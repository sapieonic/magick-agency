import type {
  AgencyInboundCallOutcome,
  AgencyInboundClosedCause,
  AgencyInboundClipSlot,
  AgencyInboundMissedReason,
  AgencyInboundStickyReason,
} from '@magick-agency/contracts/agency';
import { AGENCY_INBOUND_ROUTE_DEFAULTS, AGENCY_INBOUND_ROUTE_LIMITS } from '@magick-agency/contracts/agency';
import { AGENCY_INBOUND_SLOT_STANDARD } from '@magick-agency/contracts/api/agency/inbound';
import { inboundScheduleState, nextInboundOpening } from '@magick-agency/domain/inbound-schedule';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { agencyCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { createChildLogger } from '@magick-agency/observability';
import { trackInboundCallEnded, trackInboundOverflow } from '@magick-agency/observability/metrics/agency';
import {
  agencyContactRepository,
  agencyInboundAnswerRepository,
  agencyInboundCallRepository,
  agencyInboundRouteRepository,
  type AgencyInboundCallRecord,
  type AgencyInboundRouteRecord,
  type InboundRouteSchedule,
} from '../../db/repositories/agency.repository.js';
import {
  type InboundAnswerDecision,
  type InboundAnswerOptions,
  type InboundCallArrival,
  type InboundCallHangup,
  type InboundCallRouter,
  type InboundSpokenMessage,
} from '../../seams/inbound-call-router.js';
import { AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS } from '@magick-agency/contracts/agency';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { DEFERRED_HANGUP_MS } from '@magick-agency/domain/timers';
import type { ClipSequenceResult, WebRtcBridgeManager } from '../../core/webrtc-bridge-manager.js';
import type { DncRegistry } from '../dnc-registry.js';
import { identifyInboundCaller } from './identify-caller.js';
import { resolveInboundClips, routeClipId, type InboundClipPart } from './inbound-clips.js';
import type { InboundCallEnd, InboundCallExits, InboundConnector } from './inbound-connector.js';
import { discardVoicemail, takeVoicemail, voicemailAvailable, type InboundVoicemailDeps } from './inbound-voicemail.js';
import type { AgencyDialer } from '../agency-dialer.js';

const log = createChildLogger({ component: 'agency-inbound-router' });

/**
 * ─── THE INBOUND CALL, P1: ANSWER EVERY CALL, CONNECT NOBODY (docs/inbound.md §3, §7, §10) ───
 *
 * The agency side of the inbound seam (`seams/inbound-call-router.ts`): the voice area has
 * verified the carrier's callback; this decides what the call is and what the caller hears, and
 * owns its spine row (`agency_inbound_calls`), its Missed row and its callback.
 *
 * ── Answer (synchronous, inside the carrier's answer-URL timeout) ────────────────
 *  1. The number rung, on the credential the call arrived on (`findRouteForNumber`). Not the
 *     credential's, not active, not linked to inbound, not assigned to its tenant → REFUSED: a
 *     `rejected` spine row (no Missed row) and a hangup.
 *  2. Who is calling (`identifyInboundCaller`, §4.1) and the account (§8.3): the matched contact's
 *     account (it may use the number), else the number's route's (while its account may still use
 *     the number), else the tenant default (no account): the carrier speaks the closed message,
 *     the Missed row is written, nothing streams.
 *  3. The caller on DNC (§7): the registry checked for the match's campaign, else the account,
 *     else tenant-wide, and a DNC-suppressed contact; flagged on the row (`caller_dnc`). Never
 *     auto-dialled (the follow-up re-checks and fails closed, B8).
 *  4. The plan: a credential that is not `active` (§10), or a route closed now
 *     (`inboundScheduleState`; `unresolvable` is closed), or no route at all → `closed`. Open →
 *     `queue` (P2, below) when agents may be connected and someone in the caller's pool could
 *     take them now or once their current work ends (the connector's rule, its rejoin grace
 *     included: PM-M6, SWE-N4), else the caller is told we will call back → `overflow` (the
 *     route's overflow action: the call-back message or a voicemail, with no "please hold").
 *  5. Admission (IB5), in the transaction that writes the spine + leg (`insertArrival`): the
 *     route's live admitted calls are counted under the route's advisory lock; at its
 *     `max_concurrent` the call is turned away (`overflow_no_capacity`, stays `arrived`), else
 *     admitted (`greeting`). The bridge then takes the shared slots: over the account's own limit
 *     it is held anyway (IB5); with the global or carrier scope full it hears "all lines are busy"
 *     (`overflow_no_capacity`).
 *     A call turned away is not admitted (`arrived`): neither the route's count nor the account's
 *     live total holds it (the bridge's refusal takes the admission back, `refuseAdmission`).
 *  6. The answer: our stream (principle 2) when the route has a recording for the plan's message,
 *     a voicemail is taken, or the caller may queue. What the caller hears is played in the
 *     background ({@link AgencyInboundCallRouter.play}), after the carrier opens the stream. A
 *     caller who will only hear a message the route has no recording for is answered with the
 *     carrier speaking it (`spoken`, the standard recording's words) and the call is ended at
 *     once, its follow-up written: nothing streams, so no line of ours is held.
 *
 * ── What the caller hears (docs/inbound.md §3.4) ─────────────────────────────────
 * `greeting` (if set), then `closed` / `callback` / `busy` per the plan, then the call is put down.
 * No caller is put down in silence: on our stream a message with no recording of the route's plays
 * our standard recording (`inbound-standard-clips.ts`), and a call answered before anything
 * streams hears the same words spoken by the carrier ({@link spokenMessageFor}; the greeting is
 * then not played). A caller who withheld their number or whose number is on DNC is never
 * promised a callback: in opening hours the busy message ("try again shortly") stands in for the
 * call-back one, on every path ({@link messageSlotFor}); they never hear "we're closed" while the
 * line is open (PM-N1). Their voicemail is prompted by our neutral prompt, which asks for their
 * number and promises nothing ({@link voicemailPrompt}). With the global or carrier scope full (found only once the stream is
 * promised) the caller hears "busy" (the route's recording or ours). The connector's preamble
 * plays the greeting or, unset, our "please hold", and before a recorded call the notice (IB7),
 * the route's or ours ({@link AgencyInboundCallRouter.clips}).
 *
 * ── An answer past its budget (the webhook's abort signal) ───────────────────────
 * The caller heard the fallback message ("try again shortly"), so the call is the fallback's: the
 * answer places nothing more (no stream taken, no message), and the row, if one was written, ends
 * `failed` with no Missed row and no callback, whoever ends it (this answer, the hangup webhook,
 * the play loop).
 *
 * ── Tenant isolation ─────────────────────────────────────────────────────────────
 * A carrier call id already held by another tenant's or credential's row is refused with a hangup
 * and nothing written (`insertArrival`'s `foreign`), as the hangup webhook ignores one.
 *
 * ── The outcome ──────────────────────────────────────────────────────────────────
 * The plan's outcome once every message played. A caller who hangs up before the end: on the
 * `overflow` plan (the caller who would have waited in the queue) → `abandoned_in_queue`; on
 * `closed` and `overflow_no_capacity` the reason they were not taken is decided before they hang
 * up and stays (an after-hours caller who hangs up during the closed message rang after hours).
 * No media ever (the stream lost): `failed`, unless the carrier said the caller hung up first.
 * Exactly one writer ends a call: this process's play loop while it holds the call, else the
 * hangup webhook, else the sweep; the spine's terminal guard makes any second end a no-op.
 *
 * ── P2: the `queue` plan (docs/inbound.md §2, §5; IB8, Q12, Q13) ────────────────
 * An open route's admitted caller (a slot taken, or over the account's own limit: IB5 still
 * connects them) is put through to an agent when the account's `agency_inbound_enabled` flag is
 * on and the server runs one process (`MEDIA_WORKERS = 0`, IB8; with media workers P2 keeps the
 * P1 answer, logged once, Q13). The stream is taken in CONNECTABLE (`acceptInboundCall`): parked
 * for {@link parkedSecondsFor}, an agent's station bindable to it, recorded from the bind when the
 * route records (and the account allows it). The connector (`inbound-connector.ts`) then owns the
 * call: the greeting and, for a recorded call, the recording notice (IB7), the hold, the queue,
 * the agent. A caller who reaches nobody comes back through `InboundCallExits`: the route's
 * overflow message ({@link AgencyInboundCallRouter.overflow}) and {@link
 * AgencyInboundCallRouter.settleCall}, the one way every unconnected exit is written. A call
 * whose stream turns out to have no global or carrier slot hears "busy" as in P1.
 *
 * ── P2: the in-flight clash (§5.4, Q7, Q8) ───────────────────────────────────────
 * A `queue` caller whose number a paced dial is ringing right now: the dial is cancelled (on a
 * carrier that can stop it ringing) and its agent is handed this call ({@link
 * AgencyInboundCallRouter.supersedeRingingDial}).
 *
 * ── P2: voicemail (§7, IB3, Q14) ─────────────────────────────────────────────────
 * A route whose action for the case is `voicemail` (`after_hours_action` out of hours,
 * `overflow_action` for an open route's caller nobody takes: the P1 plan, or the queue's exit)
 * takes one: the case's message as the prompt, the beep, up to 120 s recorded from our stream,
 * stored as a WAV (`inbound-voicemail.ts`), the call `voicemail` with the case's Missed reason.
 * A caller who leaves before speaking ends as the case's own outcome. Without storage
 * configured, or (before the stream is ours) without a recording for the prompt, the action's
 * message plays as for `callback`. Busy callers (`overflow_no_capacity`) leave none.
 *
 * ── The follow-up (§7, IB3, IB4) ─────────────────────────────────────────────────
 * Every call that reached no one is a Missed row (`follow_up_status = 'open'`, its reason,
 * assignee the sticky agent if they can see the account, else the account). And, for a matched
 * contact not on DNC (re-checked, failing closed), an inbound callback on the contact
 * (`bookInboundCallback`: running or paused campaign, not terminal; exhausted is reopened) due at
 * the route's next opening (`nextInboundOpening`; a route that never opens books none, a call with
 * no route books one due now), in the transaction that ends the spine.
 */

/** The message a plan's caller is answered with: its clip slot on the route, and the carrier's spoken stand-in for it. */
const PLAN_MESSAGE: Record<PlannedOutcome, { slot: AgencyInboundClipSlot; spoken: InboundSpokenMessage }> = {
  closed: { slot: 'closed', spoken: 'closed' },
  overflow: { slot: 'callback', spoken: 'callback' },
  overflow_no_capacity: { slot: 'busy', spoken: 'busy' },
};

type PlannedOutcome = Extract<AgencyInboundCallOutcome, 'closed' | 'overflow' | 'overflow_no_capacity'>;

/** How long a connectable call may wait before an agent is bound beyond the queue's maximum wait: the preamble. */
export const INBOUND_PREAMBLE_ALLOWANCE_SECONDS = 60;
/** After the queue: the overflow message, or a voicemail's prompt and recording. */
export const INBOUND_EXIT_ALLOWANCE_SECONDS = AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS + 30;

/**
 * The least budget of a call that leaves a voicemail and is never connected (after hours, or an
 * open route's caller nobody can be put through to, §7): the greeting, the message and the beep,
 * and the whole recording. `acceptInboundCall` takes the account's max duration when longer.
 */
export const INBOUND_VOICEMAIL_BUDGET_SECONDS = INBOUND_PREAMBLE_ALLOWANCE_SECONDS + INBOUND_EXIT_ALLOWANCE_SECONDS;

/**
 * The parked budget of a connectable call (`acceptInboundCall`'s `parkedSeconds`): everything
 * that may happen before an agent's bind — the preamble, the queue's maximum wait, and what a
 * caller who reaches nobody hears after it. The bridge's parked backstop ends a call still
 * unbound then; the queue's own maximum wait always acts first.
 */
export function parkedSecondsFor(route: Pick<AgencyInboundRouteRecord, 'queue_max_wait_seconds'>): number {
  return route.queue_max_wait_seconds + INBOUND_PREAMBLE_ALLOWANCE_SECONDS + INBOUND_EXIT_ALLOWANCE_SECONDS;
}

/** The longest a call may be parked before an agent's bind: {@link parkedSecondsFor} at the route's longest maximum wait. */
export const INBOUND_MAX_PARKED_SECONDS = parkedSecondsFor({ queue_max_wait_seconds: AGENCY_INBOUND_ROUTE_LIMITS.QUEUE_MAX_WAIT_SECONDS.max });

/** Who is calling, as far as what they may be promised goes: their number (null: withheld) and whether it is on DNC. */
export type InboundCallerPromise = Pick<AgencyInboundCallRecord, 'from_e164' | 'caller_dnc'>;

/**
 * Whether a caller may be told "we'll call you back": not one who withheld their number (nobody
 * can ring them) nor one on DNC (nobody may, B8; no callback is ever booked for them).
 */
export function mayPromiseCallback(caller: InboundCallerPromise): boolean {
  return caller.from_e164 !== null && !caller.caller_dnc;
}

/**
 * The clip slot of the message a plan's caller hears: the plan's own, except that a caller who
 * may not be promised a callback ({@link mayPromiseCallback}) hears the busy message ("…Please try
 * again shortly") instead of the call-back one, on every path (spoken, played, the queue's
 * overflow). PM-N1: the call-back case is always in opening hours (an open route's caller nobody
 * takes), so the closed words ("we're closed") would be false there; a `closed` plan keeps the
 * closed words for everyone, and over capacity (`overflow_no_capacity`) is busy for everyone.
 */
export function messageSlotFor(planned: PlannedOutcome, caller: InboundCallerPromise): 'closed' | 'callback' | 'busy' {
  const slot = PLAN_MESSAGE[planned].slot as 'closed' | 'callback' | 'busy';
  return slot === 'callback' && !mayPromiseCallback(caller) ? 'busy' : slot;
}

/**
 * What the carrier speaks for a plan when nothing will stream and the route has no recording for
 * its message: the standard recording's words for {@link messageSlotFor}'s slot.
 */
export function spokenMessageFor(planned: PlannedOutcome, caller: InboundCallerPromise): InboundSpokenMessage {
  return messageSlotFor(planned, caller);
}

/** A message slot as a part that never plays silence: the route's recording, else our standard one. */
function withStandard(slot: 'closed' | 'callback' | 'busy'): InboundClipPart {
  return { slot, standard: slot };
}

/** How many answers given up on (their callers heard the fallback) this process remembers until their hangup. */
const GIVEN_UP_MAX = 10_000;

/**
 * How long a hangup that found no call to end is remembered for an answer still in flight
 * (QA-F4): the caller gave up during our answer-URL work, so the hangup webhook can land before
 * the answer writes the spine row. Well past the answer's budget (`INBOUND_ANSWER_BUDGET_MS`).
 */
export const INBOUND_EARLY_HANGUP_MS = 30_000;

const carrierKey = (provider: string, carrierCallId: string): string => `${provider}:${carrierCallId}`;

/**
 * The Missed row's reason for how a call that reached nobody ended; null for `answered` /
 * `rejected`. A voicemail's reason is the action that took it (`closed` after hours, `overflow`
 * from the queue), carried on its end; one with none named reads as an overflow.
 */
export function missedReasonFor(end: AgencyInboundCallOutcome | InboundCallEnd): AgencyInboundMissedReason | null {
  const { outcome, voicemail } = typeof end === 'string' ? { outcome: end, voicemail: null } : end;
  switch (outcome) {
    case 'answered':
    case 'rejected':
      return null;
    case 'voicemail':
      return voicemail?.reason ?? 'overflow';
    default:
      return outcome;
  }
}

/** The action a route takes for a caller nobody answers in that case: after hours, or from the queue. */
export type InboundUnconnectedCase = Extract<AgencyInboundMissedReason, 'closed' | 'overflow'>;

/**
 * Whether a caller who reaches nobody leaves a voicemail (§7, IB3): the route's action for the
 * case is `voicemail` (`after_hours_action` for a call out of hours, `overflow_action` for one
 * that waited or would have, `max_waiting` included), and this process can store one.
 */
export function takesVoicemail(
  route: Pick<AgencyInboundRouteRecord, 'after_hours_action' | 'overflow_action'> | null,
  which: InboundUnconnectedCase,
  storageConfigured: boolean,
): boolean {
  if (!route || !storageConfigured) return false;
  return (which === 'closed' ? route.after_hours_action : route.overflow_action) === 'voicemail';
}

/**
 * What prompts a voicemail before its beep. For a caller who may be promised a callback: the
 * message's recording (the closed one after hours, the call-back one from the queue), else our
 * standard voicemail prompt ("… and we'll call you back"; also when the recording is set but
 * cannot be played). For a caller who may not be ({@link mayPromiseCallback}: withheld, DNC): our
 * neutral prompt ("Please leave your name, your number and a short message after the tone"),
 * whatever the route's recordings, which say "we're closed" or "goodbye" and may promise a call;
 * so such a caller can always leave a voicemail where the route's action takes one (a voicemail is
 * the only way to reach back a withheld caller).
 */
export function voicemailPrompt(
  route: AgencyInboundRouteRecord | null,
  messageSlot: 'closed' | 'callback' | 'busy',
  caller: InboundCallerPromise,
): InboundClipPart {
  if (!mayPromiseCallback(caller)) return { slot: null, standard: 'voicemail_prompt_neutral' };
  if (routeClipId(route, messageSlot)) return { slot: messageSlot, standard: 'voicemail_prompt' };
  return { slot: null, standard: 'voicemail_prompt' };
}

/** How a call that was playing its messages ends, from how the sequence ended (see the header). */
export function outcomeAfterPlayback(planned: PlannedOutcome, result: ClipSequenceResult, callerHungUp: boolean): AgencyInboundCallOutcome {
  const earlyHangup = planned === 'overflow' ? 'abandoned_in_queue' : planned;
  switch (result) {
    case 'completed':
      return planned;
    case 'aborted':
      return earlyHangup;
    case 'no_media':
    case 'not_found':
      return callerHungUp ? earlyHangup : 'failed';
  }
}

/** A call this process is playing messages to. */
interface LiveInboundCall {
  planned: PlannedOutcome | 'queue';
  /** The carrier's hangup arrived while the messages were (to be) playing. */
  callerHungUp: boolean;
}

export interface AgencyInboundCallRouterDeps {
  bridge: Pick<WebRtcBridgeManager,
    'acceptInboundCall' | 'playClipSequenceThenHangUp' | 'stopInboundHold' | 'recordInboundAudio' | 'forceEndWithOutcome'>;
  dnc: Pick<DncRegistry, 'check' | 'checkEntry'>;
  now?: () => Date;
  /** Where voicemails are stored (§7): the app's bucket by default; tests replace it. */
  voicemailStorage?: InboundVoicemailDeps['storage'];
  /**
   * P2: connecting agents (the `queue` plan). Absent: P1 (nobody is connected). `connector` is
   * set once the connector exists (`startInboundCalls` builds the two together).
   */
  connect?: {
    connector: InboundConnector | null;
    /** `agency_inbound_enabled` for the call's tenant and account; a read that fails is false (P1's answer). */
    enabled(tenantId: string, accountId: string): Promise<boolean>;
    /** `MEDIA_WORKERS` (IB8): P2 connects only in one process. */
    mediaWorkers: number;
    /** The dialer, for the in-flight clash (§5.4): a ringing dial to the caller cancelled and its agent handed the call. */
    dialer?: Pick<AgencyDialer, 'findRingingAttemptTo' | 'supersedeForInbound'> | null;
  };
}

export class AgencyInboundCallRouter implements InboundCallRouter, InboundCallExits {
  private readonly live = new Map<string, LiveInboundCall>();
  private warnedWorkers = false;
  /** Answers given up on (`provider:carrierCallId`): their callers heard the fallback, so they end with no follow-up. */
  private readonly givenUp = new Set<string>();
  /**
   * Hangups that came while the answer was still deciding (`provider:carrierCallId` → the
   * credential and tenant that verified it, and when), for {@link INBOUND_EARLY_HANGUP_MS}: the
   * answer ends its row at once instead of promising a stream nobody will open (QA-F4).
   */
  private readonly hungUpEarly = new Map<string, { tenantId: string; credentialId: string; at: number }>();
  private readonly running = new Set<Promise<void>>();
  private readonly now: () => Date;

  constructor(private readonly deps: AgencyInboundCallRouterDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The calls this process is playing messages to, by inbound call id (tests, shutdown). */
  liveCallIds(): string[] {
    return [...this.live.keys()];
  }

  /** Resolves once every message sequence started so far has ended and settled. */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  async answer(arrival: InboundCallArrival, opts: InboundAnswerOptions = {}): Promise<InboundAnswerDecision> {
    const { signal } = opts;
    const giveUp = () => this.noteGivenUp(carrierKey(arrival.provider, arrival.carrierCallId));
    if (signal?.aborted) giveUp();
    signal?.addEventListener('abort', giveUp, { once: true });
    try {
      return await this.decide(arrival, signal);
    } finally {
      signal?.removeEventListener('abort', giveUp);
    }
  }

  private async decide(arrival: InboundCallArrival, signal: AbortSignal | undefined): Promise<InboundAnswerDecision> {
    const found = await agencyInboundRouteRepository.findRouteForNumber(arrival.credentialId, arrival.toE164);
    const linked = found !== null && found.tenant_id === arrival.tenantId && found.number_status === 'active'
      && found.inbound_linked_at !== null && found.assignment_id !== null;
    if (!linked) {
      log.warn({ credentialId: arrival.credentialId, phoneNumberId: found?.phone_number_id ?? null }, 'Inbound call to a number not linked to inbound on this credential — refusing it');
      await this.reject(arrival, found?.phone_number_id ?? null);
      return { kind: 'hangup' };
    }
    const phoneNumberId = found.phone_number_id;
    const route = found.route && found.route_account_may_use ? found.route : null;
    const at = this.now();
    const identity = await identifyInboundCaller({
      tenantId: arrival.tenantId,
      fromE164: arrival.fromE164,
      numberRungE164: arrival.toE164,
      phoneNumberId,
      lookbackDays: route?.sticky_lookback_days ?? AGENCY_INBOUND_ROUTE_DEFAULTS.sticky_lookback_days,
      at,
    });
    const match = identity.match;
    const accountId = match?.accountId ?? route?.account_id ?? null;
    const callerDnc = await this.callerOnDnc(arrival, accountId, match);
    // Every candidate who can see the account, in rank order: the first is the sticky agent; the
    // connector names whichever of them takes the call (P2).
    let stickyCandidates: Array<{ userId: string; reason: AgencyInboundStickyReason }> = [];
    if (accountId && identity.candidates.length > 0) {
      const members = await agencyInboundAnswerRepository.filterAccountMembers(
        arrival.tenantId, accountId, identity.candidates.map((c) => c.userId));
      stickyCandidates = identity.candidates.filter((c) => members.has(c.userId)).map((c) => ({ userId: c.userId, reason: c.reason }));
    }
    const sticky = stickyCandidates[0] ?? null;
    const identification = {
      match: match ? { contactId: match.contactId, campaignId: match.campaignId } : null,
      callerDnc,
      sticky,
    };

    // Past the budget before anything is written: the fallback answered the caller, and the call
    // leaves nothing behind (as a call the fallback URL answers while we are down).
    if (signal?.aborted) return { kind: 'fallback' };

    if (accountId === null) {
      // The tenant default (§8.3): no account, so no leg and nothing to stream; the carrier speaks
      // the closed message. The Missed row is the tenant default's.
      const { call } = await agencyInboundCallRepository.insertArrival({
        tenantId: arrival.tenantId, accountId: null, routeId: null, phoneNumberId, provider: arrival.provider,
        telephonyCredentialId: arrival.credentialId, providerCallId: arrival.carrierCallId,
        fromE164: arrival.fromE164, toE164: arrival.toE164, identification, answered: true,
        recordingRequested: false, analysisProfileId: null, closedCause: 'no_route',
      });
      if (!call) return this.refuseForeign(arrival);
      if (call.state !== 'ended') await this.settle(call, 'closed');
      return { kind: 'spoken', message: 'closed' };
    }

    // The kill switch (§8.1): with the account's `agency_inbound_enabled` off, a caller is told
    // the route is closed, by the carrier (no queue, no stream, no voicemail), and left a Missed row.
    const switchedOff = route !== null && await this.switchedOff(arrival.tenantId, accountId);
    let planned: PlannedOutcome = arrival.credentialStatus !== 'active' || !route || switchedOff
      || inboundScheduleState(route, at) !== 'open' ? 'closed' : 'overflow';
    // Out of the route's hours (not a credential that is not active, nor no route, nor switched
    // off): the route's after-hours action applies (a voicemail, §7).
    const afterHours = planned === 'closed' && arrival.credentialStatus === 'active' && route !== null && !switchedOff;
    // Why, on the row (`closed_cause`, 0030): the inbound summary counts each apart (§11).
    const closedCause: AgencyInboundClosedCause | null = planned !== 'closed' ? null
      : arrival.credentialStatus !== 'active' ? 'credential_inactive'
        : !route ? 'no_route'
          : switchedOff ? 'switched_off'
            : 'hours';
    // P2: an open route's caller may be put through to an agent (the header). Decided before the
    // insert, so the leg asks for the recording the route wants (IB7's notice depends on it).
    const mayConnect = planned === 'overflow' && route !== null && await this.mayConnect(arrival.tenantId, accountId);
    // PM-M6 / SWE-N4: decided before the greeting. A caller nobody in their pool could take, now
    // or once their current work ends (the connector's own rule and presence read, its rejoin grace
    // included), is not put in the queue to hear "please hold" and then, at once, the overflow:
    // they are answered as any open-route caller nobody can take (the call-back message, or the
    // route's voicemail), and never recorded.
    const nobodyCanTake = mayConnect && route !== null && !(await this.anyoneCouldTake(arrival.tenantId, accountId, route));
    const connectable = mayConnect && !nobodyCanTake;
    const recorded = connectable && route !== null && route.record_calls && await this.allowsRecording(arrival.tenantId, accountId);

    const arrived = await withTransaction(async (client) => {
      let underCap = true;
      if (route) {
        await agencyInboundAnswerRepository.lockRouteAdmission(route.id, client);
        underCap = await agencyInboundAnswerRepository.countLiveAdmittedOnRoute(route.id, client) < route.max_concurrent;
      }
      const inserted = await agencyInboundCallRepository.insertArrival({
        tenantId: arrival.tenantId, accountId, routeId: route?.id ?? null, phoneNumberId, provider: arrival.provider,
        telephonyCredentialId: arrival.credentialId, providerCallId: arrival.carrierCallId,
        fromE164: arrival.fromE164, toE164: arrival.toE164, identification, answered: true,
        // A call no agent can take is never recorded (a recording starts at the bind, §6): nor is
        // one over the route's `max_concurrent`, which hears "busy" (and one the bridge's shared
        // scopes turn away has the flag taken back with its admission, `refuseAdmission`).
        recordingRequested: recorded && underCap, analysisProfileId: route?.analysis_profile_id ?? null,
        closedCause,
      }, { client });
      if (!inserted.call) return null;
      if (inserted.created && underCap) {
        const moved = await agencyInboundCallRepository.transition(inserted.call.id, 'greeting', {}, { client });
        return { created: true, call: moved ?? inserted.call, admitted: true };
      }
      return { created: inserted.created, call: inserted.call, admitted: inserted.created ? false : inserted.call.state !== 'arrived' };
    }, { pool: getPool() });
    if (!arrived) return this.refuseForeign(arrival);
    const { created, call, admitted } = arrived;

    if (!created && call.state === 'ended') return { kind: 'hangup' };
    const legId = call.webrtc_call_id;
    if (!legId) {
      log.error({ inboundCallId: call.id }, 'Inbound call with an account and no media leg — ending it failed');
      await this.settle(call, 'failed');
      return { kind: 'fallback' };
    }
    // Turned away at the route's `max_concurrent`: "all lines are busy". Not under the kill switch
    // (SWE-F4): a switched-off account's caller is told the route is closed whatever its load
    // (spoken by the carrier, nothing streams, so no capacity is used), and ends `closed`.
    if (!admitted && !switchedOff) planned = 'overflow_no_capacity';

    if (signal?.aborted) {
      // Written, then given up on: the caller heard the fallback. No stream is taken.
      await this.endLeg(legId, { status: 'failed', outcome: 'inbound_answer_timed_out', error_code: 'INBOUND_ANSWER_TIMED_OUT' });
      await this.settle(call, 'failed');
      return { kind: 'fallback' };
    }

    // The caller hung up while this answer was deciding, before the row existed (QA-F4): the call
    // ends now as the caller who left (`outcomeAfterPlayback`'s early hangup: an open route's caller
    // `abandoned_in_queue`, the closed and busy reasons kept), with its follow-up. No stream
    // promised, no slot held. A hangup that lands once the row exists, while this answer is still
    // taking its stream, is the hangup webhook's to settle (`ended`: `abandoned_in_queue`, whatever
    // the plan); this answer's own settle below is then a no-op (SWE-N1).
    if (this.tookEarlyHangup(arrival)) {
      await this.endLeg(legId, { status: 'completed', outcome: 'inbound_caller_hung_up' });
      await this.settle(call, outcomeAfterPlayback(planned, 'aborted', true));
      return { kind: 'hangup' };
    }

    // A caller who may queue is put through. A caller nobody will take leaves a voicemail when the
    // route's action for their case says so (§7): after hours, or an open route's caller nobody can
    // be put through to; its prompt is {@link voicemailPrompt}'s (the message's recording, else our
    // standard prompt; our neutral one for a caller who may not be promised a callback). Any other
    // caller only hears the message: with no recording of the route's for it, the carrier speaks
    // it and the call ends here with its follow-up (no stream, no session, no slot).
    const queue = connectable && admitted;
    if (nobodyCanTake && admitted) {
      trackInboundOverflow('no_agents');
      log.info({ inboundCallId: call.id }, 'Nobody in the pool could take this inbound caller — answered with the overflow action, not queued');
    }
    const unconnectedCase: InboundUnconnectedCase | null = planned === 'overflow' ? 'overflow' : planned === 'closed' && afterHours ? 'closed' : null;
    let messageSlot = messageSlotFor(planned, call);
    const prompt = voicemailPrompt(route, messageSlot, call);
    const voicemail = !queue && unconnectedCase !== null
      && takesVoicemail(route, unconnectedCase, voicemailAvailable({ storage: this.deps.voicemailStorage }));
    if (!queue && !voicemail && (switchedOff || !routeClipId(route, messageSlot))) {
      await this.endLeg(legId, { status: 'completed', outcome: `inbound_${planned}` });
      await this.settle(call, planned);
      return { kind: 'spoken', message: spokenMessageFor(planned, call) };
    }

    const accepted = await this.deps.bridge.acceptInboundCall({
      callId: legId,
      correlationId: call.id,
      tenantId: arrival.tenantId,
      accountId,
      provider: arrival.provider,
      telephonyCredentialId: arrival.credentialId,
      callerId: arrival.toE164,
      destinationPhone: arrival.fromE164 ?? '',
      carrierCallId: arrival.carrierCallId,
      takeSlots: admitted,
      // A caller who may queue is parked for an agent's station (the header); every other caller
      // only hears a message, so nothing is parked or recorded.
      connectable: queue,
      browserCloseGraceMs: queue ? DEFERRED_HANGUP_MS : 0,
      // A voicemail's floor: the prompt and the whole recording, whatever the account's ceiling.
      parkedSeconds: queue && route ? parkedSecondsFor(route) : voicemail ? INBOUND_VOICEMAIL_BUDGET_SECONDS : 0,
      record: queue && recorded,
    });
    if (!accepted.accepted) {
      if (accepted.reason === 'ended') return { kind: 'hangup' };
      await this.endLeg(legId, { status: 'failed', outcome: 'inbound_stream_unavailable', error_code: 'INBOUND_STREAM_UNAVAILABLE' });
      await this.settle(call, 'failed');
      return { kind: 'fallback' };
    }
    if (accepted.capacity === 'no_capacity') {
      // The global or the carrier's scope is full and no slot was taken: the call is no admitted
      // call of the route's or the account's (IB5). It hears "busy": the route's recording, else
      // ours (the stream is already promised; never silence).
      if (created && admitted) await agencyInboundCallRepository.refuseAdmission(call.id);
      messageSlot = 'busy';
      planned = 'overflow_no_capacity';
    }

    // The hangup came while the stream was being taken (it found the row, ended it, and nothing
    // played yet): the session just taken is let go now, not at the media deadline.
    if (!this.live.has(call.id) && this.tookEarlyHangup(arrival)) {
      await this.deps.bridge.forceEndWithOutcome(call.id, 'inbound_caller_hung_up').catch(() => false);
      await this.settle(call, outcomeAfterPlayback(planned, 'aborted', true));
      return { kind: 'hangup' };
    }

    // A retried answer for a call already playing: the same stream, and no second sequence.
    if (!this.live.has(call.id)) {
      if (queue && accepted.capacity !== 'no_capacity' && route) {
        this.hold(call, route, stickyCandidates, recorded && route.recording_notice);
        // Held first, so a ringing dial to this caller can hand its agent this very call.
        this.supersedeRingingDial(call);
      } else if (voicemail && accepted.capacity !== 'no_capacity' && unconnectedCase && route) {
        this.voicemail(call, unconnectedCase, ['greeting', prompt], route);
      } else {
        this.play(call, planned, ['greeting', withStandard(messageSlot)], route);
      }
    }
    return { kind: 'stream', callId: legId, streamUrl: accepted.streamUrl, maxDurationSeconds: accepted.maxDurationSeconds };
  }

  async ended(hangup: InboundCallHangup): Promise<{ legId: string | null }> {
    const call = await agencyInboundCallRepository.findByProviderCallId(hangup.provider, hangup.carrierCallId);
    if (!call) {
      // No row yet: the answer may still be deciding (QA-F4). Remembered for it, under the
      // credential and tenant that verified this hangup, so only that answer can read it.
      this.noteEarlyHangup(hangup);
      log.info({ credentialId: hangup.credentialId }, 'Inbound hangup before its answer wrote the call — remembered for the answer');
      return { legId: null };
    }
    if (call.tenant_id !== hangup.tenantId || call.telephony_credential_id !== hangup.credentialId) {
      log.warn({ credentialId: hangup.credentialId }, 'Inbound hangup for a call this credential never answered — ignoring');
      return { legId: null };
    }
    const key = carrierKey(call.provider, call.provider_call_id);
    const live = this.live.get(call.id);
    if (live) {
      // The play loop owns the call: it ends it when the stream goes (which the bridge is told next).
      live.callerHungUp = true;
    } else {
      // Not being played to: a caller who hung up before we put them anywhere, or one the fallback
      // answered (`settle` leaves that one no follow-up, and its outcome is `failed`). Remembered
      // too, for an answer that wrote the row and is still taking its stream.
      if (call.state !== 'ended') {
        await this.settle(call, this.givenUp.has(key) ? 'failed' : 'abandoned_in_queue');
        this.noteEarlyHangup(hangup);
      }
      this.givenUp.delete(key);
    }
    return { legId: call.webrtc_call_id };
  }

  /**
   * The startup and periodic sweep (§10): every call not ended that started before `olderThan`
   * ends (`sweepStale`: bridged → `answered`, else `failed` with its Missed row: we lost the
   * caller, QA-F9), and
   * each one that reached nobody gets its callback booked here. Batches of `batch` until none is
   * left. Returns how many calls it ended.
   */
  async sweep(olderThan: Date, batch = 200): Promise<number> {
    let total = 0;
    for (;;) {
      const ended = await agencyInboundCallRepository.sweepStale(olderThan, batch);
      for (const call of ended) {
        trackInboundCallEnded(call.outcome ?? 'failed');
        if (call.follow_up_status === null) continue;
        try {
          const owed = await this.callbackOwed(call);
          if (!owed) continue;
          await withTransaction(async (client, tx) => {
            const booked = await agencyContactRepository.bookInboundCallback({ tenantId: call.tenant_id, contactId: owed.contactId, dueAt: owed.dueAt }, { client });
            if (booked && !await agencyInboundAnswerRepository.setCallbackDueAt(call.id, booked.dueAt, client)) await tx.rollback();
          }, { pool: getPool() });
        } catch (err) {
          log.error({ err, inboundCallId: call.id }, 'Could not book the callback of a swept inbound call');
        }
      }
      total += ended.length;
      if (ended.length < batch) return total;
    }
  }

  // ── The connector's exits (P2: `InboundCallExits`) ─────────────────────────

  /**
   * End an unconnected call the connector held as `end` (an outcome, or a voicemail with its
   * recording), with its Missed row and callback: `settle`, the one writer of every unconnected
   * end. An answer given up on (its caller heard the fallback) ends `failed` with no follow-up,
   * as everywhere else.
   */
  async settleCall(call: AgencyInboundCallRecord, end: AgencyInboundCallOutcome | InboundCallEnd): Promise<void> {
    const givenUp = this.givenUp.has(carrierKey(call.provider, call.provider_call_id));
    await this.settle(call, givenUp ? 'failed' : end);
  }

  /**
   * A queued caller reached nobody: the hold stops and the route's overflow action runs. The
   * message is "we'll call you back", or for a caller who may not be promised a callback (withheld,
   * DNC: {@link messageSlotFor}) the busy one ("…try again shortly"). Never silence: with no
   * recording of the route's for it, our standard recording plays.
   *  - `callback` (IB3's default): the message plays and the call is put down
   *    (`playClipSequenceThenHangUp`).
   *  - `voicemail` (§7): the prompt ({@link voicemailPrompt}: the message's recording, else our
   *    standard voicemail prompt; our neutral prompt for a caller who may not be promised a
   *    callback), then the beep, then up to 120 s recorded ({@link voicemailEnd}).
   * The outcome is `overflow` once decided, even if the caller hangs up during the message (the
   * reason stays, as P1's closed message keeps its reason), `voicemail` when one was left;
   * `failed` only when the stream was lost with no hangup from the caller.
   */
  async overflow(call: AgencyInboundCallRecord, route: AgencyInboundRouteRecord): Promise<InboundCallEnd> {
    this.deps.bridge.stopInboundHold(call.id);
    const slot = messageSlotFor('overflow', call);
    if (takesVoicemail(route, 'overflow', voicemailAvailable({ storage: this.deps.voicemailStorage }))) {
      return this.voicemailEnd(call, 'overflow', route, [voicemailPrompt(route, slot, call)]);
    }
    let result: ClipSequenceResult = 'not_found';
    try {
      const clipHashes = await resolveInboundClips(route, [withStandard(slot)], { tenantId: route.tenant_id, accountId: route.account_id });
      result = await this.deps.bridge.playClipSequenceThenHangUp(call.id, { clipHashes, outcome: 'inbound_overflow' });
    } catch (err) {
      log.error({ err, inboundCallId: call.id }, 'Inbound overflow message failed');
    }
    if (result === 'completed' || result === 'aborted') return { outcome: 'overflow' };
    return { outcome: this.live.get(call.id)?.callerHungUp ? 'overflow' : 'failed' };
  }

  /**
   * The connector's clips for `slots` (the preamble: greeting and recording notice; the hold), as
   * hashes (`inbound-clips.ts`: never throws). Each slot the route leaves unset, or whose recording
   * cannot be played, plays our standard recording for it (`AGENCY_INBOUND_SLOT_STANDARD`): "please
   * hold" for the greeting, the recording notice (IB7: a recorded call is never recorded unannounced
   * while the route's notice switch is on); the hold has none (the built-in hold tone plays).
   */
  clips(route: AgencyInboundRouteRecord, slots: readonly AgencyInboundClipSlot[]): Promise<string[]> {
    return resolveInboundClips(
      route,
      slots.map((slot) => ({ slot, standard: AGENCY_INBOUND_SLOT_STANDARD[slot] })),
      { tenantId: route.tenant_id, accountId: route.account_id },
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Whether anyone in the caller's pool could take them now or once their current work ends: the
   * connector's answer ({@link InboundConnector.couldAnyoneTake}, the rule its queue applies). A
   * read that fails is yes: the caller queues and the connector asks again.
   */
  private async anyoneCouldTake(tenantId: string, accountId: string, route: AgencyInboundRouteRecord): Promise<boolean> {
    const connector = this.deps.connect?.connector;
    if (!connector) return true;
    try {
      return await connector.couldAnyoneTake({ tenantId, accountId, route });
    } catch (err) {
      log.warn({ err, tenantId, accountId }, 'Could not read who could take an inbound caller — queueing them');
      return true;
    }
  }

  /** Whether this account's callers may be put through to agents now (the header). */
  private async mayConnect(tenantId: string, accountId: string): Promise<boolean> {
    const connect = this.deps.connect;
    if (!connect?.connector) return false;
    if (connect.mediaWorkers > 0) {
      if (!this.warnedWorkers) {
        this.warnedWorkers = true;
        log.warn({ mediaWorkers: connect.mediaWorkers }, 'Inbound callers are not put through to agents with media workers on (IB8): every open route answers with the call-back message');
      }
      return false;
    }
    try {
      return await connect.enabled(tenantId, accountId);
    } catch (err) {
      log.warn({ err, tenantId, accountId }, 'Could not read agency_inbound_enabled — answering the call as P1');
      return false;
    }
  }

  /**
   * The kill switch (§8.1): whether the account's `agency_inbound_enabled` is off. Only with the
   * P2 gate wired (`connect`, as `startInboundCalls` always does); a read that fails is not off
   * (the call is answered as P1, with no agent connected: `mayConnect` reads the flag too).
   */
  private async switchedOff(tenantId: string, accountId: string): Promise<boolean> {
    const connect = this.deps.connect;
    if (!connect) return false;
    try {
      return !(await connect.enabled(tenantId, accountId));
    } catch (err) {
      log.warn({ err, tenantId, accountId }, 'Could not read agency_inbound_enabled — answering the call as if inbound were on');
      return false;
    }
  }

  /** The account's recording ceiling (`allow_recording`, NULL is not allowed). A read that fails records nothing. */
  private async allowsRecording(tenantId: string, accountId: string): Promise<boolean> {
    return (await accountSettingsRepository.getAllowRecording(tenantId, accountId).catch((err: unknown) => {
      log.warn({ err, tenantId, accountId }, 'Could not read allow_recording — the inbound call is not recorded');
      return null;
    })) === true;
  }

  /** Hand a `queue` call to the connector, which holds it until it ends (in the background). */
  private hold(
    call: AgencyInboundCallRecord,
    route: AgencyInboundRouteRecord,
    stickyCandidates: Array<{ userId: string; reason: AgencyInboundStickyReason }>,
    recordingNotice: boolean,
  ): void {
    const connector = this.deps.connect!.connector!;
    const live: LiveInboundCall = { planned: 'queue', callerHungUp: false };
    this.live.set(call.id, live);
    const run = connector.take({ call, route, stickyCandidates, recordingNotice })
      .catch((err: unknown) => log.error({ err, inboundCallId: call.id }, 'Inbound connector failed a call'))
      .finally(() => {
        this.live.delete(call.id);
        if (live.callerHungUp) this.givenUp.delete(carrierKey(call.provider, call.provider_call_id));
      });
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
  }

  /**
   * The in-flight clash (docs/inbound.md §5.4, Q7, Q8): a paced dial still ringing this caller's
   * number on the call's account is cancelled, and its agent, who has the customer's panel, is
   * handed this call. Only for a call the connector holds (the `queue` plan: someone can take it).
   * Synchronous from the dialer's read to the cancel, so the dial cannot be answered in between:
   *  1. the ringing dial (`findRingingAttemptTo`); on a carrier that cannot cancel ringing
   *     (VoiceLink) nothing is cancelled and the caller queues normally (Q7);
   *  2. the call promised to its session (`expectHandover`: no other agent is offered it);
   *  3. the dial superseded (`supersedeForInbound`: marked, `forceEndWithOutcome(…, 'canceled')`).
   * The dialer's `ended` arm settles it (`canceled`, the code `inbound_call`, the contact back
   * uncharged, released `inbound_call`) and releases the agent, whose release hook takes them for
   * this call; then `clash_attempt_id` is stamped. A dial not cancelled after all (answered first,
   * or gone) drops the hand-over and the caller queues normally.
   *
   * The soft phone's manual dial to the same number is left alone (decided): a soft-phone session
   * can never take an inbound reservation (it is on the `soft_phone` break, §4.3; pickups from the
   * soft phone are P3), so cancelling the agent's own dial would leave both with nothing; the
   * caller queues for the team and the manual dial meets a busy line as it would.
   */
  private supersedeRingingDial(call: AgencyInboundCallRecord): void {
    const connect = this.deps.connect;
    const dialer = connect?.dialer;
    const connector = connect?.connector;
    if (!dialer || !connector || !call.from_e164 || !call.account_id) return;
    const ringing = dialer.findRingingAttemptTo(call.tenant_id, call.account_id, call.from_e164);
    if (!ringing) return;
    if (!ringing.cancelsRinging) {
      log.info({ inboundCallId: call.id, attemptId: ringing.attemptId }, 'Customer rang in while a dial to them rings on a carrier that cannot cancel it — queued normally (Q7)');
      return;
    }
    const sessionId = ringing.sessionId;
    if (!connector.expectHandover(sessionId, call.id)) return;
    const superseded = dialer.supersedeForInbound(ringing.attemptId, {
      inboundCallId: call.id,
      settled: (cancelled) => {
        connector.dropHandover(sessionId);
        if (!cancelled) return;
        void agencyInboundCallRepository.setClashAttempt(call.id, ringing.attemptId)
          .catch((err: unknown) => log.warn({ err, inboundCallId: call.id }, 'Could not record the dial this inbound call superseded'));
      },
    });
    if (!superseded) connector.dropHandover(sessionId);
  }

  /**
   * After hours or from an open route nobody can be put through to (the P1 plan), the route's
   * action is a voicemail (§7): the greeting and the plan's message as the prompt, the beep, the
   * recording ({@link voicemailEnd}), then the call settled. In the background, held in `live`
   * as `play` is.
   */
  private voicemail(
    call: AgencyInboundCallRecord,
    which: InboundUnconnectedCase,
    slots: readonly InboundClipPart[],
    route: AgencyInboundRouteRecord,
  ): void {
    const live: LiveInboundCall = { planned: which, callerHungUp: false };
    this.live.set(call.id, live);
    const run = (async () => {
      const key = carrierKey(call.provider, call.provider_call_id);
      try {
        const end = await this.voicemailEnd(call, which, route, slots);
        await this.settle(call, this.givenUp.has(key) ? 'failed' : end);
      } catch (err) {
        log.error({ err, inboundCallId: call.id }, 'Could not settle an inbound voicemail call — the sweep will');
      } finally {
        this.live.delete(call.id);
        if (live.callerHungUp) this.givenUp.delete(key);
      }
    })();
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
  }

  /**
   * Take a voicemail after `slots` (`inbound-voicemail.ts`) and answer how the call ends: a
   * voicemail (outcome `voicemail`, its key and length, the Missed reason of the case that took
   * it); a caller who left before speaking: the case's own outcome (`closed` / `overflow`), no
   * voicemail; no media to record from: `failed`, unless the caller hung up first.
   */
  private async voicemailEnd(
    call: AgencyInboundCallRecord,
    which: InboundUnconnectedCase,
    route: AgencyInboundRouteRecord,
    slots: readonly InboundClipPart[],
  ): Promise<InboundCallEnd> {
    const prompt = await resolveInboundClips(route, slots, { tenantId: route.tenant_id, accountId: route.account_id });
    const taken = await takeVoicemail(
      { bridge: this.deps.bridge, ...(this.deps.voicemailStorage ? { storage: this.deps.voicemailStorage } : {}) },
      { id: call.id, tenant_id: call.tenant_id, account_id: call.account_id ?? route.account_id },
      prompt,
    );
    switch (taken.kind) {
      case 'kept':
        return { outcome: 'voicemail', voicemail: { key: taken.key, seconds: taken.seconds, reason: which } };
      case 'none':
        return { outcome: which };
      case 'lost':
        return { outcome: this.live.get(call.id)?.callerHungUp ? which : 'failed' };
    }
  }

  /** Play `slots` (the greeting and the plan's message), then settle the call from how the sequence ended. In the background. */
  private play(
    call: AgencyInboundCallRecord,
    planned: PlannedOutcome,
    slots: readonly InboundClipPart[],
    route: AgencyInboundRouteRecord | null,
  ): void {
    const live: LiveInboundCall = { planned, callerHungUp: false };
    this.live.set(call.id, live);
    const run = (async () => {
      let result: ClipSequenceResult = 'not_found';
      try {
        const clipHashes = route
          ? await resolveInboundClips(route, slots, { tenantId: route.tenant_id, accountId: route.account_id })
          : [];
        result = await this.deps.bridge.playClipSequenceThenHangUp(call.id, { clipHashes, outcome: `inbound_${planned}` });
      } catch (err) {
        log.error({ err, inboundCallId: call.id }, 'Inbound messages failed');
      }
      const key = carrierKey(call.provider, call.provider_call_id);
      try {
        // An answer given up on after its stream was promised: the caller heard the fallback.
        await this.settle(call, this.givenUp.has(key) ? 'failed' : outcomeAfterPlayback(planned, result, live.callerHungUp));
      } catch (err) {
        // The sweep ends it if this could not (the spine is durable).
        log.error({ err, inboundCallId: call.id }, 'Could not settle an inbound call — the sweep will');
      } finally {
        this.live.delete(call.id);
        // The hangup came while this call was played to, so `ended` left the mark to this loop.
        if (live.callerHungUp) this.givenUp.delete(key);
      }
    })();
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
  }

  /**
   * End the call as `outcome` with its follow-up, once (the spine's terminal guard), and book its
   * callback in the same transaction: a call another writer already ended is rolled back whole, so
   * it books nothing twice.
   */
  private async settle(call: AgencyInboundCallRecord, end: AgencyInboundCallOutcome | InboundCallEnd): Promise<void> {
    const { outcome, voicemail = null } = typeof end === 'string' ? { outcome: end } : end;
    // A caller the fallback answered was told to try again: no Missed row and no callback (§3.3).
    const reason = this.givenUp.has(carrierKey(call.provider, call.provider_call_id)) ? null : missedReasonFor(end);
    const followUp = reason ? { reason, assigneeUserId: call.sticky_user_id } : null;
    let ended: boolean;
    try {
      ended = await this.writeEnd(call, outcome, followUp, voicemail);
    } catch (err) {
      // Not written (the sweep ends the call, with no voicemail): no row will name the object,
      // so nothing would ever play or purge it. Best-effort, then the caller logs the failure.
      if (voicemail) await discardVoicemail({ storage: this.deps.voicemailStorage }, voicemail.key);
      throw err;
    }
    if (ended) {
      trackInboundCallEnded(outcome);
      log.info({ inboundCallId: call.id, outcome }, 'Inbound call ended');
    } else if (voicemail) {
      // Another writer ended the call first: no row names this voicemail, so nothing would ever
      // play or purge it.
      await discardVoicemail({ storage: this.deps.voicemailStorage }, voicemail.key);
    }
  }

  /** {@link settle}'s write: the callback booked and the call ended in one transaction. False: another writer ended it first. */
  private async writeEnd(
    call: AgencyInboundCallRecord,
    outcome: AgencyInboundCallOutcome,
    followUp: { reason: AgencyInboundMissedReason; assigneeUserId: string | null } | null,
    voicemail: InboundCallEnd['voicemail'],
  ): Promise<boolean> {
    const owed = followUp ? await this.callbackOwed(call) : null;
    return withTransaction(async (client, tx) => {
      const booked = owed
        ? await agencyContactRepository.bookInboundCallback({ tenantId: call.tenant_id, contactId: owed.contactId, dueAt: owed.dueAt }, { client })
        : null;
      const res = await agencyInboundCallRepository.end(call.id, {
        outcome, talkSeconds: null, followUp, callbackDueAt: booked?.dueAt ?? null,
        voicemailKey: voicemail?.key ?? null, voicemailSeconds: voicemail?.seconds ?? null,
      }, { client });
      if (!res.ended) {
        await tx.rollback();
        return false;
      }
      if (booked?.reopened) log.info({ inboundCallId: call.id, contactId: booked.contactId }, 'Inbound call reopened an exhausted contact as a callback (IB4)');
      return true;
    }, { pool: getPool() });
  }

  /**
   * The inbound callback a call's follow-up owes (§7), or null: a matched contact, a caller with a
   * number, not flagged DNC and not on the DNC registry now (re-checked; anything but `clear` owes
   * none, B8 fails closed), due at the route's next opening (`nextInboundOpening`; a call with no
   * route: now; a route that never opens: none, since null is never read as now). Whether the
   * contact takes it (campaign live, not terminal) is the booking's own check.
   */
  private async callbackOwed(call: AgencyInboundCallRecord): Promise<{ contactId: string; dueAt: Date } | null> {
    if (!call.matched_contact_id || !call.from_e164 || call.caller_dnc || !call.account_id) return null;
    const dnc = await this.deps.dnc.check(call.tenant_id, call.from_e164, { accountId: call.account_id, campaignId: call.matched_campaign_id });
    if (dnc !== 'clear') {
      if (dnc === 'unavailable') log.warn({ inboundCallId: call.id }, 'DNC check unavailable — no callback booked for this inbound call (fails closed)');
      return null;
    }
    const schedule: InboundRouteSchedule | null = call.route_id ? await agencyInboundAnswerRepository.findRouteSchedule(call.route_id) : null;
    const now = this.now();
    const dueAt = schedule ? nextInboundOpening(schedule, now) : now;
    if (!dueAt) {
      log.warn({ inboundCallId: call.id, routeId: call.route_id }, 'The route never opens — no callback booked for this inbound call');
      return null;
    }
    return { contactId: call.matched_contact_id, dueAt };
  }

  /**
   * Whether the caller is on DNC for the call's scope (§7): a DNC-suppressed matched contact, or
   * an entry for the match's campaign, else any of the account's, else tenant-wide. A withheld
   * caller is not. An unavailable registry flags nothing here; the follow-up re-checks and books no
   * callback (fails closed).
   */
  private async callerOnDnc(
    arrival: InboundCallArrival,
    accountId: string | null,
    match: { campaignId: string; suppressedReason: string | null } | null,
  ): Promise<boolean> {
    if (!arrival.fromE164) return false;
    if (match?.suppressedReason === 'dnc') return true;
    const scope = match
      ? { accountId, campaignId: match.campaignId }
      : accountId ? { accountId, everyCampaignOfAccount: true as const } : { accountId: null, campaignId: null };
    const entry = await this.deps.dnc.checkEntry(arrival.tenantId, arrival.fromE164, scope);
    return entry.result === 'suppressed';
  }

  /** A verified call to a number this credential does not answer: a `rejected` spine row, no Missed row. */
  private async reject(arrival: InboundCallArrival, phoneNumberId: string | null): Promise<void> {
    await withTransaction(async (client) => {
      const { call } = await agencyInboundCallRepository.insertArrival({
        tenantId: arrival.tenantId, accountId: null, routeId: null, phoneNumberId, provider: arrival.provider,
        telephonyCredentialId: arrival.credentialId, providerCallId: arrival.carrierCallId,
        fromE164: arrival.fromE164, toE164: arrival.toE164,
        identification: { match: null, callerDnc: false, sticky: null }, answered: false,
        recordingRequested: false, analysisProfileId: null,
      }, { client });
      if (!call) {
        this.refuseForeign(arrival);
        return;
      }
      const res = await agencyInboundCallRepository.end(call.id, {
        outcome: 'rejected', talkSeconds: null, followUp: null, callbackDueAt: null, voicemailKey: null,
      }, { client });
      if (res.ended) trackInboundCallEnded('rejected');
    }, { pool: getPool() });
  }

  /**
   * A carrier call id whose row belongs to another tenant or credential (`insertArrival`'s
   * `foreign`): nothing was written and nothing of that row is read or changed. Hung up; the log
   * names this credential and tenant only.
   */
  private refuseForeign(arrival: InboundCallArrival): InboundAnswerDecision {
    log.warn({ credentialId: arrival.credentialId, tenantId: arrival.tenantId },
      'Inbound answer naming a carrier call id another tenant or credential holds — refusing it, nothing written');
    return { kind: 'hangup' };
  }

  /** End an inbound media leg that never streamed (a spoken answer, a fault, an answer given up on). */
  private async endLeg(legId: string, end: { status: 'completed' | 'failed'; outcome: string; error_code?: string }): Promise<void> {
    await agencyCallRepository.update(legId, { ...end, ended_at: new Date() })
      .catch((err: unknown) => log.error({ err, legId }, 'Could not end the media leg of an inbound call that never streamed'));
  }

  private noteEarlyHangup(hangup: InboundCallHangup): void {
    const now = Date.now();
    // Oldest first: drop what has expired, and the oldest beyond the bound.
    for (const [key, seen] of this.hungUpEarly) {
      if (now - seen.at < INBOUND_EARLY_HANGUP_MS && this.hungUpEarly.size < GIVEN_UP_MAX) break;
      this.hungUpEarly.delete(key);
    }
    const key = carrierKey(hangup.provider, hangup.carrierCallId);
    this.hungUpEarly.delete(key);
    this.hungUpEarly.set(key, { tenantId: hangup.tenantId, credentialId: hangup.credentialId, at: now });
  }

  /** Whether `arrival`'s caller hung up while its answer was deciding (then forgotten): the same credential and tenant, in time. */
  private tookEarlyHangup(arrival: InboundCallArrival): boolean {
    const key = carrierKey(arrival.provider, arrival.carrierCallId);
    const seen = this.hungUpEarly.get(key);
    if (!seen || seen.tenantId !== arrival.tenantId || seen.credentialId !== arrival.credentialId) return false;
    this.hungUpEarly.delete(key);
    return Date.now() - seen.at < INBOUND_EARLY_HANGUP_MS;
  }

  private noteGivenUp(key: string): void {
    if (this.givenUp.size >= GIVEN_UP_MAX) this.givenUp.delete(this.givenUp.values().next().value!);
    this.givenUp.add(key);
  }
}
