import { getPool } from '../../connection.js';
import type { AuditLogRecord, CreateAuditLogInput } from '../../models/platform/audit.model.js';

/*
 * PORT NOTE (magick-agency): ported from master `src/db/repositories/audit.repository.ts`
 * (v3.24.0) to `repositories/platform/` (path collision with core's
 * `audit.repository.ts`, which writes `audit_logs`). This one writes
 * `platform_audit_log`. Change: `api_key_id` is no longer inserted (the baseline
 * dropped the column; decision #5), so each row binds ten values, not eleven.
 * Exported as `auditRepository` (master's name, so the ported buffer compiles
 * unchanged) and as `platformAuditRepository`.
 */

/**
 * The request ceiling.
 *
 * 1000, raised from 100 for MAG-158's CSV export. That export asks the merge for
 * `ACTIVITY_EXPORT_PAGE_SIZE + 1` rows from each source, and a clamp BELOW what
 * it asked for is not a smaller page — it is row loss. `mergeActivityPage` reads
 * "fewer rows came back than I asked for" as "this stream is exhausted" and
 * returns a null cursor, so on a trail that is mostly master's rows (dispositions
 * and DNC marks are master-only) the export would stop at the clamp and hand
 * over a file that looks complete. The cap must therefore sit above the largest
 * page any caller asks for, not at a number chosen for the interactive route —
 * `GET /audit-log` keeps its own `max(100)` in its query schema.
 */
const MAX_LIMIT = 1000;

/**
 * The millisecond-truncated sort/keyset key. Stated once so the `WHERE` and the
 * `ORDER BY` can never drift apart — if they did, the page SQL returns would
 * stop being the page the merge is asking for.
 */
const MS_TRUNC_CREATED_AT = "date_trunc('milliseconds', created_at)";

/**
 * The two orderings, and why there are two.
 *
 * Both are TOTAL — `id` is in each — so neither can serve a row twice on one
 * page and never on the next. They differ only in whether the timestamp is
 * truncated, and that difference decides whether Postgres can use an index:
 *
 *  - {@link ORDER_BY_OFFSET} names the bare column, so
 *    `(tenant_id, created_at DESC)` and `(tenant_id, account_id, created_at DESC)`
 *    can drive the sort. This is what every offset-paginated caller gets, and
 *    `GET /audit-log` is tenant-wide: a 50-row page there must not sort the
 *    tenant's whole retained set.
 *  - {@link ORDER_BY_KEYSET} names the truncated expression, which no index can
 *    serve, and is opted into only by the keyset/merge path that needs SQL's
 *    ordering to agree with its cursor's millisecond resolution.
 */
const ORDER_BY_OFFSET = 'created_at DESC, id DESC';
const ORDER_BY_KEYSET = `${MS_TRUNC_CREATED_AT} DESC, id DESC`;

export class AuditRepository {
  async insertBatch(events: CreateAuditLogInput[]): Promise<void> {
    if (events.length === 0) return;
    const pool = getPool();

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const event of events) {
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`,
      );
      values.push(
        event.tenant_id,
        event.account_id || null,
        // Read off the actor union rather than off the event as a whole, so the
        // column can only receive the id belonging to the kind of principal the
        // call site declared. `user_id` on an `api_key` row is the misattribution
        // this whole change exists to remove (86d45t7rm), and the narrowing here
        // is what makes it unwritable rather than merely discouraged.
        event.actor_type === 'human' ? event.user_id : null,
        event.actor_type,
        event.action,
        event.resource_type,
        event.resource_id || null,
        event.campaign_id || null,
        JSON.stringify(event.details || {}),
        event.ip_address || null,
      );
    }

    await pool.query(
      `INSERT INTO platform_audit_log (tenant_id, account_id, user_id, actor_type, action, resource_type, resource_id, campaign_id, details, ip_address)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  /**
   * ── The order is `(created_at, id)`, and the second column is load-bearing ──
   * `ORDER BY created_at DESC` alone is a PARTIAL order, and ties here are the
   * common case rather than the rare one: `auditLogger` batches, one flush is
   * one transaction, and `now()` is fixed for the whole transaction — so every
   * row in a flush shares a timestamp to the microsecond. Paging a partial
   * order serves a row twice on one page and never on the next.
   *
   * ── `before` is a keyset, and it is what makes MAG-158's merge pageable ────
   * The campaign activity trail interleaves this stream with core's in
   * application code, and two OFFSET-paginated sources cannot be merged
   * coherently: an OFFSET counts from the top of a set that keeps growing, so a
   * row written mid-pagination shifts every later page by one. A keyset names
   * one exact position and is unaffected by anything written since — new rows
   * are simply newer than the cursor.
   *
   * ── Both the keyset and the ORDER BY are truncated to MILLISECONDS ─────────
   * `created_at` is a bare `TIMESTAMPTZ`, i.e. **microsecond** precision, but the
   * cursor travels over JSON and through a JS `Date`, which holds only
   * milliseconds. A cursor is therefore always floor-rounded relative to the row
   * it names, and comparing it against the raw column silently **skips** every
   * row whose true timestamp falls in `(cursor, row]` — rows that were never
   * emitted. Two writers landing in the same millisecond with different
   * microseconds is ordinary, so this is live row loss on an audit trail.
   *
   * Truncating on the SQL side makes the two representations the same value, so
   * the comparison is exact by construction. `ORDER BY` must be truncated too, or
   * SQL and the merge would disagree *within* a millisecond and the `limit + 1`
   * prefix SQL returns would not be the prefix the merge expects.
   *
   * ── …and ONLY the keyset path pays for it (`keysetOrder`) ──────────────────
   * An expression in `ORDER BY` cannot be served by
   * `(tenant_id, created_at DESC)` or `(tenant_id, account_id, created_at DESC)`,
   * so applying the truncated ordering unconditionally made every OFFSET caller
   * sort its whole filtered set — including tenant-wide `GET /audit-log`, where
   * an ordinary 50-row page then sorts the tenant's entire retained audit log.
   * That endpoint predates the merge and gains nothing from the truncation, so
   * it keeps the index-friendly ordering and the keyset path opts in.
   *
   * **The opt-in is an explicit flag and deliberately NOT `before !== undefined`.**
   * Page one of a keyset read carries no cursor, so keying off `before` would
   * order page one by the raw column and page two by the truncated one — two
   * orderings that disagree *within* a millisecond, which is precisely the
   * silent row loss the truncation was added to fix, resurfacing only on rows
   * that happen to straddle a page boundary inside the same millisecond. The
   * activity path therefore sets `keysetOrder` on every page, first included,
   * and passing `before` without it throws rather than returning a subtly wrong
   * page.
   *
   * What this does NOT fix: the keyset path still has no index it can use.
   * `idx_audit_log_tenant_campaign` is the one it wants and it ends
   * `created_at DESC` with no `id`, so the row-wise `(created_at, id)`
   * comparison could not have driven it even before the truncation existed.
   * Sizing that properly needs `EXPLAIN` against real data and a migration, and
   * is ticketed separately — so read this split as stopping the OFFSET path
   * being collateral damage, not as the keyset path's performance being handled.
   * `from`/`to` still bind the raw column either way, which is what partition
   * pruning needs.
   *
   * `total` deliberately ignores `before`: it answers "how many rows match this
   * filter", not "how many are left below the cursor", which would count down
   * page by page.
   */
  async find(options: {
    tenantId: string;
    accountId?: string;
    limit?: number;
    offset?: number;
    action?: string;
    actions?: string[];
    resourceType?: string;
    resourceId?: string;
    campaignId?: string;
    /**
     * Filter to one kind of principal (86d45t7rm).
     *
     * Rows written before migration 067 carry a NULL `actor_type` and match NO
     * value here — deliberately, and it is the same rule the module applies to an
     * action the catalog does not know: master cannot say what kind of principal
     * a row it never recorded one for belonged to, and folding those rows into
     * `human` (the tempting default, since most of them are) would be inventing
     * the fact this column exists because nobody captured it.
     */
    actorType?: string;
    from?: Date;
    to?: Date;
    /**
     * Keyset position: return only rows strictly older than this one.
     *
     * Requires {@link keysetOrder}. Passing one without the other is a
     * programming error and throws — see the doc comment above.
     */
    before?: { createdAt: Date; id: string };
    /**
     * Opt into the millisecond-truncated ordering that a keyset read needs.
     *
     * Set on EVERY page of a keyset walk, including the first one — which has no
     * `before` yet. Ordering is a property of the walk, not of the individual
     * request, and a walk whose pages are ordered differently from each other is
     * not a walk.
     *
     * Left unset (the default) the query orders by the bare `created_at`, which
     * an index can serve. Do not set it on an OFFSET-paginated read: it buys
     * nothing there and costs the index.
     */
    keysetOrder?: boolean;
    /**
     * `false` skips the `COUNT(*)` and reports `total: null`.
     *
     * The count is a second scan of the same filtered set over a table
     * partitioned by month, and a caller that pages to the end of the trail pays
     * it once per page for a number it discards — the CSV export is exactly
     * that, and at the 5000-row ceiling it was ~51 counts nobody read. Default
     * `true`, so a caller that wants the number keeps it by saying nothing.
     */
    withTotal?: boolean;
  }): Promise<{ logs: AuditLogRecord[]; total: number | null }> {
    // Refused loudly, not accommodated. A `before` served under the raw ordering
    // reads a millisecond-resolution cursor against a microsecond column and
    // silently drops the rows in between — a wrong page that looks like a right
    // one, on an audit trail. Throwing keeps the invariant unbreakable from the
    // outside instead of relying on every future caller remembering it.
    if (options.before && options.keysetOrder !== true) {
      throw new Error(
        'AuditRepository.find: `before` requires `keysetOrder: true` — a keyset read must use the '
        + 'millisecond-truncated ordering its cursor is expressed in, on every page including the first.',
      );
    }

    const pool = getPool();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions = ['tenant_id = $1'];
    const values: unknown[] = [options.tenantId];
    let paramIndex = 2;

    if (options.accountId) {
      conditions.push(`account_id = $${paramIndex++}`);
      values.push(options.accountId);
    }
    if (options.action) {
      conditions.push(`action = $${paramIndex++}`);
      values.push(options.action);
    }
    // Separate from `action` rather than folded into it: the singular form is an
    // exact match the existing `/audit-log` route depends on, and quietly making
    // it accept a list would change that route's meaning for a comma in a value.
    if (options.actions && options.actions.length > 0) {
      conditions.push(`action = ANY($${paramIndex++})`);
      values.push(options.actions);
    }
    if (options.resourceType) {
      conditions.push(`resource_type = $${paramIndex++}`);
      values.push(options.resourceType);
    }
    if (options.resourceId) {
      conditions.push(`resource_id = $${paramIndex++}`);
      values.push(options.resourceId);
    }
    if (options.campaignId) {
      conditions.push(`campaign_id = $${paramIndex++}`);
      values.push(options.campaignId);
    }
    // `= $n`, so a NULL `actor_type` (a pre-067 row) matches nothing rather than
    // being swept into whichever value was asked for. See the option's doc.
    if (options.actorType) {
      conditions.push(`actor_type = $${paramIndex++}`);
      values.push(options.actorType);
    }
    if (options.from) {
      conditions.push(`created_at >= $${paramIndex++}`);
      values.push(options.from);
    }
    if (options.to) {
      conditions.push(`created_at <= $${paramIndex++}`);
      values.push(options.to);
    }

    const where = conditions.join(' AND ');

    const selectConditions = [...conditions];
    const selectValues = [...values];
    if (options.before) {
      // Row-wise comparison over the truncated value — exactly
      // `trunc < $a OR (trunc = $a AND id < $b)`. See the doc comment for why
      // the truncation is load-bearing rather than cosmetic.
      selectConditions.push(
        `(${MS_TRUNC_CREATED_AT}, id) < ($${paramIndex++}, $${paramIndex++})`,
      );
      selectValues.push(options.before.createdAt, options.before.id);
    }

    // Not issued at all when the caller said it does not want the number. A
    // count that is run and then discarded costs exactly as much as one that is
    // read, and `null` is the honest report of "not counted" — a 0, or the page
    // length, is a figure a caller could believe and would contradict the rows
    // sitting next to it.
    const countResult = options.withTotal === false
      ? null
      : await pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM platform_audit_log WHERE ${where}`,
        values,
      );

    const orderBy = options.keysetOrder === true ? ORDER_BY_KEYSET : ORDER_BY_OFFSET;

    const result = await pool.query<AuditLogRecord>(
      `SELECT * FROM platform_audit_log WHERE ${selectConditions.join(' AND ')}
       ORDER BY ${orderBy} LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...selectValues, limit, offset],
    );

    return {
      logs: result.rows,
      total: countResult === null ? null : parseInt(countResult.rows[0]?.count || '0', 10),
    };
  }
}

export const auditRepository = new AuditRepository();
/** The same instance under an unambiguous name (core's `auditRepository` writes `audit_logs`). */
export const platformAuditRepository = auditRepository;
