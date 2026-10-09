/**
 * PORT NOTE (magick-agency): moved verbatim out of `logger.ts` (core `src/utils/logger.ts:132-205`
 * @4850d1d9), which re-exports `scrubMediaUrl`; `isSecretQueryKey` is now exported. The move lets
 * the OTel span hook (`apps/server/src/utils/redact-url.ts`) apply the same rule without loading
 * pino. That hook runs before the rest of the app, so this module must import nothing.
 */

/**
 * Strip credentials out of a request URL before it is logged.
 *
 * Fastify's automatic request logging serializes `req.url` (and `req.query`) on
 * EVERY request, and `disableRequestLogging` is only on in development — so in
 * staging/production any secret embedded in a URL lands in log storage verbatim.
 *
 * Scrubbed shapes (log output ONLY — the live request/auth path is untouched):
 *   /media-stream/static/<callId>/<token>     → …/static/<callId>/[REDACTED]
 *   /static-media-stream/<callId>/<token>     → …/<callId>/[REDACTED]   (legacy)
 *   /…?token=…                                → …?token=[REDACTED]
 *   /…?hub.verify_token=…                     → …?hub.verify_token=[REDACTED]
 *   /api/v1/recordings/:id?sig=…              → …?sig=[REDACTED]
 *
 * The current static-call route nests under `/media-stream/` (so it inherits
 * nginx's WS-upgrade block — see ws-static-media-url.ts), which puts its token one
 * segment FURTHER along than the AI route's id: `/media-stream/static/<callId>/
 * <token>` vs `/media-stream/<callId>`. Anchoring on the route name alone would
 * redact the callId and leave the token in cleartext — exactly inverting the
 * intent — so `static` is consumed as part of the route marker.
 *
 * The callId is deliberately preserved — it is the correlation key these lines
 * exist for, and it is not a credential (the socket is fail-closed on the token).
 *
 * Exported for direct testing: the leak is invisible in normal assertions because
 * it happens inside Fastify's own logging, not ours.
 */
const MEDIA_STREAM_PATH_RE = /\/(static-media-stream|media-stream|browser-stream|pstn-stream)\//;

/** Query keys whose values are credentials and must never reach log storage. */
const SECRET_QUERY_KEYS = new Set([
  'token',
  'sig',
  'hub.verify_token',
]);

export function isSecretQueryKey(key: string): boolean {
  if (SECRET_QUERY_KEYS.has(key)) return true;
  // Meta (and similar) nest the verify secret as `*.verify_token`.
  return key.endsWith('.verify_token') || key.endsWith('verify_token');
}

export function scrubMediaUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  let out = url;
  // Bare `token=` (media/WebRTC legs, status webhooks).
  out = out.replace(/([?&]token=)[^&]+/gi, '$1[REDACTED]');
  // Nested verify secrets (`hub.verify_token=`) — the bare `token=` regex misses
  // these because `_` sits between `&`/`?` and `token=`.
  out = out.replace(/([?&][\w.-]*verify_token=)[^&]+/gi, '$1[REDACTED]');
  // HMAC on signed recording-playback URLs.
  out = out.replace(/([?&]sig=)[^&]+/gi, '$1[REDACTED]');
  // Trailing path token, but ONLY on a media-stream route: elsewhere a trailing
  // segment is an id we want to keep readable.
  if (MEDIA_STREAM_PATH_RE.test(out)) {
    const [pathPart, queryPart] = out.split('?', 2);
    const segments = (pathPart ?? '').split('/');
    // .../<route>/<callId>/<token> — a token is present only when there are two
    // segments after the route name, so a plain `/<route>/<callId>` is untouched.
    let routeIdx = segments.findIndex((s) => s === 'static-media-stream' || s === 'media-stream' || s === 'browser-stream' || s === 'pstn-stream');
    // `/media-stream/static/<callId>/<token>` — the `static` sub-segment shifts the
    // callId and token one position right. Consume it as part of the route marker,
    // otherwise the callId gets redacted and the token survives.
    if (routeIdx >= 0 && segments[routeIdx] === 'media-stream' && segments[routeIdx + 1] === 'static') {
      routeIdx += 1;
    }
    if (routeIdx >= 0 && segments.length >= routeIdx + 3) {
      segments[routeIdx + 2] = '[REDACTED]';
      out = segments.join('/') + (queryPart ? `?${queryPart}` : '');
    }
  }
  return out;
}
