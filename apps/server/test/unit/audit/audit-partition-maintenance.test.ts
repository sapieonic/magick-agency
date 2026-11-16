import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Audit-partition maintenance, against `src/audit/audit-partition-maintenance.ts`:
 *  - drops only audit partitions entirely older than the cutoff and purges the
 *    default partition (for both `audit_logs` and `platform_audit_log`);
 *  - a dry run counts rows without deleting or dropping anything.
 * Fixtures are the 2026-02 / 2026-05 / DEFAULT partitions and a mocked pool.
 * Also covers the create half's naming / month arithmetic (pure); its SQL is
 * exercised on real Postgres in `test/integration/audit/audit-partition-maintenance.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  logMock: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@magick-agency/observability', () => ({
  logger: mocks.logMock,
  createChildLogger: () => mocks.logMock,
}));

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import {
  AUDIT_HORIZON_TABLES,
  AUDIT_TABLES,
  partitionName,
  purgeAuditHorizonRows,
  purgeAuditPartitions,
  runAuditPartitionMaintenance,
  utcMonthStart,
} from '../../../src/audit/audit-partition-maintenance.js';

function partitionRows(table: string) {
  return [
    { relname: `${table}_2026_02`, bound: `FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00')` },
    { relname: `${table}_2026_05`, bound: `FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00')` },
    { relname: `${table}_default`, bound: 'DEFAULT' },
  ];
}

/** Default query mock: every DELETE removes fewer rows than a batch, partitions listed above. */
function mockQueries(table: string) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_inherits')) {
      const rows = partitionRows(table);
      return { rows, rowCount: rows.length };
    }
    if (sql.trimStart().startsWith('SELECT count')) {
      return { rows: [{ n: 7 }], rowCount: 1 };
    }
    if (sql.trimStart().startsWith('DELETE') || sql.trimStart().startsWith('DROP')) {
      return { rows: [], rowCount: 3 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
}

function executedSql(): string[] {
  return mocks.query.mock.calls.map((c) => String(c[0]).trim());
}

/** The sources' clock: "today (2026-06) minus 85 days ≈ 2026-03-19". */
const CUTOFF = new Date('2026-03-19T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(AUDIT_TABLES)('purgeAuditPartitions — $table', (spec) => {
  it('drops only audit partitions entirely older than the cutoff and purges the default partition', async () => {
    mockQueries(spec.table);
    // Cutoff ≈ 2026-03-19: the 2026-02 partition (ends 03-01) is fully aged out;
    // 2026-05 is not; default is row-deleted.
    const report = await purgeAuditPartitions(spec, CUTOFF, false);

    expect(report.dropped).toEqual([`${spec.table}_2026_02`]);
    const drops = executedSql().filter((s) => s.startsWith('DROP TABLE'));
    expect(drops).toEqual([`DROP TABLE IF EXISTS "${spec.table}_2026_02"`]);
    expect(executedSql().some((s) => s.includes(`DELETE FROM ${spec.table}_default`))).toBe(true);
    expect(report.defaultRows).toBe(3);
  });

  it('dry run counts rows without deleting or dropping anything', async () => {
    mockQueries(spec.table);
    const report = await purgeAuditPartitions(spec, CUTOFF, true);

    expect(report.dropped).toEqual([`${spec.table}_2026_02`]);
    expect(report.defaultRows).toBe(7);
    expect(executedSql().some((s) => s.startsWith('DELETE') || s.startsWith('DROP'))).toBe(false);
  });
});

describe('partition naming and month arithmetic (NEW, the create half)', () => {
  it('names partitions <table>_YYYY_MM, as the baseline does', () => {
    expect(partitionName('audit_logs', new Date(Date.UTC(2028, 0, 1)))).toBe('audit_logs_2028_01');
    expect(partitionName('platform_audit_log', new Date(Date.UTC(2027, 11, 1)))).toBe('platform_audit_log_2027_12');
  });

  it('steps UTC months across a year boundary, independent of the day of month', () => {
    const now = new Date('2027-11-30T23:59:59Z');
    expect(utcMonthStart(now).toISOString()).toBe('2027-11-01T00:00:00.000Z');
    expect(utcMonthStart(now, 1).toISOString()).toBe('2027-12-01T00:00:00.000Z');
    expect(utcMonthStart(now, 2).toISOString()).toBe('2028-01-01T00:00:00.000Z');
  });
});

describe('runAuditPartitionMaintenance: the two halves fail independently (NEW)', () => {
  it('a persistent create failure is recorded per table and does not skip the drop half', async () => {
    mocks.query.mockReset().mockImplementation(async (_sql: string, params?: unknown[]) => {
      // `existingPartitions` (create half) binds the table name; the purge's
      // partition read does not.
      if (params !== undefined && _sql.includes('pg_inherits')) throw new Error('permission denied for schema public');
      return { rows: [], rowCount: 0 };
    });

    const report = await runAuditPartitionMaintenance({
      retentionDays: 85, monthsAhead: 1, now: new Date('2026-06-15T00:00:00Z'),
    });

    expect(report.errors).toEqual({
      'audit_logs.create': 'permission denied for schema public',
      'platform_audit_log.create': 'permission denied for schema public',
    });
    // The purge still ran for both tables.
    expect(report.dropped).toEqual({ audit_logs: [], platform_audit_log: [] });
    expect(report.defaultRowsDeleted).toEqual({ audit_logs: 0, platform_audit_log: 0 });
    // And so did the horizon tables' purge.
    expect(report.horizonRowsDeleted).toEqual({ agency_listen_sessions: 0 });
    expect(mocks.logMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'audit_logs' }), 'Audit partition create failed for table',
    );
  });

  it('a horizon table\'s failed purge is recorded and stops nothing before it', async () => {
    mocks.query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('agency_listen_sessions')) throw new Error('relation "agency_listen_sessions" does not exist');
      return { rows: [], rowCount: 0 };
    });

    const report = await runAuditPartitionMaintenance({
      retentionDays: 85, monthsAhead: 0, now: new Date('2026-06-15T00:00:00Z'), dryRun: true,
    });

    expect(report.errors).toEqual({ 'agency_listen_sessions.purge': 'relation "agency_listen_sessions" does not exist' });
    expect(report.dropped).toEqual({ audit_logs: [], platform_audit_log: [] });
    expect(report.horizonRowsDeleted).toEqual({});
  });
});

describe('purgeAuditHorizonRows: the unpartitioned tables kept for the audit horizon (docs/listening.md, LS12)', () => {
  it('purges the listen sessions, by their start', () => {
    expect(AUDIT_HORIZON_TABLES).toEqual([{ table: 'agency_listen_sessions', tsColumn: 'started_at' }]);
  });

  it('deletes in batches of 5000 until a short batch, each picked by age at the cutoff', async () => {
    const batches = [5000, 5000, 12];
    mocks.query.mockReset().mockImplementation(async () => ({ rows: [], rowCount: batches.shift() ?? 0 }));

    const deleted = await purgeAuditHorizonRows(AUDIT_HORIZON_TABLES[0]!, CUTOFF, false);

    expect(deleted).toBe(10_012);
    expect(mocks.query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of mocks.query.mock.calls) {
      expect(String(sql)).toMatch(/SELECT id FROM agency_listen_sessions WHERE started_at < \$1 LIMIT \$2/);
      expect(String(sql)).toMatch(/DELETE FROM agency_listen_sessions/);
      expect(params).toEqual([CUTOFF, 5000]);
    }
  });

  it('a dry run counts and deletes nothing', async () => {
    mockQueries('agency_listen_sessions');

    expect(await purgeAuditHorizonRows(AUDIT_HORIZON_TABLES[0]!, CUTOFF, true)).toBe(7);
    expect(executedSql()).toHaveLength(1);
    expect(executedSql()[0]).toMatch(/^SELECT count\(\*\)::int AS n FROM agency_listen_sessions WHERE started_at < \$1/);
  });
});
