import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENCY_LISTEN_CLOSE, AGENCY_LISTEN_IDLE_TIMEOUT_MS, type AgencyListenEndReason } from '@magick-agency/contracts/agency';
import {
  handleListenSocket,
  parseListenClientFrame,
  LISTEN_MAX_CLIENT_MESSAGE_BYTES,
  type ListenSocketDeps,
} from '../../../../src/agency/listen/listen-socket.js';
import { ListenRegistry } from '../../../../src/agency/listen/listen-registry.js';
import type { ListenGrantPayload } from '../../../../src/agency/listen/listen-token.js';
import type { ListenSink, ListenTapStats, OpenListenTapResult } from '../../../../src/core/webrtc-bridge-manager.js';

/*
 * The listener socket (docs/listening.md §3, §4): the upgrade's fail-closed order (token, caps,
 * row, tap), the control frames and their strict parsing, the idle bound, and the one end — the
 * `ended` frame and the close code for each reason, the row closed with its counters, the audit
 * pair. Over a fake socket, a fake bridge and stubbed rows.
 */

const S = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const GRANT: ListenGrantPayload = {
  listenId: L, sessionId: S, tenantId: '33333333-3333-4333-8333-333333333333', accountId: '44444444-4444-4444-8444-444444444444',
  callId: '55555555-5555-4555-8555-555555555555', origin: 'campaign', campaignId: '66666666-6666-4666-8666-666666666666',
  correlationId: '77777777-7777-4777-8777-777777777777', agentUserId: '88888888-8888-4888-8888-888888888888',
  listenerUserId: '99999999-9999-4999-8999-999999999999', recording: true,
};

class FakeWs extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Buffer> = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string | Buffer): void { this.sent.push(data); }
  close(code: number, reason: string): void {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this.closed = { code, reason };
  }
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  /** The client sends a text frame. */
  say(frame: unknown): void { this.emit('message', Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame)), false); }
  /** The client went away. */
  drop(): void { this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)); }
}

interface Harness {
  ws: FakeWs;
  deps: ListenSocketDeps;
  registry: ListenRegistry;
  rows: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  audit: ReturnType<typeof vi.fn>;
  sink: () => ListenSink;
  tap: { detach: ReturnType<typeof vi.fn>; stats: ReturnType<typeof vi.fn> };
}

function harness(over: {
  grant?: ListenGrantPayload | null;
  open?: () => Promise<unknown>;
  tap?: 'refused' | 'ok';
  limits?: Partial<{ maxPerCall: number; maxPerProcess: number; maxPerUser: number }>;
} = {}): Harness {
  const ws = new FakeWs();
  const registry = new ListenRegistry({
    limits: { maxPerCall: 2, maxPerProcess: 20, maxPerUser: 1, recheckMs: 30_000, ...over.limits },
    access: async () => new Set(),
  });
  const rows = { open: vi.fn(over.open ?? (async () => ({}))), close: vi.fn(async () => ({})) };
  const audit = vi.fn();
  let captured: ListenSink | null = null;
  const tap = { detach: vi.fn(), stats: vi.fn((): ListenTapStats => ({ framesSent: 7, framesDropped: 1 })) };
  const deps: ListenSocketDeps = {
    tokens: { consume: vi.fn(async () => (over.grant === undefined ? GRANT : over.grant)) },
    registry,
    bridge: {
      openListenTap: vi.fn((callId: string, sink: ListenSink): OpenListenTapResult => {
        captured = sink;
        if (over.tap === 'refused') return { refused: 'not_found' };
        return { callId, listenId: sink.listenId, attached: true, stats: tap.stats, detach: tap.detach };
      }),
    },
    rows,
    audit,
    replicaId: 'r1',
  };
  return { ws, deps, registry, rows, audit, tap, sink: () => captured! };
}

async function admitted(h: Harness) {
  const s = await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps);
  expect(s).not.toBeNull();
  return s!;
}

/** Let the end's row close and audit settle. */
const settle = () => new Promise((r) => setImmediate(r));

afterEach(() => { vi.useRealTimers(); });

describe('parseListenClientFrame', () => {
  it('accepts exactly ping (with an optional finite ts) and stop', () => {
    expect(parseListenClientFrame('{"event":"ping"}')).toEqual({ event: 'ping' });
    expect(parseListenClientFrame('{"event":"ping","ts":12.5}')).toEqual({ event: 'ping', ts: 12.5 });
    expect(parseListenClientFrame('{"event":"stop"}')).toEqual({ event: 'stop' });
  });
  it('refuses anything else: other events, extra keys, a bad ts, not JSON, not an object, too long', () => {
    for (const raw of [
      '{"event":"pong"}', '{"event":"stop","x":1}', '{"event":"ping","ts":"1"}', '{"event":"ping","ts":null}',
      '{"event":"ping","extra":true}', 'stop', '[]', 'null', '"ping"', '{}',
      JSON.stringify({ event: 'ping', ts: 1, pad: 'x'.repeat(LISTEN_MAX_CLIENT_MESSAGE_BYTES) }),
    ]) expect(parseListenClientFrame(raw), raw).toBeNull();
  });
});

describe('the upgrade, fail closed (LS7)', () => {
  it('a token that does not verify closes 4401 before anything is read or written', async () => {
    const h = harness({ grant: null });
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'nope' }, h.deps)).toBeNull();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.TOKEN_REJECTED, reason: 'listen_token_invalid' });
    expect(h.rows.open).not.toHaveBeenCalled();
    expect(h.deps.bridge.openListenTap).not.toHaveBeenCalled();
  });

  it('a grant for another agent\'s session is not this socket\'s: 4401', async () => {
    const h = harness();
    expect(await handleListenSocket(h.ws as never, { sessionId: L, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    expect(h.ws.closed?.code).toBe(AGENCY_LISTEN_CLOSE.TOKEN_REJECTED);
    expect(h.rows.open).not.toHaveBeenCalled();
  });

  it('a cap refuses 4429 with the code as the reason, and no row is written', async () => {
    const h = harness({ limits: { maxPerCall: 1 } });
    h.registry.reserve({ listenId: 'other', callId: GRANT.callId, tenantId: GRANT.tenantId, listenerUserId: 'someone' });
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.LIMIT, reason: 'listen_limit_call' });
    expect(h.rows.open).not.toHaveBeenCalled();
  });

  it('no row, no audio: a failed insert closes 1011 listen_unavailable, opens no tap, and gives the slot back', async () => {
    const h = harness({ open: async () => { throw new Error('pool exhausted'); } });
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.INTERNAL_ERROR, reason: 'listen_unavailable' });
    expect(h.deps.bridge.openListenTap).not.toHaveBeenCalled();
    expect(h.registry.check(GRANT.callId, GRANT.tenantId, 'x')).toBeNull();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('the row is written BEFORE the tap opens (no row, no audio)', async () => {
    const h = harness();
    const order: string[] = [];
    h.rows.open.mockImplementation(async () => { order.push('row'); });
    (h.deps.bridge.openListenTap as ReturnType<typeof vi.fn>).mockImplementationOnce((callId: string, sink: ListenSink) => {
      order.push('tap');
      return { callId, listenId: sink.listenId, attached: true, stats: h.tap.stats, detach: h.tap.detach };
    });
    await admitted(h);
    expect(order).toEqual(['row', 'tap']);
    expect(h.rows.open).toHaveBeenCalledWith(expect.objectContaining({
      id: L, callId: GRANT.callId, agentSessionId: S, listenerUserId: GRANT.listenerUserId, replicaId: 'r1', origin: 'campaign',
    }));
  });

  it('a call the bridge no longer has closes 4404; its row closes `call_ended`; nothing is audited', async () => {
    const h = harness({ tap: 'refused' });
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.CALL_GONE, reason: 'listen_call_not_live' });
    expect(h.rows.close).toHaveBeenCalledWith(L, { reason: 'call_ended', framesSent: 0, framesDropped: 0 });
    expect(h.ws.json().some((f) => f['event'] === 'ready')).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
  });

  it('admitted: `ready` first, the started audit row with ids only, the session in the registry', async () => {
    const h = harness();
    await admitted(h);
    expect(h.ws.json()[0]).toEqual({ event: 'ready', listen_id: L, call_id: GRANT.callId, format: 'alaw8', frame_bytes: 160 });
    expect(h.registry.size).toBe(1);
    expect(h.audit).toHaveBeenCalledWith({
      tenant_id: GRANT.tenantId, account_id: GRANT.accountId, actor_type: 'human', user_id: GRANT.listenerUserId,
      action: 'agency_call.listen_started', resource_type: 'agency_call', resource_id: GRANT.callId, campaign_id: GRANT.campaignId,
      details: { listen_id: L, call_id: GRANT.callId, origin: 'campaign', correlation_id: GRANT.correlationId, agent_user_id: GRANT.agentUserId },
    });
  });

  it('a socket that errors is just a closed one: the error handler is attached before the first await', async () => {
    const h = harness();
    const pending = handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps);
    expect(h.ws.listenerCount('error')).toBe(1);
    expect(() => h.ws.emit('error', new Error('ECONNRESET'))).not.toThrow();
    await pending;
  });
});

describe('the session', () => {
  it('ping is answered pong with the client ts echoed; a bad frame and binary are ignored', async () => {
    const h = harness();
    await admitted(h);
    h.ws.say({ event: 'ping', ts: 42 });
    h.ws.say('{"event":"ping","ts":"nope"}');
    h.ws.emit('message', Buffer.from([1, 2, 3]), true);
    const pongs = h.ws.json().filter((f) => f['event'] === 'pong');
    expect(pongs).toHaveLength(1);
    expect(pongs[0]).toMatchObject({ event: 'pong', ts: 42 });
    expect(typeof pongs[0]!['server_ts']).toBe('number');
  });

  it('the sink sends audio as binary to the socket', async () => {
    const h = harness();
    await admitted(h);
    const frame = Buffer.alloc(161, 1);
    expect(h.sink().send(frame)).toBe('sent');
    expect(h.ws.sent.at(-1)).toBe(frame);
    h.ws.readyState = 3;
    expect(h.sink().send(frame)).toBe('closed');
  });

  const cases: Array<[string, (h: Harness) => Promise<void> | void, AgencyListenEndReason, number]> = [
    ['stop', (h) => h.ws.say({ event: 'stop' }), 'listener_stopped', AGENCY_LISTEN_CLOSE.NORMAL],
    ['superseded', async (h) => { await h.registry.endSessions([L], 'superseded'); }, 'superseded', AGENCY_LISTEN_CLOSE.SUPERSEDED],
    ['revoked', async (h) => { await h.registry.endSessions([L], 'permission_revoked'); }, 'permission_revoked', AGENCY_LISTEN_CLOSE.FORBIDDEN],
    ['shutdown', async (h) => { await h.registry.shutdown(); }, 'server_shutdown', AGENCY_LISTEN_CLOSE.GOING_AWAY],
  ];
  for (const [name, act, reason, code] of cases) {
    it(`${name}: ended { ${reason} }, close ${code}, tap detached, row closed with the tap's counters, ended audited`, async () => {
      const h = harness();
      await admitted(h);
      await act(h);
      await settle();
      expect(h.ws.json().at(-1)).toEqual({ event: 'ended', reason });
      expect(h.ws.closed).toEqual({ code, reason });
      expect(h.tap.detach).toHaveBeenCalledTimes(1);
      expect(h.rows.close).toHaveBeenCalledWith(L, { reason, framesSent: 7, framesDropped: 1 });
      expect(h.audit).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'agency_call.listen_ended',
        details: expect.objectContaining({ listen_id: L, end_reason: reason, frames_dropped: 1 }),
      }));
      expect(h.registry.size).toBe(0);
    });
  }

  it('the tap ends it (call_ended, send_backlog, tap_error): its stats are the row\'s, its detach is not called again', async () => {
    for (const [reason, code] of [['call_ended', 1000], ['send_backlog', 4408], ['tap_error', 1011]] as const) {
      const h = harness();
      await admitted(h);
      h.sink().close(reason, { framesSent: 100, framesDropped: 3 });
      await settle();
      expect(h.ws.closed).toEqual({ code, reason });
      expect(h.tap.detach).not.toHaveBeenCalled();
      expect(h.rows.close).toHaveBeenCalledWith(L, { reason, framesSent: 100, framesDropped: 3 });
    }
  });

  it('the client closing is `listener_disconnected`: nothing more is sent, the row closes', async () => {
    const h = harness();
    await admitted(h);
    const sentBefore = h.ws.sent.length;
    h.ws.drop();
    await settle();
    expect(h.ws.sent.length).toBe(sentBefore);
    expect(h.rows.close).toHaveBeenCalledWith(L, expect.objectContaining({ reason: 'listener_disconnected' }));
  });

  it('30 s with no client frame closes 4408 `listener_disconnected`; a ping restarts the bound', async () => {
    vi.useFakeTimers();
    const h = harness();
    await admitted(h);
    await vi.advanceTimersByTimeAsync(AGENCY_LISTEN_IDLE_TIMEOUT_MS - 1_000);
    h.ws.say({ event: 'ping' });
    await vi.advanceTimersByTimeAsync(AGENCY_LISTEN_IDLE_TIMEOUT_MS - 1_000);
    expect(h.ws.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.HEARTBEAT_TIMEOUT, reason: 'listener_disconnected' });
  });

  it('ends once: a second end, a late stop, the client close after it change nothing', async () => {
    const h = harness();
    await admitted(h);
    h.ws.say({ event: 'stop' });
    h.ws.say({ event: 'stop' });
    h.sink().close('call_ended', { framesSent: 1, framesDropped: 0 });
    h.ws.drop();
    await settle();
    expect(h.rows.close).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls.filter(([e]) => e.action === 'agency_call.listen_ended')).toHaveLength(1);
  });

  it('a row close or audit that throws is logged, never thrown', async () => {
    const h = harness();
    await admitted(h);
    h.rows.close.mockRejectedValueOnce(new Error('down'));
    h.audit.mockImplementation(() => { throw new Error('buffer'); });
    h.ws.say({ event: 'stop' });
    await settle();
    expect(h.ws.closed?.code).toBe(1000);
  });

  it('a supervisor\'s second listen supersedes the first through the registry', async () => {
    const first = harness();
    await admitted(first);
    const second: Harness = { ...harness(), registry: first.registry };
    second.deps.registry = first.registry;
    second.deps.tokens = { consume: vi.fn(async () => ({ ...GRANT, listenId: S })) };
    await handleListenSocket(second.ws as never, { sessionId: S, listenId: S, token: 'tok' }, second.deps);
    await settle();
    expect(first.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.SUPERSEDED, reason: 'superseded' });
    expect(second.ws.json()[0]).toMatchObject({ event: 'ready' });
  });
});
