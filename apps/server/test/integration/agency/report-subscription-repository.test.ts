import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertTenant } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { reportRunRepository, reportSubscriptionRepository: repo } =
  await import('../../../src/db/repositories/agency.repository.js');
const { localDayBounds, nextRunAt, periodFor } = await import('../../../src/agency/reports/schedule.js');
type Mod = typeof import('../../../src/db/repositories/agency.repository.js');
type CreateInput = Parameters<Mod['reportSubscriptionRepository']['create']>[0];
type Sub = import('../../../src/db/repositories/agency.repository.js').ReportSubscriptionRecord;
type Handler = import('../../../src/db/repositories/agency.repository.js').ReportSubscriptionDueHandler;

/**
 * The report subscription repository on real Postgres (docs/reports.md RP4, RP14; migration
 * 0023): create, read, PATCH, delete and the newest run (`last_run`); and the due claim, the
 * tick's only path from a schedule to a run: each due subscription in its own transaction with
 * its run, so a handler that throws (or a crash) leaves no run and the schedule unmoved; two
 * overlapping ticks handle each subscription once (SKIP LOCKED); one run per period whatever
 * runs twice (the unique index).
 *
 * Mutation-checked: `FOR UPDATE` without `SKIP LOCKED` in the due claim makes the held-lock case
 * wait (time out; the overlapping ticks then only serialise); dropping the `failed` exclusion makes a
 * throwing handler be called again in the same call; running the handler outside the claim's
 * transaction (pool instead of client) leaves the run of a throwing handler behind.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const NOW = new Date('2026-11-09T09:00:00Z');

function input(o: Partial<CreateInput> = {}): CreateInput {
  return {
    tenantId: T,
    accountId: A,
    kind: 'account',
    subjectId: A,
    cadence: 'daily',
    sendLocalTime: '07:30',
    sendWeekday: null,
    sendMonthday: null,
    timezone: 'Asia/Kolkata',
    formats: ['pdf', 'xlsx'],
    recipientUserIds: [randomUUID(), randomUUID()],
    enabled: true,
    nextRunAt: new Date('2026-11-09T02:00:00Z'),
    createdBy: randomUUID(),
    ...o,
  };
}

/** The tick's handler, as W1 will write it: the period's run on the claim's client, then the next send. */
const tickHandler = (calls: string[] = []): Handler => async (sub, client) => {
  calls.push(sub.id);
  const period = periodFor(sub.cadence, sub.next_run_at!, sub.timezone);
  const bounds = localDayBounds(period.from, period.to, sub.timezone);
  await reportRunRepository.createForSubscription({
    tenantId: sub.tenant_id, accountId: sub.account_id, kind: sub.kind, subjectId: sub.subject_id,
    localFrom: period.from, localTo: period.to, timezone: sub.timezone, rangeFrom: bounds.start, rangeTo: bounds.end,
    formats: sub.formats, subscriptionId: sub.id, periodStart: period.from,
  }, client);
  return { nextRunAt: nextRunAt(sub, NOW) };
};

const runsOf = async (subscriptionId: string) =>
  (await pool().query<{ period_start: string }>(
    'SELECT period_start::text AS period_start FROM report_runs WHERE subscription_id = $1 ORDER BY period_start',
    [subscriptionId])).rows.map((r) => r.period_start);

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: T });
  await insertTenant({ id: OTHER_TENANT });
});
afterAll(closeTestPool);

describe('create, read, update, delete', () => {
  it('creates and reads back the record shape, with no last run yet', async () => {
    const sub = await repo.create(input({ cadence: 'weekly', sendWeekday: 1, sendLocalTime: '09:05' }));
    expect(sub).toMatchObject({
      tenant_id: T, account_id: A, kind: 'account', subject_id: A, cadence: 'weekly', send_local_time: '09:05',
      send_weekday: 1, send_monthday: null, timezone: 'Asia/Kolkata', formats: ['pdf', 'xlsx'], enabled: true,
      last_run: null,
    });
    expect(sub.recipient_user_ids).toHaveLength(2);
    expect(sub.next_run_at!.toISOString()).toBe('2026-11-09T02:00:00.000Z');
    expect(await repo.findById(T, sub.id)).toEqual(sub);
    expect(await repo.findById(OTHER_TENANT, sub.id)).toBeNull();
  });

  it('lists the account\'s subscriptions newest first; null lists only unscoped ones', async () => {
    const first = await repo.create(input());
    const second = await repo.create(input());
    await pool().query(`UPDATE report_subscriptions SET created_at = now() - interval '1 hour' WHERE id = $1`, [first.id]);
    const elsewhere = await repo.create(input({ accountId: OTHER_ACCOUNT }));
    const unscoped = await repo.create(input({ accountId: null }));
    await repo.create(input({ tenantId: OTHER_TENANT }));
    expect((await repo.list(T, A)).map((s) => s.id)).toEqual([second.id, first.id]);
    expect((await repo.list(T, OTHER_ACCOUNT)).map((s) => s.id)).toEqual([elsewhere.id]);
    expect((await repo.list(T, null)).map((s) => s.id)).toEqual([unscoped.id]);
  });

  it('last_run is the run with the latest period', async () => {
    const sub = await repo.create(input());
    const make = (from: string) => reportRunRepository.createForSubscription({
      tenantId: T, accountId: A, kind: 'account', subjectId: A, localFrom: from, localTo: from, timezone: 'Asia/Kolkata',
      ...(() => { const b = localDayBounds(from, from, 'Asia/Kolkata'); return { rangeFrom: b.start, rangeTo: b.end }; })(),
      formats: ['pdf'], subscriptionId: sub.id, periodStart: from,
    });
    const nov7 = await make('2026-11-07');
    await make('2026-11-05');
    expect((await repo.findById(T, sub.id))!.last_run).toEqual({ id: nov7!.id, status: 'queued', period_start: '2026-11-07' });
    expect((await repo.list(T, A))[0]!.last_run?.id).toBe(nov7!.id);
  });

  it('a PATCH writes only what it names; disabling clears next_run_at; an inconsistent row is refused', async () => {
    const sub = await repo.create(input());
    await pool().query(`UPDATE report_subscriptions SET updated_at = now() - interval '1 day' WHERE id = $1`, [sub.id]);
    const moved = await repo.update(T, sub.id, {
      cadence: 'monthly', sendMonthday: 28, sendLocalTime: '06:45', nextRunAt: new Date('2026-11-28T01:15:00Z'),
    });
    expect(moved).toMatchObject({ cadence: 'monthly', send_monthday: 28, send_weekday: null, send_local_time: '06:45', formats: ['pdf', 'xlsx'] });
    expect(moved!.updated_at.getTime()).toBeGreaterThan(sub.updated_at.getTime());
    const off = await repo.update(T, sub.id, { enabled: false, nextRunAt: null });
    expect(off).toMatchObject({ enabled: false, next_run_at: null });
    await expect(repo.update(T, sub.id, { enabled: true })).rejects.toMatchObject({ code: '23514', constraint: 'ck_report_subscriptions_enabled' });
    await expect(repo.update(T, sub.id, { cadence: 'weekly' })).rejects.toMatchObject({ code: '23514', constraint: 'ck_report_subscriptions_days' });
    expect(await repo.update(OTHER_TENANT, sub.id, { formats: ['pdf'] })).toBeNull();
    expect((await repo.update(T, sub.id, { recipientUserIds: [randomUUID()], formats: ['xlsx'] }))!.formats).toEqual(['xlsx']);
  });

  it('delete removes the subscription and keeps its runs', async () => {
    const sub = await repo.create(input());
    expect(await repo.claimDue(NOW, 5, tickHandler())).toHaveLength(1);
    expect(await repo.delete(OTHER_TENANT, sub.id)).toBe(false);
    expect(await repo.delete(T, sub.id)).toBe(true);
    expect(await repo.findById(T, sub.id)).toBeNull();
    expect(await runsOf(sub.id)).toEqual(['2026-11-08']);
  });

  it('disable stops scheduling, once', async () => {
    const sub = await repo.create(input());
    expect(await repo.disable(sub.id)).toBe(true);
    expect(await repo.disable(sub.id)).toBe(false);
    expect(await repo.findById(T, sub.id)).toMatchObject({ enabled: false, next_run_at: null });
  });
});

describe('the due claim', () => {
  it('creates the period\'s run and advances next_run_at, for due subscriptions only', async () => {
    const due = await repo.create(input());
    const weekly = await repo.create(input({ cadence: 'weekly', sendWeekday: 1, sendLocalTime: '09:00', timezone: 'Europe/London', nextRunAt: new Date('2026-11-09T09:00:00Z') }));
    const future = await repo.create(input({ nextRunAt: new Date('2026-11-10T02:00:00Z') }));
    await repo.create(input({ enabled: false, nextRunAt: null }));
    const calls: string[] = [];
    const outcomes = await repo.claimDue(NOW, 10, tickHandler(calls));
    expect(calls.sort()).toEqual([due.id, weekly.id].sort());
    expect(outcomes.map((o) => o.outcome)).toEqual(['advanced', 'advanced']);
    expect(await runsOf(due.id)).toEqual(['2026-11-08']);
    expect(await runsOf(weekly.id)).toEqual(['2026-11-02']);
    expect((await repo.findById(T, due.id))!.next_run_at!.toISOString()).toBe('2026-11-10T02:00:00.000Z');
    expect((await repo.findById(T, weekly.id))!.next_run_at!.toISOString()).toBe('2026-11-16T09:00:00.000Z');
    expect(await runsOf(future.id)).toEqual([]);
    expect(await repo.claimDue(NOW, 10, tickHandler())).toEqual([]);
  });

  it('takes at most `limit`, earliest due first', async () => {
    const late = await repo.create(input({ nextRunAt: new Date('2026-11-09T03:00:00Z') }));
    const early = await repo.create(input({ nextRunAt: new Date('2026-11-09T01:00:00Z') }));
    const calls: string[] = [];
    expect(await repo.claimDue(NOW, 1, tickHandler(calls))).toHaveLength(1);
    expect(calls).toEqual([early.id]);
    expect(await repo.claimDue(NOW, 1, tickHandler(calls))).toHaveLength(1);
    expect(calls).toEqual([early.id, late.id]);
  });

  it('a handler that throws after creating the run leaves no run and the schedule unmoved; the rest proceed', async () => {
    const bad = await repo.create(input({ nextRunAt: new Date('2026-11-09T01:00:00Z') }));
    const good = await repo.create(input({ nextRunAt: new Date('2026-11-09T02:00:00Z') }));
    const calls: string[] = [];
    const inner = tickHandler();
    const outcomes = await repo.claimDue(NOW, 10, async (sub, client) => {
      calls.push(sub.id);
      const decision = await inner(sub, client);
      if (sub.id === bad.id) throw new Error('recipient lookup failed');
      return decision;
    });
    expect(calls).toEqual([bad.id, good.id]); // the failed one is not retried in the same call
    expect(outcomes).toMatchObject([
      { subscriptionId: bad.id, outcome: 'error', error: expect.objectContaining({ message: 'recipient lookup failed' }) },
      { subscriptionId: good.id, outcome: 'advanced' },
    ]);
    expect(await runsOf(bad.id)).toEqual([]);
    expect((await repo.findById(T, bad.id))!.next_run_at!.toISOString()).toBe('2026-11-09T01:00:00.000Z');
    expect(await runsOf(good.id)).toEqual(['2026-11-08']);
    // The next tick takes it again.
    expect((await repo.claimDue(NOW, 10, tickHandler())).map((o) => o.subscriptionId)).toEqual([bad.id]);
    expect(await runsOf(bad.id)).toEqual(['2026-11-08']);
  });

  it('a next run that is not after the claim is refused, rolling back the run', async () => {
    const sub = await repo.create(input());
    const inner = tickHandler();
    const outcomes = await repo.claimDue(NOW, 10, async (s, client) => {
      await inner(s, client);
      return { nextRunAt: NOW };
    });
    expect(outcomes).toMatchObject([{ subscriptionId: sub.id, outcome: 'error' }]);
    expect(await runsOf(sub.id)).toEqual([]);
  });

  it('a disable decision stops the subscription', async () => {
    const sub = await repo.create(input());
    expect(await repo.claimDue(NOW, 10, async () => ({ disable: true }))).toEqual([{ subscriptionId: sub.id, outcome: 'disabled' }]);
    expect(await repo.findById(T, sub.id)).toMatchObject({ enabled: false, next_run_at: null });
  });

  it('a period that already has a run (run-now, a retry) creates nothing more, and still advances', async () => {
    const sub = await repo.create(input());
    await repo.claimDue(NOW, 10, tickHandler());
    await repo.update(T, sub.id, { nextRunAt: new Date('2026-11-09T02:00:00Z') }); // as if the advance were lost
    let created: unknown = 'unset';
    const outcomes = await repo.claimDue(NOW, 10, async (s, client) => {
      const period = periodFor(s.cadence, s.next_run_at!, s.timezone);
      const b = localDayBounds(period.from, period.to, s.timezone);
      created = await reportRunRepository.createForSubscription({
        tenantId: s.tenant_id, accountId: s.account_id, kind: s.kind, subjectId: s.subject_id, localFrom: period.from,
        localTo: period.to, timezone: s.timezone, rangeFrom: b.start, rangeTo: b.end, formats: s.formats,
        subscriptionId: s.id, periodStart: period.from,
      }, client);
      return { nextRunAt: nextRunAt(s, NOW) };
    });
    expect(created).toBeNull();
    expect(outcomes).toMatchObject([{ outcome: 'advanced' }]);
    expect(await runsOf(sub.id)).toEqual(['2026-11-08']);
  });

  it('two overlapping ticks handle each due subscription exactly once', async () => {
    const subs: Sub[] = [];
    for (let i = 0; i < 6; i++) subs.push(await repo.create(input({ nextRunAt: new Date(Date.UTC(2026, 10, 9, 1, i)) })));
    const calls: string[] = [];
    const inner = tickHandler(calls);
    const slow: Handler = async (sub, client) => {
      await new Promise((r) => setTimeout(r, 30));
      return inner(sub, client);
    };
    const [a, b] = await Promise.all([repo.claimDue(NOW, 10, slow), repo.claimDue(NOW, 10, slow)]);
    expect(a.length + b.length).toBe(6);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(calls.sort()).toEqual(subs.map((s) => s.id).sort());
    for (const s of subs) expect(await runsOf(s.id)).toEqual(['2026-11-08']);
  });

  it('skips a subscription another transaction holds locked, rather than waiting for it', async () => {
    const held = await repo.create(input({ nextRunAt: new Date('2026-11-09T01:00:00Z') }));
    const free = await repo.create(input({ nextRunAt: new Date('2026-11-09T02:00:00Z') }));
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM report_subscriptions WHERE id = $1 FOR UPDATE', [held.id]);
      const calls: string[] = [];
      await repo.claimDue(NOW, 10, tickHandler(calls));
      expect(calls).toEqual([free.id]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
