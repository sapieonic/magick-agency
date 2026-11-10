import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';

/** An audio file fetched for an `<audio>` element, or the copy that says why it cannot play. */
export type BlobAudio = { status: 'ready'; url: string } | { status: 'unavailable'; message: string };

/**
 * An audio route of our own API as a blob URL: the route needs the console's bearer token, which
 * an `<audio src>` cannot send. A 404 reads as `gone`, anything else as `failed`. The caller
 * revokes the URL when it is done with it. Never throws.
 */
export async function fetchAudioBlobUrl(
  url: string,
  tenantId: string,
  accountId: string | undefined,
  copy: { gone: string; failed: string },
): Promise<BlobAudio> {
  try {
    const headers = await buildAuthHeaders(tenantId, accountId);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      captureApiError(url, res);
      return { status: 'unavailable', message: res.status === 404 ? copy.gone : copy.failed };
    }
    const blob = await res.blob();
    return { status: 'ready', url: URL.createObjectURL(blob) };
  } catch {
    return { status: 'unavailable', message: copy.failed };
  }
}
