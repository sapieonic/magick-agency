import { AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS } from '@magick-agency/contracts/agency/floor-assist';
import type { AgencyFloorAgent } from '@magick-agency/contracts/api/agency/floor';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { errorCode, errorStatus } from '../agencyErrors';
import { breakLimitMinutesOf } from '../agencyAgentFloor';
import { formatCount } from '../format/number';

/**
 * Floor assist on the supervisor's Live floor (decisions LF4, LF5, LF28–LF33): Need help's row, card
 * and chime, Talk to agent and Send reminder. Pure, so each rule is tested where it is made. The
 * flag is the station's (`floorAssistFlag.ts`, LF11): with it off the floor read's `help` is null on
 * every row and the message route answers `403 floor_assist_disabled`, so Live floor shows no Talk,
 * no Send reminder, no Need help chip and no sound toggle.
 */

/** The longest message, in characters as the reader sees them (code points, LF17). */
export const MESSAGE_MAX_CHARS = AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS;

/** A message's length as the server counts it: trimmed, in code points (an emoji is one). */
export function messageLength(text: string): number {
  return [...text.trim()].length;
}

/** Whether the server would take this text (1 to 500 characters once trimmed). */
export function messageFits(text: string): boolean {
  const length = messageLength(text);
  return length >= 1 && length <= MESSAGE_MAX_CHARS;
}

/** Who a message goes to: the agent's live session and their name, and Send reminder's prefilled words. */
export interface MessageTarget {
  sessionId: string;
  name: string;
  /** Present for Send reminder: the dialog opens with these words, still editable. */
  reminder?: string;
}

/**
 * Send reminder's words (LF5's "the same route with prefilled text"): friendly, naming the break
 * and its length, the reason's limit (LF6) or the floor's 30 minutes for a reason with none.
 */
export function reminderText(breakLabel: string | null, breakLimitMinutes: number | null | undefined): string {
  const minutes = formatCount(breakLimitMinutesOf(breakLimitMinutes));
  const what = breakLabel ? `${breakLabel} break` : 'break';
  return typeof breakLimitMinutes === 'number'
    ? `Hi, your ${what} (${minutes} minutes) is over. Please come back to your station when you can. Thank you!`
    : `Hi, your ${what} has gone past ${minutes} minutes. Please come back to your station when you can. Thank you!`;
}

/**
 * A refused message in the console's words, naming the agent (the route's refusals, LF5, LF11,
 * LF17): no live station, the text, the flag, a session gone (the uniform 404). Anything else is
 * the server's message or the fallback.
 */
export function messageRefusal(err: unknown, name: string): string {
  switch (errorCode(err)) {
    case 'agent_not_live':
      return `${name} isn’t on a station that can receive messages right now.`;
    case 'message_invalid':
      return `Write a message of 1 to ${formatCount(MESSAGE_MAX_CHARS)} characters.`;
    case 'floor_assist_disabled':
      return 'Messages to agents are turned off for this account.';
    default:
      break;
  }
  if (errorStatus(err) === 404) return `${name}’s session has ended.`;
  return getErrorMessage(err, `Your message wasn’t sent to ${name}. Try again.`);
}

/**
 * One open Need help request, as the chime tells requests apart (LF31): the agent and the moment
 * they raised it, so a request raised again after an answer is a new one.
 */
export function helpKey(row: Pick<AgencyFloorAgent, 'agent_user_id' | 'help'>): string | null {
  return row.help ? `${row.agent_user_id}@${row.help.raised_at}` : null;
}

/** Every open request on the floor, in the floor's order. */
export function helpKeys(rows: readonly Pick<AgencyFloorAgent, 'agent_user_id' | 'help'>[]): string[] {
  return rows.flatMap((row) => {
    const key = helpKey(row);
    return key === null ? [] : [key];
  });
}

/**
 * The requests to chime for (LF31): the ones not seen before on this page. Null `seen` is the page's first
 * read of the floor: what is already open then is shown (the red row and card) and not chimed for,
 * so a reload or a return to the page never plays the sound for requests the reader has seen.
 */
export function newHelpKeys(seen: ReadonlySet<string> | null, keys: readonly string[]): string[] {
  if (seen === null) return [];
  return keys.filter((key) => !seen.has(key));
}

/** "under a minute ago", "3 min ago": how long ago a request was raised, on the floor's 5 s clock. */
export function helpAgo(raisedAt: string, nowMs: number): string {
  const at = Date.parse(raisedAt);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  return minutes < 1 ? 'under a minute ago' : `${formatCount(minutes)} min ago`;
}

// ── The chime's setting, per browser (LF4: on by default, mutable per browser) ──

const CHIME_KEY = 'magick.liveFloor.helpChime.v1';

/**
 * Whether Need help plays its sound in this browser: on unless turned off here. Storage that throws
 * (a private window, blocked site data) reads as the default, on.
 */
export function readHelpChimeOn(): boolean {
  try {
    return window.localStorage.getItem(CHIME_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Keeps the choice for this browser; storage that throws keeps it for this page only. */
export function writeHelpChimeOn(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(CHIME_KEY);
    else window.localStorage.setItem(CHIME_KEY, 'off');
  } catch {
    // Blocked or full storage: the page's own state carries the choice until it is reloaded.
  }
}
