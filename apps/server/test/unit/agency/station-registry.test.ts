// PORT NOTE (magick-agency, Phase 6): ported from core test/unit/agency/station-registry.test.ts@4850d1d9 (29 → 29).
// Verbatim. Import paths only (logger → `@magick-agency/observability`). No case deleted or modified.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Agent presence and replica ownership (§3).
//
// The station socket is the anchor of ownership. The Redis key is written and
// read from day one even though core is single-replica (D2), so the invariant
// "dial only on the owning replica" is exercised continuously rather than being
// dead code that rots until someone needs it.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { StationRegistry } from '../../../src/agency/station-registry.js';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
  };
}

function fakeWs() {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    closed: false,
    /** What the registry asked to be sent on the wire, not just that it closed. */
    closeArgs: [] as [number | undefined, string | undefined][],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    close(code?: number, reason?: string) {
      this.closed = true;
      this.readyState = 3;
      this.closeArgs.push([code, reason]);
    },
  };
}

const ENTRY = { campaignId: 'camp-1', tenantId: 't1', accountId: 'a1', agentUserId: 'u1' };

beforeEach(() => vi.clearAllMocks());

describe('StationRegistry ownership', () => {
  it('claims ownership in Redis on attach and clears it on detach', async () => {
    const redis = fakeRedis();
    const reg = new StationRegistry(redis as any, '', 'r1');
    const ws = fakeWs();

    await reg.attach({ sessionId: 's1', ws: ws as any, ...ENTRY });
    expect(await reg.ownerOf('s1')).toBe('r1');
    expect(redis.set).toHaveBeenCalledWith('agency:station:s1', expect.any(String), 'PX', expect.any(Number));

    await reg.detach('s1');
    expect(await reg.ownerOf('s1')).toBeNull();
    expect(reg.isLocallyOwned('s1')).toBe(false);
  });

  it('renews ownership on every heartbeat', async () => {
    const redis = fakeRedis();
    const reg = new StationRegistry(redis as any, '', 'r1');
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });
    redis.set.mockClear();

    expect(await reg.heartbeat('s1')).toBe(true);
    // The socket's own heartbeat is what keeps the key alive; losing it is what
    // removes the agent from the available pool everywhere.
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('refuses a heartbeat from a socket that no longer holds the session', async () => {
    // The heartbeat was keyed on the session alone, so a SUPERSEDED socket's ping
    // renewed its replacement — `lastSeen` stopped meaning "this socket pinged" and
    // started meaning "any socket for this session pinged", which is the premise
    // `silentSince` and the sweep rest on. Downstream the route answers by
    // `send(sessionId, …)`, which resolves to the attached socket, so the
    // replacement's console got a pong echoing a `ts` it never sent.
    //
    // FALSIFICATION: drop the `ws` comparison in `heartbeat` and both assertions
    // below red.
    const redis = fakeRedis();
    const reg = new StationRegistry(redis as any, '', 'r1');
    const first = fakeWs();
    const second = fakeWs();
    await reg.attach({ sessionId: 's1', ws: first as any, ...ENTRY });
    await reg.attach({ sessionId: 's1', ws: second as any, ...ENTRY });

    const beforeStale = reg.get('s1')!.lastSeen;
    redis.set.mockClear();

    expect(await reg.heartbeat('s1', first as any)).toBe(false);
    // Not renewed, in either of the two places a heartbeat writes.
    expect(redis.set).not.toHaveBeenCalled();
    expect(reg.get('s1')!.lastSeen).toBe(beforeStale);

    // And the socket that does hold it is unaffected.
    expect(await reg.heartbeat('s1', second as any)).toBe(true);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('reports no heartbeat for a session it does not hold', async () => {
    const reg = new StationRegistry(fakeRedis() as any, '', 'r1');
    expect(await reg.heartbeat('ghost')).toBe(false);
  });

  it('answers ownership from the local map when Redis is absent', async () => {
    const reg = new StationRegistry(null, '', 'r1');
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });
    expect(await reg.ownerOf('s1')).toBe('r1');
    expect(await reg.ownerOf('s2')).toBeNull();
  });

  it('treats an unreadable ownership key as unowned rather than guessing', async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    const reg = new StationRegistry(redis as any, '', 'r1');
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });
    // Dialing an agent we cannot prove we own would produce an abandoned call.
    expect(await reg.ownerOf('s1')).toBeNull();
  });
});

describe('StationRegistry socket lifecycle', () => {
  it('supersedes a prior socket for the same session and closes it', async () => {
    const reg = new StationRegistry(null, '', 'r1');
    const first = fakeWs();
    const second = fakeWs();

    await reg.attach({ sessionId: 's1', ws: first as any, ...ENTRY });
    await reg.attach({ sessionId: 's1', ws: second as any, ...ENTRY });

    // A reconnect that raced the old socket's close must not leave two sockets
    // relaying the same agent's audio.
    expect(first.closed).toBe(true);
    expect(reg.socketFor('s1')).toBe(second);
    expect(reg.size()).toBe(1);
  });

  it('closes the superseded socket with 4409, not bare', async () => {
    // A bare `close()` puts no code on the wire, so the peer reports RFC 6455's
    // 1005/1006 "no status received" — which is exactly what an ordinary network
    // drop looks like. The console cannot act on the difference, master's proxy
    // launders it to 1000, and nothing distinguishes a supersede anywhere. `4409`
    // has been declared in `AgencyStationCloseCode` since the contract landed and
    // was sent by nothing.
    const reg = new StationRegistry(null, '', 'r1');
    const first = fakeWs();

    await reg.attach({ sessionId: 's1', ws: first as any, ...ENTRY });
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });

    expect(first.closeArgs).toEqual([[4409, 'superseded']]);
  });

  it('re-attaching the SAME socket is not a supersede', async () => {
    // 4409 is terminal at the console, so sending one to the socket that is still
    // the live one would be self-inflicted. `attach` is idempotent per socket and
    // must stay that way.
    const reg = new StationRegistry(null, '', 'r1');
    const only = fakeWs();

    await reg.attach({ sessionId: 's1', ws: only as any, ...ENTRY });
    await reg.attach({ sessionId: 's1', ws: only as any, ...ENTRY });

    expect(only.closeArgs).toEqual([]);
    expect(only.closed).toBe(false);
  });

  it('a superseded socket closing does NOT evict the one that replaced it', async () => {
    const reg = new StationRegistry(null, '', 'r1');
    const first = fakeWs();
    const second = fakeWs();
    await reg.attach({ sessionId: 's1', ws: first as any, ...ENTRY });
    await reg.attach({ sessionId: 's1', ws: second as any, ...ENTRY });

    await reg.detach('s1', first as any); // the old socket's close handler fires late

    expect(reg.isLocallyOwned('s1')).toBe(true);
    expect(reg.socketFor('s1')).toBe(second);
  });

  it('detach is idempotent', async () => {
    const reg = new StationRegistry(fakeRedis() as any, '', 'r1');
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });
    await reg.detach('s1');
    await expect(reg.detach('s1')).resolves.toBeUndefined();
    expect(reg.size()).toBe(0);
  });
});

describe('StationRegistry frame delivery', () => {
  it('sends synchronously and reports delivery', async () => {
    const reg = new StationRegistry(null, '', 'r1');
    const ws = fakeWs();
    await reg.attach({ sessionId: 's1', ws: ws as any, ...ENTRY });

    // Synchronous by design: `reserved` must reach the wire inside the dial tick.
    expect(reg.send('s1', { event: 'ready', session_id: 's1', state: 'break' })).toBe(true);
    expect(ws.sent[0]).toMatchObject({ event: 'ready' });
  });

  it('reports failure for a missing or closed socket instead of throwing', async () => {
    const reg = new StationRegistry(null, '', 'r1');
    const ws = fakeWs();
    await reg.attach({ sessionId: 's1', ws: ws as any, ...ENTRY });
    ws.readyState = 3;

    // The caller must treat false as "this agent is not really there".
    expect(reg.send('s1', { event: 'pong', server_ts: 1 })).toBe(false);
    expect(reg.send('nobody', { event: 'pong', server_ts: 1 })).toBe(false);
  });

  it('survives a socket that throws on send', async () => {
    const reg = new StationRegistry(null, '', 'r1');
    const ws = { ...fakeWs(), send() { throw new Error('EPIPE'); } };
    await reg.attach({ sessionId: 's1', ws: ws as any, ...ENTRY });
    expect(reg.send('s1', { event: 'pong', server_ts: 1 })).toBe(false);
  });

  it('broadcasts to every agent on a campaign and only that campaign', async () => {
    const reg = new StationRegistry(null, '', 'r1');
    const a = fakeWs(); const b = fakeWs(); const other = fakeWs();
    await reg.attach({ sessionId: 's1', ws: a as any, ...ENTRY });
    await reg.attach({ sessionId: 's2', ws: b as any, ...ENTRY });
    await reg.attach({ sessionId: 's3', ws: other as any, ...ENTRY, campaignId: 'camp-2' });

    const sent = reg.broadcast('camp-1', {
      event: 'campaign_state', campaign_id: 'camp-1', status: 'completed',
      reason: 'list_exhausted', dialing: false, message: 'done',
    });

    // This is the only way an idle agent — unreachable by any per-attempt frame —
    // learns the list has drained.
    expect(sent).toBe(2);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
  });

  it('counts only agents that actually received the broadcast', async () => {
    const reg = new StationRegistry(null, '', 'r1');
    const live = fakeWs(); const dead = fakeWs();
    await reg.attach({ sessionId: 's1', ws: live as any, ...ENTRY });
    await reg.attach({ sessionId: 's2', ws: dead as any, ...ENTRY });
    dead.readyState = 3;

    expect(reg.broadcast('camp-1', { event: 'pong', server_ts: 1 })).toBe(1);
  });

  it('lists sessions per campaign for the tick', async () => {
    const reg = new StationRegistry(null, '', 'r1');
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });
    await reg.attach({ sessionId: 's2', ws: fakeWs() as any, ...ENTRY, campaignId: 'camp-2' });

    expect(reg.sessionIdsForCampaign('camp-1')).toEqual(['s1']);
    expect(reg.all()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// `connectedBySession` — the supervisor floor's liveness column (§C.4, MAG-148).
//
// The property that matters is not "does it return booleans", it is that a Redis
// FAULT is distinguishable from an absent key. `ownerOf` deliberately conflates
// them (`null` is the fail-safe answer for its dial-path callers), and reusing it
// here would render every agent "disconnected" during a blip — a confident wrong
// answer on the one screen a supervisor acts from. So this method throws instead,
// and the route maps that to `connected: null` = unknown.
// ---------------------------------------------------------------------------
describe('StationRegistry.connectedBySession', () => {
  it('reports a held station as connected and an expired one as not', async () => {
    const redis = fakeRedis();
    const reg = new StationRegistry(redis as any, '', 'r1');
    await reg.attach({ sessionId: 'live', ws: fakeWs() as any, ...ENTRY });

    // 'gone' never attached, so no key was ever written — the shape an agent's
    // session row takes after their browser dies and the 30s TTL lapses.
    const out = await reg.connectedBySession(['live', 'gone']);

    expect(out.get('live')).toBe(true);
    expect(out.get('gone')).toBe(false);
  });

  it('asks Redis once for the whole floor', async () => {
    const redis = fakeRedis();
    const reg = new StationRegistry(redis as any, 'pfx:', 'r1');
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });
    await reg.attach({ sessionId: 's2', ws: fakeWs() as any, ...ENTRY });
    redis.mget.mockClear();

    await reg.connectedBySession(['s1', 's2', 's3']);

    // One MGET, not three GETs. The route is polled and a full shift is tens of
    // agents, so a per-row lookup is an N+1 that only appears under load.
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledWith(
      'pfx:agency:station:s1', 'pfx:agency:station:s2', 'pfx:agency:station:s3',
    );
  });

  it('THROWS on a Redis fault rather than reporting everyone disconnected', async () => {
    // The whole reason this method exists instead of a loop over `ownerOf`. A
    // swallowed error here becomes `false` for every agent on the floor, which is
    // indistinguishable from a genuinely empty shift and is acted on the same way.
    const redis = fakeRedis();
    redis.mget.mockRejectedValue(new Error('READONLY replica'));
    const reg = new StationRegistry(redis as any, '', 'r1');

    await expect(reg.connectedBySession(['s1'])).rejects.toThrow('READONLY');
  });

  it('short-circuits an empty floor without touching Redis', async () => {
    // `MGET` with no arguments is a Redis error, and a campaign between shifts is
    // the ordinary case — so this must never reach the client at all.
    const redis = fakeRedis();
    const reg = new StationRegistry(redis as any, '', 'r1');

    expect(await reg.connectedBySession([])).toEqual(new Map());
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('falls back to the in-process map when Redis is not configured', async () => {
    // Truthful under D2: with one replica, the sockets this process holds ARE the
    // live set. The fallback is the real answer here, not a degraded one.
    const reg = new StationRegistry(null, '', 'r1');
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });

    const out = await reg.connectedBySession(['s1', 's2']);

    expect(out.get('s1')).toBe(true);
    expect(out.get('s2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `stationPresence` — "is this agent's station held ANYWHERE" (ticket 86d44path).
//
// The method `POST /sessions/:id/available` should always have been asking. It
// was reading `isLocallyOwned`, an in-process `Map` lookup that answers "do *I*
// hold this socket" — the same question only while one replica is running.
// Behind a load balancer the station socket pins to whichever replica accepted
// the upgrade while the POST is routed independently, so an agent with a healthy,
// pinging console was told to open the station they already had.
//
// The three-valued return is the point, for a different reason than
// `connectedBySession`'s throw: an agent whose station is fine must not be told to
// open it, so a Redis fault reports `unknown` rather than folding into `absent`.
//
// NOTE: nothing in production calls this. `/available` deliberately still gates on
// `isLocallyOwned` — wiring this in removes the incidental protection that check
// gives the replica-local wrap-up/disposition guards below it on that route. So
// these are tests of a primitive, not of any route behaviour, and there is no
// route test to pair them with.
// ---------------------------------------------------------------------------
describe('StationRegistry.stationPresence', () => {
  it('reports a socket held by ANOTHER replica as connected', async () => {
    // The bug, stated directly. Two registries over one Redis: 'r2' holds the
    // socket, 'r1' is asked. `isLocallyOwned` says no; the agent is connected.
    const redis = fakeRedis();
    const holder = new StationRegistry(redis as any, '', 'r2');
    const asked = new StationRegistry(redis as any, '', 'r1');

    await holder.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });

    expect(asked.isLocallyOwned('s1')).toBe(false);
    expect(await asked.stationPresence('s1')).toBe('connected');
  });

  it('still reports a genuinely absent station as absent', async () => {
    // The guard must not go vacuous in the course of being fixed: an agent with no
    // socket anywhere must still be refused, or the pacing engine dials customers
    // into nobody.
    const redis = fakeRedis();
    const reg = new StationRegistry(redis as any, '', 'r1');

    expect(await reg.stationPresence('never-attached')).toBe('absent');
  });

  it('stops reporting connected once the holder detaches', async () => {
    const redis = fakeRedis();
    const holder = new StationRegistry(redis as any, '', 'r2');
    const asked = new StationRegistry(redis as any, '', 'r1');
    const ws = fakeWs();

    await holder.attach({ sessionId: 's1', ws: ws as any, ...ENTRY });
    expect(await asked.stationPresence('s1')).toBe('connected');

    await holder.detach('s1');

    // Detach drops the ownership key, so the sibling sees the departure without
    // waiting out the 30s TTL.
    expect(await asked.stationPresence('s1')).toBe('absent');
  });

  it('answers from the local map without asking Redis when we hold the socket', async () => {
    // This pins the compatibility short-circuit, NOT an authority claim: an
    // orphaned socket can sit in the map after its heartbeat-backed key has
    // expired, so the map is not the more authoritative of the two. What the
    // ordering buys is that a Redis blip cannot start refusing the single-replica
    // deployment, which is every deployment today.
    const redis = fakeRedis();
    const reg = new StationRegistry(redis as any, '', 'r1');
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });
    redis.get.mockClear();
    redis.get.mockRejectedValue(new Error('READONLY replica'));

    expect(await reg.stationPresence('s1')).toBe('connected');
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('reports UNKNOWN on a Redis fault, not absent', async () => {
    // `absent` would tell an agent whose console is healthy to open the station
    // they already have — the one instruction guaranteed not to help, since they
    // would reload a working console and hit the same refusal.
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error('READONLY replica'));
    const reg = new StationRegistry(redis as any, '', 'r1');

    expect(await reg.stationPresence('s1')).toBe('unknown');
  });

  it('treats a miss as absent, never unknown, when no Redis is configured', async () => {
    // D2 / no-Redis: the in-process map IS the authority, so a miss is a real
    // absence. Reporting `unknown` here would make every single-replica refusal
    // read as an infrastructure fault.
    const reg = new StationRegistry(null, '', 'r1');

    expect(await reg.stationPresence('s1')).toBe('absent');
    await reg.attach({ sessionId: 's1', ws: fakeWs() as any, ...ENTRY });
    expect(await reg.stationPresence('s1')).toBe('connected');
  });

  it('reads presence from key EXISTENCE, never from the replica id inside it', async () => {
    // Parsing the id would invite a `=== this.replicaId` comparison, which is
    // `isLocallyOwned` again wearing a Redis costume. The key's 30s TTL is renewed
    // by the station ping, so existence already means "a ping landed recently".
    const redis = fakeRedis();
    const reg = new StationRegistry(redis as any, '', 'r1');
    redis.store.set('agency:station:s1', 'not even json');

    expect(await reg.stationPresence('s1')).toBe('connected');
  });
});
