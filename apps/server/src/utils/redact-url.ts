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
 * ── This module imports NOTHING, deliberately ──────────────────────────────
 * `src/instrumentation.ts` imports it, and that file runs before the rest of the
 * application: it registers the `import-in-the-middle` ESM hook and may only
 * reach modules with no side effects and no transitive dependencies (the same
 * constraint its `./utils/version.js` import is annotated with). A `logger.js` or
 * `config/index.js` import here would drag the whole application graph — and
 * config's `process.exit(1)` — in front of the instrumentation bootstrap.
 */

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
 * The query string is preserved as-is. It is not where any credential in this
 * service travels, and dropping it would take the one thing a "customer says the
 * filter is wrong" report is answered from. Fragments cannot appear in a
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

/**
 * The span attributes that must be overridden for a credential-bearing request,
 * shaped for `@opentelemetry/instrumentation-http`'s `startIncomingSpanHook`.
 *
 * ── This was verified against the installed instrumentation, not assumed ────
 * `instrumentation-http@0.212.0` builds its server-span attributes in
 * `utils.js:getIncomingRequestAttributes`, which ends with
 * `Object.assign(oldAttributes, newAttributes, hookAttributes)` (and the
 * equivalent two-argument form in each single-stability branch). **The hook's
 * attributes are applied LAST in every branch**, so returning a key here
 * overwrites the instrumentation's own value rather than being ignored — which
 * is the property this fix depends on and the reason it is stated in full.
 *
 * Both attribute vocabularies are covered because which one is emitted depends
 * on `OTEL_SEMCONV_STABILITY_OPT_IN`, an env var this service does not set: the
 * default is `SemconvStability.OLD` (`http.js:34`), i.e. `http.url` and
 * `http.target`, and opting in would switch to (or add) `url.path`. Writing only
 * the stable keys would have redacted nothing at all in today's deployment.
 *
 * Two things deliberately NOT handled here, both checked in the same source:
 *
 *  - **The span NAME.** It starts as the bare method and is rewritten in
 *    `_onServerResponseFinish` to `${method} ${http.route}`, where `http.route`
 *    comes from the RPC metadata Fastify's instrumentation sets — the route
 *    TEMPLATE (`/invites/:token`), never the interpolated path. Nothing to
 *    redact.
 *  - **The response-time attributes.** `getIncomingRequestAttributesOnResponse`
 *    contributes only the status code and `http.route`, so no URL is re-added
 *    after this hook has run.
 *
 * Returns an EMPTY object for every request that needs no redaction, so the
 * hook is a no-op on all traffic but the two invite routes. The alternative —
 * always returning the (unchanged) path — would make this function part of the
 * attribute pipeline for every request in the service in exchange for nothing.
 */
export function redactedRequestSpanAttributes(request: {
  url?: string | undefined;
  headers: unknown;
  socket?: unknown;
}): Record<string, string> {
  const raw = request.url;
  if (!raw) return {};

  const redacted = redactUrl(raw);
  if (redacted === raw) return {};

  const queryStart = redacted.search(/[?#]/);
  const path = queryStart === -1 ? redacted : redacted.slice(0, queryStart);

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
    // Old semconv — the default for this service. `url.query` is deliberately
    // left to the instrumentation: the query string is not redacted, so its own
    // value is already correct.
    'http.target': redacted,
    'http.url': `${scheme}//${host}${redacted}`,
  };
}
