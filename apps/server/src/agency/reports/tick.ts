/**
 * The reports tick (docs/reports.md "Shape", RP8, RP13, RP14): every `tickIntervalMs`, main
 * process only (started by `startAgency`), never overlapping itself:
 *
 *  (a) **subscriptions → runs** through `claimDue`: each due subscription in its own transaction.
 *      With `agency_reports_enabled` off for its tenant and account the period is skipped: no
 *      run, the schedule advances, and turning the flag back on resumes it (the `flag_off`
 *      metric). Its subject is probed next (`subscription-subject.ts`): one that is gone disables
 *      the subscription (no run, no failure email every period). A campaign subscription takes
 *      the campaign's CURRENT zone as the builder and the Insights reads take it (`campaignZone`,
 *      RP3), stored back on the subscription when it changed. A zone Postgres does not know is
 *      not caught here: the run fails `assembly_failed` each period, as the campaign's own
 *      Insights tab fails, and the failure email says so;
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
 *      tick that marked it sends (at most once); with the flag off for the run's tenant and
 *      account it is marked and not sent (its link would land on a page the flag hides);
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
import { campaignZone } from '../insights/range.js';
import { countTerminalRun, type RenderOutcomeResult } from './apply.js';

const log = createChildLogger({ component: 'agency-reports-tick' });

/** Items each step handles per tick; the rest wait for the next. */
export const REPORT_TICK_BATCH = 50;
/** A run assembled but unsent for this long is the tick's to send (the assembler normally sends within ms). */
export const REPORT_UNSENT_GRACE_MS = 5 * 60_000;
/** The renderer version recorded on a run the tick found finished in S3 after a lost callback. */
export const RECONCILED_RENDERER_VERSION = 'reconciled';

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
  /** Is `agency_reports_enabled` on for this tenant and account? */
  reportsEnabled(scope: { tenantId: string; accountId: string | null }): Promise<boolean>;
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
  subscriptions: { created: number; duplicate: number; disabled: number; flagOff: number; errors: number };
  resent: number;
  reconciled: number;
  timedOut: number;
  notified: number;
  /** Finished runs marked notified without an email: the flag was off for their account. */
  notifySkipped: number;
  expired: number;
  errors: number;
}

/** What a due subscription's handler decided; counted only after its transaction commits. */
type SubscriptionDecided =
  | { result: 'created' | 'duplicate' | 'flag_off' }
  | { result: 'disabled'; kind: ReportSubscriptionRecord['kind']; reason: string };

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
    // What each handler decided, counted and logged only once `claimDue` reports its transaction
    // committed (`advanced` or `disabled`): the handler runs BEFORE the advance UPDATE and the
    // commit, and a failure in either rolls the run back, so counting inside it would count a run
    // that never existed, again on the retry next tick.
    const decided = new Map<string, SubscriptionDecided>();
    const handler = async (claimed: ReportSubscriptionRecord, client: PoolClient): Promise<ReportSubscriptionDueDecision> => {
      // Reports turned off for the account: skip this period without disabling, so turning the
      // flag back on resumes the schedule (from its next send, not a catch-up of the gap).
      if (!(await deps.reportsEnabled({ tenantId: claimed.tenant_id, accountId: claimed.account_id }))) {
        decided.set(claimed.id, { result: 'flag_off' });
        return { nextRunAt: nextRunAt(claimed, now) };
      }
      // Then the subject: one that is gone would only produce a run failing
      // `subject_unavailable` (and a failure email) every period, so the subscription stops.
      const subject = await deps.subject(claimed);
      if (!subject.available) {
        decided.set(claimed.id, { result: 'disabled', kind: claimed.kind, reason: subject.reason });
        return { disable: true };
      }
      // A campaign subscription follows the campaign's CURRENT zone (RP3): the period, its bounds
      // and the next send are cut in it, and the stored zone follows it. `campaignZone` is the
      // builder's and the Insights reads' own rule (an unset or unusable zone is UTC), so the
      // run's zone is the one the builder expects and never fails it as a changed zone.
      let sub = claimed;
      if (claimed.kind === 'campaign') {
        const zone = campaignZone(subject.timezone);
        if (zone !== claimed.timezone) sub = { ...claimed, timezone: zone };
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
      decided.set(claimed.id, { result: run ? 'created' : 'duplicate' });
      return {
        nextRunAt: nextRunAt(sub, now),
        ...(sub.timezone !== claimed.timezone ? { timezone: sub.timezone } : {}),
      };
    };
    const outcomes = await deps.subscriptions.claimDue(now, batch, handler);
    for (const outcome of outcomes) {
      if (outcome.outcome === 'error') {
        // Rolled back, whatever the handler decided: nothing to count but the error.
        result.subscriptions.errors += 1;
        log.error({ subscriptionId: outcome.subscriptionId, err: outcome.error }, 'Report subscription could not produce its run');
        continue;
      }
      const d = decided.get(outcome.subscriptionId);
      if (!d) continue;
      if (d.result === 'disabled') {
        result.subscriptions.disabled += 1;
        log.warn({ subscriptionId: outcome.subscriptionId, kind: d.kind, reason: d.reason }, 'Report subscription disabled: its subject is gone');
        continue;
      }
      if (d.result === 'flag_off') result.subscriptions.flagOff += 1;
      else result.subscriptions[d.result] += 1;
      agencyReportsSubscriptionRunsTotal.inc({ result: d.result });
    }
  };

  /**
   * Send `run` again under the attempt it was read at (`markSent`'s fence, so two passes that read
   * the same row send it once), counted in `resent`; `warning` is logged before the dispatch.
   */
  const resend = async (run: ReportRunRecord, result: ReportTickResult, warning?: string): Promise<void> => {
    const attempt = await deps.runs.markSent(run.id, { renderAttempt: run.render_attempt });
    if (attempt === null) return;
    result.resent += 1;
    if (warning) log.warn({ runId: run.id, attempt }, warning);
    await deps.dispatcher.dispatch(run, attempt);
  };

  const resendUnsent = async (now: Date, result: ReportTickResult): Promise<void> => {
    const runs = await deps.runs.findAssembledUnsent(new Date(now.getTime() - unsentGraceMs), batch);
    for (const run of runs) {
      try {
        await resend(run, result);
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
      await resend(run, result, 'Report run had no callback in time; re-sent');
      return;
    }
    const failed = await deps.runs.markFailed(run.id, 'render_timed_out', { renderAttempt: run.render_attempt });
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
        // The flag is read before the mark, so a flag read that throws leaves the run to retry.
        const enabled = await deps.reportsEnabled({ tenantId: run.tenant_id, accountId: run.account_id });
        if (!(await deps.runs.markNotified(run.id))) continue;
        if (!enabled) {
          result.notifySkipped += 1;
          continue;
        }
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
      subscriptions: { created: 0, duplicate: 0, disabled: 0, flagOff: 0, errors: 0 },
      resent: 0, reconciled: 0, timedOut: 0, notified: 0, notifySkipped: 0, expired: 0, errors: 0,
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
