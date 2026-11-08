/**
 * The report pipeline's background work, assembled from config: the render dispatcher
 * (`./dispatch.ts`), the assembler (`./assembler.ts`) and the reports tick (`./tick.ts`).
 * Started by `startAgency` (`bootstrap/agency.ts`) in the main process only, whatever the
 * `agency_reports_enabled` flag says (the flag gates requests; with it off nothing is queued and
 * both loops find nothing to do). Stopped assembler first (its run in flight records or is
 * reclaimed later), then the tick, then the inline renderer's queue is drained.
 */
import { createChildLogger } from '@magick-agency/observability';
import type { AppConfig } from '../../config/index.js';
import { headFile } from '../../storage/s3.js';
import { sendAgencyReportReadyEmails } from '../../notifications/agency-report-ready.js';
import { applyRenderOutcome, defaultApplyDeps } from './apply.js';
import {
  createInlineDispatcher,
  createSqsDispatcher,
  sqsSender,
  type ReportRenderDispatcher,
  type ReportRendererLoader,
} from './dispatch.js';
import { defaultAssemblerDeps, startReportAssembler, type ReportAssembler } from './assembler.js';
import { defaultTickRepos, startReportTick, type ReportTick } from './tick.js';

const log = createChildLogger({ component: 'agency-reports' });

type ReportsConfig = AppConfig['agency']['reports'];

/** The render dispatcher the config names. */
export function createReportDispatcher(
  config: Pick<AppConfig, 's3'> & { agency: { reports: ReportsConfig } },
  opts: { loader?: ReportRendererLoader } = {},
): ReportRenderDispatcher {
  const reports = config.agency.reports;
  const bucket = config.s3?.audioBucket ?? '';
  const apply = defaultApplyDeps(reports.retentionDays);
  if (reports.renderer === 'sqs') {
    return createSqsDispatcher({
      queueUrl: reports.sqsQueueUrl!,
      bucket,
      callbackBaseUrl: reports.callbackBaseUrl!,
      sender: sqsSender({
        region: config.s3?.region ?? process.env['AWS_REGION'],
        ...(config.s3 ? { credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } } : {}),
      }),
    });
  }
  return createInlineDispatcher({
    bucket,
    ...(reports.chromePath ? { chromePath: reports.chromePath } : {}),
    apply: (runId, attempt, callback) => applyRenderOutcome(runId, attempt, callback, apply),
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
  stop(): Promise<void>;
}

export function startReportPipeline(
  config: Pick<AppConfig, 's3'> & { agency: { reports: ReportsConfig } },
  opts: { loader?: ReportRendererLoader; nodeEnv?: string } = {},
): ReportPipeline {
  const reports = config.agency.reports;
  if (reports.renderer === 'inline' && (opts.nodeEnv ?? process.env['NODE_ENV']) === 'production') {
    log.warn(
      'AGENCY_REPORTS_RENDERER=inline in production: reports render in this process, which needs the renderer '
        + 'package and Chromium (the production image has neither). Set AGENCY_REPORTS_RENDERER=sqs.',
    );
  }
  if (!config.s3) {
    log.warn('No S3 bucket configured (S3_AUDIO_BUCKET): report runs will fail to assemble');
  }
  const dispatcher = createReportDispatcher(config, opts);
  const assembler = startReportAssembler(
    { intervalMs: reports.assemblerIntervalMs, maxDetailRows: reports.maxDetailRows, maxAttempts: reports.maxAttempts },
    defaultAssemblerDeps(dispatcher),
  );
  const applyDeps = defaultApplyDeps(reports.retentionDays);
  const tick = startReportTick(
    { intervalMs: reports.tickIntervalMs, renderTimeoutMs: reports.renderTimeoutMs, maxAttempts: reports.maxAttempts },
    {
      ...defaultTickRepos,
      dispatcher,
      headObject: headReportObject,
      apply: (runId, attempt, callback) => applyRenderOutcome(runId, attempt, callback, applyDeps),
      notify: (run) => sendAgencyReportReadyEmails(run, { retentionDays: reports.retentionDays }),
      now: () => new Date(),
    },
  );
  return {
    dispatcher,
    assembler,
    tick,
    async stop() {
      await assembler.stop();
      await tick.stop();
      await dispatcher.idle();
    },
  };
}
