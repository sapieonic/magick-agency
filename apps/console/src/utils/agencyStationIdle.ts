import type { AgencyQueueIdleReason, AgencyQueueState } from '../types/agency';

/**
 * Copy for the station's idle panels — the contact column and the empty
 * middle column while the agent is waiting.
 *
 * These surfaces sit in the agent's field of view for a whole shift, so they
 * say what to do (stay on the screen; which keys work) and never invent a
 * queue length, an ETA or a statistic this client does not have.
 *
 * The middle column's guide is **not interactive**. Tab order on this screen
 * is frozen: a control that appeared only while idle would jump
 * into the sequence between "waiting" and "connected", which is the exact
 * moment a misclick hangs up on a person.
 */

export const IDLE_WAITING_HINT =
  'Stay on this screen so the next customer reaches you.';

export const IDLE_PAUSED_HINT =
  'Customers who ring in can still reach you. Campaign calls start again when it’s running.';

export const IDLE_GUIDE_HEADING = 'When a call connects';

export const IDLE_GUIDE_INTRO =
  'The contact’s details appear here. These keys work without a mouse.';

export const IDLE_KEYS_NOW: ReadonlyArray<{ key: string; does: string }> = [
  { key: 'B', does: 'Take a break' },
];

export const IDLE_KEYS_ON_CALL: ReadonlyArray<{ key: string; does: string }> = [
  { key: '1–9', does: 'Pick an outcome' },
  { key: 'N', does: 'Write a note' },
  { key: 'D', does: 'Mark do not call' },
  { key: 'Ctrl + Enter', does: 'Save the outcome' },
  { key: 'E then E', does: 'Hang up' },
];

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
 * On a `strict` or `preferred` campaign an agent with nothing due is NOT
 * reserved, so "waiting for a call" would be untrue: no call is coming until
 * something falls due. The idle guide says so, and why, from the `queue` the
 * bootstrap, `ready` and the `queue` frame state. A `Record` over the contract's
 * union, so a reason added there without copy fails the type check.
 *
 * `{next}` is the next due time when the server sent one; the other sentence
 * reads whole on its own.
 */
export const QUEUE_IDLE_COPY: Record<AgencyQueueIdleReason, { withTime: string; withoutTime: string }> = {
  queue_empty: {
    withTime: 'You have no open contacts right now. Your supervisor can assign you more.',
    withoutTime: 'You have no open contacts right now. Your supervisor can assign you more.',
  },
  waiting_for_retry: {
    withTime: 'Your contacts are scheduled for another try later. The next one is due {next}.',
    withoutTime: 'Your contacts are all scheduled for another try later.',
  },
  callbacks_later: {
    withTime: 'Your open contacts are callbacks booked for later. The next one is due {next}.',
    withoutTime: 'Your open contacts are all callbacks booked for later.',
  },
  outside_calling_hours: {
    withTime: 'The campaign is outside its calling hours. Calls start again {next}.',
    withoutTime: 'The campaign is outside its calling hours.',
  },
};

export const NOTHING_DUE_HEADING = 'Nothing due now';

/**
 * Nothing due for a reason this console has no words for (a newer server's, or
 * none stated). Still "nothing due": a call is not coming, so the guide must not
 * fall back to promising one.
 */
export const QUEUE_IDLE_NEUTRAL_COPY = {
  withTime: 'Nothing is due for you right now. Your next contact is due {next}.',
  withoutTime: 'Nothing is due for you right now.',
} as const;

/**
 * The idle guide's lead line when the agent's own queue has nothing due, or
 * `null` when the ordinary "a call will reach you" copy is true (pool mode, no
 * queue stated, or something due).
 */
export function nothingDueCopy(
  queue: AgencyQueueState | null | undefined,
  formatTime: (iso: string) => string,
): string | null {
  if (!queue || queue.due) return null;
  const copy = (queue.reason ? QUEUE_IDLE_COPY[queue.reason] : undefined) ?? QUEUE_IDLE_NEUTRAL_COPY;
  return queue.next_due_at
    ? copy.withTime.replace('{next}', formatTime(queue.next_due_at))
    : copy.withoutTime;
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
