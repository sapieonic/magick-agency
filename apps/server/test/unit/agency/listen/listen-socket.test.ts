import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENCY_LISTEN_CLOSE, AGENCY_LISTEN_IDLE_TIMEOUT_MS, AGENCY_LISTEN_PING_INTERVAL_MS, type AgencyListenEndReason,
} from '@magick-agency/contracts/agency';
import {
  handleListenSocket,
  parseListenClientFrame,
  LISTEN_CLIENT_MESSAGE_BURST,
  LISTEN_CLIENT_MESSAGES_PER_SECOND,
  LISTEN_MAX_CLIENT_MESSAGE_BYTES,
  LISTEN_MESSAGE_RATE_REASON,
  type ListenSocketDeps,
} from '../../../../src/agency/listen/listen-socket.js';
import { ListenTokenUnavailableError } from '../../../../src/agency/listen/listen-token.js';
import { BACKLOG_CLOSE_TERMINATE_MS } from '../../../../src/utils/ws-backpressure.js';
import { ListenRegistry, type ListenAccessCheck } from '../../../../src/agency/listen/listen-registry.js';
import type { ListenGrantPayload } from '../../../../src/agency/listen/listen-token.js';
import type { ListenSink, ListenTapStats, OpenListenTapResult } from '../../../../src/core/webrtc-bridge-manager.js';

/*
 * The listener socket (docs/listening.md §3, §4): the upgrade's fail-closed order (token, caps,
 * the access check, row, tap, admission — a revocation anywhere between the grant and the
 * admission refuses it, LS16 n), the control frames and their strict parsing, the idle bound, and the one end — the
 * `ended` frame and the close code for each reason, the row closed with its counters, the audit
 * pair. Over a fake socket, a fake bridge and stubbed rows.
 */

const S = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const GRANT: ListenGrantPayload = {
  listenId: L, sessionId: S, tenantId: '33333333-3333-4333-8333-333333333333', accountId: '44444444-4444-4444-8444-444444444444',
  callId: '55555555-5555-4555-8555-555555555555', origin: 'campaign', campaignId: '66666666-6666-4666-8666-666666666666',
  correlationId: '77777777-7777-4777-8777-777777777777', agentUserId: '88888888-8888-4888-8888-888888888888',
  listenerUserId: '99999999-9999-4999-8999-999999999999', recording: true, revocationGen: 0,
};

class FakeWs extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Buffer> = [];
  closed: { code: number; reason: string } | null = null;
  pings = 0;
  terminated = false;
  send(data: string | Buffer): void { this.sent.push(data); }
  ping(): void { this.pings++; }
  terminate(): void { this.terminated = true; this.readyState = 3; }
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
  rows: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; markLive: ReturnType<typeof vi.fn> };
  audit: ReturnType<typeof vi.fn>;
  sink: () => ListenSink;
  tap: { detach: ReturnType<typeof vi.fn>; stats: ReturnType<typeof vi.fn> };
}

function harness(over: {
  grant?: ListenGrantPayload | null;
  access?: ListenAccessCheck;
  open?: () => Promise<unknown>;
  tap?: 'refused' | 'ok' | 'throws' | 'ended';
  limits?: Partial<{ maxPerCall: number; maxPerProcess: number; maxPerUser: number }>;
} = {}): Harness {
  const ws = new FakeWs();
  const registry = new ListenRegistry({
    limits: { maxPerCall: 2, maxPerProcess: 20, maxPerUser: 1, recheckMs: 30_000, ...over.limits },
    access: over.access ?? (async () => ({ revoked: new Set(), unchecked: new Set() })),
  });
  const rows = { open: vi.fn(over.open ?? (async () => ({}))), close: vi.fn(async () => ({})), markLive: vi.fn(async () => true) };
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
        if (over.tap === 'throws') throw new Error('bridge bug');
        if (over.tap === 'ended') {
          // A tap that ended under the attach: the sink closed at once, the handle detached (SWE-L1).
          sink.close('call_ended', { framesSent: 0, framesDropped: 0 });
          return { callId, listenId: sink.listenId, attached: false, stats: tap.stats, detach: tap.detach };
        }
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

  it('LS16 n: the database says they may no longer listen: 4403 permission_revoked, no row, the slot given back', async () => {
    const h = harness({ access: async (subjects) => ({ revoked: new Set(subjects.map((x) => x.listenId)), unchecked: new Set() }) });
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.FORBIDDEN, reason: 'permission_revoked' });
    expect(h.rows.open).not.toHaveBeenCalled();
    expect(h.deps.bridge.openListenTap).not.toHaveBeenCalled();
    expect(h.registry.held().size).toBe(0);
  });

  it('LS16 n: an access check that cannot be made refuses 1011 listen_unavailable, no row (fail closed)', async () => {
    for (const access of [
      (async (subjects) => ({ revoked: new Set(), unchecked: new Set(subjects.map((x) => x.listenId)) })) as ListenAccessCheck,
      (async () => { throw new Error('ECONNREFUSED'); }) as ListenAccessCheck,
    ]) {
      const h = harness({ access });
      expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
      expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.INTERNAL_ERROR, reason: 'listen_unavailable' });
      expect(h.rows.open).not.toHaveBeenCalled();
      expect(h.registry.held().size).toBe(0);
    }
  });

  it('LS16 n: revoked between the grant and the upgrade: the grant\'s generation is stale, 4403 before the database is asked', async () => {
    const access = vi.fn<ListenAccessCheck>(async () => ({ revoked: new Set(), unchecked: new Set() }));
    const h = harness({ access });
    await h.registry.revokeUser(GRANT.tenantId, GRANT.listenerUserId); // no session yet: only the generation moves
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.FORBIDDEN, reason: 'permission_revoked' });
    expect(access).not.toHaveBeenCalled();
    expect(h.rows.open).not.toHaveBeenCalled();
  });

  it('LS16 n: revoked between the reservation and the admission: the row closes permission_revoked, 4403, no ready, no audit', async () => {
    const h = harness();
    h.rows.open.mockImplementation(async () => { await h.registry.revokeUser(GRANT.tenantId, GRANT.listenerUserId); });
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    await settle();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.FORBIDDEN, reason: 'permission_revoked' });
    expect(h.ws.json().some((f) => f['event'] === 'ready')).toBe(false);
    expect(h.rows.close).toHaveBeenCalledWith(L, { reason: 'permission_revoked', framesSent: 7, framesDropped: 1, live: false });
    // Never live: "Listened to by" leaves the row out (QA-M2).
    expect(h.rows.markLive).not.toHaveBeenCalled();
    expect(h.tap.detach).toHaveBeenCalledTimes(1);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
    expect(h.registry.held().size).toBe(0);
  });

  it('a stopping process refuses 1011 listen_unavailable at the reservation, not the server\'s limit', async () => {
    const h = harness();
    await h.registry.shutdown();
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.INTERNAL_ERROR, reason: 'listen_unavailable' });
    expect(h.rows.open).not.toHaveBeenCalled();
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
    expect(h.rows.close).toHaveBeenCalledWith(L, { reason: 'call_ended', framesSent: 0, framesDropped: 0, live: false });
    expect(h.ws.json().some((f) => f['event'] === 'ready')).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
    expect(h.rows.markLive).not.toHaveBeenCalled();
  });

  it('SWE-L1: a tap that ended under the attach (the sink closed at once) is a call no longer live: 4404, no slot, no audit, no `ended` frame', async () => {
    const h = harness({ tap: 'ended' });
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    await settle();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.CALL_GONE, reason: 'listen_call_not_live' });
    expect(h.ws.json()).toEqual([]);
    expect(h.rows.close).toHaveBeenCalledTimes(1);
    expect(h.rows.close).toHaveBeenCalledWith(L, { reason: 'call_ended', framesSent: 0, framesDropped: 0, live: false });
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
    expect(h.registry.held().size).toBe(0);
  });

  it('SWE-NITS: opening the tap throwing is the server\'s failure, not the call\'s end: 1011 listen_unavailable, the row closed tap_error', async () => {
    const h = harness({ tap: 'throws' });
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    await settle();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.INTERNAL_ERROR, reason: 'listen_unavailable' });
    expect(h.rows.close).toHaveBeenCalledWith(L, { reason: 'tap_error', framesSent: 0, framesDropped: 0, live: false });
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.registry.held().size).toBe(0);
  });

  it('QA-L3: a token store that cannot be asked refuses 1011 listen_unavailable, not 4401 (re-mint)', async () => {
    const h = harness();
    h.deps.tokens = { consume: vi.fn(async () => { throw new ListenTokenUnavailableError(L); }) };
    expect(await handleListenSocket(h.ws as never, { sessionId: S, listenId: L, token: 'tok' }, h.deps)).toBeNull();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.INTERNAL_ERROR, reason: 'listen_unavailable' });
    expect(h.rows.open).not.toHaveBeenCalled();
  });

  it('the fault budget reaches the bridge through the seam (SWE-L2)', async () => {
    const h = harness();
    h.deps.faultBudget = 7;
    await admitted(h);
    expect(h.deps.bridge.openListenTap).toHaveBeenCalledWith(GRANT.callId, expect.anything(), { faultBudget: 7 });
  });

  it('admitted: `ready` first, the row stamped live, the started audit row with ids only, the session in the registry', async () => {
    const h = harness();
    await admitted(h);
    expect(h.rows.markLive).toHaveBeenCalledWith(L);
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
    ['access unverified (LS21)', async (h) => { await h.registry.endSessions([L], 'access_unverified'); }, 'access_unverified', AGENCY_LISTEN_CLOSE.ACCESS_UNVERIFIED],
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
      expect(h.rows.close).toHaveBeenCalledWith(L, { reason, framesSent: 7, framesDropped: 1, live: true });
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
      expect(h.rows.close).toHaveBeenCalledWith(L, { reason, framesSent: 100, framesDropped: 3, live: true });
    }
  });

  it('SWE-M3: a socket that never completes the close is terminated after the station\'s grace; one that closes is not', async () => {
    vi.useFakeTimers();
    const h = harness();
    await admitted(h);
    h.sink().close('send_backlog', { framesSent: 100, framesDropped: 3 });
    await vi.advanceTimersByTimeAsync(BACKLOG_CLOSE_TERMINATE_MS - 1);
    expect(h.ws.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.ws.terminated).toBe(true);

    const polite = harness();
    await admitted(polite);
    polite.ws.say({ event: 'stop' });
    polite.ws.drop(); // the peer completes the close
    await vi.advanceTimersByTimeAsync(BACKLOG_CLOSE_TERMINATE_MS);
    expect(polite.ws.terminated).toBe(false);
  });

  it('QA-M1: the server pings at the protocol level, and a pong keeps a listener that sends no JSON ping alive', async () => {
    vi.useFakeTimers();
    const h = harness();
    await admitted(h);
    // A hidden tab: its timers throttled, so no JSON ping for minutes; the browser answers pings itself.
    for (let t = 0; t < 4 * AGENCY_LISTEN_IDLE_TIMEOUT_MS; t += AGENCY_LISTEN_PING_INTERVAL_MS) {
      await vi.advanceTimersByTimeAsync(AGENCY_LISTEN_PING_INTERVAL_MS);
      h.ws.emit('pong', Buffer.alloc(0));
    }
    expect(h.ws.pings).toBe(4 * AGENCY_LISTEN_IDLE_TIMEOUT_MS / AGENCY_LISTEN_PING_INTERVAL_MS);
    expect(h.ws.closed).toBeNull();
    // A peer that answers nothing is still ended by the idle bound, and the pinging stops.
    await vi.advanceTimersByTimeAsync(AGENCY_LISTEN_IDLE_TIMEOUT_MS);
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.HEARTBEAT_TIMEOUT, reason: 'listener_disconnected' });
    const pings = h.ws.pings;
    await vi.advanceTimersByTimeAsync(AGENCY_LISTEN_PING_INTERVAL_MS * 3);
    expect(h.ws.pings).toBe(pings);
  });

  it('QA-L5: past its message rate the socket is closed 1008 and the listen ends listener_disconnected; an honest client never gets near it', async () => {
    let now = 1_000_000;
    const h = harness();
    h.deps.now = () => now;
    await admitted(h);
    // An honest console: a ping every 10 s for an hour.
    for (let i = 0; i < 360; i++) { now += 10_000; h.ws.say({ event: 'ping' }); }
    expect(h.ws.closed).toBeNull();
    // A flood in one instant, the bucket full again: the burst passes, the next message closes it.
    now += 10_000;
    for (let i = 0; i < LISTEN_CLIENT_MESSAGE_BURST; i++) h.ws.say({ event: 'ping' });
    expect(h.ws.closed).toBeNull();
    h.ws.say({ event: 'ping' });
    await settle();
    expect(h.ws.closed).toEqual({ code: AGENCY_LISTEN_CLOSE.INVALID_UPGRADE, reason: LISTEN_MESSAGE_RATE_REASON });
    expect(h.rows.close).toHaveBeenCalledWith(L, expect.objectContaining({ reason: 'listener_disconnected' }));
    // The bucket refills at its rate: binary messages count too.
    const b = harness();
    b.deps.now = () => now;
    await admitted(b);
    for (let i = 0; i < LISTEN_CLIENT_MESSAGE_BURST; i++) b.ws.emit('message', Buffer.from([1]), true);
    now += 1_000 / LISTEN_CLIENT_MESSAGES_PER_SECOND;
    b.ws.emit('message', Buffer.from([1]), true);
    expect(b.ws.closed).toBeNull();
    b.ws.emit('message', Buffer.from([1]), true);
    expect(b.ws.closed?.code).toBe(AGENCY_LISTEN_CLOSE.INVALID_UPGRADE);
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
