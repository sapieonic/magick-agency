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
  'Nothing will be sent to you until the campaign is running again.';

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
