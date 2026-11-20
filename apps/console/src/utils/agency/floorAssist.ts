import { AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS } from '@magick-agency/contracts/agency/floor-assist';
import type { AgencyFloorAgent, AgencyFloorAlertKind } from '@magick-agency/contracts/api/agency/floor';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { errorCode, errorStatus } from '../agencyErrors';
import { breakLimitMinutesOf } from '../agencyAgentFloor';
import { browserStorage } from '../browserStorage';
import { formatCount } from '../format/number';

/**
 * Floor assist on the supervisor's Live floor (decisions LF4, LF5, LF28–LF33): Need help's row, card
 * and chime, Talk to agent and Send reminder. Pure, so each rule is tested where it is made. The
 * flag is the station's (`floorAssistFlag.ts`, LF11): with it off the floor read's `help` is null on
 * every row and the message route answers `403 floor_assist_disabled`, so Live floor shows no Talk,
 * no Send reminder, no Need help chip and no sound toggle.
 */

/** A message's length as the server counts it: trimmed, in code points (an emoji is one). */
export function messageLength(text: string): number {
  return [...text.trim()].length;
}

/** Whether the server would take this text (1 to 500 characters once trimmed). */
export function messageFits(text: string): boolean {
  const length = messageLength(text);
  return length >= 1 && length <= AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS;
}

/** Who a message goes to: the agent's live session and their name, and Send reminder's prefilled words. */
export interface MessageTarget {
  sessionId: string;
  name: string;
  /** Present for Send reminder: the dialog opens with these words, still editable. */
  reminder?: string;
}

/**
 * The one-press answer to Need help when the supervisor walks over (BE-9): a supervisor's message,
 * the existing answer (LF14), so it answers the request whatever the agent was doing.
 */
export const COMING_TO_DESK_TEXT = 'I am coming to your desk.';

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
      return `Write a message of 1 to ${formatCount(AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS)} characters.`;
    case 'floor_assist_disabled':
      return 'Messages to agents are turned off for this account.';
    default:
      break;
  }
  if (errorStatus(err) === 404) return `${name}’s session has ended.`;
  return getErrorMessage(err, `Your message wasn’t sent to ${name}. Try again.`);
}

/**
 * One alert as the chime tells alerts apart (LF31, AS16): what it is about and a key that is the
 * same whichever read saw it. Live floor's floor read and the shell's alerts read both carry an
 * open Need help request, so its key is built from what both carry ({@link helpChimeKey}); the
 * other kinds come only from the alerts read and are keyed by the alert's `id`.
 */
export interface ChimeKey {
  kind: AgencyFloorAlertKind;
  key: string;
}

/**
 * A Need help request's chime key: the session and the instant it was raised (as a number, so two
 * reads that spell the same instant differently agree), so a request raised again after an answer
 * is a new one.
 */
export function helpChimeKey(sessionId: string, raisedAt: string): string {
  const at = Date.parse(raisedAt);
  return `help:${sessionId}@${Number.isFinite(at) ? at : raisedAt}`;
}

/** Every open request on the floor, in the floor's order. A row with no open session has none. */
export function helpKeys(rows: readonly Pick<AgencyFloorAgent, 'session_id' | 'help'>[]): ChimeKey[] {
  return rows.flatMap((row) => (row.help && row.session_id
    ? [{ kind: 'help' as const, key: helpChimeKey(row.session_id, row.help.raised_at) }]
    : []));
}

/**
 * What one read changes in the page's heard alerts (LF31, AS16), pure. `covers` are the kinds the
 * read can see (Live floor's floor read: Need help; the shell's alerts read: every kind). The first
 * read of the page that covers a kind only notes what is open of it (`noted`: shown, never chimed
 * for), so a reload never plays the sound for what the reader can already see. After that, a key
 * not heard before on this page, by any read, is `fresh` (chimed once), and never again, whichever
 * read sees it next.
 */
export function heardFrom(
  heard: ReadonlySet<string>,
  baselined: ReadonlySet<AgencyFloorAlertKind>,
  covers: readonly AgencyFloorAlertKind[],
  keys: readonly ChimeKey[],
): { fresh: string[]; noted: string[]; baselines: AgencyFloorAlertKind[] } {
  const baselines = covers.filter((kind) => !baselined.has(kind));
  const fresh: string[] = [];
  const noted: string[] = [];
  for (const { kind, key } of keys) {
    if (heard.has(key) || fresh.includes(key) || noted.includes(key)) continue;
    if (baselines.includes(kind)) noted.push(key);
    else fresh.push(key);
  }
  return { fresh, noted, baselines };
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
 * The choice made on this page, whatever storage did with it: `null` until the reader toggles. One
 * value for the whole page, so a chime mounted after a toggle (Live floor opened after muting from
 * the banner) agrees with every other, even where storage cannot keep the choice.
 */
let chosenOnThisPage: boolean | null = null;

/**
 * Whether Need help plays its sound in this browser: on unless turned off here. The choice made on
 * this page first (so every chime agrees, storage or not), then the browser's, then on: storage
 * that throws (a private window, blocked site data) reads as the default.
 */
export function readHelpChimeOn(): boolean {
  if (chosenOnThisPage !== null) return chosenOnThisPage;
  try {
    return browserStorage()?.getItem(CHIME_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Keeps the choice for this page, and for this browser where storage lets it. */
export function writeHelpChimeOn(on: boolean): void {
  chosenOnThisPage = on;
  try {
    const storage = browserStorage();
    if (on) storage?.removeItem(CHIME_KEY);
    else storage?.setItem(CHIME_KEY, 'off');
  } catch {
    // Blocked or full storage: the page's choice above carries it until the page is reloaded.
  }
}

/** Tests only: forget the page's choice, as a reload does. */
export function resetHelpChimeChoiceForTests(): void {
  chosenOnThisPage = null;
}
