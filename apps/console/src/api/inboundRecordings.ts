import { API_BASE } from '../config';
import { ApiError, apiFetch } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import { fetchAudioBlobUrl, type BlobAudio } from './blobAudio';
import { parseInboundRefusal, type InboundRefusal } from './inbound';
import type {
  AgencyInboundStandardRecording,
  AgencyInboundClipInvalidReason,
  AgencyInboundClipOption,
  AgencyInboundClipResponse,
  AgencyInboundClipRouteRef,
} from '../types/inbound';

/**
 * The account's recordings for inbound routes (`docs/inbound.md` §8.4), uploaded and deleted from
 * the route editor:
 *
 *   POST   /proxy/agency/inbound/clips       multipart (`name`, then `file`) → 201 { clip }
 *   DELETE /proxy/agency/inbound/clips/:id   → 204; 409 `inbound_clip_in_use` naming the routes
 *   GET    /proxy/agency/inbound/clips/:id/audio                   → the recording's bytes (preview)
 *   GET    /proxy/agency/inbound/clips/standard/:recording/audio   → one of our standard recordings (preview)
 *
 * The list is `listInboundClips` (`./inbound.ts`). Both resolve to a result, not a throw: a
 * refusal is something the admin acts on (another file, another name, a route to change first).
 */

const CLIPS = `${API_BASE}/proxy/agency/inbound/clips`;

/** An upload or delete refused: the inbound refusal, with why an upload was refused and which routes hold a recording. */
export interface RecordingRefusal extends InboundRefusal {
  uploadReason: AgencyInboundClipInvalidReason | null;
  routes: AgencyInboundClipRouteRef[];
}

export type RecordingResult<T> = { ok: true; value: T } | { ok: false; refusal: RecordingRefusal };

const UPLOAD_REASONS: ReadonlySet<string> = new Set<AgencyInboundClipInvalidReason>([
  'no_file', 'unsupported_type', 'too_large', 'too_long', 'empty', 'undecodable', 'name_invalid',
]);

function recordingRefusal(err: unknown): RecordingRefusal {
  const base = parseInboundRefusal(err);
  const raw = err && typeof err === 'object' ? (err as { details?: unknown }).details : undefined;
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const reason = body['upload_reason'];
  const routes = Array.isArray(body['routes'])
    ? (body['routes'] as unknown[]).filter(
        (r): r is AgencyInboundClipRouteRef =>
          !!r && typeof r === 'object' && typeof (r as { route_id?: unknown }).route_id === 'string'
          && typeof (r as { name?: unknown }).name === 'string',
      )
    : [];
  return {
    ...base,
    // The 413 the multipart limit itself may answer, before the route runs.
    uploadReason: typeof reason === 'string' && UPLOAD_REASONS.has(reason)
      ? (reason as AgencyInboundClipInvalidReason)
      : base.status === 413 ? 'too_large' : null,
    routes,
  };
}

/**
 * Upload one recording. Multipart, so it uses `fetch` with the shared auth headers (`apiFetch`
 * would set a JSON content type and break the boundary). The name goes before the file: the
 * server reads the fields that precede it.
 */
export async function uploadInboundRecording(
  file: File,
  name: string,
  tenantId?: string,
  accountId?: string,
): Promise<RecordingResult<AgencyInboundClipOption>> {
  const form = new FormData();
  if (name.trim()) form.append('name', name.trim());
  form.append('file', file);
  try {
    const headers = await buildAuthHeaders(tenantId, accountId);
    const res = await fetch(CLIPS, { method: 'POST', headers, body: form });
    if (!res.ok) {
      let details: unknown;
      try {
        details = await res.json();
      } catch {
        details = undefined;
      }
      captureApiError(CLIPS, res);
      throw new ApiError(res.status, details, res.headers.get('x-request-id') ?? undefined);
    }
    const body = (await res.json()) as AgencyInboundClipResponse;
    return { ok: true, value: body.clip };
  } catch (err) {
    return { ok: false, refusal: recordingRefusal(err) };
  }
}

/** Delete one recording no live route plays. */
export async function deleteInboundRecording(
  clipId: string,
  tenantId?: string,
  accountId?: string,
): Promise<RecordingResult<void>> {
  try {
    await apiFetch<void>(`${CLIPS}/${encodeURIComponent(clipId)}`, { method: 'DELETE' }, tenantId, accountId);
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, refusal: recordingRefusal(err) };
  }
}

// ─── Preview ────────────────────────────────────────────────────────────────

/** What a preview plays: one of the account's recordings, or one of our standard recordings. */
export type RecordingSource = { kind: 'uploaded'; clipId: string } | { kind: 'standard'; recording: AgencyInboundStandardRecording };

export const RECORDING_GONE_COPY = 'This recording no longer exists. Someone may have deleted it.';
export const RECORDING_FAILED_COPY = 'We couldn’t load the recording. Try again in a moment.';

/** The preview's path: always our own API, the id or name encoded. */
export function recordingAudioUrl(source: RecordingSource): string {
  return source.kind === 'uploaded'
    ? `${CLIPS}/${encodeURIComponent(source.clipId)}/audio`
    : `${CLIPS}/standard/${encodeURIComponent(source.recording)}/audio`;
}

/**
 * A recording as a blob URL for an `<audio>` element: the route needs the console's bearer token,
 * which an `<audio src>` cannot send (the Missed list's voicemail is fetched the same way). The
 * caller revokes the URL when it is done with it. Never throws.
 */
export async function fetchRecordingBlobUrl(
  source: RecordingSource,
  tenantId: string,
  accountId?: string,
): Promise<BlobAudio> {
  return fetchAudioBlobUrl(recordingAudioUrl(source), tenantId, accountId, { gone: RECORDING_GONE_COPY, failed: RECORDING_FAILED_COPY });
}
