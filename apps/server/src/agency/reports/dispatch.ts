/**
 * Sending a run to the renderer (docs/reports.md "Shape", RP13, RP15). The assembler sends a run
 * once its dataset is recorded and `markSent` has given it a render attempt; the tick re-sends a
 * run that never called back. Both go through a {@link ReportRenderDispatcher}:
 *
 *  - **sqs** ({@link createSqsDispatcher}): one `SendMessage` of the {@link ReportRenderMessage}
 *    JSON to `AGENCY_REPORTS_SQS_QUEUE_URL`; the renderer Lambda renders and POSTs its signed
 *    callback to `${AGENCY_REPORTS_CALLBACK_BASE_URL}/webhooks/reports/rendered`.
 *  - **inline** ({@link createInlineDispatcher}): the renderer package
 *    (`@magick-agency/report-renderer`) called in this process, one run at a time, its returned
 *    callback applied through `applyRenderOutcome` (no HTTP, no signature); the renderer's
 *    structured log events (stage, run id, attempt, bytes, ms) go to the server log. Development
 *    and tests only: the production image carries no Chromium.
 *
 * ── How the inline dispatcher reaches the renderer ───────────────────────────
 * The renderer is its own workspace app (RP15) whose sources are `.tsx`. It is loaded with a
 * dynamic `import()` of a NON-literal specifier ({@link loadReportRenderer}), typed by the small
 * local {@link ReportRendererModule} interface, so the server's `tsc` never follows into the
 * renderer's sources and needs no JSX settings. The server lists the package as a dependency for
 * the import to resolve; until it does, an inline render fails the run `render_failed` with a
 * message saying the renderer is not installed. Tests inject a fake loader.
 *
 * A dispatch that throws (SQS unreachable) leaves the run `rendering`; the tick re-sends it after
 * `AGENCY_REPORTS_RENDER_TIMEOUT_MS`, so a send is never lost, only late.
 */
import type { Readable } from 'node:stream';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createChildLogger } from '@magick-agency/observability';
import {
  REPORT_DATASET_VERSION,
  type ReportRenderCallback,
  type ReportRenderMessage,
} from '@magick-agency/contracts/reports';
import type { ReportRunRecord } from '../../db/repositories/agency.repository.js';
import { getFile, getFileStream, uploadFile, uploadStream } from '../../storage/s3.js';
import { reportOutputPrefix } from './report-keys.js';

const log = createChildLogger({ component: 'agency-reports-dispatch' });

/** The webhook path the renderer calls back on, joined to `AGENCY_REPORTS_CALLBACK_BASE_URL`. */
export const REPORT_CALLBACK_PATH = '/webhooks/reports/rendered';

/** What a dispatch reads from the run: its ids, formats and recorded dataset. */
export type DispatchableRun = Pick<ReportRunRecord, 'id' | 'tenant_id' | 'account_id' | 'formats' | 'dataset_key'>;

export interface ReportRenderDispatcher {
  /** Send `run` to the renderer as render attempt `attempt` (the value `markSent` returned). */
  dispatch(run: DispatchableRun, attempt: number): Promise<void>;
  /** Resolves when no send is in flight (the inline renderer's queue is empty). */
  idle(): Promise<void>;
}

/** The render message for a run (the SQS body, or the inline renderer's argument). */
export function buildRenderMessage(
  run: DispatchableRun,
  attempt: number,
  opts: { bucket: string; callbackUrl: string },
): ReportRenderMessage {
  if (!run.dataset_key) throw new Error(`report run ${run.id}: no dataset recorded, nothing to render`);
  return {
    run_id: run.id,
    attempt,
    dataset_version: REPORT_DATASET_VERSION,
    bucket: opts.bucket,
    dataset_key: run.dataset_key,
    output_prefix: reportOutputPrefix({ tenantId: run.tenant_id, accountId: run.account_id, runId: run.id }),
    formats: [...run.formats],
    callback_url: opts.callbackUrl,
  };
}

// ─── SQS ──────────────────────────────────────────────────────────────────────

/** The one SQS call the dispatcher makes (a seam for tests). */
export interface ReportSqsSender {
  send(queueUrl: string, body: string): Promise<void>;
}

export function sqsSender(opts: {
  region: string | undefined;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}): ReportSqsSender {
  // Credentials as `storage/s3.ts` takes them (the `s3` config block's keys); without that block,
  // the SDK's default chain (an instance role).
  const client = new SQSClient({
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  });
  return {
    async send(queueUrl, body) {
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    },
  };
}

export function createSqsDispatcher(opts: {
  queueUrl: string;
  bucket: string;
  callbackBaseUrl: string;
  sender: ReportSqsSender;
}): ReportRenderDispatcher {
  const callbackUrl = `${opts.callbackBaseUrl.replace(/\/+$/, '')}${REPORT_CALLBACK_PATH}`;
  return {
    async dispatch(run, attempt) {
      const message = buildRenderMessage(run, attempt, { bucket: opts.bucket, callbackUrl });
      await opts.sender.send(opts.queueUrl, JSON.stringify(message));
      log.info({ runId: run.id, attempt }, 'Report run sent to the renderer queue');
    },
    idle: async () => {},
  };
}

// ─── Inline ───────────────────────────────────────────────────────────────────

/** The renderer's object IO, as `@magick-agency/report-renderer`'s `renderRun` takes it. */
export interface ReportRendererIO {
  readObject(key: string): Promise<Buffer>;
  readStream(key: string): Promise<Readable>;
  writeObject(key: string, body: Buffer | Readable, contentType: string, bytes: number): Promise<{ bytes: number }>;
}

/** What the server uses of `@magick-agency/report-renderer`: one function. */
export interface ReportRendererModule {
  renderRun(
    message: ReportRenderMessage,
    io: ReportRendererIO,
    options?: { chromePath?: string; log?(event: unknown): void },
  ): Promise<ReportRenderCallback>;
}

export type ReportRendererLoader = () => Promise<ReportRendererModule>;

/** The package name, held in a variable so `tsc` does not resolve the renderer's sources. */
const RENDERER_PACKAGE: string = '@magick-agency/report-renderer';

/** Load the renderer package in process (module header). */
export const loadReportRenderer: ReportRendererLoader = async () => {
  const mod = (await import(RENDERER_PACKAGE)) as Partial<ReportRendererModule>;
  if (typeof mod.renderRun !== 'function') throw new Error(`${RENDERER_PACKAGE} does not export renderRun`);
  return mod as ReportRendererModule;
};

/** The renderer's IO over this server's bucket (`storage/s3.ts`). */
export const s3RendererIO: ReportRendererIO = {
  readObject: (key) => getFile(key),
  readStream: async (key) => (await getFileStream(key)).body,
  async writeObject(key, body, contentType, bytes) {
    if (Buffer.isBuffer(body)) {
      await uploadFile(key, body, contentType);
      return { bytes: body.length };
    }
    const written = await uploadStream(key, body, contentType);
    return { bytes: written || bytes };
  },
};

/** A renderer log event as `renderRun` emits it (`RenderLogEvent`): never dataset contents. */
export interface ReportRendererLogEvent {
  event?: string;
  run_id?: string;
  attempt?: number;
  format?: string;
  bytes?: number;
  ms?: number;
  code?: string;
  error?: string;
}

/** One structured line in the server log for a renderer event (run id, attempt, stage, bytes, ms). */
export interface ReportRendererLogLine {
  runId: string | undefined;
  attempt: number | undefined;
  stage: string;
  format?: string;
  bytes?: number;
  ms?: number;
  code?: string;
  error?: string;
}

/** Map a renderer event to the server's log fields (unknown fields dropped). */
export function rendererLogLine(event: unknown): ReportRendererLogLine {
  const e = (event && typeof event === 'object' ? event : {}) as ReportRendererLogEvent;
  return {
    runId: typeof e.run_id === 'string' ? e.run_id : undefined,
    attempt: typeof e.attempt === 'number' ? e.attempt : undefined,
    stage: typeof e.event === 'string' ? e.event : 'unknown',
    ...(typeof e.format === 'string' ? { format: e.format } : {}),
    ...(typeof e.bytes === 'number' ? { bytes: e.bytes } : {}),
    ...(typeof e.ms === 'number' ? { ms: e.ms } : {}),
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    ...(typeof e.error === 'string' ? { error: e.error.slice(0, 2000) } : {}),
  };
}

const rendererLog = createChildLogger({ component: 'agency-reports-renderer' });

/** Write a renderer event to the server log: a failure as a warning, every other stage as info. */
export function logRendererEvent(event: unknown): void {
  const line = rendererLogLine(event);
  if (line.stage === 'render.failed') rendererLog.warn(line, 'Report renderer: render failed');
  else rendererLog.info(line, `Report renderer: ${line.stage}`);
}

/** The version the inline dispatcher records when the renderer never ran. */
export const INLINE_UNAVAILABLE_VERSION = 'inline-unavailable';

export function createInlineDispatcher(opts: {
  bucket: string;
  /** `AGENCY_REPORTS_CHROME_PATH`; absent lets the renderer discover Chromium itself. */
  chromePath?: string;
  /** `applyRenderOutcome` bound to its deps. */
  apply: (runId: string, attempt: number, callback: ReportRenderCallback) => Promise<unknown>;
  io?: ReportRendererIO;
  loader?: ReportRendererLoader;
  /** Where the renderer's log events go (default: the server log, {@link logRendererEvent}). */
  logEvent?: (event: unknown) => void;
}): ReportRenderDispatcher {
  const io = opts.io ?? s3RendererIO;
  const loader = opts.loader ?? loadReportRenderer;
  const logEvent = opts.logEvent ?? logRendererEvent;
  // One render at a time: each dispatch is chained behind the previous one.
  let queue: Promise<void> = Promise.resolve();

  const renderOne = async (message: ReportRenderMessage): Promise<void> => {
    let callback: ReportRenderCallback;
    try {
      const renderer = await loader();
      callback = await renderer.renderRun(message, io, {
        ...(opts.chromePath ? { chromePath: opts.chromePath } : {}),
        log: (event) => { try { logEvent(event); } catch { /* a log sink never fails a render */ } },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error({ runId: message.run_id, attempt: message.attempt, err: reason }, 'Inline report render failed');
      callback = {
        run_id: message.run_id,
        attempt: message.attempt,
        status: 'failed',
        files: [],
        error: { code: 'render_failed', message: `The in-process renderer could not run: ${reason}`.slice(0, 500) },
        renderer_version: INLINE_UNAVAILABLE_VERSION,
      };
    }
    try {
      await opts.apply(message.run_id, message.attempt, callback);
    } catch (err) {
      log.error({ runId: message.run_id, attempt: message.attempt, err }, 'Inline report render result could not be applied');
    }
  };

  return {
    async dispatch(run, attempt) {
      // Built now, so a run without a dataset fails the caller's dispatch rather than the queue.
      const message = buildRenderMessage(run, attempt, {
        bucket: opts.bucket,
        callbackUrl: `inline:${REPORT_CALLBACK_PATH}`,
      });
      queue = queue.then(() => renderOne(message));
      log.info({ runId: run.id, attempt }, 'Report run queued for the in-process renderer');
    },
    idle: () => queue,
  };
}
