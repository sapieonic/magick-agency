import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_TENANT, insertWebrtcCall } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));

const { webrtcCallRepository } = await import(
  '../../../src/repositories/agency-call.repository.js'
);

/**
 * ─── AGENCY LEGS ARE INVISIBLE AND UNTOUCHABLE THROUGH THE SOFTPHONE ─────────
 *
 * `webrtc_calls` holds both products' calls and stays one table by design
 * (migration 076). The boundary is a read-path predicate at the repository
 * (`docs/agency-dialer-design.md` §7b), and this suite asserts the resulting
 * behaviour against real SQL rather than the query text.
 *
 * ── Why the seven routes are tested as two functions ────────────────────────
 *
 * Every tenant-facing `/api/v1/webrtc-call/*` handler reaches its record through
 * exactly one of two repository reads:
 *
 *   GET  /                      → listByTenant
 *   GET  /:id                   → findByIdScoped
 *   GET  /:id/recording         → findByIdScoped
 *   GET  /:id/recording-url     → findByIdScoped
 *   POST /:id/end               → findByIdScoped
 *   POST /:id/retry-analysis    → findByIdScoped
 *   DELETE /:id/transcript      → findByIdScoped
 *
 * The six `findByIdScoped` handlers each do the same thing with the result: they
 * 404 when it is null. So `findByIdScoped` returning null for an agency row is
 * exactly what closes all six, and asserting it once at the repository is a
 * stronger statement than asserting it six times through mocked routes — it
 * cannot pass while the SQL is wrong. The route wiring itself (that each handler
 * really does go through this function, and really does 404 on null) is pinned by
 * `test/unit/api/routes/webrtc-call.test.ts`.
 *
 * The severity of the six is not uniform, and the writes are the reason this is a
 * security patch and not a cosmetic one: before the predicate, `POST /:id/end`
 * let a softphone user hang up a live agency power-dialer leg by id, and
 * `DELETE /:id/transcript` let them erase an agency call's transcript.
 */

/*
 * PORT NOTE (magick-agency): ported from core
 * test/integration/agency/webrtc-call-scope-isolation.test.ts@4850d1d9. The
 * softphone (scope `'dialer'`) is deleted; `'agency'` is the only scope.
 *  - DELETED (4): the "findByIdScoped — the six by-id routes" cases. Their
 *    subject is the softphone's six routes; the agency-scope refusal of a
 *    campaign-less row is the "mirror image" case below, kept.
 *  - MODIFIED (5): the "listByTenant" cases now list the AGENCY scope, with
 *    campaign-less rows (`campaign_id: null`, the old softphone shape) as the
 *    rows the scope must neither return nor count.
 *  - MODIFIED (1): the partition case asserts the agency page excludes exactly
 *    the campaign-less rows (no `'dialer'` page to compare against).
 *  - Ids are UUIDs (core: 'test-tenant' / 'test-account' / 'other-tenant'); the
 *    table is `agency_calls`. The comment above is core's and describes core.
 */
const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
const CAMPAIGN = DEFAULTS.campaignId;
const NO_CAMPAIGN = { campaign_id: null };

describe('webrtc_calls dialer/agency scope isolation (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── the list route ───────────────────────────────────────────────────────
  describe('listByTenant — the history route', () => {
    it('lists agency legs only, and counts them only', async () => {
      const agency = await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT, campaign_id: CAMPAIGN });
      await insertWebrtcCall({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        ...NO_CAMPAIGN,
      });
      await insertWebrtcCall({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        ...NO_CAMPAIGN,
      });

      const { rows, total } = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency');

      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(agency.id);
      // The count must agree with the page — see the unit suite for why.
      expect(total).toBe(1);
    });

    it('returns an empty page and a zero total for an account with only campaign-less rows', async () => {
      await insertWebrtcCall({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        ...NO_CAMPAIGN,
      });

      const { rows, total } = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency');
      expect(rows).toHaveLength(0);
      expect(total).toBe(0);
    });

    it('projects campaign_id on the rows it does return', async () => {
      await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT, campaign_id: CAMPAIGN });

      const { rows } = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveProperty('campaign_id');
      expect(rows[0]!.campaign_id).toBe(CAMPAIGN);
    });

    /**
     * The optional filters build `$n` placeholders from `values.length`. The scope
     * predicate carries no bind parameter, so it must not disturb them — a shift
     * here would bind the status to the wrong position and silently return the
     * wrong rows.
     */
    it('composes with the status filter without shifting parameters', async () => {
      const done = await insertWebrtcCall({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        status: 'completed',
        campaign_id: CAMPAIGN,
      });
      await insertWebrtcCall({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        status: 'failed',
        campaign_id: CAMPAIGN,
      });
      await insertWebrtcCall({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        status: 'completed',
        ...NO_CAMPAIGN,
      });

      const { rows, total } = await webrtcCallRepository.listByTenant(
        TENANT, ACCOUNT, 'agency', 20, 0, { status: 'completed' },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(done.id);
      expect(total).toBe(1);
    });

    it('pages over agency legs without counting campaign-less rows into the total', async () => {
      for (let i = 0; i < 3; i += 1) {
        await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT, campaign_id: CAMPAIGN });
      }
      for (let i = 0; i < 5; i += 1) {
        await insertWebrtcCall({
          tenant_id: TENANT,
          account_id: ACCOUNT,
          ...NO_CAMPAIGN,
        });
      }

      const first = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency', 2, 0);
      expect(first.rows).toHaveLength(2);
      expect(first.total).toBe(3);

      // The tail page is the remainder, not an empty page the inflated count
      // would have pointed the pager at.
      const second = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency', 2, 2);
      expect(second.rows).toHaveLength(1);
      expect(second.total).toBe(3);
    });
  });

  /**
   * The type-level half of the contract, in the one test subtree `npm run lint`
   * gates at zero errors (`lint:test:agency`). `scope` must stay REQUIRED: a
   * default would type-check every call site at once and leave them unaudited,
   * which is the whole reason it is a parameter. If someone gives it a default,
   * this directive becomes unused and the gate fails — which is the point.
   *
   * It is a compile-time assertion, so the body never has to run.
   */
  describe('scope is a required parameter', () => {
    it('is a compile error to omit', () => {
      const omitted = (): unknown =>
        // @ts-expect-error — `scope` is required; giving it a default breaks this.
        webrtcCallRepository.listByTenant(TENANT, ACCOUNT);
      const omittedById = (): unknown =>
        // @ts-expect-error — likewise on the by-id read.
        webrtcCallRepository.findByIdScoped('wc-1', TENANT, ACCOUNT);

      expect(typeof omitted).toBe('function');
      expect(typeof omittedById).toBe('function');
    });
  });

  // ── the agency side of the same predicate ────────────────────────────────
  describe("scope 'agency' — the mirror image", () => {
    it('returns the agency leg and refuses the softphone call', async () => {
      const agency = await insertWebrtcCall({
        tenant_id: TENANT, account_id: ACCOUNT, campaign_id: CAMPAIGN,
      });
      const dialer = await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT, ...NO_CAMPAIGN });

      const foundAgency = await webrtcCallRepository.findByIdScoped(
        agency.id, TENANT, ACCOUNT, 'agency',
      );
      expect(foundAgency).not.toBeNull();
      expect(foundAgency!.campaign_id).toBe(CAMPAIGN);

      expect(
        await webrtcCallRepository.findByIdScoped(dialer.id, TENANT, ACCOUNT, 'agency'),
      ).toBeNull();
    });

    it('still enforces the tenant boundary within the agency scope', async () => {
      const other = await insertWebrtcCall({
        tenant_id: OTHER_TENANT, account_id: ACCOUNT, campaign_id: CAMPAIGN,
      });

      expect(
        await webrtcCallRepository.findByIdScoped(other.id, TENANT, ACCOUNT, 'agency'),
      ).toBeNull();
    });

    /**
     * The two scopes must partition the tenant's rows exactly: every row belongs
     * to one product or the other, none to both, none to neither. A row that fell
     * through both lists would be invisible to every surface in the platform, and
     * a row in both would be a leak in whichever direction was read first.
     */
    it('partitions the tenant\'s calls exactly between the two scopes', async () => {
      const campaignLess: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        campaignLess.push((await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT, ...NO_CAMPAIGN })).id);
      }
      for (let i = 0; i < 4; i += 1) {
        await insertWebrtcCall({
          tenant_id: TENANT, account_id: ACCOUNT, campaign_id: CAMPAIGN,
        });
      }

      // PORT NOTE: no `'dialer'` page exists; the complement is the campaign-less rows.
      const agencyPage = await webrtcCallRepository.listByTenant(TENANT, ACCOUNT, 'agency', 50, 0);

      expect(agencyPage.total).toBe(4);

      const dialerIds = new Set(campaignLess);
      const agencyIds = new Set(agencyPage.rows.map((r) => r.id));
      // Disjoint...
      for (const id of dialerIds) expect(agencyIds.has(id)).toBe(false);
      // ...and together the whole tenant.
      const { rows: allRows } = await (async () => {
        const pool = getTestPool();
        return pool.query('SELECT id FROM agency_calls WHERE tenant_id = $1', [TENANT]);
      })();
      expect(dialerIds.size + agencyIds.size).toBe(allRows.length);
    });
  });

  /**
   * The internal read stays unscoped on purpose: the bridge, settlement and the
   * analysis runner all handle both products' calls through it. If this test
   * fails because someone scoped `findById`, the agency dialer is broken, not
   * secured.
   */
  describe('findById — deliberately serves both products', () => {
    it('returns an agency leg', async () => {
      const agency = await insertWebrtcCall({
        tenant_id: TENANT,
        account_id: ACCOUNT,
        campaign_id: CAMPAIGN,
      });
      expect(await webrtcCallRepository.findById(agency.id)).not.toBeNull();
    });

    it('returns a softphone call', async () => {
      const dialer = await insertWebrtcCall({ tenant_id: TENANT, account_id: ACCOUNT, ...NO_CAMPAIGN });
      expect(await webrtcCallRepository.findById(dialer.id)).not.toBeNull();
    });
  });
});
