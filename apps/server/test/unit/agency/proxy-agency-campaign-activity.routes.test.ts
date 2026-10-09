import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ACTIVITY_EXPORT_PAGE_SIZE,
  ACTIVITY_EXPORT_TIME_BUDGET_MS,
  ACTIVITY_MAX_LIMIT,
} from '../../../src/agency/agency-activity.js';

/*
 * The route reads two stores in-process (decision B16):
 *  - the ownership probe is `callCore` (`../../../src/api/core-dispatch.js`), mocked as
 *    `mocks.proxyToCore`;
 *  - the dialer's half of the trail is `auditRepository.findFiltered` on `audit_logs`
 *    (`@magick-agency/db/repositories/audit.repository`) plus `getAuditRetentionHorizon`
 *    (`src/audit/audit-retention.ts`). Both are mocked here (`coreFindFiltered`,
 *    `retentionHorizon`) and `coreRead(...)` stubs them together.
 *    The platform half is `platform_audit_log`, via `@magick-agency/db/repositories/platform/audit.repository`.
 *
 * Filters are asserted on `findFiltered`'s options (`tenantId`, `accountId`, `campaignId`,
 * `eventTypes`, `from`, `to`, `limit`, `withTotal`, `before`). The real-Postgres twin of
 * the service is `test/integration/agency/agency-activity-service.test.ts`.
 */

const TENANT = 'tenant-1';
const CAMPAIGN = 'camp-1';

// Real uuids: both audit tables key on `UUID`, and the cursor codec now refuses
// anything else rather than letting Postgres raise `22P02` from a keyset.
const MASTER_DISPOSITION_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const MASTER_DNC_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CORE_AUTO_PAUSE_ID = 'cccccccc-3333-4333-8333-cccccccccccc';

/** Distinct, well-formed uuids for the multi-page export cases. */
function uuidFor(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `eeeeeeee-5555-4555-8555-${hex}`;
}

/**
 * One FULL export page — `limit + 1` the public API layer rows, which is what keeps the
 * merge's `hasMore` true. A loop fed only these can be ended by the row ceiling
 * or the wall-clock budget and by nothing else, which is the point: it isolates
 * the guard under test from the stream simply running out.
 */
function fullPage(base: number) {
  return Array.from({ length: ACTIVITY_EXPORT_PAGE_SIZE + 1 }, (_, i) => ({
    ...dispositionRow(),
    id: uuidFor(base + i),
    created_at: new Date(Date.UTC(2026, 7, 1) - (base + i) * 60_000),
  }));
}

/** Feeds `fullPage` a fresh, non-overlapping id/timestamp block per call. */
function pagesOfFullRows() {
  let call = 0;
  return () => fullPage((call += 1) * 10_000);
}

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  coreFindFiltered: vi.fn(),
  retentionHorizon: vi.fn(),
  auditFind: vi.fn(),
  findIdentitiesInTenant: vi.fn(),
  config: { agency: { rosterReplaceEnabled: false } },
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({
  callCore: mocks.proxyToCore,
}));
vi.mock('@magick-agency/db/repositories/platform/audit.repository', () => ({
  auditRepository: { find: mocks.auditFind },
}));
vi.mock('@magick-agency/db/repositories/audit.repository', () => ({
  auditRepository: { findFiltered: mocks.coreFindFiltered },
}));
vi.mock('../../../src/audit/audit-retention.js', () => ({
  getAuditRetentionHorizon: mocks.retentionHorizon,
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findIdentitiesInTenant: mocks.findIdentitiesInTenant },
}));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: vi.fn() } }));
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(), getFile: vi.fn(), uploadFile: vi.fn(),
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn() },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// Auth/tenant/capability/RBAC each have their own suites; the permission this
// route carries is asserted from the source in the sibling campaigns suite.
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({ requirePermission: () => async () => {} }));
vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));

const { proxyAgencyCampaignsRoutes } = await import(
  '../../../src/api/routes/proxy-agency-campaigns.routes.js'
);

const PREFIX = '/proxy/agency';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    (request as { tenantId?: string }).tenantId = TENANT;
    (request as { accountId?: string }).accountId = 'account-1';
    (request as { user?: { id: string } }).user = { id: 'user-1' };
    // Deliberately different from `accountId`. (the public API layer's degraded path scoped by this
    // MEMBERSHIP account; that path is gone, and nothing on this route may read it now —
    // the Dialer half is scoped by the campaign row's own account.)
    (request as { membership?: { account_id: string | null } }).membership = { account_id: 'account-9' };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

function campaignOk() {
  return {
    status: 200,
    body: { id: CAMPAIGN, name: 'Q3 collections', account_id: 'account-1', status: 'stopped' },
    headers: new Headers(),
  };
}

/**
 * A disposition row. `resource_id` is the ATTEMPT id, not the campaign — the
 * trap, and the reason the filter is `campaign_id`.
 */
function dispositionRow() {
  return {
    id: MASTER_DISPOSITION_ID,
    tenant_id: TENANT,
    account_id: 'account-1',
    user_id: 'user-1',
    action: 'agency_disposition.created',
    resource_type: 'agency_disposition',
    resource_id: 'attempt-9',
    campaign_id: CAMPAIGN,
    details: { disposition_code: 'promise_to_pay', on_behalf: true },
    ip_address: null,
    created_at: new Date('2026-08-01T12:00:00.000Z'),
  };
}

/** A DNC mark. `resource_id` is the DNC entry id — likewise not the campaign. */
function dncRow() {
  return {
    ...dispositionRow(),
    id: MASTER_DNC_ID,
    action: 'dnc_entry.created',
    resource_type: 'dnc_entry',
    resource_id: 'dnc-4',
    details: { attempt_id: 'attempt-9', scope: 'campaign' },
    created_at: new Date('2026-08-01T11:30:00.000Z'),
  };
}

function coreAutoPause() {
  return {
    id: CORE_AUTO_PAUSE_ID,
    timestamp: '2026-08-01T11:00:00.000Z',
    event_type: 'agency_campaign.auto_paused',
    severity: 'error',
    actor: 'system:abandonment-guardrail',
    call_id: null,
    event_data: { campaign_id: CAMPAIGN, reason: 'abandonment_ceiling', measured_pct: 4.2, ceiling_pct: 3 },
  };
}

/**
 * The trail's two halves come from two in-process reads, so this stubs both:
 * `findFiltered`'s `{ rows, total }` and the retention horizon.
 */
function coreRead(
  logs: unknown[],
  overrides: { total?: number | null; retention?: { earliest_retained_at: string | null; source: string } } = {},
) {
  mocks.coreFindFiltered.mockResolvedValue({
    rows: logs,
    total: 'total' in overrides ? overrides.total : logs.length,
  });
  mocks.retentionHorizon.mockResolvedValue(
    overrides.retention ?? { earliest_retained_at: '2026-05-01T00:00:00.000Z', source: 'partition_bound' },
  );
}

describe('GET /proxy/agency/campaigns/:id/activity', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.proxyToCore.mockResolvedValue(campaignOk());
    coreRead([]);
    mocks.auditFind.mockResolvedValue({ logs: [], total: 0 });
    mocks.findIdentitiesInTenant.mockResolvedValue([
      { id: 'user-1', display_name: 'Sam Patel', email: 'sam@example.com', role: 'account_admin' },
    ]);
    app = await buildApp();
  });

  const get = (query = '') =>
    app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/activity${query}` });

  /**
   * The merged trail carries rows from both stores.
   *
   * A test that only checked "200 with rows" would pass against a route that
   * returns the public API layer's half. So this pins ONE ROW FROM EACH STORE, and the two
   * chosen are the ones neither store can produce alone: `auto_paused` with its
   * measured rate exists only in the internal handler, `agency_disposition.created` only in
   * the public API layer. It also pins a naive `resource_id = campaignId` filter as broken —
   * the disposition's `resource_id` is an attempt id.
   */
  it('returns dialer-only and platform-only rows in one merged, time-ordered payload', async () => {
    mocks.auditFind.mockResolvedValue({ logs: [dispositionRow(), dncRow()], total: 2 });
    coreRead([coreAutoPause()]);

    const res = await get();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const actions = body.rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual([
      'agency_disposition.created',
      'dnc_entry.created',
      'agency_campaign.auto_paused',
    ]);

    const autoPause = body.rows.find((r: { action: string }) => r.action === 'agency_campaign.auto_paused');
    expect(autoPause).toMatchObject({
      source: 'core',
      actor: { system: true, display: 'system:abandonment-guardrail' },
      detail: { measured_pct: 4.2, ceiling_pct: 3 },
    });

    const disposition = body.rows[0];
    expect(disposition).toMatchObject({
      source: 'master',
      actor: { system: false, user_id: 'user-1', display: 'Sam Patel' },
      target: { type: 'agency_disposition', id: 'attempt-9' },
      detail: { disposition_code: 'promise_to_pay', on_behalf: true },
    });

    expect(body.total).toBe(3);
    expect(body.partial).toBe(false);
    expect(body.retention).toEqual({
      earliest_retained_at: '2026-05-01T00:00:00.000Z',
      source: 'partition_bound',
    });
  });

  /**
   * The filter is `campaign_id` on BOTH sides. `resource_id` on a disposition
   * row is the attempt id and on a DNC row the entry id, so a `resource_id`
   * filter would silently drop most of what a compliance reviewer came for —
   * and would look like a working feature.
   */
  it('scopes both stores by campaign, never by resource id', async () => {
    await get();

    expect(mocks.auditFind).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, campaignId: CAMPAIGN }),
    );
    expect(mocks.auditFind.mock.calls[0]![0]).not.toHaveProperty('resourceId');
    expect(mocks.coreFindFiltered).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, campaignId: CAMPAIGN }),
    );
    expect(mocks.coreFindFiltered.mock.calls[0]![0]).not.toHaveProperty('resourceId');
  });

  /**
   * `requirePermission` proves the caller's ROLE and never looks at the target
   * row, so without this a supervisor could name another tenant's campaign and
   * enumerate its audit rows.
   */
  it('verifies the campaign before either read, and forwards the internal handler\'s refusal unchanged', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 404,
      body: { error: 'Not Found', message: 'Campaign not found' },
      headers: new Headers(),
    });

    const res = await get();

    expect(res.statusCode).toBe(404);
    expect(mocks.auditFind).not.toHaveBeenCalled();
    expect(mocks.coreFindFiltered).not.toHaveBeenCalled();
  });

  /**
   * The internal handler stamps its rows with the campaign's OWN account, and the internal handler types that
   * column `VARCHAR(100)` with a literal `'default'` fallback — so it can differ
   * from the request header. Querying with the header would return nothing and
   * read as "the dialer recorded nothing about this campaign".
   *
   * The column is a `uuid` (no `'default'`), but the rule stands: `ActivityQuery.accountId` is the campaign ROW's account,
   * read after the ownership proof, never the header (`account-1`) or the membership
   * (`account-9`). The value is distinct from both so neither can pass by coincidence.
   */
  it('queries the internal handler with the account from the campaign, not from the request header', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { id: CAMPAIGN, name: 'Q3', account_id: 'account-7' },
      headers: new Headers(),
    });

    await get();

    expect(mocks.coreFindFiltered).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-7' }),
    );
  });

  /**
   * Absent means "the client forgot to read it"; false means "we checked". On a
   * surface whose failure mode is looking complete while being short, the
   * difference is the feature.
   */
  it('always carries partial and partial_reason, even on the happy path', async () => {
    const body = (await get()).json();

    expect(body).toHaveProperty('partial', false);
    expect(body).toHaveProperty('partial_reason', null);
  });

  it('passes the action and period filters to both stores', async () => {
    await get(
      '?action=agency_campaign.paused,dnc_entry.created'
      + '&from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z',
    );

    expect(mocks.auditFind).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: ['agency_campaign.paused', 'dnc_entry.created'],
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-08-31T00:00:00.000Z'),
      }),
    );
    expect(mocks.coreFindFiltered).toHaveBeenCalledWith(
      expect.objectContaining({
        eventTypes: ['agency_campaign.paused', 'dnc_entry.created'],
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-08-31T00:00:00.000Z'),
      }),
    );
  });

  /**
   * The screen renders the total, so this route must keep paying for it. The
   * export's opt-out is an option on the read, not a change to it — a default
   * that flipped would blank the count on every supervisor's screen.
   */
  it('still counts both stores, because the screen shows the number', async () => {
    mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 12 });
    coreRead([coreAutoPause()], { total: 30 });

    const body = (await get()).json();

    expect(body.total).toBe(42);
    expect(mocks.auditFind.mock.calls[0]![0]).not.toHaveProperty('withTotal');
    // The in-process read states the default explicitly (`withTotal: !query.skipTotal`).
    expect(mocks.coreFindFiltered.mock.calls[0]![0]).toMatchObject({ withTotal: true });
  });

  /**
   * `total: null` from the internal handler is "not counted" — what it answers to
   * `with_total=false` — and it is a different fact from a body that carried no
   * total at all. Folded together, the skipped count would be read as the internal handler's
   * page length and ADDED to the public API layer's, producing a confident figure that is
   * simply wrong. The rows are untouched either way, which is what makes the
   * wrong number hard to notice.
   */
  it('reads the internal handler\'s explicit null total as uncounted, not as a count of its rows', async () => {
    mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 5 });
    coreRead([coreAutoPause()], { total: null });

    const body = (await get()).json();

    expect(body.total).toBeNull();
    // Not a degraded read — the internal handler answered, and every row it sent is here.
    expect(body.partial).toBe(false);
    expect(body.rows).toHaveLength(2);
  });

  it('asks each store for one row more than the page, so it can tell exhausted from truncated', async () => {
    await get('?limit=10');

    expect(mocks.auditFind).toHaveBeenCalledWith(expect.objectContaining({ limit: 11 }));
    expect(mocks.coreFindFiltered).toHaveBeenCalledWith(expect.objectContaining({ limit: 11 }));
  });

  /**
   * Refused, not reset. A cursor that quietly restarts the trail from the top
   * reads as duplicate rows to a reviewer scrolling through it, and nothing
   * distinguishes that from real duplicates.
   */
  it('refuses a malformed cursor rather than silently paging from the top', async () => {
    const res = await get('?cursor=not-a-cursor');

    expect(res.statusCode).toBe(400);
    expect(mocks.auditFind).not.toHaveBeenCalled();
  });

  it('round-trips its own cursor into a keyset on both stores', async () => {
    mocks.auditFind.mockResolvedValue({ logs: [dispositionRow(), dncRow()], total: 2 });
    coreRead([coreAutoPause()]);

    const first = (await get('?limit=1')).json();
    expect(first.next_cursor).toBeTruthy();

    vi.clearAllMocks();
    mocks.proxyToCore.mockResolvedValue(campaignOk());
    mocks.auditFind.mockResolvedValue({ logs: [], total: 0 });
    coreRead([]);

    await get(`?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`);

    expect(mocks.auditFind).toHaveBeenCalledWith(
      expect.objectContaining({
        before: { createdAt: new Date('2026-08-01T12:00:00.000Z'), id: MASTER_DISPOSITION_ID },
      }),
    );
    // The internal handler contributed nothing to page one, so it has no position yet and must
    // not be sent a keyset it never earned.
    expect(mocks.coreFindFiltered.mock.calls[0]![0]).not.toHaveProperty('before');
  });

  it('rejects a page size that would overrun the internal handler\'s own request cap', async () => {
    const res = await get('?limit=100');

    expect(res.statusCode).toBe(400);
  });

  // The ownership probe answers or throws (a wiring defect) — there is no unverified
  // scoping to fall back to, and an unproven campaign must reach NEITHER store (prove
  // ownership BEFORE the activity read), as in the route's `requireOwnedCampaign`.
  it('serves the public API layer\'s rows when the internal handler is unreachable for the ownership probe too', async () => {
    mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 1 });
    mocks.proxyToCore.mockRejectedValue(new Error('internal handlers are not registered'));

    const res = await get();

    expect(res.statusCode).toBe(500);
    expect(mocks.auditFind).not.toHaveBeenCalled();
    expect(mocks.coreFindFiltered).not.toHaveBeenCalled();
  });

  /**
   * The internal handler validates the period too, but the public API layer maps any internal handler `>= 400` to
   * `partial: core_error` — so without the public API layer's own check the supervisor is told
   * the voice service is broken when they simply picked the dates backwards,
   * and is sent to the wrong remedy.
   */
  it('refuses an inverted date range as the caller\'s error, not an internal handler outage', async () => {
    const res = await get('?from=2026-08-31T00:00:00.000Z&to=2026-08-01T00:00:00.000Z');

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation Error');
    expect(mocks.auditFind).not.toHaveBeenCalled();
    expect(mocks.coreFindFiltered).not.toHaveBeenCalled();
  });

  /**
   * The filter's vocabulary travels with the data it filters.
   *
   * The console would otherwise hold its own copy of these names, which nothing could check. The two pinned below are the
   * pair that proves the served list spans BOTH stores: `auto_paused` is the internal handler's
   * alone (and is the row a compliance reviewer came for), `agency_disposition
   * .created` is the public API layer's alone. A list drawn from one catalog would drop one of
   * them and still look like a working feature.
   */
  it('serves the action vocabulary, spanning both stores', async () => {
    const res = await get();

    const values = res.json().available_actions.map((a: { value: string }) => a.value);
    expect(values).toContain('agency_campaign.auto_paused');
    expect(values).toContain('agency_disposition.created');
    // Scheduler actions are in the public API layer's catalog and carry no campaign — offering
    // them would be a control that always returns nothing on this screen.
    expect(values).not.toContain('schedule.created');
    expect(res.json().available_actions[0]).toMatchObject({
      value: expect.any(String), label: expect.any(String), group: expect.any(String),
    });
  });

  /**
   * The ordering a keyset walk needs is an opt-in, and the activity path takes
   * it on EVERY page — including this one, which has no cursor yet.
   *
   * Deriving it from `before` instead would order page one by the raw column and
   * page two by the millisecond-truncated one; the two disagree within a
   * millisecond, and a row straddling that boundary appears on neither page.
   * That is the silent row loss the truncation was added to fix, and it would
   * only ever show up on rows sharing a millisecond across a page break.
   */
  it('opts into the keyset ordering on the first page, before any cursor exists', async () => {
    await get();

    const options = mocks.auditFind.mock.calls[0]![0];
    expect(options).toMatchObject({ keysetOrder: true });
    expect(options).not.toHaveProperty('before');
  });

  it('refuses a cursor whose id is not a uuid, rather than letting Postgres 22P02', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, master: { at: '2026-08-01T12:00:00.000Z', id: 'nope' }, core: null }),
      'utf8',
    ).toString('base64url');

    const res = await get(`?cursor=${encodeURIComponent(cursor)}`);

    expect(res.statusCode).toBe(400);
    expect(mocks.auditFind).not.toHaveBeenCalled();
  });
});

describe('GET /proxy/agency/campaigns/:id/activity.csv', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.proxyToCore.mockResolvedValue(campaignOk());
    coreRead([]);
    mocks.auditFind.mockResolvedValue({ logs: [], total: 0 });
    mocks.findIdentitiesInTenant.mockResolvedValue([]);
    app = await buildApp();
  });

  // The deadline cases stub `Date.now`; left installed it would follow the suite
  // into every later test as a mock with no implementation.
  afterEach(() => vi.restoreAllMocks());

  const get = (query = '') =>
    app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/activity.csv${query}` });

  it('exports the merged trail with a stable header', async () => {
    mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 1 });
    coreRead([coreAutoPause()]);

    const res = await get('?preamble=false');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('activity-Q3-collections.csv');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('at,source,action,actor,actor_user_id,target_type,target_id,detail,actor_type,actor_api_key_id');
    expect(lines[1]).toContain('agency_disposition.created');
    expect(lines[2]).toContain('agency_campaign.auto_paused');
  });

  it('applies the same filters as the screen', async () => {
    await get('?action=dnc_entry.created&from=2026-08-01T00:00:00.000Z');

    expect(mocks.auditFind).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: ['dnc_entry.created'],
        from: new Date('2026-08-01T00:00:00.000Z'),
      }),
    );
  });

  /**
   * The export is draining a trail, not rendering one, and each page costs a
   * the public API layer SELECT plus an ownership probe plus an identity lookup — in series. At
   * the screen's page size a full 5000-row export was ~51 of those trips; at 500
   * it is ~10. The `+ 1` is the merge's extra row, and it is what has to stay
   * inside the internal handler's request cap.
   */
  it('pages the export coarsely rather than at the screen page size', async () => {
    await get();

    expect(mocks.auditFind).toHaveBeenCalledWith(
      expect.objectContaining({ limit: ACTIVITY_EXPORT_PAGE_SIZE + 1 }),
    );
    expect(mocks.coreFindFiltered).toHaveBeenCalledWith(
      expect.objectContaining({ limit: ACTIVITY_EXPORT_PAGE_SIZE + 1 }),
    );
    expect(ACTIVITY_EXPORT_PAGE_SIZE).toBeGreaterThan(ACTIVITY_MAX_LIMIT);
  });

  /**
   * Nothing in a CSV reads `total`, and asking for it costs a `COUNT(*)` over a
   * partitioned table on BOTH sides of the merge, once per page — ~102 of them
   * at the row ceiling. Asserted at the seam each read crosses, because a count
   * that is issued and then discarded costs exactly as much as one that is read.
   */
  it('asks neither store to count, since the file never carries a total', async () => {
    await get();

    expect(mocks.auditFind).toHaveBeenCalledWith(
      expect.objectContaining({ withTotal: false }),
    );
    expect(mocks.coreFindFiltered).toHaveBeenCalledWith(
      expect.objectContaining({ withTotal: false }),
    );
  });

  /**
   * A skipped count must not read as a degraded one. `total: null` is what both
   * situations report, so `partial` is the only key that separates them — and an
   * export that mistook "not counted" for "the dialer half is missing" would 424 every
   * time, i.e. the feature would never produce a file at all.
   */
  it('does not mistake an uncounted page for a partial one', async () => {
    mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: null });
    coreRead([coreAutoPause()], { total: null });

    const res = await get('?preamble=false');

    expect(res.statusCode).toBe(200);
    expect(res.body.trim().split('\n').slice(1)).toHaveLength(2);
  });

  /**
   * Every other CSV case is one page of two rows, so the pagination loop — the
   * part that can spin, stall, or stop early — was entirely undefended. This
   * drives it across several pages and pins that the cursor actually advances.
   */
  it('walks every page, not just the first', async () => {
    const PAGES = 4;
    let call = 0;
    mocks.auditFind.mockImplementation(async () => {
      // `limit + 1` rows keeps `hasMore` true; a short final page ends the loop.
      const rows = call < PAGES - 1 ? ACTIVITY_EXPORT_PAGE_SIZE + 1 : 5;
      const base = call * 10_000;
      call += 1;
      return {
        logs: Array.from({ length: rows }, (_, i) => ({
          ...dispositionRow(),
          id: uuidFor(base + i),
          created_at: new Date(Date.UTC(2026, 7, 1) - (base + i) * 60_000),
        })),
        total: null,
      };
    });

    const res = await get('?preamble=false');

    expect(res.statusCode).toBe(200);
    const dataLines = res.body.trim().split('\n').slice(1);
    expect(dataLines).toHaveLength(ACTIVITY_EXPORT_PAGE_SIZE * (PAGES - 1) + 5);
    expect(res.headers['x-activity-rows']).toBe(String(dataLines.length));
    expect(mocks.auditFind).toHaveBeenCalledTimes(PAGES);
    // The second page must carry a keyset, or the loop would re-read page one
    // forever.
    expect(mocks.auditFind.mock.calls[1]![0]).toHaveProperty('before');
  });

  /**
   * A compliance export that stopped at the ceiling and did not say so is the
   * "a file cannot carry a banner" failure in its other form.
   */
  it('stops at the row ceiling and reports it', async () => {
    const nextPage = pagesOfFullRows();
    mocks.auditFind.mockImplementation(async () => ({ logs: nextPage(), total: null }));

    const res = await get('?preamble=false');

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-activity-truncated']).toBe('true');
    expect(res.headers['x-activity-truncated-reason']).toBe('row_limit');
    expect(res.headers['x-activity-row-limit']).toBe('5000');
    expect(res.body.trim().split('\n').slice(1)).toHaveLength(5000);
  });

  /**
   * The row ceiling bounds how much is written, not how long the writing takes.
   * An internal handler that answers slowly rather than failing keeps this loop legal and
   * unbounded, holding a Fastify connection, a Postgres client and a socket for
   * as long as the internal handler cares to take — and a compliance export is exactly the
   * request an operator retries when nothing comes back, so the slow case
   * multiplies itself.
   *
   * The clock is driven from inside the read, so the deadline is exercised by
   * the loop rather than by a timer racing it.
   */
  it('stops at the wall-clock budget rather than running as long as the internal handler takes', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // Full pages every time, so nothing but the deadline can end this loop.
    const nextPage = pagesOfFullRows();
    mocks.auditFind.mockImplementation(async () => {
      now += ACTIVITY_EXPORT_TIME_BUDGET_MS / 2 + 1;
      return { logs: nextPage(), total: null };
    });

    const res = await get('?preamble=false');

    // Two pages fit inside the budget; the third is never asked for.
    expect(mocks.auditFind).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.body.trim().split('\n').slice(1)).toHaveLength(ACTIVITY_EXPORT_PAGE_SIZE * 2);
    // Short, and it says so on the header an already-shipped client reads —
    // never handed over as if it were the whole trail.
    expect(res.headers['x-activity-truncated']).toBe('true');
    expect(res.headers['x-activity-truncated-reason']).toBe('time_limit');
    // The row ceiling is NOT what stopped it, and reporting it would tell the
    // operator the file holds 5000 rows when it holds 1000.
    expect(res.headers['x-activity-row-limit']).toBeUndefined();
    expect(res.headers['x-activity-rows']).toBe(String(ACTIVITY_EXPORT_PAGE_SIZE * 2));
  });

  /**
   * The budget must never be able to expire before any work is done: a check at
   * the top of the loop would answer a truncated EMPTY file to a request that
   * had not read a single row.
   */
  it('never truncates before it has fetched anything', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => {
      // Already past any budget from the very first reading.
      now += ACTIVITY_EXPORT_TIME_BUDGET_MS * 10;
      return now;
    });
    mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: null });

    const res = await get('?preamble=false');

    expect(mocks.auditFind).toHaveBeenCalledTimes(1);
    expect(res.body.trim().split('\n').slice(1)).toHaveLength(1);
    // One short page exhausted the stream, so nothing was cut off.
    expect(res.headers['x-activity-truncated']).toBeUndefined();
  });

  /**
   * The reverse mistake, and the worse one: a real outage reported as a time
   * limit hands over a short compliance file during exactly the failure the 424
   * exists for. A transport failure mid-export must still refuse the WHOLE
   * export, not truncate it — including after pages have already been assembled.
   */
  //
  // A failing Dialer read throws out of `fetchActivityPage` (no `partial` page), so the
  // refusal is the error handler's 500 — the invariant is: no short file is handed over
  // after pages were already assembled.
  it('still refuses when the internal handler actually fails mid-export, rather than calling it a time limit', async () => {
    const nextPage = pagesOfFullRows();
    mocks.auditFind.mockImplementation(async () => ({ logs: nextPage(), total: null }));

    let call = 0;
    mocks.coreFindFiltered.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { rows: [], total: null };
      throw new Error('connection terminated unexpectedly');
    });

    const res = await get('?preamble=false');

    expect(res.statusCode).toBe(500);
    // Nothing of the 500 rows already assembled leaks out as a file.
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-activity-rows']).toBeUndefined();
  });

  /**
   * `actor` carries tenant-controlled display names, and this is the file that
   * predictably leaves the organisation and is opened in Excel by someone else.
   */
  it('neutralises a display name that would execute as a spreadsheet formula', async () => {
    mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 1 });
    mocks.findIdentitiesInTenant.mockResolvedValue([
      { id: 'user-1', display_name: '=HYPERLINK("http://evil","click")', email: 'e@x.com', role: 'viewer' },
    ]);

    const res = await get('?preamble=false');

    const cell = res.body.trim().split('\n')[1]!;
    expect(cell).toContain('"\'=HYPERLINK');
    expect(cell).not.toContain(',=HYPERLINK');
  });

  it('verifies the campaign before exporting anything', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 403, body: { error: 'Forbidden' }, headers: new Headers() });

    const res = await get();

    expect(res.statusCode).toBe(403);
    expect(mocks.auditFind).not.toHaveBeenCalled();
  });

  describe('the comment preamble', () => {
    /** Every preamble line the route emits starts with the comment marker. */
    function preambleLines(body: string): string[] {
      return body.split('\n').filter((line) => line.startsWith('#'));
    }

    it('is present by default, ahead of the header row', async () => {
      mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 1 });
      coreRead([coreAutoPause()]);

      const res = await get();

      const lines = res.body.split('\n');
      const preamble = preambleLines(res.body);
      expect(preamble.length).toBeGreaterThan(0);
      // The header must come strictly after every `#` line, never before.
      const headerIndex = lines.indexOf('at,source,action,actor,actor_user_id,target_type,target_id,detail,actor_type,actor_api_key_id');
      expect(headerIndex).toBeGreaterThan(0);
      for (let i = 0; i < headerIndex; i += 1) {
        expect(lines[i]).toMatch(/^#/);
      }
    });

    it('carries the campaign, tenant and account it was scoped to', async () => {
      mocks.auditFind.mockResolvedValue({ logs: [], total: 0 });

      const res = await get();

      expect(res.body).toContain('# Campaign: Q3 collections (id: camp-1)');
      expect(res.body).toContain(`# Tenant: ${TENANT}`);
      // `campaignOk()` stamps `account_id: 'account-1'` — the account the internal handler's
      // rows were actually scoped to, not the request's own `X-Account-Id`.
      expect(res.body).toContain('# Account: account-1');
    });

    it('agrees with the row-count and truncation headers rather than contradicting them', async () => {
      const nextPage = pagesOfFullRows();
      mocks.auditFind.mockImplementation(async () => ({ logs: nextPage(), total: null }));

      const res = await get();

      expect(res.headers['x-activity-truncated']).toBe('true');
      expect(res.headers['x-activity-truncated-reason']).toBe('row_limit');
      expect(res.body).toContain('# Rows exported: 5000');
      expect(res.body).toContain('# Truncated: yes — stopped at the 5000-row export ceiling');
    });

    it('says the export is complete when nothing was truncated', async () => {
      mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 1 });

      const res = await get();

      expect(res.headers['x-activity-truncated']).toBeUndefined();
      expect(res.body).toContain('# Rows exported: 1');
      expect(res.body).toContain('# Truncated: no — this is the complete trail');
    });

    it('states every filter, including the "no filter" case for each independently', async () => {
      const withFilters = await get(
        '?action=agency_campaign.paused,dnc_entry.created'
        + '&from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z',
      );
      expect(withFilters.body).toContain('# Filter — action: agency_campaign.paused | dnc_entry.created');
      expect(withFilters.body).toContain('# Filter — from: 2026-08-01T00:00:00.000Z');
      expect(withFilters.body).toContain('# Filter — to: 2026-08-31T00:00:00.000Z');

      const withoutFilters = await get();
      expect(withoutFilters.body).toContain('# Filter — action: none applied');
      expect(withoutFilters.body).toContain('# Filter — from: none applied');
      expect(withoutFilters.body).toContain('# Filter — to: none applied');
    });

    it.each([
      ['partition_bound', '2026-05-01T00:00:00.000Z', 'source: partition_bound'],
      ['unbounded', null, 'unbounded — the dialer reports no retention horizon'],
      ['unknown', null, 'unknown (source: unknown)'],
    ])('reports the %s retention source the internal handler carried on the page', async (source, earliest, expectedText) => {
      // The horizon is `getAuditRetentionHorizon`'s.
      coreRead([], { retention: { earliest_retained_at: earliest, source } });

      const res = await get();

      expect(res.body).toContain(expectedText);
    });


    /**
     * The comma-split hole the preamble's own doc comment claimed to close and
     * did not. `Q3, =SUM(A1:A9)` begins with `Q`, so a guard tested against the
     * start of the whole value prefixed nothing, the line went out unquoted as
     * `# Campaign: Q3, =SUM(A1:A9)`, and a spreadsheet splitting the row on
     * commas put a live formula in the second cell.
     */
    it.each([
      ['Q3,=SUM(A1:A9)'],
      ['Q3, =SUM(A1:A9)'],
    ])('leaves no live formula in any comma-split cell of the preamble (%s)', async (name) => {
      mocks.proxyToCore.mockResolvedValue({
        status: 200,
        body: { id: CAMPAIGN, name, account_id: 'account-1' },
        headers: new Headers(),
      });
      mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 1 });

      const res = await get();

      const campaignLine = res.body.split('\n').find((l) => l.startsWith('# Campaign:'))!;
      expect(campaignLine).toBeDefined();
      // Split the row the way a spreadsheet splits an unquoted one, and classify
      // each cell the way it classifies one — leading spaces protect nothing.
      for (const cell of campaignLine.split(',')) {
        expect(cell.replace(/^ +/, '')).not.toMatch(/^[=+\-@\t]/);
      }
      // The operator's comma is still there. Forbidding commas in campaign names
      // would answer a chain-of-custody question with a name nobody typed.
      expect(campaignLine).toContain('Q3,');
      expect(campaignLine).toContain('SUM(A1:A9)');
    });

    it('is omitted with ?preamble=false, leaving the header as the first line', async () => {
      mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 1 });

      const res = await get('?preamble=false');

      expect(preambleLines(res.body)).toHaveLength(0);
      expect(res.body.split('\n')[0]).toBe('at,source,action,actor,actor_user_id,target_type,target_id,detail,actor_type,actor_api_key_id');
    });

    /**
     * A campaign name is tenant-controlled and this is the file that leaves
     * the organisation. A raw newline in it must not be able to end the
     * current `#` line early and start an attacker-chosen, un-prefixed line —
     * which would forge extra preamble lines or, with enough of them, inject a
     * fabricated data row ahead of the real header.
     */
    it('cannot have its campaign name forge extra preamble lines or a fake data row', async () => {
      mocks.proxyToCore.mockResolvedValue({
        status: 200,
        body: {
          id: CAMPAIGN,
          name: 'Q3\n# Rows exported: 999999\r\nevil,injected,2099-01-01T00:00:00.000Z,x,,,,{}',
          account_id: 'account-1',
        },
        headers: new Headers(),
      });
      mocks.auditFind.mockResolvedValue({ logs: [dispositionRow()], total: 1 });

      const res = await get();

      const lines = res.body.split('\n').filter((l) => l.length > 0);
      const headerIndex = lines.indexOf('at,source,action,actor,actor_user_id,target_type,target_id,detail,actor_type,actor_api_key_id');
      expect(headerIndex).toBeGreaterThan(0);
      // Every line ahead of the real header is still a `#` comment — the
      // hostile name's embedded `\n`/`\r\n` did not end its `#` line early and
      // start a bare, un-prefixed line of its own choosing.
      for (let i = 0; i < headerIndex; i += 1) {
        expect(lines[i]).toMatch(/^#/);
      }
      // No forged extra data row: exactly the one real disposition row follows
      // the header, and no stray `\r` survived into the file at all.
      expect(lines).toHaveLength(headerIndex + 2);
      expect(lines[headerIndex + 1]).toContain('agency_disposition.created');
      expect(res.body).not.toContain('\r');
      // The hostile text survives only flattened, inert, inside the single
      // `# Campaign:` comment line it was embedded in — never as its own row.
      const campaignLine = lines.find((l) => l.startsWith('# Campaign:'));
      expect(campaignLine).toContain('evil,injected,2099-01-01T00:00:00.000Z');
    });
  });
});
