/**
 * The soft phone's guard on `available` (docs/softphone.md §4.1 step 1, §6), as the
 * routes and the soft-phone service call it.
 *
 * `AgentStateMachine.set(…, 'available')` refuses, inside its Lua write, while the
 * session holds a soft-phone call (`manual`) or is a soft-phone session. This turns
 * that refusal into what a caller can answer with: the session's unsettled call
 * (for `409 manual_call_live`), or `wrong_session_kind`.
 *
 * A `manual` field naming a call that is no longer unsettled is STALE (the release
 * after a settle failed, or a crash between the settle and the release): it is
 * cleared by that id — never another — and the write retried once, so a stale
 * claim cannot keep an agent out of the pool forever.
 */
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyManualCall } from '@magick-agency/contracts/agency';
import { agencyManualCallRepository } from '../../db/repositories/agency.repository.js';
import { AGENT_LEASE_MS, type AgentStateMachine } from '../agent-state-machine.js';

const log = createChildLogger({ component: 'agency-softphone' });

export type SetAvailableResult =
  | { ok: true }
  | { ok: false; refusal: { code: 'manual_call_live'; call: AgencyManualCall } | { code: 'wrong_session_kind' } }
  /** Redis could not answer; nothing was written. */
  | { ok: false; refusal: { code: 'unavailable' } };

export async function setAvailableGuarded(
  agents: AgentStateMachine,
  sessionId: string,
): Promise<SetAvailableResult> {
  for (let pass = 0; pass < 2; pass++) {
    const set = await agents.set(sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
    if (set === 'ok') return { ok: true };
    if (set === 'softphone_session') return { ok: false, refusal: { code: 'wrong_session_kind' } };
    if (set === 'unavailable') return { ok: false, refusal: { code: 'unavailable' } };

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
  // session holds. Unreachable unless the release itself keeps failing.
  const unsettled = await agencyManualCallRepository.findUnsettledForSession(sessionId);
  const call = unsettled
    ? await agencyManualCallRepository.findWireById(unsettled.id, { tenantId: unsettled.tenant_id, accountId: unsettled.account_id })
    : null;
  return call ? { ok: false, refusal: { code: 'manual_call_live', call } } : { ok: false, refusal: { code: 'unavailable' } };
}
