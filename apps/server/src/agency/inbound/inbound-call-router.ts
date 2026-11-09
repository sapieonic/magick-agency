import type {
  AgencyInboundCallOutcome,
  AgencyInboundClipSlot,
  AgencyInboundMissedReason,
  AgencyInboundStickyReason,
} from '@magick-agency/contracts/agency';
import { AGENCY_INBOUND_ROUTE_DEFAULTS } from '@magick-agency/contracts/agency';
import { inboundScheduleState, nextInboundOpening } from '@magick-agency/domain/inbound-schedule';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { agencyCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { createChildLogger } from '@magick-agency/observability';
import { trackInboundCallEnded } from '@magick-agency/observability/metrics/agency';
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
  getInboundCallRouter,
  setInboundCallRouter,
  type InboundAnswerDecision,
  type InboundCallArrival,
  type InboundCallHangup,
  type InboundCallRouter,
} from '../../seams/inbound-call-router.js';
import { WEBRTC_MAX_DURATION_SECONDS } from '../../config/call-duration-limits.js';
import type { ClipSequenceResult, WebRtcBridgeManager } from '../../core/webrtc-bridge-manager.js';
import type { DncRegistry } from '../dnc-registry.js';
import { identifyInboundCaller } from './identify-caller.js';
import { resolveInboundClips } from './inbound-clips.js';

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
 *     (`inboundScheduleState`; `unresolvable` is closed), or no route at all → `closed`. Open → P1
 *     has no agents to connect, so the caller is told we will call back → `overflow`.
 *  5. Admission (IB5), in the transaction that writes the spine + leg (`insertArrival`): the
 *     route's live admitted calls are counted under the route's advisory lock; at its
 *     `max_concurrent` the call is turned away (`overflow_no_capacity`, stays `arrived`), else
 *     admitted (`greeting`). The bridge then takes the shared slots: over the account's own limit
 *     it is held anyway (IB5); with the global or carrier scope full it hears "all lines are busy"
 *     (`overflow_no_capacity`).
 *  6. The answer: our stream (principle 2). What the caller hears is played in the background
 *     ({@link AgencyInboundCallRouter.play}), after the carrier opens the stream.
 *
 * ── What the caller hears (P1) ───────────────────────────────────────────────────
 * `greeting` (if set), then `closed` / `callback` / `busy` per the plan, then the call is put down.
 * The recording notice (IB7) plays only before a call that is recorded; P1 records no inbound call
 * (nobody is connected, and a recording starts at the bridge, §6), so it never plays in P1. A slot
 * with no clip plays nothing (`inbound-clips.ts`: there is no built-in audio).
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
 * ── The follow-up (§7, IB3, IB4) ─────────────────────────────────────────────────
 * Every call that reached no one is a Missed row (`follow_up_status = 'open'`, its reason,
 * assignee the sticky agent if they can see the account, else the account). And, for a matched
 * contact not on DNC (re-checked, failing closed), an inbound callback on the contact
 * (`bookInboundCallback`: running or paused campaign, not terminal; exhausted is reopened) due at
 * the route's next opening (`nextInboundOpening`; a route that never opens books none, a call with
 * no route books one due now), in the transaction that ends the spine.
 */

/** What P1 tells an admitted caller, by plan: the clip slots in order. */
const PLAN_SLOTS: Record<PlannedOutcome, readonly AgencyInboundClipSlot[]> = {
  closed: ['greeting', 'closed'],
  overflow: ['greeting', 'callback'],
  overflow_no_capacity: ['greeting', 'busy'],
};

type PlannedOutcome = Extract<AgencyInboundCallOutcome, 'closed' | 'overflow' | 'overflow_no_capacity'>;

/** The Missed row's reason for an outcome that reached nobody; null for `answered` / `rejected`. */
export function missedReasonFor(outcome: AgencyInboundCallOutcome): AgencyInboundMissedReason | null {
  switch (outcome) {
    case 'answered':
    case 'rejected':
      return null;
    case 'voicemail':
      // P2 records voicemail; until then the reason is the action that led to it.
      return 'overflow';
    default:
      return outcome;
  }
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
  planned: PlannedOutcome;
  /** The carrier's hangup arrived while the messages were (to be) playing. */
  callerHungUp: boolean;
}

export interface AgencyInboundCallRouterDeps {
  bridge: Pick<WebRtcBridgeManager, 'acceptInboundCall' | 'playClipSequenceThenHangUp'>;
  dnc: Pick<DncRegistry, 'check' | 'checkEntry'>;
  now?: () => Date;
}

export class AgencyInboundCallRouter implements InboundCallRouter {
  private readonly live = new Map<string, LiveInboundCall>();
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

  async answer(arrival: InboundCallArrival): Promise<InboundAnswerDecision> {
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
    let sticky: { userId: string; reason: AgencyInboundStickyReason } | null = null;
    if (accountId && identity.candidates.length > 0) {
      const members = await agencyInboundAnswerRepository.filterAccountMembers(
        arrival.tenantId, accountId, identity.candidates.map((c) => c.userId));
      const first = identity.candidates.find((c) => members.has(c.userId));
      if (first) sticky = { userId: first.userId, reason: first.reason };
    }
    const identification = {
      match: match ? { contactId: match.contactId, campaignId: match.campaignId } : null,
      callerDnc,
      sticky,
    };

    if (accountId === null) {
      // The tenant default (§8.3): no account, so no leg and nothing to stream; the carrier speaks
      // the closed message. The Missed row is the tenant default's.
      const { call } = await agencyInboundCallRepository.insertArrival({
        tenantId: arrival.tenantId, accountId: null, routeId: null, phoneNumberId, provider: arrival.provider,
        telephonyCredentialId: arrival.credentialId, providerCallId: arrival.carrierCallId,
        fromE164: arrival.fromE164, toE164: arrival.toE164, identification, answered: true,
        recordingRequested: false, analysisProfileId: null,
      });
      if (call.state !== 'ended') await this.settle(call, 'closed');
      return { kind: 'closed' };
    }

    let planned: PlannedOutcome = arrival.credentialStatus !== 'active' || !route
      || inboundScheduleState(route, at) !== 'open' ? 'closed' : 'overflow';

    const { created, call, admitted } = await withTransaction(async (client) => {
      let underCap = true;
      if (route) {
        await agencyInboundAnswerRepository.lockRouteAdmission(route.id, client);
        underCap = await agencyInboundAnswerRepository.countLiveAdmittedOnRoute(route.id, client) < route.max_concurrent;
      }
      const inserted = await agencyInboundCallRepository.insertArrival({
        tenantId: arrival.tenantId, accountId, routeId: route?.id ?? null, phoneNumberId, provider: arrival.provider,
        telephonyCredentialId: arrival.credentialId, providerCallId: arrival.carrierCallId,
        fromE164: arrival.fromE164, toE164: arrival.toE164, identification, answered: true,
        // P1 records no inbound call: nobody is connected (a recording starts at the bridge, §6).
        recordingRequested: false, analysisProfileId: route?.analysis_profile_id ?? null,
      }, { client });
      if (inserted.created && underCap) {
        const moved = await agencyInboundCallRepository.transition(inserted.call.id, 'greeting', {}, { client });
        return { ...inserted, call: moved ?? inserted.call, admitted: true };
      }
      return { ...inserted, admitted: inserted.created ? false : inserted.call.state !== 'arrived' };
    }, { pool: getPool() });

    if (!created && call.state === 'ended') return { kind: 'hangup' };
    const legId = call.webrtc_call_id;
    if (!legId) {
      log.error({ inboundCallId: call.id }, 'Inbound call with an account and no media leg — ending it failed');
      await this.settle(call, 'failed');
      return { kind: 'fallback' };
    }
    if (!admitted) planned = 'overflow_no_capacity';

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
    });
    if (!accepted.accepted) {
      if (accepted.reason === 'ended') return { kind: 'hangup' };
      await agencyCallRepository.update(legId, {
        status: 'failed', outcome: 'inbound_stream_unavailable', error_code: 'INBOUND_STREAM_UNAVAILABLE', ended_at: new Date(),
      }).catch((err: unknown) => log.error({ err, legId }, 'Could not end the media leg of an inbound call with no stream'));
      await this.settle(call, 'failed');
      return { kind: 'fallback' };
    }
    if (accepted.capacity === 'no_capacity') planned = 'overflow_no_capacity';

    // A retried answer for a call already playing: the same stream, and no second sequence.
    if (!this.live.has(call.id)) this.play(call, planned, route);
    return { kind: 'stream', callId: legId, streamUrl: accepted.streamUrl, maxDurationSeconds: accepted.maxDurationSeconds };
  }

  async ended(hangup: InboundCallHangup): Promise<{ legId: string | null }> {
    const call = await agencyInboundCallRepository.findByProviderCallId(hangup.provider, hangup.carrierCallId);
    if (!call || call.tenant_id !== hangup.tenantId || call.telephony_credential_id !== hangup.credentialId) {
      log.warn({ credentialId: hangup.credentialId }, 'Inbound hangup for a call this credential never answered — ignoring');
      return { legId: null };
    }
    const live = this.live.get(call.id);
    if (live) {
      // The play loop owns the call: it ends it when the stream goes (which the bridge is told next).
      live.callerHungUp = true;
    } else if (call.state !== 'ended') {
      await this.settle(call, 'abandoned_in_queue');
    }
    return { legId: call.webrtc_call_id };
  }

  /**
   * The startup and periodic sweep (§10): every call not ended that arrived before `olderThan`
   * ends (`sweepStale`: bridged → `answered`, else `abandoned_in_queue` with its Missed row), and
   * each one that reached nobody gets its callback booked here. Batches of `batch` until none is
   * left. Returns how many calls it ended.
   */
  async sweep(olderThan: Date, batch = 200): Promise<number> {
    let total = 0;
    for (;;) {
      const ended = await agencyInboundCallRepository.sweepStale(olderThan, batch);
      for (const call of ended) {
        trackInboundCallEnded(call.outcome ?? 'abandoned_in_queue');
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

  // ── internals ──────────────────────────────────────────────────────────────

  /** Play the plan's messages, then settle the call from how the sequence ended. In the background. */
  private play(call: AgencyInboundCallRecord, planned: PlannedOutcome, route: AgencyInboundRouteRecord | null): void {
    const live: LiveInboundCall = { planned, callerHungUp: false };
    this.live.set(call.id, live);
    const run = (async () => {
      let result: ClipSequenceResult = 'not_found';
      try {
        const clipHashes = route
          ? await resolveInboundClips(route, PLAN_SLOTS[planned], { tenantId: route.tenant_id, accountId: route.account_id })
          : [];
        result = await this.deps.bridge.playClipSequenceThenHangUp(call.id, { clipHashes, outcome: `inbound_${planned}` });
      } catch (err) {
        log.error({ err, inboundCallId: call.id }, 'Inbound messages failed');
      }
      try {
        await this.settle(call, outcomeAfterPlayback(planned, result, live.callerHungUp));
      } catch (err) {
        // The sweep ends it if this could not (the spine is durable).
        log.error({ err, inboundCallId: call.id }, 'Could not settle an inbound call — the sweep will');
      } finally {
        this.live.delete(call.id);
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
  private async settle(call: AgencyInboundCallRecord, outcome: AgencyInboundCallOutcome): Promise<void> {
    const reason = missedReasonFor(outcome);
    const followUp = reason ? { reason, assigneeUserId: call.sticky_user_id } : null;
    const owed = followUp ? await this.callbackOwed(call) : null;
    const ended = await withTransaction(async (client, tx) => {
      const booked = owed
        ? await agencyContactRepository.bookInboundCallback({ tenantId: call.tenant_id, contactId: owed.contactId, dueAt: owed.dueAt }, { client })
        : null;
      const res = await agencyInboundCallRepository.end(call.id, {
        outcome, talkSeconds: null, followUp, callbackDueAt: booked?.dueAt ?? null, voicemailKey: null,
      }, { client });
      if (!res.ended) {
        await tx.rollback();
        return false;
      }
      if (booked?.reopened) log.info({ inboundCallId: call.id, contactId: booked.contactId }, 'Inbound call reopened an exhausted contact as a callback (IB4)');
      return true;
    }, { pool: getPool() });
    if (ended) {
      trackInboundCallEnded(outcome);
      log.info({ inboundCallId: call.id, outcome }, 'Inbound call ended');
    }
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
      const res = await agencyInboundCallRepository.end(call.id, {
        outcome: 'rejected', talkSeconds: null, followUp: null, callbackDueAt: null, voicemailKey: null,
      }, { client });
      if (res.ended) trackInboundCallEnded('rejected');
    }, { pool: getPool() });
  }
}

/** How often the periodic sweep runs (§10). */
export const INBOUND_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * The periodic sweep ends a call that arrived longer ago than this and has not ended: past the
 * longest any call may last (`WEBRTC_MAX_DURATION_SECONDS`, every session's max-duration timer
 * ends it before), with a margin, so it never ends a call a live session in this process still
 * holds. The startup sweep instead ends every call that arrived before this process started: no
 * session of the process that held it survives a restart (one replica; IB8).
 */
export const INBOUND_SWEEP_STALE_AFTER_MS = (WEBRTC_MAX_DURATION_SECONDS + 10 * 60) * 1000;

/**
 * Start inbound calls in this process (`bootstrap/agency.ts`): the startup sweep, THEN the router
 * registered on the seam (so no call this process answers can be swept as a leftover), then the
 * periodic sweep. The stop unregisters the router (arriving calls hear the fallback message) and
 * stops the sweep; calls still playing settle as their sessions end (the bridge's shutdown), and
 * the next start's sweep ends any that could not.
 */
export async function startInboundCalls(deps: AgencyInboundCallRouterDeps & { sweepIntervalMs?: number }): Promise<{
  router: AgencyInboundCallRouter;
  stop: () => void;
}> {
  const router = new AgencyInboundCallRouter(deps);
  const now = deps.now ?? (() => new Date());
  try {
    const swept = await router.sweep(now());
    if (swept > 0) log.warn({ swept }, 'Ended inbound calls left open by a restart');
  } catch (err) {
    log.error({ err }, 'Startup sweep of inbound calls failed — the periodic sweep retries');
  }
  setInboundCallRouter(router);
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    router.sweep(new Date(now().getTime() - INBOUND_SWEEP_STALE_AFTER_MS))
      .then((swept) => { if (swept > 0) log.warn({ swept }, 'Ended stale inbound calls'); })
      .catch((err: unknown) => log.error({ err }, 'Periodic sweep of inbound calls failed'))
      .finally(() => { sweeping = false; });
  }, deps.sweepIntervalMs ?? INBOUND_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return {
    router,
    stop: () => {
      clearInterval(timer);
      if (getInboundCallRouter() === router) setInboundCallRouter(null);
    },
  };
}
