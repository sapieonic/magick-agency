import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The Redis client options (`src/utils/redis-options.ts`), against a real ioredis client and
// a fake Redis on a loopback socket that speaks just enough RESP: it answers the ready
// check (`INFO`), then either STALLS every other command (TCP up, no reply: a Redis that is
// hung, swapping or partitioned one way) or answers it nil.
//
// What is pinned:
//  - with the production options a stalled command REJECTS (`Command timed out`) within
//    the command timeout; with ioredis's defaults it is still pending a second later (the
//    defect: a Redis outage took ~10 s to show on /readyz and some requests waited ~30 s);
//  - decision Q6 on that rejection: a bridge call token whose check times out lands in the
//    "Redis erroring" branch and is ACCEPTED, while the same client against a Redis that
//    answers nil REFUSES it ("Redis answered and the key is missing");
//  - the agent lease renewer sees a timeout as `unknown`, not `lost`, so it keeps renewing
//    a live call's lease (the dialer stops only on `lost`).
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import net from 'node:net';
import { Redis } from 'ioredis';
import { redisClientOptions } from '../../../src/utils/redis-options.js';
import { parseConfig } from '../../../src/config/load.js';
import { BridgeWsTokens } from '../../../src/core/bridge/ws-tokens.js';
import { AgentStateMachine } from '../../../src/agency/agent-state-machine.js';

/** The commands the fake stalls (or answers nil); everything else is answered +OK. */
const DATA_COMMANDS = new Set(['get', 'set', 'del', 'eval', 'evalsha', 'hgetall', 'expire', 'ping']);
const INFO_REPLY = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';

/** A fake Redis: replies to INFO (the ready check) and the handshake; data commands stall, or get nil. */
async function fakeRedis(mode: 'stall' | 'nil'): Promise<{ url: string; commands: string[]; close: () => Promise<void> }> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      // One RESP array per command; ioredis may pipeline several in one chunk.
      for (const part of chunk.toString('latin1').split(/(?=\*\d+\r\n)/)) {
        const name = part.split('\r\n')[2]?.toLowerCase();
        if (!name) continue;
        commands.push(name);
        if (name === 'info') socket.write(`$${Buffer.byteLength(INFO_REPLY)}\r\n${INFO_REPLY}\r\n`);
        // The connection handshake (`CLIENT SETINFO`, `SELECT`) is answered in both modes.
        else if (!DATA_COMMANDS.has(name)) socket.write('+OK\r\n');
        else if (mode === 'nil') socket.write(name === 'eval' || name === 'evalsha' ? ':0\r\n' : '$-1\r\n');
        // 'stall': a data command is never answered.
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${port}`,
    commands,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const COMMAND_TIMEOUT_MS = 300;
const clientOptions = () => redisClientOptions({
  keyPrefix: '', commandTimeoutMs: COMMAND_TIMEOUT_MS, maxRetriesPerRequest: 1, connectTimeoutMs: 2_000,
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function connect(url: string, opts: ReturnType<typeof clientOptions> | Record<string, never>): Promise<Redis> {
  const redis = new Redis(url, { ...opts, lazyConnect: true });
  redis.on('error', () => undefined);
  cleanups.push(() => redis.disconnect());
  await redis.connect();
  return redis;
}

/** Settle within `ms`, or report that it was still pending. */
function within<T>(ms: number, p: Promise<T>): Promise<{ settled: 'resolved'; value: T } | { settled: 'rejected'; error: Error } | { settled: 'pending' }> {
  return Promise.race([
    p.then((value) => ({ settled: 'resolved' as const, value }), (error: Error) => ({ settled: 'rejected' as const, error })),
    new Promise<{ settled: 'pending' }>((r) => setTimeout(() => r({ settled: 'pending' }), ms)),
  ]);
}

describe('redisClientOptions', () => {
  it('maps the redis config block (defaults: 2 s command and connect timeouts, one retry)', () => {
    const parsed = parseConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5436/x', REDIS_URL: 'redis://localhost:6383/0' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(redisClientOptions(parsed.config.redis)).toEqual({
      keyPrefix: undefined, commandTimeout: 2_000, maxRetriesPerRequest: 1, connectTimeout: 2_000,
    });
    const tuned = parseConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5436/x', REDIS_URL: 'redis://localhost:6383/0',
      REDIS_KEY_PREFIX: 'p:', REDIS_COMMAND_TIMEOUT_MS: '500', REDIS_MAX_RETRIES_PER_REQUEST: '0', REDIS_CONNECT_TIMEOUT_MS: '1500',
    });
    expect(tuned.ok && redisClientOptions(tuned.config.redis)).toEqual({
      keyPrefix: 'p:', commandTimeout: 500, maxRetriesPerRequest: 0, connectTimeout: 1_500,
    });
    expect(parseConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5436/x', REDIS_URL: 'redis://localhost:6383/0', REDIS_COMMAND_TIMEOUT_MS: '0',
    }).ok).toBe(false);
  });

  it('a stalled command rejects within the command timeout; with ioredis defaults it is still pending', async () => {
    const fake = await fakeRedis('stall');
    cleanups.push(fake.close);

    const bounded = await connect(fake.url, clientOptions());
    const t0 = Date.now();
    const result = await within(2_000, bounded.get('k'));
    expect(result.settled).toBe('rejected');
    expect((result as { error: Error }).error.message).toMatch(/Command timed out/);
    // The timeout fired (not an earlier failure); `within` above is the upper bound, kept
    // loose (2 s against a 300 ms timeout) so a loaded full run cannot fail it, and still far
    // from the defaults below, which never settle.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(COMMAND_TIMEOUT_MS - 20);

    // The defect, characterised: no command timeout, so a stalled Redis holds the caller.
    const defaults = await connect(fake.url, {});
    expect((await within(1_000, defaults.get('k'))).settled).toBe('pending');
  });

  it('Q6: a call token whose check TIMES OUT is accepted (Redis erroring), never refused', async () => {
    const fake = await fakeRedis('stall');
    cleanups.push(fake.close);
    const tokens = new BridgeWsTokens(await connect(fake.url, clientOptions()), '');

    const t0 = Date.now();
    await expect(tokens.verifyWsToken('call-1', 'whatever', 'provider')).resolves.toBe(true);
    await expect(tokens.verifyWsToken('call-1', undefined, 'webhook')).resolves.toBe(true);
    // Two command timeouts, not a hang: bounded loosely (a loaded run can be slow; a client
    // without the timeout never answers at all).
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(fake.commands).toContain('get');
  });

  it('Q6 control: the same client against a Redis that ANSWERS nil refuses the token', async () => {
    const fake = await fakeRedis('nil');
    cleanups.push(fake.close);
    const tokens = new BridgeWsTokens(await connect(fake.url, clientOptions()), '');
    await expect(tokens.verifyWsToken('call-1', 'whatever', 'provider')).resolves.toBe(false);
  });

  it('the agent lease renewer reads a timeout as `unknown` (keep renewing), a CAS miss as `lost`', async () => {
    const stalled = await fakeRedis('stall');
    cleanups.push(stalled.close);
    const answered = await fakeRedis('nil');
    cleanups.push(answered.close);

    const onStall = new AgentStateMachine(await connect(stalled.url, clientOptions()), '');
    await expect(onStall.renewLease('s1', 'on_call', 15_000)).resolves.toBe('unknown');
    // The boolean form keeps its contract: not renewed.
    await expect(onStall.renew('s1', 'on_call', 15_000)).resolves.toBe(false);

    const onMiss = new AgentStateMachine(await connect(answered.url, clientOptions()), '');
    await expect(onMiss.renewLease('s1', 'on_call', 15_000)).resolves.toBe('lost');
  });
});
