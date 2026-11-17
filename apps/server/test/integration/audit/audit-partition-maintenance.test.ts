import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  AUDIT_TABLES,
  ensureFuturePartitions,
  runAuditPartitionMaintenance,
} from '../../../src/audit/audit-partition-maintenance.js';

/**
 * The partition job on the REAL baseline (Postgres 5436): the create half and the drop half
 * (`purgeAuditPartitions`), including "leaves the audit
 * partitions alone when the cutoff predates all of them", and the row purge of the tables kept for
 * the same horizon (`purgeAuditHorizonRows`: the listen sessions).
 *
 * The suite drops and creates partitions of its worker's test database, so
 * `afterAll` puts the baseline's 2026-01..2027-12 window back and drops the
 * 2028 months the create cases add (the next file gets a fresh copy regardless).
 */

/** Drop every `<table>_2028_MM` the create cases attach (rows move to nowhere; tables are test-only). */
async function dropCreated2028(): Promise<void> {
  for (const spec of AUDIT_TABLES) {
    for (const name of (await partitionsOf(spec.table)).filter((n) => n.startsWith(`${spec.table}_2028_`))) {
      await getPool().query(`DROP TABLE IF EXISTS "${name}"`);
    }
  }
}

async function partitionsOf(table: string): Promise<string[]> {
  const { rows } = await getPool().query<{ relname: string }>(
    `SELECT c.relname FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1 ORDER BY c.relname`,
    [table],
  );
  return rows.map((r) => r.relname);
}

async function insertAudit(table: string, at: Date): Promise<void> {
  if (table === 'audit_logs') {
    await getPool().query(
      `INSERT INTO audit_logs (tenant_id, account_id, event_type, event_category, timestamp)
       VALUES ($1, $2, 'test.event', 'system', $3)`,
      [randomUUID(), randomUUID(), at],
    );
  } else {
    await getPool().query(
      `INSERT INTO platform_audit_log (tenant_id, action, resource_type, created_at, actor_type)
       VALUES ($1, 'test.action', 'test', $2, 'system')`,
      [randomUUID(), at],
    );
  }
}

async function rowsIn(relname: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM "${relname}"`);
  return rows[0]!.n;
}

describe('audit partition maintenance against the baseline (integration)', () => {
  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await dropCreated2028();
    // Restore the baseline window (2026-01..2027-12) for whatever runs next.
    for (const spec of AUDIT_TABLES) {
      await ensureFuturePartitions(spec, 23, new Date('2026-01-15T00:00:00Z'));
    }
    await closePool();
  });

  it('leaves the audit partitions alone when the cutoff predates all of them', async () => {
    const before = { a: await partitionsOf('audit_logs'), p: await partitionsOf('platform_audit_log') };
    // now = 2026-03-01, 85 days back = 2025-12-06: before every baseline partition.
    const report = await runAuditPartitionMaintenance({
      retentionDays: 85, monthsAhead: 3, now: new Date('2026-03-01T00:00:00Z'),
    });

    expect(report.errors).toEqual({});
    expect(report.dropped).toEqual({ audit_logs: [], platform_audit_log: [] });
    expect(await partitionsOf('audit_logs')).toEqual(before.a);
    expect(await partitionsOf('platform_audit_log')).toEqual(before.p);
  });

  it('creates the months past the baseline window and moves their DEFAULT rows in', async () => {
    for (const spec of AUDIT_TABLES) {
      // A row for 2028-01 lands in DEFAULT today (no partition yet) — the state a
      // job that has not run for a while leaves behind.
      await insertAudit(spec.table, new Date('2028-01-10T12:00:00Z'));
      expect(await rowsIn(`${spec.table}_default`)).toBe(1);
    }

    const report = await runAuditPartitionMaintenance({
      retentionDays: 3650, monthsAhead: 2, now: new Date('2027-12-05T00:00:00Z'),
    });

    expect(report.errors).toEqual({});
    for (const spec of AUDIT_TABLES) {
      expect(report.created[spec.table]).toEqual([`${spec.table}_2028_01`, `${spec.table}_2028_02`]);
      expect(await rowsIn(`${spec.table}_default`)).toBe(0);
      expect(await rowsIn(`${spec.table}_2028_01`)).toBe(1);
      // A new row in that month now routes to the new partition, not DEFAULT.
      await insertAudit(spec.table, new Date('2028-01-20T00:00:00Z'));
      expect(await rowsIn(`${spec.table}_2028_01`)).toBe(2);
    }

    // Idempotent: a second pass creates nothing.
    const again = await runAuditPartitionMaintenance({
      retentionDays: 3650, monthsAhead: 2, now: new Date('2027-12-05T00:00:00Z'),
    });
    expect(again.created).toEqual({ audit_logs: [], platform_audit_log: [] });
    await dropCreated2028();
  });

  it('creates with UTC bounds even when the session TimeZone is not UTC (Asia/Kolkata)', async () => {
    // 2028-01-31T20:00Z is January in UTC but already February in IST. With the
    // ATTACH bound written as a bare date it was read in the session zone
    // (2028-01-01 00:00 IST = 2027-12-31T18:30Z), while the DEFAULT-row move used
    // UTC instants — so this row was moved into _2028_01 and then violated its
    // partition bound, failing the ATTACH.
    const at = new Date('2028-01-31T20:00:00Z');
    for (const spec of AUDIT_TABLES) await insertAudit(spec.table, at);

    await closePool();
    initDbPool({ url: `${TEST_DB_URL}${TEST_DB_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c timezone=Asia/Kolkata')}`, poolMin: 0, poolMax: 4 });
    try {
      const { rows } = await getPool().query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
      expect(rows[0]!.tz).toBe('Asia/Kolkata');

      const report = await runAuditPartitionMaintenance({
        retentionDays: 3650, monthsAhead: 2, now: new Date('2027-12-05T00:00:00Z'),
      });

      expect(report.errors).toEqual({});
      for (const spec of AUDIT_TABLES) {
        expect(await rowsIn(`${spec.table}_default`)).toBe(0);
        expect(await rowsIn(`${spec.table}_2028_01`)).toBe(1);
        const bound = await getPool().query<{ b: string }>(
          `SELECT pg_get_expr(c.relpartbound, c.oid) AS b FROM pg_class c WHERE c.relname = $1`,
          [`${spec.table}_2028_01`],
        );
        // Rendered in the session zone: UTC midnight on the 1st is 05:30 IST.
        expect(bound.rows[0]!.b).toBe(
          "FOR VALUES FROM ('2028-01-01 05:30:00+05:30') TO ('2028-02-01 05:30:00+05:30')",
        );
      }
    } finally {
      await dropCreated2028();
      await closePool();
      initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
    }
  });

  it('drops partitions wholly past retention and row-deletes old DEFAULT rows, on both tables', async () => {
    for (const spec of AUDIT_TABLES) {
      await insertAudit(spec.table, new Date('2026-01-10T00:00:00Z')); // in 2026_01
      await insertAudit(spec.table, new Date('2025-06-01T00:00:00Z')); // before the window → DEFAULT
      await insertAudit(spec.table, new Date('2026-05-10T00:00:00Z')); // in 2026_05, kept
    }

    // now = 2026-06-15, 85 days back = 2026-03-22: 2026-01 and 2026-02 are wholly older.
    const report = await runAuditPartitionMaintenance({
      retentionDays: 85, monthsAhead: 1, now: new Date('2026-06-15T00:00:00Z'),
    });

    expect(report.errors).toEqual({});
    for (const spec of AUDIT_TABLES) {
      expect(report.dropped[spec.table]).toEqual([`${spec.table}_2026_01`, `${spec.table}_2026_02`]);
      expect(report.defaultRowsDeleted[spec.table]).toBe(1);
      const parts = await partitionsOf(spec.table);
      expect(parts).not.toContain(`${spec.table}_2026_01`);
      expect(parts).not.toContain(`${spec.table}_2026_02`);
      expect(parts).toContain(`${spec.table}_2026_03`); // ends 04-01 > cutoff: kept
      expect(await rowsIn(`${spec.table}_2026_05`)).toBe(1);
    }
  });

  it('deletes listen sessions with their month\'s audit partition, closed or not, and keeps the rest (LS12)', async () => {
    const at = (iso: string, ended: boolean) => getPool().query<{ id: string }>(
      `INSERT INTO agency_listen_sessions
         (tenant_id, account_id, call_id, origin, campaign_id, correlation_id, agent_session_id, agent_user_id,
          listener_user_id, started_at, ended_at, end_reason, replica_id)
       VALUES ($1, $2, $3, 'campaign', $4, $5, $6, $7, $8, $9, $10, $11, 'replica-1') RETURNING id`,
      [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(),
        new Date(iso), ended ? new Date(iso) : null, ended ? 'call_ended' : null],
    ).then((r) => r.rows[0]!.id);
    // The cutoff (2026-03-22) falls in March: the February partitions go, March's is kept.
    await at('2026-02-28T23:59:59Z', true); // February: deleted with February's audit rows
    await at('2026-02-10T00:00:00Z', false); // February, left open by a dead process: deleted
    const marchFirst = await at('2026-03-01T00:00:00Z', true); // March: kept, as March's audit rows are
    const beforeCutoff = await at('2026-03-20T00:00:00Z', true); // before the cutoff, but in March: kept
    const kept = await at('2026-03-23T00:00:00Z', true); // after the cutoff: kept

    // now = 2026-06-15, 85 days back = 2026-03-22. A dry run counts and deletes nothing.
    const dry = await runAuditPartitionMaintenance({
      retentionDays: 85, monthsAhead: 0, now: new Date('2026-06-15T00:00:00Z'), dryRun: true,
    });
    expect(dry.horizonRowsDeleted).toEqual({ agency_listen_sessions: 2 });
    expect(await rowsIn('agency_listen_sessions')).toBe(5);

    const report = await runAuditPartitionMaintenance({
      retentionDays: 85, monthsAhead: 0, now: new Date('2026-06-15T00:00:00Z'),
    });
    expect(report.errors).toEqual({});
    expect(report.horizonRowsDeleted).toEqual({ agency_listen_sessions: 2 });
    const { rows } = await getPool().query<{ id: string }>('SELECT id FROM agency_listen_sessions');
    expect(rows.map((r) => r.id).sort()).toEqual([marchFirst, beforeCutoff, kept].sort());
  });
});
