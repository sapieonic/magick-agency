/**
 * Wrap-up redial: the agent, in wrap-up after a call that connected and before the
 * outcome is saved, redials the same customer and is connected to them again
 * (`POST /sessions/:id/redial`; the campaign's `allow_wrapup_redial`, off by default).
 *
 * It reuses the normal dial path rather than adding one: the pre-dial gates (calling
 * hours, DNC, number validity, all failing closed) mint the same clearance the pacing
 * tick's do, the dispatcher checks it, and `AgencyDialer.executeDial` places the call
 * exactly as it places a paced one. What differs is where the agent and the contact come
 * from:
 *
 *  - the agent is not taken from `available` but from `wrapup`, by a CAS of its own
 *    (`AgentStateMachine.reserveFromWrapup`), so a redial can never take an agent the
 *    pool or a break already has;
 *  - the contact is not claimed from `pending` but taken back from `connected`, only
 *    while it is still parked for this conversation
 *    (`AgencyAttemptRepository.beginWrapupRedial`, one transaction that also closes the
 *    wrapped-up attempt with the system code `redialed` and inserts the redial, linked
 *    by `redial_of_attempt_id`).
 *
 * ── Ordering: everything that can refuse runs before anything is written ──────────
 *
 * The row checks, the station, the caller ID and the gates come first, so a refusal
 * (DNC, a closed calling window, ...) leaves the agent exactly where they were: in
 * wrap-up, the countdown running, the outcome pad usable. Only then is the wrap-up
 * taken (`WrapupManager.takeForRedial`, which stops the countdown synchronously: auto
 * return can never fire while the redial rings or talks). From that point every failure
 * puts the agent back in wrap-up with a fresh window (none when an outcome is required),
 * never back in the pool with an outcome owed.
 *
 * The redial's own end is the dialer's: whatever its outcome, the customer stays held
 * for the outcome (`parkRedialContact`) and the agent lands in wrap-up again on the
 * redial attempt, with the redials its number leaves.
 *
 * ── Which dispatcher, with media workers ─────────────────────────────────────
 *
 * `runtime.dispatcher` of the process this runs in. With media workers the route is
 * `session_param` (`api/core-owners.ts`), so this runs in the worker holding the agent's
 * station, whose dispatcher is a `LocalDialDispatcher` over its own dialer: the
 * clearance and ownership checks hold (the station is this worker's), the account's
 * concurrency guard is the bridge's (shared through Redis), and pacing cannot take the
 * agent (Redis says `reserved`). It does NOT go through the primary's
 * `IpcDialDispatcher`, and that is deliberate, as for the soft phone's dials (also
 * placed in the owning worker, outside pacing): the leadership grant and its
 * `stillAuthorised` check answer "may PACING dial this campaign now", a question about
 * the tick's authority, and a redial is not the tick's decision but the agent's, about
 * a customer already in conversation. The campaign's own state is checked here instead
 * (`redialRefusalForAttempt`: running, setting on). The cost: a redial is outside the
 * IPC channel's `maxDialsInFlight` back-pressure, which bounds requests on the channel,
 * not calls (one redial per agent at most, each behind the concurrency guard).
 *
 * ── A refusal at the limit is recorded ───────────────────────────────────────
 *
 * Every `redial_limit_reached` answer (the row check, the live wrap-up's count, the take) adds
 * one to the campaign's pacing history for this minute (`redials_refused_at_limit`, IN2), a
 * single-row upsert from whichever process serves the request (`recordPacingEvent`). Best
 * effort: it never fails the answer.
 */
import { createChildLogger } from '@magick-agency/observability';
import {
  AGENCY_REDIALED_DISPOSITION_CODE,
  AGENCY_WRAPUP_REDIAL_LIMIT,
  type AgencyRedialResponse,
} from '@magick-agency/contracts/agency';
import {
  agencyAttemptRepository,
  agencyCampaignRepository,
  agencyContactRepository,
} from '../db/repositories/agency.repository.js';
import type { AgencyCallAttemptRecord, AgencyCampaignRecord } from '../db/models/agency.model.js';
import { AGENT_LEASE_MS, type AgentStateMachine } from './agent-state-machine.js';
import type { AgencyDialer } from './agency-dialer.js';
import type { ClearedDialCommand, DialDispatcher } from './dial-dispatcher.js';
import type { DncRegistry } from './dnc-registry.js';
import { evaluatePreDialGates, type PreDialDecision } from './pre-dial-gates.js';
import { pickCallerId, usableCallerIds } from './pacing/caller-id-pool.js';
import { RESERVING_MARKER } from './reserved-agent.js';
import type { StationRegistry } from './station-registry.js';
import type { WrapupManager, WrapupRedialRefusal } from './wrapup-manager.js';
import { REDIAL_MESSAGES, redialRefusalForAttempt, type RedialRefusal } from './wrapup-redial-rules.js';
import { recordPacingEvent } from './pacing/pacing-history.js';

const log = createChildLogger({ component: 'agency-wrapup-redial' });


export interface WrapupRedialDeps {
  agents: Pick<AgentStateMachine, 'reserveFromWrapup' | 'transition'>;
  wrapup: Pick<WrapupManager, 'stateFor' | 'takeForRedial' | 'finishRedial' | 'endTaken'>;
  stations: Pick<StationRegistry, 'ownerOf'>;
  dnc: DncRegistry;
  dispatcher: DialDispatcher;
  dialer: Pick<AgencyDialer, 'enterRedialWrapup' | 'releaseAgent' | 'releaseOwingOutcome' | 'abandonUndispatchedRedial'>;
}

/**
 * The statuses: 404 when the attempt is not this session's to redial (missing, another
 * session's, another tenant's: one answer, so a caller learns nothing about attempts
 * that are not theirs), 503 when the agent's state could not be read, 409 for every
 * other refusal. (400 for a malformed id is the route's.)
 */
export type WrapupRedialResult =
  | { ok: true; response: AgencyRedialResponse }
  | { ok: false; status: 404 | 409 | 503; code: RedialRefusal['code']; message: string };

function refuse(refusal: RedialRefusal, status: 404 | 409 | 503 = 409): WrapupRedialResult {
  return { ok: false, status: refusal.notFound ? 404 : status, code: refusal.code, message: refusal.message };
}

const NOT_YOURS: RedialRefusal = { code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_your_call, notFound: true };

/** A gate's refusal, as the agent is told it. `null` for `dial`. */
export function redialRefusalForGate(decision: PreDialDecision): RedialRefusal | null {
  switch (decision.action) {
    case 'dial':
      return null;
    case 'suppress':
      return decision.gate === 'dnc'
        ? { code: 'redial_blocked_dnc', message: REDIAL_MESSAGES.dnc }
        : { code: 'redial_blocked', message: REDIAL_MESSAGES.phone_invalid };
    case 'defer':
      return { code: 'redial_blocked_calling_hours', message: REDIAL_MESSAGES.calling_hours };
    case 'halt':
      return { code: 'redial_blocked', message: REDIAL_MESSAGES.dnc_unavailable };
  }
}

/** A refusal at the redial limit, recorded in the campaign's pacing history first. */
async function refuseAtLimit(
  campaign: Pick<AgencyCampaignRecord, 'id' | 'tenant_id'>,
  refusal: RedialRefusal,
): Promise<WrapupRedialResult> {
  await recordPacingEvent(campaign.id, campaign.tenant_id, 'redials_refused_at_limit');
  return refuse(refusal);
}

function refusalForTake(reason: WrapupRedialRefusal): RedialRefusal {
  switch (reason) {
    case 'limit_reached':
      return { code: 'redial_limit_reached', message: REDIAL_MESSAGES.limit };
    case 'disposition_submitted':
      return { code: 'disposition_already_submitted', message: REDIAL_MESSAGES.disposition_submitted };
    case 'not_offered':
      return { code: 'redial_not_allowed', message: REDIAL_MESSAGES.campaign_off };
    case 'not_in_wrapup':
      return { code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_in_wrapup };
  }
}

/**
 * Redial the customer of the wrap-up `sessionId` is in, for `attemptId`. The caller (the
 * route) has already established that the requester is the session's own agent.
 */
export async function startWrapupRedial(
  deps: WrapupRedialDeps,
  input: { sessionId: string; attemptId: string; actorUserId: string },
): Promise<WrapupRedialResult> {
  const { sessionId, attemptId } = input;

  // ── 1. The rows ───────────────────────────────────────────────────────────
  const attempt = await agencyAttemptRepository.findById(attemptId);
  // Before the campaign read, so another session's (or tenant's) attempt answers
  // exactly as a missing one does.
  if (!attempt || attempt.reserved_agent_id !== sessionId) return refuse(NOT_YOURS);
  const campaign = await agencyCampaignRepository.findById(attempt.campaign_id);
  if (!campaign) return refuse(NOT_YOURS);
  const rowRefusal = redialRefusalForAttempt(attempt, campaign, sessionId);
  if (rowRefusal) {
    return rowRefusal.code === 'redial_limit_reached' ? refuseAtLimit(campaign, rowRefusal) : refuse(rowRefusal);
  }

  // ── 2. The live wrap-up (peeked; taken only once nothing else can refuse) ─────
  const live = deps.wrapup.stateFor(sessionId);
  if (!live || live.attempt_id !== attemptId) {
    return refuse({ code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_in_wrapup });
  }
  if (live.disposition_submitted) {
    return refuse({ code: 'disposition_already_submitted', message: REDIAL_MESSAGES.disposition_submitted });
  }
  if (live.redial_remaining === undefined || live.redial_remaining === null) {
    // The campaign allows it (the row checks passed), so this wrap-up withheld it: no
    // outcome owed, or the last redial's dial outcome is unknown (the carrier may still
    // ring the customer).
    return refuse({ code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_offered });
  }
  if (live.redial_remaining <= 0) {
    return refuseAtLimit(campaign, { code: 'redial_limit_reached', message: REDIAL_MESSAGES.limit });
  }

  const contact = await agencyContactRepository.findById(attempt.contact_id);
  if (!contact || contact.state !== 'connected') {
    return refuse({ code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_held });
  }

  // ── 3. Where the call goes from: the station, then a caller ID ─────────────
  const ownerReplica = await deps.stations.ownerOf(sessionId);
  if (!ownerReplica) return refuse({ code: 'redial_blocked', message: REDIAL_MESSAGES.no_station });
  // The same number the customer just spoke to us from, while it is still usable.
  const pool = usableCallerIds(campaign);
  const callerId = pool.includes(attempt.caller_id) ? attempt.caller_id : pickCallerId(pool, 0);
  if (!callerId) return refuse({ code: 'redial_blocked', message: REDIAL_MESSAGES.no_caller_id });

  // ── 4. The pre-dial gates, last of the checks: the clearance they mint is short-lived
  //       (`CLEARANCE_MAX_AGE_MS`) and must survive to the dispatch. ─────────────
  const gate = await evaluatePreDialGates({ campaign, contact, now: new Date() }, { dnc: deps.dnc });
  const gateRefusal = redialRefusalForGate(gate);
  if (gateRefusal || gate.action !== 'dial') {
    log.info({ sessionId, attemptId, gate: gate.action === 'dial' ? null : gate.gate }, 'Wrap-up redial refused by the pre-dial gates');
    return refuse(gateRefusal ?? { code: 'redial_blocked', message: REDIAL_MESSAGES.dnc_unavailable });
  }

  // ── 5. Take the wrap-up: the countdown stops here, synchronously ────────────
  const take = deps.wrapup.takeForRedial(sessionId, attemptId);
  if (!take.ok) {
    const refusal = refusalForTake(take.reason);
    return refusal.code === 'redial_limit_reached' ? refuseAtLimit(campaign, refusal) : refuse(refusal);
  }
  const { taken } = take;

  // From here on, a refusal re-opens the wrap-up on the attempt it was taken from (a
  // fresh window, the redials its number leaves). When it cannot be reopened the agent
  // is held out of the pool (`releaseOwingOutcome`: `offline` with no station, else
  // `break`), never released to `available` with the outcome owed.
  const backToWrapup = async (): Promise<void> => {
    const reopened = await deps.dialer.enterRedialWrapup({
      sessionId, attemptId, campaignId: campaign.id, tenantId: campaign.tenant_id, campaign,
      redialNumber: attempt.redial_number,
    });
    if (!reopened) await deps.dialer.releaseOwingOutcome(sessionId);
  };

  // ── 6. The agent: wrapup → reserved ────────────────────────────────────────
  const reserved = await deps.agents.reserveFromWrapup(sessionId, RESERVING_MARKER);
  if (reserved !== 'reserved') {
    log.warn({ sessionId, attemptId, reserved }, 'Wrap-up redial could not reserve the agent — back to wrap-up');
    await backToWrapup();
    // `unavailable`: the agent state store did not answer, which is not "you left
    // wrap-up" and must not read as it.
    return reserved === 'unavailable'
      ? refuse({ code: 'redial_blocked', message: REDIAL_MESSAGES.state_unavailable }, 503)
      : refuse({ code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_in_wrapup });
  }
  // Undo the reservation, then reopen the wrap-up. The CAS is the normal path. When it
  // loses, the agent is no longer `reserved`: the 10s pre-dial lease lapsed, or the
  // station closed and wrote `offline` (nothing else writes over a reservation: pacing
  // reserves only from `available`, and `/available`, force-available and `/leave`
  // refuse while a redial is being set up). `enterRedialWrapup` then decides on the
  // station, not on the lost lease: a station still here gets its wrap-up back (`enter`
  // writes `wrapup`, which is exactly the state an agent owing an outcome belongs in),
  // a gone one is held `offline`.
  const unreserve = async (): Promise<void> => {
    const restored = await deps.agents.transition(sessionId, 'reserved', 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
    if (!restored) log.warn({ sessionId, attemptId }, 'Wrap-up redial reservation was lost before it could be undone');
    await backToWrapup();
  };

  // ── 7. The rows: close the wrapped-up attempt, take the customer back, insert ──
  let begun: Awaited<ReturnType<typeof agencyAttemptRepository.beginWrapupRedial>>;
  try {
    begun = await agencyAttemptRepository.beginWrapupRedial({
      redialOfAttemptId: attemptId,
      sessionId,
      actorUserId: input.actorUserId,
      callerId,
      disposition: AGENCY_REDIALED_DISPOSITION_CODE,
    });
  } catch (err) {
    log.error({ err, sessionId, attemptId }, 'Wrap-up redial could not be written — back to wrap-up');
    await unreserve();
    throw err;
  }
  if (!begun.ok) {
    if (begun.reason === 'disposition_already_submitted') {
      // The agent's disposition landed while the wrap-up was taken, so its
      // `noteDisposition` found nothing to end: the outcome is in, and the agent is
      // done. The taken wrap-up ends `disposition_submitted` (as `noteDisposition`
      // would have ended it), and the agent goes back to the pool (or their queued
      // break) through the one release path.
      deps.wrapup.endTaken(taken, 'disposition_submitted');
      await deps.agents.transition(sessionId, 'reserved', 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
      await deps.dialer.releaseAgent(sessionId);
      return refuse({ code: 'disposition_already_submitted', message: REDIAL_MESSAGES.disposition_submitted });
    }
    await unreserve();
    return refuse({ code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_held });
  }
  const redial = begun.attempt;
  deps.wrapup.finishRedial(taken);

  // ── 8. Dial, through the dispatcher like every dial ─────────────────────────
  const cmd = commandFor(redial, attempt, campaign, contact, ownerReplica, gate.clearance);
  log.info(
    { sessionId, attemptId: redial.id, redialOf: attemptId, redialNumber: redial.redial_number },
    'Wrap-up redial placed',
  );
  // Not awaited: the call's progress is the station socket's to report, and the HTTP
  // answer must not wait on the carrier. A dispatch the dispatcher refuses (an expired
  // clearance, a replica mismatch) never reaches `executeDial`; it is ended here and the
  // agent goes back to wrap-up, as for a dial that failed before the carrier.
  void deps.dispatcher.dispatch(cmd).catch(async (err) => {
    log.error({ err, attemptId: redial.id }, 'Wrap-up redial dispatch refused — back to wrap-up');
    await deps.dialer.abandonUndispatchedRedial(cmd).catch((e) =>
      log.error({ err: e, attemptId: redial.id }, 'Could not settle a refused wrap-up redial'));
  });

  return {
    ok: true,
    response: {
      session_id: sessionId,
      attempt_id: redial.id,
      redial_of_attempt_id: attemptId,
      redial_number: redial.redial_number,
      redial_remaining: Math.max(0, AGENCY_WRAPUP_REDIAL_LIMIT - redial.redial_number),
    },
  };
}

function commandFor(
  redial: AgencyCallAttemptRecord,
  original: AgencyCallAttemptRecord,
  campaign: AgencyCampaignRecord,
  contact: NonNullable<Awaited<ReturnType<typeof agencyContactRepository.findById>>>,
  ownerReplica: string,
  clearance: ClearedDialCommand['clearance'],
): ClearedDialCommand {
  return {
    attemptId: redial.id,
    campaignId: campaign.id,
    contactId: contact.id,
    sessionId: redial.reserved_agent_id!,
    ownerReplica,
    tenantId: campaign.tenant_id,
    accountId: campaign.account_id,
    callerId: redial.caller_id,
    attemptNumber: redial.attempt_number,
    campaign,
    contact: { ...contact, state: 'in_flight' },
    clearance,
    redial: { ofAttemptId: original.id, number: redial.redial_number },
  };
}
