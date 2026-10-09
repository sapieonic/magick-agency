import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('../../../../../src/connection.js', () => ({ getPool: () => mocks.pool }));

import { AuditRepository } from '../../../../../src/repositories/platform/audit.repository.js';

/*
 *  - `api_key_id` is not a column (baseline): each row binds
 *    10 values, so placeholders are `$1..$10` / `$11..$20` and every parameter
 *    index after `actor_type` (3) moves down by one.
 *  - DELETED: "writes the key id and NO user id for an api_key actor" and
 *    "still records api_key when the key id is unavailable" (no API keys).
 *  - MODIFIED: "refuses to write a user id smuggled onto an api_key row" now
 *    smuggles it onto a `system` row — the remaining non-human shape, and the
 *    same repository narrowing (`actor_type === 'human' ? user_id : null`).
 *  - `ACTIVITY_EXPORT_PAGE_SIZE` is the server's activity-export constant
 *    (apps/server/src/agency/agency-activity.ts); this package cannot import
 *    it, so its value is restated here.
 * Mocked pool: ids and action strings are arbitrary, nothing reaches Postgres.
 */
const ACTIVITY_EXPORT_PAGE_SIZE = 500;

const logRow = {
  id: 'log-1', tenant_id: 't-1', user_id: 'u-1',
  action: 'user.login', resource_type: 'user', resource_id: 'u-1',
  details: {}, ip_address: '127.0.0.1', created_at: new Date(),
};

describe('AuditRepository', () => {
  let repo: AuditRepository;

  beforeEach(() => {
    repo = new AuditRepository();
    vi.clearAllMocks();
  });

  describe('insertBatch', () => {
    it('should not query when given empty array', async () => {
      await repo.insertBatch([]);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    it('should INSERT a single event', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.insertBatch([{
        tenant_id: 't-1', account_id: 'a-1', actor_type: 'human', user_id: 'u-1',
        action: 'schedule.created',
        resource_type: 'schedule', resource_id: 's-1', campaign_id: 'c-1',
        details: {}, ip_address: '127.0.0.1',
      }]);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO platform_audit_log');
      expect(sql).toContain('($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)');
      expect(params[0]).toBe('t-1');
      expect(params[1]).toBe('a-1');
      expect(params[2]).toBe('u-1');
      expect(params[3]).toBe('human');
      expect(params[4]).toBe('schedule.created');
      expect(params[5]).toBe('schedule');
      expect(params[6]).toBe('s-1');
      expect(params[7]).toBe('c-1');
      expect(params[8]).toBe('{}');
      expect(params[9]).toBe('127.0.0.1');
    });

    it('should INSERT multiple events with sequential placeholders', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.insertBatch([
        { tenant_id: 't-1', actor_type: 'system', action: 'schedule.created', resource_type: 'schedule' },
        { tenant_id: 't-1', actor_type: 'system', action: 'schedule.cancelled', resource_type: 'schedule' },
      ]);
      const [sql] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)');
      expect(sql).toContain('($11, $12, $13, $14, $15, $16, $17, $18, $19, $20)');
    });

    /**
     * The columns the actor union writes, one shape per branch.
     *
     * These are the assertions that make the repair real rather than declared:
     * the whole point of the change is that a key-authenticated row must NOT
     * carry a `user_id`, and the union only makes that unconstructible in
     * TypeScript — vitest does not type-check, so the SQL half needs its own
     * check. The `system` case is here for the same reason: `system` and
     * `api_key` both write a NULL `user_id` and must remain distinguishable by
     * `actor_type` alone, which is the ambiguity this ticket exists to remove.
     */
    describe('the actor columns', () => {
      const base = { tenant_id: 't-1', action: 'schedule.created', resource_type: 'schedule' } as const;

      it('writes the user id and no key id for a human actor', async () => {
        mocks.pool.query.mockResolvedValue({ rows: [] });
        await repo.insertBatch([{ ...base, actor_type: 'human', user_id: 'u-1' }]);
        const [sql, params] = mocks.pool.query.mock.calls[0]!;
        expect(params[2]).toBe('u-1');
        expect(params[3]).toBe('human');
        // There is no key-id column to be null; assert it is not written.
        expect(sql).not.toContain('api_key_id');
      });

      it('writes neither identity for a system actor', async () => {
        mocks.pool.query.mockResolvedValue({ rows: [] });
        await repo.insertBatch([{ ...base, actor_type: 'system' }]);
        const [, params] = mocks.pool.query.mock.calls[0]!;
        expect(params[2]).toBeNull();
        expect(params[3]).toBe('system');
        expect(params).toHaveLength(10);
      });

      /**
       * The narrowing is in the REPOSITORY, not only in the type. A caller that
       * defeats the union — an `as any`, a value crossing a JS boundary — must
       * still not be able to put a human's id on a key's row, because that row
       * is the misattribution the whole change removes.
       */
      it('refuses to write a user id smuggled onto a system row', async () => {
        mocks.pool.query.mockResolvedValue({ rows: [] });
        await repo.insertBatch([
          { ...base, actor_type: 'system', user_id: 'u-1' } as never,
        ]);
        const [, params] = mocks.pool.query.mock.calls[0]!;
        expect(params[2]).toBeNull();
        expect(params[3]).toBe('system');
      });
    });

    it('should serialize details as JSON', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.insertBatch([{
        tenant_id: 't-1', actor_type: 'system', action: 'schedule.created', resource_type: 'schedule',
        details: { key: 'value' },
      }]);
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[8]).toBe('{"key":"value"}');
    });

    it('should default details to empty object when not provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.insertBatch([{ tenant_id: 't-1', actor_type: 'system', action: 'schedule.created', resource_type: 'schedule' }]);
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[8]).toBe('{}');
    });

    it('should set resource_id and ip_address to null when not provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.insertBatch([{ tenant_id: 't-1', actor_type: 'system', action: 'schedule.created', resource_type: 'schedule' }]);
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[6]).toBeNull();
      expect(params[9]).toBeNull();
    });
  });

  describe('find', () => {
    it('should run count + data queries and return both', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [logRow] });

      const result = await repo.find({ tenantId: 't-1' });
      expect(result.total).toBe(10);
      expect(result.logs).toEqual([logRow]);
      expect(mocks.pool.query).toHaveBeenCalledTimes(2);
    });

    it('should apply default limit=50 and offset=0', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1' });
      const [, params2] = mocks.pool.query.mock.calls[1]!;
      expect(params2[params2.length - 2]).toBe(50);
      expect(params2[params2.length - 1]).toBe(0);
    });

    it('should apply custom limit and offset', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1', limit: 10, offset: 20 });
      const [, params2] = mocks.pool.query.mock.calls[1]!;
      expect(params2[params2.length - 2]).toBe(10);
      expect(params2[params2.length - 1]).toBe(20);
    });

    it('should filter by action when provided', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '3' }] })
        .mockResolvedValueOnce({ rows: [logRow] });

      await repo.find({ tenantId: 't-1', action: 'schedule.created' });
      const [sql1, params1] = mocks.pool.query.mock.calls[0]!;
      expect(sql1).toContain('action = $2');
      expect(params1[1]).toBe('schedule.created');
    });

    it('should filter by resourceType when provided', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1', resourceType: 'account' });
      const [sql1, params1] = mocks.pool.query.mock.calls[0]!;
      expect(sql1).toContain('resource_type = $2');
      expect(params1[1]).toBe('account');
    });

    it('should filter by action and resourceType simultaneously', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [logRow] });

      await repo.find({ tenantId: 't-1', action: 'schedule.created', resourceType: 'schedule' });
      const [sql1, params1] = mocks.pool.query.mock.calls[0]!;
      expect(sql1).toContain('action = $2');
      expect(sql1).toContain('resource_type = $3');
      expect(params1[1]).toBe('schedule.created');
      expect(params1[2]).toBe('schedule');
    });

    it('should filter by resourceId, campaignId, accountId, from, and to in SQL', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [logRow] });

      const from = new Date('2026-08-01T00:00:00Z');
      const to = new Date('2026-08-17T00:00:00Z');
      await repo.find({
        tenantId: 't-1',
        resourceId: 'att-1',
        campaignId: 'camp-1',
        accountId: 'acct-1',
        from,
        to,
      });
      const [sql1, params1] = mocks.pool.query.mock.calls[0]!;
      expect(sql1).toContain('account_id = $2');
      expect(sql1).toContain('resource_id = $3');
      expect(sql1).toContain('campaign_id = $4');
      expect(sql1).toContain('created_at >= $5');
      expect(sql1).toContain('created_at <= $6');
      expect(params1).toEqual(['t-1', 'acct-1', 'att-1', 'camp-1', from, to]);
    });

    /**
     * The ceiling has to sit ABOVE the largest page any caller asks for, and the
     * CSV export asks for `ACTIVITY_EXPORT_PAGE_SIZE + 1`. A clamp below the
     * requested size is not a smaller page — `mergeActivityPage` reads "fewer
     * rows than I asked for" as "this stream is exhausted", so the export would
     * stop at the clamp and hand over a file that looks complete.
     */
    it('caps limit at 1000, above the largest page the export asks for', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1', limit: 50_000 });
      const [, params2] = mocks.pool.query.mock.calls[1]!;
      expect(params2[params2.length - 2]).toBe(1000);
      expect(ACTIVITY_EXPORT_PAGE_SIZE + 1).toBeLessThanOrEqual(1000);
    });

    it('passes a page the size the export asks for straight through', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1', limit: ACTIVITY_EXPORT_PAGE_SIZE + 1 });
      const [, params2] = mocks.pool.query.mock.calls[1]!;
      expect(params2[params2.length - 2]).toBe(ACTIVITY_EXPORT_PAGE_SIZE + 1);
    });

    /**
     * ── `withTotal: false` skips the COUNT, and skipping it is the point ─────
     * The count is a second scan of the same filtered set over a table
     * partitioned by month. The CSV export pages to the end of the trail and
     * discards the number, so at the 5000-row ceiling it was paying for ~51
     * counts nobody read.
     *
     * Asserted as "one query, and it is the SELECT" rather than as a timing — a
     * count that is issued and then dropped costs exactly the same.
     */
    it('issues no COUNT at all when the caller does not want the total', async () => {
      mocks.pool.query.mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1', withTotal: false });

      expect(mocks.pool.query).toHaveBeenCalledTimes(1);
      const [sql] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('SELECT * FROM platform_audit_log');
      expect(sql).not.toContain('COUNT');
    });

    /**
     * `null` is the honest report of "not counted". A 0 — or the page length —
     * is a figure a caller could believe, and it would contradict the rows
     * sitting next to it.
     */
    it('reports an uncounted total as null, never as zero', async () => {
      mocks.pool.query.mockResolvedValueOnce({ rows: [logRow] });

      const result = await repo.find({ tenantId: 't-1', withTotal: false });

      expect(result.total).toBeNull();
      expect(result.logs).toEqual([logRow]);
    });

    /**
     * Default true, so every caller written before the option is unchanged —
     * `GET /audit-log` still renders a count.
     */
    it('counts by default, and when asked explicitly', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '4' }] })
        .mockResolvedValueOnce({ rows: [] });

      await expect(repo.find({ tenantId: 't-1', withTotal: true })).resolves.toMatchObject({ total: 4 });
      expect(mocks.pool.query).toHaveBeenCalledTimes(2);
    });

    /**
     * `ORDER BY created_at DESC` alone is a PARTIAL order, and ties are the
     * common case here rather than the rare one: `auditLogger` batches, one
     * flush is one transaction, and `now()` is fixed for a transaction — so
     * every row in a flush shares a timestamp to the microsecond. Paging a
     * partial order serves a row twice on one page and never on the next.
     */
    it('orders by a total key, not by created_at alone', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1' });

      expect(mocks.pool.query.mock.calls[1]![0]).toContain('ORDER BY created_at DESC, id DESC');
    });

    /**
     * The truncated ordering is an EXPRESSION, so neither
     * `(tenant_id, created_at DESC)` nor `(tenant_id, account_id, created_at DESC)`
     * can serve it — a tenant-wide `GET /audit-log` page would sort the tenant's
     * whole retained set to render 50 rows. That endpoint predates the merge and
     * needs nothing from the truncation, so it must keep the bare column.
     */
    it('leaves the offset path on the index-friendly ordering', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1', accountId: 'a-1', limit: 50, offset: 100 });

      const [sql] = mocks.pool.query.mock.calls[1]!;
      expect(sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(sql).not.toContain('ORDER BY date_trunc');
    });

    /**
     * The keyset walk opts in, and it does so on EVERY page — the first one
     * included, which carries no cursor yet.
     */
    it('uses the truncated ordering when the caller opts in, cursor or not', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1', keysetOrder: true });

      expect(mocks.pool.query.mock.calls[1]![0])
        .toContain("ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC");
    });

    /**
     * The invariant, encoded so it cannot be got wrong later.
     *
     * Deriving the ordering from `before` instead of an explicit flag is the
     * plausible-looking mistake: page one of a keyset walk has no cursor, so it
     * would get the raw ordering and page two the truncated one. The two
     * disagree *within* a millisecond, and a row straddling that boundary
     * between pages is emitted on neither — the exact silent row loss the
     * truncation was added to fix, visible only on rows that share a
     * millisecond. So a `before` without the flag is refused rather than
     * quietly served a subtly wrong page.
     */
    it('throws on a keyset read that did not opt into the keyset ordering', async () => {
      await expect(repo.find({
        tenantId: 't-1',
        before: { createdAt: new Date('2026-08-01T12:00:00.123Z'), id: 'a-9' },
      })).rejects.toThrow(/`before` requires `keysetOrder: true`/);

      // Refused before it reached the database, not after a wrong page came back.
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    /**
     * `created_at` is a bare `TIMESTAMPTZ` (microseconds) but a cursor travels
     * through a JS `Date` (milliseconds), so it is always floor-rounded relative
     * to the row it names. Compared against the RAW column, the keyset excludes
     * every row whose true timestamp falls in `(cursor, row]` — rows that were
     * never emitted. Truncating on the SQL side makes the two the same value.
     *
     * The ORDER BY must be truncated in lockstep, or SQL and the merge disagree
     * *within* a millisecond and the `limit + 1` prefix stops being the prefix
     * the merge expects. One constant feeds both; this asserts both.
     */
    it('compares and orders on the same millisecond-truncated key', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({
        tenantId: 't-1',
        keysetOrder: true,
        before: { createdAt: new Date('2026-08-01T12:00:00.123Z'), id: 'a-9' },
      });

      const [sql] = mocks.pool.query.mock.calls[1]!;
      expect(sql).toContain("(date_trunc('milliseconds', created_at), id) < ($2, $3)");
      expect(sql).toContain("ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC");
      // The raw column must not be compared against a cursor anywhere.
      expect(sql).not.toMatch(/\(created_at, id\) </);
    });

    it('applies a keyset as a row-wise comparison, after the filters', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });
      const createdAt = new Date('2026-08-01T12:00:00Z');

      await repo.find({ tenantId: 't-1', campaignId: 'camp-1', keysetOrder: true, before: { createdAt, id: 'a-9' } });

      const [sql, params] = mocks.pool.query.mock.calls[1]!;
      expect(sql).toContain("(date_trunc('milliseconds', created_at), id) < ($3, $4)");
      // An off-by-one here binds the cursor to the LIMIT slot and pages nonsense.
      expect(params).toEqual(['t-1', 'camp-1', createdAt, 'a-9', 50, 0]);
    });

    /**
     * `total` answers "how many rows match this filter", not "how many are left
     * below the cursor" — the latter counts down page by page.
     */
    it('counts the filtered set without the keyset', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '9' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repo.find({
        tenantId: 't-1',
        campaignId: 'camp-1',
        keysetOrder: true,
        before: { createdAt: new Date('2026-08-01T12:00:00Z'), id: 'a-9' },
      });

      const [countSql, countParams] = mocks.pool.query.mock.calls[0]!;
      expect(countSql).not.toContain('date_trunc');
      expect(countParams).toEqual(['t-1', 'camp-1']);
      expect(result.total).toBe(9);
    });

    /**
     * Separate from the singular `action` rather than folded into it: the exact
     * match is what `GET /audit-log` depends on, and quietly making it accept a
     * list would change that route's meaning for a comma inside a value.
     */
    it('matches a set of actions without disturbing the exact-match filter', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.find({ tenantId: 't-1', actions: ['dnc_entry.created', 'agency_campaign.paused'] });

      const [sql, params] = mocks.pool.query.mock.calls[1]!;
      expect(sql).toContain('action = ANY($2)');
      expect(params[1]).toEqual(['dnc_entry.created', 'agency_campaign.paused']);
    });

    it('should return 0 total when count row missing', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repo.find({ tenantId: 't-1' });
      expect(result.total).toBe(0);
    });
  });
});
