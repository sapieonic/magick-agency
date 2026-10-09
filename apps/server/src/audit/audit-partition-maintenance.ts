import type pg from 'pg';
import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'audit-partition-maintenance' });

/**
 * Runtime maintenance of the two monthly range-partitioned audit tables
 * (decision B7 keeps both):
 *
 *  - `audit_logs` (written by `audit/audit-logger.ts`), partition key `timestamp`;
 *  - `platform_audit_log` (written by `audit/platform/*`), partition key `created_at`.
 *
 * The baseline creates 2026-01..2027-12 plus a DEFAULT partition and states that
 * extending and ageing them is a runtime job
 * (`packages/db/migrations/0001_baseline.sql`). Two halves:
 *
 * 1. **Create** the next `monthsAhead` months. Without a runtime creator, once
 *    the baseline's window passes every insert lands in DEFAULT forever — the
 *    state the DEFAULT exists to survive rather than to live in. Partition names
 *    follow the baseline's `<table>_YYYY_MM`.
 *
 *    A month whose range already has rows in DEFAULT (the job did not run for a
 *    while) cannot simply be created: Postgres refuses `CREATE TABLE … PARTITION
 *    OF` while the default holds rows that would belong to it. So every create
 *    is: new table LIKE the parent → move that range's rows out of DEFAULT →
 *    `ATTACH PARTITION`, in ONE transaction. With no stray rows the move is a
 *    no-op. ATTACH builds the partitioned indexes on the new table.
 *
 * 2. **Drop** partitions entirely older than the retention cutoff and
 *    batch-delete old rows from DEFAULT ({@link purgeAuditPartitions}). The two
 *    tables differ only in name and timestamp column, so one function serves
 *    both. The cutoff is `config.auditPartitions.retentionDays` (default 85,
 *    floor 30).
 */

/** Rows per DEFAULT-partition delete batch. */
const BATCH_SIZE = 5000;

export interface AuditTableSpec {
  /** The partitioned parent. */
  table: 'audit_logs' | 'platform_audit_log';
  /** Its partition key column. */
  tsColumn: 'timestamp' | 'created_at';
}

export const AUDIT_TABLES: readonly AuditTableSpec[] = [
  { table: 'audit_logs', tsColumn: 'timestamp' },
  { table: 'platform_audit_log', tsColumn: 'created_at' },
];

/** First instant of the UTC month containing `d`, plus `add` months. */
export function utcMonthStart(d: Date, add = 0): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1));
}

/** `<table>_YYYY_MM`, the baseline's partition naming. */
export function partitionName(table: string, monthStart: Date): string {
  const yyyy = monthStart.getUTCFullYear();
  const mm = String(monthStart.getUTCMonth() + 1).padStart(2, '0');
  return `${table}_${yyyy}_${mm}`;
}

async function existingPartitions(pool: pg.Pool, table: string): Promise<Map<string, string | null>> {
  const { rows } = await pool.query<{ relname: string; bound: string | null }>(
    `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1`,
    [table],
  );
  return new Map(rows.map((r) => [r.relname, r.bound]));
}

/**
 * Ensure partitions exist for the current month and the next `monthsAhead`.
 * Returns the names created. Identifiers are built from the fixed table spec
 * and a computed date, never from input; quoted defensively.
 */
export async function ensureFuturePartitions(
  spec: AuditTableSpec,
  monthsAhead: number,
  now: Date = new Date(),
): Promise<string[]> {
  const pool = getPool();
  const existing = await existingPartitions(pool, spec.table);
  const created: string[] = [];

  for (let i = 0; i <= monthsAhead; i++) {
    const from = utcMonthStart(now, i);
    const to = utcMonthStart(now, i + 1);
    const name = partitionName(spec.table, from);
    if (existing.has(name)) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The bounds below are absolute UTC instants (`toISOString()`), and the
      // session zone is pinned for the transaction too, so a session TimeZone
      // other than UTC can neither shift the ATTACH range away from the
      // DEFAULT-row move's range nor render the bound in local time.
      await client.query(`SET LOCAL TIME ZONE 'UTC'`);
      await client.query(
        `CREATE TABLE "${name}" (LIKE "${spec.table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      );
      const moved = await client.query(
        `WITH moved AS (
           DELETE FROM "${spec.table}_default"
            WHERE "${spec.tsColumn}" >= $1::timestamptz AND "${spec.tsColumn}" < $2::timestamptz
           RETURNING *
         )
         INSERT INTO "${name}" SELECT * FROM moved`,
        [from.toISOString(), to.toISOString()],
      );
      await client.query(
        `ALTER TABLE "${spec.table}" ATTACH PARTITION "${name}" FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`,
      );
      await client.query('COMMIT');
      created.push(name);
      log.info({ partition: name, movedFromDefault: moved.rowCount ?? 0 }, 'Audit partition created');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return created;
}

/**
 * Drops `<table>` monthly partitions whose entire range is older than the
 * cutoff (a DROP is instant vs row-by-row deletes), and batch-deletes old rows
 * from the DEFAULT partition. Rows in a partially-aged partition survive until
 * the whole month passes the cutoff — at most ~1 month of slack.
 *
 * The table name and timestamp column are parameters, from {@link AUDIT_TABLES}.
 */
export async function purgeAuditPartitions(
  spec: AuditTableSpec,
  cutoff: Date,
  dryRun: boolean,
): Promise<{ dropped: string[]; defaultRows: number }> {
  const pool = getPool();
  const dropped: string[] = [];

  const partitions = await pool.query<{ relname: string; bound: string }>(`
    SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = '${spec.table}'`);

  for (const { relname, bound } of partitions.rows) {
    // Range partitions render as: FOR VALUES FROM ('...') TO ('2026-03-01 00:00:00+00')
    const match = /TO \('([^']+)'\)/.exec(bound ?? '');
    if (!match?.[1]) continue; // DEFAULT partition or unparseable bound — skip
    const rangeEnd = new Date(match[1]);
    if (Number.isNaN(rangeEnd.getTime()) || rangeEnd > cutoff) continue;

    if (!dryRun) {
      // relname comes from pg_class, not user input; quoted defensively.
      await pool.query(`DROP TABLE IF EXISTS "${relname}"`);
      log.info({ partition: relname }, 'Audit partition dropped');
    }
    dropped.push(relname);
  }

  let defaultRows = 0;
  const hasDefault = partitions.rows.some((r) => r.relname === `${spec.table}_default`);
  if (hasDefault) {
    if (dryRun) {
      const result = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${spec.table}_default WHERE ${spec.tsColumn} < $1`,
        [cutoff],
      );
      defaultRows = result.rows[0]?.n ?? 0;
    } else {
      let deleted: number;
      do {
        const result = await pool.query(
          `DELETE FROM ${spec.table}_default WHERE id IN (
            SELECT id FROM ${spec.table}_default WHERE ${spec.tsColumn} < $1 LIMIT $2)`,
          [cutoff, BATCH_SIZE],
        );
        deleted = result.rowCount ?? 0;
        defaultRows += deleted;
      } while (deleted === BATCH_SIZE);
    }
  }

  return { dropped, defaultRows };
}

export interface AuditPartitionMaintenanceOptions {
  retentionDays: number;
  monthsAhead: number;
  now?: Date;
  dryRun?: boolean;
}

export interface AuditPartitionMaintenanceReport {
  created: Record<string, string[]>;
  dropped: Record<string, string[]>;
  defaultRowsDeleted: Record<string, number>;
  errors: Record<string, string>;
}

/**
 * One pass over both tables. Each table, and each HALF per table (create, then
 * drop), is attempted independently, and a failure is recorded rather than
 * thrown, so neither one table's fault nor a persistent create failure can stop
 * the rest of the maintenance (the retention purges' per-target posture).
 * `errors` is keyed `<table>.create` / `<table>.purge`.
 */
export async function runAuditPartitionMaintenance(
  opts: AuditPartitionMaintenanceOptions,
): Promise<AuditPartitionMaintenanceReport> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000);
  const report: AuditPartitionMaintenanceReport = { created: {}, dropped: {}, defaultRowsDeleted: {}, errors: {} };

  for (const spec of AUDIT_TABLES) {
    try {
      report.created[spec.table] = opts.dryRun ? [] : await ensureFuturePartitions(spec, opts.monthsAhead, now);
    } catch (err) {
      report.errors[`${spec.table}.create`] = err instanceof Error ? err.message : String(err);
      log.error({ err, table: spec.table }, 'Audit partition create failed for table');
    }
    try {
      const purged = await purgeAuditPartitions(spec, cutoff, opts.dryRun ?? false);
      report.dropped[spec.table] = purged.dropped;
      report.defaultRowsDeleted[spec.table] = purged.defaultRows;
    } catch (err) {
      report.errors[`${spec.table}.purge`] = err instanceof Error ? err.message : String(err);
      log.error({ err, table: spec.table }, 'Audit partition purge failed for table');
    }
  }
  return report;
}
