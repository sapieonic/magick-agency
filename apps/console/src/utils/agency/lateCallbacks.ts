import type { AgencyAssignmentMode } from '@magick-agency/contracts/agency';
import type { AgencyLateCallbacksPreview, AgencyLateCallbacksResult } from '@magick-agency/contracts/api/agency/assignment';
import { plural } from '../format/number';

/**
 * Give late callbacks to free agents on Live floor (LF7, LF21, LF30): when it is offered, and its
 * words. Pure, so each rule is tested where it is made.
 */

/**
 * Whether the late-callbacks row offers "Give to free agents", with contact assignment on (its
 * routes' flag; the page offers nothing without it): the campaign's mode read and not `pool` (LF7:
 * no agent owns a callback there). A mode not read yet, or whose read failed, offers nothing: the
 * row keeps its link to the campaign's Callbacks tab.
 */
export function offersHandOff(mode: AgencyAssignmentMode | undefined): boolean {
  return mode === 'strict' || mode === 'preferred';
}

/** `409 late_callbacks_pool_mode`: the mode changed under the page. */
export const LATE_CALLBACKS_POOL_COPY =
  'This campaign shares one queue, so no agent owns its callbacks and there are none to give.';

/**
 * Who the preview's plan gives callbacks to: its `per_agent` lines with `receiving` above 0, in the
 * preview's order (fewest due first). Not `live_agent_user_ids`: that is every free agent, and the
 * dealing evens out the receivers' due callbacks, so one late callback and three free agents goes to
 * the one with the fewest due only (LF21).
 */
export function lateCallbacksReceivers(preview: Pick<AgencyLateCallbacksPreview, 'per_agent'>): string[] {
  return preview.per_agent.filter((line) => line.receiving > 0).map((line) => line.agent_user_id);
}

/**
 * The preview as one question: "Give 4 late callbacks to 2 free agents?" (the agents the plan gives
 * callbacks to, {@link lateCallbacksReceivers}), or why nothing would move: nobody free on the
 * campaign, or no late callback waiting on an agent who is away (the board's count reads a 15-minute
 * absence, the hand-off presence, LF21, so they can differ).
 */
export function lateCallbacksQuestion(preview: Pick<AgencyLateCallbacksPreview, 'moving' | 'per_agent' | 'live_agent_user_ids'>): string {
  if (preview.live_agent_user_ids.length === 0) return 'No agent is free on this campaign right now, so there is nobody to give the late callbacks to.';
  const receivers = lateCallbacksReceivers(preview).length;
  if (preview.moving === 0 || receivers === 0) return 'No late callback is waiting on an agent who is away right now. Nothing would move.';
  return `Give ${plural(preview.moving, 'late callback')} to ${plural(receivers, 'free agent')}?`;
}

/** What a committed hand-off did: "Gave 4 late callbacks: Arjun T 2, Divya S 2." */
export function lateCallbacksResultText(result: Pick<AgencyLateCallbacksResult, 'moved' | 'per_agent'>, agentName: (id: string) => string): string {
  if (result.moved === 0) return 'Nothing moved: those callbacks were already given or picked up.';
  const to = result.per_agent.filter((line) => line.receiving > 0).map((line) => `${agentName(line.agent_user_id)} ${line.receiving}`);
  return `Gave ${plural(result.moved, 'late callback')}${to.length > 0 ? `: ${to.join(', ')}` : ''}.`;
}
