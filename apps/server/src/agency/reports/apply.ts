/**
 * The ONE path from a render result to a run (RP13): the signed webhook, the inline renderer and
 * the tick's reconcile (files found in S3 after a lost callback) all call
 * {@link applyRenderOutcome}, so the fence, the key check and the terminal metrics live in one
 * place.
 *
 *  1. The callback must name this run and this attempt.
 *  2. Every file key must be exactly the run's output key for its format (`isReportOutputKey`):
 *     a callback, even a correctly signed one, cannot point a run at another run's or another
 *     tenant's object. A `rendered` callback must carry one file per requested format.
 *  3. `applyRenderResult` writes it only while the run is `rendering` under that attempt; a late
 *     callback of a superseded send is `stale` (acknowledged, ignored).
 *  4. A `failed` result stores its code's generic copy (`failure-messages.ts`); the renderer's
 *     own message is logged with the run id and attempt, never stored or served.
 */
import { createChildLogger } from '@magick-agency/observability';
import {
  agencyReportsRenderSeconds,
  agencyReportsRunsTotal,
} from '@magick-agency/observability/metrics/agency';
import type { ReportFormat, ReportRendererFailureCode } from '@magick-agency/contracts/api/agency/reports';
import type { ReportRenderCallback } from '@magick-agency/contracts/reports';
import {
  reportRunRepository,
  type ReportRunRecord,
  type ReportRunRepository,
} from '../../db/repositories/agency.repository.js';
import { isReportOutputKey } from './report-keys.js';
import { REPORT_FAILURE_MESSAGES } from './failure-messages.js';

const log = createChildLogger({ component: 'agency-reports' });

export type RenderOutcomeResult =
  | { result: 'applied'; run: ReportRunRecord }
  | { result: 'stale' }
  /** The callback contradicts the run (wrong run or attempt, a foreign key, a missing format). Nothing written. */
  | { result: 'invalid'; reason: string };

export interface ApplyRenderOutcomeDeps {
  repo: Pick<ReportRunRepository, 'findByIdAnyTenant' | 'applyRenderResult'>;
  /** `AGENCY_REPORTS_RETENTION_DAYS`. */
  retentionDays: number;
  now?: () => Date;
}

/** Record a run that reached `ready` or `failed`: `agency_reports_runs_total`. */
export function countTerminalRun(run: Pick<ReportRunRecord, 'kind' | 'status'>): void {
  if (run.status === 'ready' || run.status === 'failed') {
    agencyReportsRunsTotal.inc({ kind: run.kind, status: run.status });
  }
}

const RENDERER_CODES = new Set<string>(['dataset_unreadable', 'dataset_version_unsupported', 'render_failed', 'upload_failed']);

export async function applyRenderOutcome(
  runId: string,
  attempt: number,
  callback: ReportRenderCallback,
  deps: ApplyRenderOutcomeDeps,
): Promise<RenderOutcomeResult> {
  if (callback.run_id !== runId || callback.attempt !== attempt) {
    return { result: 'invalid', reason: 'callback names another run or attempt' };
  }
  const run = await deps.repo.findByIdAnyTenant(runId);
  // A run that no longer exists has nothing to apply to: acknowledge, as for a superseded attempt.
  if (!run) return { result: 'stale' };

  const scope = { tenantId: run.tenant_id, accountId: run.account_id, runId: run.id };
  const seen = new Set<ReportFormat>();
  for (const file of callback.files) {
    if (!run.formats.includes(file.format) || seen.has(file.format) || !isReportOutputKey(scope, file.format, file.key)) {
      log.warn({ runId, attempt, format: file.format }, 'Report render result refused: a file key is not this run\'s output key');
      return { result: 'invalid', reason: 'file key is not the run\'s output key' };
    }
    if (!Number.isInteger(file.bytes) || file.bytes < 0) return { result: 'invalid', reason: 'file bytes is not a count' };
    seen.add(file.format);
  }

  let applied;
  if (callback.status === 'rendered') {
    if (run.formats.some((f) => !seen.has(f))) {
      return { result: 'invalid', reason: 'a rendered callback must carry every requested format' };
    }
    applied = await deps.repo.applyRenderResult(runId, attempt, {
      status: 'rendered',
      files: callback.files.map((f) => ({ format: f.format, key: f.key, bytes: f.bytes })),
      rendererVersion: callback.renderer_version,
      retentionDays: deps.retentionDays,
    });
  } else {
    const code = (callback.error && RENDERER_CODES.has(callback.error.code) ? callback.error.code : 'render_failed') as ReportRendererFailureCode;
    // The renderer's own text (an exception message, a key, a path) is logged, never stored or
    // served: the run keeps the code's generic copy (`failure-messages.ts`).
    log.warn({
      runId, attempt, code, rendererCode: callback.error?.code ?? null,
      rendererMessage: callback.error?.message?.slice(0, 2000) ?? null, rendererVersion: callback.renderer_version,
    }, 'Report renderer reported a failure');
    applied = await deps.repo.applyRenderResult(runId, attempt, {
      status: 'failed',
      error: { code, message: REPORT_FAILURE_MESSAGES[code] },
      rendererVersion: callback.renderer_version,
    });
  }
  if (applied.result === 'stale') return { result: 'stale' };

  countTerminalRun(applied.run);
  if (run.sent_at) {
    const seconds = ((deps.now?.() ?? new Date()).getTime() - new Date(run.sent_at).getTime()) / 1000;
    if (seconds >= 0) agencyReportsRenderSeconds.observe({ kind: run.kind }, seconds);
  }
  log.info({ runId, attempt, status: applied.run.status, kind: run.kind }, 'Report render result applied');
  return { result: 'applied', run: applied.run };
}

/** {@link applyRenderOutcome} on the real repository. */
export function defaultApplyDeps(retentionDays: number): ApplyRenderOutcomeDeps {
  return { repo: reportRunRepository, retentionDays };
}
