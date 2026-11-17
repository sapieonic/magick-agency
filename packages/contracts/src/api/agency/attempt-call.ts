/**
 * The agency's own call detail — `GET /agency/campaigns/:id/attempts/:attemptId`
 * (served under `/proxy/agency/...`).
 *
 * These two wire shapes are the envelope that carries the `webrtc-call.ts`
 * record an agency campaign call shows, so they live beside it.
 */

import type { AgencyAttempt } from './agency-spine';
import type { AgencyCallListenSession } from './live-calls';
import type { WebRtcCallRecord } from './webrtc-call';

/**
 * Why the call is or is not here. The dialer runtime's own vocabulary, forwarded through
 * the public API layer untouched.
 *
 * The distinction between the last two is not cosmetic. The attempt→call link is
 * deliberately un-FK'd and both sides purge on independent retention windows, so
 * an attempt routinely outlives its call — and "we never dialled this number" is a
 * different answer to a compliance question than "we dialled it and the recording
 * has aged out". Collapsing them into one empty state would make the spine unable
 * to give either.
 */
export type AgencyCallAvailability = 'available' | 'purged' | 'never_placed';

/** One attempt, plus its call when the call still exists. */
export interface AgencyAttemptCallDetail {
  attempt: AgencyAttempt;
  /** Null whenever `call_availability` is not `available`. */
  call: WebRtcCallRecord | null;
  call_availability: AgencyCallAvailability;
  /**
   * Who listened to the call live ("Listened to by", docs/listening.md LS13, LS16 k): the sessions
   * that went live, earliest first, added by the public API layer for an `agency.supervise` caller.
   * Absent when there is no call or the read failed; the page then shows no section.
   */
  listen_sessions?: AgencyCallListenSession[];
}
