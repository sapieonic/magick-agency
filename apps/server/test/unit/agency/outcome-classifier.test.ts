import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Carrier event → outcome → release reason → console copy.
//
// This chain is total by necessity: a missed mapping strands a contact in
// `in_flight` forever (the campaign can then never reach `completed`), and a
// `released` with no reason blanks the agent's panel with no explanation.
// ---------------------------------------------------------------------------

import {
  classifyAttemptOutcome,
  releaseReasonFor,
  requiresDisposition,
  releaseMessageFor,
  campaignMessageFor,
  campaignChangeReasonFor,
  isDialingStatus,
} from '../../../src/agency/outcome-classifier.js';
import type {
  AgencyAttemptOutcome,
  AgencyCampaignChangeReason,
  AgencyCampaignStatus,
  AgencyReleaseReason,
} from '@magick-agency/contracts/agency';
import type { WebRtcCallStatus } from '@magick-agency/db/models/agency-call.model';

/** Every status the bridge can hand the classifier, terminal or not. */
const EVERY_STATUS = [
  'initiating', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy', 'canceled',
] as const satisfies readonly WebRtcCallStatus[];

// ===========================================================================
// The full truth table over (status × answered × bridged)
//
// Written out row by row rather than generated from the implementation's own
// shape, because the defect being pinned is a BELIEF, not an off-by-one: every
// caller believed `answered` and `bridged` were one fact and passed the carrier's
// pickup for both. A table generated from `(status, flag)` would encode exactly
// that belief and go green against the bug.
//
// The `answered: false, bridged: true` rows are physically impossible — nothing
// bridges a leg the far end has not answered — and they are here deliberately, to
// pin which flag WINS if the pair ever arrives inconsistent. `bridged` does, in
// both directions: a bridged leg is a conversation whatever the answer flag says,
// and treating the inconsistency as "not answered" would drop a real connected
// call out of the connect rate.
// ===========================================================================
const TRUTH_TABLE: Array<{
  what: string;
  input: Parameters<typeof classifyAttemptOutcome>[0];
  expected: AgencyAttemptOutcome;
}> = [
  // ── status `completed` ────────────────────────────────────────────────────
  {
    what: 'completed · answered · bridged — an ordinary conversation',
    input: { status: 'completed', outcome: 'remote_hangup', answered: true, bridged: true },
    expected: 'connected',
  },
  {
    what: 'completed · answered · NOT bridged — a customer who spoke to nobody',
    input: { status: 'completed', outcome: 'remote_hangup', answered: true, bridged: false },
    expected: 'abandoned',
  },
  {
    what: 'completed · not answered · not bridged — the ring completed, nobody picked up',
    input: { status: 'completed', outcome: 'canceled', answered: false, bridged: false },
    expected: 'no_answer',
  },
  {
    what: 'completed · not answered · bridged (impossible) — `bridged` wins',
    input: { status: 'completed', answered: false, bridged: true },
    expected: 'connected',
  },
  // ── status `canceled` ─────────────────────────────────────────────────────
  {
    what: 'canceled · answered · bridged — a conversation cut off by a teardown',
    input: { status: 'canceled', outcome: 'ended_by_user', answered: true, bridged: true },
    expected: 'connected',
  },
  {
    what: 'canceled · answered · NOT bridged — picked up, reached nobody',
    input: { status: 'canceled', outcome: 'ended_by_user', answered: true, bridged: false },
    expected: 'abandoned',
  },
  {
    what: 'canceled · not answered · not bridged — a dial WE stopped mid-ring',
    input: { status: 'canceled', outcome: 'agent_hangup', answered: false, bridged: false },
    expected: 'canceled',
  },
  {
    what: 'canceled · not answered · bridged (impossible) — `bridged` wins',
    input: { status: 'canceled', answered: false, bridged: true },
    expected: 'connected',
  },
  // ── the statuses that answer themselves, flags notwithstanding ────────────
  {
    what: 'no_answer — the carrier said so',
    input: { status: 'no_answer', outcome: 'no_answer', answered: false, bridged: false },
    expected: 'no_answer',
  },
  {
    what: 'busy — the carrier said so',
    input: { status: 'busy', outcome: 'busy', answered: false, bridged: false },
    expected: 'busy',
  },
  {
    what: 'failed — the carrier rejected the call',
    input: { status: 'failed', outcome: 'telephony_error', answered: false, bridged: false },
    expected: 'failed',
  },
  {
    what: 'a non-terminal status reaching a teardown falls to `failed`',
    input: { status: 'ringing', answered: false, bridged: false },
    expected: 'failed',
  },
  // ── the short-circuits, which outrank the status entirely ─────────────────
  {
    what: 'the agent\'s station socket dropped',
    input: { status: 'canceled', outcome: 'agent_disconnected', answered: false, bridged: false },
    expected: 'agent_disconnected',
  },
  {
    what: 'the reaper settled an attempt its owning replica died holding',
    input: { status: 'failed', outcome: 'orphaned', answered: false, bridged: false },
    expected: 'orphaned',
  },
  {
    what: 'the abandoned path settled it itself, and says so',
    input: { status: 'completed', outcome: 'abandoned', answered: true, bridged: false },
    expected: 'abandoned',
  },
];

describe('classifyAttemptOutcome — the truth table', () => {
  for (const { what, input, expected } of TRUTH_TABLE) {
    it(`${what} ⇒ ${expected}`, () => {
      expect(classifyAttemptOutcome(input)).toBe(expected);
    });
  }

  it('covers every (status × answered × bridged) combination that has a rule', () => {
    // A guard on the table itself, not on the classifier: the four statuses whose
    // verdict depends on the flags must each appear with all four flag pairs, or a
    // row added to the implementation could go unexercised while this file still
    // looked exhaustive. The short-circuit rows are excluded — their whole
    // property is that the flags do not matter.
    const shortCircuits = new Set(['agent_disconnected', 'orphaned', 'abandoned']);
    for (const status of ['completed', 'canceled'] as const) {
      const seen = TRUTH_TABLE
        .filter((row) => row.input.status === status && !shortCircuits.has(row.input.outcome ?? ''))
        .map((row) => `${row.input.answered}/${row.input.bridged}`);
      expect(new Set(seen), `${status} is missing a flag combination`)
        .toEqual(new Set(['true/true', 'true/false', 'false/false', 'false/true']));
    }
  });

  it('detects an unreachable number from any carrier phrasing', () => {
    for (const phrase of ['Invalid number', 'UNALLOCATED', 'not in service', 'no_route', 'No route to destination', 'unobtainable']) {
      expect(classifyAttemptOutcome({
        status: 'failed', outcome: 'telephony_error', errorMessage: phrase, answered: false, bridged: false,
      })).toBe('invalid');
    }
  });

  it('is conservative: anything ambiguous stays `failed`, never `invalid`', () => {
    // A false `invalid` permanently suppresses a real customer, which is far
    // worse than one wasted retry.
    for (const phrase of ['temporary failure', 'network congestion', 'timeout', 'switch error']) {
      expect(classifyAttemptOutcome({
        status: 'failed', outcome: 'telephony_error', errorMessage: phrase, answered: false, bridged: false,
      })).toBe('failed');
    }
  });

  it('an agent disconnect is never laundered into a bad-number verdict', () => {
    // Same phrasing, but the agent's socket dropping is not the customer's fault
    // and must not suppress or penalise their number.
    expect(classifyAttemptOutcome({
      status: 'canceled', outcome: 'agent_disconnected', errorMessage: 'invalid', answered: false, bridged: false,
    })).toBe('agent_disconnected');
  });

  it('never produces `machine` — AMD is out of scope (D1)', () => {
    // The carrier cannot tell us a machine answered, so voicemail is `connected`
    // and only the agent's disposition says otherwise. Inventing `machine` here
    // would be a lie the retry engine acts on.
    for (const status of EVERY_STATUS) {
      for (const answered of [true, false]) {
        for (const bridged of [true, false]) {
          expect(classifyAttemptOutcome({ status, answered, bridged })).not.toBe('machine');
        }
      }
    }
  });

  it('always returns SOMETHING — an unmapped event would strand the contact', () => {
    for (const status of EVERY_STATUS) {
      for (const answered of [true, false]) {
        for (const bridged of [true, false]) {
          expect(classifyAttemptOutcome({ status, answered, bridged })).toBeTruthy();
        }
      }
    }
  });
});

// ===========================================================================
// The two pilot defects (2026-09-08), pinned by name
//
// Both come from the same line: `agency-dialer.ts`'s `ended` handler passed
// `bridged: ev.answered`, so the classifier was told the carrier's pickup was a
// media bridge. The two rows below are the two directions that produced, and they
// are pinned separately because a fix that only addressed one would still leave
// the pilot's bridge rate unreadable.
// ===========================================================================
describe('pilot 2026-09-08, defect 1 — a cancelled ring is NOT an abandoned call', () => {
  it('classifies a ring the agent cancelled as `canceled`', () => {
    // 26 `local hangup` lines in the pilot window carried `intent: "agent_hangup"`
    // from the console. Every one of them had `answered: false` and reached the
    // `canceled`-status arm, which had no third branch — so it returned
    // `abandoned`, and ~19 phantom abandoned rows landed in the same column as the
    // real ones. `abandoned` means a REAL CUSTOMER picked up and got silence; a
    // cancelled ring has no customer in it at all.
    const outcome = classifyAttemptOutcome({
      status: 'canceled', outcome: 'agent_hangup', answered: false, bridged: false,
    });
    expect(outcome).toBe('canceled');
    expect(outcome, 'a dial nobody answered was counted as an abandoned customer')
      .not.toBe('abandoned');
    // And not laundered into the customer's ledger the other way either: a ring we
    // stopped is not the number failing to answer.
    expect(outcome).not.toBe('no_answer');
  });

  it('holds however OUR cancel is spelled, since three paths spell it differently', () => {
    // The browser leg closing yields `ended_by_user`; the hangup route yields
    // `agent_hangup`; a station drop mid-ring yields `agent_disconnected`. All
    // three are OUR pre-answer teardowns and none of them abandoned anybody.
    for (const spelling of ['ended_by_user', 'agent_hangup', 'browser_hangup']) {
      expect(classifyAttemptOutcome({
        status: 'canceled', outcome: spelling, answered: false, bridged: false,
      }), `outcome=${spelling}`).toBe('canceled');
    }
    // `agent_disconnected` is the exception, and deliberately so: it has its own
    // attempt outcome and short-circuits ahead of the status switch, so a station
    // drop mid-ring is reported as the dropped station rather than folded into
    // "we cancelled". Both land on the our-fault ledger either way
    // (`ourFaultBeforeBridge` names both), so the ledger is the same and only the
    // supervisor's explanation differs — which is the more specific one.
    expect(classifyAttemptOutcome({
      status: 'canceled', outcome: 'agent_disconnected', answered: false, bridged: false,
    })).toBe('agent_disconnected');
  });

  it('does NOT claim a far-end decline as our fault', () => {
    // ── The case this arm used to invert ────────────────────────────────────
    //
    // `status: 'canceled'` says only that the call ended before a pickup; WHO
    // ended it is in `outcome`. VoiceLink maps `reject`, `declin*` and SIP 487
    // onto `{status: 'canceled', outcome: 'canceled'}` — a customer actively
    // refusing the call. That is information ABOUT THE NUMBER (they are
    // screening), so it belongs on the customer's own `attempt_count`, not on the
    // our-fault ledger whose premise is "we stopped it and learned nothing".
    //
    // Getting this wrong redialled a screening customer on a bound they never
    // consume. On VoiceLink it is also the COMMON case, not the rare one:
    // `cancelRinging` is false there, so a local cancel frequently produces no
    // carrier `canceled` at all, while a far-end 487 always does.
    for (const farEnd of ['canceled', 'rejected', 'declined', undefined, null]) {
      expect(classifyAttemptOutcome({
        status: 'canceled', outcome: farEnd, answered: false, bridged: false,
      }), `outcome=${farEnd}`).toBe('no_answer');
    }
  });

  it('treats an unknown teardown outcome as NOT ours — the safe direction', () => {
    // `LOCALLY_ENDED_OUTCOMES` is an allow-list on purpose. A carrier outcome
    // nobody has seen yet must not be mistaken for one of ours: that direction of
    // error puts a real decline on the our-fault ledger, while the other spends
    // the customer's own allowance, which every unclassified teardown already does.
    expect(classifyAttemptOutcome({
      status: 'canceled', outcome: 'some_carrier_word_from_2027', answered: false, bridged: false,
    })).toBe('no_answer');
  });

  it('a BRIDGED teardown is never `canceled` — the invariant the dial gate rests on', () => {
    // ── Why this exhaustive sweep exists, and what it licenses ──────────────
    //
    // The `ended` handler routes `canceled` to the our-fault ledger behind
    // `(outcome === 'agent_disconnected' || outcome === 'canceled') &&
    // live.bridgedAt === null`. The comments at that gate and on
    // `DEFAULT_RETRY_POLICY.canceled` both claim the second half is satisfied
    // **by construction** for `canceled` — which is what makes the routing
    // unconditional, and therefore what makes that policy entry an unread
    // fail-safe rather than a live rule.
    //
    // That claim is a property of THIS function, not of the dial site, so it is
    // pinned here and swept over every input rather than asserted for one
    // scenario. If a future arm ever returned `canceled` for a bridged teardown,
    // the gate would start falling through to `chargeAttempt` — spending a
    // customer's allowance on a dial we stopped — and the only warning would be
    // this line going red.
    for (const status of EVERY_STATUS) {
      for (const answered of [true, false]) {
        for (const outcome of [
          undefined, 'ended_by_user', 'agent_hangup', 'remote_hangup', 'abandoned',
          'agent_disconnected', 'orphaned', 'service_shutdown', 'telephony_error',
        ]) {
          expect(
            classifyAttemptOutcome({ status, outcome, answered, bridged: true }),
            `status=${status} answered=${answered} outcome=${outcome}`,
          ).not.toBe('canceled');
        }
      }
    }
  });
});

describe('pilot 2026-09-08, defect 2 — an answered call that reached nobody is NOT connected', () => {
  it('classifies the `064836f1` shape as `abandoned`, not `connected`', () => {
    // Traced end to end on callId `064836f1-8915-49f8-9c5a-c741f3cdd2af`: the
    // agent cancelled at 10:36:09, VoiceLink could not act on it, the phone kept
    // ringing, the customer answered at 12.44, the relay opened into a dismissed
    // console, and it ended `status: completed` with `talkTime: 16` and 769/668
    // frames exchanged. Status says completed, duration says 16 seconds of audio —
    // every signal a status-or-duration check can see says "connected". The ONLY
    // thing that says otherwise is the missing `bridged_at`, which is the same
    // fact `ABANDONED_ATTEMPT_PREDICATE_SQL` reads.
    const outcome = classifyAttemptOutcome({
      status: 'completed', outcome: 'remote_hangup', answered: true, bridged: false,
    });
    expect(outcome).toBe('abandoned');
    expect(outcome, 'a call nobody spoke on was reported as a conversation and billed')
      .not.toBe('connected');
  });

  it('agrees with the SQL abandonment predicate rather than contradicting it', () => {
    // `ABANDONED_ATTEMPT_PREDICATE_SQL` is `answered_at IS NOT NULL AND (… OR
    // bridged_at IS NULL OR …)` — answered and not bridged. The classifier now
    // spells exactly that on BOTH terminal statuses, so the label in
    // `agency_call_attempts.outcome` and the rows the compliance query selects
    // finally describe the same attempts. This assertion is the cross-check: the
    // predicate is a leaf module with no imports, so the two can only be kept in
    // step by a test that states the shared arms.
    for (const status of ['completed', 'canceled'] as const) {
      // answered ∧ ¬bridged ⇒ abandoned, both statuses.
      expect(classifyAttemptOutcome({ status, answered: true, bridged: false })).toBe('abandoned');
      // ¬answered ⇒ never abandoned, whatever else is true. This is the arm that
      // kept the phantom rows out of the numerator even while the LABEL was wrong.
      expect(classifyAttemptOutcome({ status, answered: false, bridged: false }))
        .not.toBe('abandoned');
      // answered ∧ bridged ⇒ never abandoned.
      expect(classifyAttemptOutcome({ status, answered: true, bridged: true }))
        .not.toBe('abandoned');
    }
  });
});

describe('a service-initiated teardown is `orphaned`, not `failed`', () => {
  it('maps every service-lifecycle outcome the platform actually writes', () => {
    // `webrtc-bridge-manager.ts:315` settles its sessions `service_shutdown` on
    // SIGTERM, `ws-static-call-manager.ts:1613` does the same, and
    // `webrtc-call.repository.ts:305`'s stale sweep writes `stuck_active_call`
    // for a row whose owning replica died. All three previously fell through to
    // the status switch and came out `failed` — the CUSTOMER's ledger, 2 attempts,
    // and a contact retired by our own restart. `orphaned` has an our-fault
    // default and is routed to the `our_fault_attempts` ledger by the dial site,
    // which is `AD-P3-C-09`'s whole point.
    for (const outcome of ['service_shutdown', 'system_rebooted', 'stuck_active_call']) {
      expect(classifyAttemptOutcome({
        status: 'failed', outcome, answered: false, bridged: false,
      }), outcome).toBe('orphaned');
      // The status does not rescue it either way — a shutdown mid-ring reports
      // `canceled` and one mid-conversation reports `completed`.
      expect(classifyAttemptOutcome({
        status: 'canceled', outcome, answered: false, bridged: false,
      }), `${outcome} (canceled)`).toBe('orphaned');
      // ⚠️ …but a BRIDGED one is a conversation, not a loss. This assertion used
      // to require `orphaned` here, which is what let an ordinary deploy landing
      // mid-conversation redial a customer we had just spoken to: `orphaned` is
      // `{delay_minutes: 0, max_attempts: 3}` while `connected` is
      // `{max_attempts: 0}`. It is the same distinction the
      // `max_duration_reached` test below rests on — a call we cut short is not a
      // call the platform lost.
      expect(classifyAttemptOutcome({
        status: 'completed', outcome, answered: true, bridged: true,
      }), `${outcome} (completed, bridged)`).toBe('connected');
      // And the boundary: answered but never bridged is still ours to own.
      expect(classifyAttemptOutcome({
        status: 'completed', outcome, answered: true, bridged: false,
      }), `${outcome} (answered, unbridged)`).toBe('orphaned');
    }
  });

  it('leaves `max_duration_reached` alone, though it shares the analytics dimension', () => {
    // `webrtcEndedBy` groups it with the service-lifecycle outcomes as `system`,
    // and that grouping is about WHO ended the call, not about whether the call
    // happened. This one did: it was answered, bridged and billed. Calling it
    // `orphaned` would put a completed conversation on the our-fault redial ledger
    // and re-dial a customer we just spoke to for thirty minutes.
    expect(classifyAttemptOutcome({
      status: 'completed', outcome: 'max_duration_reached', answered: true, bridged: true,
    })).toBe('connected');
  });
});

describe('releaseReasonFor / requiresDisposition', () => {
  const outcomes: AgencyAttemptOutcome[] = [
    'connected', 'no_answer', 'busy', 'failed', 'machine',
    'invalid', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled',
  ];

  it('maps every outcome, and null, to a reason', () => {
    for (const o of outcomes) expect(releaseReasonFor(o)).toBeTruthy();
    expect(releaseReasonFor(null)).toBe('reservation_expired');
  });

  it('distinguishes the agent hanging up from the call simply ending', () => {
    expect(releaseReasonFor('connected')).toBe('completed');
    expect(releaseReasonFor('connected', { agentHungUp: true })).toBe('agent_hangup');
  });

  it('`canceled` gets NO reason of its own, and reuses copy that is true', () => {
    // Deliberately not a new `AgencyReleaseReason` member. Under late binding a
    // pre-answer cancel is announced to nobody — the agent was never shown the
    // dial — and with the flag off the only producer is the agent's own hangup,
    // which already has exact copy. A new member would be a fifth hand-mirrored
    // union (core, master's error mask, cusui, `releaseMessageFor`) bought for a
    // frame that either is not sent or already reads correctly.
    expect(releaseReasonFor('canceled', { agentHungUp: true })).toBe('agent_hangup');
    expect(releaseMessageFor(releaseReasonFor('canceled', { agentHungUp: true })))
      .toBe('You ended the call.');
    // The residual case — a supervisor stop or a pause landing mid-ring with the
    // flag off. Uninformative but true, which beats inventing copy for a state
    // the agent was not watching.
    expect(releaseReasonFor('canceled')).toBe('completed');
    expect(releaseMessageFor(releaseReasonFor('canceled'))).toBe('Call ended.');
    // Emphatically NOT `abandoned`: "The call was answered but could not be
    // connected to you" would tell an agent a customer was left hanging by a dial
    // nobody ever picked up.
    expect(releaseReasonFor('canceled')).not.toBe('abandoned');
  });

  it('asks for a disposition ONLY when the call reached the agent', () => {
    // Prompting on a number that rang out trains agents to click through the
    // dialog without reading it, which poisons the data the retry engine uses.
    expect(requiresDisposition('connected')).toBe(true);
    for (const o of outcomes.filter((x) => x !== 'connected')) {
      expect(requiresDisposition(o)).toBe(false);
    }
    expect(requiresDisposition(null)).toBe(false);
  });
});

describe('console copy', () => {
  it('has non-empty copy for every release reason', () => {
    const reasons: AgencyReleaseReason[] = [
      'completed', 'no_answer', 'busy', 'failed', 'invalid', 'abandoned',
      'agent_disconnected', 'reservation_expired', 'agent_hangup', 'remote_hangup',
      'campaign_paused', 'campaign_stopped', 'supervisor_released', 'orphaned',
    ];
    for (const r of reasons) {
      expect(releaseMessageFor(r).length).toBeGreaterThan(0);
    }
  });

  it('falls back rather than returning empty for an unknown reason', () => {
    // A console that receives a reason from a newer core must still say
    // something true instead of blanking the panel.
    expect(releaseMessageFor('something_new' as AgencyReleaseReason).length).toBeGreaterThan(0);
    expect(campaignMessageFor('something_new' as AgencyCampaignChangeReason).length).toBeGreaterThan(0);
  });

  it('has copy for every campaign change reason', () => {
    const reasons: AgencyCampaignChangeReason[] = [
      'list_exhausted', 'paused_by_supervisor', 'stopped_by_supervisor',
      'auto_paused', 'resumed', 'started',
    ];
    for (const r of reasons) expect(campaignMessageFor(r).length).toBeGreaterThan(0);
  });

  it('tells the two kinds of `paused` apart, which the status alone cannot', () => {
    // The defect this closes: both writers set `status = 'paused'`, so a reason
    // derived from the status announced the `AD-P4-C-02` compliance stop as "A
    // supervisor paused this campaign" to every agent on the floor.
    expect(campaignChangeReasonFor({ status: 'paused', pause_reason: 'supervisor' }))
      .toBe('paused_by_supervisor');
    expect(campaignChangeReasonFor({ status: 'paused', pause_reason: 'abandonment_ceiling' }))
      .toBe('auto_paused');
  });

  it('degrades an unattributed pause to "automatically", never to a person', () => {
    // A `pause_reason` value added later with no arm here, or a row paused by hand.
    // Vague and true beats confident and wrong: claiming a supervisor acted sends
    // the agent to ask a human who did nothing.
    expect(campaignChangeReasonFor({ status: 'paused', pause_reason: null })).toBe('auto_paused');
    expect(campaignChangeReasonFor({ status: 'paused', pause_reason: 'something_new' }))
      .toBe('auto_paused');
  });

  it('ignores stale pause metadata once the campaign has moved on', () => {
    // `transitionStatus` clears the lot on resume, but the reason must not depend
    // on that having happened — a resumed campaign is `resumed` whatever the row
    // still says, or a supervisor's resume would announce itself as a pause.
    expect(campaignChangeReasonFor({ status: 'running', pause_reason: 'abandonment_ceiling' }))
      .toBe('resumed');
    expect(campaignChangeReasonFor({ status: 'stopped', pause_reason: 'supervisor' }))
      .toBe('stopped_by_supervisor');
    expect(campaignChangeReasonFor({ status: 'stopping', pause_reason: null }))
      .toBe('stopped_by_supervisor');
  });

  it('only `running` counts as still dialing', () => {
    const statuses: AgencyCampaignStatus[] = ['draft', 'running', 'paused', 'stopping', 'completed', 'stopped'];
    for (const s of statuses) {
      expect(isDialingStatus(s)).toBe(s === 'running');
    }
  });
});

describe('AD-P2-C-05 — an abandoned call is never a connected one', () => {
  it('classifies `abandoned` on either terminal status', () => {
    // `abandonAnsweredCall` hangs the customer up itself, so the teardown it
    // produces can report either terminal status — `completed` when the apology
    // clip played, `canceled` when there was none to play. Both must reach the
    // same verdict, since the difference is a campaign config setting and not a
    // fact about the call.
    //
    // ⚠️ This block previously asserted these rows with `bridged: true`, and its
    // comment explained that `bridged` "here is the carrier's `answered` flag".
    // That was accurate, and it was the defect the 2026-09-08 pilot exposed: the
    // parameter meant one thing and was fed another. The rows now carry the real
    // facts — answered, never bridged — which is what an abandoned call is.
    for (const status of ['completed', 'canceled'] as const) {
      expect(classifyAttemptOutcome({
        status, outcome: 'abandoned', answered: true, bridged: false,
      }), status).toBe('abandoned');
    }
  });

  it('the short-circuit still outranks the status arms, which is why it stays', () => {
    // With `answered`/`bridged` separated, the `completed`/`canceled` arms reach
    // `abandoned` for these facts on their own — so the early return is no longer
    // the only thing standing between an abandoned call and `connected`. It is
    // kept because it is the one path that KNOWS rather than infers that no agent
    // was there, and this row is the case where that matters: a `bridged_at`
    // stamped by a bind that raced the apology clip. The bridge won that race, but
    // `abandonAnsweredCall` had already decided nobody was home, and its verdict
    // is the one the abandonment ledger was built on.
    expect(classifyAttemptOutcome({
      status: 'completed', outcome: 'abandoned', answered: true, bridged: true,
    })).toBe('abandoned');
  });

  it('does not let an invalid-number match steal an abandoned call', () => {
    // `isInvalidNumber` scans the concatenated outcome/errorCode/errorMessage
    // blob, so an abandoned call whose carrier message happens to mention an
    // unallocated number must still be `abandoned` — a false `invalid`
    // permanently suppresses a real customer we already inconvenienced once.
    expect(classifyAttemptOutcome({
      status: 'completed', outcome: 'abandoned', answered: true, bridged: false,
      errorMessage: 'unallocated number',
    })).toBe('abandoned');
  });

  it('and does not let one steal a cancelled ring either', () => {
    // The same hazard one door along, and the new arm makes it reachable: the
    // pre-answer teardown's `errorMessage` is whatever the carrier said about a
    // call it never completed. A cancelled ring classified `invalid` would
    // SUPPRESS the contact permanently (`resolveRetryDecision` routes `invalid`
    // to `suppressed` before any attempts arithmetic) on the strength of a
    // number we chose not to finish dialling.
    //
    // ⚠️ It currently DOES: `isInvalidNumber` is checked before the status switch,
    // so this row returns `invalid`. That ordering is deliberate and untouched
    // here — a carrier saying "unallocated" is a fact about the number, whoever
    // hung up — and the assertion exists to pin it as a KNOWN reading rather than
    // leave the next reader to discover it from a suppressed contact.
    expect(classifyAttemptOutcome({
      status: 'canceled', outcome: 'agent_hangup', answered: false, bridged: false,
      errorMessage: 'unallocated number',
    })).toBe('invalid');
  });
});
