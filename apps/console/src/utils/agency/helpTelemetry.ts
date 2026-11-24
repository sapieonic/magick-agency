import type { AgencySessionHelp } from '@magick-agency/contracts/agency';
import {
  trackAgencyHelpAnswered,
  trackAgencyHelpCancelled,
  trackAgencyHelpExpired,
  trackAgencyHelpRaised,
  trackAgencyHelpRefused,
  type AgencyHelpRefusedCode,
  type AgencyHelpSurface,
  type AgencyHelpWaitBucket,
} from '../../analytics/events';
import { secondsInStateBucket } from '../agencyAgentFloor';

/**
 * Need help's telemetry (LF39 and its amendment 2): `agency_help_raised`, `_cancelled`,
 * `_answered`, `_expired` and `_refused`, each at most once per request (`raised_at`) on a page.
 * The mobile app sends the same names and properties, by the same rules.
 *
 *  - **raised**: the first raise answer (`POST /help`'s reply with a request) naming a `raised_at`
 *    this page has not reported, whether or not it is on screen when it lands. A `ready.help` or a
 *    frame never sends it ({@link HelpTelemetry.raiseAnswered}).
 *  - **The end events** come from the frames alone ({@link HelpTelemetry.frameSeen}), and only for a
 *    request in scope when the frame landed: the one on screen; with nothing on screen, any request
 *    while a raise is in flight (pressed, its reply not back: the frame may be about it), but not
 *    the request the station last saw end; or one the agent pressed Cancel for (noted at the press,
 *    {@link HelpTelemetry.cancelSent}). The reducer decides the first two as the frame lands
 *    (`StationState.helpFrame`). A raise whose reply failed is no longer in flight, so an answer
 *    for it afterwards sends nothing, though the screen still shows it (LF24).
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
export function helpRefusedCode(code: string | null, status: number | null): AgencyHelpRefusedCode {
  if (code === 'floor_assist_disabled' || code === 'help_not_on_call' || code === 'session_ended') return code;
  if (status === 404) return 'not_found';
  // `apiFetch` throws an `ApiError` with the status for every answer; a fetch that got none throws without one.
  if (status === null) return 'network';
  return 'other';
}

/** How long a request was open, in `agency_floor_intervention`'s buckets (`secondsInStateBucket`). */
export function helpWaitBucket(elapsedMs: number | null): AgencyHelpWaitBucket {
  return secondsInStateBucket(elapsedMs);
}

export class HelpTelemetry {
  /** Requests whose `raised` was sent. */
  private readonly raised = new Set<string>();
  /** Requests whose end (cancelled, answered or expired) was sent. */
  private readonly ended = new Set<string>();
  /** Requests the agent pressed Cancel for. */
  private readonly cancelling = new Set<string>();

  /** @param elapsed ms from a server instant to now, on the server-aligned clock (`ServerClock.since`). */
  constructor(private readonly elapsed: (raisedAt: string) => number | null) {}

  /** A raise's answer: the first naming a request not yet reported is the raise. */
  raiseAnswered(help: Pick<AgencySessionHelp, 'raised_at'> | null, where: HelpWhere): void {
    if (help === null || typeof help.raised_at !== 'string' || this.raised.has(help.raised_at)) return;
    this.raised.add(help.raised_at);
    trackAgencyHelpRaised({ surface: where.surface, on_call: where.onCall });
  }

  /** The agent pressed Cancel on `raisedAt`: its frames are in scope from now on. */
  cancelSent(raisedAt: string): void {
    this.cancelling.add(raisedAt);
  }

  /** A Need help frame the station heard (`StationState.helpFrame`), each time one lands. */
  frameSeen(
    heard: { frame: { event: 'help_answered'; raised_at: string; how: 'listen' | 'message' } | { event: 'help_cleared'; raised_at: string; reason: string }; inScope: boolean } | null,
  ): void {
    if (heard === null) return;
    const { frame } = heard;
    const raisedAt = frame.raised_at;
    if (!heard.inScope && !this.cancelling.has(raisedAt)) return;
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
  refused(action: 'raise' | 'cancel', code: string | null, status: number | null): void {
    trackAgencyHelpRefused({ action, code: helpRefusedCode(code, status) });
  }

  /** Sends `send` once for the request: its first end wins. */
  private end(raisedAt: string, send: () => void): void {
    if (this.ended.has(raisedAt)) return;
    this.ended.add(raisedAt);
    send();
  }

  private waitBucket(raisedAt: string): AgencyHelpWaitBucket {
    return helpWaitBucket(this.elapsed(raisedAt));
  }
}
