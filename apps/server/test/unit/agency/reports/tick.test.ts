// The reports tick over fakes: a subscription's period and catch-up (only the latest missed
// period), the duplicate, the advance strictly after now; the reconcile paths (unsent → sent;
// timed out with every file in S3 → applied through the shared path; without them → re-sent, then
// failed `render_timed_out` at the last attempt); notify only for the tick that marked the run;
// expiry; the gauges; and per-item isolation (one bad run never stops the tick). The SQL behind
// each fake is pinned by the repositories' integration tests.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

const metrics = vi.hoisted(() => ({ subs: vi.fn(), pending: vi.fn(), oldest: vi.fn(), runs: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/agency', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  agencyReportsSubscriptionRunsTotal: { inc: metrics.subs },
  agencyReportsPendingRuns: { set: metrics.pending },
  agencyReportsOldestPendingSeconds: { set: metrics.oldest },
  agencyReportsRunsTotal: { inc: metrics.runs },
}));

import { createReportTick, dueSendAt, type ReportTickDeps } from '../../../../src/agency/reports/tick.js';
import { reportOutputKey } from '../../../../src/agency/reports/report-keys.js';
import type {
  ReportRunFence,
  ReportRunSubscriptionInput,
  ReportSubscriptionDueHandler,
  ReportSubscriptionRecord,
} from '../../../../src/db/repositories/agency.repository.js';
import { ACCOUNT, RUN, SUBSCRIPTION, TENANT, runRecord, subscriptionRecord } from './run-fixture.js';

const NOW = new Date('2026-11-08T09:30:00Z');
const RUN_B = '99999999-9999-4999-8999-999999999999';
const scope = { tenantId: TENANT, accountId: ACCOUNT, runId: RUN };
const client = {} as PoolClient;

function deps(over: Partial<ReportTickDeps> = {}) {
  const d = {
    runs: {
      createForSubscription: vi.fn(async (input: ReportRunSubscriptionInput, _db?: unknown): Promise<ReturnType<typeof runRecord> | null> => runRecord({ subscription_id: input.subscriptionId })),
      findAssembledUnsent: vi.fn(async () => [] as ReturnType<typeof runRecord>[]),
      findRenderingSentBefore: vi.fn(async () => [] as ReturnType<typeof runRecord>[]),
      markSent: vi.fn(async (_id: string, fence: ReportRunFence): Promise<number | null> => ('renderAttempt' in fence ? fence.renderAttempt : 0) + 1),
      markFailed: vi.fn(async (id: string, ..._rest: unknown[]) => runRecord({ id, status: 'failed' })),
      findFinishedUnnotified: vi.fn(async () => [] as ReturnType<typeof runRecord>[]),
      markNotified: vi.fn(async (_id: string) => true),
      expireDue: vi.fn(async (_now: Date) => 0),
      pendingStats: vi.fn(async () => ({ queued: 0, assembling: 0, rendering: 0, oldestCreatedAt: null as Date | null })),
    },
    subscriptions: {
      claimDue: vi.fn(async (_now: Date, _limit: number, _handler: ReportSubscriptionDueHandler): Promise<never[]> => []),
    },
    dispatcher: { dispatch: vi.fn(async () => {}), idle: vi.fn(async () => {}) },
    headObject: vi.fn(async (_key: string) => null as { bytes: number } | null),
    apply: vi.fn(async () => ({ result: 'applied' as const, run: runRecord({ status: 'ready' }) })),
    notify: vi.fn(async (_run: ReturnType<typeof runRecord>) => {}),
    now: () => NOW,
  };
  return Object.assign(d, over) as typeof d;
}

const opts = { intervalMs: 60_000, renderTimeoutMs: 900_000, maxAttempts: 3 };

/** Run the tick's subscription step for one subscription; the handler's decision and the run input. */
async function dueOnce(sub: ReportSubscriptionRecord, d = deps()) {
  let decision: unknown;
  d.subscriptions.claimDue.mockImplementation(async (_now, _limit, handler) => {
    decision = await handler(sub, client);
    return [{ subscriptionId: sub.id, outcome: 'advanced', nextRunAt: (decision as { nextRunAt: Date }).nextRunAt }] as never[];
  });
  const result = await createReportTick(opts, d).runTick();
  return { decision: decision as { nextRunAt: Date }, input: d.runs.createForSubscription.mock.calls[0]?.[0], result, d };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('subscriptions → runs', () => {
  it('a daily subscription due now covers the previous local day, joins the claim\'s transaction and advances a day', async () => {
    const sub = subscriptionRecord({ next_run_at: new Date('2026-11-08T08:00:00Z') });
    const { decision, input, result, d } = await dueOnce(sub);
    expect(input).toMatchObject({
      subscriptionId: SUBSCRIPTION, periodStart: '2026-11-07', localFrom: '2026-11-07', localTo: '2026-11-07',
      timezone: 'Europe/London', tenantId: TENANT, accountId: ACCOUNT, kind: 'campaign', formats: ['pdf'],
      rangeFrom: new Date('2026-11-07T00:00:00Z'), rangeTo: new Date('2026-11-08T00:00:00Z'),
    });
    expect(d.runs.createForSubscription.mock.calls[0]![1]).toBe(client);
    expect(decision.nextRunAt).toEqual(new Date('2026-11-09T08:00:00Z'));
    expect(decision.nextRunAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(result.subscriptions.created).toBe(1);
    expect(metrics.subs).toHaveBeenCalledWith({ result: 'created' });
  });

  it('after downtime sends only the most recent missed period, once', async () => {
    // Due five days ago; four sends were missed.
    const sub = subscriptionRecord({ next_run_at: new Date('2026-11-03T08:00:00Z') });
    const { input, decision, d } = await dueOnce(sub);
    expect(d.runs.createForSubscription).toHaveBeenCalledTimes(1);
    expect(input).toMatchObject({ periodStart: '2026-11-07', localTo: '2026-11-07' });
    expect(decision.nextRunAt).toEqual(new Date('2026-11-09T08:00:00Z'));
  });

  it('weekly and monthly periods: the seven days ending yesterday, the previous calendar month', async () => {
    // Sunday 2026-11-08 is ISO weekday 7.
    const weekly = subscriptionRecord({ cadence: 'weekly', send_weekday: 7, next_run_at: new Date('2026-11-08T08:00:00Z') });
    expect((await dueOnce(weekly)).input).toMatchObject({ localFrom: '2026-11-01', localTo: '2026-11-07' });
    const monthly = subscriptionRecord({ cadence: 'monthly', send_monthday: 1, next_run_at: new Date('2026-11-01T08:00:00Z') });
    const { input, decision } = await dueOnce(monthly);
    expect(input).toMatchObject({ localFrom: '2026-10-01', localTo: '2026-10-31' });
    expect(decision.nextRunAt).toEqual(new Date('2026-12-01T08:00:00Z'));
  });

  it('a period that already has its run is a duplicate: counted, still advanced', async () => {
    const d = deps();
    d.runs.createForSubscription.mockResolvedValue(null as never);
    const { decision, result } = await dueOnce(subscriptionRecord({ next_run_at: new Date('2026-11-08T08:00:00Z') }), d);
    expect(result.subscriptions).toMatchObject({ created: 0, duplicate: 1 });
    expect(metrics.subs).toHaveBeenCalledWith({ result: 'duplicate' });
    expect(decision.nextRunAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('counts a subscription whose handler failed and carries on', async () => {
    const d = deps();
    d.subscriptions.claimDue.mockResolvedValue([
      { subscriptionId: SUBSCRIPTION, outcome: 'error', error: new Error('boom') },
      { subscriptionId: RUN_B, outcome: 'advanced', nextRunAt: new Date() },
    ] as never);
    const result = await createReportTick(opts, d).runTick();
    expect(result.subscriptions.errors).toBe(1);
    expect(d.runs.expireDue).toHaveBeenCalled();
  });

  it('dueSendAt: the due time, or the latest missed send when that is later', () => {
    expect(dueSendAt(subscriptionRecord({ next_run_at: new Date('2026-11-08T08:00:00Z') }), NOW)).toEqual(new Date('2026-11-08T08:00:00Z'));
    expect(dueSendAt(subscriptionRecord({ next_run_at: new Date('2026-10-01T08:00:00Z') }), NOW)).toEqual(new Date('2026-11-08T08:00:00Z'));
  });
});

describe('reconcile', () => {
  it('sends a run whose dataset was recorded but never sent, fenced on the attempt it read', async () => {
    const d = deps();
    const run = runRecord({ status: 'assembling', dataset_key: 'k', render_attempt: 0 });
    d.runs.findAssembledUnsent.mockResolvedValue([run]);
    const result = await createReportTick(opts, d).runTick();
    expect(d.runs.markSent).toHaveBeenCalledWith(RUN, { renderAttempt: 0 });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(run, 1);
    expect(result.resent).toBe(1);
  });

  it('sends nothing when the fence refuses (another pass sent it)', async () => {
    const d = deps();
    d.runs.findAssembledUnsent.mockResolvedValue([runRecord({ dataset_key: 'k' })]);
    d.runs.markSent.mockResolvedValue(null as never);
    await createReportTick(opts, d).runTick();
    expect(d.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('looks for timed-out runs sent before now minus the render timeout', async () => {
    const d = deps();
    await createReportTick(opts, d).runTick();
    expect(d.runs.findRenderingSentBefore).toHaveBeenCalledWith(new Date(NOW.getTime() - 900_000), 50);
  });

  it('a timed-out run whose every file is in S3 is applied as rendered through the shared path', async () => {
    const d = deps();
    d.runs.findRenderingSentBefore.mockResolvedValue([runRecord({ status: 'rendering', render_attempt: 2 })]);
    d.headObject.mockImplementation(async (key: string) => ({ bytes: key.endsWith('.pdf') ? 10 : 20 }));
    const result = await createReportTick(opts, d).runTick();
    expect(d.apply).toHaveBeenCalledWith(RUN, 2, {
      run_id: RUN, attempt: 2, status: 'rendered', error: null, renderer_version: 'reconciled',
      files: [
        { format: 'pdf', key: reportOutputKey(scope, 'pdf'), bytes: 10 },
        { format: 'xlsx', key: reportOutputKey(scope, 'xlsx'), bytes: 20 },
      ],
    });
    expect(d.runs.markSent).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(1);
  });

  it('a timed-out run missing a file is re-sent while attempts remain', async () => {
    const d = deps();
    const run = runRecord({ status: 'rendering', render_attempt: 2 });
    d.runs.findRenderingSentBefore.mockResolvedValue([run]);
    d.headObject.mockImplementation(async (key: string) => (key.endsWith('.pdf') ? { bytes: 1 } : null));
    await createReportTick(opts, d).runTick();
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.runs.markSent).toHaveBeenCalledWith(RUN, { renderAttempt: 2 });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(run, 3);
  });

  it('at the last attempt it fails render_timed_out, fenced on that attempt, and counts it', async () => {
    const d = deps();
    d.runs.findRenderingSentBefore.mockResolvedValue([runRecord({ status: 'rendering', render_attempt: 3 })]);
    const result = await createReportTick(opts, d).runTick();
    expect(d.runs.markFailed).toHaveBeenCalledWith(RUN, 'render_timed_out', expect.any(String), { renderAttempt: 3 });
    expect(d.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(result.timedOut).toBe(1);
    expect(metrics.runs).toHaveBeenCalledWith({ kind: 'agent', status: 'failed' });
  });

  it('one run that throws does not stop the others', async () => {
    const d = deps();
    d.runs.findRenderingSentBefore.mockResolvedValue([
      runRecord({ id: RUN, status: 'rendering', render_attempt: 1 }),
      runRecord({ id: RUN_B, status: 'rendering', render_attempt: 1 }),
    ]);
    d.headObject.mockImplementation(async (key: string) => {
      if (key.includes(RUN)) throw new Error('S3 500');
      return null;
    });
    const result = await createReportTick(opts, d).runTick();
    expect(result.errors).toBe(1);
    expect(d.runs.markSent).toHaveBeenCalledWith(RUN_B, { renderAttempt: 1 });
  });
});

describe('notify, expire, gauges', () => {
  it('only the tick that marked a run notified sends its email', async () => {
    const d = deps();
    d.runs.findFinishedUnnotified.mockResolvedValue([runRecord({ id: RUN, status: 'ready' }), runRecord({ id: RUN_B, status: 'ready' })]);
    d.runs.markNotified.mockImplementation(async (id: string) => id === RUN);
    const result = await createReportTick(opts, d).runTick();
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ id: RUN }));
    expect(result.notified).toBe(1);
  });

  it('an email that throws is isolated', async () => {
    const d = deps();
    d.runs.findFinishedUnnotified.mockResolvedValue([runRecord({ id: RUN }), runRecord({ id: RUN_B })]);
    d.notify.mockRejectedValueOnce(new Error('mail down'));
    const result = await createReportTick(opts, d).runTick();
    expect(d.notify).toHaveBeenCalledTimes(2);
    expect(result.errors).toBe(1);
  });

  it('expires ready runs at now and sets the pending gauges', async () => {
    const d = deps();
    d.runs.expireDue.mockResolvedValue(4);
    d.runs.pendingStats.mockResolvedValue({ queued: 2, assembling: 1, rendering: 3, oldestCreatedAt: new Date(NOW.getTime() - 120_000) });
    const result = await createReportTick(opts, d).runTick();
    expect(d.runs.expireDue).toHaveBeenCalledWith(NOW);
    expect(result.expired).toBe(4);
    expect(metrics.pending).toHaveBeenCalledWith({ status: 'queued' }, 2);
    expect(metrics.pending).toHaveBeenCalledWith({ status: 'assembling' }, 1);
    expect(metrics.pending).toHaveBeenCalledWith({ status: 'rendering' }, 3);
    expect(metrics.oldest).toHaveBeenCalledWith(120);
  });

  it('a step that throws does not stop the steps after it', async () => {
    const d = deps();
    d.subscriptions.claimDue.mockRejectedValue(new Error('db down'));
    d.runs.findFinishedUnnotified.mockRejectedValue(new Error('db down'));
    const result = await createReportTick(opts, d).runTick();
    expect(result.errors).toBe(2);
    expect(d.runs.expireDue).toHaveBeenCalled();
    expect(d.runs.pendingStats).toHaveBeenCalled();
  });
});
