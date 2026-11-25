import type { FastifyRequest, FastifyReply } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import type { RecordingRedirectBody } from '@magick-agency/contracts/api/agency/webrtc-call';
import { trackRecordingFetchFailure, type RecordingFetchFailureReason } from '@magick-agency/observability/metrics/voice';
import { recordingRedirectsToCarrier } from './recording-url-resolver.js';
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
 * tenant's credential, sent to its recording media hosts only (Plivo: `media.plivo.com`
 * and its regional subdomains, never `api.plivo.com`) and never past a redirect.
 * `proxyCallRecording` streams the body and forwards Range, or, for a call pinned to a credential
 * on a carrier whose recordings are public (VoiceLink, CR12), checks the credential and the
 * host and then redirects the viewer to the recording rather than fetching it.
 */

const log = createChildLogger({ component: 'recording-proxy' });

// Re-exported so callers of this module can reach it here too.
export { isDirectRecordingProvider } from './recording-url-resolver.js';

/**
 * The normalised hostname of an https URL, or null for an unparseable or non-https one
 * or one with an empty label. Factored out of `recordingHostMatches` (same parse, same
 * scheme rule) so a refusal can name the host without re-parsing differently.
 */
export function recordingHostname(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    // Scheme is part of the question. `recording_url` is persisted from an
    // unauthenticated carrier callback, so an `http://` value is reachable by anyone
    // who can forge one. No carrier serves recording media over http.
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    // An empty label (`.media.plivo.com`, `a..media.plivo.com`) names no host: refused here
    // rather than matched as a "subdomain" and left to fail in DNS.
    if (host.split('.').includes('')) return null;
    return host;
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
 * Matching is exact-or-subdomain on a dot boundary (`aps1.media.plivo.com` matches
 * `media.plivo.com`; `evilmedia.plivo.com` and `media.plivo.com.evil.example` do not; and
 * `api.plivo.com` and `foo.plivo.com` would match `plivo.com`, which is why no list holds
 * an apex whose subdomains are not all recording hosts), or exact only with `exact`, and an
 * unparseable or non-https URL matches nothing.
 */
export function recordingHostMatches(
  rawUrl: string,
  domains: readonly string[],
  /** Exact host only, no subdomains (`RecordingAccess.exactHosts`; RC4's redirect hosts). */
  exact = false,
): boolean {
  const hostname = recordingHostname(rawUrl);
  if (hostname === null) return false;
  return domains.some((d) => {
    const domain = d.toLowerCase();
    return hostname === domain || (!exact && hostname.endsWith(`.${domain}`));
  });
}

/**
 * Release a response whose body will never be read, so its connection goes back now rather than
 * at GC (undici pins the socket until the body is consumed or cancelled). Never throws.
 */
export async function discardResponseBody(res: Response): Promise<void> {
  const body = res.body as { cancel?: () => Promise<void> } | null;
  if (typeof body?.cancel !== 'function') return;
  await body.cancel().catch(() => undefined);
}

/** Redirect hops followed before a fetch is refused. */
export const MAX_RECORDING_REDIRECTS = 3;

/**
 * A URL (the first, or a redirect hop) is not on the recording-host allow-list. Carries hosts
 * only, never a URL: a carrier's signed recording URL holds its secret in the path or query.
 * `host` is the refused URL's host (a redirect's TARGET at `hop > 0`; null when unparseable or
 * not https); `redirectedFrom` the host that answered with the redirect (null at hop 0).
 */
export class RecordingHostRefusedError extends Error {
  constructor(
    public readonly host: string | null,
    public readonly reason: 'off_list' | 'too_many_redirects',
    public readonly hop: number,
    public readonly redirectedFrom: string | null = null,
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
  /** Hosts match exactly, no subdomains (`RecordingAccess.exactHosts`). */
  exactHosts?: boolean;
  /**
   * Further hosts a REDIRECT hop may go to, matched exactly (`RecordingAccess.redirectHosts`,
   * RC4, operator config only). Never the first URL; the hop still carries no header but Range.
   */
  redirectHosts?: readonly string[];
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
  let redirectedFrom: string | null = null;
  const redirectHosts = opts.redirectHosts ?? [];
  for (let hop = 0; ; hop++) {
    const allowed = recordingHostMatches(current, allowedHosts, opts.exactHosts === true)
      || (hop > 0 && redirectHosts.length > 0 && recordingHostMatches(current, redirectHosts, true));
    if (!allowed) {
      throw new RecordingHostRefusedError(recordingHostname(current), 'off_list', hop, redirectedFrom);
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
    redirectedFrom = recordingHostname(current);
    if (hop >= MAX_RECORDING_REDIRECTS) {
      throw new RecordingHostRefusedError(null, 'too_many_redirects', hop + 1, redirectedFrom);
    }
    try {
      current = new URL(location, current).toString();
    } catch {
      throw new RecordingHostRefusedError(null, 'off_list', hop + 1, redirectedFrom);
    }
  }
}

/**
 * Why a fetch that threw did not return the audio (RC3; `recording_fetch_failures_total`'s
 * `reason`): an allow-list refusal by where it struck, a timeout (an `AbortSignal.timeout`, or
 * an abort `timedOut` says was ours), else the network.
 */
export function recordingFetchErrorReason(err: unknown, timedOut = false): RecordingFetchFailureReason {
  if (err instanceof RecordingHostRefusedError) {
    if (err.reason === 'too_many_redirects') return 'too_many_redirects';
    return err.hop > 0 ? 'redirect_refused' : 'host_not_allowed';
  }
  const name = (err as { name?: unknown } | null)?.name;
  if (timedOut || name === 'TimeoutError') return 'timeout';
  return 'network';
}

/** Why a carrier's non-2xx answer did not return the audio (RC3). */
export function recordingUpstreamStatusReason(status: number): RecordingFetchFailureReason {
  if (status === 401 || status === 403) return 'upstream_unauthorized';
  if (status === 404 || status === 410) return 'upstream_not_found';
  return 'upstream_status';
}

/**
 * How long the playback proxy waits for the carrier's response headers (RC3). Before RC3 a
 * carrier host that never answered held the request open until the viewer's browser gave up;
 * now it is a 504 with `reason: timeout` in the log and the failure counter. Only the headers
 * are timed: a long recording still streams for as long as it takes.
 */
export const RECORDING_PROXY_HEADERS_TIMEOUT_MS = 20_000;

/**
 * Whether the request's `Accept` names `application/json` itself (not through a wildcard), with
 * a non-zero quality. A script that fetches a recording to make a blob asks this way: it cannot
 * follow a cross-origin redirect to a carrier that sends no CORS headers, so it is told the URL
 * instead (CR12). An `<audio src>` asks for audio or for anything (a wildcard), and keeps the 302.
 */
export function acceptsJsonRedirect(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(',') : accept;
  if (!value) return false;
  return value.split(',').some((part) => {
    const [type, ...params] = part.split(';').map((p) => p.trim().toLowerCase());
    if (type !== 'application/json') return false;
    const q = params.find((p) => p.startsWith('q='));
    if (q === undefined) return true;
    const quality = Number(q.slice(2));
    return Number.isFinite(quality) && quality > 0;
  });
}

/** The call-row fields the proxy reads. */
export type ProxiedRecordingCall = RecordingCallRef & {
  id: string;
  recording_url: string | null;
  /** A read row has the URL nulled already when false (RC1); checked again here, the bytes' last door. */
  recording_requested?: boolean;
};

/**
 * Proxy a call's recording from the carrier to the client. Forwards Range
 * requests and surfaces upstream 206 Partial Content responses so HTML5
 * audio seeking works on long recordings.
 *
 * The call's own provider, pinned credential and tenant decide the hosts and headers
 * (`resolveAccess`). A call pinned to a credential on a carrier whose recordings are public
 * (`recordingRedirectsToCarrier`, CR12) is answered 302 to its URL once the access is resolved
 * and the URL's host passes the allow-list, with `Cache-Control: no-store`; nothing is fetched.
 * When the request's `Accept` names `application/json` ({@link acceptsJsonRedirect}), the same
 * answer is `200 { redirect_url }` (`RecordingRedirectBody`), still `no-store`: the console's
 * blob fetchers cannot follow a cross-origin redirect to a host that sends no CORS headers.
 * A refused access (a revoked credential, a BYOC call with none, an
 * unknown provider) is a 404 `recording_unavailable`, before any fetch. A URL, or a
 * redirect hop, whose host is off the allow-list is a 502, rather than fetching
 * whatever `recording_url` says.
 *
 * ── What a viewer sees as "We could not reach the service that stores this recording" ──
 *
 * The console says that for every answer but a 403 or a 404 (`recordingRefusal`). Every such
 * answer this function gives is logged with a bounded `reason`, the call id and its provider,
 * and counted in `recording_fetch_failures_total{surface="playback"}`; hosts are logged, never
 * a URL (RC3, `docs/operations.md` "Recordings that will not play"):
 *  - 502 `access_error`: resolving the call's access threw (not a refusal: the credential
 *    store or the database failed);
 *  - 502 `host_not_allowed`: the stored URL's host is not this carrier's recording host;
 *  - 502 `redirect_refused` / `too_many_redirects`: the carrier's host redirected elsewhere
 *    (`redirectHost` and `redirectedFrom` logged);
 *  - 502 `upstream_unauthorized` / `upstream_not_found` / `upstream_status`: the carrier
 *    answered non-2xx (`upstreamStatus` logged);
 *  - 504 `timeout`: no response headers within {@link RECORDING_PROXY_HEADERS_TIMEOUT_MS} of the
 *    first request to the carrier. Resolving the access before it is not timed here: it is our
 *    database and keyring, not the carrier, so a stall there is not "the recording host did not
 *    answer" (the pool's timeouts bound it, db-hygiene.md §5) and a failure is `access_error`;
 *  - 502 `network`: the fetch failed (DNS, refused, reset, TLS).
 * The 404s (`access_refused`, a call with no recording) read as "not recorded".
 */
export async function proxyCallRecording(
  callRecord: ProxiedRecordingCall,
  request: FastifyRequest,
  reply: FastifyReply,
  resolveAccess: RecordingAccessResolver,
  opts: { headersTimeoutMs?: number } = {},
): Promise<FastifyReply> {
  // RC1: a call that did not ask for a recording has none, whatever the row still holds.
  if (!callRecord.recording_url || callRecord.recording_requested === false) {
    return reply.code(404).send({ error: 'Not Found', message: 'No recording available for this call' });
  }
  const provider = callRecord.provider;
  const failed = (reason: RecordingFetchFailureReason): void => trackRecordingFetchFailure(provider, 'playback', reason);

  let access: RecordingAccess;
  try {
    access = await resolveAccess(callRecord);
  } catch (err) {
    if (err instanceof RecordingAccessRefusedError) {
      failed('access_refused');
      log.warn(
        {
          callId: callRecord.id, provider: err.provider, credentialId: err.credentialId,
          reason: 'access_refused', refusal: err.reason, credentialKind: err.credentialKind,
        },
        'Recording access refused; not proxying',
      );
      return reply.code(404).send({
        error: 'Not Found',
        code: 'recording_unavailable',
        message: 'This recording is no longer available',
      });
    }
    failed('access_error');
    log.error({ err, callId: callRecord.id, provider, reason: 'access_error' }, 'Error resolving recording access');
    return reply.code(502).send({ error: 'Bad Gateway', message: 'Failed to fetch recording' });
  }

  const host = recordingHostname(callRecord.recording_url);

  // CR12: a pinned call on a carrier whose recordings are public. The credential has served
  // `recording` above (B21: a revoked one is the 404 already), so the viewer is sent to the
  // file itself, which their browser can reach where our egress cannot. Only a URL the fetch
  // would have taken: the same allow-list check, else the same refusal as a fetch's.
  if (recordingRedirectsToCarrier(provider, callRecord.telephony_credential_id)) {
    if (!recordingHostMatches(callRecord.recording_url, access.allowedHosts, access.exactHosts)) {
      failed('host_not_allowed');
      log.warn(
        { callId: callRecord.id, provider, reason: 'host_not_allowed', hop: 0, host },
        'Recording URL is not on the recording-host allow-list; refusing to redirect',
      );
      return reply.code(502).send({
        error: 'Bad Gateway',
        message: 'The recording is not hosted on an allowed carrier host',
      });
    }
    // `no-store`: the redirect is this request's answer, after this check, never a cached one
    // that would outlive the credential's revocation. `Vary: Accept`: the two answers differ by it.
    if (acceptsJsonRedirect(request.headers['accept'])) {
      const body: RecordingRedirectBody = { redirect_url: callRecord.recording_url };
      return reply.code(200).header('Cache-Control', 'no-store').header('Vary', 'Accept').send(body);
    }
    return reply.code(302).header('Location', callRecord.recording_url).header('Cache-Control', 'no-store')
      .header('Vary', 'Accept').send();
  }

  const headers: Record<string, string> = { ...access.headers };
  const range = request.headers['range'];
  if (typeof range === 'string' && range.length > 0) headers['Range'] = range;

  // Times the carrier's response headers only (not the access resolved above, which is ours):
  // cleared once they arrive, so the body streams untimed.
  const headersTimeout = new AbortController();
  const timer = setTimeout(() => headersTimeout.abort(), opts.headersTimeoutMs ?? RECORDING_PROXY_HEADERS_TIMEOUT_MS);
  try {
    let upstream: Response;
    try {
      upstream = await fetchWithAllowedRedirects(
        callRecord.recording_url, { headers, signal: headersTimeout.signal }, access.allowedHosts,
        { exactHosts: access.exactHosts, ...(access.redirectHosts ? { redirectHosts: access.redirectHosts } : {}) },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok && upstream.status !== 206) {
      const reason = recordingUpstreamStatusReason(upstream.status);
      failed(reason);
      await discardResponseBody(upstream);
      log.warn(
        { callId: callRecord.id, provider, reason, upstreamStatus: upstream.status, host },
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
    const reason = recordingFetchErrorReason(err, headersTimeout.signal.aborted);
    failed(reason);
    if (err instanceof RecordingHostRefusedError) {
      log.warn(
        {
          callId: callRecord.id, provider, reason, hop: err.hop,
          // Hosts only, never the URL: the refused one, or a redirect's target and its sender.
          ...(err.hop > 0 ? { host, redirectHost: err.host, redirectedFrom: err.redirectedFrom } : { host: err.host }),
        },
        'Recording URL is not on the recording-host allow-list; refusing to proxy',
      );
      return reply.code(502).send({
        error: 'Bad Gateway',
        message: 'The recording is not hosted on an allowed carrier host',
      });
    }
    if (reason === 'timeout') {
      log.warn({ callId: callRecord.id, provider, reason, host }, 'Recording host did not answer in time; giving up');
      return reply.code(504).send({ error: 'Gateway Timeout', message: 'The recording host did not answer in time' });
    }
    // The error is logged without the request init: it may hold a credential.
    log.error({ err, callId: callRecord.id, provider, reason, host }, 'Error proxying recording');
    return reply.code(502).send({ error: 'Bad Gateway', message: 'Failed to fetch recording' });
  }
}
