import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant, insertUser } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';

const audit = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: audit }));

const { AgentStateMachine, AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');
const { AwayRingService } = await import('../../../src/agency/away-ring.js');
const { AgencyRuntime } = await import('../../../src/agency/runtime.js');
const { agencyAgentSessionRepository: sessions, agencyPushDeviceRepository: devices } =
  await import('../../../src/db/repositories/agency.repository.js');
const { setPushSender, resetPushSender } = await import('../../../src/seams/push-sender.js');
const { AWAY_RING_BREAK } = await import('@magick-agency/domain/break-manager');

/*
 * Mode B's `away_ring` (IQ66, IQ67, N1, N2, N5) against REAL Redis running the REAL Lua and REAL
 * Postgres: the unit tier's Redis doubles match on script text and cannot say anything about the
 * scripts' atomicity or the SQL.
 *
 *  1. The Lua: enter (from the states asked, behind the `available` guard), the release of an
 *     unanswered push offer back to `away_ring`, the create-if-absent re-seed, the end, the station
 *     close's decision, and `ring` cleared by every other state write: a named catalog break never
 *     carries `ring = 1`, and the inbound reservation takes a `break` only with it.
 *  2. The push-device repository: register (revive, token handed to one row), opt-in, revoke, a
 *     failure (`unregistered` revokes), the session's device.
 *  3. The session mirror: `away_ring_since` stamped once per absence, kept across a ring, cleared by
 *     every real end; the take-over's claim ends it in the same statement, logged.
 *  4. `AwayRingService`: the refusals in order, the reconcile (a key gone, a mirror the startup
 *     reaper rewrote, a crash mid-ring then boot, a tick during a ring, the ends: max age, flag
 *     off, revoked, opted out), the connector's return after a ring, the take-over's end.
 *  5. The runtime's "no socket means offline" paths: the station close keeps `away_ring` (and a
 *     close racing a ring's compare-and-swap never knocks a held push offer offline), the
 *     rehydrate ends it on the agent's return, the release keeps it, and a queued `away_ring`
 *     applies with no socket at all.
 */

const MAX_AGE = 4 * 60 * 60 * 1000;
const key = (sid: string) => `agency:agent:${sid}:state`;

interface FakeSender {
  sent: Array<{ deviceRowId: string; payload: Record<string, unknown> }>;
  configured: boolean;
  next: { ok: true } | { ok: false; reason: 'unregistered' | 'unavailable' };
}
const sender: FakeSender = { sent: [], configured: true, next: { ok: true } };

let user: string;
let campaignId: string;

beforeEach(async () => {
  await truncateAll();
  await flushTestRedis();
  audit.log.mockReset();
  await insertTenant({ id: DEFAULTS.tenantId });
  user = (await insertUser()).id as string;
  campaignId = (await insertAgencyCampaign()).id as string;
  sender.sent = [];
  sender.configured = true;
  sender.next = { ok: true };
  setPushSender({
    async send(device, payload) {
      sender.sent.push({ deviceRowId: device.id, payload: payload as unknown as Record<string, unknown> });
      return sender.next;
    },
    configured: () => sender.configured,
  });
});
afterEach(() => { resetPushSender(); });
afterAll(async () => {
  await closeTestRedis();
  await closeTestPool();
});

const sm = () => new AgentStateMachine(getTestRedis(), '');

async function row(sid: string) {
  const { rows } = await getTestPool().query('SELECT * FROM agency_agent_sessions WHERE id = $1', [sid]);
  return rows[0];
}

async function session(overrides: Record<string, unknown> = {}) {
  return insertAgentSession(campaignId, { agent_user_id: user, station_device_id: 'phone-aaaa-1', ...overrides }) as Promise<{ id: string }>;
}

async function device(overrides: Partial<{ deviceId: string; ringEnabled: boolean; userId: string; token: string }> = {}) {
  return devices.register({
    tenantId: DEFAULTS.tenantId,
    userId: overrides.userId ?? user,
    deviceId: overrides.deviceId ?? 'phone-aaaa-1',
    platform: 'android',
    token: overrides.token ?? `fcm-${randomUUID()}`,
    appBuild: '1.4.0+40',
    ringEnabled: overrides.ringEnabled ?? true,
  });
}

function service(opts: { attached?: Set<string>; holds?: Set<string>; allowed?: boolean; agents?: InstanceType<typeof AgentStateMachine> } = {}) {
  const attached = opts.attached ?? new Set<string>();
  const sent: unknown[] = [];
  /** The connector's cancel of a ring in flight (N1), asked by an end during a ring; here the ring was answered and stands. */
  const cancels: Array<[string, string]> = [];
  const svc = new AwayRingService({
    agents: opts.agents ?? sm(),
    stations: { isLocallyOwned: (id: string) => attached.has(id), send: (_id: string, f: unknown) => { sent.push(f); return true; } } as never,
    inbound: () => ({
      holdsPushOffer: (id: string) => opts.holds?.has(id) ?? false,
      cancelRingForAwayRingEnd: async (id: string, reason: string) => { cancels.push([id, reason]); return 'answered'; },
    }) as never,
    ringAllowed: async () => opts.allowed ?? true,
  });
  svc.configure({ maxAgeMs: MAX_AGE });
  return { svc, frames: sent, cancels };
}

/** Wait for the fire-and-forget `ring_off` push. */
async function pushes(n: number) {
  for (let i = 0; i < 100 && sender.sent.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return sender.sent;
}

// ─── 1. The Lua ────────────────────────────────────────────────────────────────

describe('the away_ring Lua (real Redis)', () => {
  it('enters from available: break, ring, a fresh since, the TTL it was given; nothing renews it', async () => {
    const s = randomUUID();
    await sm().set(s, 'available');
    expect(await sm().enterAwayRing(s, { ttlMs: 3_600_000, fromStates: ['available'] })).toEqual({ ok: true, from: 'available' });
    expect(await sm().get(s)).toMatchObject({ state: 'break', ring: true, inboundCallId: null, attemptId: null });
    const ttl = await getTestRedis().pttl(key(s));
    expect(ttl).toBeGreaterThan(AGENT_LEASE_MS.break);
    expect(ttl).toBeLessThanOrEqual(3_600_000);
  });

  it('enters only from the states asked, and never past the available guard', async () => {
    const s = randomUUID();
    await sm().set(s, 'break');
    expect(await sm().enterAwayRing(s, { ttlMs: 60_000, fromStates: ['available'] })).toEqual({ ok: false, reason: 'wrong_state', state: 'break' });
    expect(await sm().enterAwayRing(s, { ttlMs: 60_000, fromStates: ['break'] })).toEqual({ ok: true, from: 'break' });

    const manual = randomUUID();
    await sm().set(manual, 'break');
    await sm().claimManual(manual, 'mc-1');
    expect(await sm().enterAwayRing(manual, { ttlMs: 60_000, fromStates: ['break'] })).toMatchObject({ ok: false, reason: 'manual_call_live' });

    const owed = randomUUID();
    await sm().rehydrateInbound(owed, 'ib-owed');
    expect(await sm().enterAwayRing(owed, { ttlMs: 60_000, fromStates: ['break'] })).toMatchObject({ ok: false, reason: 'inbound_call_owed' });
    expect((await sm().get(owed))!.ring).toBe(false);

    expect(await sm().enterAwayRing(randomUUID(), { ttlMs: 60_000, fromStates: ['break'] })).toEqual({ ok: false, reason: 'wrong_state', state: null });
  });

  it('a named catalog break never gains ring = 1: every other state write clears it', async () => {
    const s = randomUUID();
    await sm().set(s, 'available');
    await sm().enterAwayRing(s, { ttlMs: 60_000, fromStates: ['available'] });
    // The agent's own catalog break (the set), written over away_ring: no ring.
    await sm().set(s, 'break');
    expect(await sm().get(s)).toMatchObject({ state: 'break', ring: false });
    // ...so the inbound reservation does not take it, and away_ring is never re-entered by a ring.
    expect(await sm().reserveForInbound(s, 'ib-1', ['break'])).toEqual({ ok: false, reason: 'wrong_state', state: 'break' });

    await sm().enterAwayRing(s, { ttlMs: 60_000, fromStates: ['break'] });
    await sm().transition(s, 'break', 'available');
    expect((await sm().get(s))!.ring).toBe(false);

    await sm().enterAwayRing(s, { ttlMs: 60_000, fromStates: ['available'] });
    await sm().set(s, 'available');
    expect(await sm().get(s)).toMatchObject({ state: 'available', ring: false });
  });

  it('the inbound reservation takes away_ring (break with ring) and clears ring; the plain reasons still need their states', async () => {
    const s = randomUUID();
    await sm().set(s, 'available');
    await sm().enterAwayRing(s, { ttlMs: 60_000, fromStates: ['available'] });
    expect(await sm().reserveForInbound(s, 'ib-1', ['available'])).toEqual({ ok: false, reason: 'wrong_state', state: 'break' });
    expect(await sm().reserveForInbound(s, 'ib-1', ['break'])).toEqual({ ok: true, from: 'break' });
    expect(await sm().get(s)).toMatchObject({ state: 'reserved', ring: false, inboundCallId: 'ib-1', pushOffer: true });
    // A push offer is marked so, in the same script; a station offer (from available) is not, and
    // every way the field ends goes with it.
    const station = randomUUID();
    await sm().set(station, 'available');
    await sm().reserveForInbound(station, 'ib-2', ['available']);
    expect((await sm().get(station))!.pushOffer).toBe(false);
    await sm().set(s, 'on_call');
    expect(await sm().get(s)).toMatchObject({ state: 'on_call', inboundCallId: 'ib-1', pushOffer: false });
    expect(await sm().setOfflineUnlessAway(s, false)).toBe('offline');
  });

  it('an unanswered push offer goes back to away_ring, only by the call that holds the session', async () => {
    const s = randomUUID();
    await sm().set(s, 'available');
    await sm().enterAwayRing(s, { ttlMs: 60_000, fromStates: ['available'] });
    await sm().reserveForInbound(s, 'ib-1', ['break']);
    const before = (await sm().get(s))!.since!;
    await new Promise((r) => setTimeout(r, 5));
    expect(await sm().releaseInboundToAwayRing(s, 'ib-other', 600_000)).toBe(false);
    expect(await sm().get(s)).toMatchObject({ state: 'reserved', inboundCallId: 'ib-1' });
    expect(await sm().releaseInboundToAwayRing(s, 'ib-1', 600_000)).toBe(true);
    const live = (await sm().get(s))!;
    expect(live).toMatchObject({ state: 'break', ring: true, inboundCallId: null });
    expect(live.since!).toBeGreaterThan(before);
    expect(await getTestRedis().pttl(key(s))).toBeGreaterThan(AGENT_LEASE_MS.reserved_dialing);
  });

  it('the re-seed creates a key only where there is none', async () => {
    const s = randomUUID();
    expect(await sm().reseedAwayRing(s, { sinceMs: 1_000, ttlMs: 120_000 })).toBe(true);
    expect(await sm().get(s)).toMatchObject({ state: 'break', ring: true, since: 1_000 });
    const held = randomUUID();
    await sm().reserveForInbound(held, 'ib-1', ['available']).catch(() => undefined);
    await sm().set(held, 'available');
    await sm().reserveForInbound(held, 'ib-1', ['available']);
    expect(await sm().reseedAwayRing(held, { sinceMs: 1_000, ttlMs: 120_000 })).toBe(false);
    expect(await sm().get(held)).toMatchObject({ state: 'reserved', ring: false, inboundCallId: 'ib-1' });
  });

  it('the end: break with the ordinary lease, offline on request, nothing from any other state', async () => {
    const s = randomUUID();
    await sm().set(s, 'available');
    await sm().enterAwayRing(s, { ttlMs: 3_600_000, fromStates: ['available'] });
    expect(await sm().endAwayRing(s, { offline: false })).toEqual({ outcome: 'ended', state: 'break' });
    expect(await sm().get(s)).toMatchObject({ state: 'break', ring: false });
    expect(await getTestRedis().pttl(key(s))).toBeLessThanOrEqual(AGENT_LEASE_MS.break);

    await sm().enterAwayRing(s, { ttlMs: 3_600_000, fromStates: ['break'] });
    expect(await sm().endAwayRing(s, { offline: true })).toEqual({ outcome: 'ended', state: 'offline' });
    expect(await sm().get(s)).toMatchObject({ state: 'offline', ring: false });

    expect(await sm().endAwayRing(s, { offline: true })).toEqual({ outcome: 'not_away_ring', state: 'offline' });
    const gone = randomUUID();
    expect(await sm().endAwayRing(gone, { offline: false })).toEqual({ outcome: 'no_key', state: null });
    expect(await getTestRedis().exists(key(gone))).toBe(0);
    expect(await sm().endAwayRing(gone, { offline: true })).toEqual({ outcome: 'no_key', state: 'offline' });
  });

  it('a heartbeat renew never touches away_ring, even one that read break (device_away) before the switch', async () => {
    const s = randomUUID();
    await sm().set(s, 'break');
    // The heartbeat read `break` here (`device_away`, renewed like any break)...
    const read = (await sm().get(s))!.state;
    // ...the app switched to away_ring meanwhile...
    expect(await sm().enterAwayRing(s, { ttlMs: 3_600_000, fromStates: ['break'] })).toMatchObject({ ok: true });
    // ...and the renew, state-matched on `break`, must not cut the absence's TTL to the break lease.
    expect(await sm().renew(s, read, AGENT_LEASE_MS.break)).toBe(false);
    expect(await getTestRedis().pttl(key(s))).toBeGreaterThan(AGENT_LEASE_MS.break);
    // A plain break still renews.
    await sm().endAwayRing(s, { offline: false });
    expect(await sm().renew(s, 'break', AGENT_LEASE_MS.break)).toBe(true);
  });

  it('the station close writes offline unless away_ring, or a push offer the connector holds', async () => {
    const away = randomUUID();
    await sm().set(away, 'available');
    await sm().enterAwayRing(away, { ttlMs: 60_000, fromStates: ['available'] });
    expect(await sm().setOfflineUnlessAway(away, false)).toBe('kept');
    expect(await sm().get(away)).toMatchObject({ state: 'break', ring: true });

    const plain = randomUUID();
    await sm().set(plain, 'break');
    expect(await sm().setOfflineUnlessAway(plain, false)).toBe('offline');

    // A station offer the connector says is a push offer (its synchronous answer) is kept; a
    // station offer it does not hold is not.
    const offered = randomUUID();
    await sm().set(offered, 'available');
    await sm().reserveForInbound(offered, 'ib-1', ['available']);
    expect(await sm().setOfflineUnlessAway(offered, true)).toBe('kept');
    expect(await sm().get(offered)).toMatchObject({ state: 'reserved', inboundCallId: 'ib-1' });
    expect(await sm().setOfflineUnlessAway(offered, false)).toBe('offline');

    // A ring (reserved from away_ring): kept on the field alone, whatever the connector answered.
    const ringing = randomUUID();
    await sm().set(ringing, 'available');
    await sm().enterAwayRing(ringing, { ttlMs: 60_000, fromStates: ['available'] });
    await sm().reserveForInbound(ringing, 'ib-3', ['break']);
    expect(await sm().setOfflineUnlessAway(ringing, false)).toBe('kept');
    expect(await sm().get(ringing)).toMatchObject({ state: 'reserved', inboundCallId: 'ib-3', pushOffer: true });
  });
});

// ─── 2. The push-device repository ─────────────────────────────────────────────

describe('the push-device repository (real Postgres)', () => {
  it('registers, keeps the opt-in when it is not given, revives a revoked row and clears its failure', async () => {
    const first = await devices.register({
      tenantId: DEFAULTS.tenantId, userId: user, deviceId: 'phone-aaaa-1', platform: 'android', token: 'tok-1', appBuild: '1.0+1',
    });
    expect(first).toMatchObject({ ring_enabled: false, fcm_token: 'tok-1', voip_token: null, revoked_at: null });
    await devices.setRingEnabled(user, 'phone-aaaa-1', true);
    await devices.recordFailure(first.id, 'unregistered');
    expect((await devices.find(user, 'phone-aaaa-1'))!.revoked_at).not.toBeNull();
    expect(await devices.setRingEnabled(user, 'phone-aaaa-1', false)).toBeNull();
    const again = await devices.register({
      tenantId: DEFAULTS.tenantId, userId: user, deviceId: 'phone-aaaa-1', platform: 'android', token: 'tok-2', appBuild: '1.0+2',
    });
    expect(again).toMatchObject({ id: first.id, ring_enabled: true, fcm_token: 'tok-2', revoked_at: null, last_failure_at: null, last_failure_reason: null });
  });

  it('hands a token to one live row: the older row holding it is revoked, whoever it belongs to', async () => {
    const other = (await insertUser()).id as string;
    const old = await device({ userId: other, deviceId: 'phone-old-01', token: 'shared-token' });
    const mine = await device({ deviceId: 'phone-new-01', token: 'shared-token' });
    expect((await devices.find(other, 'phone-old-01'))!.revoked_at).not.toBeNull();
    expect(mine.revoked_at).toBeNull();
    expect(old.id).not.toBe(mine.id);
  });

  it('revoke is idempotent; a failure is recorded, and only unregistered revokes', async () => {
    const d = await device();
    expect(await devices.recordFailure(d.id, 'unavailable')).toEqual({ revoked: false });
    expect(await devices.find(user, 'phone-aaaa-1')).toMatchObject({ last_failure_reason: 'unavailable', revoked_at: null });
    expect((await devices.revoke(user, 'phone-aaaa-1'))!.id).toBe(d.id);
    expect(await devices.revoke(user, 'phone-aaaa-1')).toBeNull();
    expect(await devices.recordFailure(d.id, 'unregistered')).toEqual({ revoked: false });
  });

  it("finds a session's device by its station device id, and none for another agent's", async () => {
    const d = await device();
    const s = await session();
    expect((await devices.findForSession(s.id))!.id).toBe(d.id);
    const stranger = await insertAgentSession(campaignId, { station_device_id: 'phone-aaaa-1' }) as { id: string };
    expect(await devices.findForSession(stranger.id)).toBeNull();
  });
});

// ─── 3. The session mirror ─────────────────────────────────────────────────────

describe('the session mirror of away_ring (real Postgres)', () => {
  it('stamps away_ring_since once per absence, keeps it across a ring, and clears it on every real end', async () => {
    const s = await session({ state: 'available' });
    await sessions.setState(s.id, 'break', 'away_ring');
    const since = (await row(s.id)).away_ring_since as Date;
    expect(since).toBeInstanceOf(Date);
    await sessions.setState(s.id, 'reserved');
    expect((await row(s.id)).away_ring_since).toEqual(since);
    expect(await sessions.restoreAwayRing(s.id)).toBe(true);
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'away_ring', away_ring_since: since });
    await sessions.setState(s.id, 'break', 'away_ring');
    expect((await row(s.id)).away_ring_since).toEqual(since);

    for (const [state, reason] of [['available', null], ['break', 'lunch'], ['break', 'device_away'], ['offline', undefined]] as const) {
      await sessions.setState(s.id, 'break', 'away_ring');
      await getTestPool().query('UPDATE agency_agent_sessions SET ring_misses = 1 WHERE id = $1', [s.id]);
      await sessions.setState(s.id, state, reason);
      const r = await row(s.id);
      expect(r.away_ring_since, `${state}/${reason}`).toBeNull();
      expect(r.ring_misses, `${state}/${reason}`).toBe(state === 'available' ? 0 : 1);
    }
    expect(await sessions.restoreAwayRing(s.id)).toBe(false);
    await sessions.setState(s.id, 'break', 'away_ring');
    await sessions.leave(s.id);
    expect((await row(s.id)).away_ring_since).toBeNull();
  });

  it('ends away_ring: device_away on break or offline, once', async () => {
    const s = await session({ state: 'available' });
    await sessions.setState(s.id, 'break', 'away_ring');
    expect(await sessions.endAwayRing(s.id, 'offline')).toMatchObject({ id: s.id, agent_user_id: user, station_device_id: 'phone-aaaa-1', from_state: 'break' });
    expect(await row(s.id)).toMatchObject({ state: 'offline', break_reason: 'device_away', away_ring_since: null });
    expect(await sessions.endAwayRing(s.id, 'offline')).toBeNull();
  });

  it('the take-over ends away_ring in the claim itself, and logs the switch to device_away', async () => {
    const s = await session({ state: 'available' });
    const absence = new Date(Date.now() - 90_000);
    expect(await sessions.enterAwayRing(s.id, absence)).toEqual(absence);
    // A reconnect from the device holding it moves nothing and ends nothing.
    expect(await sessions.claimStationDevice(s.id, { deviceId: 'phone-aaaa-1', takeOver: false })).toEqual({ ok: true });
    expect(await sessions.claimStationDevice(s.id, { deviceId: 'laptop-bbbb-2', takeOver: true }))
      .toEqual({ ok: true, endedAwayRing: { previousDeviceId: 'phone-aaaa-1', awaySince: absence } });
    expect(await row(s.id)).toMatchObject({ station_device_id: 'laptop-bbbb-2', state: 'break', break_reason: 'device_away', away_ring_since: null });
    // One pause: the switch to device_away keeps the absence's start.
    expect((await row(s.id)).state_since).toEqual(absence);
    const { rows } = await getTestPool().query(
      `SELECT from_state, to_state, break_reason FROM agency_agent_session_events WHERE session_id = $1 ORDER BY at`, [s.id]);
    expect(rows.at(-1)).toEqual({ from_state: 'break', to_state: 'break', break_reason: 'device_away' });

    // Mid-ring (`reserved`): the absence ends, the state is the connector's.
    const ringing = await session({ agent_user_id: (await insertUser()).id, state: 'available' });
    await sessions.setState(ringing.id, 'break', 'away_ring');
    await sessions.setState(ringing.id, 'reserved');
    expect((await sessions.claimStationDevice(ringing.id, { deviceId: 'laptop-cccc-3', takeOver: true })).ok).toBe(true);
    expect(await row(ringing.id)).toMatchObject({ state: 'reserved', away_ring_since: null });
  });
});

// ─── 4. AwayRingService ────────────────────────────────────────────────────────

describe('AwayRingService', () => {
  async function onAwayRing(opts: { sinceAgoMs?: number } = {}) {
    const s = await session({ state: 'available' });
    await sm().set(s.id, 'available');
    const { svc } = service();
    const record = (await sessions.findById(s.id))!;
    expect(await svc.enter(record, ['available'])).toMatchObject({ ok: true });
    if (opts.sinceAgoMs) {
      await getTestPool().query(`UPDATE agency_agent_sessions SET away_ring_since = now() - make_interval(secs => $2::float8 / 1000) WHERE id = $1`, [s.id, opts.sinceAgoMs]);
    }
    return s;
  }

  it('refuses away_ring in the order of the remedies', async () => {
    const s = await session();
    const rec = async () => (await sessions.findById(s.id))!;
    expect(await service({ allowed: false }).svc.refusalFor(await rec())).toBe('ring_not_allowed');
    expect(await service().svc.refusalFor(await rec())).toBe('no_push_device');
    const d = await device({ ringEnabled: false });
    expect(await service().svc.refusalFor(await rec())).toBe('ring_disabled');
    await devices.setRingEnabled(user, 'phone-aaaa-1', true);
    sender.configured = false;
    expect(await service().svc.refusalFor(await rec())).toBe('push_unavailable');
    sender.configured = true;
    expect(await service().svc.refusalFor(await rec())).toBeNull();
    await getTestPool().query(`UPDATE agency_agent_sessions SET away_ring_since = now() - interval '5 hours' WHERE id = $1`, [s.id]);
    expect(await service().svc.refusalFor(await rec())).toBe('ring_not_allowed');
    await devices.revoke(user, 'phone-aaaa-1');
    expect(await service().svc.refusalFor(await rec())).toBe('no_push_device');
    expect(d.id).toBeTruthy();
    const other = await insertAgentSession(campaignId, { agent_user_id: user, station_device_id: null, left_at: new Date() }) as { id: string };
    expect(await service().svc.refusalFor((await sessions.findById(other.id))!)).toBe('no_push_device');
  });

  it('enter: Redis away_ring with the time left, the mirror on away_ring with the absence stamped', async () => {
    await device();
    const s = await onAwayRing();
    expect(await sm().get(s.id)).toMatchObject({ state: 'break', ring: true });
    expect(await getTestRedis().pttl(key(s.id))).toBeGreaterThan(MAX_AGE - 60_000);
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'away_ring' });
    expect((await row(s.id)).away_ring_since).toBeInstanceOf(Date);
  });

  it('reconcile: a key gone while the database says away_ring is re-seeded, create-if-absent, with the time left', async () => {
    await device();
    const s = await onAwayRing({ sinceAgoMs: 60 * 60 * 1000 });
    await getTestRedis().del(key(s.id));
    const summary = await service().svc.reconcile();
    expect(summary).toMatchObject({ candidates: 1, reseeded: 1, ended: 0 });
    expect(await sm().get(s.id)).toMatchObject({ state: 'break', ring: true });
    const ttl = await getTestRedis().pttl(key(s.id));
    expect(ttl).toBeLessThanOrEqual(MAX_AGE - 60 * 60 * 1000);
    expect(ttl).toBeGreaterThan(MAX_AGE - 60 * 60 * 1000 - 60_000);
    // Idempotent: the next tick finds it on away_ring and does nothing.
    expect(await service().svc.reconcile()).toMatchObject({ reseeded: 0, restored: 0, ended: 0, cleared: 0 });
  });

  it('reconcile: the startup reaper wrote the mirror offline; Redis still rings, so the mirror is restored', async () => {
    await device();
    const s = await onAwayRing();
    await sessions.markAllOffline();
    expect(await row(s.id)).toMatchObject({ state: 'offline', break_reason: 'away_ring' });
    expect(await service().svc.reconcile()).toMatchObject({ restored: 1 });
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'away_ring' });
  });

  it('reconcile: a crash mid-ring, then boot: skipped while the ring holds the key, re-seeded once it lapses', async () => {
    await device();
    const s = await onAwayRing();
    // The ring: Redis reserved for the call, the mirror `reserved` (its reason nulled).
    expect((await sm().reserveForInbound(s.id, 'ib-1', ['break'])).ok).toBe(true);
    await sessions.setState(s.id, 'reserved');
    // The crash, and the boot's reaper.
    await sessions.markAllOffline();
    expect(await row(s.id)).toMatchObject({ state: 'offline', break_reason: null });
    expect(await service().svc.reconcile()).toMatchObject({ candidates: 1, skippedInFlight: 1, reseeded: 0 });
    expect(await sm().get(s.id)).toMatchObject({ state: 'reserved', inboundCallId: 'ib-1' });
    // The dead process's `reserved` lease lapses.
    await getTestRedis().del(key(s.id));
    expect(await service().svc.reconcile()).toMatchObject({ reseeded: 1 });
    expect(await sm().get(s.id)).toMatchObject({ state: 'break', ring: true });
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'away_ring' });
  });

  it('reconcile: a tick during a ring the connector holds writes nothing itself; one past its end asks the connector to cancel the ring (N1)', async () => {
    await device();
    const s = await onAwayRing();
    await sm().reserveForInbound(s.id, 'ib-1', ['break']);
    await sessions.setState(s.id, 'reserved');
    await devices.setRingEnabled(user, 'phone-aaaa-1', false);
    const { svc, cancels } = service({ holds: new Set([s.id]) });
    // The connector answers that the ring was already answered: it runs to its end, nothing is written.
    expect(await svc.reconcile()).toMatchObject({ skippedInFlight: 1, ended: 0 });
    expect(cancels).toEqual([[s.id, 'opted_out']]);
    expect(await sm().get(s.id)).toMatchObject({ state: 'reserved', inboundCallId: 'ib-1' });
    expect(await row(s.id)).toMatchObject({ state: 'reserved' });
    expect(sender.sent).toEqual([]);
  });

  it('reconcile ends an absence past its maximum age: offline with no socket, device_away, ring_off, audited', async () => {
    const d = await device();
    const s = await onAwayRing({ sinceAgoMs: MAX_AGE + 1_000 });
    const absence = (await row(s.id)).away_ring_since as Date;
    expect(await service().svc.reconcile()).toMatchObject({ ended: 1 });
    expect(await sm().get(s.id)).toMatchObject({ state: 'offline', ring: false });
    expect(await row(s.id)).toMatchObject({ state: 'offline', break_reason: 'device_away', away_ring_since: null });
    // The ring_off names the absence it ends, so a late one cannot end the next on the phone.
    expect(await pushes(1)).toEqual([{
      deviceRowId: d.id,
      payload: { type: 'ring_off', session_id: s.id, reason: 'max_age', away_since: absence.toISOString() },
    }]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agency_session.away_ring_ended', resource_id: s.id, actor_type: 'system',
      details: expect.objectContaining({ reason: 'max_age', to_state: 'offline' }),
    }));
  });

  it.each([
    ['the flags off', 'flag_off', async (): Promise<void> => undefined, false],
    ['the device revoked', 'revoked', async (): Promise<void> => { await devices.revoke(user, 'phone-aaaa-1'); }, true],
    ['the agent opted out', 'opted_out', async (): Promise<void> => { await devices.setRingEnabled(user, 'phone-aaaa-1', false); }, true],
  ] as const)('reconcile ends it with %s (%s); a station attached keeps the break', async (_what, reason, change, allowed) => {
    await device();
    const s = await onAwayRing();
    await change();
    const { svc, frames } = service({ allowed, attached: new Set([s.id]) });
    expect(await svc.reconcile()).toMatchObject({ ended: 1 });
    expect(await sm().get(s.id)).toMatchObject({ state: 'break', ring: false });
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'device_away', away_ring_since: null });
    expect(frames).toEqual([expect.objectContaining({ event: 'agent_state', state: 'break', break_reason: 'device_away' })]);
    expect((await pushes(1))[0]!.payload).toMatchObject({ type: 'ring_off', reason });
  });

  it('a server-ended absence keeps its start: Redis, the frame, the mirror and the ring_off all name the instant away_ring began', async () => {
    await device();
    const s = await session({ state: 'available' });
    await sm().set(s.id, 'available');
    const { svc, frames } = service({ attached: new Set([s.id]) });
    const entered = await svc.enter((await sessions.findById(s.id))!, ['available']);
    if (!entered.ok) throw new Error('not entered');
    // Redis and the mirror stamp the one instant the frame (and the HTTP answer) said.
    expect(frames).toEqual([{ event: 'agent_state', state: 'break', since: entered.since, break_reason: 'away_ring' }]);
    expect(new Date((await sm().get(s.id))!.since!).toISOString()).toBe(entered.since);
    expect(((await row(s.id)).away_ring_since as Date).toISOString()).toBe(entered.since);
    // A ring came and went: Redis's `since` (the idle clock, IQ63) and `state_since` move on.
    await sm().reserveForInbound(s.id, 'ib-1', ['break']);
    await sessions.setState(s.id, 'reserved');
    await new Promise((r) => setTimeout(r, 20));
    expect(await svc.releaseInbound(s.id, 'ib-1')).toBe('away_ring');
    expect((await sm().get(s.id))!.since).toBeGreaterThan(Date.parse(entered.since));
    // Two misses (or any server end) with the app's station here: device_away, `since` kept.
    frames.length = 0;
    expect(await svc.end(s.id, 'ring_missed')).toBe('ended');
    expect(frames).toEqual([{ event: 'agent_state', state: 'break', since: entered.since, break_reason: 'device_away' }]);
    expect(await sm().get(s.id)).toMatchObject({ state: 'break', ring: false, since: Date.parse(entered.since) });
    expect(((await row(s.id)).state_since as Date).toISOString()).toBe(entered.since);
    expect((await pushes(1))[0]!.payload).toEqual({ type: 'ring_off', session_id: s.id, reason: 'ring_missed', away_since: entered.since });
    // The transition log still splits the pause by reason at the switch's own instant.
    const { rows } = await getTestPool().query(
      'SELECT to_state, break_reason, at FROM agency_agent_session_events WHERE session_id = $1 ORDER BY at, id', [s.id]);
    expect(rows.map((r) => r.break_reason)).toEqual(['away_ring', null, 'away_ring', 'device_away']);
    expect((rows.at(-1)!.at as Date).getTime()).toBeGreaterThan(Date.parse(entered.since));
  });

  it('with no station here the end writes offline now, and the ring_off still names the absence', async () => {
    await device();
    const s = await session({ state: 'available' });
    await sm().set(s.id, 'available');
    const { svc } = service();
    const entered = await svc.enter((await sessions.findById(s.id))!, ['available']);
    if (!entered.ok) throw new Error('not entered');
    await new Promise((r) => setTimeout(r, 20));
    expect(await svc.end(s.id, 'ring_missed')).toBe('ended');
    expect((await sm().get(s.id))!.since).toBeGreaterThan(Date.parse(entered.since));
    expect(((await row(s.id)).state_since as Date).getTime()).toBeGreaterThan(Date.parse(entered.since));
    expect((await pushes(1))[0]!.payload).toMatchObject({ reason: 'ring_missed', away_since: entered.since });
  });

  it("an end whose Redis write the reconcile saw first (it cleared the key) still ends the mirror: device_away, not a row left on away_ring", async () => {
    await device();
    const s = await onAwayRing();
    // `end`'s Redis write lands...
    expect(await sm().endAwayRing(s.id, { offline: true })).toMatchObject({ outcome: 'ended' });
    // ...a reconcile tick reads Redis off away_ring with nothing in flight, and clears the key...
    expect(await service().svc.reconcile()).toMatchObject({ cleared: 1 });
    // ...then `end`'s mirror write: it must still match the row.
    expect(await sessions.endAwayRing(s.id, 'offline')).toMatchObject({ id: s.id, from_state: 'break' });
    expect(await row(s.id)).toMatchObject({ state: 'offline', break_reason: 'device_away', away_ring_since: null });
  });

  it("reconcile clears a stale key when Redis is off away_ring with nothing in flight", async () => {
    await device();
    const s = await onAwayRing();
    await sm().set(s.id, 'available');
    expect(await service().svc.reconcile()).toMatchObject({ cleared: 1 });
    expect((await row(s.id)).away_ring_since).toBeNull();
  });

  it('reconcile never wipes a NEW absence entered between its read and its clear', async () => {
    await device();
    const s = await onAwayRing();
    // Whatever moved the agent off away_ring ended that absence: only the key is left behind...
    await sm().set(s.id, 'available');
    // ...and, while the pass awaits Redis, the agent goes away ringing again (a fresh start).
    const machine = sm();
    const realGet = machine.get.bind(machine);
    const fresh = new Date(Date.now() + 5_000);
    let entered = false;
    machine.get = async (id: string) => {
      const live = await realGet(id);
      if (id === s.id && !entered) {
        entered = true;
        await getTestPool().query('UPDATE agency_agent_sessions SET away_ring_since = $2 WHERE id = $1', [s.id, fresh]);
      }
      return live;
    };
    expect(await service({ agents: machine }).svc.reconcile()).toMatchObject({ candidates: 1, cleared: 0 });
    expect((await row(s.id)).away_ring_since).toEqual(fresh);
    // The clear names the absence it read, to the millisecond.
    expect(await sessions.clearAwayRingSince(s.id, new Date(fresh.getTime() - 1))).toBe(false);
    expect(await sessions.clearAwayRingSince(s.id, fresh)).toBe(true);
  });

  it("the connector's return after an unanswered ring: Redis and the mirror back on away_ring; nothing for a call that does not hold it", async () => {
    await device();
    const s = await onAwayRing();
    const since = (await row(s.id)).away_ring_since;
    await sm().reserveForInbound(s.id, 'ib-1', ['break']);
    await sessions.setState(s.id, 'reserved');
    const { svc } = service();
    expect(await svc.releaseInbound(s.id, 'ib-other')).toBe('not_held');
    expect(await svc.releaseInbound(s.id, 'ib-1')).toBe('away_ring');
    expect(await sm().get(s.id)).toMatchObject({ state: 'break', ring: true, inboundCallId: null });
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'away_ring', away_ring_since: since });

    // The absence ended under the ring (a take-over): Redis is not put back on away_ring.
    await sm().reserveForInbound(s.id, 'ib-2', ['break']);
    await sessions.claimStationDevice(s.id, { deviceId: 'laptop-bbbb-2', takeOver: true });
    expect(await svc.releaseInbound(s.id, 'ib-2')).toBe('not_away_ring');
    expect(await sm().get(s.id)).toMatchObject({ state: 'reserved', inboundCallId: 'ib-2' });
  });

  it('the take-over: Redis ring cleared, the old device told taken_over', async () => {
    const d = await device();
    const s = await onAwayRing();
    const claim = await sessions.claimStationDevice(s.id, { deviceId: 'laptop-bbbb-2', takeOver: true });
    expect(claim).toMatchObject({ endedAwayRing: { previousDeviceId: 'phone-aaaa-1' } });
    if (!claim.ok || !claim.endedAwayRing) throw new Error('no end');
    const absence = claim.endedAwayRing.awaySince!;
    await service().svc.endOnTakeOver(s.id, user, 'phone-aaaa-1', absence);
    // The new device is shown the same pause: `since` kept at the absence's start.
    expect(await sm().get(s.id)).toMatchObject({ state: 'break', ring: false, since: absence.getTime() });
    expect(await pushes(1)).toEqual([{
      deviceRowId: d.id, payload: { type: 'ring_off', session_id: s.id, reason: 'taken_over', away_since: absence.toISOString() },
    }]);
  });

  it('a push the carrier says is unregistered revokes the device', async () => {
    const d = await device();
    sender.next = { ok: false, reason: 'unregistered' };
    expect(await service().svc.send(d, { type: 'test_ring' }, 1_000)).toEqual({ ok: false, reason: 'unregistered' });
    expect(await devices.find(user, 'phone-aaaa-1')).toMatchObject({ last_failure_reason: 'unregistered' });
    expect((await devices.find(user, 'phone-aaaa-1'))!.revoked_at).not.toBeNull();
  });
});

// ─── 5. The runtime's "no socket means offline" paths ──────────────────────────

describe('the runtime with a session on away_ring (no station socket)', () => {
  function runtime(opts: { allowed?: boolean } = {}) {
    const rt = new AgencyRuntime({} as never, getTestRedis(), '');
    rt.awayRing.configure({ maxAgeMs: MAX_AGE });
    // The flags, as the account has them (the service reads the flag service otherwise).
    rt.awayRing.ringAllowed = async () => opts.allowed ?? true;
    return rt;
  }

  async function awayRingFor(rt: InstanceType<typeof AgencyRuntime>): Promise<{ id: string }> {
    await device();
    const s = await session({ state: 'available' });
    await rt.agents.set(s.id, 'available');
    const entered = await rt.agents.enterAwayRing(s.id, { ttlMs: MAX_AGE, fromStates: ['available'] });
    expect(entered.ok).toBe(true);
    await sessions.setState(s.id, 'break', 'away_ring');
    return s;
  }

  it('the station close keeps away_ring: nothing written, in Redis or the mirror', async () => {
    const rt = runtime();
    const s = await awayRingFor(rt);
    expect(await rt.releaseStationOnClose(s.id)).toBe(false);
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'break', ring: true });
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'away_ring' });
  });

  it('a close racing the ring CAS never knocks a held push offer offline', async () => {
    const rt = runtime();
    for (let i = 0; i < 20; i++) {
      await truncateAll();
      await flushTestRedis();
      await insertTenant({ id: DEFAULTS.tenantId });
      user = (await insertUser()).id as string;
      campaignId = (await insertAgencyCampaign()).id as string;
      const s = await awayRingFor(rt);
      // The connector's own answer comes too late to help: it learns it holds the offer only once
      // the CAS has answered, after this close read `holdsPushOffer` (false). The `push` field the
      // reservation writes in the same script is what the close's decision reads.
      let reserved = false;
      rt.inbound = {
        holdsPushOffer: () => reserved, onStationClosed: () => undefined, hasLiveCall: () => false,
        onAgentAvailable: () => undefined, findCallForSession: () => null,
      } as never;
      const ring = rt.agents.reserveForInbound(s.id, 'ib-1', ['break']).then((r) => { reserved = r.ok; return r; });
      const close = rt.releaseStationOnClose(s.id);
      expect(reserved).toBe(false);
      const [r, wentOffline] = await Promise.all([ring, close]);
      expect(r.ok).toBe(true);
      expect(wentOffline).toBe(false);
      expect(await rt.agents.get(s.id)).toMatchObject({ state: 'reserved', inboundCallId: 'ib-1' });
    }
  });

  it('the release of a session on away_ring with no socket keeps it; a plain break is written offline', async () => {
    const rt = runtime();
    const s = await awayRingFor(rt);
    expect(await rt.dialer.releaseAgent(s.id)).toEqual({ state: 'break', result: 'ok' });
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'break', ring: true });
    await rt.agents.set(s.id, 'break');
    expect(await rt.dialer.releaseAgent(s.id)).toEqual({ state: 'offline', result: 'ok' });
  });

  it("the agent's return (a rehydrate over break with ring) ends away_ring as device_away, row and frame", async () => {
    const rt = runtime();
    const s = await awayRingFor(rt);
    const rec = (await sessions.findById(s.id))!;
    const absence = rec.away_ring_since!;
    expect(await rt.rehydrateAgent(s.id, rec)).toBe('break');
    expect(rec.break_reason).toBe('device_away');
    // One absence: the return keeps its start as `since`, in Redis and the mirror.
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'break', ring: false, since: absence.getTime() });
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'device_away', away_ring_since: null, state_since: absence });
    // A lapsed key with the row still on away_ring comes back as device_away too, its start kept.
    await sessions.setState(s.id, 'break', 'away_ring');
    const absence2 = (await row(s.id)).away_ring_since as Date;
    await getTestRedis().del(key(s.id));
    const rec2 = (await sessions.findById(s.id))!;
    expect(await rt.rehydrateAgent(s.id, rec2)).toBe('break');
    expect(rec2.break_reason).toBe('device_away');
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'break', since: absence2.getTime() });
    expect(await row(s.id)).toMatchObject({ break_reason: 'device_away', away_ring_since: null, state_since: absence2 });
  });

  it('a queued away_ring applies at the release with no socket at all; refused meanwhile, it is device_away', async () => {
    const rt = runtime();
    await device();
    const s = await session({ state: 'wrapup' });
    await rt.agents.set(s.id, 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
    rt.breaks.queue(s.id, { ...AWAY_RING_BREAK });
    expect(await rt.dialer.releaseAgent(s.id)).toEqual({ state: 'break', result: 'ok' });
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'break', ring: true });
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'away_ring' });
    expect(rt.breaks.peek(s.id)).toBeNull();

    // The flags off by the release: device_away, and with no socket that is offline.
    rt.awayRing.ringAllowed = async () => false;
    await rt.agents.set(s.id, 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
    await sessions.setState(s.id, 'wrapup');
    rt.breaks.queue(s.id, { ...AWAY_RING_BREAK });
    expect(await rt.dialer.releaseAgent(s.id)).toEqual({ state: 'offline', result: 'ok' });
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'offline', ring: false });
  });

  it('a queued away_ring still applies after the app parked its socket in the wrap-up (offline), and with that lease lapsed (no key)', async () => {
    const rt = runtime();
    await device();
    const s = await session({ state: 'wrapup' });
    await rt.agents.set(s.id, 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
    rt.breaks.queue(s.id, { ...AWAY_RING_BREAK });
    // The app hid, asked for away_ring (queued: wrap-up), and parked its socket: the close writes offline.
    expect(await rt.releaseStationOnClose(s.id)).toBe(true);
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'offline' });
    // The wrap-up ends: the queued away_ring applies, with no socket.
    expect(await rt.dialer.releaseAgent(s.id)).toEqual({ state: 'break', result: 'ok' });
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'break', ring: true });
    expect(await getTestRedis().pttl(key(s.id))).toBeGreaterThan(AGENT_LEASE_MS.break);
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'away_ring' });

    // A long wrap-up: the close's offline lease lapsed before it ended.
    await sessions.setState(s.id, 'wrapup');
    await getTestRedis().del(key(s.id));
    rt.breaks.queue(s.id, { ...AWAY_RING_BREAK });
    expect(await rt.dialer.releaseAgent(s.id)).toEqual({ state: 'break', result: 'ok' });
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'break', ring: true });
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'away_ring' });
    expect((await row(s.id)).away_ring_since).not.toBeNull();
  });
});
