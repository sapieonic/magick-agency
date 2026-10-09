/**
 * The agency's own call detail — `GET /agency/campaigns/:id/attempts/:attemptId`
 * in cusui's terms (`/proxy/agency/...` in MagickVoice).
 *
 * PORT NOTE (magick-agency): verbatim excerpt of
 * `magick-comms-cusui/src/api/agencySpine.ts:115-135` (cusui v2.96.0,
 * ee5beb4400ec1fb5fdf6049871681ae6875e8d29). In cusui these two wire shapes are
 * declared inside the API module rather than under `src/types/`; they are the
 * envelope that carries the `webrtc-call.ts` record an agency campaign call shows,
 * so they are ported beside it. Only the import paths changed.
 */

import type { AgencyAttempt } from './agency-spine';
import type { WebRtcCallRecord } from './webrtc-call';

/**
 * Why the call is or is not here. Core's own vocabulary, forwarded through
 * master untouched (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b).
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
}
