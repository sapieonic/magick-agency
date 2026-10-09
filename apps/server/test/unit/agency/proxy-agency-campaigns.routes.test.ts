import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';

/*
 * `callCore` (`src/api/core-dispatch.js`) is mocked as `mocks.proxyToCore` (there is no API key
 * to resolve); the audit logger is `platformAuditLogger`; the logger mock is a partial over
 * `@magick-agency/observability`; the route registers no capability gate;
 * `getFileBuffer` is the internal handler's `getFile` (B14); RBAC permissions are
 * `agency.campaigns.read|write` in the source table. Ids are short opaque ones (the
 * UUID guard is `agencyPlugin`'s, outside this route plugin).
 */
const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  getFileStream: vi.fn(),
  getFileBuffer: vi.fn(),
  uploadFile: vi.fn().mockResolvedValue(undefined),
  repo: {
    create: vi.fn(),
    findById: vi.fn(),
    requestCancel: vi.fn(),
  },
  serviceRun: vi.fn().mockResolvedValue(undefined),
  supersedeRoster: vi.fn(),
  auditLog: vi.fn(),
  // Mutable, because the flag decides whether a route is REGISTERED — so it has
  // to be set before `buildApp()` rather than per request. Frozen in production
  // (`Object.freeze` in `config/index.ts`); mutable here is the point.
  config: { agency: { rosterReplaceEnabled: false } },
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: mocks.getFileStream,
  getFile: mocks.getFileBuffer,
  uploadFile: mocks.uploadFile,
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: mocks.repo,
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: mocks.serviceRun },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// Auth/tenant/capability/RBAC are each covered by their own suites; here they
// are stubbed to no-ops so these tests exercise the ROUTE behaviour rather than
// re-testing four middlewares. The permission each route carries is asserted
// separately, from the source, at the bottom of this file.
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => {},
}));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
// Partial: `RosterSupersedeError` must be the REAL class or the route's
// `instanceof` arms cannot fire, and those arms are the whole error contract.
vi.mock('../../../src/agency/agency-roster.client.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/agency/agency-roster.client.js')
  >('../../../src/agency/agency-roster.client.js');
  return { ...actual, supersedeRoster: mocks.supersedeRoster };
});

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import { RosterSupersedeError } from '../../../src/agency/agency-roster.client.js';
import type { AgencyCampaignWire } from '../../../src/agency/agency-campaign-wire.js';

const PREFIX = '/proxy/agency';

const ACTING_USER = 'user-1';

/**
 * `membershipAccountId` models the caller's OWN membership scope (what
 * `tenantContextMiddleware` resolves), distinct from `accountId` — the
 * unauthenticated `X-Account-Id` header. Omitted ⇒ no membership on the
 * request, i.e. tenant-wide, which is what every pre-existing test assumes.
 * `accountId: null` models a caller who omitted the header.
 */
async function buildApp(
  tenantId = TENANT,
  opts: { membershipAccountId?: string | null; accountId?: string | null } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    (request as { tenantId?: string }).tenantId = tenantId;
    const accountId = opts.accountId === undefined ? 'account-1' : opts.accountId;
    if (accountId !== null) (request as { accountId?: string }).accountId = accountId;
    (request as { user?: { id: string } }).user = { id: ACTING_USER };
    if (opts.membershipAccountId !== undefined) {
      (request as { membership?: { account_id: string | null } }).membership = {
        account_id: opts.membershipAccountId,
      };
    }
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenant_id: TENANT,
    account_id: 'account-1',
    campaign_id: 'campaign-1',
    s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
    file_name: 'roster.csv',
    file_size_bytes: '1000',
    status: 'running',
    dry_run: false,
    rows_read: '500',
    accepted: '400',
    rejected: '100',
    duplicates: '30',
    rejected_by_reason: { invalid_phone: 70, duplicate_phone: 30 },
    bytes_read: '500',
    chunks_sent: 1,
    headers: ['Mobile', 'Name'],
    context_columns: ['Name'],
    rejected_s3_key: null,
    rejected_row_count: 0,
    rejected_truncated: false,
    core_rejected_duplicate_rows: '0',
    core_duplicate_source_rows: [],
    core_rejected_duplicate_rows_may_undercount: false,
    replace_superseded_uncertain: false,
    error_code: null,
    error_message: null,
    created_at: new Date('2026-08-11T00:00:00Z'),
    started_at: new Date('2026-08-11T00:00:01Z'),
    finished_at: null,
    ...overrides,
  };
}

describe('agency campaign proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { ok: true }, headers: new Headers() });
    // `clearAllMocks` resets the vi.fn()s but not this plain object, so it is
    // restored by hand — a leaked `true` would silently register a destructive
    // route for every later test in the file.
    mocks.config.agency.rosterReplaceEnabled = false;
  });

  it('proxies campaign edit as PATCH with the body intact', async () => {
    // PATCH. The method union AND the body-serialisation gate in
    // the proxy client both had to be widened — a method missing from the gate
    // sends no body and the internal handler answers 200 to a write that did nothing.
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/campaigns/c1`,
      payload: { name: 'Renewals Q3' },
    });

    expect(res.statusCode).toBe(200);
    const call = mocks.proxyToCore.mock.calls[0]![0];
    expect(call.method).toBe('PATCH');
    expect(call.path).toBe('/agency-campaigns/c1');
    expect(call.body).toEqual({ name: 'Renewals Q3' });
    await app.close();
  });

  it.each([
    ['start', '/agency-campaigns/c1/start'],
    ['pause', '/agency-campaigns/c1/pause'],
    ['resume', '/agency-campaigns/c1/resume'],
    ['stop', '/agency-campaigns/c1/stop'],
  ])('proxies %s to its own the internal handler path', async (action, corePath) => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/c1/${action}` });
    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore.mock.calls[0]![0].path).toBe(corePath);
    await app.close();
  });

  it('relays the internal handler\'s status for stop rather than asserting a terminal state', async () => {
    // A 200 from stop means "accepted and draining": the pacing leader writes
    // `stopping → stopped` on its next idle tick, because that transition has
    // exactly one writer. The proxy must not invent a terminal state.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { status: 'stopping' },
      headers: new Headers(),
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/c1/stop` });
    expect(res.json()).toEqual({ status: 'stopping' });
    await app.close();
  });

  /**
   * `break_reasons` (internal handler migration 078).
   *
   * Campaign config is the **sole authority** on which break codes the internal handler will
   * accept, and it reaches the internal handler through this pass-through. The public API layer deliberately
   * holds no schema for it and no copy of the built-in default list: the internal handler owns
   * the column, the internal handler serves it through bootstrap, and the internal handler validates
   * `POST /sessions/:id/break` against it, answering `unknown_break_reason` with
   * `allowed_codes`. A mirror here would be a second copy of a rule that can go
   * stale — the same reason the IVR smart-TTS fields round-trip unvalidated.
   *
   * These tests exist because "we didn't write any code" is exactly the change
   * a later refactor silently breaks: the moment anybody adds a Zod schema to
   * these two handlers to validate something else, an undeclared `break_reasons`
   * is stripped, every campaign silently falls back to the defaults, and the
   * break picker an operator configured stops working with no error anywhere.
   */
  it('round-trips break_reasons through create untouched', async () => {
    const breakReasons = [
      { code: 'lunch', label: 'Lunch', is_paid: false },
      { code: 'training', label: 'Training', is_paid: true },
      { code: 'bio', label: 'Comfort break' },
    ];
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns`,
      payload: { name: 'Renewals Q3', break_reasons: breakReasons },
    });

    expect(res.statusCode).toBe(200);
    const call = mocks.proxyToCore.mock.calls[0]![0];
    expect(call.path).toBe('/agency-campaigns');
    // Field-wise, not whole-body: the create path defaults `disposition_catalog` on
    // create, so a whole-body equality would now fail for a reason that has nothing
    // to do with break reasons. Naming the field is also the stronger guard — it
    // survives the next legitimate default too.
    expect((call.body as Record<string, unknown>)['name']).toBe('Renewals Q3');
    expect((call.body as Record<string, unknown>)['break_reasons']).toEqual(breakReasons);
    await app.close();
  });

  it('round-trips break_reasons through edit untouched, including an empty list', async () => {
    // An empty list is meaningful and must not be confused with "absent": it is
    // how an operator says "this campaign configures none", which is what makes
    // the internal handler fall back to its built-in defaults.
    const app = await buildApp();
    await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/campaigns/c1`,
      payload: { break_reasons: [] },
    });

    expect(mocks.proxyToCore.mock.calls[0]![0].body).toEqual({ break_reasons: [] });
    await app.close();
  });

  it('does not invent a default break list of its own', async () => {
    /**
     * The public API layer must never populate `break_reasons`. If it did, a campaign that
     * configures none would arrive at the internal handler carrying the public API layer's idea of the defaults,
     * and the authority would silently move to the service that does not own the
     * column.
     *
     * ── Why this now asserts one FIELD and not the whole body ──────────────────
     * The create path does default `disposition_catalog`, which reads like a
     * breach of this exact rule. It is not, and the difference is verifiable in
     * the internal handler rather than only in prose:
     *
     *  - `break_reasons` HAS an internal-handler-side default. `break-manager.ts:52,59`
     *    substitutes `DEFAULT_BREAK_REASONS` whenever the configured list is empty
     *    or invalid, so an empty list means "use the internal handler's built-ins". The public API layer
     *    populating it would override a real default — the harm named above.
     *  - `disposition_catalog` has NO such substitution. `requiresDisposition`
     *    reads empty as "no disposition required", a distinct configuration. There
     *    is nothing for the public API layer's default to override, and without it the column's
     *    `'[]'` was never seeded by anything, so disposition was inert on every
     *    campaign the platform had made.
     *
     * So the rule is intact and its scope is narrower than a whole-body equality
     * implied. Asserting the field keeps the guard and stops it failing for reasons
     * that are not about break reasons.
     */
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns`,
      payload: { name: 'Renewals Q3' },
    });

    const body = mocks.proxyToCore.mock.calls[0]![0].body as Record<string, unknown>;
    expect('break_reasons' in body).toBe(false);
    await app.close();
  });

  it('exposes NO concurrency setter anywhere on the campaign surface (D10)', async () => {
    // Concurrency is super-admin only: an account that can raise its own limit
    // can raise its own carrier spend. There is no /proxy/account-settings and
    // none is being added.
    const app = await buildApp();
    for (const url of [
      `${PREFIX}/campaigns/c1/concurrency`,
      `${PREFIX}/account-settings`,
      `${PREFIX}/campaigns/c1/max-concurrent-calls`,
    ]) {
      const res = await app.inject({ method: 'POST', url, payload: { max_concurrent_calls: 50 } });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });
});

/**
 * Campaign lifecycle actions routed through the platform audit
 * trail. These are proxy routes, so the whole point is that a row is written
 * only for what the internal handler actually accepted — never for what the browser asked for.
 */
describe('campaign lifecycle audit trail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.agency.rosterReplaceEnabled = false;
  });

  it.each([
    ['start', 'agency_campaign.started'],
    ['pause', 'agency_campaign.paused'],
    ['resume', 'agency_campaign.resumed'],
    ['stop', 'agency_campaign.stopped'],
  ])('audits %s as %s on a 2xx from the internal handler, with the resulting status', async (route, action) => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { id: 'c1', status: 'paused' },
      headers: new Headers(),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/c1/${route}` });

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: 'account-1',
      actor_type: 'human',
      user_id: ACTING_USER,
      action,
      resource_type: 'agency_campaign',
      resource_id: 'c1',
      campaign_id: 'c1',
      details: { campaign_id: 'c1', status: 'paused' },
    });
    await app.close();
  });

  it.each(['start', 'pause', 'resume', 'stop'])(
    'does NOT audit %s when the internal handler answers a 4xx',
    async (route) => {
      mocks.proxyToCore.mockResolvedValue({
        status: 409,
        body: { error: 'Conflict', message: 'campaign is not in a startable state' },
        headers: new Headers(),
      });
      const app = await buildApp();

      const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/c1/${route}` });

      expect(res.statusCode).toBe(409);
      expect(mocks.auditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each(['start', 'pause', 'resume', 'stop'])(
    'does NOT audit %s when the internal handler answers a 5xx',
    async (route) => {
      mocks.proxyToCore.mockResolvedValue({
        status: 502,
        body: { error: 'Bad Gateway' },
        headers: new Headers(),
      });
      const app = await buildApp();

      const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/c1/${route}` });

      expect(res.statusCode).toBe(502);
      expect(mocks.auditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('omits `details` rather than fabricating a status when the internal handler\'s body carries none', async () => {
    // `stop` answers 200 with `{ status: 'stopping' }` normally, but the audit
    // call must not assume the shape — a body with no `status` field (or a
    // non-string one) must not throw and must not invent a value.
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { ok: true }, headers: new Headers() });
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/c1/stop` });

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: 'account-1',
      actor_type: 'human',
      user_id: ACTING_USER,
      action: 'agency_campaign.stopped',
      resource_type: 'agency_campaign',
      resource_id: 'c1',
      campaign_id: 'c1',
      details: { campaign_id: 'c1' },
    });
    await app.close();
  });
});

describe('agency ingest routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The campaign-ownership probe (`proveCampaignOwnedForWrite`) runs before
    // every roster WRITE. Set explicitly: `clearAllMocks` keeps implementations,
    // so without this the probe silently inherited whatever an earlier describe
    // left behind.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { id: 'campaign-1', account_id: 'account-1' },
      headers: new Headers(),
    });
    // `clearAllMocks` resets the vi.fn()s but not this plain object, so it is
    // restored by hand — a leaked `true` would silently register a destructive
    // route for every later test in this block.
    mocks.config.agency.rosterReplaceEnabled = false;
  });

  it('serves limits from the constants so the wizard shows the real numbers', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/ingest/limits` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ max_rows: 1_000_000, max_columns: 100 });
    await app.close();
  });

  it('analyzes a file and returns headers, samples and a suggestion', async () => {
    mocks.getFileStream.mockResolvedValue({
      body: Readable.from([Buffer.from('Mobile,Name\n9876543210,Asha\n', 'utf8')]),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/ingest/analyze`,
      payload: { s3_key: `agency-ingest/${TENANT}/u/roster.csv`, default_country_code: '91' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.headers).toEqual(['Mobile', 'Name']);
    expect(body.suggested_phone_column).toBe('Mobile');
    await app.close();
  });

  it('refuses to analyze another tenant\'s S3 key', async () => {
    // The key is client-supplied, so ownership must be proved. Without this a
    // tenant could name another tenant's upload and have the analyzer read its
    // sample values back to them.
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/ingest/analyze`,
      payload: { s3_key: `agency-ingest/${OTHER_TENANT}/u/roster.csv` },
    });
    expect(res.statusCode).toBe(403);
    expect(mocks.getFileStream).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a structured 422 for an unreadable file rather than a 500', async () => {
    mocks.getFileStream.mockResolvedValue({
      body: Readable.from([Buffer.from('Mobile,Name\n', 'utf16le')]),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/ingest/analyze`,
      payload: { s3_key: `agency-ingest/${TENANT}/u/roster.csv` },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('unsupported_encoding');
    await app.close();
  });

  it('starts a dry run WITHOUT a campaign and sends nothing to the internal handler', async () => {
    // The "95% of your rows are valid" answer, before the operator commits.
    mocks.repo.create.mockResolvedValue(job({ dry_run: true, campaign_id: null, status: 'pending' }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/ingest/jobs`,
      payload: {
        s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
        file_name: 'roster.csv',
        phone_column: 'Mobile',
        dry_run: true,
      },
    });

    expect(res.statusCode).toBe(202);
    expect(mocks.repo.create.mock.calls[0]![0]).toMatchObject({ dry_run: true, campaign_id: null });
    // A dry run reaches the internal handler through no path at all.
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a REAL import with no campaign', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/ingest/jobs`,
      payload: {
        s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
        file_name: 'roster.csv',
        phone_column: 'Mobile',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.repo.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('strips a leading + from the campaign country code before storing it', async () => {
    mocks.repo.create.mockResolvedValue(job());
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/ingest/jobs`,
      payload: {
        s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
        file_name: 'roster.csv',
        phone_column: 'Mobile',
        campaign_id: '11111111-2222-3333-4444-555555555555',
        default_country_code: '+1',
      },
    });
    expect(mocks.repo.create.mock.calls[0]![0].default_country_code).toBe('1');
    await app.close();
  });

  it('returns 202 immediately rather than holding the request for minutes', async () => {
    // A 1M-row file takes minutes; the wizard polls the job.
    mocks.repo.create.mockResolvedValue(job({ status: 'pending' }));
    let resolveRun: () => void = () => {};
    mocks.serviceRun.mockReturnValue(new Promise<void>((r) => { resolveRun = r; }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/ingest/jobs`,
      payload: {
        s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
        file_name: 'roster.csv',
        phone_column: 'Mobile',
        campaign_id: '11111111-2222-3333-4444-555555555555',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().job_id).toBe('00000000-0000-4000-8000-000000000001');
    resolveRun();
    await app.close();
  });

  /**
   * ── The ingest MODE, and the destructive branch's guards ──────────────────
   *
   * The internal handler's 083 made a corrected re-upload merge instead of being refused, and
   * the internal handler cannot tell a correction from a top-up because the two are the same
   * request. The public API layer is the only service that holds the operator's intent, so it
   * is the only one that can carry a mode.
   */
  describe('ingest mode', () => {
    const REPLACE_BODY = {
      s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
      file_name: 'roster.csv',
      phone_column: 'Mobile',
      campaign_id: '11111111-2222-3333-4444-555555555555',
      mode: 'replace',
      expected_contacts_total: 5000,
    };

    it('defaults to append and says so in the response', async () => {
      // The default is a decision, not an omission: `append` is today's
      // behaviour and the non-destructive value, so a caller that says nothing
      // gets exactly what it got yesterday. Echoing it is the part that was
      // missing before — an intent nobody could observe is how this class of bug
      // started.
      mocks.repo.create.mockResolvedValue(job({ status: 'pending', mode: 'append' }));
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: {
          s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
          file_name: 'roster.csv',
          phone_column: 'Mobile',
          campaign_id: '11111111-2222-3333-4444-555555555555',
        },
      });

      expect(res.json().mode).toBe('append');
      // Not passed through to the repository at all, so the column's own default
      // applies and a pre-057 database still accepts the INSERT.
      expect(mocks.repo.create.mock.calls[0]![0].mode).toBeUndefined();
      await app.close();
    });

    it('refuses a replace when the deployment has not enabled it', async () => {
      // 400, not 501: the error mask rewrites every 5xx into "contact support
      // and quote this request id", which would delete the one sentence that is
      // actually true and actionable.
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: REPLACE_BODY,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('not enabled');
      // Refused BEFORE the job row exists — a `pending` job that can never
      // legally run is a row the reaper has to clean up and an operator has to
      // interpret.
      expect(mocks.repo.create).not.toHaveBeenCalled();
      await app.close();
    });

    it('refuses a replace that is also a dry run', async () => {
      // A preview that destroys the roster it is previewing. This is the one
      // combination an operator could plausibly send while trying to be careful.
      mocks.config.agency.rosterReplaceEnabled = true;
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: { ...REPLACE_BODY, dry_run: true },
      });

      expect(res.statusCode).toBe(400);
      expect(mocks.repo.create).not.toHaveBeenCalled();
      await app.close();
    });

    it('refuses a replace with no expected_contacts_total', async () => {
      // The compare-and-swap is the only server-side confirmation that does real
      // work: a colleague's top-up between the screen and the click is invisible
      // to every other check, and is exactly the case where "retire everything"
      // is not what anyone meant.
      mocks.config.agency.rosterReplaceEnabled = true;
      const app = await buildApp();
      const { expected_contacts_total: _omitted, ...withoutCount } = REPLACE_BODY;
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: withoutCount,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('expected_contacts_total');
      expect(mocks.repo.create).not.toHaveBeenCalled();
      await app.close();
    });

    it('records the mode on the job and hands the expected count to the run', async () => {
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.repo.create.mockResolvedValue(job({ status: 'pending', mode: 'replace' }));
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: REPLACE_BODY,
      });

      expect(res.statusCode).toBe(202);
      expect(res.json().mode).toBe('replace');
      expect(mocks.repo.create.mock.calls[0]![0].mode).toBe('replace');
      expect(mocks.serviceRun.mock.calls[0]![0].expectedContactsTotal).toBe(5000);
      await app.close();
    });

    it('surfaces the mode and the retired count on the job payload', async () => {
      // `replace_superseded_contacts` is the field to render loudest on a FAILED
      // replace: a failed append leaves the campaign as it was, a failed replace
      // may have already emptied it, and nothing else distinguishes them.
      mocks.repo.findById.mockResolvedValue(
        job({ status: 'failed', mode: 'replace', replace_superseded_contacts: '5000' }),
      );
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();

      expect(body.mode).toBe('replace');
      expect(body.replace_superseded_contacts).toBe(5000);
      // Exactly 5,000 — not "maybe". The pair is what carries the meaning.
      expect(body.replace_superseded_uncertain).toBe(false);
      await app.close();
    });

    it('distinguishes "nothing retired" from "we could not confirm"', async () => {
      /**
       * The third state, which a nullable count alone could not express and which
       * was being reported as the second. `supersedeRoster` makes up to four
       * attempts, so one can commit and a later one be refused by the internal handler's
       * compare-and-swap — leaving the roster gone, the count unknown, and every
       * other signal saying "the internal handler refused".
       *
       *   (N, false)    exactly N retired
       *   (NULL, false) nothing retired
       *   (NULL, true)  the roster MAY be gone, count unknown
       */
      mocks.repo.findById.mockResolvedValue(
        job({
          status: 'failed',
          mode: 'replace',
          replace_superseded_contacts: null,
          replace_superseded_uncertain: true,
          error_code: 'replace_refused',
        }),
      );
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();

      expect(body.replace_superseded_contacts).toBeNull();
      expect(body.replace_superseded_uncertain).toBe(true);
      await app.close();
    });

    it('reports append and null on a row written before migration 057', async () => {
      // `SELECT *` against a pre-057 database returns a row with neither key.
      // Append is both the historical truth and the fail-safe reading — a client
      // must never infer "this was a replace" from an absence.
      const preMigration = job();
      delete (preMigration as Record<string, unknown>).mode;
      delete (preMigration as Record<string, unknown>).replace_superseded_contacts;
      mocks.repo.findById.mockResolvedValue(preMigration);

      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();

      expect(body.mode).toBe('append');
      expect(body.replace_superseded_contacts).toBeNull();
      // `false`, unlike the undercount flag above — and the asymmetry is
      // deliberate. That flag qualifies a number the public API layer tried and failed to write;
      // this one asserts a destructive act happened, and an absent column is no
      // evidence at all that it did. Inventing `true` here would warn every
      // operator on every append that their roster might be gone.
      expect(body.replace_superseded_uncertain).toBe(false);
      await app.close();
    });
  });

  /**
   * ── Clearing a roster ─────────────────────────────────────────────────────
   *
   * There has never been a way to do this — no route in the public API layer, no endpoint in
   * the internal handler — while the console's own summary copy tells operators in two places that
   * they can "clear and re-upload". The product's advice was impossible to
   * follow.
   */
  describe('roster clear', () => {
    it('is not registered at all when the deployment has not enabled it', async () => {
      // The public API layer's own idiom (an entire subsystem registers only if its config
      // says so). A destructive surface that is visible but always fails is
      // worse than one that is not there.
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 10 },
      });

      expect(res.statusCode).toBe(404);
      expect(mocks.supersedeRoster).not.toHaveBeenCalled();
      await app.close();
    });

    it('retires every live contact, exempting nothing', async () => {
      // No `ingestJobId`: nothing is being loaded, so nothing is protected.
      // Sending one would make the request read as a replace in the internal handler's audit row.
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.supersedeRoster.mockResolvedValue({
        superseded: 4210, retained: 0, contacts_total: 0, already_applied: false,
      });
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 4210 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        campaign_id: 'c1',
        // Explicit, so the `unconfirmed` state below is never inferred from an
        // absent field — the same rule the job payload's uncertainty flag follows.
        roster_state: 'cleared',
        cleared: 4210,
        contacts_total: 0,
        already_applied: false,
      });
      expect(mocks.supersedeRoster.mock.calls[0]![0]).toMatchObject({
        campaignId: 'c1',
        expectedContactsTotal: 4210,
        reason: 'clear',
      });
      expect(mocks.supersedeRoster.mock.calls[0]![0].ingestJobId).toBeUndefined();
      await app.close();
    });

    it('requires the expected count rather than defaulting it', async () => {
      // Defaulting a compare-and-swap to "whatever is there" is the same as not
      // having one.
      mocks.config.agency.rosterReplaceEnabled = true;
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(mocks.supersedeRoster).not.toHaveBeenCalled();
      await app.close();
    });

    it('forwards the internal handler\'s refusal as a 409 carrying its machine code', async () => {
      // `campaign_dialing`, `attempts_live` and `contacts_total_mismatch` are
      // three different operator actions. Collapsing them makes the refusal
      // unactionable, and each one is a thing they CAN fix.
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError('The campaign is running.', 409, 'refused', 'campaign_dialing'),
      );
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 10 },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('campaign_dialing');
      await app.close();
    });

    /**
     * ── The clear that cannot say whether it cleared ─────────────────────────
     *
     * `supersedeRoster` makes up to four attempts, so attempt 1 can retire 4,210
     * contacts and commit, lose its response to the 30s timeout, and attempt 2 be
     * answered `409 contacts_total_mismatch` against a roster that is already 0.
     * Answering the browser 409 told the operator their clear failed while their
     * contacts were gone. The ingest replace path already treated `attempts > 1`
     * as unconfirmable; this route never looked.
     */
    it('does not report a FAILURE for a clear whose outcome is unknown', async () => {
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError(
          'Roster has 0 contacts, expected 4210.',
          409,
          'refused',
          'contacts_total_mismatch',
          2,
        ),
      );
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 4210 },
      });

      // 202: the request was accepted, the outcome is not knowable here, read it
      // from the campaign. A 4xx asserts it did not happen — the untruth being
      // fixed — and would additionally be masked by `errorMaskHook` into a
      // support-ticket message, losing the one sentence that matters. A 200
      // asserts the opposite untruth.
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        campaign_id: 'c1',
        roster_state: 'unconfirmed',
        // Null, never 0 — the public API layer has no count, and a zero reads as "we cleared
        // nothing" on the one response that cannot make that claim.
        cleared: null,
        contacts_total: null,
        code: 'roster_state_unconfirmed',
        core_code: 'contacts_total_mismatch',
        attempts: 2,
        message: expect.stringContaining('may already have been removed'),
      });
      // The recovery is re-fetch-and-re-confirm, which is what the
      // `contacts_total_mismatch` guidance already tells the console. A bare retry
      // re-asserts a count that is by now certainly wrong.
      expect(res.json().message).toContain('do not simply retry');
      await app.close();
    });

    it('treats an exhausted-retry transport failure as unconfirmed too, not a masked 500', async () => {
      // `failed` after four attempts is the same uncertainty reached differently:
      // the attempt that could have committed is not the one that answered. A
      // masked 500 here would tell the operator nothing about their roster.
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError(
          'Could not reach the core service to change this roster (4 attempts): core returned 503',
          0,
          'failed',
          undefined,
          4,
        ),
      );
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 10 },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json().roster_state).toBe('unconfirmed');
      // The internal handler never gave a refusal reason, so none is invented.
      expect(res.json()).not.toHaveProperty('core_code');
      await app.close();
    });

    it('still answers 404 after a retry when the internal handler says the campaign does not exist', async () => {
      // The one code the attempt count does not override: a campaign the internal handler cannot
      // find has no roster for the operator to go and check, so "we could not
      // confirm your contacts" would be an alarm about nothing.
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError('Campaign not found', 404, 'campaign_not_found', undefined, 3),
      );
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 10 },
      });

      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('answers 404 for an unknown campaign, carrying the code that survives the mask', async () => {
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError('Campaign not found', 404, 'campaign_not_found'),
      );
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 10 },
      });

      expect(res.statusCode).toBe(404);
      // `campaign_not_found` was already allow-listed in `errorMaskHook`, but the
      // allow-list reads the BODY — and this body was `{ error, message }`, so
      // the internal handler's recorded 404 masked the whole response into "contact support and
      // quote this request id" for a campaign that simply does not exist.
      // `error-mask.als.test.ts` proves the forwarding over the real seam; this
      // asserts the route actually sends the field that forwarding depends on.
      expect(res.json().code).toBe('campaign_not_found');
      await app.close();
    });

    it('does NOT dress an internal handler that cannot serve the hop as an operator error', async () => {
      // Reachable only when the flag is on against an internal handler without the endpoint —
      // i.e. this deployment is wired wrong. That is a server fault, and the
      // error mask's job is to turn it into a request id plus a full log line
      // rather than an explanation of our deployment aimed at an operator.
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError('core has no such route', 404, 'unsupported'),
      );
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 10 },
      });

      expect(res.statusCode).toBe(500);
      await app.close();
    });
  });

  describe('job status', () => {
    it('reconciles accepted + rejected to rows_read, with duplicates as a breakdown', async () => {
      mocks.repo.findById.mockResolvedValue(job());
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();

      expect(body.accepted + body.rejected).toBe(body.rows_read);
      // Never a fourth addend — an operator adds these against their spreadsheet.
      expect(body.duplicates).toBe(30);
      expect(body.rejected_by_reason).toEqual({ invalid_phone: 70, duplicate_phone: 30 });
      await app.close();
    });

    it('caps in-flight progress at 99 so 100 always means finished', async () => {
      // A bar that sits at 100% while work continues is worse than one at 97%.
      mocks.repo.findById.mockResolvedValue(
        job({ status: 'running', bytes_read: '1000', file_size_bytes: '1000' }),
      );
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();
      expect(body.progress_pct).toBe(99);
      await app.close();
    });

    it('reports 100 only once the job is terminal', async () => {
      mocks.repo.findById.mockResolvedValue(job({ status: 'completed', bytes_read: '400' }));
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();
      expect(body.progress_pct).toBe(100);
      await app.close();
    });

    it('reports null progress when the file size is unknown', async () => {
      // Better an indeterminate spinner than a fabricated fraction.
      mocks.repo.findById.mockResolvedValue(job({ file_size_bytes: null }));
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();
      expect(body.progress_pct).toBeNull();
      await app.close();
    });

    it('surfaces the export truncation flag', async () => {
      // An operator fixing a file from a truncated export would re-upload a
      // file that still fails, so the shortfall must be visible.
      mocks.repo.findById.mockResolvedValue(
        job({ rejected_s3_key: 'k', rejected_row_count: 50_000, rejected_truncated: true }),
      );
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();
      expect(body).toMatchObject({
        has_rejected_export: true,
        rejected_row_count: 50_000,
        rejected_truncated: true,
      });
      await app.close();
    });

    it('surfaces a roster gap as an operator-visible failure', async () => {
      mocks.repo.findById.mockResolvedValue(
        job({
          status: 'failed',
          error_code: 'roster_incomplete',
          error_message: 'Core is missing chunks 7, 11. The import did not complete; upload the file again.',
        }),
      );
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();
      expect(body.error_code).toBe('roster_incomplete');
      expect(body.error_message).toContain('7, 11');
      await app.close();
    });

    it('surfaces internal-handler-side duplicate rejections independent of accepted/rejected', async () => {
      // The bug this pins: a re-upload into an already-populated campaign can
      // sail through the public API layer's own accepted/rejected counters (rows_read =
      // accepted + rejected, both about what the public API layer decided to SEND) while the internal handler
      // writes zero rows because every row collided with the existing roster.
      // Without this field the wizard's "5,000 accepted" summary is a lie.
      mocks.repo.findById.mockResolvedValue(
        job({
          accepted: '5000',
          rejected: '0',
          rows_read: '5000',
          core_rejected_duplicate_rows: '5000',
          core_duplicate_source_rows: [2, 3, 4],
        }),
      );
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();

      expect(body.accepted).toBe(5000);
      expect(body.core_rejected_duplicate_rows).toBe(5000);
      expect(body.core_duplicate_source_rows).toEqual([2, 3, 4]);
      await app.close();
    });

    it('defaults internal-handler-side duplicate fields to zero/empty on an ordinary import', async () => {
      mocks.repo.findById.mockResolvedValue(job());
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();

      expect(body.core_rejected_duplicate_rows).toBe(0);
      expect(body.core_duplicate_source_rows).toEqual([]);
      // An exact zero, and the payload says so — this is the shape the console reads
      // as "the internal handler refused nothing", so it must be distinguishable from the shape
      // below.
      expect(body.core_rejected_duplicate_rows_may_undercount).toBe(false);
      await app.close();
    });

    it('tells the client when that zero means "unknown" rather than "none"', async () => {
      // Same zero on the wire, opposite meanings. Without this field a summary
      // built from a chunk the internal handler could not account for renders identically to a
      // clean import, and the operator has no way to learn otherwise — which is
      // the failure the internal handler's migration 084 and the public API layer's 056 exist to end.
      mocks.repo.findById.mockResolvedValue(
        job({
          accepted: '5000',
          rows_read: '5000',
          core_rejected_duplicate_rows: '0',
          core_rejected_duplicate_rows_may_undercount: true,
        }),
      );
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();

      expect(body.core_rejected_duplicate_rows).toBe(0);
      expect(body.core_rejected_duplicate_rows_may_undercount).toBe(true);
      await app.close();
    });

    it('degrades cleanly when the columns are entirely absent (pre-migration-055 row)', async () => {
      // Simulates a `SELECT *` against a database that hasn't run migration
      // 055 yet (or a row from that ordering window) — the keys aren't
      // merely null, they don't exist on the object at all, which is what
      // Number(undefined) → NaN → JSON `null` actually requires to reproduce.
      const preMigrationJob = job();
      delete (preMigrationJob as Record<string, unknown>).core_rejected_duplicate_rows;
      delete (preMigrationJob as Record<string, unknown>).core_duplicate_source_rows;
      delete (preMigrationJob as Record<string, unknown>)
        .core_rejected_duplicate_rows_may_undercount;
      mocks.repo.findById.mockResolvedValue(preMigrationJob);

      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();

      // Without the `?? 0` / `?? []` fallback these would be `null`, not `0`/`[]`.
      expect(body.core_rejected_duplicate_rows).toBe(0);
      expect(body.core_duplicate_source_rows).toEqual([]);
      /**
       * **`true`, not `false`.**
       *
       * The key is missing from `SELECT *` only while the column does not exist —
       * i.e. while the migration that adds it has not been applied — and in that window the
       * repository's `42703` ladder has also been unable to write the trust bit. So
       * `?? false` would report `{ core_rejected_duplicate_rows: 0, may_undercount:
       * false }`: "the internal handler refused nothing, exactly", said confidently about a number
       * the public API layer never recorded. That is a confident wrong zero.
       *
       * Absence of the COLUMN is not absence of an internal handler flag: it means the public API layer could
       * not vouch for the count, so it says so. Once the migration lands, historical rows read
       * the column default `false`, which is correct for them.
       */
      expect(body.core_rejected_duplicate_rows_may_undercount).toBe(true);
      await app.close();
    });

    it('reports an exact zero as exact once migration 056 has landed', async () => {
      // The counterpart, and the one that keeps the flag meaningful: with the
      // column present and false, the summary must read as a clean import rather
      // than warning on every ordinary job.
      mocks.repo.findById.mockResolvedValue(
        job({ core_rejected_duplicate_rows: '0', core_rejected_duplicate_rows_may_undercount: false }),
      );
      const app = await buildApp();
      const body = (await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).json();

      expect(body.core_rejected_duplicate_rows).toBe(0);
      expect(body.core_rejected_duplicate_rows_may_undercount).toBe(false);
      await app.close();
    });

    it('scopes the lookup to the CALLER\'s tenant, and 404s what that scope cannot see', async () => {
      // A job id is not a capability. The tenant predicate itself is SQL, pinned
      // against a real Postgres in agency-ingest-job-account-scope.test.ts; what
      // this asserts is that the route hands the repository the tenant the
      // REQUEST resolved — built with a second tenant so a hard-coded or
      // defaulted tenant id cannot pass by coincidence.
      mocks.repo.findById.mockResolvedValue(null);
      const app = await buildApp(OTHER_TENANT);
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` });
      expect(res.statusCode).toBe(404);
      // Tenant-wide caller: no account predicate.
      expect(mocks.repo.findById).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', OTHER_TENANT, null);
      await app.close();
    });

    it.each([
      ['GET', '/ingest/jobs/not-a-uuid'],
      ['POST', '/ingest/jobs/not-a-uuid/cancel'],
      ['GET', '/ingest/jobs/not-a-uuid/rejected.csv'],
    ] as const)('%s %s is a 404 before any database call, not a 22P02 500', async (method, path) => {
      // The public API layer's own UUID primary key: a malformed id used to reach Postgres as
      // `22P02 invalid_text_representation` and come back as a masked 500.
      const app = await buildApp();
      const res = await app.inject({ method, url: `${PREFIX}${path}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not Found', message: 'Import not found.' });
      expect(mocks.repo.findById).not.toHaveBeenCalled();
      expect(mocks.repo.requestCancel).not.toHaveBeenCalled();
      expect(mocks.getFileBuffer).not.toHaveBeenCalled();
      await app.close();
    });
  });

  /**
   * An account-scoped caller must not poll, export or
   * cancel a SIBLING account's ingest job in the same tenant. The repository
   * does the filtering (an equality predicate on `account_id`); these tests pin
   * that every job-id route hands it the caller's MEMBERSHIP account — never
   * the `X-Account-Id` header — and that a miss is the same 404 a nonexistent
   * id gets, on all three routes.
   */
  describe('account scope (sibling-account IDOR)', () => {
    const OWN = 'account-b';

    it('poll passes the membership account, not the header, and 404s a sibling job', async () => {
      mocks.repo.findById.mockResolvedValue(null);
      // Header omitted — legal for an account-scoped caller, and exactly the
      // case a header-keyed check would read as tenant-wide.
      const app = await buildApp(TENANT, { membershipAccountId: OWN, accountId: null });
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-00000000000a` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not Found', message: 'Import not found.' });
      expect(mocks.repo.findById).toHaveBeenCalledWith('00000000-0000-4000-8000-00000000000a', TENANT, OWN);
      await app.close();
    });

    it('rejected.csv is scoped the same way and never reads S3 for a sibling job', async () => {
      mocks.repo.findById.mockResolvedValue(null);
      const app = await buildApp(TENANT, { membershipAccountId: OWN, accountId: null });
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-00000000000a/rejected.csv` });
      expect(res.statusCode).toBe(404);
      expect(mocks.repo.findById).toHaveBeenCalledWith('00000000-0000-4000-8000-00000000000a', TENANT, OWN);
      expect(mocks.getFileBuffer).not.toHaveBeenCalled();
      await app.close();
    });

    it('cancel scopes the UPDATE itself and 404s (not 409s) a sibling job', async () => {
      mocks.repo.requestCancel.mockResolvedValue(false);
      mocks.repo.findById.mockResolvedValue(null);
      const app = await buildApp(TENANT, { membershipAccountId: OWN, accountId: null });
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-00000000000a/cancel` });
      // 404, indistinguishable from a nonexistent id. The scoped UPDATE is what
      // stops a sibling's live import being cancelled; the re-read under the
      // same scope is what keeps "already finished" for jobs the caller can see.
      expect(res.statusCode).toBe(404);
      expect(mocks.repo.requestCancel).toHaveBeenCalledWith('00000000-0000-4000-8000-00000000000a', TENANT, OWN);
      expect(mocks.repo.findById).toHaveBeenCalledWith('00000000-0000-4000-8000-00000000000a', TENANT, OWN);
      await app.close();
    });

    it('an account-scoped caller still reaches its OWN job, scoped by membership alone', async () => {
      mocks.repo.findById.mockResolvedValue(job({ account_id: OWN }));
      // No header: the scope must come from the membership, never X-Account-Id.
      const app = await buildApp(TENANT, { membershipAccountId: OWN, accountId: null });
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` });
      expect(res.statusCode).toBe(200);
      expect(mocks.repo.findById).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', TENANT, OWN);
      await app.close();
    });

    it('a tenant-wide membership is unrestricted even when it names an account header', async () => {
      mocks.repo.findById.mockResolvedValue(job({ account_id: 'account-a' }));
      mocks.repo.requestCancel.mockResolvedValue(true);
      const app = await buildApp(TENANT, { membershipAccountId: null, accountId: OWN });

      expect((await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001` })).statusCode).toBe(200);
      expect(mocks.repo.findById).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000000001', TENANT, null);

      expect((await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001/cancel` })).statusCode).toBe(202);
      expect(mocks.repo.requestCancel).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000000001', TENANT, null);
      await app.close();
    });

    it('create stamps the membership account when the header is omitted', async () => {
      // Otherwise the job is stamped NULL and the scoped lookups above would
      // refuse to show it back to the caller who created it.
      mocks.repo.create.mockResolvedValue(job({ dry_run: true, campaign_id: null, status: 'pending' }));
      const app = await buildApp(TENANT, { membershipAccountId: OWN, accountId: null });
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: {
          s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
          file_name: 'roster.csv',
          phone_column: 'Mobile',
          dry_run: true,
        },
      });
      expect(res.statusCode).toBe(202);
      expect(mocks.repo.create.mock.calls[0]![0]).toMatchObject({ account_id: OWN });
      await app.close();
    });

    it('an account-scoped caller cancelling its OWN finished job still gets 409', async () => {
      mocks.repo.requestCancel.mockResolvedValue(false);
      mocks.repo.findById.mockResolvedValue(job({ account_id: OWN, status: 'completed' }));
      const app = await buildApp(TENANT, { membershipAccountId: OWN, accountId: OWN });
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001/cancel` });
      expect(res.statusCode).toBe(409);
      expect(mocks.repo.findById).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', TENANT, OWN);
      await app.close();
    });

    it('create stamps the membership account over the header', async () => {
      // `tenantContextMiddleware` refuses a disagreeing header in production; it
      // is mocked here, so a different header is what proves membership wins
      // rather than the two merely being equal.
      mocks.repo.create.mockResolvedValue(job({ dry_run: true, campaign_id: null, status: 'pending' }));
      const app = await buildApp(TENANT, { membershipAccountId: OWN, accountId: 'account-header' });
      await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: {
          s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
          file_name: 'roster.csv',
          phone_column: 'Mobile',
          dry_run: true,
        },
      });
      expect(mocks.repo.create.mock.calls[0]![0]).toMatchObject({ account_id: OWN });
      await app.close();
    });

    it('create records the person, never a platform key\'s creator, as created_by', async () => {
      mocks.repo.create.mockResolvedValue(job({ dry_run: true, campaign_id: null, status: 'pending' }));
      const payload = {
        s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
        file_name: 'roster.csv',
        phone_column: 'Mobile',
        dry_run: true,
      };

      const session = await buildApp();
      await session.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs`, payload });
      expect(mocks.repo.create.mock.calls[0]![0]).toMatchObject({ created_by: ACTING_USER });
      await session.close();
    });

    it('create by a tenant-wide caller still stamps the header account', async () => {
      mocks.repo.create.mockResolvedValue(job({ dry_run: true, campaign_id: null, status: 'pending' }));
      const app = await buildApp(TENANT, { membershipAccountId: null, accountId: 'account-a' });
      await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: {
          s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
          file_name: 'roster.csv',
          phone_column: 'Mobile',
          dry_run: true,
        },
      });
      expect(mocks.repo.create.mock.calls[0]![0]).toMatchObject({ account_id: 'account-a' });
      await app.close();
    });
  });

  /**
   * A second door: a rejected-rows export lives under the
   * same `agency-ingest/{tenant}/` prefix as an upload and is keyed by nothing
   * but the job id, so naming it as an `s3_key` read a sibling account's
   * rejected rows back through the analyzer or a dry-run re-ingest.
   */
  describe('client-supplied s3_key cannot name a rejected-rows export', () => {
    const exportKey = `agency-ingest/${TENANT}/11111111-2222-3333-4444-555555555555/rejected-rows.csv`;

    it('analyze refuses it and never reads S3', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/analyze`,
        payload: { s3_key: exportKey },
      });
      expect(res.statusCode).toBe(403);
      expect(mocks.getFileStream).not.toHaveBeenCalled();
      await app.close();
    });

    it('a dry-run ingest refuses it and creates no job', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: { s3_key: exportKey, file_name: 'x.csv', phone_column: 'Mobile', dry_run: true },
      });
      expect(res.statusCode).toBe(403);
      expect(mocks.repo.create).not.toHaveBeenCalled();
      await app.close();
    });

    // The other half of the refusal: a GENUINE upload literally named
    // `rejected-rows.csv` must be renamed on the way in, or the refusal above
    // would lock the operator out of their own file.
    it('an upload named rejected-rows.csv is stored under a key the analyzer accepts', async () => {
      mocks.getFileStream.mockResolvedValue({ body: Readable.from([Buffer.from('Mobile\n+919812345678\n', 'utf8')]) });
      const app = await buildApp();
      const boundary = '----agencyUploadTest';
      const payload =
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="rejected-rows.csv"\r\n' +
        'Content-Type: text/csv\r\n\r\n' +
        'Mobile\n+919812345678\n\r\n' +
        `--${boundary}--\r\n`;
      const up = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/upload`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(up.statusCode).toBe(201);
      const key = up.json().s3_key as string;
      expect(key).toMatch(new RegExp(`^agency-ingest/${TENANT}/[0-9a-f-]{36}/upload-rejected-rows\\.csv$`));
      expect(mocks.uploadFile).toHaveBeenCalledWith(key, expect.anything(), 'text/csv');

      const analyzed = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/analyze`,
        payload: { s3_key: key },
      });
      expect(analyzed.statusCode).not.toBe(403);
      await app.close();
    });

    it('a key with extra segments under the tenant prefix is refused too', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/analyze`,
        payload: { s3_key: `agency-ingest/${TENANT}/a/b/roster.csv` },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  /**
   * The roster writes reach the internal handler over S2S, past the internal handler's `requireOwned`, and
   * the internal handler's internal contacts handler resolves the campaign by id alone — so
   * the public API layer has to prove ownership of a body-supplied `campaign_id` itself.
   */
  describe('campaign ownership before a roster write', () => {
    const CAMPAIGN = '11111111-2222-3333-4444-555555555555';
    const realImport = {
      s3_key: `agency-ingest/${TENANT}/u/roster.csv`,
      file_name: 'roster.csv',
      phone_column: 'Mobile',
      campaign_id: CAMPAIGN,
    };

    // The probe answers with the campaign's `account_id: 'account-b'`. The internal
    // handler's `requireOwned` only ever answers 200 for a campaign whose account equals
    // the probed one, and the route stamps the job from the PROVEN owner (the row's
    // account), so an `account-1` fixture from the describe's beforeEach would describe an
    // impossible probe.
    it('probes the campaign with the account the job is stamped with', async () => {
      mocks.repo.create.mockResolvedValue(job());
      mocks.proxyToCore.mockResolvedValue({
        status: 200,
        body: { id: CAMPAIGN, account_id: 'account-b' },
        headers: new Headers(),
      });
      const app = await buildApp(TENANT, { membershipAccountId: 'account-b', accountId: null });
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs`, payload: realImport });
      expect(res.statusCode).toBe(202);
      expect(mocks.proxyToCore).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: `/agency-campaigns/${CAMPAIGN}`,
        tenantId: TENANT,
        accountId: 'account-b',
      }));
      expect(mocks.repo.create.mock.calls[0]![0]).toMatchObject({ account_id: 'account-b' });
      await app.close();
    });

    it('a campaign the internal handler does not show this caller is a 404, and nothing is loaded', async () => {
      // A sibling account's campaign, another tenant's and a nonexistent one
      // are all the internal handler's 404 — forwarded unchanged so they stay indistinguishable.
      mocks.proxyToCore.mockResolvedValue({
        status: 404,
        body: { error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found' },
        headers: new Headers(),
      });
      const app = await buildApp();
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs`, payload: realImport });
      expect(res.statusCode).toBe(404);
      expect(mocks.repo.create).not.toHaveBeenCalled();
      expect(mocks.serviceRun).not.toHaveBeenCalled();
      await app.close();
    });

    it('fails CLOSED when the internal handler cannot be reached', async () => {
      mocks.proxyToCore.mockRejectedValue(new Error('ECONNREFUSED'));
      const app = await buildApp();
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs`, payload: realImport });
      expect(res.statusCode).toBe(500);
      expect(mocks.repo.create).not.toHaveBeenCalled();
      await app.close();
    });

    it('refuses a real import with no account to prove ownership against', async () => {
      // Tenant-wide membership, no X-Account-Id: the internal handler's `requireOwned` has
      // nothing to compare the campaign's account to.
      const app = await buildApp(TENANT, { membershipAccountId: null, accountId: null });
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs`, payload: realImport });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'account_scope_required' });
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      expect(mocks.repo.create).not.toHaveBeenCalled();
      await app.close();
    });

    it('a dry run WITHOUT a campaign is not probed — it stays reachable with the internal handler down', async () => {
      mocks.repo.create.mockResolvedValue(job({ dry_run: true, campaign_id: null }));
      const app = await buildApp();
      const { campaign_id: _omit, ...noCampaign } = realImport;
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: { ...noCampaign, dry_run: true },
      });
      expect(res.statusCode).toBe(202);
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      await app.close();
    });

    // A dry run applies the named campaign's campaign-scoped DNC entries, so an
    // unprobed one naming a sibling's campaign was a suppression oracle.
    it('a dry run naming a campaign IS probed, and a refused probe creates no job', async () => {
      mocks.proxyToCore.mockResolvedValue({
        status: 404,
        body: { error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found' },
        headers: new Headers(),
      });
      const app = await buildApp(TENANT, { membershipAccountId: 'account-b', accountId: null });
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs`,
        payload: { ...realImport, dry_run: true },
      });
      expect(res.statusCode).toBe(404);
      expect(mocks.proxyToCore).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: `/agency-campaigns/${CAMPAIGN}`,
        accountId: 'account-b',
      }));
      expect(mocks.repo.create).not.toHaveBeenCalled();
      expect(mocks.serviceRun).not.toHaveBeenCalled();
      await app.close();
    });

    it('roster clear is probed too, and a refused probe clears nothing', async () => {
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.proxyToCore.mockResolvedValue({
        status: 404,
        body: { error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found' },
        headers: new Headers(),
      });
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 10 },
      });
      expect(res.statusCode).toBe(404);
      expect(mocks.supersedeRoster).not.toHaveBeenCalled();
      await app.close();
    });

    // As in "probes the campaign…": the
    // probe answers with the probed account, and the supersede is addressed to the proven owner.
    it('roster clear sends the membership account, not a missing header', async () => {
      mocks.config.agency.rosterReplaceEnabled = true;
      mocks.supersedeRoster.mockResolvedValue({ superseded: 3, contacts_total: 0, already_applied: false });
      mocks.proxyToCore.mockResolvedValue({
        status: 200,
        body: { id: 'c1', account_id: 'account-b' },
        headers: new Headers(),
      });
      const app = await buildApp(TENANT, { membershipAccountId: 'account-b', accountId: null });
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/c1/roster/clear`,
        payload: { expected_contacts_total: 3 },
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.proxyToCore).toHaveBeenCalledWith(expect.objectContaining({
        path: '/agency-campaigns/c1',
        accountId: 'account-b',
      }));
      expect(mocks.supersedeRoster).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-b' }));
      await app.close();
    });

    /*
     * `agency_ingest_jobs.account_id` is set from
     * the PROVEN owner of the campaign — the account on the campaign row the probe returned —
     * because the in-process roster hand-off compares the two and fails a mismatch
     * `core_rejected_chunk`. The internal handler's `requireOwned` makes the row's account equal the probed
     * one, so the two can only differ in a stub; this one makes them differ to pin WHICH
     * value is written. Mutation-checked: stamping `jobAccountId` instead reds it.
     */
    it('stamps the job with the account on the proven campaign row', async () => {
      mocks.repo.create.mockResolvedValue(job());
      mocks.proxyToCore.mockResolvedValue({
        status: 200,
        body: { id: CAMPAIGN, account_id: 'account-owner' },
        headers: new Headers(),
      });
      const app = await buildApp(TENANT, { membershipAccountId: 'account-b', accountId: null });
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs`, payload: realImport });
      expect(res.statusCode).toBe(202);
      expect(mocks.repo.create.mock.calls[0]![0]).toMatchObject({ account_id: 'account-owner' });
      await app.close();
    });

    // A probe that answers 200 without the campaign's account cannot
    // name an owner, so nothing is stamped or loaded (the route refuses rather than guesses).
    it('refuses to stamp a job when the proven campaign carries no account', async () => {
      mocks.proxyToCore.mockResolvedValue({ status: 200, body: { id: CAMPAIGN }, headers: new Headers() });
      const app = await buildApp(TENANT, { membershipAccountId: 'account-b', accountId: null });
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs`, payload: realImport });
      expect(res.statusCode).toBe(500);
      expect(mocks.repo.create).not.toHaveBeenCalled();
      expect(mocks.serviceRun).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('cancel', () => {
    it('accepts a cancel for a live job', async () => {
      mocks.repo.requestCancel.mockResolvedValue(true);
      const app = await buildApp();
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001/cancel` });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ job_id: '00000000-0000-4000-8000-000000000001', cancel_requested: true });
      await app.close();
    });

    it('409s a job that already finished rather than pretending', async () => {
      // Pretending to cancel something already loaded would leave the operator
      // believing a roster was not imported when it was.
      mocks.repo.requestCancel.mockResolvedValue(false);
      mocks.repo.findById.mockResolvedValue(job({ status: 'completed' }));
      const app = await buildApp();
      const res = await app.inject({ method: 'POST', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001/cancel` });
      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it('404s a nonexistent job rather than claiming it already finished', async () => {
      mocks.repo.requestCancel.mockResolvedValue(false);
      mocks.repo.findById.mockResolvedValue(null);
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/ingest/jobs/00000000-0000-0000-0000-000000000000/cancel`,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe('rejected-rows export', () => {
    it('serves the CSV as a download named after the source file', async () => {
      mocks.repo.findById.mockResolvedValue(job({ rejected_s3_key: 'k', rejected_row_count: 2 }));
      mocks.getFileBuffer.mockResolvedValue(Buffer.from('_row,Mobile,_reason\n2,abc,bad\n'));
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001/rejected.csv` });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="roster-rejected-rows.csv"',
      );
      expect(res.body).toContain('_reason');
      await app.close();
    });

    it('sanitises the download filename', async () => {
      mocks.repo.findById.mockResolvedValue(
        job({ rejected_s3_key: 'k', file_name: '../../etc/pa ss"wd.csv' }),
      );
      mocks.getFileBuffer.mockResolvedValue(Buffer.from('x'));
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001/rejected.csv` });
      const disposition = res.headers['content-disposition'] as string;
      expect(disposition).not.toContain('..');
      expect(disposition).not.toContain('"wd');
      await app.close();
    });

    it('404s when the import had no rejected rows', async () => {
      mocks.repo.findById.mockResolvedValue(job({ rejected_s3_key: null }));
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/ingest/jobs/00000000-0000-4000-8000-000000000001/rejected.csv` });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});

describe('campaign config at the proxy boundary', () => {
  beforeEach(() => {
    // This describe has its own beforeEach, so it must clear too — the sibling
    // block's clear does not reach here, and `mock.calls[0]` silently became the
    // FIRST test's call for every later one. Two of these cases passed against the
    // wrong request before this line existed.
    vi.clearAllMocks();
    mocks.proxyToCore.mockResolvedValue({ status: 201, body: { id: 'campaign-1' } });
  });

  it('400s a bad config on CREATE and never reaches the internal handler', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns`,
      payload: {
        name: 'Q3',
        caller_ids: ['+15551230001'],
        calling_days: [0, 1],
        default_timezone: 'EST',
      },
    });

    expect(res.statusCode).toBe(400);
    // Not "the internal handler would have rejected it anyway": the internal handler validates NONE of this, so
    // reaching the internal handler means the value is stored and behaves wrongly later.
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    expect(Object.keys(res.json().details)).toEqual(['calling_days[0]', 'default_timezone']);
    await app.close();
  });

  it('400s a bad config on PATCH too', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/campaigns/campaign-1`,
      payload: { retry_policy: { machine: { max_attempts: 2 } } },
    });

    // Validating only on create would leave every rule reachable one PATCH later —
    // and the builder edits a running campaign's window and catalog here.
    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards a valid body to the internal handler unchanged apart from the catalog default', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns`,
      payload: {
        name: 'Q3',
        caller_ids: ['+15551230001'],
        calling_window_start: '09:00',
        calling_window_end: '20:00',
        calling_days: [1, 2, 3, 4, 5],
        default_timezone: 'America/New_York',
      },
    });

    const sent = mocks.proxyToCore.mock.calls[0]![0].body as Record<string, unknown>;
    expect(sent['name']).toBe('Q3');
    expect(sent['default_timezone']).toBe('America/New_York');
    // The public API layer still keeps no campaign copy — the body goes through, it is not
    // rebuilt from a public-API-layer schema.
    expect(sent['calling_days']).toEqual([1, 2, 3, 4, 5]);
    await app.close();
  });

  it('defaults the disposition catalog on CREATE', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns`,
      payload: { name: 'Q3', caller_ids: ['+15551230001'] },
    });

    const sent = mocks.proxyToCore.mock.calls[0]![0].body as Record<string, unknown>;
    // Without this every campaign the platform makes carries `'[]'` and
    // disposition is inert — no code to submit, `allowed_codes: []` on any attempt.
    expect((sent['disposition_catalog'] as { code: string }[]).map((e) => e.code)).toEqual([
      'voicemail',
      'callback',
      'do_not_call',
    ]);
    await app.close();
  });

  it('does NOT default the catalog on PATCH', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: {} });
    const app = await buildApp();

    await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/campaigns/campaign-1`,
      payload: { name: 'renamed' },
    });

    const sent = mocks.proxyToCore.mock.calls[0]![0].body as Record<string, unknown>;
    // A rename must not silently replace an operator's catalog — including one
    // they deliberately emptied.
    expect('disposition_catalog' in sent).toBe(false);
    await app.close();
  });

  it('preserves an explicitly empty catalog on CREATE', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns`,
      payload: { name: 'Q3', caller_ids: ['+15551230001'], disposition_catalog: [] },
    });

    const sent = mocks.proxyToCore.mock.calls[0]![0].body as Record<string, unknown>;
    // "Outcome-driven retry, no human write-up" is a coherent configuration the internal handler
    // supports and preserves. A default that overrode `[]` would delete it.
    expect(sent['disposition_catalog']).toEqual([]);
    await app.close();
  });
});

describe('editing config on a RUNNING campaign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: {} });
  });

  it('adds no campaign-status gate — one the internal handler call, and it is the PATCH', async () => {
    /**
     * The documented rule is **allowed**, and this is the mechanically-verifiable
     * form of it rather than a comment asserting it.
     *
     * A status gate cannot be added to the public API layer without becoming visible here: the public API layer
     * holds no campaign copy, so any such gate has to GET the campaign first and
     * decide on the status it reads. That makes it a SECOND the internal handler call, before the
     * PATCH — so asserting the call count and the method is what actually observes
     * the rule. (It would also be a gate on a status that can change between the two
     * calls, which is the other reason it belongs in the internal handler and not here.)
     */
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/campaigns/campaign-1`,
      payload: { calling_window_start: '09:00', calling_window_end: '18:00' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    const call = mocks.proxyToCore.mock.calls[0]![0];
    expect(call.method).toBe('PATCH');
    expect(call.path).toBe('/agency-campaigns/campaign-1');
    await app.close();
  });

  it('validates a running campaign\'s edit by the same rules as any other', async () => {
    // The gate that DOES exist is the config validator, and it must not weaken just
    // because the campaign is live — a live campaign is exactly where a window that
    // can never open costs dials.
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/campaigns/campaign-1`,
      payload: { calling_window_start: '09:00', calling_window_end: '09:00:00' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('calling_window_end');
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards `status` rather than ruling on it, because the internal handler owns lifecycle', async () => {
    /**
     * The internal handler answers 400 to a `status` in a PATCH body — lifecycle goes through
     * /start, /pause, /resume, /stop so a config edit can never race the pacing
     * leader's own `running → completed` write. The public API layer must forward it and let the internal handler
     * say so: a public-API-layer rejection would be a second, drifting copy of a rule
     * the internal handler already enforces, and the two would disagree the first time the internal handler's moved.
     */
    const app = await buildApp();

    await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/campaigns/campaign-1`,
      payload: { status: 'paused', calling_days: [1, 2, 3] },
    });

    const sent = mocks.proxyToCore.mock.calls[0]![0].body as Record<string, unknown>;
    expect(sent['status']).toBe('paused');
    await app.close();
  });
});

describe('the campaign row\'s lifecycle provenance reaches the browser', () => {
  /**
   * The internal handler adds three members to the campaign row it serves — `started_at`,
   * `ended_at` and `last_transition_by` — and the public API layer's job is that they arrive.
   *
   * ── Why this needs a test when the code needed no change ──────────────────
   * Because "needed no change" is a property, not an accident, and it is the one
   * a well-meaning refactor deletes. Both campaign reads are
   * `reply.code(result.status).send(result.body)`: no Fastify `response` schema
   * (so no ajv `removeAdditional`), no Zod response parse, no field whitelist.
   * The moment somebody adds one "to document the shape", every field the internal handler ships
   * next is dropped on the floor with a green suite — which is exactly how this
   * feature half-ships. So the assertion is `JSON.stringify` on the whole body
   * rather than a field-by-field walk: a walk cannot see a field it does not
   * name, and the fields it does not name are the ones at risk.
   *
   * ── Three rules, all pinned below ─────────────────────────────────────────
   *  1. present → forwarded, byte-identically, key order included;
   *  2. `null` stays `null` — never `0`, never `''`, never `{}`. `null` is an
   *     ANSWER on all three ("never started", "still live", "the platform did
   *     it"), and coercing it states something the data does not;
   *  3. ABSENT is tolerated. An older internal handler does not serve them, and neither a
   *     rollback of the internal handler nor the deploy order may 500 this read.
   */
  const CAMPAIGN_ID = 'campaign-1';

  /** The internal handler's row with the three new members populated. */
  const RUNNING_CAMPAIGN: AgencyCampaignWire & Record<string, unknown> = {
    id: CAMPAIGN_ID,
    account_id: 'account-1',
    name: 'Q3 outbound',
    status: 'running',
    started_at: '2026-08-11T04:30:00.000Z',
    ended_at: null,
    last_transition_by: { user_id: ACTING_USER, name: 'Asha Menon' },
    // A field this repo has never heard of, standing in for whatever the internal handler adds
    // next. It must survive on the same mechanism the three above do.
    some_field_added_next_quarter: { nested: [1, 2, 3] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards started_at, ended_at and last_transition_by byte-identically on the detail read', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: RUNNING_CAMPAIGN, headers: new Headers() });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN_ID}` });

    expect(res.statusCode).toBe(200);
    // Serialised, not deep-equal: key order and unknown fields both matter here.
    expect(JSON.stringify(res.json())).toBe(JSON.stringify(RUNNING_CAMPAIGN));
    await app.close();
  });

  it('forwards them on the LIST read too, which is a different handler', async () => {
    // The list and the detail are separate registrations, and a response schema
    // would be added to one of them first.
    const page = { campaigns: [RUNNING_CAMPAIGN], total: 1 };
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: page, headers: new Headers() });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns` });

    expect(JSON.stringify(res.json())).toBe(JSON.stringify(page));
    await app.close();
  });

  it('keeps a null last_transition_by NULL — an auto-pause was nobody\'s doing', async () => {
    const autoPaused: AgencyCampaignWire = {
      id: CAMPAIGN_ID,
      account_id: 'account-1',
      name: 'Q3 outbound',
      status: 'paused',
      started_at: '2026-08-11T04:30:00.000Z',
      ended_at: null,
      // The abandonment ceiling paused this campaign. There is no actor.
      last_transition_by: null,
    };
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: autoPaused, headers: new Headers() });
    const app = await buildApp();

    const body = (await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN_ID}`,
    })).json() as Record<string, unknown>;

    // `toBeNull`, not a falsy check: `{}`, `''` and `0` are all falsy and all wrong.
    expect(body['last_transition_by']).toBeNull();
    expect(body['ended_at']).toBeNull();
    expect(body['last_transition_by']).not.toEqual({});
    await app.close();
  });

  it('keeps a null started_at NULL rather than dating a campaign that never ran', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { ...RUNNING_CAMPAIGN, status: 'draft', started_at: null, last_transition_by: null },
    });
    const app = await buildApp();

    const body = (await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN_ID}`,
    })).json() as Record<string, unknown>;

    expect(body['started_at']).toBeNull();
    expect(body['started_at']).not.toBe(0);
    expect(body['started_at']).not.toBe('');
    await app.close();
  });

  it('carries an ended_at through on a terminal campaign', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { ...RUNNING_CAMPAIGN, status: 'stopped', ended_at: '2026-08-19T11:02:03.000Z' },
    });
    const app = await buildApp();

    const body = (await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN_ID}`,
    })).json() as Record<string, unknown>;

    // The exact string the internal handler sent — not re-serialised through a `Date`, which
    // would be lossless here and is not the habit to establish.
    expect(body['ended_at']).toBe('2026-08-19T11:02:03.000Z');
    await app.close();
  });

  it('tolerates all three being ABSENT — an older internal handler, or a rollback of the internal handler', async () => {
    const oldCore = { id: CAMPAIGN_ID, account_id: 'account-1', name: 'Q3 outbound', status: 'running' };
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: oldCore, headers: new Headers() });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN_ID}` });

    expect(res.statusCode).toBe(200);
    // Absent, not invented: the public API layer must not manufacture `started_at: null` for a
    // the internal handler that has no opinion, because "never started" is a claim.
    expect(Object.keys(res.json())).not.toContain('started_at');
    expect(JSON.stringify(res.json())).toBe(JSON.stringify(oldCore));
    await app.close();
  });
});

describe('every campaign route carries its RBAC permission', () => {
  /**
   * ── Why this is asserted against the SOURCE TEXT ───────────────────────────
   * `requirePermission` is mocked to a no-op at the top of this file — it has to
   * be, or every case here would be re-testing the RBAC middleware. The cost is
   * that **no behavioural test in this file can observe a missing guard**:
   * deleting `preHandler: requirePermission('agency.campaigns.write')`
   * from `POST /campaigns` — the route that creates a campaign — would leave every
   * other test green. A claim in a header comment that the permission is "asserted
   * separately" is convincing enough that a reviewer stops looking, which is how a
   * route can ship unauthenticated.
   *
   * Reading the source is the only mechanism available once the middleware is
   * stubbed, and it is a real one: it fails loudly the moment a guard is dropped or
   * a new campaign route is added without one.
   */
  const source = readFileSync(
    new URL('../../../src/api/routes/proxy-agency-campaigns.routes.ts', import.meta.url),
    'utf8',
  );

  // Route → the permission it must carry. Reads are `.read`; writes are `.write`;
  // the four lifecycle transitions are `agency.supervise` (floor `account_admin`)
  // because starting/pausing/resuming/stopping a campaign is a
  // supervisory control action, not a `.schedules.write`-floored (`operator`)
  // dispatch operation — an `operator` stopping a live campaign is exactly what
  // `agency.supervise` was created to prevent. `stats` deliberately stays on
  // `proxy.contact_lists.read` (floor `viewer`): a supervisor dashboard a viewer
  // can read is the intent, only the controls rise.
  const EXPECTED: ReadonlyArray<readonly [string, string, string | readonly string[]]> = [
    ['post', '/campaigns', 'agency.campaigns.write'],
    ['get', '/campaigns', 'agency.campaigns.read'],
    ['get', '/campaigns/:id', 'agency.campaigns.read'],
    ['patch', '/campaigns/:id', 'agency.campaigns.write'],
    ['get', '/campaigns/:id/stats', 'agency.campaigns.read'],
    // The campaign's bucketed series. `agency.supervise`, NOT the
    // `proxy.contact_lists.read` its `/stats` neighbour one line up carries — the
    // live strip is a dashboard an `operator` running the floor must be able to
    // read, while the series is a per-day record of throughput over up to a
    // quarter, on the same tab as the roster and the attempt spine, every one of
    // which floors at `account_admin`. The two lines disagreeing is deliberate;
    // the route's docstring is the argument. Asserted BY EXECUTION as well, in
    // `proxy-agency-campaign-series.routes.test.ts`, because this table cannot see
    // a guard deleted together with its own row here.
    ['get', '/campaigns/:id/stats/series', 'agency.supervise'],
    // The merged audit trail. `audit.read`, not a campaign-read
    // permission: `audit.read` floors at
    // `account_admin` — the same floor as `agency.supervise`, so the supervisor
    // who controls a campaign can read its trail — rather than minting a second
    // permission that would have to be kept aligned with the first.
    ['get', '/campaigns/:id/activity', 'audit.read'],
    ['get', '/campaigns/:id/activity.csv', 'audit.read'],
    // The attempt spine's read surface. `agency.supervise`, NOT
    // `audit.read`: the two share a role floor (`account_admin`), so this is not
    // about who gets in — it is about which question the permission names.
    // `audit.read` covers the control plane (who pressed what); these are the
    // operational record (what was dialled, to whom, with what result), and a
    // tenant narrowing one must be able to narrow it without silently taking
    // the other away.
    ['get', '/campaigns/:id/attempts', 'agency.supervise'],
    ['get', '/campaigns/:id/contacts', 'agency.supervise'],
    ['get', '/campaigns/:id/contacts/:contactId', 'agency.supervise'],
    // The exports carry every phone number on the campaign in one file. They
    // are deliberately on the SAME permission as the list rather than a gate of
    // their own — a second gate to keep aligned is a second gate to drift — and
    // the exposure is answered by the audit row each one writes instead. If
    // that reasoning is ever revisited, it is these two lines that change.
    ['get', '/campaigns/:id/attempts.csv', 'agency.supervise'],
    ['get', '/campaigns/:id/contacts.csv', 'agency.supervise'],
    ['post', '/campaigns/:id/start', 'agency.supervise'],
    ['post', '/campaigns/:id/pause', 'agency.supervise'],
    ['post', '/campaigns/:id/resume', 'agency.supervise'],
    ['post', '/campaigns/:id/stop', 'agency.supervise'],
    // Retry campaigns. Three
    // routes on three different floors, which is the whole reason they are worth
    // a comment here rather than three quiet rows:
    //
    //  - the PREVIEW is `agency.supervise`, not the `proxy.contact_lists.read`
    //    its `GET /campaigns/:id` neighbour carries: it breaks a campaign's
    //    contacts down by how their calls WENT, which is the supervisory record,
    //    and it is the first half of an action whose second half is floored
    //    there too. Splitting them would let someone size a cohort they cannot
    //    author.
    //  - the CREATE is the only route on this plugin carrying TWO permissions,
    //    and they share a floor today: `proxy.contact_lists.write` because it
    //    creates a campaign, `agency.supervise` because it acts on another
    //    campaign's call results (different in kind, not just
    //    in floor). Naming both is what keeps the route correct if either moves.
    //  - LINEAGE is `proxy.contact_lists.read`, back at `viewer`, because it is
    //    navigation — names, statuses, generations — every field of which a
    //    viewer can already read one campaign at a time.
    ['get', '/campaigns/:id/retry/preview', 'agency.supervise'],
    ['post', '/campaigns/:id/retry', ['agency.supervise', 'agency.campaigns.write']],
    ['get', '/campaigns/:id/lineage', 'agency.campaigns.read'],
    ['get', '/ingest/limits', 'agency.campaigns.read'],
    ['post', '/ingest/analyze', 'agency.campaigns.write'],
    ['post', '/ingest/jobs', 'agency.campaigns.write'],
    ['get', '/ingest/jobs/:id', 'agency.campaigns.read'],
    ['post', '/ingest/jobs/:id/cancel', 'agency.campaigns.write'],
    ['get', '/ingest/jobs/:id/rejected.csv', 'agency.campaigns.read'],
    ['post', '/ingest/upload', 'agency.campaigns.write'],
    // Destructive, and registered only when `AGENCY_ROSTER_REPLACE_ENABLED` is
    // set — but the guard is asserted from the SOURCE, so the flag does not
    // exempt it. That is the right way round: a route that is invisible in most
    // deployments is exactly the one whose permission nobody re-checks.
    ['post', '/campaigns/:id/roster/clear', 'agency.campaigns.write'],
  ];

  it.each(EXPECTED)('%s %s requires %s', (verb, path, permission) => {
    // Matches the registration through to its `requirePermission(...)`, allowing
    // only whitespace and the generic between — so a guard moved out of the route's
    // own options, or replaced with a different permission, does not match.
    //
    // A route needing MORE than one permission is spelled as a preHandler array,
    // and the array form is matched WHOLE — opening bracket, both calls, closing
    // bracket, in order. Matching each permission independently would go green on
    // a route that had lost one of them, which on the retry create is the
    // difference between "a supervisor authored this" and "anyone who can upload
    // a contact list authored this from someone else's call results". The order
    // is pinned too, because it decides which permission the 403 names.
    const call = (p: string): string => `requirePermission\\('${p.replace(/\./g, '\\.')}'\\)`;
    const guard = Array.isArray(permission)
      ? `\\[\\s*${permission.map(call).join(',\\s*')},?\\s*\\]`
      : call(permission as string);
    const pattern = new RegExp(
      `\\.${verb}(?:<[^>]*>)?\\(\\s*'${path.replace(/[/:.]/g, '\\$&')}'\\s*,\\s*\\{\\s*` +
        `preHandler: ${guard}`,
    );

    expect(pattern.test(source), `${verb.toUpperCase()} ${path} must be guarded by ${permission}`)
      .toBe(true);
  });

  it('knows about every route in the file, so a NEW unguarded one reds', () => {
    /**
     * The list above can only catch a guard removed from a route it names. A route
     * ADDED without a guard would pass every case and be invisible — which is a real
     * failure mode, not a hypothetical one. So count the registrations
     * and require the table to cover them all.
     */
    const registrations = source.match(/\b(?:app|sub)\.(?:get|post|patch|put|delete)(?:<[^>]*>)?\(/g) ?? [];

    expect(registrations).toHaveLength(EXPECTED.length);
  });
});
