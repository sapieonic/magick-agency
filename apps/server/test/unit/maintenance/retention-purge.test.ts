import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * PORT NOTE (magick-agency): ported from core test/unit/maintenance/retention-purge.test.ts
 * @4850d1d9 (19 cases -> 16), against the AGENCY SLICE of the purge (see the module's
 * header). Deleted, with the targets they covered: "deletes a concurrency group only
 * once...", "keeps IVR sessions still referenced by a surviving call", "falls the agency
 * transcript window back to the softphone one when unset" (no softphone window), and the
 * `kb_*` date-cast block inside the order case. Rewritten for the slice: the order case
 * (two tables), the two "purges each product's ... under its own predicate" cases (now:
 * the purge touches the two agency tables and nothing else), the window-binding cases
 * (the agency window is the only row window; unset means no row purge), the transcript-window binding (UPDATE agency_calls, one statement,
 * unset = none) and the report. New: the transcript step nulls `conversation_log` AND
 * `transcript_meta` and never `call_analysis` (the "analysis survives" invariant).
 * Real-Postgres coverage of that invariant is test/integration/db/agency-retention-purge.
 */
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  config: {
    server: { env: 'test' },
    retention: {
      slackWebhookUrl: undefined as string | undefined,
      minDays: 30,
      agencyRetentionDays: 85 as number | undefined,
      agencyTranscriptRetentionDays: undefined as number | undefined,
    },
  } as Record<string, any>,
  logMock: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: mocks.logMock,
  createChildLogger: () => mocks.logMock,
}));

vi.mock('../../../src/config/index.js', () => ({
  config: mocks.config,
}));

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({ query: mocks.query }),
}));

// No-delay retry so Slack failure tests don't sleep
vi.mock('../../../src/utils/retry.js', () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}));

import { runRetentionPurge, isPurgeRunning } from '../../../src/maintenance/retention-purge.js';

const DAY = 24 * 60 * 60 * 1000;

/** Default query mock: every DELETE removes fewer rows than a batch, partitions listed above. */
function mockQueries(opts: { deleteRowCounts?: number[]; updateRowCount?: number } = {}) {
  const deleteRowCounts = [...(opts.deleteRowCounts ?? [])];
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.trimStart().startsWith('SELECT count')) {
      return { rows: [{ n: 7 }], rowCount: 1 };
    }
    if (sql.trimStart().startsWith('DELETE') || sql.trimStart().startsWith('DROP')) {
      return { rows: [], rowCount: deleteRowCounts.shift() ?? 3 };
    }
    if (sql.trimStart().startsWith('UPDATE agency_calls')) {
      return { rows: [], rowCount: opts.updateRowCount ?? 0 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
}

function executedSql(): string[] {
  return mocks.query.mock.calls.map((c) => (c[0] as string).replace(/\s+/g, ' ').trim());
}

describe('runRetentionPurge (agency slice)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.retention.slackWebhookUrl = undefined;
    mocks.config.retention.agencyRetentionDays = 85;
    mocks.config.retention.agencyTranscriptRetentionDays = undefined;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    // Pin Date only (timers stay real) so partition-drop expectations are
    // deterministic: cutoff = 2026-06-12 - 85d = 2026-03-19.
    vi.useFakeTimers({ now: new Date('2026-06-12T00:00:00Z'), toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes the analysis jobs before the calls they reference and reports counts', async () => {
    mockQueries();

    const report = await runRetentionPurge();

    expect(report.error).toBeUndefined();
    expect(Object.keys(report.tables)).toEqual(['dialer_analysis_jobs', 'agency_calls']);

    const deletes = executedSql().filter((s) => s.startsWith('DELETE FROM'));
    const orderOf = (table: string) => deletes.findIndex((s) => s.startsWith(`DELETE FROM ${table} `));
    // dialer_analysis_jobs FK-references agency_calls, so it must purge first.
    expect(orderOf('dialer_analysis_jobs')).toBeLessThan(orderOf('agency_calls'));
  });

  it('touches only the two agency tables', async () => {
    mockQueries();
    await runRetentionPurge();

    const targets = executedSql()
      .filter((s) => s.startsWith('DELETE FROM') || s.startsWith('UPDATE'))
      .map((s) => /^(?:DELETE FROM|UPDATE) (\w+)/.exec(s)![1]);
    for (const t of targets) expect(['dialer_analysis_jobs', 'agency_calls']).toContain(t);
    // No product predicate: every agency_calls row is agency's.
    expect(executedSql().some((s) => s.includes('campaign_id'))).toBe(false);
  });

  it('binds the agency window to both row targets', async () => {
    mocks.config.retention.agencyRetentionDays = 400;
    mockQueries();
    await runRetentionPurge();

    const cutoffs = mocks.query.mock.calls
      .filter((c) => /^(DELETE FROM (dialer_analysis_jobs|agency_calls)) /.test((c[0] as string).trimStart()))
      .map((c) => ((c[1] as unknown[])[0] as Date).getTime());
    expect(cutoffs).toHaveLength(2);
    for (const cutoff of cutoffs) expect(cutoff).toBe(Date.now() - 400 * DAY);
  });

  it('with no agency window set, deletes nothing', async () => {
    mocks.config.retention.agencyRetentionDays = undefined;
    mockQueries();
    const report = await runRetentionPurge();

    expect(report.retention_days).toBeNull();
    expect(report.cutoff).toBeNull();
    expect(report.tables).toEqual({});
    expect(executedSql().some((s) => s.startsWith('DELETE') || s.startsWith('DROP'))).toBe(false);
  });

  it('binds the transcript window to agency_calls, one statement, and not to the row window', async () => {
    mocks.config.retention.agencyRetentionDays = 400;
    mocks.config.retention.agencyTranscriptRetentionDays = 30;
    mockQueries();
    await runRetentionPurge();

    const updates = mocks.query.mock.calls.filter((c) => (c[0] as string).trimStart().startsWith('UPDATE agency_calls'));
    expect(updates).toHaveLength(1);
    const cutoff = ((updates[0]![1] as unknown[])[0] as Date).getTime();
    expect(cutoff).toBe(Date.now() - 30 * DAY);
    expect(cutoff).not.toBe(Date.now() - 400 * DAY);
  });

  it('nulls the transcript AND its provenance but never the analysis', async () => {
    mocks.config.retention.agencyTranscriptRetentionDays = 30;
    mockQueries();
    await runRetentionPurge();

    const update = executedSql().find((s) => s.startsWith('UPDATE agency_calls'))!;
    expect(update).toContain('SET conversation_log = NULL, transcript_meta = NULL');
    expect(update).not.toContain('call_analysis');
    expect(update).not.toContain('analysis_status');
    // Only rows that still carry a transcript, so a cleared row is a no-op.
    expect(update).toContain('conversation_log IS NOT NULL OR transcript_meta IS NOT NULL');
  });

  it('runs no transcript step when the transcript window is unset', async () => {
    mockQueries();
    const report = await runRetentionPurge();
    expect(executedSql().some((s) => s.startsWith('UPDATE'))).toBe(false);
    expect(report.agency_transcripts_nulled).toBe(0);
  });

  it('reports the nulled transcripts', async () => {
    mocks.config.retention.agencyTranscriptRetentionDays = 30;
    mockQueries({ updateRowCount: 11 });
    const report = await runRetentionPurge();
    expect(report.agency_transcripts_nulled).toBe(11);
  });

  it('passes a cutoff of AGENCY_RETENTION_DAYS ago', async () => {
    mockQueries();
    const before = Date.now();
    await runRetentionPurge();
    const after = Date.now();

    const cutoffArg = mocks.query.mock.calls.find((c) => (c[0] as string).startsWith('DELETE'))?.[1]?.[0] as Date;
    const expectedMs = 85 * DAY;
    expect(before - cutoffArg.getTime()).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(after - cutoffArg.getTime()).toBeLessThanOrEqual(expectedMs + 1000);
  });

  it('keeps deleting batches until a partial batch is returned', async () => {
    // jobs: one partial batch. agency_calls: two full batches (5000) then a partial one (120).
    mockQueries({ deleteRowCounts: [3, 5000, 5000, 120] });

    const report = await runRetentionPurge();

    expect(report.tables['dialer_analysis_jobs']).toBe(3);
    expect(report.tables['agency_calls']).toBe(10120);
    const callsDeletes = executedSql().filter((s) => s.startsWith('DELETE FROM agency_calls'));
    expect(callsDeletes).toHaveLength(3);
  });

  it('purges by created_at only, regardless of status', async () => {
    mockQueries();
    await runRetentionPurge();
    const rowSql = executedSql().filter((q) => q.startsWith('DELETE FROM dialer') || q.startsWith('DELETE FROM agency_calls')).join('\n');
    expect(rowSql).not.toContain('status');
  });

  it('does not touch audit_logs at all (partition maintenance is lane A\'s)', async () => {
    mockQueries();
    const report = await runRetentionPurge();
    expect(report).not.toHaveProperty('audit_partitions_dropped');
    expect(report).not.toHaveProperty('audit_default_rows');
    expect(executedSql().some((s) => s.includes('audit_logs') || s.includes('pg_inherits') || s.startsWith('DROP'))).toBe(false);
  });

  it('dry run counts rows without deleting, updating or dropping anything', async () => {
    mocks.config.retention.agencyTranscriptRetentionDays = 30;
    mockQueries();
    const report = await runRetentionPurge({ dryRun: true });

    expect(report.dry_run).toBe(true);
    expect(report.tables['agency_calls']).toBe(7);
    expect(report.agency_transcripts_nulled).toBe(7);
    expect(executedSql().some((s) => s.startsWith('DELETE') || s.startsWith('DROP') || s.startsWith('UPDATE'))).toBe(false);
  });

  it('posts a Slack summary when the webhook is configured', async () => {
    mocks.config.retention.slackWebhookUrl = 'https://hooks.slack.com/services/T/B/x';
    mockQueries();

    await runRetentionPurge({ requestedBy: 'test' });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/T/B/x');
    const payload = JSON.parse(init.body);
    expect(payload.text).toContain('Retention purge complete');
    expect(payload.text).toContain('`agency_calls`:');
    expect(payload.text).toContain('`dialer_analysis_jobs`:');
    expect(payload.text).not.toContain('audit_logs');
  });

  it('captures query errors on the report and still posts the Slack failure summary', async () => {
    mocks.config.retention.slackWebhookUrl = 'https://hooks.slack.com/services/T/B/x';
    mocks.query.mockRejectedValue(new Error('connection refused'));

    const report = await runRetentionPurge();

    expect(report.error).toBe('connection refused');
    const payload = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(payload.text).toContain('FAILED');
    expect(payload.text).toContain('connection refused');
  });

  it('rejects a second run while one is in flight and clears the flag afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.query.mockImplementation(async (sql: string) => {
      await gate;
      if (sql.includes('pg_inherits')) return { rows: [], rowCount: 0 };
      if (sql.trimStart().startsWith('SELECT count')) return { rows: [{ n: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const first = runRetentionPurge();
    expect(isPurgeRunning()).toBe(true);
    await expect(runRetentionPurge()).rejects.toThrow('already running');

    release();
    await first;
    expect(isPurgeRunning()).toBe(false);
  });
});
