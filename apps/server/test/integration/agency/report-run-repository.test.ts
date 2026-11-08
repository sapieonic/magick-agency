import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportDetailFile } from '@magick-agency/contracts/reports';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertTenant } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { reportRunRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');
type CreateInput = import('../../../src/db/repositories/agency.repository.js').ReportRunCreateInput;

/**
 * The report run repository on real Postgres (docs/reports.md, RP2, RP8, RP12–RP14; migration
 * 0023): the per-tenant pending limit under concurrent creates, the assembler's claim (oldest
 * first, SKIP LOCKED between two claimers and past a held row lock, the stale reclaim), every
 * fence (a lost claim's writes refused, a superseded render attempt's callback `stale`, two
 * re-sends of one attempt sending once), the subscription run's unique period, the history's
 * keyset paging and account scoping, notification, expiry and the pending stats.
 *
 * Mutation-checked: dropping the advisory lock from `create` lets the concurrent creates past the
 * limit; `FOR UPDATE` without `SKIP LOCKED` in the claim makes the held-lock case wait (time out);
 * dropping `claim_generation` from `markAssembled`'s WHERE lets the lost claim write; dropping
 * `render_attempt` from `applyRenderResult`'s WHERE applies the superseded callback; dropping the
 * `render_attempt` fence from `markSent` lets both concurrent re-sends win.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();

/** October 2026 in Europe/London: 31 days, 745 hours (the stored cap). */
function input(o: Partial<CreateInput> = {}): CreateInput {
  return {
    tenantId: T,
    accountId: A,
    kind: 'campaign',
    subjectId: randomUUID(),
    localFrom: '2026-10-01',
    localTo: '2026-10-31',
    timezone: 'Europe/London',
    rangeFrom: new Date('2026-09-30T23:00:00Z'),
    rangeTo: new Date('2026-11-01T00:00:00Z'),
    formats: ['pdf', 'xlsx'],
    audience: 'supervisor',
    requestedBy: randomUUID(),
    ...o,
  };
}

async function created(o: Partial<CreateInput> = {}) {
  const outcome = await repo.create(input(o), 1000);
  if (!outcome.ok) throw new Error('queue full');
  return outcome.run;
}

const DETAIL: ReportDetailFile[] = [{
  sheet: 'attempts', label: 'Attempts', key: 'report-datasets/x/details-attempts.ndjson.gz', rows: 3, truncated: false,
  columns: [{ key: 'dialed_at', label: 'Dialled at', type: 'datetime' }],
}];

/** Claim, assemble and send one run: it is `rendering` at attempt 1. */
async function rendering() {
  const run = await created();
  await pool().query(`UPDATE report_runs SET created_at = '2000-01-01' WHERE id = $1`, [run.id]);
  const claim = await repo.claimNextQueued(new Date(Date.now() - 600_000));
  expect(claim?.id).toBe(run.id);
  expect(await repo.markAssembled(run.id, claim!.claim_generation, { datasetKey: 'k', detailFiles: DETAIL, truncated: false })).toBe(true);
  expect(await repo.markSent(run.id, { claimGeneration: claim!.claim_generation })).toBe(1);
  return run;
}

const status = async (id: string) =>
  (await pool().query<{ status: string }>('SELECT status FROM report_runs WHERE id = $1', [id])).rows[0]!.status;

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: T });
  await insertTenant({ id: OTHER_TENANT });
});
afterAll(closeTestPool);

describe('create and read', () => {
  it('inserts a queued run and reads it back in the record shape; another tenant reads nothing', async () => {
    const run = await created({ kind: 'account', subjectId: A, campaignIds: [randomUUID()], emailMe: true });
    expect(run).toMatchObject({
      tenant_id: T, account_id: A, kind: 'account', subject_id: A, local_from: '2026-10-01', local_to: '2026-10-31',
      timezone: 'Europe/London', formats: ['pdf', 'xlsx'], audience: 'supervisor', email_me: true, status: 'queued',
      claim_generation: 0, render_attempt: 0, detail_files: [], files: [], truncated: false, subscription_id: null,
      period_start: null, error_code: null, finished_at: null, expires_at: null,
    });
    expect(run.range_from.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    expect(run.campaign_ids).toHaveLength(1);
    expect(await repo.findById(T, run.id)).toEqual(run);
    expect(await repo.findById(OTHER_TENANT, run.id)).toBeNull();
    expect(await repo.findByIdAnyTenant(run.id)).toEqual(run);
  });

  it('the stored window cap refuses 745 hours and a second (the CHECK under the repository)', async () => {
    await expect(repo.create(input({ rangeTo: new Date('2026-11-01T00:00:01Z') }), 5))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_report_runs_window' });
  });
});

describe('the per-tenant pending limit', () => {
  it('twelve concurrent creates against a limit of five: exactly five queued, seven refused', async () => {
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => repo.create(input(), 5)));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(5);
    const refused = outcomes.filter((o) => !o.ok);
    expect(refused).toHaveLength(7);
    expect(refused[0]).toEqual({ ok: false, reason: 'queue_full', pending: 5 });
    const { rows } = await pool().query<{ n: number }>('SELECT count(*)::int AS n FROM report_runs');
    expect(rows[0]!.n).toBe(5);
  });

  it('counts only pending runs, per tenant; a subscription run counts but is never refused', async () => {
    for (let i = 0; i < 2; i++) await created();
    const done = await created();
    await pool().query(
      `UPDATE report_runs SET status = 'failed', finished_at = now(), error_code = 'assembly_failed', error_message = 'x' WHERE id = $1`,
      [done.id]);
    expect((await repo.create(input(), 3)).ok).toBe(true); // 3 pending now (the failed one is not)
    expect((await repo.create(input(), 3)).ok).toBe(false);
    expect((await repo.create(input({ tenantId: OTHER_TENANT, accountId: OTHER_ACCOUNT }), 3)).ok).toBe(true);
    const sub = await repo.createForSubscription({ ...input(), subscriptionId: randomUUID(), periodStart: '2026-10-01' });
    expect(sub).not.toBeNull();
    expect(await repo.pendingStats()).toMatchObject({ queued: 5 });
  });
});

describe('the assembler claim', () => {
  it('takes the oldest queued run, bumps the generation and stamps the claim', async () => {
    const older = await created();
    const newer = await created();
    await pool().query(`UPDATE report_runs SET created_at = now() - interval '1 minute' WHERE id = $1`, [older.id]);
    const claim = await repo.claimNextQueued(new Date(Date.now() - 600_000));
    expect(claim).toMatchObject({ id: older.id, status: 'assembling', claim_generation: 1 });
    expect(claim!.claimed_at).toBeInstanceOf(Date);
    expect((await repo.claimNextQueued(new Date(Date.now() - 600_000)))?.id).toBe(newer.id);
    expect(await repo.claimNextQueued(new Date(Date.now() - 600_000))).toBeNull();
  });

  it('two concurrent claimers never take the same run', async () => {
    for (let i = 0; i < 3; i++) await created();
    const claims = await Promise.all([1, 2, 3, 4].map(() => repo.claimNextQueued(new Date(Date.now() - 600_000))));
    const ids = claims.filter((c) => c !== null).map((c) => c!.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(claims.filter((c) => c === null)).toHaveLength(1);
  });

  it('skips a run another transaction holds locked, rather than waiting for it (SKIP LOCKED)', async () => {
    const held = await created();
    const free = await created();
    await pool().query(`UPDATE report_runs SET created_at = now() - interval '1 minute' WHERE id = $1`, [held.id]);
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM report_runs WHERE id = $1 FOR UPDATE', [held.id]);
      const claim = await repo.claimNextQueued(new Date(Date.now() - 600_000));
      expect(claim?.id).toBe(free.id);
      expect(await repo.claimNextQueued(new Date(Date.now() - 600_000))).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await repo.claimNextQueued(new Date(Date.now() - 600_000)))?.id).toBe(held.id);
  });

  it('reclaims an assembling run whose claim went stale with no dataset, and fences the old claimer out', async () => {
    const run = await created();
    const first = await repo.claimNextQueued(new Date(Date.now() - 600_000));
    expect(first?.claim_generation).toBe(1);
    // Fresh claim: not stale yet.
    expect(await repo.claimNextQueued(new Date(Date.now() - 600_000))).toBeNull();
    await pool().query(`UPDATE report_runs SET claimed_at = now() - interval '20 minutes' WHERE id = $1`, [run.id]);
    const second = await repo.claimNextQueued(new Date(Date.now() - 600_000));
    expect(second).toMatchObject({ id: run.id, claim_generation: 2, status: 'assembling' });

    // The first assembler wakes up: every write under generation 1 is refused.
    const assembled = { datasetKey: 'old', detailFiles: DETAIL, truncated: true };
    expect(await repo.markAssembled(run.id, 1, assembled)).toBe(false);
    expect(await repo.markSent(run.id, { claimGeneration: 1 })).toBeNull();
    expect(await repo.markFailed(run.id, 'assembly_failed', 'late', { claimGeneration: 1 })).toBeNull();
    expect(await repo.findById(T, run.id)).toMatchObject({ status: 'assembling', dataset_key: null, render_attempt: 0 });

    // The new owner's writes land.
    expect(await repo.markAssembled(run.id, 2, { datasetKey: 'new', detailFiles: DETAIL, truncated: true })).toBe(true);
    expect(await repo.findById(T, run.id)).toMatchObject({ dataset_key: 'new', detail_files: DETAIL, truncated: true });
  });

  it('an assembled run left unsent is the tick\'s to re-send, never reclaimed for assembly', async () => {
    const run = await created();
    const claim = await repo.claimNextQueued(new Date(Date.now() - 600_000));
    await repo.markAssembled(run.id, claim!.claim_generation, { datasetKey: 'k', detailFiles: [], truncated: false });
    await pool().query(`UPDATE report_runs SET claimed_at = now() - interval '20 minutes' WHERE id = $1`, [run.id]);
    expect(await repo.claimNextQueued(new Date(Date.now() - 600_000))).toBeNull();
    expect((await repo.findAssembledUnsent(new Date(Date.now() - 600_000))).map((r) => r.id)).toEqual([run.id]);
    expect(await repo.findAssembledUnsent(new Date(Date.now() - 30 * 60_000))).toEqual([]);
    expect(await repo.markSent(run.id, { renderAttempt: 0 })).toBe(1);
    expect(await repo.findAssembledUnsent(new Date(Date.now() - 600_000))).toEqual([]);
  });

  it('a run with no dataset cannot be sent', async () => {
    const run = await created();
    const claim = await repo.claimNextQueued(new Date(Date.now() - 600_000));
    expect(await repo.markSent(run.id, { claimGeneration: claim!.claim_generation })).toBeNull();
  });
});

describe('sending and the render callback (RP13)', () => {
  it('re-sends are fenced on the attempt read: two concurrent re-sends of attempt 1 send once', async () => {
    const run = await rendering();
    const resent = await Promise.all([repo.markSent(run.id, { renderAttempt: 1 }), repo.markSent(run.id, { renderAttempt: 1 })]);
    expect(resent.filter((a) => a !== null)).toEqual([2]);
    expect(await repo.findById(T, run.id)).toMatchObject({ status: 'rendering', render_attempt: 2 });
  });

  it('the superseded attempt\'s callback is stale; the current one applies once; then everything is stale', async () => {
    const run = await rendering();
    expect(await repo.markSent(run.id, { renderAttempt: 1 })).toBe(2);
    const files = [{ format: 'pdf' as const, key: 'reports/x/report.pdf', bytes: 12_345 }];
    const rendered = { status: 'rendered' as const, files, rendererVersion: '1.2.0', retentionDays: 90 };

    expect(await repo.applyRenderResult(run.id, 1, rendered)).toEqual({ result: 'stale' });
    expect(await status(run.id)).toBe('rendering');

    const applied = await repo.applyRenderResult(run.id, 2, rendered);
    expect(applied.result).toBe('applied');
    if (applied.result !== 'applied') return;
    expect(applied.run).toMatchObject({ status: 'ready', files, renderer_version: '1.2.0', render_attempt: 2 });
    expect(applied.run.expires_at!.getTime() - applied.run.finished_at!.getTime()).toBe(90 * 86_400_000);

    expect(await repo.applyRenderResult(run.id, 2, rendered)).toEqual({ result: 'stale' });
    expect(await repo.applyRenderResult(run.id, 2, {
      status: 'failed', error: { code: 'render_failed', message: 'late' }, rendererVersion: '1.2.0',
    })).toEqual({ result: 'stale' });
    expect(await repo.markSent(run.id, { renderAttempt: 2 })).toBeNull();
    expect(await repo.markFailed(run.id, 'render_timed_out', 'x', { renderAttempt: 2 })).toBeNull();
    expect(await status(run.id)).toBe('ready');
  });

  it('a failed render ends the run failed with the renderer\'s code', async () => {
    const run = await rendering();
    const applied = await repo.applyRenderResult(run.id, 1, {
      status: 'failed', error: { code: 'dataset_version_unsupported', message: 'dataset_version 2' }, rendererVersion: '0.9.0',
    });
    expect(applied.result === 'applied' && applied.run).toMatchObject({
      status: 'failed', error_code: 'dataset_version_unsupported', error_message: 'dataset_version 2',
      renderer_version: '0.9.0', expires_at: null, files: [],
    });
  });

  it('the tick times a run out under the attempt it read, finds sends older than the cutoff', async () => {
    const run = await rendering();
    expect(await repo.findRenderingSentBefore(new Date(Date.now() - 60_000), 10)).toEqual([]);
    await pool().query(`UPDATE report_runs SET sent_at = now() - interval '20 minutes' WHERE id = $1`, [run.id]);
    expect((await repo.findRenderingSentBefore(new Date(Date.now() - 900_000), 10)).map((r) => r.id)).toEqual([run.id]);
    expect(await repo.markFailed(run.id, 'render_timed_out', 'No callback after 3 sends', { renderAttempt: 0 })).toBeNull();
    const failed = await repo.markFailed(run.id, 'render_timed_out', 'No callback after 3 sends', { renderAttempt: 1 });
    expect(failed).toMatchObject({ status: 'failed', error_code: 'render_timed_out' });
    expect(failed!.finished_at).toBeInstanceOf(Date);
    expect(await repo.findRenderingSentBefore(new Date(), 10)).toEqual([]);
  });
});

describe('notification and expiry', () => {
  it('finished runs that email someone wait for notification; marking is once only', async () => {
    const quiet = await rendering();
    const loud = await created({ emailMe: true });
    await pool().query(
      `UPDATE report_runs SET status = 'failed', finished_at = now(), error_code = 'assembly_failed', error_message = 'x'
        WHERE id = ANY($1::uuid[])`, [[quiet.id, loud.id]]);
    const scheduled = await repo.createForSubscription({ ...input(), subscriptionId: randomUUID(), periodStart: '2026-10-01' });
    await pool().query(
      `UPDATE report_runs SET status = 'ready', finished_at = now() + interval '1 second', expires_at = now() WHERE id = $1`,
      [scheduled!.id]);
    expect((await repo.findFinishedUnnotified(10)).map((r) => r.id)).toEqual([loud.id, scheduled!.id]);
    expect(await repo.markNotified(loud.id)).toBe(true);
    expect(await repo.markNotified(loud.id)).toBe(false);
    expect((await repo.findFinishedUnnotified(10)).map((r) => r.id)).toEqual([scheduled!.id]);
  });

  it('expireDue turns ready runs past expires_at expired and leaves the rest', async () => {
    const due = await created();
    const later = await created();
    await pool().query(`UPDATE report_runs SET status = 'ready', finished_at = now(), expires_at = now() - interval '1 minute' WHERE id = $1`, [due.id]);
    await pool().query(`UPDATE report_runs SET status = 'ready', finished_at = now(), expires_at = now() + interval '1 day' WHERE id = $1`, [later.id]);
    expect(await repo.expireDue(new Date())).toBe(1);
    expect(await status(due.id)).toBe('expired');
    expect(await status(later.id)).toBe('ready');
    expect((await repo.findById(T, due.id))!.expires_at).toBeInstanceOf(Date);
    expect(await repo.expireDue(new Date())).toBe(0);
  });
});

describe('subscription runs (RP14)', () => {
  it('one run per (subscription, period): the second insert answers null', async () => {
    const subscriptionId = randomUUID();
    const first = await repo.createForSubscription({ ...input(), subscriptionId, periodStart: '2026-10-01' });
    expect(first).toMatchObject({ subscription_id: subscriptionId, period_start: '2026-10-01', audience: 'supervisor', requested_by: null, email_me: false });
    expect(await repo.createForSubscription({ ...input(), subscriptionId, periodStart: '2026-10-01' })).toBeNull();
    expect(await repo.createForSubscription({ ...input(), localFrom: '2026-11-01', localTo: '2026-11-07', subscriptionId, periodStart: '2026-11-01' }))
      .not.toBeNull();
  });
});

describe('the history list', () => {
  it('pages newest first by keyset, ties broken by id, nothing skipped or repeated', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await created()).id);
    // Four share one microsecond, as rows written in one transaction would.
    await pool().query(`UPDATE report_runs SET created_at = '2026-11-08T10:00:00.123456Z' WHERE id = ANY($1::uuid[])`, [ids.slice(0, 4)]);
    await pool().query(`UPDATE report_runs SET created_at = '2026-11-08T09:00:00Z' WHERE id = ANY($1::uuid[])`, [ids.slice(4)]);
    const seen: string[] = [];
    let cursor: string | null = null;
    const { decodeKeysetCursor } = await import('@magick-agency/domain/keyset-cursor');
    do {
      const page = await repo.list({ tenantId: T, accountId: A, limit: 3, ...(cursor ? { after: decodeKeysetCursor(cursor)! } : {}) });
      expect(page.rows.length).toBeLessThanOrEqual(3);
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.next_cursor;
    } while (cursor);
    const { rows } = await pool().query<{ id: string }>('SELECT id FROM report_runs ORDER BY created_at DESC, id DESC');
    expect(seen).toEqual(rows.map((r) => r.id));
    expect(new Set(seen).size).toBe(7);
  });

  it('is scoped to the tenant and the account (null lists only unscoped runs) and narrows by filters', async () => {
    const requester = randomUUID();
    const subject = randomUUID();
    const mine = await created({ requestedBy: requester, kind: 'agent', subjectId: subject, audience: 'self' });
    const other = await created({ kind: 'campaign' });
    const elsewhere = await created({ accountId: OTHER_ACCOUNT });
    const unscoped = await created({ accountId: null });
    await created({ tenantId: OTHER_TENANT, accountId: A });
    const subscriptionId = randomUUID();
    const scheduled = await repo.createForSubscription({ ...input(), subscriptionId, periodStart: '2026-10-01' });

    const list = async (o: Partial<Parameters<typeof repo.list>[0]> = {}) =>
      (await repo.list({ tenantId: T, accountId: A, limit: 25, ...o })).rows.map((r) => r.id).sort();
    expect(await list()).toEqual([mine.id, other.id, scheduled!.id].sort());
    expect(await list({ accountId: OTHER_ACCOUNT })).toEqual([elsewhere.id]);
    expect(await list({ accountId: null })).toEqual([unscoped.id]);
    expect(await list({ requestedBy: requester })).toEqual([mine.id]);
    expect(await list({ kind: 'agent' })).toEqual([mine.id]);
    expect(await list({ subjectId: subject })).toEqual([mine.id]);
    expect(await list({ subscriptionId })).toEqual([scheduled!.id]);
    expect(await list({ tenantId: OTHER_TENANT, accountId: OTHER_ACCOUNT })).toEqual([]);
  });

  it('countRequestedSince counts one requester\'s runs in the window', async () => {
    const user = randomUUID();
    await created({ requestedBy: user });
    const old = await created({ requestedBy: user });
    await created();
    await pool().query(`UPDATE report_runs SET created_at = now() - interval '2 minutes' WHERE id = $1`, [old.id]);
    expect(await repo.countRequestedSince(T, user, new Date(Date.now() - 60_000))).toBe(1);
    expect(await repo.countRequestedSince(T, user, new Date(Date.now() - 600_000))).toBe(2);
    expect(await repo.countRequestedSince(OTHER_TENANT, user, new Date(Date.now() - 600_000))).toBe(0);
  });
});

describe('pendingStats', () => {
  it('counts by pending status and names the oldest pending run', async () => {
    expect(await repo.pendingStats()).toEqual({ queued: 0, assembling: 0, rendering: 0, oldestCreatedAt: null });
    const oldest = await rendering(); // created 2000-01-01
    await created();
    await created();
    const assembling = await created();
    await pool().query(`UPDATE report_runs SET status = 'assembling', claimed_at = now(), created_at = now() WHERE id = $1`, [assembling.id]);
    const stats = await repo.pendingStats();
    expect(stats).toMatchObject({ queued: 2, assembling: 1, rendering: 1 });
    expect(stats.oldestCreatedAt).toEqual((await repo.findById(T, oldest.id))!.created_at);
  });
});
