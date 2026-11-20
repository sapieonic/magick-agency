import type { AgencyDialActivity, AgencyQueueIdleReason, AgencyQueueState } from '../types/agency';

/**
 * The station's idle helpers: the dial activity the socket states, the agent's name on the top
 * bar, and the agent's own queue (contact assignment). The words the station shows while the agent
 * waits are `utils/agency/stationCopy.ts` (AS15).
 */

/**
 * The one check for a stated dial activity, from the `dial_activity` frame and from
 * `ready.dial_activity` alike: `ringing` a boolean and `unanswered_in_a_row` a non-negative
 * integer, or `null` (treated as absent). Unchecked, `ringing: "yes"` would make the panel say
 * "Dialling" (truthy) while the rail did not (`=== true`). Returns a fresh object holding only
 * the two fields, so nothing else the server sent rides into state.
 */
export function parseDialActivity(value: unknown): AgencyDialActivity | null {
  if (typeof value !== 'object' || value === null) return null;
  const { ringing, unanswered_in_a_row: count } = value as Record<string, unknown>;
  if (typeof ringing !== 'boolean') return null;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
  return { ringing, unanswered_in_a_row: count };
}

/**
 * The name on the station header.
 *
 * Display name first: that is what a supervisor walking up to a shared seat
 * needs to read. Email is the fallback when the account has no name yet, and
 * "Signed in" is the last resort so the chip is never a blank circle.
 */
export function stationAgentLabel(user: {
  display_name: string | null;
  email: string;
} | null | undefined): string {
  const name = user?.display_name?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  if (email) return email;
  return 'Signed in';
}

// ─── "Nothing due now" (contact assignment) ─────────────────────────────────

/**
 * Why nothing is due for the agent, or `null` when something is (or no queue is stated, as on a
 * `pool` campaign). On a `strict` or `preferred` campaign an agent with nothing due is NOT
 * reserved; the station shows 02c and its subtitle from `noCallsSubtitle` (`stationCopy.ts`), and
 * the page reports the reason to analytics. `null` too for a nothing-due queue that states no
 * reason: there is nothing to report.
 */
export function nothingDueReason(queue: AgencyQueueState | null | undefined): AgencyQueueIdleReason | null {
  if (!queue || queue.due) return null;
  return queue.reason ?? null;
}

/**
 * The queue to show: the socket's statement once it has made one, the
 * bootstrap's (the state at join) until then.
 */
export function effectiveQueue(
  socket: AgencyQueueState | null | undefined,
  bootstrap: AgencyQueueState | null | undefined,
): AgencyQueueState | null {
  return socket !== undefined ? socket : (bootstrap ?? null);
}
