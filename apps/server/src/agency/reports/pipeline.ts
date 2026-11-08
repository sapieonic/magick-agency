/**
 * The report pipeline's background work, assembled from config: the render dispatcher
 * (`./dispatch.ts`), the assembler (`./assembler.ts`) and the reports tick (`./tick.ts`).
 * Started by `startAgency` (`bootstrap/agency.ts`) in the main process only, whatever the
 * `agency_reports_enabled` flag says: the flag gates the routes, and the tick reads it per tenant
 * and account before a subscription's run and before an email (`tick.ts`); a run already queued
 * when the flag goes off still finishes, its files hidden behind the gated download.
 *
 * Stopped within ONE budget, `REPORT_PIPELINE_STOP_WAIT_MS` (20 s) from the call, never more: the
 * assembler and the tick stop together (both stop starting work at once; the assembler's run in
 * flight records or is reclaimed by the next boot, the tick's item in hand finishes and the rest
 * waits for the restart), then the inline renderer's queue is waited for in what is left of the
 * budget (a render cut off stays `rendering` and the tick's reconcile re-sends it). On shutdown it
 * runs beside the completion-notice drain (≤ 30 s), so the 20 s overlaps it inside the container's
 * 45 s grace: among the plan's concurrent drains with media workers (`index.ts`), beside the
 * runtime's stop in one process (`bootstrap/agency.ts`). Idempotent: the same promise each call.
 */
import { createChildLogger } from '@magick-agency/observability';
import type { ReportRenderCallback } from '@magick-agency/contracts/reports';
import type { AppConfig } from '../../config/index.js';
import { headFile } from '../../storage/s3.js';
import { sendAgencyReportReadyEmails } from '../../notifications/agency-report-ready.js';
import { applyRenderOutcome, defaultApplyDeps, type RenderOutcomeResult } from './apply.js';
import {
  checkInlineRenderer,
  createInlineDispatcher,
  createSqsDispatcher,
  sqsSender,
  type ReportRenderDispatcher,
  type ReportRendererLoader,
} from './dispatch.js';
import { defaultAssemblerDeps, startReportAssembler, type ReportAssembler } from './assembler.js';
import { defaultTickRepos, startReportTick, type ReportTick } from './tick.js';
import { probeSubscriptionSubject } from './subscription-subject.js';
import { FLAGS, getFeatureFlagService } from '../../feature-flags/index.js';
import { withTimeout } from '../../utils/with-timeout.js';

const log = createChildLogger({ component: 'agency-reports' });

type ReportsConfig = AppConfig['agency']['reports'];

/** The whole of `ReportPipeline.stop()`'s waiting: the assembler, the tick and the inline queue together. */
export const REPORT_PIPELINE_STOP_WAIT_MS = 20_000;

/** `applyRenderOutcome` on the real repository, bound to the config's retention. */
type ReportApply = (runId: string, attempt: number, callback: ReportRenderCallback) => Promise<RenderOutcomeResult>;

function reportApply(reports: ReportsConfig): ReportApply {
  const deps = defaultApplyDeps(reports.retentionDays);
  return (runId, attempt, callback) => applyRenderOutcome(runId, attempt, callback, deps);
}

/** The render dispatcher the config names; the inline one applies results through `opts.apply` (default: {@link reportApply}). */
export function createReportDispatcher(
  config: Pick<AppConfig, 's3'> & { agency: { reports: ReportsConfig } },
  opts: { loader?: ReportRendererLoader; apply?: ReportApply } = {},
): ReportRenderDispatcher {
  const reports = config.agency.reports;
  const bucket = config.s3?.audioBucket ?? '';
  if (reports.renderer === 'sqs') {
    return createSqsDispatcher({
      queueUrl: reports.sqsQueueUrl!,
      bucket,
      callbackBaseUrl: reports.callbackBaseUrl!,
      renderTimeoutMs: reports.renderTimeoutMs,
      sender: sqsSender({
        region: config.s3?.region ?? process.env['AWS_REGION'],
        ...(config.s3 ? { credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } } : {}),
      }),
    });
  }
  return createInlineDispatcher({
    bucket,
    ...(reports.chromePath ? { chromePath: reports.chromePath } : {}),
    apply: opts.apply ?? reportApply(reports),
    ...(opts.loader ? { loader: opts.loader } : {}),
  });
}

/** HEAD an object: its size, or null when it does not exist (S3 404). Other errors throw. */
export async function headReportObject(key: string): Promise<{ bytes: number } | null> {
  try {
    const head = await headFile(key);
    return { bytes: head.contentLength ?? 0 };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export interface ReportPipeline {
  dispatcher: ReportRenderDispatcher;
  assembler: ReportAssembler;
  tick: ReportTick;
  /** Stop everything within `stopWaitMs` (module header). Idempotent. */
  stop(): Promise<void>;
}

export function startReportPipeline(
  config: Pick<AppConfig, 's3'> & { agency: { reports: ReportsConfig } },
  opts: { loader?: ReportRendererLoader; nodeEnv?: string; stopWaitMs?: number } = {},
): ReportPipeline {
  const reports = config.agency.reports;
  const stopWaitMs = opts.stopWaitMs ?? REPORT_PIPELINE_STOP_WAIT_MS;
  if (reports.renderer === 'inline' && (opts.nodeEnv ?? process.env['NODE_ENV']) === 'production') {
    log.warn(
      'AGENCY_REPORTS_RENDERER=inline in production: reports render in this process, which needs the renderer '
        + 'package and Chromium (the production image has neither). Set AGENCY_REPORTS_RENDERER=sqs.',
    );
  }
  if (!config.s3) {
    log.warn('No S3 bucket configured (S3_AUDIO_BUCKET): report runs will fail to assemble');
  }
  // One apply path for the inline renderer and the tick's reconcile.
  const apply = reportApply(reports);
  const dispatcher = createReportDispatcher(config, { ...opts, apply });
  if (reports.renderer === 'inline') void checkInlineRenderer(opts.loader);
  const assembler = startReportAssembler(
    { intervalMs: reports.assemblerIntervalMs, maxDetailRows: reports.maxDetailRows, maxAttempts: reports.maxAttempts, stopWaitMs },
    defaultAssemblerDeps(dispatcher),
  );
  const tick = startReportTick(
    { intervalMs: reports.tickIntervalMs, renderTimeoutMs: reports.renderTimeoutMs, maxAttempts: reports.maxAttempts, stopWaitMs },
    {
      ...defaultTickRepos,
      dispatcher,
      reportsEnabled: ({ tenantId, accountId }) => getFeatureFlagService().isEnabled(FLAGS.agency_reports_enabled, {
        tenantId,
        ...(accountId ? { accountId } : {}),
      }),
      subject: probeSubscriptionSubject,
      headObject: headReportObject,
      apply,
      notify: (run) => sendAgencyReportReadyEmails(run, { retentionDays: reports.retentionDays }),
      now: () => new Date(),
    },
  );
  const stopAll = async (): Promise<void> => {
    const deadline = Date.now() + stopWaitMs;
    const left = (): number => Math.max(0, deadline - Date.now());
    // Together, each bounded by the budget: the assembler by its `stopWaitMs`, the tick by `left()`.
    await Promise.all([assembler.stop(), tick.stop(left())]);
    // Last, so neither loop can queue a render after it: the inline queue (a no-op under `sqs`).
    await withTimeout(dispatcher.idle(), left(), 'inline report renders').catch((err: unknown) => {
      log.warn({ err, stopWaitMs }, 'Report pipeline stopped with inline renders unfinished; the tick re-sends them after the restart');
    });
    log.info('Report pipeline stopped');
  };
  let stopped: Promise<void> | null = null;
  return {
    dispatcher,
    assembler,
    tick,
    stop: () => (stopped ??= stopAll()),
  };
}
