import { getPool } from '../connection.js';
import type { AuditEvent, AuditLogRow, AuditRecord } from '../models/audit.model.js';

/**
 * The millisecond-truncated sort/keyset key. Stated once so the `WHERE` and the
 * `ORDER BY` can never drift apart — if they did, the page SQL returns would
 * stop being the page the merge is asking for.
 */
const MS_TRUNC_TIMESTAMP = "date_trunc('milliseconds', timestamp)";

/**
 * The request ceiling, shared with `GET /internal/audit-logs` so the route's 400
 * and the clamp here can never name different numbers — a route that accepted a
 * limit this method then silently shortened would hand back a page the caller
 * reads as the end of the trail.
 *
 * 1000, raised from 100 for the CSV export. That export walks the
 * whole filtered trail one merged page at a time, and every page costs it a
 * round trip to this service; at 100 a 5000-row trail was ~51 of them, in
 * series. The cap is a guard against an unbounded page, not a tuning knob — the
 * interactive route still asks for tens.
 */
export const AUDIT_FIND_MAX_LIMIT = 1000;

export class AuditRepository {
  async insertBatch(events: AuditEvent[]): Promise<void> {
    if (events.length === 0) return;

    const pool = getPool();
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const event of events) {
      placeholders.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10})`
      );
      values.push(
        event.callId || null,
        event.tenantId,
        event.accountId,
        event.eventType,
        event.eventCategory,
        event.severity,
        JSON.stringify(event.eventData),
        event.requestId || null,
        event.actor || null,
        event.ipAddress || null,
        event.durationMs || null
      );
      paramIndex += 11;
    }

    // No log here: the one caller, AuditBuffer.flush, logs the failure with its
    // retry count, and logging it here too put two ERROR lines on every attempt.
    await pool.query(
      `INSERT INTO audit_logs (call_id, tenant_id, account_id, event_type, event_category, severity, event_data, request_id, actor, ip_address, duration_ms)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  async findByCallId(callId: string, limit = 100): Promise<AuditRecord[]> {
    const pool = getPool();
    const result = await pool.query<AuditRecord>(
      'SELECT * FROM audit_logs WHERE call_id = $1 ORDER BY timestamp DESC LIMIT $2',
      [callId, limit]
    );
    return result.rows;
  }

  async findByTenant(tenantId: string, accountId?: string, limit = 100, offset = 0): Promise<AuditRecord[]> {
    const pool = getPool();
    if (accountId) {
      const result = await pool.query<AuditRecord>(
        'SELECT * FROM audit_logs WHERE tenant_id = $1 AND account_id = $2 ORDER BY timestamp DESC, id DESC LIMIT $3 OFFSET $4',
        [tenantId, accountId, limit, offset]
      );
      return result.rows;
    }
    const result = await pool.query<AuditRecord>(
      'SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY timestamp DESC, id DESC LIMIT $2 OFFSET $3',
      [tenantId, limit, offset]
    );
    return result.rows;
  }

  /**
   * Campaign/time/type-filtered read behind the internal audit-logs route, so
   * the dialer's agency rows are not write-only.
   *
   * `campaignId` is stored in `event_data.campaign_id`, not a column. Filter
   * via JSONB and the expression index in migration 094 — a sequential scan
   * of a partitioned table is the shape to avoid.
   *
   * ── The order is `(timestamp, id)`, and the second column is load-bearing ──
   * `ORDER BY timestamp DESC` alone does not define an order: it defines a
   * *partial* one, and ties are resolved however the plan happens to emit them.
   * Ties are not rare here — `auditLogger` batches, one batch is one
   * transaction, and `now()` is fixed for the whole transaction, so every row in
   * a flush shares a timestamp to the microsecond. Paginating a partial order is
   * how a row is served twice on one page and never on the next.
   *
   * ── `before` is a keyset, and it is what makes paging stable ───────────────
   * The activity export merges this stream with the platform audit stream in application code, so the two
   * must page by position rather than by offset: an OFFSET is counted from the
   * top of a result set that keeps growing, so a row written during pagination
   * shifts every later page by one. A keyset asks for "the rows after this exact
   * one" and is unaffected by anything written since — new rows are simply newer
   * than the cursor and fall outside the window.
   *
   * ── Both the keyset and the ORDER BY are truncated to MILLISECONDS ─────────
   * `timestamp` is a bare `TIMESTAMPTZ`, i.e. **microsecond** precision, but the
   * cursor travels over JSON and through a JS `Date`, which holds only
   * milliseconds. A cursor is therefore always floor-rounded relative to the row
   * it names, and comparing it against the raw column silently **skips** every
   * row whose true timestamp falls in `(cursor, row]` — rows that were never
   * emitted. Two writers landing in the same millisecond with different
   * microseconds is ordinary, not exotic, so this is a live row-loss bug on a
   * surface whose whole purpose is not to lose rows.
   *
   * Truncating on the SQL side makes the two representations the same value, so
   * the comparison is exact by construction rather than by luck. `ORDER BY` must
   * be truncated too: if SQL ordered on the raw column while the merge ordered on
   * the truncated one, the two would disagree *within* a millisecond and the
   * `limit + 1` prefix SQL returns would not be the prefix the merge expects.
   *
   * The cost is that the ordering can no longer be served directly by migration
   * 094's index (which ends `timestamp DESC` and carries no `id` anyway, so the
   * row-wise form could not drive it either). The filtered set is one campaign's
   * rows, so the sort is small; `from`/`to` still bind the raw column, which is
   * what partition pruning needs.
   */
  async findFiltered(options: {
    tenantId: string;
    accountId: string;
    eventTypes?: string[];
    campaignId?: string;
    from?: Date;
    to?: Date;
    /** Keyset position: return only rows strictly older than this one. */
    before?: { timestamp: Date; id: string };
    limit?: number;
    offset?: number;
    /**
     * `false` skips the `COUNT(*)` and reports `total: null`.
     *
     * The count is a second scan of the same filtered set over a partitioned
     * table, and a caller that walks the trail to its end pays it once per page
     * for a number it discards — the CSV export is exactly that, and at the
     * 5000-row ceiling it was ~51 counts nobody read. Default `true`, so a
     * caller that wants the number keeps it by saying nothing.
     */
    withTotal?: boolean;
  }): Promise<{ rows: AuditLogRow[]; total: number | null }> {
    const pool = getPool();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), AUDIT_FIND_MAX_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions = ['tenant_id = $1', 'account_id = $2'];
    const values: unknown[] = [options.tenantId, options.accountId];
    let paramIndex = 3;

    if (options.eventTypes && options.eventTypes.length > 0) {
      conditions.push(`event_type = ANY($${paramIndex++})`);
      values.push(options.eventTypes);
    }
    if (options.campaignId) {
      conditions.push(`event_data->>'campaign_id' = $${paramIndex++}`);
      values.push(options.campaignId);
    }
    if (options.from) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      values.push(options.from);
    }
    if (options.to) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      values.push(options.to);
    }

    const where = conditions.join(' AND ');
    // `total` is the size of the FILTERED set, deliberately excluding the keyset
    // — a caller paging through wants "how many in this campaign/window", not
    // "how many are left below the cursor", and the latter changes on every page.
    const countSql = `SELECT COUNT(*) as count FROM audit_logs WHERE ${where}`;

    const selectConditions = [...conditions];
    const selectValues = [...values];
    if (options.before) {
      // Row-wise comparison over the truncated value — exactly
      // `trunc < $a OR (trunc = $a AND id < $b)`. See the doc comment for why
      // the truncation is load-bearing rather than cosmetic.
      selectConditions.push(
        `(${MS_TRUNC_TIMESTAMP}, id) < ($${paramIndex++}, $${paramIndex++})`,
      );
      selectValues.push(options.before.timestamp, options.before.id);
    }
    const selectSql = `SELECT * FROM audit_logs WHERE ${selectConditions.join(' AND ')}
       ORDER BY ${MS_TRUNC_TIMESTAMP} DESC, id DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;

    const withTotal = options.withTotal !== false;

    const [countResult, result] = await Promise.all([
      // Not issued at all when the caller said it does not want the number. A
      // `null` total is the honest report of "not counted"; returning 0, or the
      // page length, would be a figure a caller could believe.
      withTotal
        ? pool.query<{ count: string }>(countSql, values)
        : Promise.resolve(null),
      pool.query<AuditLogRow>(selectSql, [...selectValues, limit, offset]),
    ]);

    return {
      rows: result.rows,
      total: countResult === null ? null : parseInt(countResult.rows[0]?.count || '0', 10),
    };
  }
}

export const auditRepository = new AuditRepository();
