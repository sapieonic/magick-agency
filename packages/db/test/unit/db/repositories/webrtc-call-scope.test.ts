import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ─── THE DIALER/AGENCY SCOPE PREDICATE ──────────────────────────────────────
 *
 * `webrtc_calls` holds both products' calls — softphone legs (`campaign_id IS
 * NULL`) and agency power-dialer legs (`campaign_id IS NOT NULL`) — and stays one
 * table by design (migration 076). The boundary between the two is therefore a
 * read-path predicate, and the design (docs/architecture.md) puts it at the
 * repository rather than at the routes.
 *
 * That placement is what these tests are pinning. All seven tenant-facing
 * `/api/v1/webrtc-call/*` handlers — list, detail, recording, recording-url, end,
 * retry-analysis and transcript erasure — reach their record through exactly two
 * functions, `listByTenant` and `findByIdScoped`. So the predicate living in those
 * two is what makes an agency call invisible AND untouchable through the
 * softphone's routes, and a regression here silently re-opens all seven at once.
 *
 * The route-level unit tests cannot catch that: they mock the repository
 * wholesale, so they would pass against an unfiltered query. These assert the SQL
 * the repository actually issues; `test/integration/agency/webrtc-call-scope-isolation.test.ts`
 * asserts the resulting behaviour against real rows.
 */

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
}));

vi.mock('../../../../src/connection.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }),
}));

import { WebRtcCallRepository } from '../../../../src/repositories/agency-call.repository.js';

/*
 * `WebRtcCallScope` is `'agency'` only, so the findByIdScoped/listByTenant cases
 * pass `'agency'` and assert `campaign_id IS NOT NULL`; the table is `agency_calls`.
 * Also covered: the required-scope case (untyped code still fails closed to the
 * narrower `campaign_id IS NULL`) and the unscoped findById case.
 */

const repo = new WebRtcCallRepository();

/** Collapse whitespace so assertions do not depend on SQL formatting. */
function sqlAt(i: number): string {
  return (mocks.poolQuery.mock.calls[i]![0] as string).replace(/\s+/g, ' ');
}

describe('WebRtcCallRepository — dialer/agency scope predicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Satisfies both the COUNT(*) shape and the row shape.
    mocks.poolQuery.mockResolvedValue({ rows: [{ count: '0' }], rowCount: 1 });
  });

  describe('findByIdScoped', () => {
    it('keeps the tenant and account predicates alongside it', async () => {
      await repo.findByIdScoped('wc-1', 't1', 'a1', 'agency');
      const sql = sqlAt(0);
      expect(sql).toContain('tenant_id = $2');
      expect(sql).toContain('account_id = $3');
      expect(mocks.poolQuery.mock.calls[0]![1]).toEqual(['wc-1', 't1', 'a1']);
    });
  });

  describe('listByTenant', () => {
    it('applies the predicate to the COUNT query', async () => {
      await repo.listByTenant('t1', 'a1', 'agency');
      expect(sqlAt(0)).toContain('COUNT(*)');
      expect(sqlAt(0)).toContain('campaign_id IS NOT NULL');
    });

    it('applies the predicate to the data query', async () => {
      await repo.listByTenant('t1', 'a1', 'agency');
      expect(sqlAt(1)).toContain('campaign_id IS NOT NULL');
    });

    /**
     * The count and the page must agree. Filtering only the data query would show
     * the right rows under a total that counts the other product's calls, and the
     * pager would run off the end into empty pages — a subtler bug than no filter
     * at all, because the visible list looks correct.
     */
    it('never filters one of the two queries without the other', async () => {
      await repo.listByTenant('t1', 'a1', 'agency');
      expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
      expect(sqlAt(0)).toContain('campaign_id IS NOT NULL');
      expect(sqlAt(1)).toContain('campaign_id IS NOT NULL');
    });

    it('keeps the predicate when the optional filters are also applied', async () => {
      await repo.listByTenant('t1', 'a1', 'agency', 20, 0, {
        status: 'completed',
        phone: '+14155550199',
        analysis_status: 'done',
      });
      for (const i of [0, 1]) {
        const sql = sqlAt(i);
        expect(sql).toContain('campaign_id IS NOT NULL');
        expect(sql).toContain('status = $3');
        expect(sql).toContain('destination_phone = $4');
        expect(sql).toContain('analysis_status = $5');
      }
    });

    /**
     * `campaign_id IS NULL` carries no bind parameter, so it must not disturb the
     * `$n` numbering the optional filters build up from `values.length`.
     */
    it('does not shift the positional parameters', async () => {
      await repo.listByTenant('t1', 'a1', 'agency', 20, 0, { status: 'completed' });
      expect(mocks.poolQuery.mock.calls[0]![1]).toEqual(['t1', 'a1', 'completed']);
      expect(mocks.poolQuery.mock.calls[1]![1]).toEqual(['t1', 'a1', 'completed', 20, 0]);
    });

    /**
     * The list projection must carry the discriminator. Without it the list cannot
     * label — or even recognise — a row from the other product, which is what made
     * the original leak invisible from the response payload.
     *
     * Asserted against the SELECT LIST specifically, not the whole statement. The
     * WHERE clause says `campaign_id IS NULL` on every one of these queries, so a
     * bare `toContain('campaign_id')` over the full SQL passes even with the
     * column removed from the projection — which is the one thing this pins.
     */
    it('projects campaign_id so a foreign row is recognisable', async () => {
      await repo.listByTenant('t1', 'a1', 'agency');
      const sql = sqlAt(1);
      const selectList = sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM agency_calls'));
      expect(selectList).toContain('campaign_id');
    });
  });

  /**
   * The other half of the split. `scope: 'agency'` is what the agency read path
   * passes, and it must be the exact complement of `'agency'` — anything else and
   * a call belongs to both products or to neither.
   */
  describe("scope: 'agency'", () => {
    it('selects the complementary predicate on findByIdScoped', async () => {
      await repo.findByIdScoped('wc-1', 't1', 'a1', 'agency');
      expect(sqlAt(0)).toContain('campaign_id IS NOT NULL');
    });

    it('selects the complementary predicate on both listByTenant queries', async () => {
      await repo.listByTenant('t1', 'a1', 'agency');
      expect(sqlAt(0)).toContain('campaign_id IS NOT NULL');
      expect(sqlAt(1)).toContain('campaign_id IS NOT NULL');
    });

    /**
     * Asserting the agency predicate is present is not enough on its own: a query
     * carrying both clauses would satisfy that and match no rows at all. The two
     * scopes have to be exclusive, so check the dialer clause is absent too.
     */
    it('does not also emit the dialer predicate', async () => {
      await repo.listByTenant('t1', 'a1', 'agency');
      for (const i of [0, 1]) {
        expect(sqlAt(i)).not.toContain('campaign_id IS NULL');
      }
    });
  });

  /**
   * The scope parameter is required and has no default. A default would
   * type-check every call site immediately and leave them all unaudited, which is
   * the entire reason the refactor threads a parameter instead of reading a flag.
   *
   * **What actually gates this, and what does not.** `npm run lint` is
   * `tsc --noEmit` over `src/` (this tree is excluded) plus `lint:test:agency`,
   * which gates only `test/**‍/agency/**`. This file is neither, so the
   * `@ts-expect-error` below would become an unused directive — visible under
   * `npm run lint:test`, which carries a deliberate backlog and is outside the
   * gate. So it documents the intent here; the type-level assertion that CI
   * actually enforces is the one in
   * `test/integration/agency/webrtc-call-scope-isolation.test.ts`, which is in the
   * gated subtree.
   *
   * What the runtime half adds is real either way: the direction of the fallback.
   * Reached from untyped code, this yields the softphone's narrower predicate and
   * never the agency one — failing closed toward the product that does not hold
   * the other's rows.
   */
  describe('scope is required', () => {
    it('is a compile error to omit, and falls back to the dialer scope at runtime', async () => {
      // @ts-expect-error — `scope` is required; this must not compile.
      await repo.listByTenant('t1', 'a1');

      expect(sqlAt(0)).toContain('campaign_id IS NULL');
      expect(sqlAt(0)).not.toContain('campaign_id IS NOT NULL');
    });
  });

  /**
   * `findById` is deliberately NOT scoped. The bridge, settlement and the analysis
   * runner handle both products' calls and reach rows through it; scoping it would
   * break agency call handling rather than isolate it. It is not tenant-facing.
   */
  describe('findById (deliberately unscoped)', () => {
    it('does not filter on campaign_id', async () => {
      await repo.findById('wc-1');
      expect(sqlAt(0)).not.toContain('campaign_id');
    });
  });
});
