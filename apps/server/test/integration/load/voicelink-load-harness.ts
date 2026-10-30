/**
 * Shared rig for the VoiceLink load suites: the REAL app (`buildApp` with a real context
 * over Postgres 5436 and this worktree's Redis db) listening on loopback, the REAL
 * `WebRtcBridgeManager` and guard host, the REAL provider registry and `VoicelinkAdapter`
 * — and the mock carrier (`test/mocks/voicelink`) on the other side of real sockets.
 * Nothing in the call path is faked; the agent's station socket is the one in-process
 * stand-in, because the bridge borrows it rather than accepting it over a route.
 *
 * Config: a suite sets the env below in its own `vi.hoisted` (config is read at import),
 * then {@link startLoadRig} points `config.telephony.voicelink.baseUrl` — the object the
 * provider registry hands the adapter by reference — at the mock carrier, and the carrier
 * rewrites the bridge's public `wss://agency.test` / `https://agency.test` URLs to the
 * listening app.
 *
 *   VOICELINK_WEBHOOK_BASE_URL=https://agency.test/api/v1/webhooks/voicelink
 *   VOICELINK_USERNAME / VOICELINK_PASSWORD = the mock's defaults
 *   MAX_CONCURRENT_CALLS, RATE_LIMIT_WEBHOOK_MAX, RATE_LIMIT_CARRIER_MEDIA_MAX: high
 *
 * {@link assertNoLeaks} is the end-of-scenario check every suite runs: no bridge session,
 * no concurrency slot, no provider token, no server- or carrier-side socket, no timer
 * left on a session, no listener left on a borrowed station socket.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import { ensureVoiceEngine, getVoiceEngine, resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import type { WebRtcBridgeManager, WebRtcLifecycleEvent } from '../../../src/core/webrtc-bridge-manager.js';
import type { WebRtcBridgeSession } from '../../../src/core/webrtc-bridge-session.js';
import { MockVoicelinkCarrier } from '../../mocks/voicelink/index.js';

export const LOAD_ENV: Record<string, string> = {
  VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
  VOICELINK_USERNAME: 'mock-vl-user',
  VOICELINK_PASSWORD: 'mock-vl-password',
  MAX_CONCURRENT_CALLS: '100000',
  RATE_LIMIT_WEBHOOK_MAX: '1000000',
  RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
  LOG_LEVEL: 'warn',
};

/**
 * The agent's station socket, as the bridge borrows it: records every frame the bridge
 * writes, lets the test send browser media, and counts live listeners (a borrowed socket
 * must have none left once its attempt is over).
 */
export class LoadStationSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  /** PCM16 payloads of the bridge's `media` frames, decoded, in order. */
  readonly media: Buffer[] = [];
  private readonly sentHooks: Array<(frame: Record<string, unknown>) => void> = [];

  send(raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame['event'] === 'media') {
      this.media.push(Buffer.from((frame['media'] as { payload: string }).payload, 'base64'));
    }
    for (const hook of this.sentHooks) hook(frame);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  /** Run `hook` on every frame the bridge sends from now on. */
  onSent(hook: (frame: Record<string, unknown>) => void): void {
    this.sentHooks.push(hook);
  }

  /** Media frames the browser has sent up to the bridge. */
  mediaSentCount = 0;

  /** The browser sends a media frame (PCM16 16 kHz) up to the bridge. */
  sendMedia(pcm: Buffer): void {
    this.mediaSentCount += 1;
    this.emit('message', Buffer.from(JSON.stringify({ event: 'media', media: { payload: pcm.toString('base64') } })));
  }

  /** Listeners the bridge registered and has not removed. */
  bridgeListenerCount(): number {
    return this.listenerCount('message') + this.listenerCount('close') + this.listenerCount('error');
  }

  events(): string[] {
    return this.sent.map((f) => (f['event'] === 'status' ? `status:${String(f['status'])}` : String(f['event'])));
  }
}

export interface LoadRig {
  app: FastifyInstance;
  carrier: MockVoicelinkCarrier;
  bridge: WebRtcBridgeManager;
  origin: string;
  /** Every lifecycle event the bridge emitted, in order. */
  lifecycle: WebRtcLifecycleEvent[];
  /** Sessions captured while live, so the leak check can inspect them after teardown. */
  captured: Map<string, WebRtcBridgeSession>;
}

export const LOAD_TENANT = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a000001';
export const LOAD_ACCOUNT = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a000002';
export const LOAD_CAMPAIGN = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a000003';

export function initLoadDb(poolMax = 10): void {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax });
}

/** Fresh tables and Redis, then the app, the engine and the carrier. */
export async function startLoadRig(opts: { maxConcurrentCalls?: number } = {}): Promise<LoadRig> {
  await truncateAll();
  await flushTestRedis();
  await getTestPool().query(
    'INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls) VALUES ($1, $2, $3)',
    [LOAD_TENANT, LOAD_ACCOUNT, opts.maxConcurrentCalls ?? 10_000],
  );
  resetVoiceEngineForTests();
  let origin = '';
  const carrier = new MockVoicelinkCarrier({ targetOrigin: () => origin });
  await carrier.start();
  config.telephony.voicelink.baseUrl = carrier.baseUrl;
  config.telephony.voicelink.username = carrier.username;
  config.telephony.voicelink.password = carrier.password;
  const app = await buildApp({ ctx: { config, pool: getPool(), redis: getTestRedis() } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const bridge = ensureVoiceEngine(getTestRedis()).bridge;
  const lifecycle: WebRtcLifecycleEvent[] = [];
  const captured = new Map<string, WebRtcBridgeSession>();
  bridge.onLifecycle((e) => {
    lifecycle.push(e);
    const s = bridge.getSession(e.callId);
    if (s) captured.set(e.callId, s);
  });
  return { app, carrier, bridge, origin, lifecycle, captured };
}

export async function stopLoadRig(rig: LoadRig | null): Promise<void> {
  if (!rig) return;
  await rig.carrier.stop();
  await getVoiceEngine()?.bridge.gracefulShutdown();
  await getVoiceEngine()?.guardHost.gracefulShutdown();
  await rig.app.close();
  resetVoiceEngineForTests();
}

export async function closeLoadDb(): Promise<void> {
  await closePool();
  await closeTestPool();
  await closeTestRedis();
}

let attemptSeq = 0;

/** Dial one call through the agency entry point with a borrowed station socket. */
export async function dialBridged(rig: LoadRig, station: LoadStationSocket, destination = '+919812345678'): Promise<{ callId: string; attemptId: string }> {
  const attemptId = randomUUID();
  attemptSeq += 1;
  const record = await rig.bridge.createBridgedCall({
    tenantId: LOAD_TENANT,
    accountId: LOAD_ACCOUNT,
    callerId: '+919800000001',
    destinationPhone: destination,
    browserSocket: station as never,
    correlation: { kind: 'attempt' as const, campaignId: LOAD_CAMPAIGN, agencyAttemptId: attemptId },
  });
  const session = rig.bridge.getSession(record.id);
  if (session) rig.captured.set(record.id, session);
  return { callId: record.id, attemptId };
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 30_000,
  /** Appended to the timeout error: the state that never converged. */
  explain?: () => Promise<string> | string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${explain ? `: ${await explain()}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface CallRow {
  id: string;
  status: string;
  outcome: string | null;
  error_code: string | null;
  answered_at: Date | null;
  ended_at: Date | null;
  provider_call_id: string | null;
  recording_url: string | null;
  talk_time_seconds: number | null;
}

export async function callRows(ids?: string[]): Promise<Map<string, CallRow>> {
  const { rows } = await getTestPool().query<CallRow>(
    `SELECT id, status, outcome, error_code, answered_at, ended_at, provider_call_id, recording_url, talk_time_seconds
       FROM agency_calls ${ids ? 'WHERE id = ANY($1::uuid[])' : ''}`,
    ids ? [ids] : [],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

const TERMINAL = new Set(['completed', 'no_answer', 'busy', 'canceled', 'failed']);

/** Wait until every listed call row is terminal (and the bridge holds no session for it). */
export async function waitAllTerminal(rig: LoadRig, ids: string[], timeoutMs = 45_000): Promise<Map<string, CallRow>> {
  return waitFor(`${ids.length} terminal rows`, async () => {
    if (ids.some((id) => rig.bridge.getSession(id))) return null;
    const rows = await callRows(ids);
    return [...rows.values()].every((r) => TERMINAL.has(r.status) && r.ended_at) && rows.size === ids.length ? rows : null;
  }, timeoutMs, async () => {
    const rows = await callRows(ids);
    const stuck = ids.filter((id) => {
      const r = rows.get(id);
      return rig.bridge.getSession(id) || !r || !TERMINAL.has(r.status) || !r.ended_at;
    });
    return JSON.stringify(stuck.slice(0, 5).map((id) => ({
      id, live: Boolean(rig.bridge.getSession(id)), row: rows.get(id) ?? null,
      carrier: rig.carrier.calls.get(id)?.scriptName, errors: rig.carrier.calls.get(id)?.errors,
    })));
  });
}

/** `ended` lifecycle events per call id. */
export function endedCounts(rig: LoadRig): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of rig.lifecycle) if (e.phase === 'ended') out.set(e.callId, (out.get(e.callId) ?? 0) + 1);
  return out;
}

/**
 * Nothing left behind once every call has ended: the end-of-scenario invariant.
 * Polls the socket counts (a close handshake is asynchronous), asserts the rest at once.
 */
export async function assertNoLeaks(
  rig: LoadRig,
  stations: LoadStationSocket[] = [],
  /** Server-side sockets that SHOULD still be open (real station sockets of a live floor). */
  liveStationSockets = 0,
): Promise<void> {
  expect(rig.bridge.getActiveCount(), 'bridge sessions').toBe(0);
  const redis = getTestRedis();
  expect(Number((await redis.get('active_calls')) ?? '0'), 'global concurrency counter').toBe(0);
  const accountCounter = await redis.get(`active_calls:account:${LOAD_TENANT}:${LOAD_ACCOUNT}`);
  expect(Number(accountCounter ?? '0'), 'account concurrency counter').toBe(0);
  // Every scope's per-call lock (global, account, provider) is `<counter>:lock:<key>`.
  expect(await redis.keys('*active_calls*:lock:*'), 'concurrency slot locks').toEqual([]);
  expect(await redis.keys('webrtc:ws-token:provider:*'), 'provider media tokens').toEqual([]);
  await waitFor('server-side media sockets closed', () => rig.app.websocketServer.clients.size === liveStationSockets, 10_000,
    () => `${rig.app.websocketServer.clients.size} open, ${liveStationSockets} expected`);
  await waitFor('carrier-side media sockets closed', () => rig.carrier.openSocketCount().media === 0, 10_000);
  for (const [callId, s] of rig.captured) {
    const timers = s as unknown as { maxDurationTimer: unknown; endConfirmationTimer: unknown; browserGraceTimer: unknown };
    expect({ callId, max: timers.maxDurationTimer, confirm: timers.endConfirmationTimer, grace: timers.browserGraceTimer })
      .toEqual({ callId, max: null, confirm: null, grace: null });
  }
  for (const [i, st] of stations.entries()) {
    expect(st.bridgeListenerCount(), `station ${i} listeners`).toBe(0);
  }
}
