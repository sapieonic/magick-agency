import type { SoftphoneState } from '../../hooks/useSoftphone';

/**
 * What the soft phone's hosts say about leaving it, and whether a call is recorded: shared by
 * `/dialer/phone` (`SoftphonePage`, its top bar's nav) and the screen itself (`SoftphoneScreen`,
 * "Call is recorded" in the band).
 */

/**
 * What leaving for another screen does with no call: nothing ends. The soft phone stays open
 * (and a campaign join will offer to close it), so the nav says so rather than let the agent find
 * out at the join.
 */
export const SOFTPHONE_STAYS_OPEN_COPY = 'Your soft phone stays open on other screens. Close it here when you are done.';

/** What leaving would do while a call is unsettled: the nav says it. */
export const SOFTPHONE_LEAVE_BLOCKED_COPY = 'Finish this call first. Leaving now would cut the customer off.';

/** Recording disclosed in the band: the agent may have to announce it. */
export function recordingDisclosed(sp: SoftphoneState): boolean {
  if (sp.call) return sp.call.recording_requested;
  if (sp.campaign) return sp.campaign.record_calls;
  return Boolean(sp.bootstrap?.untagged.record_calls);
}
