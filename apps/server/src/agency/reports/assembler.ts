/**
 * The report assembler (docs/reports.md "Shape", RP1, RP12): every `assemblerIntervalMs` a pass
 * claims queued runs one at a time, builds each run's dataset with its kind's builder
 * (`./datasets/`), writes it to S3, records it and sends the run to the renderer.
 *
 * ── Once per deployment, one at a time ──────────────────────────────────────
 * Started by `startAgency` (`bootstrap/agency.ts`), which runs only in the main process. Within
 * the process a pass never overlaps the previous one and assembles one run at a time. The claim is
 * `FOR UPDATE SKIP LOCKED` and every later write is fenced on the claim's `claim_generation`, so a
 * second assembler anywhere would only share the work, and an assembler that stalled past the
 * stale cutoff (its run claimed again) finds its writes refused and stops.
 *
 * ── One run ─────────────────────────────────────────────────────────────────
 *  1. `claimNextQueued(now − staleAfterMs)`: the oldest queued run, or an `assembling` run whose
 *     assembler died before recording a dataset. A run claimed more than `maxAttempts` times (it
 *     crashed the process each time) fails `assembly_failed` instead of being tried forever.
 *  2. The builder (`REPORT_DATASET_BUILDERS[kind]`), bounded by `buildTimeoutMs` of wall clock.
 *  3. Each detail source streamed as gzipped NDJSON (one JSON array per line) to
 *     `report-datasets/…/details-<sheet>.ndjson.gz` through `uploadStream`, stopping at
 *     `maxDetailRows` (RP12): the iterator's `return()` is called, the file is `truncated` and so
 *     is the run.
 *  4. `dataset.json` (the builder's dataset plus `detail_files`) through `uploadJson`.
 *  5. `markAssembled`, then `markSent` (both fenced on the claim), then the dispatch.
 *
 * Errors: `ReportSubjectUnavailableError` fails the run `subject_unavailable`, and disables the
 * subscription that produced it only when the tick's own probe (`probeSubscriptionSubject`) agrees
 * the subject is gone: a builder can refuse for a passing reason (an account report's campaign
 * moved mid-build) and the schedule must survive that. `ReportZoneChangedError` (a campaign's zone
 * changed after the run was made) fails `subject_changed`; anything else `assembly_failed`.
 * Logged with the run id, never the dataset.
 *
 * ── Restarts ────────────────────────────────────────────────────────────────
 * `stop()` waits at most `stopWaitMs` for the run in flight (a build may run for minutes; the
 * container's grace is 45 s). A run left `assembling` with no dataset by a stop, a crash or a
 * kill is reclaimed by the FIRST pass after start, whatever its claim's age: one replica (D2), so
 * a claim older than this process's first pass belongs to a process that is gone. Later passes
 * reclaim only claims older than `staleAfterMs`. The claim fence keeps a mistaken reclaim (a
 * clock skew) harmless.
 *
 * ── Read timeouts ───────────────────────────────────────────────────────────
 * The builders read through the shared pool (the screens' own reads, RP1), and the builder seam
 * hands them no client, so the assembler cannot put their statements under a
 * `SET LOCAL statement_timeout`. It bounds the whole build by wall clock instead
 * (`buildTimeoutMs`): past it the run fails `assembly_failed` (its statements are not cancelled;
 * they finish on their own). docs/reports.md "Pipeline" records this for the dataset builders.
 */
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { createChildLogger } from '@magick-agency/observability';
import { agencyReportsAssembleSeconds } from '@magick-agency/observability/metrics/agency';
import type { ReportKind } from '@magick-agency/contracts/api/agency/reports';
import type { ReportDetailFile } from '@magick-agency/contracts/reports';
import {
  reportRunRepository,
  reportSubscriptionRepository,
  type ReportRunRecord,
  type ReportRunRepository,
  type ReportSubscriptionRepository,
} from '../../db/repositories/agency.repository.js';
import { uploadJson, uploadStream } from '../../storage/s3.js';
import { withTimeout } from '../../utils/with-timeout.js';
import {
  REPORT_DATASET_BUILDERS,
  ReportSubjectUnavailableError,
  ReportZoneChangedError,
  type ReportDatasetBuilder,
  type ReportDetailSource,
} from './datasets/index.js';
import { reportDatasetKey, reportDetailKey, type ReportKeyScope } from './report-keys.js';
import type { ReportRenderDispatcher } from './dispatch.js';
import { countTerminalRun } from './apply.js';
import { probeSubscriptionSubject, type ReportSubscriptionSubject, type SubjectRef } from './subscription-subject.js';

const log = createChildLogger({ component: 'agency-reports-assembler' });

/** A claimed `assembling` run with no dataset this long is reclaimed (its assembler died). */
export const REPORT_ASSEMBLY_STALE_MS = 30 * 60_000;
/** The wall-clock bound on one builder call. */
export const REPORT_BUILD_TIMEOUT_MS = 10 * 60_000;
/** The detail files' content type: gzipped NDJSON. */
export const REPORT_DETAIL_CONTENT_TYPE = 'application/gzip';

/** How long `stop()` waits for the run in flight before giving up on it (inside the 45 s grace). */
export const REPORT_ASSEMBLER_STOP_WAIT_MS = 20_000;

export interface ReportAssemblerOptions {
  intervalMs: number;
  maxDetailRows: number;
  maxAttempts: number;
  staleAfterMs?: number;
  buildTimeoutMs?: number;
  stopWaitMs?: number;
}

export interface ReportAssemblerStorage {
  uploadStream(key: string, body: Readable, contentType: string): Promise<number>;
  uploadJson(key: string, value: unknown): Promise<number>;
}

export interface ReportAssemblerDeps {
  repo: Pick<ReportRunRepository, 'claimNextQueued' | 'markAssembled' | 'markSent' | 'markFailed'>;
  /**
   * A subscription whose run failed `subject_unavailable` is disabled (its failure email is the
   * last) when `subject` (the tick's probe) also says the subject is gone.
   */
  subscriptions: Pick<ReportSubscriptionRepository, 'disable'>;
  subject(ref: SubjectRef): Promise<ReportSubscriptionSubject>;
  builders: Record<ReportKind, ReportDatasetBuilder>;
  storage: ReportAssemblerStorage;
  dispatcher: ReportRenderDispatcher;
  now: () => Date;
}

export type ReportAssembleOutcome =
  | { runId: string; outcome: 'sent'; attempt: number }
  | { runId: string; outcome: 'failed'; code: 'assembly_failed' | 'subject_unavailable' | 'subject_changed' }
  /** A fenced write was refused: the claim was taken over; this assembler stopped. */
  | { runId: string; outcome: 'claim_lost' }
  /** Recorded and sent, but the dispatch threw; the tick re-sends it. */
  | { runId: string; outcome: 'dispatch_failed'; attempt: number };

export interface ReportAssembler {
  /** One pass now: claims and assembles until nothing is queued. Null when a pass is already running. */
  runPass(): Promise<ReportAssembleOutcome[] | null>;
  stop(): Promise<void>;
}

export function defaultAssemblerDeps(dispatcher: ReportRenderDispatcher): ReportAssemblerDeps {
  return {
    repo: reportRunRepository,
    subscriptions: reportSubscriptionRepository,
    subject: probeSubscriptionSubject,
    builders: REPORT_DATASET_BUILDERS,
    storage: { uploadStream, uploadJson },
    dispatcher,
    now: () => new Date(),
  };
}

/**
 * Stream one detail source into a gzipped NDJSON object, at most `maxRows` rows. Reads one row
 * past the cap to learn whether the source had more (then `truncated`); calls the iterator's
 * `return()` whenever it stops before the source ended, so a cursor-backed source releases it.
 */
export async function streamDetailFile(
  source: ReportDetailSource,
  key: string,
  maxRows: number,
  storage: Pick<ReportAssemblerStorage, 'uploadStream'>,
): Promise<{ rows: number; truncated: boolean }> {
  const gzip = createGzip();
  const upload = storage.uploadStream(key, gzip, REPORT_DETAIL_CONTENT_TYPE);
  // An upload that settles early (S3 refused) must end a wait on `drain`, which would never come.
  const uploadEnded = upload.then(
    () => { throw new Error('the detail upload ended before its rows were written'); },
    (err: unknown) => { throw err; },
  );
  uploadEnded.catch(() => undefined);
  const iterator = source.rows()[Symbol.asyncIterator]();
  let rows = 0;
  let truncated = false;
  let finished = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        finished = true;
        break;
      }
      if (rows >= maxRows) {
        truncated = true;
        break;
      }
      if (!gzip.write(`${JSON.stringify(next.value)}\n`)) {
        await Promise.race([once(gzip, 'drain'), uploadEnded]);
      }
      rows += 1;
    }
  } catch (err) {
    gzip.destroy(err instanceof Error ? err : new Error(String(err)));
    await upload.catch(() => undefined);
    throw err;
  } finally {
    if (!finished) await iterator.return?.();
  }
  gzip.end();
  await upload;
  return { rows, truncated };
}

export function createReportAssembler(options: ReportAssemblerOptions, deps: ReportAssemblerDeps) {
  const staleAfterMs = options.staleAfterMs ?? REPORT_ASSEMBLY_STALE_MS;
  const buildTimeoutMs = options.buildTimeoutMs ?? REPORT_BUILD_TIMEOUT_MS;

  const fail = async (
    run: ReportRunRecord,
    code: 'assembly_failed' | 'subject_unavailable' | 'subject_changed',
  ): Promise<ReportAssembleOutcome> => {
    const failed = await deps.repo.markFailed(run.id, code, { claimGeneration: run.claim_generation });
    if (!failed) return { runId: run.id, outcome: 'claim_lost' };
    countTerminalRun(failed);
    if (code === 'subject_unavailable' && run.subscription_id) {
      // The subject left between the tick's probe and the build: stop the schedule here, so this
      // run's failure email is the last one its recipients get. Only when the probe agrees: a
      // refusal for a passing reason leaves the schedule alone, and a probe that throws leaves it
      // to the tick's own probe next period.
      try {
        const subject = await deps.subject(run);
        if (!subject.available && (await deps.subscriptions.disable(run.subscription_id))) {
          log.warn({ runId: run.id, subscriptionId: run.subscription_id, reason: subject.reason }, 'Report subscription disabled: its subject is gone');
        }
      } catch (err) {
        log.error({ runId: run.id, subscriptionId: run.subscription_id, err }, 'Report subscription could not be checked or disabled; the tick\'s probe will');
      }
    }
    return { runId: run.id, outcome: 'failed', code };
  };

  /** Assemble one claimed run. Never throws. */
  const assembleRun = async (run: ReportRunRecord): Promise<ReportAssembleOutcome> => {
    const fence = { claimGeneration: run.claim_generation };
    if (run.claim_generation > options.maxAttempts) {
      log.error({ runId: run.id, claims: run.claim_generation }, 'Report run claimed too many times; failing it');
      return fail(run, 'assembly_failed');
    }
    const started = process.hrtime.bigint();
    const scope: ReportKeyScope = { tenantId: run.tenant_id, accountId: run.account_id, runId: run.id };
    let datasetKey: string;
    let detailFiles: ReportDetailFile[];
    let truncated = false;
    try {
      const builder = deps.builders[run.kind];
      const built = await withTimeout(builder({ run, now: deps.now() }), buildTimeoutMs, 'report build');
      detailFiles = [];
      for (const source of built.details) {
        const key = reportDetailKey(scope, source.sheet);
        const written = await streamDetailFile(source, key, options.maxDetailRows, deps.storage);
        truncated ||= written.truncated;
        detailFiles.push({
          sheet: source.sheet,
          label: source.label,
          key,
          rows: written.rows,
          truncated: written.truncated,
          columns: source.columns,
        });
      }
      datasetKey = reportDatasetKey(scope);
      await deps.storage.uploadJson(datasetKey, { ...built.dataset, detail_files: detailFiles });
    } catch (err) {
      if (err instanceof ReportSubjectUnavailableError) {
        log.warn({ runId: run.id, kind: run.kind, reason: err.message }, 'Report subject unavailable');
        return fail(run, 'subject_unavailable');
      }
      if (err instanceof ReportZoneChangedError) {
        log.warn({ runId: run.id, kind: run.kind, reason: err.message }, 'Report campaign zone changed after the run was made');
        return fail(run, 'subject_changed');
      }
      log.error({ runId: run.id, kind: run.kind, err }, 'Report assembly failed');
      return fail(run, 'assembly_failed');
    }

    try {
      if (!(await deps.repo.markAssembled(run.id, run.claim_generation, { datasetKey, detailFiles, truncated }))) {
        log.warn({ runId: run.id }, 'Report assembly claim lost before recording; stopping');
        return { runId: run.id, outcome: 'claim_lost' };
      }
      agencyReportsAssembleSeconds.observe({ kind: run.kind }, Number(process.hrtime.bigint() - started) / 1e9);
      const attempt = await deps.repo.markSent(run.id, fence);
      if (attempt === null) return { runId: run.id, outcome: 'claim_lost' };
      try {
        await deps.dispatcher.dispatch({ ...run, dataset_key: datasetKey }, attempt);
      } catch (err) {
        log.error({ runId: run.id, attempt, err }, 'Report run could not be sent to the renderer; the tick re-sends it');
        return { runId: run.id, outcome: 'dispatch_failed', attempt };
      }
      return { runId: run.id, outcome: 'sent', attempt };
    } catch (err) {
      // A database write failed after the files were written: the run stays `assembling` with or
      // without its dataset, and the stale claim or the tick's unsent sweep picks it up.
      log.error({ runId: run.id, err }, 'Report assembly could not be recorded');
      return { runId: run.id, outcome: 'claim_lost' };
    }
  };

  /**
   * Claim and assemble until nothing is queued or `shouldStop()`. `reclaimOrphans` (the first pass
   * after start): an `assembling` run claimed before this pass began is reclaimed at once.
   */
  const drain = async (shouldStop: () => boolean, opts: { reclaimOrphans?: boolean } = {}): Promise<ReportAssembleOutcome[]> => {
    const outcomes: ReportAssembleOutcome[] = [];
    const passStart = deps.now().getTime();
    while (!shouldStop()) {
      let run: ReportRunRecord | null;
      try {
        const stale = deps.now().getTime() - staleAfterMs;
        run = await deps.repo.claimNextQueued(new Date(opts.reclaimOrphans ? Math.max(stale, passStart) : stale));
      } catch (err) {
        log.error({ err }, 'Report claim failed; retrying next pass');
        break;
      }
      if (!run) break;
      outcomes.push(await assembleRun(run));
    }
    return outcomes;
  };

  return { assembleRun, drain };
}

/** Start the loop (module header). */
export function startReportAssembler(options: ReportAssemblerOptions, deps: ReportAssemblerDeps): ReportAssembler {
  const assembler = createReportAssembler(options, deps);
  const stopWaitMs = options.stopWaitMs ?? REPORT_ASSEMBLER_STOP_WAIT_MS;
  let stopping = false;
  let first = true;
  let running: Promise<ReportAssembleOutcome[]> | null = null;

  const runPass = async (): Promise<ReportAssembleOutcome[] | null> => {
    if (running || stopping) return null;
    const reclaimOrphans = first;
    first = false;
    running = assembler.drain(() => stopping, { reclaimOrphans });
    try {
      return await running;
    } finally {
      running = null;
    }
  };

  const timer = setInterval(() => { void runPass(); }, options.intervalMs);
  timer.unref?.();
  log.info({ intervalMs: options.intervalMs }, 'Report assembler started');

  return {
    runPass,
    async stop() {
      stopping = true;
      clearInterval(timer);
      if (running) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = await Promise.race([
          running.then(() => true, () => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), stopWaitMs); timer.unref?.(); }),
        ]);
        clearTimeout(timer);
        if (!waited) log.warn({ stopWaitMs }, 'Report assembler stopped with a run in flight; the next start reclaims it');
      }
      log.info('Report assembler stopped');
    },
  };
}
