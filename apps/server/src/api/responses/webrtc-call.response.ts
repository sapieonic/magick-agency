import { resolveClientRecordingUrl } from '../../utils/recording-url-resolver.js';
import type { WebRtcCallRecord } from '@magick-agency/db/models/agency-call.model';

/**
 * Shape a WebRTC call row for the API. An explicit allow-list (deny-by-default,
 * like AI calls' `formatCallResponse`) so a future column added to `webrtc_calls`
 * isn't auto-exposed. `recording_url` is replaced with an authenticated proxy
 * path (when a recording exists) so the raw, auth-gated VoBiz media URL is never
 * leaked; for unauthenticated `<audio src>` playback, clients fetch a signed URL
 * from the surface's own `recording-url` route.
 *
 * ── Why `recordingPath` is a required argument ──────────────────────────────
 *
 * `webrtc_calls` serves two products, and each has its own routes
 * (`docs/agency-dialer-design.md` §7b). A softphone call's recording is at
 * `/api/v1/webrtc-call/:id/recording`; an agency leg's is under its campaign's
 * attempt, and the softphone path would 404 for it because that plugin's reads
 * are pinned to the dialer scope.
 *
 * So the path cannot be derived from the record — only the caller knows which
 * surface it is answering for. Making it required rather than defaulting to the
 * softphone path is the same choice the repository's `scope` parameter makes: a
 * default would silently hand agency callers a dead link, and a dead media link
 * looks like a missing recording rather than a wiring bug.
 *
 * `campaign_id` is deliberately NOT exposed. It is the internal scope
 * discriminator, and a client that branches on it would be reimplementing the
 * boundary the server already enforces.
 *
 * ── The one provider that overrides `recordingPath` ─────────────────────────
 *
 * A direct-recording provider (VoiceLink) serves its recording as a public URL
 * on a host our own egress is firewalled from, so there the raw URL IS the
 * playable resource and pointing at any proxy path — this surface's or another's
 * — would 502. `resolveClientRecordingUrl` makes that call from the same
 * allowlist AI calls use, so the surfaces cannot drift. Consumers therefore get
 * either an absolute URL or a relative path and must not blindly prepend an API
 * base.
 */
export function formatWebRtcCallResponse(record: WebRtcCallRecord, recordingPath: string) {
  return {
    id: record.id,
    tenant_id: record.tenant_id,
    account_id: record.account_id,
    caller_id: record.caller_id,
    destination_phone: record.destination_phone,
    provider: record.provider,
    provider_call_id: record.provider_call_id,
    status: record.status,
    outcome: record.outcome,
    error_code: record.error_code,
    error_message: record.error_message,
    initiated_by: record.initiated_by,
    metadata: record.metadata,
    recording_requested: record.recording_requested,
    recording_url: resolveClientRecordingUrl({
      recordingUrl: record.recording_url,
      provider: record.provider,
      proxyPath: recordingPath,
    }),
    recording_duration_seconds: record.recording_duration_seconds,
    // ── Post-call analysis (dialer) ──
    analysis_profile_id: record.analysis_profile_id,
    analysis_status: record.analysis_status,
    // List-only scalar sentiment (projected in SQL from call_analysis via
    // WEBRTC_LIST_COLUMNS); undefined on the detail path, which returns the blob.
    ...(record.analysis_sentiment_label !== undefined
      ? { analysis_sentiment_label: record.analysis_sentiment_label }
      : {}),
    call_analysis: record.call_analysis,
    conversation_log: record.conversation_log,
    transcript_meta: record.transcript_meta,
    answered_at: record.answered_at,
    ended_at: record.ended_at,
    duration_seconds: record.duration_seconds,
    talk_time_seconds: record.talk_time_seconds,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}
