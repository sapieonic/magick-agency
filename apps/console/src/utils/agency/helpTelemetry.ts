import type { AgencySessionHelp } from '@magick-agency/contracts/agency';
import {
  trackAgencyHelpAnswered,
  trackAgencyHelpCancelled,
  trackAgencyHelpExpired,
  trackAgencyHelpRaised,
  trackAgencyHelpRefused,
  type AgencyHelpRefusedCode,
  type AgencyHelpSurface,
} from '../../analytics/events';
import { ApiError } from '../../api/client';
import { secondsInStateBucket, type AgencyFloorStateBucket } from '../agencyAgentFloor';
import type { StationHelpFrame } from '../agencyStationReducer';

/**
 * Need help's telemetry (LF39 and its amendment 2): `agency_help_raised`, `_cancelled`,
 * `_answered` and `_expired`, each at most once per request (`raised_at`) on a page, and
 * `_refused` once per refused or failed press. The mobile app sends the same names and properties,
 * by the same rules.
 *
 *  - **raised**: the first raise answer (`POST /help`'s reply with a request) naming a `raised_at`
 *    this page has not reported, whether or not it is on screen when it lands. A `ready.help` or a
 *    frame never sends it ({@link HelpTelemetry.raiseAnswered}).
 *  - **The end events** come from the frames alone ({@link HelpTelemetry.frameSeen}), and only for a
 *    request in scope when the frame landed, as the reducer decided it then (`helpFrameInScope` in
 *    `utils/agencyStationReducer`, which states the rule).
 *    - **answered**: `help_answered` (`how` from the frame), or `help_cleared { answered }` when no
 *      `help_answered` was sent for it (`how: 'unknown'`). A cancel that lost the race to an answer
 *      is that answer, on either side of the cancel's reply.
 *    - **expired**: `help_cleared { expired }`. **cancelled**: `help_cleared { cancelled }`, the
 *      server's proof the cancel won, never the cancel's reply (`help: null` whether it won or lost).
 *    - One of answered, expired and cancelled per request, the first in scope. A `session_ended`
 *      clear and anything out of scope send nothing.
 */

/** Where the agent pressed Need help, and whether they were on a call or owed an outcome then. */
export interface HelpWhere {
  surface: AgencyHelpSurface;
  onCall: boolean;
}

/** The refusal's code as the event carries it: the server's code when it is one of the named ones, else a 404, no answer, or other. */
export function helpRefusedCode(code: string | null, status: number | null, noResponse: boolean): AgencyHelpRefusedCode {
  if (code === 'floor_assist_disabled' || code === 'help_not_on_call' || code === 'session_ended') return code;
  if (status === 404) return 'not_found';
  // No response came back at all (`fetch` threw); an answer that could not be read is `other`.
  if (noResponse) return 'network';
  return 'other';
}

/**
 * Whether a raise or a cancel failed with no answer from the server: `fetch` itself threw (a
 * `TypeError`), or the sign-in token could not be had before any request went (a Firebase `auth/…`
 * error from `getIdToken`, as offline; the app maps a token failure to its network error too). An
 * answer that came back but could not be read (a 2xx whose body is not JSON: a `SyntaxError`) is not
 * that. Only for an error from the request itself, never one thrown while handling its answer.
 */
export function failedWithNoAnswer(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  if (err instanceof TypeError) return true;
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('auth/');
}

/**
 * The request a raise's or a cancel's 2xx answer names: the open one (`{ raised_at, call_id }`),
 * none (`null`), or `undefined` when the body has no usable `help` (a refusal of kind `other`).
 */
export function answeredHelp(answer: unknown): AgencySessionHelp | null | undefined {
  if (answer === null || typeof answer !== 'object' || !('help' in answer)) return undefined;
  const help = (answer as { help: unknown }).help;
  if (help === null) return null;
  if (typeof help !== 'object') return undefined;
  const { raised_at: raisedAt, call_id: callId } = help as { raised_at?: unknown; call_id?: unknown };
  if (typeof raisedAt !== 'string') return undefined;
  return { raised_at: raisedAt, call_id: typeof callId === 'string' ? callId : null };
}

export class HelpTelemetry {
  /** Requests whose `raised` was sent. */
  private readonly raised = new Set<string>();
  /** Requests whose end (cancelled, answered or expired) was sent. */
  private readonly ended = new Set<string>();

  /** @param elapsed ms from a server instant to now, on the server-aligned clock (`ServerClock.since`). */
  constructor(private readonly elapsed: (raisedAt: string) => number | null) {}

  /** A raise's answer: the first naming a request not yet reported is the raise. */
  raiseAnswered(help: AgencySessionHelp | null, where: HelpWhere): void {
    if (help === null || this.raised.has(help.raised_at)) return;
    this.raised.add(help.raised_at);
    trackAgencyHelpRaised({ surface: where.surface, on_call: where.onCall });
  }

  /** A Need help frame the station heard (an entry of `StationState.helpFrames`), once each, in order. */
  frameSeen(heard: StationHelpFrame): void {
    if (!heard.inScope) return;
    const { frame } = heard;
    const raisedAt = frame.raised_at;
    if (frame.event === 'help_answered') {
      this.end(raisedAt, () => trackAgencyHelpAnswered({ how: frame.how, wait_bucket: this.waitBucket(raisedAt) }));
      return;
    }
    switch (frame.reason) {
      case 'answered':
        this.end(raisedAt, () => trackAgencyHelpAnswered({ how: 'unknown', wait_bucket: this.waitBucket(raisedAt) }));
        return;
      case 'expired':
        this.end(raisedAt, () => trackAgencyHelpExpired());
        return;
      case 'cancelled':
        this.end(raisedAt, () => trackAgencyHelpCancelled({ wait_bucket: this.waitBucket(raisedAt) }));
        return;
      default:
        // `session_ended`: nothing.
        return;
    }
  }

  /** A raise or a cancel was refused, or failed. */
  refused(action: 'raise' | 'cancel', code: string | null, status: number | null, noResponse: boolean): void {
    trackAgencyHelpRefused({ action, code: helpRefusedCode(code, status, noResponse) });
  }

  /** Sends `send` once for the request: its first end wins. */
  private end(raisedAt: string, send: () => void): void {
    if (this.ended.has(raisedAt)) return;
    this.ended.add(raisedAt);
    send();
  }

  private waitBucket(raisedAt: string): AgencyFloorStateBucket {
    return secondsInStateBucket(this.elapsed(raisedAt));
  }
}
