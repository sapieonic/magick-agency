/*
 * PORT NOTE (magick-agency): ported from core `src/transcription/recording-fetcher.ts`
 * (v1.123.2) and REWORKED (plan §4): `telephony_credential_id` credential resolution
 * (`buildUpstreamHeaders` / `resolveRecordingAuthSource`) is dropped; the fetch is
 * unauthenticated and gated by the VoiceLink recording-host allow-list. Everything
 * from the response onward (status mapping, byte cap, streaming, mime inference) is
 * core's, verbatim.
 */
import { createChildLogger } from '@magick-agency/observability';
import { fetchWithAllowedRedirects, RecordingHostRefusedError } from '../utils/recording-proxy.js';
import { TranscriptionError } from './types.js';

const log = createChildLogger({ component: 'recording-fetcher' });

export interface FetchRecordingOptions {
  /** Hard cap on buffered bytes — the stream is aborted the moment it's exceeded (C4). */
  maxBytes: number;
  /** Overall request timeout (ms). */
  timeoutMs: number;
  /**
   * VoiceLink recording hosts this fetch may touch (plan §4). The URL's PARSED
   * hostname must be exact-or-subdomain of an entry; an empty list refuses every
   * fetch. Required rather than defaulted: a default that type-checks everywhere
   * audits nowhere, and the wrong default here is an SSRF.
   */
  allowedHosts: readonly string[];
}

export interface FetchedRecording {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Download a call recording's bytes for transcription.
 *
 * Nothing in the repo downloads recording bytes today — every existing path
 * *streams* to a client (`proxyCallRecording` returns `upstream.body`). This is
 * the first buffering consumer, so it must be defensive (spec C4):
 *
 *  - Sends NO credentials: a VoiceLink recording is a public carrier-hosted MP3.
 *    Core resolved a per-call carrier credential here (`telephony_credential_id`);
 *    that is gone with BYOC. In its place the URL's parsed hostname must be on the
 *    configured VoiceLink recording-host allow-list — `recording_url` is persisted
 *    from an unauthenticated carrier webhook, so it is attacker-reachable and an
 *    unchecked fetch would be an SSRF. A host off the list is a PERMANENT failure.
 *    Redirects are followed by hand (max 3), each hop re-checked: `redirect: 'follow'`
 *    would let an allow-listed host bounce the fetch to an internal address.
 *  - Streams the body with a running byte count and ABORTS the moment `maxBytes`
 *    is exceeded — never `await res.arrayBuffer()` on an unbounded remote response.
 *  - Uses `AbortSignal.timeout(timeoutMs)` so a hung upstream can't stall a worker.
 *  - Maps non-2xx to `TranscriptionError`; 401/403/404 are marked **non-retryable**
 *    (a permanently unfetchable recording must not burn 3 attempts).
 *
 * EGRESS: unlike the streaming proxy, this fetch has no client to fall back on —
 * it runs server-side, so the recording host must be reachable from this
 * service's own egress. That is NOT implied by the recording being playable in a browser:
 * `DIRECT_RECORDING_PROVIDERS` (see recording-url-resolver.ts) exists precisely
 * because a VoiceLink/Elision recording is reachable by an Indian end user and
 * historically was not reachable from our cloud. A blocked route surfaces here as
 * a TimeoutError or a network error, both of which default to **retryable**, so
 * the symptom is not "unreachable" — it is a dialer-analysis job that quietly
 * burns its whole retry budget and lands on `analysis_status='failed'`. If
 * analysis starts failing for one provider and only that provider, check egress
 * to its recording host before reading anything into the transcriber.
 */
export async function fetchRecordingBytes(
  recordingUrl: string,
  opts: FetchRecordingOptions,
): Promise<FetchedRecording> {
  let res: Response;
  try {
    // Allow-list checked on the first URL AND every redirect hop (SSRF).
    res = await fetchWithAllowedRedirects(
      recordingUrl,
      { signal: AbortSignal.timeout(opts.timeoutMs) },
      opts.allowedHosts,
    );
  } catch (err) {
    if (err instanceof RecordingHostRefusedError) {
      // Non-retryable: no number of attempts makes an off-list host acceptable.
      log.warn({ host: err.host, reason: err.reason, hop: err.hop }, 'Recording URL is not on the VoiceLink recording-host allow-list; refusing to fetch');
      throw new TranscriptionError('TRANSCRIPTION_FAILED', err.message, false);
    }
    // AbortSignal.timeout rejects with a TimeoutError (name === 'TimeoutError').
    if ((err as Error)?.name === 'TimeoutError') {
      throw new TranscriptionError('TIMEOUT', `Timed out fetching recording after ${opts.timeoutMs}ms`);
    }
    throw new TranscriptionError(
      'TRANSCRIPTION_FAILED',
      `Failed to fetch recording: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    // A permanently unfetchable recording (auth failure, gone) must not burn retries.
    const nonRetryable = res.status === 401 || res.status === 403 || res.status === 404;
    log.warn({ status: res.status, nonRetryable }, 'Recording fetch returned non-2xx');
    throw new TranscriptionError(
      'TRANSCRIPTION_FAILED',
      `Recording fetch failed with status ${res.status}`,
      !nonRetryable,
    );
  }

  const mimeType = inferMimeType(res.headers.get('content-type'), recordingUrl);

  // A Content-Length that already exceeds the cap lets us fail before streaming a byte.
  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > opts.maxBytes) {
    throw new TranscriptionError(
      'AUDIO_TOO_LARGE',
      `Recording is ${declaredLength} bytes, exceeds cap of ${opts.maxBytes}`,
      false,
    );
  }

  if (!res.body) {
    throw new TranscriptionError('TRANSCRIPTION_FAILED', 'Recording response had no body');
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        // Abort mid-stream — never buffer past the cap.
        await reader.cancel().catch(() => {});
        throw new TranscriptionError(
          'AUDIO_TOO_LARGE',
          `Recording exceeded byte cap of ${opts.maxBytes} while streaming`,
          false,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof TranscriptionError) throw err;
    if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') {
      throw new TranscriptionError('TIMEOUT', `Recording stream timed out after ${opts.timeoutMs}ms`);
    }
    throw new TranscriptionError(
      'TRANSCRIPTION_FAILED',
      `Error while streaming recording: ${(err as Error).message}`,
    );
  }

  const bytes = Buffer.concat(chunks, total);
  if (bytes.length === 0) {
    throw new TranscriptionError('UNSUPPORTED_AUDIO', 'Recording body was empty', false);
  }
  log.debug({ bytes: bytes.length, mimeType }, 'Fetched recording bytes');
  return { bytes, mimeType };
}

/** Resolve a mime type from the Content-Type header, falling back to a URL-extension guess. */
function inferMimeType(contentType: string | null, url: string): string {
  if (contentType) {
    const bare = contentType.split(';')[0]?.trim();
    if (bare && bare.startsWith('audio/')) return bare;
    // Some providers serve recordings as application/octet-stream — infer from the URL.
    if (bare && bare !== 'application/octet-stream' && bare.startsWith('audio')) return bare;
  }
  const lower = url.toLowerCase();
  if (lower.includes('.wav')) return 'audio/wav';
  if (lower.includes('.ogg')) return 'audio/ogg';
  if (lower.includes('.m4a') || lower.includes('.mp4')) return 'audio/mp4';
  if (lower.includes('.flac')) return 'audio/flac';
  return 'audio/mpeg';
}
