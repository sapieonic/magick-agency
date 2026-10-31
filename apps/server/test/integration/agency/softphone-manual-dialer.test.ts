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
 *    within a minute or so rather than after 30.
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
let dialer: InstanceType<typeof ManualDialer>;
let reaper: InstanceType<typeof AgencyReaper>;

function boot() {
  bridge = new FakeBridge();
  agents = { releaseManual: vi.fn(async () => undefined) };
  const stations = { send: vi.fn(() => true) };
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
    const swept = await reaper.sweepManualCalls();
    expect(swept.orphaned).toBe(0);

    release();
    await dialer.settled(call.id as string);
    const row = await callRow(call.id as string);
    expect(row).toMatchObject({ state: 'ended', outcome: 'connected', end_reason: 'remote_hangup', talk_seconds: 612 });
    expect(row.settled_at).toBeNull(); // bridged: the outcome is owed
    expect(dialer.activeManualCallIds()).not.toContain(call.id);
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

  it('the startup sweep: an unbridged placed orphan is our fault and requeued now; an unplaced one is just released', async () => {
    const placed = await claimedCall({ call: { state: 'ringing', dialed_at: new Date() } });
    const unplaced = await claimedCall({ call: { state: 'queued' } });
    await reaper.reapOnStartup();

    const p = await contactRow(placed.contact.id as string);
    expect(p).toMatchObject({ state: 'pending', attempt_count: 0, our_fault_attempts: 1, last_outcome: 'orphaned' });
    near(p.next_attempt_at, Date.now());
    expect(await contactRow(unplaced.contact.id as string)).toMatchObject({ state: 'pending', attempt_count: 0, our_fault_attempts: 0 });
  });
});
