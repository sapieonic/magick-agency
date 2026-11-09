/**
 * Opening the soft phone with a number already on the pad, from another screen: a Missed
 * inbound call's **Call back** (`docs/inbound.md` §7). Not a dial path: `/dialer/phone` fills
 * the pad (and the "Log to" campaign, when the agent may log to it) the way Redial does, the Call
 * button takes focus, and the agent presses it. Every soft-phone rule then applies as to any
 * typed number, the DNC check and its override note included (SP1).
 *
 * The number travels in history state, never the URL (customer history's CH6 rule): a URL is
 * logged, shared and kept in browser history.
 */

export interface SoftphonePrefill {
  /** E.164. */
  number: string;
  /** The campaign to log the call to, when the agent may. */
  campaignId: string | null;
}

const KEY = 'softphonePrefill';

/** The `state` to navigate to `/dialer/phone` with. */
export function softphonePrefillState(prefill: SoftphonePrefill): Record<string, SoftphonePrefill> {
  return { [KEY]: { number: prefill.number, campaignId: prefill.campaignId } };
}

/** The prefill in a location's state, or null (anything malformed reads as none). */
export function readSoftphonePrefill(state: unknown): SoftphonePrefill | null {
  if (!state || typeof state !== 'object') return null;
  const raw = (state as Record<string, unknown>)[KEY];
  if (!raw || typeof raw !== 'object') return null;
  const { number, campaignId } = raw as { number?: unknown; campaignId?: unknown };
  if (typeof number !== 'string' || !/^\+[1-9]\d{1,14}$/.test(number)) return null;
  return { number, campaignId: typeof campaignId === 'string' && campaignId ? campaignId : null };
}
