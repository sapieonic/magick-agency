import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertAccount, insertTenant } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

// The shared repositories reach the pool through `@magick-agency/db`'s own modules too: init it.
const { initDbPool, closePool } = await import('@magick-agency/db');
const { TEST_DB_URL } = await import('../../../../../packages/db/test/helpers/test-db.js');
initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 5 });

const { reportRunRepository: repo, reportSubscriptionRepository, reportCursorRows } = await import('../../../src/db/repositories/agency.repository.js');
const { createReportAssembler } = await import('../../../src/agency/reports/assembler.js');
const { probeSubscriptionSubject } = await import('../../../src/agency/reports/subscription-subject.js');
const { REPORT_DATASET_BUILDERS } = await import('../../../src/agency/reports/datasets/index.js');
type ReportDatasetBuilder = import('../../../src/agency/reports/datasets/index.js').ReportDatasetBuilder;
type ReportAssemblerStorage = import('../../../src/agency/reports/assembler.js').ReportAssemblerStorage;

/**
 * The assembler's deadline on real Postgres (docs/reports.md "Pipeline", the assembler header's
 * "Deadline"): one deadline covers the builder AND the detail streaming, and it stops the work,
 * not only the wait. A detail sheet read through the real cursor (`reportCursorRows`, a REPEATABLE
 * READ transaction on a client of its own) into an S3 upload that stalls, or through a statement
 * that runs long, fails the run `assembly_failed` past the deadline, fenced on the claim, with the
 * cursor's transaction ended and its client back in the pool (`pg_stat_activity`, the pool's
 * counts) by the time the run is recorded.
 *
 * Also: a real builder (the account's) told the deadline has passed stops at its next stage
 * instead of reading on and answering a dataset nobody waits for.
 *
 * Mutation-checked: handing `streamDetailFile` no signal (the builder alone under the deadline)
 * makes the stalled-upload case time out with the cursor's transaction still open; dropping the
 * cursor's `pg_cancel_backend` leaves the long statement running until the test times out;
 * dropping the account builder's checkpoints lets it answer a dataset past the deadline.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();

/** A queued run (October 2026, UTC): a campaign report by default. */
async function queued(kind: 'campaign' | 'account' = 'campaign') {
  const outcome = await repo.create({
    tenantId: T, accountId: A, kind, subjectId: kind === 'account' ? A : randomUUID(),
    localFrom: '2026-10-01', localTo: '2026-10-31', timezone: 'UTC',
    rangeFrom: new Date('2026-10-01T00:00:00Z'), rangeTo: new Date('2026-11-01T00:00:00Z'),
    formats: ['pdf', 'xlsx'], audience: 'supervisor', requestedBy: randomUUID(),
  }, { pendingLimit: 1000 });
  if (!outcome.ok) throw new Error('queue full');
  return outcome.run;
}

/** A builder whose one detail sheet is `sql` through the real report cursor. */
function cursorBuilder(sql: string): ReportDatasetBuilder {
  return async ({ run, now }) => ({
    dataset: { dataset_version: 1, run_id: run.id, kind: run.kind, audience: run.audience, generated_at: now.toISOString() } as never,
    details: [{
      sheet: 'attempts', label: 'Call attempts', columns: [{ key: 'n', label: 'N', type: 'int' }],
      async *rows(signal) {
        for await (const r of reportCursorRows<{ n: number; pad: string }>(sql, [], { signal })) yield [r.n, r.pad];
      },
    }],
  });
}

/** S3 throttled: never reads the body; gives up only when the deadline's signal fires. */
const stalledStorage = (): ReportAssemblerStorage => ({
  uploadStream: (_key: string, _body: Readable, _type: string, signal?: AbortSignal) =>
    new Promise<number>((_, reject) => { signal?.addEventListener('abort', () => reject(signal.reason)); }),
  uploadJson: async () => 0,
});

/** S3 that keeps up: drains the body. */
const drainingStorage = (): ReportAssemblerStorage => ({
  uploadStream: async (_key: string, body: Readable) => {
    let bytes = 0;
    for await (const chunk of body) bytes += (chunk as Buffer).length;
    return bytes;
  },
  uploadJson: async () => 0,
});

function assembler(builder: ReportDatasetBuilder, storage: ReportAssemblerStorage, buildTimeoutMs: number) {
  return createReportAssembler(
    { intervalMs: 60_000, maxDetailRows: 1_000_000, maxAttempts: 3, buildTimeoutMs },
    {
      repo,
      subscriptions: reportSubscriptionRepository,
      subject: probeSubscriptionSubject,
      builders: { agent: builder, campaign: builder, account: builder },
      storage,
      dispatcher: { dispatch: async () => {}, idle: async () => {} },
      now: () => new Date(),
    },
  );
}

/** What the cursor holds: clients checked out of the pool, transactions open, its statements running. */
async function held(): Promise<{ checkedOut: number; inTransaction: number; cursorStatements: number }> {
  const { rows: [r] } = await pool().query<{ in_tx: number; cursor: number }>(
    `SELECT count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS in_tx,
            count(*) FILTER (WHERE state = 'active' AND (query LIKE 'FETCH%report_rows%' OR query LIKE '%pg_sleep(30)%'))::int AS cursor
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  return { checkedOut: pool().totalCount - pool().idleCount, inTransaction: r!.in_tx, cursorStatements: r!.cursor };
}

const failure = async (id: string) =>
  (await pool().query<{ status: string; error_code: string | null }>('SELECT status, error_code FROM report_runs WHERE id = $1', [id])).rows[0]!;

const BIG = `SELECT g AS n, repeat('x', 200) AS pad FROM generate_series(1, 2000000) g`;

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: T });
  await insertAccount({ id: A, tenant_id: T });
});
afterAll(async () => {
  await closeTestPool();
  await closePool();
});

describe('the assembler deadline stops the detail streaming and releases the cursor', () => {
  it('an S3 upload stalled past the deadline: assembly_failed, fenced, the cursor transaction ended', async () => {
    const run = await queued();
    const draining = assembler(cursorBuilder(BIG), stalledStorage(), 1_500).drain(() => false);

    // Mid-run: the cursor holds its REPEATABLE READ transaction while the upload stalls.
    await vi.waitFor(async () => { expect((await held()).inTransaction).toBe(1); }, { timeout: 1_200, interval: 50 });

    const started = Date.now();
    const outcomes = await draining;
    expect(outcomes).toEqual([{ runId: run.id, outcome: 'failed', code: 'assembly_failed' }]);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await failure(run.id)).toEqual({ status: 'failed', error_code: 'assembly_failed' });
    expect(await held()).toEqual({ checkedOut: 0, inTransaction: 0, cursorStatements: 0 });
  });

  it('a detail statement running past the deadline is cancelled: assembly_failed, nothing left running', async () => {
    const run = await queued();
    const started = Date.now();
    const outcomes = await assembler(cursorBuilder(`SELECT 1 AS n, pg_sleep(30)::text AS pad`), drainingStorage(), 500).drain(() => false);
    expect(outcomes).toEqual([{ runId: run.id, outcome: 'failed', code: 'assembly_failed' }]);
    // Well short of the statement's 30 s: it was cancelled, not waited out.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await failure(run.id)).toEqual({ status: 'failed', error_code: 'assembly_failed' });
    await vi.waitFor(async () => { expect(await held()).toEqual({ checkedOut: 0, inTransaction: 0, cursorStatements: 0 }); }, { timeout: 2_000 });
  });

  it('a claim taken over during the stalled upload: the deadline\'s failure is refused by the fence', async () => {
    const run = await queued();
    const draining = assembler(cursorBuilder(BIG), stalledStorage(), 1_000).drain(() => false);
    await vi.waitFor(async () => { expect((await held()).inTransaction).toBe(1); }, { timeout: 900, interval: 50 });
    // Another assembler reclaimed it (a newer claim generation).
    await pool().query('UPDATE report_runs SET claim_generation = claim_generation + 1 WHERE id = $1', [run.id]);

    expect(await draining).toEqual([{ runId: run.id, outcome: 'claim_lost' }]);
    expect(await failure(run.id)).toEqual({ status: 'assembling', error_code: null });
    expect(await held()).toEqual({ checkedOut: 0, inTransaction: 0, cursorStatements: 0 });
  });

  it('a run inside its deadline streams the whole sheet through the same cursor', async () => {
    const run = await queued();
    const outcomes = await assembler(cursorBuilder(`SELECT g AS n, 'p' AS pad FROM generate_series(1, 2500) g`), drainingStorage(), 10_000).drain(() => false);
    expect(outcomes).toEqual([{ runId: run.id, outcome: 'sent', attempt: 1 }]);
    const { rows: [r] } = await pool().query<{ detail_files: Array<{ rows: number; truncated: boolean }> }>('SELECT detail_files FROM report_runs WHERE id = $1', [run.id]);
    expect(r!.detail_files).toEqual([expect.objectContaining({ sheet: 'attempts', rows: 2500, truncated: false })]);
    expect(await held()).toEqual({ checkedOut: 0, inTransaction: 0, cursorStatements: 0 });
  });

  it('a real builder past the deadline stops at its next stage instead of answering', async () => {
    const run = await queued('account');
    const build = REPORT_DATASET_BUILDERS.account;
    // Inside its deadline the (empty) account builds.
    await expect(build({ run, now: new Date(), signal: new AbortController().signal })).resolves.toMatchObject({ dataset: { kind: 'account' } });
    const deadline = new AbortController();
    deadline.abort(new Error('report build timed out after 1ms'));
    await expect(build({ run, now: new Date(), signal: deadline.signal })).rejects.toThrow('report build timed out after 1ms');
    expect(await held()).toEqual({ checkedOut: 0, inTransaction: 0, cursorStatements: 0 });
  });
});
