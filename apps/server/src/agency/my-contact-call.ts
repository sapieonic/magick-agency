/**
 * The agent dials one of their own contacts now (`POST /proxy/agency/my-contacts/:contactId/call`,
 * contact assignment phase 2, decision CA7), on the campaign's NORMAL path: an attempt row, the
 * campaign's caller IDs, the pre-dial gates' clearance, the one dial dispatcher, and from there
 * exactly what a paced dial gets (the ringing panel, the bridge, recording, the outcome pad,
 * wrap-up and wrap-up redial, settlement by the retry policy). The attempt is marked
 * `agent_manual` and records the overrides the dial spent.
 *
 * It mirrors the pacing tick's dial sequence and the wrap-up redial's ordering
 * (`wrapup-redial.ts`): everything that can refuse runs BEFORE anything is written.
 *
 *  1. The rows: the campaign is running; the session is the caller's live session on it and
 *     `available`; the contact is the caller's on this campaign (`contact_not_found` for
 *     anything else, so another agent's contact is indistinguishable from a missing one).
 *  2. Why it may be dialled now (`chooseAgentDialBasis`): due; or `pending` holding a
 *     retry-delay override (spends it); or retry-eligible (`agentRetryBlockSql`, spends a
 *     round). Otherwise `contact_not_retryable` with the block.
 *  3. The pre-dial gates, fail-closed, with ONE narrow option: a closed calling window passes
 *     only when the contact holds an unspent calling-hours override AND the agent gave a
 *     valid note (`PreDialGateOptions.callingHoursOverride`). Phone validity and DNC apply
 *     exactly as on a paced dial, and DNC has no override, here or anywhere.
 *  4. The station's owner and a caller ID.
 *  5. The agent: `available → reserved` (the pacing tick's CAS; a tick that reserved them
 *     first wins, and this answers `agent_not_available`).
 *  6. The claim, with the spends, in ONE statement (`claimForAgentDial`): `pending` /
 *     `exhausted` → `in_flight`, `FOR UPDATE SKIP LOCKED`, one live call per number across the
 *     ACCOUNT (a number on a call on any of the account's running campaigns, a retry child or
 *     its parent included, is `contact_in_flight`; decisions MC4), the basis and the ownership
 *     re-checked on the locked row.
 *  7. The attempt (`agent_manual`, `override_applied`, `override_note`), then the dispatch.
 *
 * Every failure after step 5 undoes what was written, as the tick's release paths do: the agent
 * back to the pool (or their queued break), the contact back to the state and due time the claim
 * found with what it spent given back (`releaseAgentDialClaim`; for an attempt insert a unique
 * index refused, `releaseRefusedAgentDialClaim`, guarded by the claim's row version since the
 * attempt that refused it is live), an attempt that exists ended `failed`.
 *
 * ── Which process, with media workers ────────────────────────────────────────
 * The internal route is `session_param` (`api/core-owners.ts`), so this runs in the worker that
 * holds the agent's station, whose dispatcher is a `LocalDialDispatcher` over its own dialer, as
 * for the wrap-up redial and the soft phone: the dial is the agent's decision, not the pacing
 * tick's, so the tick's leadership grant is not asked; the campaign's own state is checked here.
 */
import { createChildLogger } from '@magick-agency/observability';
import { AGENCY_OVERRIDE_NOTE_MAX, AGENCY_OVERRIDE_NOTE_MIN, type AgencyOverrideKind } from '@magick-agency/contracts/agency';
import type {
  AgencyAgentRetryBlock,
  AgencyAgentRetryErrorCode,
  AgencyMyContactCallResponse,
} from '@magick-agency/contracts/api/agency/assignment';
import {
  agencyAgentRetryRepository,
  agencyAttemptRepository,
  agencyCampaignRepository,
  type AgentDialClaim,
  type AgentRetrySettings,
} from '../db/repositories/agency.repository.js';
import { agentRetrySettingsOf } from '../db/repositories/agency/assignment-sql.js';
import {
  isCampaignSession,
  type AgencyAgentSessionRecord,
  type AgencyCampaignRecord,
} from '../db/models/agency.model.js';
import type { AgentStateMachine } from './agent-state-machine.js';
import type { AgencyDialer } from './agency-dialer.js';
import type { DialDispatcher } from './dial-dispatcher.js';
import type { DncRegistry } from './dnc-registry.js';
import { evaluatePreDialGates } from './pre-dial-gates.js';
import type { DedicatedCallerIdCache } from './pacing/dedicated-caller-ids.js';
import { queuedBreakReleaseOf, RESERVING_MARKER, returnReservedAgent } from './reserved-agent.js';
import type { StationRegistry } from './station-registry.js';
import {
  chooseAgentDialBasis,
  validateOverrideNoteText,
  type AgentDialBasis,
  type AgentDialChoice,
} from './contact-overrides.js';

const log = createChildLogger({ component: 'agency-my-contact-call' });

export interface MyContactCallDeps {
  agents: Pick<AgentStateMachine, 'get' | 'reserve' | 'transition'>;
  /** A break queued while the agent was reserved is applied by the one release path. */
  breaks: { peek(sessionId: string): unknown };
  stations: Pick<StationRegistry, 'ownerOf'>;
  dnc: DncRegistry;
  dispatcher: DialDispatcher;
  dialer: Pick<AgencyDialer, 'releaseAgent'>;
  /** The dial paths' caller-ID rule over the cached dedications (the runtime's `dedications`). */
  callerIds: Pick<DedicatedCallerIdCache, 'callerIdForContact'>;
}

export interface MyContactCallInput {
  tenantId: string;
  accountId: string;
  /**
   * The caller's session, as the route's session guard read it (the caller's, in the tenant
   * and account, not left). Checked here for the campaign; not read again.
   */
  session: AgencyAgentSessionRecord;
  /** The caller: the session's agent and the contact's owner. */
  actorUserId: string;
  campaignId: string;
  contactId: string;
  overrideNote?: string | null;
}

export interface MyContactCallRefusal {
  status: 400 | 404 | 409 | 502 | 503;
  code: AgencyAgentRetryErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type MyContactCallResult =
  | { ok: true; response: AgencyMyContactCallResponse; basis: AgentDialBasis }
  | ({ ok: false } & MyContactCallRefusal);

/** The agent-facing copy of each refusal. */
export const MY_CONTACT_CALL_MESSAGES: Readonly<Record<AgencyAgentRetryErrorCode, string>> = {
  assignment_disabled: 'Contact assignment is not enabled for this account.',
  not_staffed: "You're not assigned to this campaign. Ask your supervisor to add you.",
  agent_retry_disabled: 'This campaign does not allow agents to retry their contacts.',
  contact_not_found: 'Contact not found.',
  contact_not_retryable: 'This contact cannot be called now.',
  contact_in_flight: 'This customer is already on a call.',
  campaign_not_running: 'The campaign is not running.',
  agent_not_available: 'Go available on this campaign to call a contact.',
  outside_calling_hours: 'The calling window for this contact is closed.',
  override_note_invalid: `Add a note of ${AGENCY_OVERRIDE_NOTE_MIN}–${AGENCY_OVERRIDE_NOTE_MAX} characters to call outside calling hours.`,
  dnc_listed: 'This number is on the do-not-call list.',
  dnc_unavailable: 'The do-not-call list could not be checked. Nothing was dialled; try again shortly.',
  no_caller_id: 'The campaign has no usable caller ID.',
  no_station: 'Your station is not connected. Reconnect and try again.',
  dial_failed: 'The call could not be placed. The contact is back in your list.',
  feature_disabled: 'The agency dialer is not enabled for this account.',
};

function refuse(
  status: MyContactCallRefusal['status'],
  code: AgencyAgentRetryErrorCode,
  details?: Record<string, unknown>,
): { ok: false } & MyContactCallRefusal {
  return { ok: false, status, code, message: MY_CONTACT_CALL_MESSAGES[code], ...(details ? { details } : {}) };
}

/** The refusal of a contact {@link chooseAgentDialBasis} found no basis to dial. */
function refusalOfChoice(choice: Extract<AgentDialChoice, { ok: false }>): { ok: false } & MyContactCallRefusal {
  return choice.reason === 'in_flight' ? refuse(409, 'contact_in_flight') : notRetryable(choice.blocked, choice.availableAt);
}

function notRetryable(blocked: AgencyAgentRetryBlock, availableAt: Date | null): { ok: false } & MyContactCallRefusal {
  return refuse(409, 'contact_not_retryable', {
    blocked,
    ...(availableAt ? { available_at: availableAt.toISOString() } : {}),
  });
}

/** The retry settings `agentRetryBlockSql` reads, from the campaign row (the route's import). */
export { agentRetrySettingsOf };

/** Dial `input.contactId` for its owner now. The route has checked the flag and the staffing. */
export async function startMyContactCall(
  deps: MyContactCallDeps,
  input: MyContactCallInput,
): Promise<MyContactCallResult> {
  const { session, actorUserId, contactId } = input;
  const sessionId = session.id;

  // ── 1. The rows ───────────────────────────────────────────────────────────
  // The campaign and the agent's live state are independent reads, started together and
  // judged in this order (a read that throws is rethrown in the same order).
  const [campaignRead, liveRead] = await Promise.allSettled([
    agencyCampaignRepository.findById(input.campaignId),
    deps.agents.get(sessionId),
  ]);
  if (campaignRead.status === 'rejected') throw campaignRead.reason;
  const campaign = campaignRead.value;
  if (!campaign || campaign.tenant_id !== input.tenantId || campaign.account_id !== input.accountId) {
    return refuse(404, 'contact_not_found');
  }
  if (campaign.status !== 'running') return refuse(409, 'campaign_not_running');

  if (session.tenant_id !== input.tenantId || session.account_id !== input.accountId
    || session.agent_user_id !== actorUserId || session.left_at || !isCampaignSession(session)
    || session.campaign_id !== campaign.id) {
    return refuse(409, 'agent_not_available');
  }
  if (liveRead.status === 'rejected') throw liveRead.reason;
  if (liveRead.value?.state !== 'available') return refuse(409, 'agent_not_available');

  const settings = agentRetrySettingsOf(campaign);
  const evaluated = await agencyAgentRetryRepository.evaluateForAgentDial({
    contactId, campaignId: campaign.id, userId: actorUserId, settings,
  });
  if (!evaluated) return refuse(404, 'contact_not_found');
  const { contact } = evaluated;

  // ── 2. Why it may be dialled now ──────────────────────────────────────────
  const choice = chooseAgentDialBasis(evaluated.facts);
  if (!choice.ok) return refusalOfChoice(choice);

  // ── 3. The pre-dial gates (last of the reads: the clearance is short-lived) ──
  const note = input.overrideNote === undefined || input.overrideNote === null
    ? null
    : validateOverrideNoteText(input.overrideNote);
  const gate = await evaluatePreDialGates(
    { campaign, contact, now: new Date() },
    { dnc: deps.dnc },
    { callingHoursOverride: { note } },
  );
  switch (gate.action) {
    case 'suppress':
      log.info({ sessionId, contactId, gate: gate.gate }, 'Agent dial refused by the pre-dial gates');
      return gate.gate === 'dnc' ? refuse(409, 'dnc_listed') : notRetryable('suppressed', null);
    case 'halt':
      return refuse(503, 'dnc_unavailable');
    case 'defer':
      if (gate.gate === 'calling_hours' && contact.override_calling_hours && note === null) {
        // The override is there to spend, but not without the agent's reason for it.
        return refuse(400, 'override_note_invalid', { min: AGENCY_OVERRIDE_NOTE_MIN, max: AGENCY_OVERRIDE_NOTE_MAX });
      }
      return refuse(409, 'outside_calling_hours', {
        next_open_at: gate.gate === 'calling_hours' ? gate.deferUntil.toISOString() : null,
      });
    case 'dial':
      break;
  }
  const spendCallingHours = gate.callingHoursOverridden === true;

  // ── 4. Where the call goes from ───────────────────────────────────────────
  // The contact's owner's dedicated number, else the rotation (DN2): the same rule as pacing.
  // The agent dials their own contact, so the owner is the agent. Both over the campaign's
  // DIALABLE caller IDs (PL13): a dedicated number its carrier account no longer has is not used.
  const [ownerReplica, callerId] = await Promise.all([
    deps.stations.ownerOf(sessionId),
    deps.callerIds.callerIdForContact(campaign, contact.assigned_user_id),
  ]);
  if (!ownerReplica) return refuse(503, 'no_station');
  if (!callerId) return refuse(409, 'no_caller_id');

  // ── 5. The agent: available → reserved ─────────────────────────────────────
  const reserved = await deps.agents.reserve(sessionId, RESERVING_MARKER);
  if (reserved !== 'reserved') return refuse(409, 'agent_not_available');
  const returnAgent = async (): Promise<void> => {
    try {
      // As the tick's return, but to the pool by a CAS from `reserved`.
      await returnReservedAgent(sessionId, queuedBreakReleaseOf(deps), async (id) => {
        const back = await deps.agents.transition(id, 'reserved', 'available');
        if (!back) log.warn({ sessionId }, 'Agent dial reservation was lost before it could be returned');
      });
    } catch (err) {
      log.error({ err, sessionId }, 'Could not return the agent after a refused agent dial');
    }
  };

  // ── 6. The claim, with the spends ─────────────────────────────────────────
  let claim: AgentDialClaim | null;
  try {
    claim = await agencyAgentRetryRepository.claimForAgentDial({
      contactId, campaignId: campaign.id, userId: actorUserId, basis: choice.basis, spendCallingHours, settings,
    });
  } catch (err) {
    await returnAgent();
    throw err;
  }
  if (!claim) {
    await returnAgent();
    return explainLostClaim(campaign, input, settings, spendCallingHours);
  }
  const giveBack = async (): Promise<void> => {
    await agencyAgentRetryRepository.releaseAgentDialClaim(contactId, claim!).catch((err) =>
      log.error({ err, contactId }, 'Could not give back an agent dial claim — the stranded-contact sweep requeues it'));
  };

  const overrideApplied: AgencyOverrideKind[] = [
    ...(claim.spent.retryDelay ? ['retry_delay' as const] : []),
    ...(claim.spent.callingHours ? ['calling_hours' as const] : []),
  ];

  // ── 7. The attempt, then the dial ─────────────────────────────────────────
  let attempt: Awaited<ReturnType<typeof agencyAttemptRepository.create>>;
  try {
    attempt = await agencyAttemptRepository.create({
      campaignId: campaign.id,
      contactId,
      tenantId: campaign.tenant_id,
      accountId: campaign.account_id,
      callerId,
      reservedAgentId: sessionId,
      agentManual: { overrideApplied, overrideNote: claim.spent.callingHours ? note : null },
    });
  } catch (err) {
    await giveBack();
    await returnAgent();
    throw err;
  }
  if (!attempt) {
    // The duplicate-dial backstop: something holds a live attempt on this contact. That
    // attempt is not this claim's, so `giveBack`'s live-attempt guard would keep the contact
    // `in_flight` with its spends lost; the undo here is guarded by the claim's row version.
    await agencyAgentRetryRepository.releaseRefusedAgentDialClaim(contactId, claim).catch((err) =>
      log.error({ err, contactId }, 'Could not give back a refused agent dial claim — the stranded-contact sweep requeues it'));
    await returnAgent();
    return refuse(409, 'contact_in_flight');
  }

  try {
    await deps.dispatcher.dispatch({
      attemptId: attempt.id,
      campaignId: campaign.id,
      contactId,
      sessionId,
      ownerReplica,
      tenantId: campaign.tenant_id,
      accountId: campaign.account_id,
      callerId: attempt.caller_id,
      attemptNumber: attempt.attempt_number,
      campaign,
      contact: claim.contact,
      clearance: gate.clearance,
    });
  } catch (err) {
    // As the tick's dispatch failure: the attempt ends `failed`, then the agent and the
    // contact go back. A dial the dialer itself abandoned has already settled both, and the
    // guarded give-back then finds nothing to undo.
    log.error({ err, attemptId: attempt.id, sessionId, contactId }, 'Agent dial dispatch failed');
    await agencyAttemptRepository.setState(attempt.id, 'ended', { outcome: 'failed', ended_at: new Date() })
      .catch((e) => log.error({ err: e, attemptId: attempt!.id }, 'Could not end a failed agent dial'));
    await returnAgent();
    await giveBack();
    return refuse(502, 'dial_failed');
  }

  log.info(
    { sessionId, contactId, attemptId: attempt.id, basis: choice.basis, overrideApplied, roundSpent: claim.spent.round },
    'Agent dialled one of their contacts',
  );
  return {
    ok: true,
    basis: choice.basis,
    response: {
      attempt_id: attempt.id,
      contact_id: contactId,
      override_applied: overrideApplied,
      retry_round_spent: claim.spent.round,
    },
  };
}

/** Why the claim took nothing, from the rows as they are now. Nothing was written. */
async function explainLostClaim(
  campaign: AgencyCampaignRecord,
  input: MyContactCallInput,
  settings: AgentRetrySettings,
  spendCallingHours: boolean,
): Promise<{ ok: false } & MyContactCallRefusal> {
  if (await agencyAgentRetryRepository.numberIsLive(campaign.id, input.contactId)) {
    return refuse(409, 'contact_in_flight');
  }
  const now = await agencyAgentRetryRepository.evaluateForAgentDial({
    contactId: input.contactId, campaignId: campaign.id, userId: input.actorUserId, settings,
  });
  if (!now) return refuse(404, 'contact_not_found');
  const choice = chooseAgentDialBasis(now.facts);
  if (!choice.ok) return refusalOfChoice(choice);
  if (spendCallingHours && !now.contact.override_calling_hours) {
    // Spent by a concurrent dial between the gates and the claim.
    return refuse(409, 'outside_calling_hours', { next_open_at: null });
  }
  // Eligible but row-locked: a pacing tick or a soft-phone claim is taking it right now.
  return refuse(409, 'contact_in_flight');
}
