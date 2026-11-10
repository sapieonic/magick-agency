import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { closePool, initDbPool } from '@magick-agency/db';
import { MOBILE_STATION_HEARTBEAT_GRACE_MS, MOBILE_STATION_PROBE_MS, STATION_HEARTBEAT_SWEEP_MS, DEFERRED_HANGUP_MS } from '@magick-agency/domain/timers';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertAccount, insertMembership, insertTenant, insertUser } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { TEST_REDIS_URL, flushTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { createRng } from '../../helpers/load-scale.js';
import { MockVoicelinkCarrier, carrierScripts, type CarrierCall, type LeadRequest } from '../../mocks/voicelink/index.js';
import { startClusterServer, type ClusterServer } from '../../helpers/cluster-server.js';
import { FakeFirebaseEmulator, MobileAgent } from '../../helpers/cluster-mobile.js';
import { slotFor } from '../../../src/cluster/roles.js';
import { config } from '../../../src/config/index.js';
import { AgentStateMachine } from '../../../src/agency/agent-state-machine.js';

/*
 * The mobile app's station in multi-process mode (docs/mobile.md, docs/scaling.md §12): the
 * real server entry as a primary and two forked media workers, the mock VoiceLink carrier,
 * and agents that behave like the app — they join, mint station tokens, go available, pause
 * and hang up through the PUBLIC API (the primary forwards every session-owned handler to
 * the owning worker), and open `client=mobile&media=alaw8` stations that the primary hands
 * to the worker their session hashes to.
 *
 * What it pins, inside a worker, after the handoff:
 *  1. The liveness probe: the worker sends the RFC 6455 ping every 3 s on the adopted
 *     socket and sees the pongs, so a phone that answers pings and sends nothing else stays
 *     attached past its 10 s grace; a phone that stops answering is terminated (1006) 10–15 s
 *     after its last sign of life, and is then not dialable until it comes back.
 *  2. The `alaw8` relay for a mobile client: 160-byte binary frames both ways, through each
 *     worker.
 *  3. M1: a phone silent mid-call is terminated and the 8 s deferred hangup decides. One
 *     back in time re-attaches to the live call on the SAME worker process and its audio
 *     flows again; one that is not back loses the call.
 *  4. `device_away`: the break lands in the owning worker's state machine and on the
 *     agent's station; an available agent stops being reserved at once, and one on a call
 *     is queued behind it and lands on the break when the call ends.
 *
 * Timers are the product's own (no overrides exist): the file costs about a minute and a half.
 */

const PROJECT = 'magick-agency-cluster-test';
const NO_RETRY = Object.fromEntries(
  ['no_answer', 'busy', 'failed', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled'].map((o) => [o, { max_attempts: 0 }]),
);
/** The latest a silent phone may still be attached: the grace, a full sweep period, and scheduling slack. */
const DROP_BY_MS = MOBILE_STATION_HEARTBEAT_GRACE_MS + STATION_HEARTBEAT_SWEEP_MS + 1_500;

interface Rig {
  carrier: MockVoicelinkCarrier;
  emulator: FakeFirebaseEmulator;
  server: ClusterServer;
  redis: Redis;
  states: AgentStateMachine;
  tenantId: string;
  accountId: string;
  campaignId: string;
  plans: Map<string, carrierScripts.ScriptedOutcome>;
}

let rig: Rig;
let contactSeq = 0;
/** Every agent a test joins, so `afterEach` takes them out of the pool even when the test fails. */
const joined: MobileAgent[] = [];
const rng = createRng(7171);

async function startRig(): Promise<Rig> {
  await truncateAll();
  await flushTestRedis();
  const tenantId = (await insertTenant()).id as string;
  const accountId = (await insertAccount({ tenant_id: tenantId })).id as string;
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenantId],
  );
  await getTestPool().query(
    'INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, allow_recording) VALUES ($1, $2, $3, true)',
    [tenantId, accountId, 10_000],
  );
  const campaign = await insertAgencyCampaign({
    tenant_id: tenantId, account_id: accountId, status: 'running', wrapup_seconds: 0,
    disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY),
  });
  const campaignId = campaign.id as string;
  // Outstanding work for a day: holds the campaign `running` between the phases (a
  // campaign with nothing left completes) without ever being dialled here.
  await insertAgencyContact(campaignId, {
    tenant_id: tenantId, account_id: accountId, phone_e164: '+919699999999', source_row_number: 1,
    next_attempt_at: new Date(Date.now() + 86_400_000),
  });

  const plans = new Map<string, carrierScripts.ScriptedOutcome>();
  let origin = '';
  const carrier = new MockVoicelinkCarrier({ targetOrigin: () => origin });
  carrier.setScript((lead: LeadRequest) => plans.get(lead.customer_number)?.script ?? null);
  await carrier.start();
  const emulator = new FakeFirebaseEmulator(PROJECT);
  await emulator.start();
  const server = await startClusterServer({
    MEDIA_WORKERS: '2',
    FF_AGENCY_DIALER: 'true',
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_AUTH_EMULATOR_HOST: emulator.host,
    TELEPHONY_ENABLED_PROVIDERS: 'voicelink',
    VOICELINK_BASE_URL: carrier.baseUrl,
    VOICELINK_USERNAME: carrier.username,
    VOICELINK_PASSWORD: carrier.password,
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    RATE_LIMIT_STATION_MAX: '1000000',
    LOG_LEVEL: process.env['CLUSTER_TEST_LOG_LEVEL'] ?? 'warn',
  });
  origin = server.origin;
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  const states = new AgentStateMachine(redis, config.redis.keyPrefix);
  return { carrier, emulator, server, redis, states, tenantId, accountId, campaignId, plans };
}

/** A staffed agent on the mobile app (not joined yet). */
async function newAgent(): Promise<MobileAgent> {
  const user = await insertUser();
  await insertMembership({ user_id: user.id, tenant_id: rig.tenantId, account_id: rig.accountId, role: 'agent' });
  await getTestPool().query(
    'INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)',
    [rig.tenantId, rig.accountId, rig.campaignId, user.id],
  );
  const agent = new MobileAgent(rig.server.origin, rig.emulator, {
    userId: user.id as string, firebaseUid: user.firebase_uid as string, tenantId: rig.tenantId, accountId: rig.accountId,
  });
  joined.push(agent);
  return agent;
}

/** An agent joined, whose session hashes to `slot`, with its station open (`ready`). */
async function joinedOn(slot: number | null): Promise<MobileAgent> {
  for (let i = 0; i < 40; i++) {
    const agent = await newAgent();
    const url = await agent.join(rig.campaignId);
    if (slot === null || slotFor(agent.sessionId, 2) === slot) {
      await agent.connect(url);
      return agent;
    }
    await agent.api('POST', `/sessions/${agent.sessionId}/leave`, {});
  }
  throw new Error(`no session on slot ${slot}`);
}

/** A dialable contact the carrier answers with `frames` 20 ms frames; the media stops if the server closes the leg. */
async function addContact(frames: number): Promise<string> {
  const national = `96${String(10_000_000 + ++contactSeq).padStart(8, '0')}`;
  const outcome = carrierScripts.answered({ pattern: carrierScripts.framePattern(rng, frames) });
  for (const step of outcome.script.steps) if (step.do === 'media') step.stopIfClosed = true;
  rig.plans.set(national, outcome);
  const contact = await insertAgencyContact(rig.campaignId, {
    tenant_id: rig.tenantId, account_id: rig.accountId, phone_e164: `+91${national}`, source_row_number: contactSeq + 1,
  });
  return contact.id as string;
}

async function until(what: string, ms: number, check: () => Promise<boolean> | boolean, diag?: () => Promise<string> | string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}${diag ? ` (${await diag()})` : ''}\n${rig.server.output.slice(-20).join('\n')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AttemptRow { id: string; contact_id: string; reserved_agent_id: string; state: string; outcome: string | null; bridged_at: Date | null; webrtc_call_id: string | null }
async function attemptsFor(sessionId: string): Promise<AttemptRow[]> {
  return (await getTestPool().query<AttemptRow>(
    'SELECT id, contact_id, reserved_agent_id, state, outcome, bridged_at, webrtc_call_id FROM agency_call_attempts WHERE reserved_agent_id = $1 ORDER BY created_at',
    [sessionId])).rows;
}
async function attemptsForContact(contactId: string): Promise<AttemptRow[]> {
  return (await getTestPool().query<AttemptRow>(
    'SELECT id, contact_id, reserved_agent_id, state, outcome, bridged_at, webrtc_call_id FROM agency_call_attempts WHERE contact_id = $1', [contactId])).rows;
}
async function liveBridged(sessionId: string): Promise<AttemptRow | undefined> {
  return (await attemptsFor(sessionId)).find((a) => a.bridged_at !== null && a.state !== 'ended');
}
async function sessionRow(id: string): Promise<{ state: string; break_reason: string | null; client_kind: string }> {
  return (await getTestPool().query<{ state: string; break_reason: string | null; client_kind: string }>(
    'SELECT state, break_reason, client_kind FROM agency_agent_sessions WHERE id = $1', [id])).rows[0]!;
}
/** The replica holding the station (`<base>:mw<slot>:<pid>`), from its ownership key; null when none. */
async function stationOwner(sessionId: string): Promise<string | null> {
  const raw = await rig.redis.get(`${config.redis.keyPrefix}agency:station:${sessionId}`);
  return raw ? (JSON.parse(raw) as { replicaId: string }).replicaId : null;
}
/** The carrier's call for an attempt (the carrier keys calls by our call id, from the stream URL). */
function carrierCallFor(attempt: AttemptRow): CarrierCall {
  const call = attempt.webrtc_call_id ? rig.carrier.calls.get(attempt.webrtc_call_id) : undefined;
  if (!call) throw new Error(`no carrier call for attempt ${attempt.id}`);
  return call;
}

describe('mobile stations in multi-process mode: the real server as a primary and two workers', () => {
  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 });
    rig = await startRig();
  }, 120_000);
  // The tests share one campaign, and pacing hands a call to whoever has waited longest. A
  // test that fails before its own `leave()` would leave an available phone (and contacts
  // still due) that take the next test's calls, failing every test after it. So each test's
  // phones leave, and any contact still due is pushed a day out, whatever the outcome.
  // (`leave` is idempotent: a test that already left its phones costs nothing here.)
  afterEach(async () => {
    await Promise.all(joined.splice(0).map((a) => a.leave()));
    if (rig) {
      await getTestPool().query(
        `UPDATE agency_contacts SET next_attempt_at = now() + INTERVAL '1 day' WHERE campaign_id = $1 AND state = 'pending'`,
        [rig.campaignId],
      );
    }
  }, 60_000);
  afterAll(async () => {
    if (rig) {
      const stopped = rig.server.child.exitCode === null ? await rig.server.stop() : null;
      await rig.carrier.stop?.();
      await rig.emulator.stop();
      await rig.redis.quit().catch(() => {});
      if (stopped) expect(stopped.code).toBe(0);
    }
    await closePool();
    await closeTestPool();
  }, 120_000);

  it('the worker probes a handed-off phone: pongs alone keep it attached past the grace; a phone that stops answering is terminated and is not dialable until it is back', async () => {
    // Two phones that answer the protocol pings and send nothing else (no app ping, no
    // audio), one on each worker, both on the join's break; one available phone that will
    // stop answering.
    const steady = [await joinedOn(0), await joinedOn(1)];
    const dark = await joinedOn(null);
    for (const a of [...steady, dark]) {
      expect(await stationOwner(a.sessionId)).toMatch(new RegExp(`:mw${slotFor(a.sessionId, 2)}:`));
      expect((await sessionRow(a.sessionId)).client_kind).toBe('mobile');
    }
    await dark.available();
    // In the pool. Waited for, not read once: in `pool` mode every pacing tick reserves each
    // available agent before it finds no contact due and hands them back, so a single read
    // can land in that brief `reserved` (about 0.7% of reads here, more on a loaded box).
    await until('the dark phone available', 5_000, async () => (await rig.states.get(dark.sessionId))?.state === 'available');
    const attachedAt = Date.now();

    // The dark phone answers its first probe ping, then goes silent.
    await until('the dark phone answered a probe ping', MOBILE_STATION_PROBE_MS + 2_000, () => dark.leg.pingTimes.length > 0 && dark.leg.lastSignOfLife > 0);
    dark.leg.silence();
    const lastSign = dark.leg.lastSignOfLife;
    await until('the dark phone dropped', DROP_BY_MS + 2_000, () => dark.leg.closed !== null);
    const droppedAfter = dark.leg.closed!.at - lastSign;
    // `terminate`, not a close handshake: the app sees 1006, not 4408.
    expect(dark.leg.closed!.code).toBe(1006);
    expect(droppedAfter).toBeGreaterThanOrEqual(MOBILE_STATION_HEARTBEAT_GRACE_MS - 500);
    expect(droppedAfter).toBeLessThanOrEqual(DROP_BY_MS);
    // Out of the pool: offline in Redis and the row, its ownership released by the worker.
    await until('the dark phone offline', 5_000, async () => (await rig.states.get(dark.sessionId))?.state !== 'available'
      && (await sessionRow(dark.sessionId)).state === 'offline' && (await stationOwner(dark.sessionId)) === null);

    // The steady phones: still attached well past their grace, on pongs alone.
    const quietFor = MOBILE_STATION_HEARTBEAT_GRACE_MS + STATION_HEARTBEAT_SWEEP_MS + 3_000;
    await sleep(Math.max(0, attachedAt + quietFor - Date.now()));
    for (const a of steady) {
      expect(a.leg.open, `${a.sessionId} on slot ${slotFor(a.sessionId, 2)}`).toBe(true);
      const pings = a.leg.pingTimes;
      expect(pings.length).toBeGreaterThanOrEqual(Math.floor(quietFor / MOBILE_STATION_PROBE_MS) - 1);
      const gaps = pings.slice(1).map((t, i) => t - pings[i]!).sort((x, y) => x - y);
      const median = gaps[Math.floor(gaps.length / 2)]!;
      expect(median).toBeGreaterThan(MOBILE_STATION_PROBE_MS - 500);
      expect(median).toBeLessThan(MOBILE_STATION_PROBE_MS + 500);
      // From here on they keep their ownership keys as the app does.
      a.leg.startAppPings();
    }

    // Not dialable while gone: a contact waits, with no attempt, while the only available
    // agent is the dropped phone.
    const contact = await addContact(150);
    await sleep(4_000);
    expect(await attemptsForContact(contact)).toEqual([]);
    // Back (a new token from its worker, a new leg), available again: the contact is its.
    const back = await dark.reconnect();
    back.startAppPings();
    back.startTalking();
    await dark.available();
    await until('the returned phone bridged', 20_000, async () => (await attemptsForContact(contact)).some((a) => a.bridged_at !== null));
    expect((await attemptsForContact(contact))[0]!.reserved_agent_id).toBe(dark.sessionId);
    await until('the returned phone heard the customer', 10_000, () => back.heard > 50);
    await until('the call over', 20_000, async () => (await attemptsForContact(contact))[0]!.state === 'ended');
    back.stopTalking();
    await Promise.all([...steady, dark].map((a) => a.leave()));
  }, 120_000);

  it('media=alaw8 with client=mobile: 20 ms, 160-byte binary frames both ways through each worker', async () => {
    const phones = [await joinedOn(0), await joinedOn(1)];
    for (const p of phones) { p.leg.startAppPings(); p.leg.startTalking(); }
    await addContact(300);
    await addContact(300);
    for (const p of phones) await p.available();
    await until('both phones on a bridged call, hearing', 20_000, async () =>
      (await Promise.all(phones.map(async (p) => !!(await liveBridged(p.sessionId)) && p.leg.heard > 10))).every(Boolean));
    const attempts = await Promise.all(phones.map(async (p) => (await liveBridged(p.sessionId))!));
    const calls = attempts.map(carrierCallFor);
    // Each carrier stream was pointed at the worker that holds its agent's station.
    phones.forEach((p, i) => expect(calls[i]!.lead.websocket_url).toMatch(new RegExp(`&w=${slotFor(p.sessionId, 2)}$`)));

    // A 2 s window: 50 frames a second each way, give or take a loaded box.
    const heard0 = phones.map((p) => p.leg.heard);
    const rx0 = calls.map((c) => c.mediaReceived.length);
    const t0 = Date.now();
    await sleep(3_000);
    const secs = (Date.now() - t0) / 1000;
    phones.forEach((p, i) => {
      const toAgent = (p.leg.heard - heard0[i]!) / secs;
      const toCarrier = (calls[i]!.mediaReceived.length - rx0[i]!) / secs;
      // About 50 frames a second each way; the band is wide because a loaded CI box
      // delays the paced senders, and what is asserted is audio flowing at about real time.
      expect(toAgent, `slot ${slotFor(p.sessionId, 2)} frames/s to the phone`).toBeGreaterThan(25);
      expect(toAgent).toBeLessThan(75);
      expect(toCarrier, `slot ${slotFor(p.sessionId, 2)} frames/s to the carrier`).toBeGreaterThan(25);
      expect(toCarrier).toBeLessThan(75);
    });
    await until('both calls over', 20_000, async () => (await Promise.all(attempts.map(async (a) => (await attemptsForContact(a.contact_id))[0]!.state === 'ended'))).every(Boolean));
    for (const p of phones) {
      p.leg.stopTalking();
      expect(p.leg.heardOddSize).toBe(0);
      expect(p.leg.heard).toBeGreaterThan(100);
    }
    for (const c of calls) {
      expect(c.mediaReceived.length).toBeGreaterThan(100);
      expect(c.mediaReceived.every((b) => b.length === 160)).toBe(true);
    }
    for (const a of attempts) expect((await attemptsForContact(a.contact_id))[0]!.outcome).toBe('connected');
    await Promise.all(phones.map((p) => p.leave()));
  }, 120_000);

  it('M1 inside a worker: a phone silent mid-call is terminated; back within 8 s it resumes the call on the same worker, otherwise the call ends', async () => {
    const back = await joinedOn(0);
    const gone = await joinedOn(1);
    for (const p of [back, gone]) { p.leg.startAppPings(); p.leg.startTalking(); }
    await addContact(3_000);
    await addContact(3_000);
    await back.available();
    await gone.available();
    await until('both phones on a bridged call, hearing', 20_000, async () =>
      (await Promise.all([back, gone].map(async (p) => !!(await liveBridged(p.sessionId)) && p.leg.heard > 25))).every(Boolean));
    const backAttempt = (await liveBridged(back.sessionId))!;
    const goneAttempt = (await liveBridged(gone.sessionId))!;
    const ownerBefore = await stationOwner(back.sessionId);
    expect(ownerBefore).toMatch(/:mw0:/);

    // Both go dark at once (each on its own worker), with the TCP connections still up.
    const legs = [back.leg, gone.leg];
    for (const l of legs) l.silence();
    // The one coming back reconnects the moment it sees the drop, as the app does.
    let backLeg: Awaited<ReturnType<MobileAgent['reconnect']>> | null = null;
    const returning = (async () => {
      await until('the returning phone dropped', DROP_BY_MS + 2_000, () => legs[0]!.closed !== null);
      backLeg = await back.reconnect();
      backLeg.startAppPings();
      backLeg.startTalking();
    })();
    await until('both phones dropped', DROP_BY_MS + 2_000, () => legs.every((l) => l.closed !== null));
    for (const l of legs) {
      expect(l.closed!.code).toBe(1006);
      expect(l.closed!.at - l.lastSignOfLife).toBeGreaterThanOrEqual(MOBILE_STATION_HEARTBEAT_GRACE_MS - 500);
      expect(l.closed!.at - l.lastSignOfLife).toBeLessThanOrEqual(DROP_BY_MS);
    }
    await returning;
    const resumed = backLeg!;
    expect(Date.now() - legs[0]!.closed!.at).toBeLessThan(DEFERRED_HANGUP_MS);
    // Re-attached to the live call: `ready` names it, on the very worker process that held it.
    expect((resumed.ready!['active_attempt'] as { attempt_id?: string } | undefined)?.attempt_id).toBe(backAttempt.id);
    expect(await stationOwner(back.sessionId)).toBe(ownerBefore);

    // Past the deferred-hangup deadline the resumed call is still the same live call, and
    // its audio flows both ways again.
    const backCall = carrierCallFor(backAttempt);
    const heardAtResume = resumed.heard;
    const rxAtResume = backCall.mediaReceived.length;
    await sleep(Math.max(0, legs[0]!.closed!.at + DEFERRED_HANGUP_MS + 1_500 - Date.now()));
    const backNow = (await attemptsForContact(backAttempt.contact_id))[0]!;
    expect(backNow.id).toBe(backAttempt.id);
    expect(backNow.state).not.toBe('ended');
    expect(resumed.heard - heardAtResume).toBeGreaterThan(100);
    expect(backCall.mediaReceived.length - rxAtResume).toBeGreaterThan(100);
    expect(resumed.heardOddSize).toBe(0);

    // The one that did not come back lost its call to the deferred hangup: the server
    // closed the carrier's leg, the attempt is over, the agent is offline.
    await until('the abandoned call ended', 6_000, async () => (await attemptsForContact(goneAttempt.contact_id))[0]!.state === 'ended');
    const goneEnded = (await attemptsForContact(goneAttempt.contact_id))[0]!;
    expect(goneEnded.outcome).toBe('agent_disconnected');
    expect(carrierCallFor(goneAttempt).closes.some((c) => c.by === 'server')).toBe(true);
    expect((await sessionRow(gone.sessionId)).state).toBe('offline');

    // And the resumed call ends when the agent hangs up (forwarded to the owning worker).
    const hung = await back.hangup(backAttempt.id);
    expect(hung.status).toBe(200);
    await until('the resumed call ended', 10_000, async () => (await attemptsForContact(backAttempt.contact_id))[0]!.state === 'ended');
    expect((await attemptsForContact(backAttempt.contact_id))[0]!.outcome).toBe('connected');
    resumed.stopTalking();
    await Promise.all([back, gone].map((p) => p.leave()));
  }, 120_000);

  it("device_away reaches the owning worker: an available phone is paused at once and not reserved; one on a call is paused when the call ends", async () => {
    const idle = await joinedOn(0);
    const busy = await joinedOn(1);
    for (const p of [idle, busy]) p.leg.startAppPings();
    await idle.available();

    // Available → break, now: the answer, Redis, the row, and the frame on the phone's own
    // station, which only the worker holding it can send.
    const away = await idle.deviceAway();
    expect(away.status).toBe(200);
    expect(away.body).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect((await rig.states.get(idle.sessionId))?.state).toBe('break');
    expect(await sessionRow(idle.sessionId)).toMatchObject({ state: 'break', break_reason: 'device_away' });
    await until('the break frame on the idle phone', 5_000, () =>
      idle.leg.ofEvent('agent_state').some((f) => f['state'] === 'break' && f['break_reason'] === 'device_away'));

    // Pacing reserves the other agent, never the paused one.
    busy.leg.startTalking();
    const contact = await addContact(3_000);
    await busy.available();
    await until('the busy phone on a bridged call', 20_000, async () => !!(await liveBridged(busy.sessionId)) && busy.leg.heard > 10);
    expect((await attemptsForContact(contact))[0]!.reserved_agent_id).toBe(busy.sessionId);
    expect(await attemptsFor(idle.sessionId)).toEqual([]);

    // Backgrounded mid-call: queued behind the call, announced on the station.
    const queued = await busy.deviceAway();
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({ state: 'on_call', pending_state: 'break', break_reason: 'device_away' });
    await until('the pending frame on the busy phone', 5_000, () =>
      busy.leg.ofEvent('agent_state').some((f) => f['pending_state'] === 'break' && f['pending_break_reason'] === 'device_away'));
    const attempt = (await liveBridged(busy.sessionId))!;
    expect((await busy.hangup(attempt.id)).status).toBe(200);
    // The call's release applies the queued break in the worker: break, not available.
    await until('the busy phone on its device_away break', 10_000, async () =>
      (await rig.states.get(busy.sessionId))?.state === 'break'
      && (await sessionRow(busy.sessionId)).break_reason === 'device_away',
    async () => `redis ${JSON.stringify(await rig.states.get(busy.sessionId))}, row ${JSON.stringify(await sessionRow(busy.sessionId))}`);
    expect(busy.leg.ofEvent('agent_state').some((f) => f['state'] === 'break' && f['break_reason'] === 'device_away')).toBe(true);
    busy.leg.stopTalking();

    // Neither paused phone is reserved for new work.
    const next = await addContact(150);
    await sleep(4_000);
    expect(await attemptsForContact(next)).toEqual([]);
    await Promise.all([idle, busy].map((p) => p.leave()));
  }, 120_000);
});
