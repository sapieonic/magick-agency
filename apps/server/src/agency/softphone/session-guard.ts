/**
 * The soft phone's guard on `available` (docs/softphone.md §4.1 step 1, §6), as the
 * routes and the soft-phone service call it, and the inbound call's beside it
 * (docs/inbound.md §6, P2: the Redis `inbound` field and the session's unsettled inbound
 * call, read the same two ways).
 *
 * `AgentStateMachine.set(…, 'available')` refuses, inside its Lua write, while the
 * session holds a soft-phone call (`manual`) or is a soft-phone session. This turns
 * that refusal into what a caller can answer with: the session's unsettled call
 * (for `409 manual_call_live`), or `wrong_session_kind`.
 *
 * **The database is asked first.** The Lua guard only knows what the hash holds,
 * and the `manual` field lives in the lease: a lease that lapsed (a station gone
 * longer than 45 s, a restart) and was rewritten by anything but the soft-phone
 * rehydrate has no field, and the write would go through with an outcome owed. So
 * the session's unsettled call is read before the write; one that exists refuses
 * `manual_call_live` and re-claims the field (on `break` only: the claim's own
 * rule), so pacing's CAS refuses again too. A read that fails throws — the caller
 * answers an error and nothing is written, failing closed. The Lua guard still
 * closes the race with a dial that commits between this read and the write.
 *
 * A `manual` field naming a call that is no longer unsettled is STALE (the release
 * after a settle failed, or a crash between the settle and the release): it is
 * cleared by that id — never another — and the write retried once, so a stale
 * claim cannot keep an agent out of the pool forever.
 */
import { createChildLogger } from '@magick-agency/observability';
import { SOFTPHONE_BREAK_REASON, type AgencyAgentState, type AgencyManualCall } from '@magick-agency/contracts/agency';
import { agencyInboundCallRepository, agencyManualCallRepository } from '../../db/repositories/agency.repository.js';
import { AGENT_LEASE_MS, type AgentStateMachine } from '../agent-state-machine.js';

const log = createChildLogger({ component: 'agency-softphone' });

/**
 * The one rule for "this session is on the soft phone right now": Redis says `break`
 * (the authority on the agent's state, as pacing reads it) and the session row's
 * reason is the reserved {@link SOFTPHONE_BREAK_REASON}. Every route and the service
 * ask this, so a change to the rule is made once.
 */
export function onSoftphoneBreak(
  live: { state: AgencyAgentState } | null | undefined,
  session: { break_reason: string | null },
): boolean {
  return live?.state === 'break' && session.break_reason === SOFTPHONE_BREAK_REASON;
}

export type SetAvailableResult =
  | { ok: true }
  | { ok: false; refusal: { code: 'manual_call_live'; call: AgencyManualCall } | { code: 'wrong_session_kind' } }
  /**
   * The session holds an inbound call: offered, connected, or ended with its outcome owed
   * (docs/inbound.md §6). The routes answer `409 inbound_call_live` naming it.
   */
  | { ok: false; refusal: { code: 'inbound_call_live'; inboundCallId: string } }
  /** Redis could not answer; nothing was written. */
  | { ok: false; refusal: { code: 'unavailable' } }
  /**
   * The Lua guard kept refusing on a `manual` claim that would not clear, and the
   * session owes no call. Nothing was written: Redis still holds the session's state
   * and the claim, so the caller must not report `available`.
   */
  | { ok: false; refusal: { code: 'claim_not_released' } };

/**
 * The session's unsettled soft-phone call (live, or awaiting its outcome) as the wire
 * row a `409 manual_call_live` carries, or null. Read from the database — the
 * authority on what is owed — and, when there is one, the session's Redis `manual`
 * field is re-claimed for it (a no-op when it already holds it), so every later
 * `available` write refuses in Lua as well. Throws when the read fails.
 */
export async function owedSoftphoneCall(
  agents: AgentStateMachine,
  sessionId: string,
): Promise<AgencyManualCall | null> {
  const owed = await agencyManualCallRepository.findUnsettledForSession(sessionId);
  if (!owed) return null;
  const claim = await agents.claimManual(sessionId, owed.id);
  if (!claim.ok) {
    log.warn({ sessionId, manualCallId: owed.id, claim }, 'Could not re-claim the session\'s unsettled soft-phone call');
  }
  return agencyManualCallRepository.findWireById(
    owed.id, { tenantId: owed.tenant_id, accountId: owed.account_id }, { withContext: true },
  );
}

/**
 * The id of the session's unsettled inbound call (offered, connected, or ended with its outcome
 * owed), or null: the inbound twin of {@link owedSoftphoneCall}. Read from the database, the
 * authority on what is owed; when the call is ended and owes its outcome, the session's Redis
 * `inbound` field is re-claimed for it (`rehydrateInbound`: a lapsed or `available` lease becomes
 * `break`), so every later `available` write refuses in Lua as well. An offered or connected
 * call's field is the connector's, written with its reservation, and is left to it. Throws when
 * the read fails.
 */
export async function owedInboundCallId(agents: AgentStateMachine, sessionId: string): Promise<string | null> {
  const owed = await agencyInboundCallRepository.findUnsettledForSession(sessionId);
  if (!owed) return null;
  if (owed.state === 'ended' && owed.bridged_at !== null && !(await agents.rehydrateInbound(sessionId, owed.id))) {
    log.warn({ sessionId, inboundCallId: owed.id }, 'Could not re-claim the session\'s owed inbound call');
  }
  return owed.id;
}

export async function setAvailableGuarded(
  agents: AgentStateMachine,
  sessionId: string,
): Promise<SetAvailableResult> {
  const owed = await owedSoftphoneCall(agents, sessionId);
  if (owed) return { ok: false, refusal: { code: 'manual_call_live', call: owed } };
  const owedInbound = await owedInboundCallId(agents, sessionId);
  if (owedInbound) return { ok: false, refusal: { code: 'inbound_call_live', inboundCallId: owedInbound } };
  for (let pass = 0; pass < 2; pass++) {
    const set = await agents.set(sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
    if (set === 'ok') return { ok: true };
    if (set === 'softphone_session') return { ok: false, refusal: { code: 'wrong_session_kind' } };
    if (set === 'unavailable') return { ok: false, refusal: { code: 'unavailable' } };
    if (set === 'inbound_call_owed') {
      // An inbound call reserved the session between the read above and the write, or the
      // field is stale (the release after a settle failed). The database decides which; a
      // stale field is cleared by the id it holds, never another, and the write retried.
      const unsettled = await agencyInboundCallRepository.findUnsettledForSession(sessionId);
      if (unsettled) return { ok: false, refusal: { code: 'inbound_call_live', inboundCallId: unsettled.id } };
      const heldInbound = await agents.inboundCallOf(sessionId);
      if (!heldInbound) continue;
      log.warn({ sessionId, heldBy: heldInbound }, 'Stale inbound claim on a session with no unsettled inbound call — clearing it');
      await agents.releaseInbound(sessionId, heldInbound);
      continue;
    }

    const unsettled = await agencyManualCallRepository.findUnsettledForSession(sessionId);
    if (unsettled) {
      const call = await agencyManualCallRepository.findWireById(
        unsettled.id, { tenantId: unsettled.tenant_id, accountId: unsettled.account_id }, { withContext: true },
      );
      if (call) return { ok: false, refusal: { code: 'manual_call_live', call } };
    }
    const held = await agents.manualCallOf(sessionId);
    if (!held || held === unsettled?.id) break;
    log.warn({ sessionId, heldBy: held }, 'Stale soft-phone claim on a session with no unsettled call — clearing it');
    await agents.releaseManual(sessionId, held);
  }
  // A claim that would not clear: answer as a live call would, with whatever the
  // session holds. Unreachable unless the release itself keeps failing — and then it is
  // its own refusal, never `unavailable`, which a caller may treat as "Redis was down,
  // carry on" while the claim still keeps the agent out of the pool.
  const unsettledInbound = await agencyInboundCallRepository.findUnsettledForSession(sessionId);
  if (unsettledInbound) return { ok: false, refusal: { code: 'inbound_call_live', inboundCallId: unsettledInbound.id } };
  const unsettled = await agencyManualCallRepository.findUnsettledForSession(sessionId);
  const call = unsettled
    ? await agencyManualCallRepository.findWireById(unsettled.id, { tenantId: unsettled.tenant_id, accountId: unsettled.account_id })
    : null;
  return call ? { ok: false, refusal: { code: 'manual_call_live', call } } : { ok: false, refusal: { code: 'claim_not_released' } };
}
