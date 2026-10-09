import type { FastifyRequest, FastifyReply } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';

/*
 * VoiceLink recordings are public carrier-hosted MP3s, so nothing is attached to
 * the upstream request. What protects the fetch is a host allow-list:
 * `recordingHostMatches` decides whether a URL may be fetched AT ALL.
 * `proxyCallRecording` streams the body and forwards Range.
 */

const log = createChildLogger({ component: 'recording-proxy' });

// Re-exported so callers of this module can reach it here too.
export { isDirectRecordingProvider } from './recording-url-resolver.js';

/**
 * The normalised hostname of an https URL, or null for an unparseable or non-https
 * one. Factored out of `recordingHostMatches` (same parse, same scheme rule) so a
 * refusal can name the host without re-parsing differently.
 */
export function recordingHostname(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    // Scheme is part of the question. `recording_url` is persisted from an
    // unauthenticated carrier callback, so an `http://` value is reachable by anyone
    // who can forge one. No carrier serves recording media over http.
    if (parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * Does `rawUrl` point at a host we actually recognise as this carrier's?
 *
 * A substring test (`recordingUrl.includes('media.plivo.com')`) is NOT a host
 * check and must never be used here, because the value being tested is
 * ATTACKER-REACHABLE: `recording_url` is persisted as received from the carrier's
 * unauthenticated recording webhook, so anyone who can guess a call id can
 * choose the string this function inspects. `includes()` matches the host in
 * the userinfo position (`https://media.plivo.com@evil.example/x`) and anywhere
 * in the path or query (`https://evil.example/media.plivo.com`), both of which
 * resolve to the attacker's host. Parsing the URL and comparing the normalised
 * hostname is what makes "is this the carrier's host" mean what it reads as.
 *
 * Matching is exact-or-subdomain (`api.plivo.com` and `foo.plivo.com` match
 * `plivo.com`; `plivo.com.evil.example` does not), and an unparseable URL
 * matches nothing.
 */
export function recordingHostMatches(rawUrl: string, domains: readonly string[]): boolean {
  const hostname = recordingHostname(rawUrl);
  if (hostname === null) return false;
  return domains.some((d) => {
    const domain = d.toLowerCase();
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}

/** Redirect hops followed before a fetch is refused. */
export const MAX_RECORDING_REDIRECTS = 3;

/** A URL (the first, or a redirect hop) is not on the recording-host allow-list. */
export class RecordingHostRefusedError extends Error {
  constructor(
    public readonly host: string | null,
    public readonly reason: 'off_list' | 'too_many_redirects',
    public readonly hop: number,
  ) {
    super(
      reason === 'too_many_redirects'
        ? `Recording fetch followed more than ${MAX_RECORDING_REDIRECTS} redirects`
        : `Recording host ${host === null ? '(unparseable or non-https URL)' : `"${host}"`} is not on the VoiceLink recording-host allow-list`
          + (hop > 0 ? ` (redirect hop ${hop})` : ''),
    );
    this.name = 'RecordingHostRefusedError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch` that checks the allow-list on EVERY hop. `redirect: 'follow'` would
 * check only the first URL, so an allow-listed host answering 302 to an internal
 * address (169.254.169.254, localhost) would be fetched: SSRF.
 * Each `Location` is resolved against the current URL and must be https and on the
 * list; at most {@link MAX_RECORDING_REDIRECTS} hops are followed.
 * Throws {@link RecordingHostRefusedError}; other fetch errors propagate.
 */
export async function fetchWithAllowedRedirects(
  url: string,
  init: RequestInit,
  allowedHosts: readonly string[],
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!recordingHostMatches(current, allowedHosts)) {
      throw new RecordingHostRefusedError(recordingHostname(current), 'off_list', hop);
    }
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    // A hop we do not hand back is never read: release its connection now rather
    // than at GC (undici pins the socket until the body is consumed or cancelled).
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_RECORDING_REDIRECTS) {
      throw new RecordingHostRefusedError(null, 'too_many_redirects', hop + 1);
    }
    try {
      current = new URL(location, current).toString();
    } catch {
      throw new RecordingHostRefusedError(null, 'off_list', hop + 1);
    }
  }
}

/**
 * Proxy a call's recording from the carrier to the client. Forwards Range
 * requests and surfaces upstream 206 Partial Content responses so HTML5
 * audio seeking works on long recordings.
 *
 * Refuses (502) a URL, or a redirect hop, whose host is off `allowedHosts`, rather
 * than fetching whatever `recording_url` says.
 */
export async function proxyCallRecording(
  callRecord: { id: string; recording_url: string | null },
  request: FastifyRequest,
  reply: FastifyReply,
  allowedHosts: readonly string[],
): Promise<FastifyReply> {
  if (!callRecord.recording_url) {
    return reply.code(404).send({ error: 'Not Found', message: 'No recording available for this call' });
  }

  const headers: Record<string, string> = {};
  const range = request.headers['range'];
  if (typeof range === 'string' && range.length > 0) headers['Range'] = range;

  try {
    const upstream = await fetchWithAllowedRedirects(callRecord.recording_url, { headers }, allowedHosts);
    if (!upstream.ok && upstream.status !== 206) {
      log.warn(
        { callId: callRecord.id, status: upstream.status },
        'Failed to fetch recording from provider',
      );
      return reply
        .code(502)
        .send({ error: 'Bad Gateway', message: 'Failed to fetch recording from provider' });
    }

    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    const acceptRanges = upstream.headers.get('accept-ranges') || 'bytes';

    reply.code(upstream.status);
    reply.header('Content-Type', contentType);
    reply.header('Accept-Ranges', acceptRanges);
    if (contentLength) reply.header('Content-Length', contentLength);
    if (contentRange) reply.header('Content-Range', contentRange);
    reply.header('Cache-Control', 'private, max-age=3600');

    return reply.send(upstream.body);
  } catch (err) {
    if (err instanceof RecordingHostRefusedError) {
      log.warn(
        { callId: callRecord.id, host: err.host, reason: err.reason, hop: err.hop },
        'Recording URL is not on the VoiceLink recording-host allow-list; refusing to proxy',
      );
      return reply.code(502).send({
        error: 'Bad Gateway',
        message: 'The recording is not hosted on an allowed carrier host',
      });
    }
    log.error({ err, callId: callRecord.id }, 'Error proxying recording');
    return reply.code(502).send({ error: 'Bad Gateway', message: 'Failed to fetch recording' });
  }
}
