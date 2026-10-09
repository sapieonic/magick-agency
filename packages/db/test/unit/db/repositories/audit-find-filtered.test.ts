import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../../../src/connection.js', () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock('@magick-agency/observability', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { auditRepository, AUDIT_FIND_MAX_LIMIT } = await import(
  '../../../../src/repositories/audit.repository.js'
);

/** The two `pool.query` calls are dispatched together; count comes first. */
function calls() {
  const [count, select] = mocks.query.mock.calls;
  return {
    countSql: count?.[0] as string,
    countValues: count?.[1] as unknown[],
    selectSql: select?.[0] as string,
    selectValues: select?.[1] as unknown[],
  };
}

const SCOPE = { tenantId: 'tenant-1', accountId: 'account-1' };

describe('auditRepository.findFiltered', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation((sql: string) =>
      sql.startsWith('SELECT COUNT')
        ? Promise.resolve({ rows: [{ count: '7' }] })
        : Promise.resolve({ rows: [] }),
    );
  });

  /**
   * `ORDER BY timestamp DESC` alone is a PARTIAL order, and ties here are the
   * common case rather than the rare one: `auditLogger` batches, one flush is
   * one transaction, and `now()` is fixed per transaction — so every row in a
   * flush shares a timestamp to the microsecond. Paging a partial order serves
   * a row twice on one page and never on the next.
   */
  it('orders by a total key, not by timestamp alone', async () => {
    await auditRepository.findFiltered(SCOPE);

    expect(calls().selectSql).toContain("ORDER BY date_trunc('milliseconds', timestamp) DESC, id DESC");
  });

  /**
   * `timestamp` is a bare `TIMESTAMPTZ` (microseconds) but a cursor travels
   * through a JS `Date` (milliseconds), so it is always floor-rounded relative
   * to the row it names. Compared against the RAW column, the keyset excludes
   * every row whose true timestamp falls in `(cursor, row]` — rows that were
   * never emitted. Truncating on the SQL side makes the two the same value.
   *
   * The ORDER BY must be truncated in lockstep: if SQL ordered on the raw column
   * while the merge ordered on the truncated one, they would disagree *within* a
   * millisecond and the `limit + 1` prefix would not be the prefix the merge
   * expects. That is why one constant feeds both, and why this asserts both.
   */
  it('compares and orders on the same millisecond-truncated key', async () => {
    await auditRepository.findFiltered({
      ...SCOPE,
      before: { timestamp: new Date('2026-08-01T10:00:00.123Z'), id: 'audit-9' },
    });

    const { selectSql } = calls();
    expect(selectSql).toContain("(date_trunc('milliseconds', timestamp), id) < ($3, $4)");
    expect(selectSql).toContain("ORDER BY date_trunc('milliseconds', timestamp) DESC, id DESC");
    // The raw column must not be compared against a cursor anywhere.
    expect(selectSql).not.toMatch(/\(timestamp, id\) </);
  });

  it('filters the campaign through the indexed JSONB expression', async () => {
    await auditRepository.findFiltered({ ...SCOPE, campaignId: 'camp-1' });

    const { selectSql, selectValues } = calls();
    expect(selectSql).toContain("event_data->>'campaign_id' = $3");
    expect(selectValues).toEqual(['tenant-1', 'account-1', 'camp-1', 50, 0]);
  });

  it('applies the keyset as a row-wise comparison', async () => {
    const timestamp = new Date('2026-08-01T10:00:00.000Z');

    await auditRepository.findFiltered({ ...SCOPE, before: { timestamp, id: 'audit-9' } });

    const { selectSql, selectValues } = calls();
    expect(selectSql).toContain("(date_trunc('milliseconds', timestamp), id) < ($3, $4)");
    // The keyset params sit between the filters and (limit, offset). An
    // off-by-one here binds the cursor to the LIMIT slot and pages nonsense.
    expect(selectValues).toEqual(['tenant-1', 'account-1', timestamp, 'audit-9', 50, 0]);
  });

  /**
   * `total` answers "how many rows in this campaign/window", not "how many are
   * left below the cursor" — the latter shrinks on every page, so a UI showing
   * it as a total would count down instead of holding still.
   */
  it('counts the filtered set without the keyset', async () => {
    await auditRepository.findFiltered({
      ...SCOPE,
      campaignId: 'camp-1',
      before: { timestamp: new Date('2026-08-01T10:00:00.000Z'), id: 'audit-9' },
    });

    const { countSql, countValues, selectValues } = calls();
    expect(countSql).not.toContain('date_trunc');
    expect(countValues).toEqual(['tenant-1', 'account-1', 'camp-1']);
    expect(selectValues).toHaveLength(countValues.length + 4);
  });

  it('clamps the limit to the ceiling and floors the offset', async () => {
    await auditRepository.findFiltered({ ...SCOPE, limit: 50_000, offset: -3 });

    expect(calls().selectValues.slice(-2)).toEqual([AUDIT_FIND_MAX_LIMIT, 0]);
  });

  it('reports the filtered total alongside the page', async () => {
    await expect(auditRepository.findFiltered(SCOPE)).resolves.toEqual({ rows: [], total: 7 });
  });

  /**
   * ── `withTotal: false` skips the COUNT, and skipping it is the point ───────
   * The count is a second scan of the same filtered set over a partitioned
   * table. Master's CSV export walks the trail to its end and never reads
   * `total`, so at the 5000-row export ceiling it was paying for ~51 counts
   * nobody looked at.
   *
   * Asserted as "one query, and it is the SELECT" rather than as a timing —
   * a count that is issued and then discarded costs exactly the same.
   */
  it('issues no COUNT at all when the caller does not want the total', async () => {
    await auditRepository.findFiltered({ ...SCOPE, withTotal: false });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]![0]).toContain('SELECT * FROM audit_logs');
    expect(mocks.query.mock.calls[0]![0]).not.toContain('COUNT');
  });

  /**
   * `null` is the honest report of "not counted". A `0` — or the page length —
   * is a figure a caller could believe, and it would contradict the rows sitting
   * next to it.
   */
  it('reports an uncounted total as null, never as zero', async () => {
    await expect(auditRepository.findFiltered({ ...SCOPE, withTotal: false }))
      .resolves.toEqual({ rows: [], total: null });
  });

  /**
   * Default `true`, so every caller that predates the option is unchanged —
   * which is what makes it safe to add to a live S2S contract.
   */
  it('counts by default, and when asked explicitly', async () => {
    await auditRepository.findFiltered(SCOPE);
    expect(mocks.query).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [{ count: '7' }] });
    await auditRepository.findFiltered({ ...SCOPE, withTotal: true });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
