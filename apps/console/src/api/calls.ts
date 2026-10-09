import { ENDPOINTS } from '../config';
import { buildAuthHeaders } from './authHeaders';
import { apiFetch } from './client';
import { captureApiError } from './error-analytics';

/*
 * PORT NOTE (magick-agency): of cusui's `src/api/calls.ts` @ ee5beb44 (the AI
 * call API) only the two functions `components/calls/CallDetailSections.tsx`
 * imports are kept, verbatim — they are that shared component's DEFAULTS, and
 * the agency attempt page overrides both (its own recording fetcher, and no
 * retry affordance at all). Listing, starting, ending, bulk, batch cancel,
 * concurrency and export calls are not ported.
 */

export function retryAnalysis(tenantId: string, callId: string, accountId?: string): Promise<{ message: string; analysis_status: string }> {
  return apiFetch(`${ENDPOINTS.proxy.calls.get(callId)}/retry-analysis`, {
    method: 'POST',
  }, tenantId, accountId);
}

/**
 * Fetch call recording as a Blob URL for playback in an <audio> element.
 * Returns null if no recording is available.
 */
export async function fetchRecordingBlobUrl(tenantId: string, callId: string, accountId?: string): Promise<string | null> {
  const headers = await buildAuthHeaders(tenantId, accountId);

  const res = await fetch(ENDPOINTS.proxy.calls.recording(callId), { headers });
  if (!res.ok) {
    if (res.status !== 404) captureApiError(ENDPOINTS.proxy.calls.recording(callId), res);
    return null;
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
