import type { FastifyRequest, FastifyReply } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import {
  RecordingAccessRefusedError,
  type RecordingAccess,
  type RecordingAccessResolver,
  type RecordingCallRef,
} from '../telephony/recording-access.js';

/*
 * What protects a recording fetch is a host allow-list: `recordingHostMatches` decides
 * whether a URL may be fetched AT ALL, on the first URL and on every redirect hop.
 * Which hosts, and which headers go with the first request, is per carrier and per
 * call (`telephony/recording-access.ts`, B21): VoiceLink's recordings are public
 * carrier-hosted MP3s (nothing attached); a BYOC carrier's are fetched with the
 * tenant's credential, sent to its exact recording hosts and never past a redirect.
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
 * recording webhook, so anyone who can forge one can choose the string this
 * function inspects. `includes()` matches the host in
 * the userinfo position (`https://media.plivo.com@evil.example/x`) and anywhere
 * in the path or query (`https://evil.example/media.plivo.com`), both of which
 * resolve to the attacker's host. Parsing the URL and comparing the normalised
 * hostname is what makes "is this the carrier's host" mean what it reads as.
 *
 * Matching is exact-or-subdomain (`api.plivo.com` and `foo.plivo.com` match
 * `plivo.com`; `plivo.com.evil.example` does not), or exact only with `exact`, and an
 * unparseable URL matches nothing.
 */
export function recordingHostMatches(
  rawUrl: string,
  domains: readonly string[],
  /** Exact host only, no subdomains: the rule for a fetch that carries a credential (B21). */
  exact = false,
): boolean {
  const hostname = recordingHostname(rawUrl);
  if (hostname === null) return false;
  return domains.some((d) => {
    const domain = d.toLowerCase();
    return hostname === domain || (!exact && hostname.endsWith(`.${domain}`));
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
        : `Recording host ${host === null ? '(unparseable or non-https URL)' : `"${host}"`} is not on the recording-host allow-list`
          + (hop > 0 ? ` (redirect hop ${hop})` : ''),
    );
    this.name = 'RecordingHostRefusedError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The request headers a redirect hop may carry: `Range` only. It is the byte offset the
 * viewer asked for, carries no credential, and the hop serves the same resource, so
 * dropping it would turn a seek through a redirect into a full download from byte 0.
 * Everything else (Authorization above all) is sent to the first URL only.
 */
const REDIRECT_SAFE_HEADERS: ReadonlySet<string> = new Set(['range']);

function redirectSafeHeaders(headers: RequestInit['headers']): Record<string, string> {
  const kept: Record<string, string> = {};
  if (!headers) return kept;
  new Headers(headers).forEach((value, name) => {
    if (REDIRECT_SAFE_HEADERS.has(name.toLowerCase())) kept[name] = value;
  });
  return kept;
}

export interface FetchAllowedOptions {
  /** Hosts match exactly, no subdomains (a credentialed fetch; see `RecordingAccess`). */
  exactHosts?: boolean;
}

/**
 * `fetch` that checks the allow-list on EVERY hop. `redirect: 'follow'` would
 * check only the first URL, so an allow-listed host answering 302 to an internal
 * address (169.254.169.254, localhost) would be fetched: SSRF.
 * Each `Location` is resolved against the current URL and must be https and on the
 * list; at most {@link MAX_RECORDING_REDIRECTS} hops are followed.
 *
 * `init.headers` go to the FIRST URL only. A redirect hop carries `Range` and nothing
 * else, so a credential (B21) never follows a redirect, whoever answers it.
 * Throws {@link RecordingHostRefusedError}; other fetch errors propagate.
 */
export async function fetchWithAllowedRedirects(
  url: string,
  init: RequestInit,
  allowedHosts: readonly string[],
  opts: FetchAllowedOptions = {},
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!recordingHostMatches(current, allowedHosts, opts.exactHosts === true)) {
      throw new RecordingHostRefusedError(recordingHostname(current), 'off_list', hop);
    }
    const hopInit: RequestInit = hop === 0
      ? { ...init, redirect: 'manual' }
      : { ...init, headers: redirectSafeHeaders(init.headers), redirect: 'manual' };
    const res = await fetch(current, hopInit);
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

/** The call-row fields the proxy reads. */
export type ProxiedRecordingCall = RecordingCallRef & { id: string; recording_url: string | null };

/**
 * Proxy a call's recording from the carrier to the client. Forwards Range
 * requests and surfaces upstream 206 Partial Content responses so HTML5
 * audio seeking works on long recordings.
 *
 * The call's own provider, pinned credential and tenant decide the hosts and headers
 * (`resolveAccess`). A refused access (a revoked credential, a BYOC call with none, an
 * unknown provider) is a 404 `recording_unavailable`, before any fetch. A URL, or a
 * redirect hop, whose host is off the allow-list is a 502, rather than fetching
 * whatever `recording_url` says.
 */
export async function proxyCallRecording(
  callRecord: ProxiedRecordingCall,
  request: FastifyRequest,
  reply: FastifyReply,
  resolveAccess: RecordingAccessResolver,
): Promise<FastifyReply> {
  if (!callRecord.recording_url) {
    return reply.code(404).send({ error: 'Not Found', message: 'No recording available for this call' });
  }

  let access: RecordingAccess;
  try {
    access = await resolveAccess(callRecord);
  } catch (err) {
    if (err instanceof RecordingAccessRefusedError) {
      log.warn(
        {
          callId: callRecord.id, provider: err.provider, credentialId: err.credentialId,
          reason: err.reason, credentialKind: err.credentialKind,
        },
        'Recording access refused; not proxying',
      );
      return reply.code(404).send({
        error: 'Not Found',
        code: 'recording_unavailable',
        message: 'This recording is no longer available',
      });
    }
    log.error({ err, callId: callRecord.id }, 'Error resolving recording access');
    return reply.code(502).send({ error: 'Bad Gateway', message: 'Failed to fetch recording' });
  }

  const headers: Record<string, string> = { ...access.headers };
  const range = request.headers['range'];
  if (typeof range === 'string' && range.length > 0) headers['Range'] = range;

  try {
    const upstream = await fetchWithAllowedRedirects(
      callRecord.recording_url, { headers }, access.allowedHosts, { exactHosts: access.exactHosts },
    );
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
        'Recording URL is not on the recording-host allow-list; refusing to proxy',
      );
      return reply.code(502).send({
        error: 'Bad Gateway',
        message: 'The recording is not hosted on an allowed carrier host',
      });
    }
    // The error is logged without the request init: it may hold a credential.
    log.error({ err, callId: callRecord.id }, 'Error proxying recording');
    return reply.code(502).send({ error: 'Bad Gateway', message: 'Failed to fetch recording' });
  }
}
