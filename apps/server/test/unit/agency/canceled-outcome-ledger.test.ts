// Mutation-checked: forcing `agency_abandoned_total` to increment on every settle reds
// 'moves NO compliance number…', so the metric reader is not vacuous. The metric reader runs over a real
// `@opentelemetry/sdk-metrics` provider (`ScrapeMetricReader` is inlined).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The 2026-09-08 pilot's defects at the DIAL SITE — the `ended` handler's
// three consequences.
//
// `outcome-classifier.test.ts` owns the truth table and `retry-policy.test.ts`
// owns the bound's arithmetic. What neither can see is the wiring between them,
// and all three of the defects lived exactly there:
//
//  1. the classifier was handed `bridged: ev.answered` — the CARRIER's pickup in
//     the place a media bridge belonged;
//  2. `canceled` fell to `chargeAttempt`, spending a customer's `attempt_count`
//     on a dial they were never given the chance to answer;
//  3. the local `bridged` that feeds the "Agency attempt ended" log line was
//     `ev.answered && (ev.talkTimeSeconds ?? 0) >= 0 && ev.status === 'completed'`,
//     whose middle clause is vacuous — so an operator reading Loki was told a
//     call bridged on the strength of a duration check that checks nothing.
//
// A separate file rather than an extension of `agency-dialer.test.ts` because
// its hoisted contact double has no `chargeOurFaultAttempt`, and per the house
// rule each file owns its own factories (no shared helpers).
//
// The metrics module is deliberately NOT mocked. The claim being made is that
// this change moves no compliance number, and the only thing that can support it
// is the value an export would actually read — the same reasoning
// `abandoned-call-path.test.ts` records for using the real meter provider.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// AgencyDialer imports WebRtcCallError from the bridge, which pulls the config
// graph — and the config schema `process.exit(1)`s on anything incomplete.
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { vobiz: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/vobiz' } },
  },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
    },
    contact: {
      unclaim: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(undefined),
      // The CUSTOMER's ledger. Every assertion in this file that matters is
      // "this spy was not called", which is worthless unless the spy exists —
      // so it is stubbed at its real name on the real repository shape.
      chargeAttempt: vi.fn().mockResolvedValue(1),
      // The OUR-FAULT ledger, `agency_contacts.our_fault_attempts`.
      chargeOurFaultAttempt: vi.fn().mockResolvedValue(1),
    },
    session: { setState: vi.fn().mockResolvedValue(undefined) },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyContactRepository: repos.contact,
  agencyCampaignRepository: {},
  agencyAgentSessionRepository: repos.session,
}));

import { AgencyDialer } from '../../../src/agency/agency-dialer.js';
import { AgentStateMachine } from '../../../src/agency/agent-state-machine.js';
import { StationRegistry } from '../../../src/agency/station-registry.js';
// The real meter provider, installed before `metrics.ts` creates its instruments:
// the claim is about the value an export (or the `:9090` scrape) would read.
const { reader } = await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  return { reader: installMetricReader() };
});
import { collectMetric } from '../../helpers/otel-metric-reader.js';
import { classifyAttemptOutcome } from '../../../src/agency/outcome-classifier.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

/**
 * A counter series' live value, or undefined when the label set is absent.
 *
 * Absent is a meaningful answer, not an error: an OTel counter exports no series
 * for a label set until its first `add`, so "this tenant/campaign never
 * appeared in the abandonment numerator" and "it appeared at 0" are different
 * facts and only the first is what a cancelled ring should produce.
 */
async function counterValue(name: string, labels: Record<string, string>): Promise<number | undefined> {
  return (await collectMetric(reader, name)).find((p) =>
    Object.entries(labels).every(([k, val]) => p.attributes[k] === val))?.value;
}

function fakeWrapup() {
  return {
    enter: vi.fn(async () => false),
    cancel: vi.fn(),
    force: vi.fn(async () => false),
    stateFor: vi.fn(() => null),
    noteDisposition: vi.fn(async () => false),
    stop: vi.fn(),
    active: vi.fn(() => 0),
  };
}

function fakeBreaks() {
  return {
    queue: vi.fn(), peek: vi.fn(() => null), take: vi.fn(() => null),
    cancel: vi.fn(), size: vi.fn(() => 0),
  };
}

function fakeWs() {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on() { /* the bridge attaches its own listeners; not exercised here */ },
    off() { /* ditto */ },
    close() { this.readyState = 3; },
    framesNamed(name: string) { return this.sent.filter((f) => f.event === name); },
  };
}

/** Bridge double whose lifecycle events fire when the test says so. */
function fakeBridge() {
  const listeners: Array<(e: any) => void> = [];
  return {
    onLifecycle(fn: (e: any) => void) { listeners.push(fn); return () => { /* noop */ }; },
    createBridgedCall: vi.fn(async () => ({ id: 'call-1' } as any)),
    /**
     * Fire a lifecycle event and let the handler finish.
     *
     * `AgencyDialer.start()`'s subscription is `void this.onBridgeLifecycle(ev)`
     * — fire-and-forget by design, because it runs inside bridge teardown and
     * must never block the path that settles credit. So the handler's DB writes
     * are still queued when the listener returns, and one macrotask turn drains
     * the whole chain of already-resolved repository doubles.
     *
     * A single deterministic yield rather than `vi.waitFor`, which the sibling
     * file uses: most of the assertions here are NEGATIVE — "`chargeAttempt` was
     * never called" — and a polling wait would let those pass by looking too
     * early, which is precisely the mistake that would leave the customer-ledger
     * charge in place and the suite green.
     */
    async emit(ev: any) {
      for (const l of listeners) l(ev);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1',
  telephony_provider: 'voicelink', record_calls: false,
  analysis_profile_id: null, caller_ids: ['+14155550100'],
  // Empty, i.e. what a campaign stores when no catalog was configured.
  // Kept explicit because `requiresDisposition(outcome, undefined)` and
  // `(outcome, [])` are different answers.
  disposition_catalog: [],
  retry_policy: {},
} as any;

const CONTACT = {
  id: 'contact-1', phone_e164: '+919876543210',
  context: { 'First Name': 'Asha' }, attempt_count: 0,
} as any;

function makeCmd(): DialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-1', contactId: 'contact-1',
    sessionId: 's1', ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign: CAMPAIGN, contact: CONTACT,
  };
}

/**
 * A dialer driven through a real dial, so the `ended` handler sees a genuine
 * `liveByAttempt` record — which is the whole subject here. Both properties
 * under test read `live.bridgedAt`, and a handler invoked without a live record
 * returns early and asserts nothing.
 *
 * `transition` is stubbed for the reason `agency-dialer.test.ts` records: a bare
 * `AgentStateMachine` with no Redis fails closed, which would abort every dial
 * and turn each of these into an agent-lease test.
 */
async function dialedWorld() {
  const bridge = fakeBridge();
  // `'r1'` is the replica id, and it must match `DialCommand.ownerReplica` —
  // otherwise the station is not locally owned, `executeDial` finds no socket and
  // abandons before the dial, and every assertion below reads `undefined`.
  const stations = new StationRegistry(null, '', 'r1');
  const agents = new AgentStateMachine(null, '');
  vi.spyOn(agents, 'transition').mockResolvedValue(true);
  const dialer = new AgencyDialer(
    bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any,
  );
  // Without this the constructor has subscribed to nothing and every lifecycle
  // event is dropped silently — the whole file then asserts against an untouched
  // set of doubles and reads as an implementation gap rather than a harness one.
  dialer.start();
  const ws = fakeWs();
  await stations.attach({
    sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
    agentUserId: 'user-1', ws: ws as any,
  });
  await dialer.executeDial(makeCmd());
  return { bridge, stations, dialer, ws };
}

/** The outcome the `ended` write actually persisted. */
function persistedOutcome(): string | undefined {
  return repos.attempt.setState.mock.calls
    .filter(([, state]: any[]) => state === 'ended')
    .at(-1)?.[2]?.outcome;
}

beforeEach(() => vi.clearAllMocks());

// ===========================================================================
// Defect 2 — the agent cancels a ringing dial
// ===========================================================================
describe('pilot 2026-09-08: a cancelled ring is charged to the our-fault ledger', () => {
  /**
   * The pilot's shape. VoiceLink cannot cancel a ringing leg, so the console's
   * hangup arrives as a pre-answer teardown: `status: 'canceled'`,
   * `outcome: 'agent_hangup'` (the hangup route), `answered: false`, and no
   * `bridged` phase ever fired.
   */
  async function cancelledRing() {
    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'canceled', outcome: 'agent_hangup', answered: false,
    });
    return world;
  }

  it('classifies it `canceled`, not `abandoned`', async () => {
    await cancelledRing();
    expect(persistedOutcome()).toBe('canceled');
    // The phantom rows. ~19 of the pilot's abandoned attempts were dials no
    // customer ever picked up, sitting in the same column as the real ones —
    // which is what made the 32% bridge rate unreadable rather than imprecise.
    expect(persistedOutcome(), 'a dial nobody answered was recorded abandoned')
      .not.toBe('abandoned');
  });

  it('spends `our_fault_attempts` and NEVER the customer\'s `attempt_count`', async () => {
    await cancelledRing();
    // The our-fault ledger rule (never charge the customer's attempt_count), applied to a second cause. Three cancelled
    // rings against `max_attempts: 3` would otherwise retire a contact nobody
    // ever spoke to, behind an entirely plausible audit trail.
    expect(repos.contact.chargeAttempt,
      'a dial we cancelled spent one of the customer\'s max_attempts')
      .not.toHaveBeenCalled();
    expect(repos.contact.chargeOurFaultAttempt).toHaveBeenCalledWith('contact-1', 'canceled');
  });

  it('never reaches `resolveRetryDecision` — which is why the default policy key is unread', async () => {
    // ── The routing claim, pinned behaviourally rather than by comment ──────
    //
    // `DEFAULT_RETRY_POLICY.canceled` is documented as a FAIL-SAFE that no live
    // path reads, and that documentation is only honest if this holds. The proof
    // is available from one spy because of how the `ended` handler is shaped:
    // `agency-dialer.ts` calls `resolveRetryDecision` in exactly one place, on
    // the line immediately after the ONLY `chargeAttempt` call, inside the `else`
    // branch. So `chargeAttempt` not being called is not a proxy for the claim —
    // it is the claim, as narrowly as a double can express it.
    //
    // Swept over every spelling of a pre-answer teardown rather than the one the
    // pilot produced, since the routing must not depend on which of the three
    // hangup paths the console happened to take. If any of these ever charged the
    // customer's ledger, `DEFAULT_RETRY_POLICY.canceled` would silently become a
    // live rule and its comment a lie.
    for (const outcome of ['agent_hangup', 'ended_by_user', 'browser_hangup']) {
      vi.clearAllMocks();
      const world = await dialedWorld();
      await world.bridge.emit({
        callId: 'call-1', correlationId: 'att-1', phase: 'ended',
        status: 'canceled', outcome, answered: false,
      });
      expect(persistedOutcome(), `outcome=${outcome}`).toBe('canceled');
      expect(repos.contact.chargeAttempt, `outcome=${outcome} reached the customer ledger`)
        .not.toHaveBeenCalled();
      expect(repos.contact.chargeOurFaultAttempt).toHaveBeenCalledWith('contact-1', 'canceled');
    }
  });

  it('sends a FAR-END DECLINE to the customer ledger, not ours', () => {
    // ── The fixture this suite was missing ─────────────────────────────────
    //
    // The loop above sweeps the spellings of OUR cancel, and an earlier version
    // included `undefined` among them — which quietly asserted that a teardown
    // with no outcome at all is our fault. It is not, and on VoiceLink the
    // unattributed `canceled` webhook is usually a far-end decline: `reject`,
    // `declin*` and SIP 487 all map to `{status: 'canceled', outcome:
    // 'canceled'}`, and `cancelRinging` is false there, so a local cancel often
    // produces no carrier `canceled` at all.
    //
    // Asserted at the classifier rather than through the dial site because the
    // routing gate (`ourFaultBeforeBridge`) keys on the ATTEMPT outcome: once the
    // classifier says `no_answer`, the our-fault branch is unreachable by
    // construction, which is a stronger statement than observing one mock.
    for (const farEnd of ['canceled', 'rejected', 'declined', undefined]) {
      const classified = classifyAttemptOutcome({
        status: 'canceled', outcome: farEnd, answered: false, bridged: false,
      });
      expect(classified, `outcome=${farEnd}`).toBe('no_answer');
      // Not our ledger's business, and specifically not `canceled` — which is the
      // only outcome `ourFaultBeforeBridge` accepts from this status.
      expect(classified, `outcome=${farEnd}`).not.toBe('canceled');
    }
  });

  it('returns the contact to the roster, and writes no second charge', async () => {
    await cancelledRing();
    // Asserted as the STATE: a contact moved to a terminal state keeps whatever
    // `next_attempt_at` it had, so the absence of a timestamp proves nothing.
    const [, state, patch] = repos.contact.markState.mock.calls.at(-1)!;
    expect(state, 'a contact we never reached was retired by our own cancel').toBe('pending');
    // `chargeOurFaultAttempt` already wrote `last_outcome`, exactly as
    // `chargeAttempt` does on the customer-ledger path.
    expect(patch ?? {}).not.toHaveProperty('bump_attempt');
    expect(patch ?? {}).not.toHaveProperty('last_outcome');
    expect(patch).toHaveProperty('next_attempt_at');
  });

  it('tells the agent they ended the call, and asks for no write-up', async () => {
    const world = await cancelledRing();
    const released = world.ws.framesNamed('released').at(-1);
    expect(released?.reason).toBe('agent_hangup');
    expect(released?.message).toBe('You ended the call.');
    // Emphatically not `abandoned`'s copy — "The call was answered but could not
    // be connected to you" describes a customer left hanging, on a dial nobody
    // picked up.
    expect(released?.reason).not.toBe('abandoned');
    // A ring that never reached anyone is not the agent's to describe.
    expect(released?.requires_disposition).toBe(false);
  });

  it('moves NO compliance number — the numerator is the predicate, not the label', async () => {
    // The claim the whole ticket rests on. `agency_abandoned_total` is
    // incremented off `isAbandonedAttempt`, whose first arm is
    // `answeredAt === null ⇒ false`, so a cancelled ring was already excluded
    // while its LABEL said `abandoned`. Relabelling it therefore changes the
    // outcome string and nothing a compliance alert reads.
    //
    // Read as `undefined`, not 0: a labelled counter registers no child until its
    // first `inc`, so absence is the honest signal that this campaign never
    // entered the numerator at all.
    const labels = { tenant_id: 't1', campaign_id: 'camp-1' };
    const abandonedBefore = await counterValue('agency_abandoned_total', labels);
    const answeredBefore = await counterValue('agency_answered_total', labels);

    await cancelledRing();

    expect(await counterValue('agency_abandoned_total', labels)).toBe(abandonedBefore);
    // And the denominator is untouched too, for the same reason: the `answered`
    // phase never fired, so the compliance RATIO this campaign contributes to is
    // unchanged in both of its terms rather than merely in one.
    expect(await counterValue('agency_answered_total', labels)).toBe(answeredBefore);
  });
});

// ===========================================================================
// Defect 1 — `bridged` must come from `live.bridgedAt`, not from `ev.answered`
// ===========================================================================
describe('pilot 2026-09-08: the classifier is handed the BRIDGE, not the carrier answer', () => {
  it('the `064836f1` shape settles `abandoned`, not `connected`', async () => {
    // Answered and never bridged. This is the call that made the fix urgent: the
    // agent's cancel did nothing, the phone kept ringing, the customer answered,
    // and the relay opened into a dismissed console — ending `completed` with 16
    // seconds of talk time and 769/668 frames exchanged. With `bridged:
    // ev.answered` the classifier saw a bridged, completed call and returned
    // `connected`: into the connect rate, and billed at the flat agency rate.
    const world = await dialedWorld();
    const answeredAt = new Date();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt,
    });
    // NO `bridged` phase — that is the entire scenario.
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'remote_hangup', answered: true, talkTimeSeconds: 16,
    });

    expect(persistedOutcome()).toBe('abandoned');
    expect(persistedOutcome(), 'a call nobody spoke on was recorded as a conversation')
      .not.toBe('connected');
    // Charged to the CUSTOMER's ledger, deliberately: they picked up and were
    // inconvenienced, so this is a real attempt and `abandoned`'s own retry rule
    // applies. The our-fault ledger is for calls that never reached them.
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
    expect(repos.contact.chargeAttempt).toHaveBeenCalledWith('contact-1', 'abandoned');
  });

  it('a genuinely bridged call is still `connected` — the negative control', async () => {
    // Without this, "always abandoned" would satisfy the assertion above.
    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date(),
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true,
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'remote_hangup', answered: true, talkTimeSeconds: 42,
    });
    expect(persistedOutcome()).toBe('connected');
  });

  it('reads `live.bridgedAt` even when the carrier reports it never answered', async () => {
    // The discriminating case, and the reason this property cannot be asserted
    // from the classifier alone: `answered: false` on the terminal event with a
    // `bridged` phase already recorded. If the call site still derived `bridged`
    // from `ev.answered` it would read false here and settle `canceled` —
    // retiring a live conversation as a dial we stopped, and sending it to the
    // our-fault ledger. Reading the bridge's own stamp gives `connected`.
    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true,
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'canceled', outcome: 'ended_by_user', answered: false, talkTimeSeconds: 7,
    });
    expect(persistedOutcome()).toBe('connected');
    expect(persistedOutcome()).not.toBe('canceled');
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
  });

  it('does not treat talk time as evidence of a bridge', async () => {
    // The vacuous clause, pinned. The old local read `(ev.talkTimeSeconds ?? 0)
    // >= 0`, which is true of every possible value including `undefined` — so a
    // reader could not tell whether duration was being consulted at all. It is
    // not: a cancelled ring that the carrier bills a second of setup to is still
    // a call that reached nobody.
    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'canceled', outcome: 'agent_hangup', answered: false, talkTimeSeconds: 3,
    });
    expect(persistedOutcome()).toBe('canceled');
  });
});
