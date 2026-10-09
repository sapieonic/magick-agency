/**
 * Redaction for request URLs whose PATH carries a credential.
 *
 * ── The defect this exists to prevent ──────────────────────────────────────
 * `src/index.ts` logs `url: request.url` at `info` on every non-health request
 * (both the `onRequest` and the `onResponse` hook), and those pino records are
 * bridged into OTel Logs by `PinoInstrumentation` and shipped to Grafana Cloud.
 * `@opentelemetry/instrumentation-http` is kept for traces and writes the same
 * string onto every server span (`http.url` / `http.target` under the old
 * semconv, `url.path` under the stable one).
 *
 * `GET /invites/<RAW TOKEN>` and `POST /invites/<RAW TOKEN>/claim` therefore put
 * a **live, single-use, seven-day bearer credential** into centralised logging
 * and tracing — two systems with far wider read access than the mailbox the
 * token was delivered to, and both of which retain it. That directly contradicts
 * `src/notifications/invite-token.ts`, which says of the raw token: *"Goes in the
 * email and NOWHERE else — never a log line"*. Possession of that string is the
 * whole authority of the claim, so a log reader could bind their own Firebase
 * identity to somebody else's membership.
 *
 * The fix is to rewrite the credential-bearing segment to a placeholder
 * (`/invites/:token/claim`) at every sink, which costs nothing an operator
 * actually uses: the route template is what a reader greps for, and the invite
 * id is already on the structured log lines the routes themselves write.
 *
 * ── Why the rule lives here rather than inline at the three sinks ───────────
 * Same argument `metric-path.ts` makes for `routeMetricLabel`: `main()` is a
 * single un-exported function, so a rule written inline there is untestable where
 * it lives — and this one has to hold identically in the log hooks, in the two
 * error middlewares, and inside an OpenTelemetry hook that runs in a completely
 * different part of the process. One exported function is the only way those four
 * can be asserted to agree.
 *
 * The span side also redacts credential query values and media-stream path tokens
 * (`redactSpanUrl`), and outgoing `fetch` spans' query values (`redactedOutgoingSpanAttributes`).
 *
 * ── This module imports (almost) NOTHING, deliberately ─────────────────────
 * `src/instrumentation.ts` imports it, and that file runs before the rest of the
 * application: it registers the `import-in-the-middle` ESM hook and may only
 * reach modules with no side effects and no transitive dependencies (the same
 * constraint its `./utils/version.js` import is annotated with). A `logger.js` or
 * `config/index.js` import here would drag the whole application graph — and
 * config's `process.exit(1)` — in front of the instrumentation bootstrap. The one
 * import is the log-side scrubber, `@magick-agency/observability/url-scrub`, a leaf
 * with no imports of its own.
 */
import { isSecretQueryKey, scrubMediaUrl } from '@magick-agency/observability/url-scrub';

/** What a credential-bearing path segment is replaced with. */
export const REDACTED_TOKEN_SEGMENT = ':token';

/**
 * The route families whose FIRST path parameter is a credential.
 *
 * `literals` is the set of sibling segments at that position which are route
 * literals rather than tokens, and it is not optional bookkeeping: without
 * `resend`, `POST /invites/resend` would be logged as `/invites/:token` — an
 * authenticated administrative write rendered as a claim attempt, which is worse
 * than the leak it was meant to fix because it is silently WRONG rather than
 * merely less detailed. `redact-url.test.ts` re-derives the literal set from
 * `invites.routes.ts` so a new fixed route under `/invites` cannot be added
 * without updating this table.
 *
 * A table rather than a hard-coded `/invites` check because the next route that
 * puts a credential in a path (a password-reset or a magic-link surface) must be
 * one line here, not a second copy of this logic somewhere else.
 */
const CREDENTIAL_PATH_RULES: readonly { readonly prefix: string; readonly literals: ReadonlySet<string> }[] = [
  { prefix: 'invites', literals: new Set(['resend']) },
];

/** The literal segments this module knows about, for the test that pins them. */
export const CREDENTIAL_PATH_LITERALS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  CREDENTIAL_PATH_RULES.map((rule) => [rule.prefix, rule.literals]),
);

/**
 * Rewrite a request URL so no credential survives into a log line or a span.
 *
 * Returns the input **unchanged** whenever nothing matched — identity, not a
 * defensive copy, so a caller (and a test) can compare by `===` to ask "did this
 * URL carry a secret?".
 *
 * The query string is preserved as-is: dropping it would take the one thing a "customer says
 * the filter is wrong" report is answered from. Credentials DO travel in queries here
 * (VoiceLink's `?token=`, signed recording `?sig=`); redacting them is `redactSpanUrl`'s and the
 * log scrubber's job, not this function's. Fragments cannot appear in a
 * server-side `request.url` at all; the split tolerates one rather than relying
 * on that.
 */
export function redactUrl(url: string): string {
  const queryStart = url.search(/[?#]/);
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const suffix = queryStart === -1 ? '' : url.slice(queryStart);

  // A leading '/' makes segments[0] the empty string, so the route family is at
  // index 1 and its first parameter at index 2.
  const segments = path.split('/');
  if (segments.length < 3) return url;

  const rule = CREDENTIAL_PATH_RULES.find((candidate) => candidate.prefix === segments[1]);
  if (!rule) return url;

  const subject = segments[2] ?? '';
  // An empty segment is a trailing slash, not a token; a known literal is a
  // route, not a token. Neither is a secret and neither should be flattened.
  if (subject === '' || rule.literals.has(subject)) return url;

  segments[2] = REDACTED_TOKEN_SEGMENT;
  return segments.join('/') + suffix;
}

/** What a credential query value is replaced with: the log scrubber's placeholder. */
const REDACTED_QUERY_VALUE = '[REDACTED]';

/**
 * `@opentelemetry/instrumentation-http`'s own default redaction list
 * (`DEFAULT_QUERY_STRINGS_TO_REDACT`, `build/src/internal-types.js`@0.223.0), which
 * `redact-url.test.ts` pins against the installed package. Pre-signed object-store URLs carry
 * these; a recording fetch can be redirected to one.
 */
export const INSTRUMENTATION_DEFAULT_REDACTED_QUERY_PARAMS: readonly string[] = [
  'sig',
  'Signature',
  'AWSAccessKeyId',
  'X-Goog-Signature',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
];

/**
 * The list handed to the HTTP instrumentation's `redactedQueryParams` (outgoing `http`/`https` spans). Setting it REPLACES the instrumentation's
 * defaults, so they are repeated, plus the log scrubber's keys. The instrumentation matches
 * names exactly, so the `*verify_token` suffix rule is covered only for `hub.verify_token`.
 */
export const OUTGOING_REDACTED_QUERY_PARAMS: readonly string[] = [
  ...INSTRUMENTATION_DEFAULT_REDACTED_QUERY_PARAMS,
  'token',
  'hub.verify_token',
];

const SIGNED_URL_QUERY_KEYS: ReadonlySet<string> = new Set(
  INSTRUMENTATION_DEFAULT_REDACTED_QUERY_PARAMS.map((key) => key.toLowerCase()),
);

function isRedactedQueryKey(rawKey: string): boolean {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    // A malformed escape: match the raw key.
  }
  key = key.toLowerCase();
  return isSecretQueryKey(key) || SIGNED_URL_QUERY_KEYS.has(key);
}

/**
 * Redact credential VALUES in a query string (without its `?`) by
 * DECODED, case-insensitive key: the log scrubber's keys (`token`, `sig`, `*verify_token`) plus
 * the instrumentation's signed-URL keys. The log scrubber matches the raw text, so
 * `?%74oken=…` (which Fastify decodes to `token`) gets past it. Every other pair is kept byte for
 * byte. Returns the input unchanged, by identity, when nothing matched.
 */
export function redactQuery(query: string): string {
  let changed = false;
  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0 || !isRedactedQueryKey(part.slice(0, eq))) return part;
    if (part.slice(eq + 1) === REDACTED_QUERY_VALUE) return part;
    changed = true;
    return `${part.slice(0, eq)}=${REDACTED_QUERY_VALUE}`;
  });
  return changed ? parts.join('&') : query;
}

/**
 * The whole span-side rule for a request URL: the invite-path rewrite (`redactUrl`), then the log scrubber (query tokens and media-stream path tokens, so a span says what
 * the log line says), then `redactQuery` for what the scrubber's raw-text match misses. Returns
 * the input unchanged, by identity, when nothing matched.
 */
export function redactSpanUrl(url: string): string {
  const scrubbed = scrubMediaUrl(redactUrl(url));
  const queryStart = scrubbed.indexOf('?');
  if (queryStart === -1) return scrubbed === url ? url : scrubbed;
  const query = redactQuery(scrubbed.slice(queryStart + 1));
  const out = query === scrubbed.slice(queryStart + 1) ? scrubbed : `${scrubbed.slice(0, queryStart + 1)}${query}`;
  return out === url ? url : out;
}

/**
 * The span attributes that must be overridden for a credential-bearing request,
 * shaped for `@opentelemetry/instrumentation-http`'s `startIncomingSpanHook`.
 *
 * ── This was verified against the installed instrumentation, not assumed ────
 * Checked against `instrumentation-http@0.223.0`: `utils.js:getIncomingRequestAttributes` emits the STABLE keys
 * only (`url.path`, `url.query`, …; the old-semconv branch and `OTEL_SEMCONV_STABILITY_OPT_IN`
 * handling are gone) and ends with `Object.assign(attributes, hookAttributes)`. **The hook's
 * attributes are applied LAST**, so returning a key here overwrites the instrumentation's own
 * value rather than being ignored — which is the property this fix depends on and the reason
 * it is stated in full.
 *
 * The old-semconv keys (`http.url`, `http.target`) are returned as well. The instrumentation no
 * longer emits them, so on a redacted span they are ADDED beside `url.path` rather than
 * overwriting anything, and carry only the redacted URL.
 *
 * Two things deliberately NOT handled here, both checked in the same source:
 *
 *  - **The span NAME.** It starts as the bare method and is rewritten in
 *    `_onServerResponseFinish` to `${method} ${http.route}`, where `http.route`
 *    comes from the RPC metadata Fastify's instrumentation sets — the route
 *    TEMPLATE (`/invites/:token`), never the interpolated path. In practice
 *    `auto-instrumentations-node@0.81.0` has no Fastify instrumentation, so no
 *    `http.route` is set and server spans are named by method alone. Either
 *    way, nothing to redact.
 *  - **The response-time attributes.** `getIncomingRequestAttributesOnResponse`
 *    contributes only the status code and `http.route`, so no URL is re-added
 *    after this hook has run.
 *
 * The instrumentation's own server-side redaction list has no `token`, so the URL goes through
 * `redactSpanUrl`: a `?token=` / `sig=` / `*verify_token=` value (VoiceLink's status webhook
 * is `/webhooks/voicelink/webrtc-status/:callId?token=…`), a signed-URL key, or a media-stream
 * path token is redacted on the span as it is in the logs, and `url.query` is overwritten when
 * the query changed (Manas, 2026-10-09).
 *
 * Returns an EMPTY object for every request that needs no redaction, so the hook adds nothing
 * to any other request. The alternative — always returning the (unchanged) path — would make
 * this function part of the attribute pipeline for every request in the service in exchange
 * for nothing.
 */
export function redactedRequestSpanAttributes(request: {
  url?: string | undefined;
  headers: unknown;
  socket?: unknown;
}): Record<string, string> {
  const raw = request.url;
  if (!raw) return {};

  const redacted = redactSpanUrl(raw);
  if (redacted === raw) return {};

  const queryStart = redacted.search(/[?#]/);
  const path = queryStart === -1 ? redacted : redacted.slice(0, queryStart);
  const rawQueryStart = raw.search(/[?#]/);
  const queryChanged = (queryStart === -1 ? '' : redacted.slice(queryStart))
    !== (rawQueryStart === -1 ? '' : raw.slice(rawQueryStart));

  // `http.url` is an ABSOLUTE url, so it has to be rebuilt rather than replaced
  // with the path — a bare path there would silently change the attribute's
  // shape for these two routes only. Host and scheme are derived the same way
  // the instrumentation derives them (the `Host` header, and whether the socket
  // is a TLS socket), so the reconstructed value differs from the original in
  // exactly the redacted segment.
  const hostHeader = (request.headers as { host?: unknown } | undefined)?.host;
  const host = typeof hostHeader === 'string' && hostHeader !== '' ? hostHeader : 'localhost';
  const scheme = (request.socket as { encrypted?: unknown } | undefined)?.encrypted === true
    ? 'https:'
    : 'http:';

  return {
    // Stable semconv.
    'url.path': path,
    // Old semconv (see above). `url.query` is deliberately left to the instrumentation when the
    // query is unchanged: its own value is already correct.
    'http.target': redacted,
    'http.url': `${scheme}//${host}${redacted}`,
    // Stable semconv's `url.query` is the query without its `?`; set only then, so every other request keeps the shape above.
    ...(queryChanged ? { 'url.query': redacted.slice(queryStart + 1) } : {}),
  };
}

/**
 * `@opentelemetry/instrumentation-undici`
 * (global `fetch`) redacts nothing: it puts the full request URL on every client span as
 * `url.full` and `url.query` (`build/src/undici.js`@0.33.0). `recording-proxy.ts` fetches carrier
 * recording URLs and follows redirects hop by hop, so a pre-signed redirect would export its
 * signature. Shaped for that instrumentation's `startSpanHook`, whose attributes are applied
 * over its own. Redacts query values by `redactQuery`'s rule; returns `{}` when nothing matched.
 * `url.query` keeps the instrumentation's shape (with its `?`).
 */
export function redactedOutgoingSpanAttributes(request: {
  origin?: unknown;
  path?: unknown;
}): Record<string, string> {
  if (typeof request.path !== 'string' || typeof request.origin !== 'string') return {};
  let url: URL;
  try {
    url = new URL(request.path, request.origin);
  } catch {
    return {};
  }
  if (url.search === '') return {};
  const query = redactQuery(url.search.slice(1));
  if (query === url.search.slice(1)) return {};
  return {
    'url.full': `${url.origin}${url.pathname}?${query}`,
    'url.query': `?${query}`,
  };
}
