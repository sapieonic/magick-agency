import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * ─── THE MANUAL DIALER'S CLOSE PATHS, ON REAL ROWS ────────────────────────────
 *
 * docs/softphone.md §4.1 steps 4, 6, 8 and 10, and §5. `ManualDialer` driven
 * directly against real Postgres, with the bridge, the station registry and the
 * agent state machine stubbed (the end-to-end suite has the real ones): every way a
 * soft-phone call closes WITHOUT an outcome saved, and what it does to the roster
 * contact it claimed —
 *
 *  - a dial the carrier never saw (the bridge refused it, the carrier refused it) is
 *    no dial at all: `dialed_at` cleared, the claim given back uncharged;
 *  - a placed call that never bridged is charged and the tag's retry policy decides
 *    when pacing may call the customer again (`no_answer` waits its delay; a ring the
 *    agent hung up is OUR fault, on the our-fault ledger);
 *  - a bridged call whose outcome lapsed is charged and settled by the policy too
 *    (`connected` → `completed` under the defaults);
 *  - the call stays in the dialer's live set until its `ended` row is written, so the
 *    orphan sweep cannot end it `orphaned` mid-teardown;
 *  - a settle that fails is retried, and the lapse sweep closes an unbridged call
 *    within a minute or so rather than after 30;
 *  - a dial whose outcome is unknown (`add_lead` timed out: the carrier may still ring
 *    the customer) is no refusal: `dialed_at` kept, the contact held 15 minutes on the
 *    our-fault ledger, whichever of the dial and a racing hang-up ends it first.
 */
const { closeTestPool, getTestPool, truncateAll } = await import('../setup/test-utils.js');
vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/db/connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db/connection')>()),
  getPool: () => getTestPool(),
}));

const { insertAgencyCampaign, insertAgencyContact, insertSoftphoneSession, insertManualCall } = await import('./agency-factories.js');
const { ManualDialer } = await import('../../../src/agency/softphone/manual-dialer.js');
const { AgencyReaper } = await import('../../../src/agency/reaper.js');
const { WebRtcCallError } = await import('../../../src/core/webrtc-bridge-manager.js');
const { agencyManualCallRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { AUTO_DISPOSITION_CODE } = await import('../../../src/agency/disposition.js');
const { CarrierRequestTimeoutError, DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS } = await import('../../../src/telephony/carrier-errors.js');

/** What the bridge throws for an `add_lead` that timed out: the adapter's error as `cause`. */
function outcomeUnknownRefusal(): Error {
  const refusal = new WebRtcCallError('VoiceLink /v1/add_lead timed out after 15000 ms', 'telephony_init_failed', 502);
  refusal.cause = new CarrierRequestTimeoutError('VoiceLink /v1/add_lead', 15_000, true);
  return refusal;
}

type Listener = (ev: Record<string, unknown>) => void;

/** The bridge, as far as the dialer sees it: a lifecycle stream and a dial that resolves or throws. */
class FakeBridge {
  private listeners: Listener[] = [];
  readonly createBridgedCall = vi.fn(async (_params: Record<string, unknown>) => ({ id: randomUUID() }));
  readonly forceEndWithOutcome = vi.fn(async () => true);
  readonly reattachBorrowedBrowserLeg = vi.fn(() => false);
  onLifecycle(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }
  emit(ev: Record<string, unknown>): void {
    for (const l of this.listeners) l(ev);
  }
}

const MIN = 60_000;
const near = (actual: Date | null, expected: number, slackMs = 15_000) => {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual!.getTime() - expected)).toBeLessThan(slackMs);
};

let bridge: FakeBridge;
let agents: { releaseManual: ReturnType<typeof vi.fn> };
let stations: { send: ReturnType<typeof vi.fn> };
let dialer: InstanceType<typeof ManualDialer>;
let reaper: InstanceType<typeof AgencyReaper>;

function boot() {
  bridge = new FakeBridge();
  agents = { releaseManual: vi.fn(async () => undefined) };
  stations = { send: vi.fn(() => true) };
  dialer = new ManualDialer(bridge as never, stations as never, agents as never);
  dialer.start();
  reaper = new AgencyReaper({
    activeAttemptIds: () => [],
    ownerOf: async () => null,
    manual: { activeIds: () => dialer.activeManualCallIds(), onClosed: (rows) => dialer.onCallsClosedBySweep(rows) },
  });
}

/** A tagged, committed `queued` call that claimed a `pending` roster contact. */
async function claimedCall(o: {
  retryPolicy?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  call?: Record<string, unknown>;
} = {}) {
  const campaign = await insertAgencyCampaign({ retry_policy: JSON.stringify(o.retryPolicy ?? {}) });
  const contact = await insertAgencyContact(campaign.id as string, { state: 'in_flight', ...o.contact });
  const session = await insertSoftphoneSession();
  const call = await insertManualCall(session, {
    campaign_id: campaign.id, contact_id: contact.id, contact_claimed: true, contact_prior_state: 'pending',
    ...o.call,
  });
  return { campaign, contact, session, call };
}

const callRow = async (id: string) => (await getTestPool().query('SELECT * FROM agency_manual_calls WHERE id = $1', [id])).rows[0];
const contactRow = async (id: string) => (await getTestPool().query('SELECT * FROM agency_contacts WHERE id = $1', [id])).rows[0];

/** Dial `call` and return its media leg id. */
async function dialed(call: Awaited<ReturnType<typeof claimedCall>>['call']): Promise<string> {
  const result = await dialer.dial(call as never, { socket: {} as never });
  expect(result).toEqual({ ok: true });
  const leg = (await callRow(call.id as string)).webrtc_call_id as string;
  expect(leg).toBeTruthy();
  return leg;
}

function end(callId: string, leg: string, ev: Record<string, unknown>): Promise<void> {
  bridge.emit({ callId: leg, correlationId: callId, phase: 'ended', answered: false, ...ev });
  return dialer.settled(callId);
}

describe('ManualDialer — closing a call with no outcome (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    boot();
  });
  afterEach(() => {
    dialer.stop();
    vi.restoreAllMocks();
  });
  afterAll(closeTestPool);

  // ── never placed ──────────────────────────────────────────────────────────

  it('a dial the bridge refused is no dial: dialed_at cleared, claim back to pending uncharged', async () => {
    const { contact, call } = await claimedCall({ contact: { attempt_count: 1 } });
    bridge.createBridgedCall.mockRejectedValueOnce(new WebRtcCallError('full', 'account_concurrency_limit', 429));
    expect(await dialer.dial(call as never, { socket: {} as never })).toEqual({ ok: false, failure: 'concurrency_limit' });
    expect(dialer.hasLiveCall(call.session_id as string)).toBe(false);

    const row = await callRow(call.id as string);
    expect(row).toMatchObject({ state: 'ended', outcome: 'failed', dialed_at: null });
    expect(row.settled_at).not.toBeNull();
    expect(await contactRow(contact.id as string)).toMatchObject({ state: 'pending', attempt_count: 1, our_fault_attempts: 0 });
    expect(agents.releaseManual).toHaveBeenCalledWith(row.session_id, row.id);
  });

  /**
   * The bridge's real order for a dial that fails before the carrier is asked (the row
   * INSERT, the carrier tokens, the carrier request's own inputs: a missing webhook base, a
   * provider with no adapter): it tears the leg down with NO `ended` and rejects with the
   * original error (`abortUnplacedLeg`). Nothing was dialled, so the agent gets the reviewed
   * `dial_failed` (503, retry), not a masked 500, and the claim is given back uncharged.
   */
  it('a dial that fails in the bridge before the carrier is no dial and answers dial_failed', async () => {
    const { contact, call } = await claimedCall({ contact: { attempt_count: 1 } });
    bridge.createBridgedCall.mockRejectedValueOnce(new TypeError('Invalid URL'));
    expect(await dialer.dial(call as never, { socket: {} as never })).toEqual({ ok: false, failure: 'dial_failed' });
    expect(dialer.hasLiveCall(call.session_id as string)).toBe(false);

    const row = await callRow(call.id as string);
    expect(row).toMatchObject({ state: 'ended', outcome: 'failed', dialed_at: null });
    expect(row.settled_at).not.toBeNull();
    expect(await contactRow(contact.id as string)).toMatchObject({ state: 'pending', attempt_count: 1, our_fault_attempts: 0 });
    expect(agents.releaseManual).toHaveBeenCalledWith(row.session_id, row.id);
  });

  it('a dial the carrier refused outright is no dial either (telephony_init_failed)', async () => {
    const { contact, call } = await claimedCall();
    bridge.createBridgedCall.mockImplementationOnce(async () => {
      // As the bridge does: the leg's `ended` is emitted before the dial throws.
      bridge.emit({ callId: randomUUID(), correlationId: call.id, phase: 'ended', status: 'failed', outcome: 'telephony_init_failed', answered: false });
      throw new WebRtcCallError('carrier said no', 'telephony_init_failed', 502);
    });
    expect(await dialer.dial(call as never, { socket: {} as never })).toEqual({ ok: true });

    const row = await callRow(call.id as string);
    expect(row).toMatchObject({ state: 'ended', outcome: 'failed', dialed_at: null });
    expect(row.settled_at).not.toBeNull();
    expect(await contactRow(contact.id as string)).toMatchObject({ state: 'pending', attempt_count: 0 });
  });

  // ── outcome unknown: the carrier may still ring the customer ─────────────

  it('a dial whose outcome is unknown is held, not given back: dialed_at kept, 15 min on the our-fault ledger', async () => {
    // The tag's `failed` policy would redial at once and charge the customer: it must not decide.
    const { contact, call } = await claimedCall({
      retryPolicy: { failed: { delay_minutes: 0, max_attempts: 9 } }, contact: { attempt_count: 1 },
    });
    bridge.createBridgedCall.mockImplementationOnce(async () => {
      // As the bridge does: the leg's `ended` (its outcome-unknown code) is emitted before the dial throws.
      bridge.emit({
        callId: randomUUID(), correlationId: call.id, phase: 'ended', status: 'failed',
        outcome: 'telephony_init_failed', errorCode: 'TELEPHONY_INIT_OUTCOME_UNKNOWN', answered: false,
      });
      throw outcomeUnknownRefusal();
    });
    const before = Date.now();
    // The agent's answer: the call, ended and settled ("didn't go through").
    expect(await dialer.dial(call as never, { socket: {} as never })).toEqual({ ok: true });

    const row = await callRow(call.id as string);
    expect(row).toMatchObject({ state: 'ended', outcome: 'failed', end_reason: 'failed' });
    expect(row.dialed_at, 'an outcome-unknown dial was recorded as never placed').not.toBeNull();
    expect(row.settled_at).not.toBeNull();
    const c = await contactRow(contact.id as string);
    expect(c).toMatchObject({ state: 'pending', attempt_count: 1, our_fault_attempts: 1, last_outcome: 'failed' });
    expect(c.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    expect(agents.releaseManual).toHaveBeenCalledWith(row.session_id, row.id);
  });

  it('at the our-fault bound an outcome-unknown dial retires the contact', async () => {
    const { contact, call } = await claimedCall({ contact: { our_fault_attempts: 2 } });
    bridge.createBridgedCall.mockImplementationOnce(async () => {
      bridge.emit({
        callId: randomUUID(), correlationId: call.id, phase: 'ended', status: 'failed',
        outcome: 'telephony_init_failed', errorCode: 'TELEPHONY_INIT_OUTCOME_UNKNOWN', answered: false,
      });
      throw outcomeUnknownRefusal();
    });
    expect(await dialer.dial(call as never, { socket: {} as never })).toEqual({ ok: true });
    expect(await contactRow(contact.id as string)).toMatchObject({ state: 'exhausted', attempt_count: 0, our_fault_attempts: 3 });
  });

  /**
   * The agent hangs up while `add_lead` is still in flight, and it then times out. The
   * bridge's order: the hang-up's teardown emits `ended` (`agent_hangup`); the dial rejects
   * later, its own end a no-op on the ended call. The hang-up used to settle the contact at
   * once on the our-fault policy (5 min by default, 1 here).
   */
  it('the agent hangs up during an add_lead that then times out: the contact is held, the agent told at once', async () => {
    const { contact, call } = await claimedCall({ retryPolicy: { canceled: { delay_minutes: 1, max_attempts: 3 } } });
    let timeOut!: () => void;
    const timedOut = new Promise<void>((resolve) => { timeOut = resolve; });
    bridge.createBridgedCall.mockImplementationOnce(async () => { await timedOut; throw outcomeUnknownRefusal(); });
    const dialing = dialer.dial(call as never, { socket: {} as never });
    await vi.waitFor(() => expect(bridge.createBridgedCall).toHaveBeenCalled());

    expect(await dialer.hangup(call.id as string, 'agent')).toBe(true);
    bridge.emit({ callId: randomUUID(), correlationId: call.id, phase: 'ended', status: 'canceled', outcome: 'agent_hangup', answered: false });
    // The agent sees the call end while the dial is still out; the contact waits for it.
    await vi.waitFor(() => expect(stations.send.mock.calls.some(([, frame]: any[]) =>
      frame.event === 'manual_call' && frame.call.state === 'ended')).toBe(true));
    expect((await contactRow(contact.id as string)).state).toBe('in_flight');

    const before = Date.now();
    timeOut();
    expect(await dialing).toEqual({ ok: true });
    await dialer.settled(call.id as string);

    const row = await callRow(call.id as string);
    expect(row).toMatchObject({ state: 'ended', outcome: 'canceled', end_reason: 'agent_hangup' });
    expect(row.settled_at).not.toBeNull();
    const c = await contactRow(contact.id as string);
    expect(c).toMatchObject({ state: 'pending', attempt_count: 0, our_fault_attempts: 1 });
    expect(c.next_attempt_at.getTime(), 'a raced hang-up lost the outcome-unknown hold')
      .toBeGreaterThanOrEqual(before + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    expect(agents.releaseManual).toHaveBeenCalledTimes(1);
  });

  it('the other order: the dial times out before the hang-up ended arrives, held all the same', async () => {
    const { contact, call } = await claimedCall({ retryPolicy: { canceled: { delay_minutes: 1, max_attempts: 3 } } });
    bridge.createBridgedCall.mockImplementationOnce(async () => { throw outcomeUnknownRefusal(); });
    const before = Date.now();
    expect(await dialer.dial(call as never, { socket: {} as never })).toEqual({ ok: true });
    bridge.emit({ callId: randomUUID(), correlationId: call.id, phase: 'ended', status: 'canceled', outcome: 'agent_hangup', answered: false });
    await dialer.settled(call.id as string);

    const c = await contactRow(contact.id as string);
    expect(c).toMatchObject({ state: 'pending', attempt_count: 0, our_fault_attempts: 1 });
    expect(c.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
  });

  /**
   * The dialer's settle never lands; the lapse sweep has only the rows. It asks the media
   * leg (`agency_calls`, by `manual_call_id`) how the bridge ended it.
   */
  it('a lapsed outcome-unknown call keeps the hold: the sweep reads how the media leg ended', async () => {
    const longAgo = new Date(Date.now() - 2 * MIN);
    const ended = { state: 'ended', outcome: 'failed', end_reason: 'failed', dialed_at: longAgo, ended_at: longAgo };
    const unknown = await claimedCall({ retryPolicy: { failed: { delay_minutes: 0, max_attempts: 9 } }, call: ended });
    const plain = await claimedCall({ retryPolicy: { failed: { delay_minutes: 0, max_attempts: 9 } }, call: ended });
    const legs = [[unknown.call, 'TELEPHONY_INIT_OUTCOME_UNKNOWN'], [plain.call, 'TELEPHONY_INIT_FAILED']] as const;
    for (const [c, code] of legs) {
      await getTestPool().query(
        `INSERT INTO agency_calls (tenant_id, account_id, caller_id, destination_phone, status, origin, manual_call_id, error_code)
         VALUES ($1, $2, '+919000000001', '+919812345678', 'failed', 'manual', $3, $4)`,
        [c.tenant_id, c.account_id, c.id, code],
      );
    }
    const before = Date.now();
    expect((await reaper.sweepManualCalls()).lapsed).toBe(2);

    const u = await contactRow(unknown.contact.id as string);
    expect(u).toMatchObject({ state: 'pending', attempt_count: 0, our_fault_attempts: 1 });
    expect(u.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    // A placed call that failed for a known reason: the customer's allowance and the policy.
    const p = await contactRow(plain.contact.id as string);
    expect(p).toMatchObject({ state: 'pending', attempt_count: 1, our_fault_attempts: 0 });
    near(p.next_attempt_at, Date.now());
  });

  // ── placed, never bridged ─────────────────────────────────────────────────

  it('an unanswered call is charged and waits the policy\'s delay before pacing may redial', async () => {
    const { contact, call } = await claimedCall({ retryPolicy: { no_answer: { delay_minutes: 45, max_attempts: 3 } } });
    const leg = await dialed(call);
    await end(call.id as string, leg, { status: 'no_answer' });

    const row = await callRow(call.id as string);
    expect(row).toMatchObject({ outcome: 'no_answer', end_reason: 'no_answer' });
    expect(row.dialed_at).not.toBeNull();
    expect(row.settled_at).not.toBeNull();
    const c = await contactRow(contact.id as string);
    expect(c).toMatchObject({ state: 'pending', attempt_count: 1, last_outcome: 'no_answer' });
    near(c.next_attempt_at, Date.now() + 45 * MIN);
  });

  it('an unanswered call that spends the last attempt exhausts the contact', async () => {
    const { contact, call } = await claimedCall({
      retryPolicy: { busy: { delay_minutes: 15, max_attempts: 2 } }, contact: { attempt_count: 1 },
    });
    const leg = await dialed(call);
    await end(call.id as string, leg, { status: 'busy' });
    expect(await contactRow(contact.id as string)).toMatchObject({ state: 'exhausted', attempt_count: 2 });
  });

  it('a ring the agent hung up is our fault: the our-fault ledger, the customer\'s allowance untouched', async () => {
    const { contact, call } = await claimedCall({ contact: { attempt_count: 1 } });
    const leg = await dialed(call);
    await dialer.hangup(call.id as string, 'agent');
    await end(call.id as string, leg, { status: 'canceled', outcome: 'agent_hangup' });

    expect(await callRow(call.id as string)).toMatchObject({ outcome: 'canceled', end_reason: 'agent_hangup' });
    const c = await contactRow(contact.id as string);
    expect(c).toMatchObject({ state: 'pending', attempt_count: 1, our_fault_attempts: 1 });
    near(c.next_attempt_at, Date.now() + 5 * MIN); // AGENCY_DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES
  });

  // ── the live set ──────────────────────────────────────────────────────────

  it('a call stays live until its end is written: the orphan sweep cannot reap it mid-teardown', async () => {
    // Old enough for the periodic sweep to consider it; only "this process is driving
    // it" may spare it.
    const { call } = await claimedCall({ call: { created_at: new Date(Date.now() - 3_600_000) } });
    const leg = await dialed(call);
    bridge.emit({ callId: leg, correlationId: call.id, phase: 'answered', answered: true });
    bridge.emit({ callId: leg, correlationId: call.id, phase: 'bridged', answered: true });
    await dialer.settled(call.id as string);

    // Hold the `ended` handler at its first read.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atRead = new Promise<void>((r) => { reached = r; });
    const realFind = agencyManualCallRepository.findById.bind(agencyManualCallRepository);
    vi.spyOn(agencyManualCallRepository, 'findById').mockImplementationOnce(async (...args) => {
      reached();
      await gate;
      return realFind(...args);
    });
    bridge.emit({ callId: leg, correlationId: call.id, phase: 'ended', status: 'completed', answered: true, talkTimeSeconds: 612 });
    await atRead;

    expect(dialer.activeManualCallIds()).toContain(call.id);
    expect(dialer.hasLiveCall(call.session_id as string)).toBe(true);
    const swept = await reaper.sweepManualCalls();
    expect(swept.orphaned).toBe(0);

    release();
    await dialer.settled(call.id as string);
    const row = await callRow(call.id as string);
    expect(row).toMatchObject({ state: 'ended', outcome: 'connected', end_reason: 'remote_hangup', talk_seconds: 612 });
    expect(row.settled_at).toBeNull(); // bridged: the outcome is owed
    expect(dialer.activeManualCallIds()).not.toContain(call.id);
    // The per-session read agrees: the station sweep and `leave` no longer see a live call.
    expect(dialer.hasLiveCall(call.session_id as string)).toBe(false);
  });

  // ── a settle that fails ───────────────────────────────────────────────────

  it('a settle that fails once is retried and lands', async () => {
    const { contact, call } = await claimedCall();
    const leg = await dialed(call);
    const real = agencyManualCallRepository.settleWithoutDisposition.bind(agencyManualCallRepository);
    vi.spyOn(agencyManualCallRepository, 'settleWithoutDisposition')
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'))
      .mockImplementation((...args) => real(...args));
    await end(call.id as string, leg, { status: 'no_answer' });

    expect((await callRow(call.id as string)).settled_at).not.toBeNull();
    expect((await contactRow(contact.id as string)).attempt_count).toBe(1);
    expect(agents.releaseManual).toHaveBeenCalledTimes(1);
  });

  it('a settle that keeps failing is closed by the lapse sweep within its short grace, not after 30 minutes', async () => {
    const { contact, call } = await claimedCall({ retryPolicy: { no_answer: { delay_minutes: 45, max_attempts: 3 } } });
    const leg = await dialed(call);
    vi.spyOn(agencyManualCallRepository, 'settleWithoutDisposition').mockRejectedValue(new Error('database is down'));
    await end(call.id as string, leg, { status: 'no_answer' });
    vi.mocked(agencyManualCallRepository.settleWithoutDisposition).mockRestore();

    const stuck = await callRow(call.id as string);
    expect(stuck.state).toBe('ended');
    expect(stuck.settled_at).toBeNull();
    expect(agents.releaseManual).not.toHaveBeenCalled();

    // Inside the grace the sweep leaves it to the dialer.
    expect((await reaper.sweepManualCalls()).lapsed).toBe(0);
    await getTestPool().query("UPDATE agency_manual_calls SET ended_at = now() - interval '1 minute' WHERE id = $1", [call.id]);
    expect((await reaper.sweepManualCalls()).lapsed).toBe(1);

    const row = await callRow(call.id as string);
    expect(row.settled_at).not.toBeNull();
    expect(row.disposition_code).toBeNull(); // it never bridged: nothing was owed
    const c = await contactRow(contact.id as string);
    expect(c).toMatchObject({ state: 'pending', attempt_count: 1 });
    near(c.next_attempt_at, Date.now() + 45 * MIN);
    expect(agents.releaseManual).toHaveBeenCalledWith(row.session_id, row.id);
  });

  // ── the reaper's rows ─────────────────────────────────────────────────────

  it('a lapsed bridged call is charged and settled by the policy: connected → completed under the defaults', async () => {
    const longAgo = new Date(Date.now() - 31 * MIN);
    const ended = { state: 'ended', outcome: 'connected', end_reason: 'remote_hangup',
      dialed_at: longAgo, answered_at: longAgo, bridged_at: longAgo, ended_at: longAgo };
    const byDefault = await claimedCall({ contact: { attempt_count: 1 }, call: ended });
    const retried = await claimedCall({ retryPolicy: { connected: { delay_minutes: 30, max_attempts: 3 } }, call: ended });

    expect((await reaper.sweepManualCalls()).lapsed).toBe(2);

    expect(await callRow(byDefault.call.id as string)).toMatchObject({ disposition_code: AUTO_DISPOSITION_CODE });
    expect(await contactRow(byDefault.contact.id as string)).toMatchObject({
      state: 'completed', attempt_count: 2, last_outcome: 'connected', last_disposition: AUTO_DISPOSITION_CODE,
    });
    const c = await contactRow(retried.contact.id as string);
    expect(c).toMatchObject({ state: 'pending', attempt_count: 1 });
    near(c.next_attempt_at, Date.now() + 30 * MIN);
  });

  /**
   * A restart mid-dial (`add_lead` in flight, or the customer's phone ringing) leaves the
   * carrier free to place that call, as for a campaign attempt the startup reap ends
   * (`reapedRedialNotBefore`): the contact is requeued on the our-fault ledger but not
   * dialable until 15 min after `dialed_at`. It used to be back on the roster at once, and
   * pacing could ring the customer a second time while the soft phone's dial still rang.
   * An answered call (its carrier leg over with its media) and an unplaced one are not held.
   */
  it('the startup sweep: an unbridged placed orphan is our fault and held 15 min after its dial; an unplaced one is just released', async () => {
    const dialedAt = new Date(Date.now() - 2 * MIN);
    const placed = await claimedCall({ call: { state: 'dialing', dialed_at: dialedAt } });
    const answered = await claimedCall({ call: { state: 'answered', dialed_at: dialedAt, answered_at: new Date() } });
    const unplaced = await claimedCall({ call: { state: 'queued' } });
    await reaper.reapOnStartup();

    const p = await contactRow(placed.contact.id as string);
    expect(p).toMatchObject({ state: 'pending', attempt_count: 0, our_fault_attempts: 1, last_outcome: 'orphaned' });
    expect(p.next_attempt_at.getTime(), 'dialable while the carrier may still place the orphaned dial')
      .toBe(dialedAt.getTime() + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    const a = await contactRow(answered.contact.id as string);
    expect(a).toMatchObject({ state: 'pending', attempt_count: 0, our_fault_attempts: 1 });
    near(a.next_attempt_at, Date.now());
    expect(await contactRow(unplaced.contact.id as string)).toMatchObject({ state: 'pending', attempt_count: 0, our_fault_attempts: 0 });
  });

  it('the periodic orphan sweep holds an unbridged placed orphan the same way', async () => {
    const longAgo = new Date(Date.now() - 6 * MIN);
    const placed = await claimedCall({ call: { state: 'ringing', dialed_at: longAgo, created_at: longAgo } });
    expect((await reaper.sweepManualCalls()).orphaned).toBe(1);

    const p = await contactRow(placed.contact.id as string);
    expect(p).toMatchObject({ state: 'pending', our_fault_attempts: 1, last_outcome: 'orphaned' });
    expect(p.next_attempt_at.getTime()).toBe(longAgo.getTime() + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
  });
});
