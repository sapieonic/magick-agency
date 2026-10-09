import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * **`GET /proxy/agency/campaigns/:id/stats/series` — the campaign's bucketed
 * trend (`86d45k0bk`).**
 *
 * Three properties, and they fail in three different ways:
 *
 *  1. **The floor is `agency.supervise`**, asserted BY EXECUTION. The sibling
 *     table in `proxy-agency-campaigns.routes.test.ts` reads the permission
 *     STRING out of the source, which cannot see a `requirePermission` deleted
 *     together with its own row in that table — measured on the lifecycle routes
 *     (MAG-96): the whole suite stayed green. So `src/rbac/rbac.middleware.js` and
 *     `src/config/index.js` are deliberately NOT mocked here and the real
 *     `PERMISSION_MATRIX` decides, exactly as
 *     `proxy-agency-campaign-lifecycle-rbac.routes.test.ts` does for start/pause.
 *     The boundary is asserted from BOTH sides — 403 at `operator`, 200 at
 *     `account_admin` — because a floor pinned only from below passes for a route
 *     with no guard at all, and one pinned only from above passes for a route
 *     floored at `tenant_owner`.
 *
 *  2. **The window rules are master's fast refusal**, and they must be MASTER's
 *     400 rather than core's: every case below also asserts `proxyToCore` was
 *     never called, because the whole benefit of validating here is not spending
 *     an AES key decryption and an S2S round trip on a request that cannot
 *     succeed. The half-open `[from, to)` convention is the one thing about this
 *     route most likely to be "fixed" into the inclusive `to` its neighbouring
 *     LIST routes use, so `from === to` is pinned as a refusal.
 *
 *  3. **The payload is forwarded untouched**, `bucket_start` above all. A
 *     date-only string is the one ISO form `new Date()` reads as UTC midnight, so
 *     any normalisation on this hop renders every chart label a day early west of
 *     Greenwich — on a body that still looks well-formed. `JSON.stringify` on the
 *     whole response is the assertion, because a field-by-field walk cannot see a
 *     field it does not name.
 */

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// PORT NOTE (magick-agency): master's `require-capability` mock is gone with governance
// (the route registers no `requireCapability('agency')`; plan §3.2).
// Deliberately NOT mocked: `src/rbac/rbac.middleware.js`, `src/config/index.js`.
// See property 1 in the file header.

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import {
  CAMPAIGN_SERIES_MAX_WINDOW_DAYS,
  MS_PER_DAY,
  type AgencyCampaignStatsSeries,
} from '../../../src/agency/agency-campaign-wire.js';
// PORT NOTE (magick-agency): master imported `FORWARDABLE_ERROR_CODES` /
// `FORWARDABLE_ERROR_LABELS` from `error-mask.middleware.js`. The error mask is not ported
// (plan §1, one union; lane B2 "Not ported"), so the two assertions on those sets are
// deleted from the two 404 cases below; their status/body assertions are kept.

const PREFIX = '/proxy/agency';
const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';
const USER = 'user-1';
const CAMPAIGN = 'campaign-1';

const FROM = '2026-08-11T00:00:00.000Z';
const TO = '2026-08-14T00:00:00.000Z';

function seriesUrl(query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ from: FROM, to: TO, ...query });
  return `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?${params.toString()}`;
}

/**
 * Core's series body.
 *
 * Typed against master's declared wire shape, so a field renamed or mistyped in
 * `agency-campaign-wire.ts` reds `npm run lint:test` here rather than passing as
 * an unchecked record key. The middle bucket is all zeros ON PURPOSE — see the
 * case that names it.
 */
const CORE_SERIES: AgencyCampaignStatsSeries = {
  campaign_id: CAMPAIGN,
  bucket: 'day',
  timezone: 'Asia/Kolkata',
  buckets: [
    { bucket_start: '2026-08-11', attempts: 412, connected: 118, successes: 76, talk_seconds: 22910, wrapup_seconds: 4488 },
    { bucket_start: '2026-08-12', attempts: 0, connected: 0, successes: 0, talk_seconds: 0, wrapup_seconds: 0 },
    { bucket_start: '2026-08-13', attempts: 388, connected: 96, successes: 51, talk_seconds: 18004, wrapup_seconds: 3910 },
  ],
};

async function buildApp(role: MembershipRole): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    // Double cast, matching the sibling RBAC suite: `lint:test` rejects a
    // single-cast `FastifyRequest as Record<string, unknown>` under TS2352.
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    r['user'] = { id: USER };
    r['membership'] = { role };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // A CLONE, not the fixture itself. A route that mutated core's body in place —
  // which is how a `bucket_start` normalisation would most naturally be written —
  // would otherwise mutate the very object the byte-identity case compares
  // against, and that case would pass while the client got the wrong dates.
  // Measured: without the clone, exactly that mutation left
  // "sends core's body byte-identically" green.
  mocks.proxyToCore.mockResolvedValue({
    status: 200,
    body: structuredClone(CORE_SERIES),
    headers: new Headers(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the series read floors at agency.supervise (account_admin)', () => {
  it.each<MembershipRole>(['agent', 'viewer', 'operator'])(
    'a %s gets 403 and the core proxy is never called',
    async (role) => {
      const app = await buildApp(role);

      const res = await app.inject({ method: 'GET', url: seriesUrl() });

      expect(res.statusCode).toBe(403);
      // Not merely "not 200": a 403 that still spent the core round trip has
      // leaked the read it refused.
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      // PORT NOTE (magick-agency): master's `resolveCoreApiKey` not-called assertion is
      // deleted with the key (in-process `callCore` takes none).
      await app.close();
    },
  );

  it.each<MembershipRole>(['account_admin', 'tenant_admin', 'tenant_owner'])(
    'a %s gets through and the core proxy is called',
    async (role) => {
      const app = await buildApp(role);

      const res = await app.inject({ method: 'GET', url: seriesUrl() });

      expect(res.statusCode).toBe(200);
      expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
      await app.close();
    },
  );

  it('is a HIGHER floor than the live /stats strip beside it, deliberately', async () => {
    /**
     * The pair that must not be "tidied up" into agreement. MAG-136 already pins
     * `/stats` at `viewer`; this asserts the DIFFERENCE from one place, so a
     * change that aligns them reds with both halves visible in one failure rather
     * than in two files.
     */
    const app = await buildApp('operator');

    const strip = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/stats` });
    const series = await app.inject({ method: 'GET', url: seriesUrl() });

    expect(strip.statusCode).toBe(200);
    expect(series.statusCode).toBe(403);
    await app.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the window and bucket are validated before core is called', () => {
  /** Every refusal here must be MASTER's, so none of them may reach core. */
  async function refuse(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const app = await buildApp('account_admin');
    const res = await app.inject({ method: 'GET', url });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  it('400s an unknown bucket, naming the param', async () => {
    const { status, body } = await refuse(seriesUrl({ bucket: 'hour' }));

    expect(status).toBe(400);
    // `details` is what `errorMaskHook` treats as structured client feedback, so
    // the offending param survives to the client instead of being flattened into
    // "contact support".
    const fieldErrors = (body['details'] as { fieldErrors: Record<string, string[]> }).fieldErrors;
    expect(Object.keys(fieldErrors)).toEqual(['bucket']);
  });

  it.each(['day', 'week', 'month'])('accepts bucket=%s', async (bucket) => {
    const app = await buildApp('account_admin');

    const res = await app.inject({ method: 'GET', url: seriesUrl({ bucket }) });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({ from: FROM, to: TO, bucket });
    await app.close();
  });

  it('does NOT inject a default bucket — `day` stays core\'s default', async () => {
    // Master defaulting it would be a second declaration of the same default, and
    // core echoes `bucket` on the response so nothing is ambiguous without it.
    const app = await buildApp('account_admin');

    await app.inject({ method: 'GET', url: seriesUrl() });

    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({ from: FROM, to: TO });
    await app.close();
  });

  it('400s `from` later than `to`', async () => {
    const { status, body } = await refuse(
      `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=${TO}&to=${FROM}`,
    );

    expect(status).toBe(400);
    const fieldErrors = (body['details'] as { fieldErrors: Record<string, string[]> }).fieldErrors;
    expect(fieldErrors['from']![0]).toContain('half-open');
  });

  it('400s `from` EQUAL to `to`, because the window is half-open', async () => {
    /**
     * The case that separates this route's convention from its neighbours'. The
     * activity and attempt LIST routes use an inclusive `to` and therefore accept
     * `from === to` (`orderedPeriod` is `<=`); an aggregate cannot, because a
     * zero-width half-open window has no buckets — and `buckets: []` on a chart
     * reads as a fact about the campaign rather than about the request.
     */
    const { status } = await refuse(
      `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=${FROM}&to=${FROM}`,
    );

    expect(status).toBe(400);
  });

  it('accepts a window of exactly the cap, and 400s one millisecond more', async () => {
    // Both sides of the boundary, from the CONSTANT rather than a literal 92 —
    // a test carrying its own copy of the number cannot catch the number moving.
    const from = new Date('2026-01-01T00:00:00.000Z');
    const atCap = new Date(from.getTime() + CAMPAIGN_SERIES_MAX_WINDOW_DAYS * MS_PER_DAY);
    const overCap = new Date(atCap.getTime() + 1);

    const app = await buildApp('account_admin');
    const ok = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=${from.toISOString()}&to=${atCap.toISOString()}`,
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
    // The at-cap half above legitimately reached core; `refuse` asserts nothing
    // did, so the counter has to be reset between the two.
    vi.clearAllMocks();

    const { status, body } = await refuse(
      `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=${from.toISOString()}&to=${overCap.toISOString()}`,
    );
    expect(status).toBe(400);
    const fieldErrors = (body['details'] as { fieldErrors: Record<string, string[]> }).fieldErrors;
    // The refusal names the cap, so a caller learns to page by quarter rather
    // than discovering an empty answer.
    expect(fieldErrors['from']![0]).toContain(`${CAMPAIGN_SERIES_MAX_WINDOW_DAYS} days`);
  });

  it('400s a missing `from` or `to` rather than aggregating an unbounded window', async () => {
    const missingTo = await refuse(`${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=${FROM}`);
    expect(missingTo.status).toBe(400);

    const both = await refuse(`${PREFIX}/campaigns/${CAMPAIGN}/stats/series`);
    expect(both.status).toBe(400);
  });

  it('400s a zone-less date-time rather than reading it in the server\'s zone', async () => {
    // Which container answered is not a fact about the caller's window. Mirrors
    // core's `parseFilterDate` exactly — master must refuse only what core refuses.
    const { status } = await refuse(
      `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=2026-08-11T00:00:00&to=${TO}`,
    );

    expect(status).toBe(400);
  });

  it('accepts the date-only spelling core accepts, so master is never the stricter hop', async () => {
    const app = await buildApp('account_admin');

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=2026-08-11&to=2026-08-14`,
    });

    expect(res.statusCode).toBe(200);
    // Forwarded verbatim: core re-reads it as UTC midnight, the same instant
    // master measured the window against.
    expect(mocks.proxyToCore.mock.calls[0]![0].query)
      .toEqual({ from: '2026-08-11', to: '2026-08-14' });
    await app.close();
  });

  it('400s a calendar-invalid date rather than silently rolling it forward', async () => {
    // `new Date('2026-02-30')` answers March 2nd. A window that quietly moves is
    // worse than one that is refused.
    const { status } = await refuse(
      `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=2026-02-30&to=2026-03-15`,
    );

    expect(status).toBe(400);
  });

  it('400s an unrecognised query param instead of dropping it', async () => {
    // A dropped filter is a request that succeeded while answering a different
    // question — on a chart, an axis nobody asked for.
    const { status, body } = await refuse(seriesUrl({ campaign_id: 'other-campaign' }));

    expect(status).toBe(400);
    expect(body['code']).toBe('unknown_query_params');
    expect((body['details'] as { unknown: string[] }).unknown).toEqual(['campaign_id']);
  });

  it('reads a REPEATED bucket the way core does — the first, not a refusal', async () => {
    /**
     * This used to assert a 400, on the reasoning that there is no defensible
     * pick between two contradictory instructions. The reasoning is fine and the
     * refusal was still wrong, because it was MASTER's alone: core reads `bucket`
     * through `singleParam`, which takes `raw[0]`, so the same URL answers 200
     * with `bucket: day` one hop down. Master refusing what core answers is the
     * one thing this route's validation may not do — the supervisor sees a chart
     * that will not load and no cause they can act on.
     *
     * Pinned as the RESOLVED value rather than just the status: a 200 that
     * forwarded `day,week` would fail at core instead, and a 200 that forwarded
     * `week` would answer a different question from the one core's own parser
     * answers for the identical URL.
     */
    const app = await buildApp('account_admin');

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=${FROM}&to=${TO}&bucket=day&bucket=week`,
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore.mock.calls[0]![0].query)
      .toEqual({ from: FROM, to: TO, bucket: 'day' });
    await app.close();
  });

  it('reads a REPEATED bound the same way, and measures the window against it', async () => {
    // Same `singleParam` rule on `from`/`to`. The second spelling here is a
    // 400-worthy window on its own (inverted), so a master that joined or
    // preferred it would refuse a request core answers.
    const app = await buildApp('account_admin');

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=${FROM}&from=2027-01-01T00:00:00.000Z&to=${TO}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({ from: FROM, to: TO });
    await app.close();
  });

  it('accepts a PADDED bound and forwards it trimmed', async () => {
    /**
     * `?from=2026-08-11%20`. Core's `parseFilterDate` opens with `singleParam`,
     * which trims, so core answers 200 — while master measured the padded string
     * against the ISO regexes and answered 400. The second half matters as much
     * as the status: the trimmed value is what goes on the wire, so core re-reads
     * the exact string master measured the window and the day cap against.
     */
    const app = await buildApp('account_admin');

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/stats/series`
        + `?from=${encodeURIComponent(' 2026-08-11 ')}&to=${encodeURIComponent('2026-08-14\t')}`
        + `&bucket=${encodeURIComponent(' week ')}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore.mock.calls[0]![0].query)
      .toEqual({ from: '2026-08-11', to: '2026-08-14', bucket: 'week' });
    await app.close();
  });

  it('still refuses a padded value that is not a date once trimmed', async () => {
    // Trimming is core's reading of the value, not a licence to accept anything:
    // the vocabulary and the ISO rules still decide, and they still decide before
    // the core round trip.
    const bucket = await refuse(seriesUrl({ bucket: ' hour ' }));
    expect(bucket.status).toBe(400);

    vi.clearAllMocks();

    const from = await refuse(
      `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=${encodeURIComponent(' nonsense ')}&to=${TO}`,
    );
    expect(from.status).toBe(400);
  });

  it('treats a WHITESPACE-ONLY bound as absent, and then as missing', async () => {
    // `singleParam` folds a blank to absent — `?from=` is what a cleared control
    // posts — and both bounds are required on this route, at both hops. So the
    // 400 is "is required", not "is not a date", and it is still master's.
    const { status } = await refuse(
      `${PREFIX}/campaigns/${CAMPAIGN}/stats/series?from=${encodeURIComponent('   ')}&to=${TO}`,
    );

    expect(status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('core\'s series payload is forwarded untouched', () => {
  it('sends core\'s body byte-identically, key order included', async () => {
    const app = await buildApp('account_admin');

    const res = await app.inject({ method: 'GET', url: seriesUrl() });

    expect(JSON.stringify(res.json())).toBe(JSON.stringify(CORE_SERIES));
    await app.close();
  });

  it('calls the sibling of the live stats path, with the campaign from the URL', async () => {
    const app = await buildApp('account_admin');

    await app.inject({ method: 'GET', url: seriesUrl() });

    const call = mocks.proxyToCore.mock.calls[0]![0];
    expect(call.method).toBe('GET');
    expect(call.path).toBe(`/agency-campaigns/${CAMPAIGN}/stats/series`);
    // A route template, never the interpolated path: the metrics SDK would otherwise
    // retain one permanent series per campaign id.
    expect(call.metricPath).toBe('/agency-campaigns/:id/stats/series');
    // Tenancy goes through the proxy helper's own arguments — master never
    // hand-rolls the `x-mgkvc-*` headers or the core API key.
    expect(call.tenantId).toBe(TENANT);
    expect(call.accountId).toBe(ACCOUNT);
    // PORT NOTE (magick-agency): `coreApiKey` assertion deleted — `callCore` takes no key.
    await app.close();
  });

  it('keeps bucket_start as a bare YYYY-MM-DD calendar day', async () => {
    /**
     * The single most expensive thing that could go wrong here. `bucket_start` is
     * cut in the campaign's own zone, so it is a DATE and not an instant — and a
     * date-only string is the one ISO form `new Date()` parses as UTC midnight.
     * One `new Date(x).toISOString()` anywhere on this hop turns `2026-08-11`
     * into `2026-08-11T00:00:00.000Z`, which every reader west of Greenwich
     * renders as the 10th.
     */
    const app = await buildApp('account_admin');

    const body = (await app.inject({ method: 'GET', url: seriesUrl() })).json() as AgencyCampaignStatsSeries;

    for (const bucket of body.buckets) {
      expect(bucket.bucket_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Stated twice on purpose: the regex above would still pass a value that
      // had been re-serialised and re-truncated, and this one names the failure.
      expect(bucket.bucket_start).not.toContain('T');
      expect(bucket.bucket_start).not.toContain('Z');
    }
    expect(body.buckets.map((b) => b.bucket_start))
      .toEqual(['2026-08-11', '2026-08-12', '2026-08-13']);
    await app.close();
  });

  it('keeps the all-zero bucket — a quiet day is not an empty one', async () => {
    // Core emits every bucket in `[from, to)`, zeros included. Filtering a zero
    // row out as "empty" turns a trough into a gap, and a gap is a different
    // claim: "we were open and nobody dialled" stops being sayable.
    const app = await buildApp('account_admin');

    const body = (await app.inject({ method: 'GET', url: seriesUrl() })).json() as AgencyCampaignStatsSeries;

    expect(body.buckets).toHaveLength(3);
    expect(body.buckets[1]).toEqual({
      bucket_start: '2026-08-12',
      attempts: 0,
      connected: 0,
      successes: 0,
      talk_seconds: 0,
      wrapup_seconds: 0,
    });
    await app.close();
  });

  it('adds NO rates — the client derives them so it can render null, not 0', async () => {
    // A rate computed here would be a second definition of "connect rate", and it
    // would have to answer 0 or null for a zero denominator in a hop that cannot
    // see how the chart renders. Both are the client's call.
    const app = await buildApp('account_admin');

    const body = (await app.inject({ method: 'GET', url: seriesUrl() })).json() as Record<string, unknown>;

    const bucket = (body['buckets'] as Record<string, unknown>[])[0]!;
    expect(Object.keys(bucket)).toEqual([
      'bucket_start', 'attempts', 'connected', 'successes', 'talk_seconds', 'wrapup_seconds',
    ]);
    expect(bucket).not.toHaveProperty('connect_rate_pct');
    expect(bucket).not.toHaveProperty('success_rate_pct');
    await app.close();
  });

  it('forwards a field this repo has never heard of', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { ...structuredClone(CORE_SERIES), some_field_added_next_quarter: { nested: [1, 2, 3] } },
    });
    const app = await buildApp('account_admin');

    const body = (await app.inject({ method: 'GET', url: seriesUrl() })).json() as Record<string, unknown>;

    expect(body['some_field_added_next_quarter']).toEqual({ nested: [1, 2, 3] });
    await app.close();
  });

  it('does NOT enrich the series the way the live strip is enriched', async () => {
    // `enrichAgencyCampaignStats` fills two fields master owns on the LIVE strip —
    // `agents[].agent_name` and the `credits_low` stall arm. A series has neither
    // an agent row to name nor a live diagnosis to make, so running it here would
    // be a database read per poll that adds no field. Pinned because "the stats
    // route enriches, so the stats series route should too" is the obvious wrong
    // symmetry.
    const app = await buildApp('account_admin');

    const body = (await app.inject({ method: 'GET', url: seriesUrl() })).json() as Record<string, unknown>;

    expect(body).not.toHaveProperty('stall');
    expect(body).not.toHaveProperty('other_stalls');
    expect(body).not.toHaveProperty('agents');
    await app.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('master fails closed on core, through the shared error path', () => {
  it.each([400, 404, 409, 500, 503])('forwards core\'s %i status verbatim', async (status) => {
    // No status invention and no new error-mapping helper: core's refusal IS the
    // answer (a 404 for a campaign in another tenant is what keeps a campaign id
    // from being an oracle), and `errorMaskHook` decides what of the body reaches
    // the client.
    mocks.proxyToCore.mockResolvedValue({
      status,
      body: { error: 'core said no', details: [{ param: 'from', message: 'too wide' }] },
      headers: new Headers(),
    });
    const app = await buildApp('account_admin');

    const res = await app.inject({ method: 'GET', url: seriesUrl() });

    expect(res.statusCode).toBe(status);
    await app.close();
  });

  it('keeps the 404 STATUS when core has no such route yet', async () => {
    /**
     * The master-new / core-old window: core's own Fastify answers
     * `{ error: 'Not Found' }` with no `code` and no `details`, so `errorMaskHook`
     * replaces the BODY with the generic support message — `'Not Found'` is
     * deliberately not in `FORWARDABLE_ERROR_LABELS`, because adding it there
     * would unmask 404s on every proxied route in master.
     *
     * What the client is entitled to is therefore the status, and this pins it:
     * master neither invents a status nor fabricates a series. See the route's
     * own docstring for why the two causes of a 404 here are merged on purpose.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 404,
      body: { message: 'Route GET:/api/v1/agency-campaigns/c/stats/series not found', error: 'Not Found', statusCode: 404 },
      headers: new Headers(),
    });
    const app = await buildApp('account_admin');

    const res = await app.inject({ method: 'GET', url: seriesUrl() });

    expect(res.statusCode).toBe(404);
    // The half that would actually hurt: an empty series drawn as a flat line
    // reads as a campaign that dialled nobody.
    expect(res.json()).not.toHaveProperty('buckets');
    // PORT NOTE (magick-agency): master's `FORWARDABLE_ERROR_LABELS.has('Not Found')`
    // assertion is deleted with the error mask. (In one process core's handler table is
    // always the same build, so "core has no such route yet" cannot occur either; the case
    // stays as the status contract for any core 404.)
    await app.close();
  });

  it('forwards core\u2019s OWN 404 with its code intact', async () => {
    // The other cause: a campaign in another tenant or none at all.
    // `campaign_not_found` is allow-listed, and `isStructuredClientError`
    // forwards on the code alone, so this body is not masked — the console can
    // say "that campaign is gone" rather than "contact support".
    const body = { error: 'Not Found', code: 'campaign_not_found' };
    mocks.proxyToCore.mockResolvedValue({ status: 404, body, headers: new Headers() });
    const app = await buildApp('account_admin');

    const res = await app.inject({ method: 'GET', url: seriesUrl() });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(body);
    // PORT NOTE (magick-agency): `FORWARDABLE_ERROR_CODES` assertion deleted with the mask;
    // there is no mask, so core's body reaches the client as written.
    await app.close();
  });

  it('does not swallow a transport failure into an empty 200', async () => {
    // `proxyToCore` rethrows; the handler deliberately does not catch, so this
    // reaches Fastify's error handler as a 500 that `errorMaskHook` has already
    // replaced with the generic support body. A chart drawn from a fabricated
    // empty series would read as a campaign that did nothing.
    mocks.proxyToCore.mockRejectedValue(new Error('ECONNREFUSED'));
    const app = await buildApp('account_admin');

    const res = await app.inject({ method: 'GET', url: seriesUrl() });

    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the plugin-level path guard covers the new route', () => {
  it('refuses a campaign id carrying a path separator', async () => {
    /**
     * Not this route's own doing: `rejectPathEscapingParams()` is a plugin hook,
     * which is the point — a per-handler check is one a new route can forget.
     * What matters for THIS route is the direction the guard runs in.
     * `GET /campaigns/:id` is floored at `viewer` and interpolates its `:id` as
     * the LAST segment of core's path, so without the hook a `viewer` sending
     * `:id = campaign-1/stats/series` would reach this `account_admin` read.
     */
    const app = await buildApp('viewer');

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${encodeURIComponent('campaign-1/stats/series')}`,
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});
