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
import type { StationHelpNotice } from '../agencyStationReducer';

/**
 * Need help's telemetry (LF39): `agency_help_raised`, `_cancelled`, `_answered`, `_expired` and
 * `_refused`, each at most once per request (`raised_at`) on a page. The mobile app sends the same
 * names and properties, by the same rules.
 *
 *  - **raised**: the first raise answer (`POST /help`'s reply with a request) naming a `raised_at`
 *    this page has not reported, whether or not it is still on screen when it lands (a slow reply
 *    after the frames ended it, or after a `ready.help` put it on screen, still counts). A
 *    `ready.help` or a frame never sends it ({@link HelpTelemetry.raiseAnswered}).
 *  - **cancelled**: only on `help_cleared { cancelled }` for the request, the server's proof the
 *    cancel won, on whichever side of the cancel's reply it lands ({@link HelpTelemetry.clearSeen}):
 *    "for the request" is the one on screen when the clear landed, or one the agent sent a cancel
 *    for (the reply, `help: null` whether the cancel won or lost, may have cleared it first). The
 *    reply itself sends nothing: it cannot tell a won cancel from one that lost to a supervisor.
 *  - **answered** / **expired**: the notice the screen shows once the request ended
 *    ({@link HelpTelemetry.noticeSeen}): `help_answered`, or a `help_cleared` `answered` alone
 *    (`how: 'unknown'`), kept by the station's reducer on either side of a cancel's reply, so a
 *    cancel that lost the race is that answer; `expired` for the request on screen, or for one the
 *    agent had sent a cancel for (a cancel that lost to the lapse).
 *  - A `session_ended` clear, and any frame about an earlier request (LF15), sends nothing.
 *
 * One of cancelled, answered and expired per request, whichever came first; duplicate frames and
 * reconnects send nothing again.
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
  /** Requests the agent sent a cancel for. */
  private readonly cancelling = new Set<string>();

  /** @param elapsed ms from a server instant to now, on the server-aligned clock (`ServerClock.since`). */
  constructor(private readonly elapsed: (raisedAt: string) => number | null) {}

  /** A raise's answer: the first naming a request not yet reported is the raise. */
  raiseAnswered(help: Pick<AgencySessionHelp, 'raised_at'> | null, where: HelpWhere): void {
    if (help === null || typeof help.raised_at !== 'string' || this.raised.has(help.raised_at)) return;
    this.raised.add(help.raised_at);
    trackAgencyHelpRaised({ surface: where.surface, on_call: where.onCall });
  }

  /** The agent pressed cancel on `raisedAt` (before its answer). */
  cancelSent(raisedAt: string): void {
    this.cancelling.add(raisedAt);
  }

  /** A `help_cleared` the station heard (the station's `helpCleared`), each time one lands. */
  clearSeen(cleared: { frame: { raised_at: string; reason: string }; onScreen: boolean } | null): void {
    if (cleared === null) return;
    const { frame, onScreen } = cleared;
    if (!onScreen && !this.cancelling.has(frame.raised_at)) return;
    if (frame.reason === 'cancelled') this.end(frame.raised_at, () => trackAgencyHelpCancelled({ wait_bucket: this.waitBucket(frame.raised_at) }));
    else if (frame.reason === 'expired') this.end(frame.raised_at, () => trackAgencyHelpExpired());
  }

  /** What the screen says about a request that ended (the station's `helpNotice`), each time it changes. */
  noticeSeen(notice: StationHelpNotice | null): void {
    if (notice === null) return;
    if (notice.kind === 'expired') {
      this.end(notice.raised_at, () => trackAgencyHelpExpired());
      return;
    }
    const how = notice.how ?? 'unknown';
    this.end(notice.raised_at, () => trackAgencyHelpAnswered({ how, wait_bucket: this.waitBucket(notice.raised_at) }));
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
