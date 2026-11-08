/**
 * The reports tick (docs/reports.md "Shape", RP8, RP13, RP14): every `tickIntervalMs`, main
 * process only (started by `startAgency`), never overlapping itself:
 *
 *  (a) **subscriptions → runs** through `claimDue`: each due subscription in its own transaction.
 *      Its subject is probed first (`subscription-subject.ts`): one that is gone disables the
 *      subscription (no run, no failure email every period). A campaign subscription takes the
 *      campaign's CURRENT zone (RP3), stored back on the subscription when it changed.
 *      Its run covers `periodFor(cadence, sendAt, zone)`, where `sendAt` is its due `next_run_at`,
 *      or, when more than one send was missed (downtime), the most recent missed send
 *      (`previousRunAt(now)`): catch-up sends only the latest period (RP14). The unique
 *      `(subscription, period_start)` index turns a repeat into `null` (the `duplicate` metric).
 *      The subscription then advances to `nextRunAt(now)`, strictly after now;
 *  (b) **reconcile** (RP13): a run whose dataset was recorded but never sent (the assembler died
 *      in between) is sent; a run `rendering` past `renderTimeoutMs` with no callback first has
 *      its expected output keys checked in S3: all present → applied as rendered (the lost
 *      callback's work was done) through `applyRenderOutcome`, the same fenced path as the
 *      webhook; else (a file missing, or the HEAD itself failing) re-sent while
 *      `render_attempt < maxAttempts`, else failed `render_timed_out`;
 *  (c) **notify**: each finished run that emails someone is marked notified first, and only the
 *      tick that marked it sends (at most once);
 *  (d) **expire** ready runs past `expires_at` (RP8);
 *  (e) the pending gauges.
 *
 * Every item is isolated: one bad run or subscription is logged and skipped, never stopping the
 * tick, and each step runs even when the one before it failed.
 */
import { createChildLogger } from '@magick-agency/observability';
import {
  agencyReportsOldestPendingSeconds,
  agencyReportsPendingRuns,
  agencyReportsSubscriptionRunsTotal,
} from '@magick-agency/observability/metrics/agency';
import type { ReportRenderCallback } from '@magick-agency/contracts/reports';
import {
  reportRunRepository,
  reportSubscriptionRepository,
  type ReportRunRecord,
  type ReportRunRepository,
  type ReportSubscriptionDueDecision,
  type ReportSubscriptionRecord,
  type ReportSubscriptionRepository,
} from '../../db/repositories/agency.repository.js';
import type { PoolClient } from 'pg';
import { localDayBounds, nextRunAt, periodFor, previousRunAt } from './schedule.js';
import { reportOutputKey } from './report-keys.js';
import type { ReportRenderDispatcher } from './dispatch.js';
import type { ReportSubscriptionSubject } from './subscription-subject.js';
import { isUsableTimezone } from '../calling-hours.js';
import { countTerminalRun, type RenderOutcomeResult } from './apply.js';

const log = createChildLogger({ component: 'agency-reports-tick' });

/** Items each step handles per tick; the rest wait for the next. */
export const REPORT_TICK_BATCH = 50;
/** A run assembled but unsent for this long is the tick's to send (the assembler normally sends within ms). */
export const REPORT_UNSENT_GRACE_MS = 5 * 60_000;
/** The renderer version recorded on a run the tick found finished in S3 after a lost callback. */
export const RECONCILED_RENDERER_VERSION = 'reconciled';
export const RENDER_TIMED_OUT_MESSAGE = 'The report files were not produced in time.';

export interface ReportTickOptions {
  intervalMs: number;
  renderTimeoutMs: number;
  maxAttempts: number;
  batch?: number;
  unsentGraceMs?: number;
}

export interface ReportTickDeps {
  runs: Pick<
    ReportRunRepository,
    | 'createForSubscription'
    | 'findAssembledUnsent'
    | 'findRenderingSentBefore'
    | 'markSent'
    | 'markFailed'
    | 'findFinishedUnnotified'
    | 'markNotified'
    | 'expireDue'
    | 'pendingStats'
  >;
  subscriptions: Pick<ReportSubscriptionRepository, 'claimDue'>;
  /** Is a due subscription's subject still there (and a campaign's current zone)? `probeSubscriptionSubject`. */
  subject(sub: ReportSubscriptionRecord): Promise<ReportSubscriptionSubject>;
  dispatcher: ReportRenderDispatcher;
  /** HEAD one object: its size, or null when it does not exist. Throws on any other error. */
  headObject(key: string): Promise<{ bytes: number } | null>;
  /** `applyRenderOutcome` bound to its deps. */
  apply(runId: string, attempt: number, callback: ReportRenderCallback): Promise<RenderOutcomeResult>;
  /** Send the run's emails (`sendAgencyReportReadyEmails`). */
  notify(run: ReportRunRecord): Promise<unknown>;
  now: () => Date;
}

export interface ReportTickResult {
  subscriptions: { created: number; duplicate: number; disabled: number; errors: number };
  resent: number;
  reconciled: number;
  timedOut: number;
  notified: number;
  expired: number;
  errors: number;
}

/** The send a due subscription's run is for: its due time, or the latest missed one (catch-up). */
export function dueSendAt(subscription: ReportSubscriptionRecord, now: Date): Date {
  const scheduled = subscription.next_run_at ? new Date(subscription.next_run_at) : now;
  const latest = previousRunAt(subscription, now);
  return latest.getTime() > scheduled.getTime() ? latest : scheduled;
}

export function createReportTick(options: ReportTickOptions, deps: ReportTickDeps) {
  const batch = options.batch ?? REPORT_TICK_BATCH;
  const unsentGraceMs = options.unsentGraceMs ?? REPORT_UNSENT_GRACE_MS;

  const subscriptionsStep = async (now: Date, result: ReportTickResult): Promise<void> => {
    const handler = async (claimed: ReportSubscriptionRecord, client: PoolClient): Promise<ReportSubscriptionDueDecision> => {
      // The subject first: one that is gone would only produce a run failing
      // `subject_unavailable` (and a failure email) every period, so the subscription stops.
      const subject = await deps.subject(claimed);
      if (!subject.available) {
        result.subscriptions.disabled += 1;
        log.warn({ subscriptionId: claimed.id, kind: claimed.kind, reason: subject.reason }, 'Report subscription disabled: its subject is gone');
        return { disable: true };
      }
      // A campaign subscription follows the campaign's CURRENT zone (RP3): the period, its bounds
      // and the next send are cut in it, and the stored zone follows it.
      let sub = claimed;
      if (subject.timezone !== null && subject.timezone !== claimed.timezone) {
        if (isUsableTimezone(subject.timezone)) {
          sub = { ...claimed, timezone: subject.timezone };
        } else {
          log.warn({ subscriptionId: claimed.id, timezone: subject.timezone }, 'Campaign zone not usable; the subscription keeps its stored zone');
        }
      }
      const sendAt = dueSendAt(sub, now);
      const period = periodFor(sub.cadence, sendAt, sub.timezone);
      const bounds = localDayBounds(period.from, period.to, sub.timezone);
      const run = await deps.runs.createForSubscription({
        tenantId: sub.tenant_id,
        accountId: sub.account_id,
        kind: sub.kind,
        subjectId: sub.subject_id,
        campaignIds: null,
        localFrom: period.from,
        localTo: period.to,
        timezone: sub.timezone,
        rangeFrom: bounds.start,
        rangeTo: bounds.end,
        formats: sub.formats,
        subscriptionId: sub.id,
        periodStart: period.from,
      }, client);
      if (run) {
        result.subscriptions.created += 1;
        agencyReportsSubscriptionRunsTotal.inc({ result: 'created' });
      } else {
        result.subscriptions.duplicate += 1;
        agencyReportsSubscriptionRunsTotal.inc({ result: 'duplicate' });
      }
      return {
        nextRunAt: nextRunAt(sub, now),
        ...(sub.timezone !== claimed.timezone ? { timezone: sub.timezone } : {}),
      };
    };
    const outcomes = await deps.subscriptions.claimDue(now, batch, handler);
    for (const outcome of outcomes) {
      if (outcome.outcome === 'error') {
        result.subscriptions.errors += 1;
        log.error({ subscriptionId: outcome.subscriptionId, err: outcome.error }, 'Report subscription could not produce its run');
      }
    }
  };

  const resendUnsent = async (now: Date, result: ReportTickResult): Promise<void> => {
    const runs = await deps.runs.findAssembledUnsent(new Date(now.getTime() - unsentGraceMs), batch);
    for (const run of runs) {
      try {
        const attempt = await deps.runs.markSent(run.id, { renderAttempt: run.render_attempt });
        if (attempt === null) continue;
        result.resent += 1;
        await deps.dispatcher.dispatch(run, attempt);
      } catch (err) {
        result.errors += 1;
        log.error({ runId: run.id, err }, 'Assembled report run could not be sent');
      }
    }
  };

  const reconcileRendering = async (run: ReportRunRecord, result: ReportTickResult): Promise<void> => {
    const scope = { tenantId: run.tenant_id, accountId: run.account_id, runId: run.id };
    const keys = run.formats.map((format) => ({ format, key: reportOutputKey(scope, format) }));
    // A HEAD that fails (S3 throttling, a permission, the network) is not proof the files are
    // there: the run falls through to the re-send / fail branch below, which the attempt fence
    // makes safe, instead of retrying the HEAD on every tick forever while the run stays
    // `rendering`.
    let heads: Array<{ bytes: number } | null>;
    try {
      heads = await Promise.all(keys.map((k) => deps.headObject(k.key)));
    } catch (err) {
      log.warn({ runId: run.id, attempt: run.render_attempt, err }, 'Report output HEAD failed; treating the files as missing');
      heads = keys.map(() => null);
    }
    if (heads.every((h) => h !== null)) {
      const outcome = await deps.apply(run.id, run.render_attempt, {
        run_id: run.id,
        attempt: run.render_attempt,
        status: 'rendered',
        files: keys.map((k, i) => ({ format: k.format, key: k.key, bytes: heads[i]!.bytes })),
        error: null,
        renderer_version: RECONCILED_RENDERER_VERSION,
      });
      if (outcome.result === 'applied') {
        result.reconciled += 1;
        log.info({ runId: run.id, attempt: run.render_attempt }, 'Report run found rendered in S3 after a lost callback');
      }
      return;
    }
    if (run.render_attempt < options.maxAttempts) {
      const attempt = await deps.runs.markSent(run.id, { renderAttempt: run.render_attempt });
      if (attempt === null) return;
      result.resent += 1;
      log.warn({ runId: run.id, attempt }, 'Report run had no callback in time; re-sent');
      await deps.dispatcher.dispatch(run, attempt);
      return;
    }
    const failed = await deps.runs.markFailed(run.id, 'render_timed_out', RENDER_TIMED_OUT_MESSAGE, {
      renderAttempt: run.render_attempt,
    });
    if (failed) {
      result.timedOut += 1;
      countTerminalRun(failed);
      log.error({ runId: run.id, attempts: run.render_attempt }, 'Report run failed: no callback after every attempt');
    }
  };

  const reconcileStep = async (now: Date, result: ReportTickResult): Promise<void> => {
    const runs = await deps.runs.findRenderingSentBefore(new Date(now.getTime() - options.renderTimeoutMs), batch);
    for (const run of runs) {
      try {
        await reconcileRendering(run, result);
      } catch (err) {
        result.errors += 1;
        log.error({ runId: run.id, err }, 'Report run could not be reconciled');
      }
    }
  };

  const notifyStep = async (result: ReportTickResult): Promise<void> => {
    const runs = await deps.runs.findFinishedUnnotified(batch);
    for (const run of runs) {
      try {
        if (!(await deps.runs.markNotified(run.id))) continue;
        result.notified += 1;
        await deps.notify(run);
      } catch (err) {
        result.errors += 1;
        log.error({ runId: run.id, err }, 'Report run notification failed');
      }
    }
  };

  const gaugesStep = async (now: Date): Promise<void> => {
    const stats = await deps.runs.pendingStats();
    agencyReportsPendingRuns.set({ status: 'queued' }, stats.queued);
    agencyReportsPendingRuns.set({ status: 'assembling' }, stats.assembling);
    agencyReportsPendingRuns.set({ status: 'rendering' }, stats.rendering);
    agencyReportsOldestPendingSeconds.set(
      stats.oldestCreatedAt ? Math.max(0, (now.getTime() - new Date(stats.oldestCreatedAt).getTime()) / 1000) : 0,
    );
  };

  /** One tick. Never throws. */
  const runTick = async (): Promise<ReportTickResult> => {
    const now = deps.now();
    const result: ReportTickResult = {
      subscriptions: { created: 0, duplicate: 0, disabled: 0, errors: 0 },
      resent: 0, reconciled: 0, timedOut: 0, notified: 0, expired: 0, errors: 0,
    };
    const step = async (name: string, work: () => Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (err) {
        result.errors += 1;
        log.error({ step: name, err }, 'Reports tick step failed');
      }
    };
    await step('subscriptions', () => subscriptionsStep(now, result));
    await step('unsent', () => resendUnsent(now, result));
    await step('reconcile', () => reconcileStep(now, result));
    await step('notify', () => notifyStep(result));
    await step('expire', async () => { result.expired = await deps.runs.expireDue(now); });
    await step('gauges', () => gaugesStep(now));
    return result;
  };

  return { runTick };
}

export interface ReportTick {
  /** One tick now. Null when one is already running. */
  runTick(): Promise<ReportTickResult | null>;
  stop(): Promise<void>;
}

/** Start the tick loop: one tick now, then every `intervalMs`. */
export function startReportTick(options: ReportTickOptions, deps: ReportTickDeps): ReportTick {
  const tick = createReportTick(options, deps);
  let stopping = false;
  let running: Promise<ReportTickResult> | null = null;
  const runTick = async (): Promise<ReportTickResult | null> => {
    if (running || stopping) return null;
    running = tick.runTick();
    try {
      return await running;
    } finally {
      running = null;
    }
  };
  const timer = setInterval(() => { void runTick(); }, options.intervalMs);
  timer.unref?.();
  void runTick();
  log.info({ intervalMs: options.intervalMs }, 'Reports tick started');
  return {
    runTick,
    async stop() {
      stopping = true;
      clearInterval(timer);
      if (running) await running.catch(() => undefined);
      log.info('Reports tick stopped');
    },
  };
}

/** The repositories the tick uses in production. */
export const defaultTickRepos = { runs: reportRunRepository, subscriptions: reportSubscriptionRepository };
