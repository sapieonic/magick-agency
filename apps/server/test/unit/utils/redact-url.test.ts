import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CREDENTIAL_PATH_LITERALS,
  REDACTED_TOKEN_SEGMENT,
  redactUrl,
  redactedRequestSpanAttributes,
} from '../../../src/utils/redact-url.js';

/**
 * `redact-url.ts` — keeping a live bearer credential out of centralised logging
 * and tracing.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `src/index.ts` logs `url: request.url` at `info` on every non-health request,
 * and `PinoInstrumentation` bridges those records into OTel Logs → Grafana
 * Cloud. `@opentelemetry/instrumentation-http` writes the same string onto every
 * server span. `GET /invites/<RAW TOKEN>` and `POST /invites/<RAW TOKEN>/claim`
 * therefore published a single-use, seven-day invitation credential to two
 * systems with far wider read access than the mailbox it was mailed to — against
 * `invite-token.ts`'s own rule that the raw token goes in the email "and NOWHERE
 * else — never a log line".
 *
 * The cases below pin three separate things, because the redaction is only worth
 * having if all three hold: the rewrite itself, that it does NOT flatten the
 * sibling route literal (`/invites/resend`), and that every sink actually calls
 * it — the last asserted over the SOURCE, since the log hooks live inside
 * `main()` and the span hook inside the OTel bootstrap, neither of which a unit
 * test can invoke.
 */

const TOKEN = 'Yb3n0Q-kx7Lm2pQeR8sT1uV4wX6yZ9aB0cD2eF4gH6i';

const SRC = (relative: string): string =>
  readFileSync(resolve(process.cwd(), 'src', relative), 'utf8');

describe('redactUrl', () => {
  it('replaces the token segment on the claim-page read', () => {
    expect(redactUrl(`/invites/${TOKEN}`)).toBe(`/invites/${REDACTED_TOKEN_SEGMENT}`);
  });

  it('replaces the token segment on the claim itself, keeping the action', () => {
    // `/claim` has to survive: it is what distinguishes the POST that spends the
    // invite from the GET that only describes it, and a log in which the two are
    // one line cannot answer "did anybody actually claim this?".
    expect(redactUrl(`/invites/${TOKEN}/claim`)).toBe(`/invites/${REDACTED_TOKEN_SEGMENT}/claim`);
  });

  it('leaves the query string alone', () => {
    // No credential in this service travels in a query string, and dropping it
    // would take the one thing a "the filter is wrong" ticket is answered from.
    expect(redactUrl(`/invites/${TOKEN}/claim?next=%2Fagency`)).toBe(
      `/invites/${REDACTED_TOKEN_SEGMENT}/claim?next=%2Fagency`,
    );
  });

  it('does NOT flatten POST /invites/resend into a token', () => {
    /**
     * The failure that would be worse than the leak: `resend` is a route
     * literal, not a credential. Rewritten to `:token` it would render an
     * authenticated administrative write as an anonymous claim attempt — a log
     * line that is silently WRONG rather than merely less detailed.
     */
    expect(redactUrl('/invites/resend')).toBe('/invites/resend');
  });

  it('returns the input UNCHANGED, by identity, when nothing matched', () => {
    // Identity rather than a copy, so a caller can ask "did this URL carry a
    // secret?" with `===` — which is exactly how the span hook decides whether
    // to override any attribute at all.
    const plain = '/users/invite?account_id=1';
    expect(redactUrl(plain)).toBe(plain);
    expect(redactUrl('/health')).toBe('/health');
    expect(redactUrl('/invites')).toBe('/invites');
    expect(redactUrl('/invites/')).toBe('/invites/');
  });

  it('redacts an unknown deep path under /invites rather than letting it through', () => {
    // Fails closed: a route added under `/invites` whose first segment is a
    // parameter is redacted by default, and only an entry in the literal table
    // opts it back out.
    expect(redactUrl(`/invites/${TOKEN}/something/else`)).toBe(
      `/invites/${REDACTED_TOKEN_SEGMENT}/something/else`,
    );
  });

  it('pins the literal table against the routes actually registered under /invites', () => {
    /**
     * The table is hand-maintained, so it is kept honest the way
     * `metric-path.templates.test.ts` keeps its template list honest: re-derive
     * the fixed route paths from the source and require each to be covered.
     * Adding `POST /invites/archive` without updating the table would otherwise
     * ship a log line calling it a claim.
     *
     * `patch` is in the verb list although this file registers none: a verb the
     * pattern omits is a route this audit stops deriving, which is silence, not
     * a failure — the same blind spot the gating audits close by deriving
     * their verbs from `PASSTHROUGH_METHODS`.
     */
    const source = SRC('api/routes/invites.routes.ts');
    const registered = [...source.matchAll(/app\.(?:get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'\/([^']*)'/g)]
      .map((match) => match[1] ?? '')
      .map((path) => path.split('/')[0] ?? '')
      .filter((segment) => segment !== '' && !segment.startsWith(':'));

    expect(registered).toContain('resend');
    const literals = CREDENTIAL_PATH_LITERALS.get('invites');
    for (const segment of registered) {
      expect(literals?.has(segment)).toBe(true);
    }
  });
});

describe('redactedRequestSpanAttributes', () => {
  const headers = { host: 'api.example.test' };

  it('overrides BOTH semconv vocabularies, because which one is emitted is an env var', () => {
    /**
     * `instrumentation-http` defaults to `SemconvStability.OLD` and this service
     * does not set `OTEL_SEMCONV_STABILITY_OPT_IN`, so `http.url`/`http.target`
     * are what ships today and `url.path` is what ships if anybody opts in.
     * Writing only the stable key would have redacted nothing at all.
     */
    const attrs = redactedRequestSpanAttributes({ url: `/invites/${TOKEN}/claim`, headers });

    expect(attrs['url.path']).toBe(`/invites/${REDACTED_TOKEN_SEGMENT}/claim`);
    expect(attrs['http.target']).toBe(`/invites/${REDACTED_TOKEN_SEGMENT}/claim`);
    expect(attrs['http.url']).toBe(
      `http://api.example.test/invites/${REDACTED_TOKEN_SEGMENT}/claim`,
    );
    for (const value of Object.values(attrs)) {
      expect(value).not.toContain(TOKEN);
    }
  });

  it('keeps http.url ABSOLUTE, and follows the socket for the scheme', () => {
    // A bare path there would change the attribute's shape for these two routes
    // only — the reconstruction differs from the original in exactly the
    // redacted segment.
    const attrs = redactedRequestSpanAttributes({
      url: `/invites/${TOKEN}`,
      headers,
      socket: { encrypted: true },
    });
    expect(attrs['http.url']).toBe(`https://api.example.test/invites/${REDACTED_TOKEN_SEGMENT}`);
  });

  it('preserves the query string in the old-semconv target', () => {
    const attrs = redactedRequestSpanAttributes({ url: `/invites/${TOKEN}?src=mail`, headers });
    expect(attrs['http.target']).toBe(`/invites/${REDACTED_TOKEN_SEGMENT}?src=mail`);
    expect(attrs['url.path']).toBe(`/invites/${REDACTED_TOKEN_SEGMENT}`);
  });

  it('is a NO-OP for every request that carries no credential', () => {
    // The hook runs on every inbound request in the service. Returning the
    // unchanged path would put this function in the attribute pipeline for all
    // of them in exchange for nothing.
    expect(redactedRequestSpanAttributes({ url: '/users/invite', headers })).toEqual({});
    expect(redactedRequestSpanAttributes({ url: '/invites/resend', headers })).toEqual({});
    expect(redactedRequestSpanAttributes({ headers })).toEqual({});
  });
});

describe('every sink actually redacts', () => {
  /**
   * A source audit, for the reason `metric-path.ts` gives about
   * `routeMetricLabel`: the two request-log hooks live inside `main()`, a single
   * un-exported function, and the span hook lives inside the OTel bootstrap that
   * runs before the application. Neither is reachable from a unit test, and both
   * are exactly where a future edit would reintroduce the raw URL.
   */

  it('the error middlewares redact too — a 500 on a claim is one line of SQL away', () => {
    // The one error middleware is `errorHandler`, registered in `agencyPlugin`.
    for (const file of ['api/middleware/error-handler.middleware.ts']) {
      const source = SRC(file);
      expect(source).toContain('redactUrl');
      expect(source).not.toMatch(/url:\s*request\.url/);
    }
  });

  it('redact-url.ts imports NOTHING, so instrumentation.ts can reach it', () => {
    /**
     * `src/instrumentation.ts` runs before the application and registers the
     * import-in-the-middle ESM hook; it may only import modules with no
     * transitive dependencies. A `logger.js` or `config/index.js` import here
     * would drag the whole application graph — and config's `process.exit(1)` —
     * in front of the instrumentation bootstrap.
     */
    expect(SRC('utils/redact-url.ts')).not.toMatch(/^\s*import\s/m);
  });
});
