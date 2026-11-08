/**
 * The Lambda entry (`index.handler` in the deployed zip): SQS `report-jobs`, batch size 1. Each
 * record is a `ReportRenderMessage`; the handler renders it with S3 IO (the message's bucket, the
 * function role's credentials) and `@sparticuz/chromium` (a layer), then POSTs the signed
 * callback. A record whose callback cannot be delivered is returned in `batchItemFailures` so SQS
 * redelivers it; a render failure is NOT a batch failure (it is reported in the callback).
 *
 * A record received after its `superseded_after` (an SQS redelivery or a backed-up queue that
 * outlasted the server's `AGENCY_REPORTS_RENDER_TIMEOUT_MS`) is dropped without rendering and
 * without a batch failure: the server has already re-sent the run as the next attempt or failed
 * it, so this attempt's callback could only be acknowledged as `stale` (RP13).
 *
 * Logs are JSON lines with run id, attempt and timings, never dataset contents (personal data).
 */
import { S3Client } from '@aws-sdk/client-s3';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { Browser } from 'puppeteer-core';
import type { ReportRenderMessage } from '@magick-agency/contracts/reports';
import { errorMessage } from './errors';
import { CallbackRefusedError, postCallback, type PostDeps } from './lambda/callback';
import { launchLambdaChromium } from './lambda/chromium';
import { s3IO, type S3Like } from './lambda/s3-io';
import { renderRun } from './render-run';

export interface HandlerDeps extends PostDeps {
  s3: S3Like;
  /** `AGENCY_REPORTS_CALLBACK_SECRET`. */
  secret: string | undefined;
  launch: () => Promise<Browser>;
  log: (line: Record<string, unknown>) => void;
  tmpDir?: string;
}

function jsonLog(line: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...line }));
}

export function createHandler(deps: HandlerDeps): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event) => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      try {
        await processRecord(record, deps);
      } catch (error) {
        if (error instanceof CallbackRefusedError) {
          // Final: a redelivery would render again only to be refused again (callback.ts).
          deps.log({ event: 'record.callback_refused', message_id: record.messageId, status: error.status });
          continue;
        }
        deps.log({ event: 'record.failed', message_id: record.messageId, error: errorMessage(error) });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

async function processRecord(record: SQSRecord, deps: HandlerDeps): Promise<void> {
  if (!deps.secret) throw new Error('AGENCY_REPORTS_CALLBACK_SECRET is not set');
  const message = JSON.parse(record.body) as ReportRenderMessage;
  const receive = Number(record.attributes?.ApproximateReceiveCount ?? 1);
  if (isSuperseded(message, deps.now())) {
    deps.log({ event: 'record.superseded', run_id: message.run_id, attempt: message.attempt, receive, superseded_after: message.superseded_after });
    return;
  }
  const started = Date.now();
  const callback = await renderRun(message, s3IO(deps.s3, message.bucket), {
    launch: deps.launch,
    tmpDir: deps.tmpDir,
    log: (e) => deps.log({ ...e, receive }),
  });
  const rawBody = JSON.stringify(callback);
  const status = await postCallback(message.callback_url, rawBody, deps.secret, deps, (n, outcome) =>
    deps.log({ event: 'callback.try', run_id: message.run_id, attempt: message.attempt, try: n, outcome }),
  );
  deps.log({ event: 'record.done', run_id: message.run_id, attempt: message.attempt, status: callback.status, callback_status: status, ms: Date.now() - started });
}

/**
 * Is the message past its `superseded_after` at `nowSeconds` (unix seconds)? Absent or not a
 * date: never (an older server, the inline path), so the message is rendered as before.
 */
export function isSuperseded(message: Pick<ReportRenderMessage, 'superseded_after'>, nowSeconds: number): boolean {
  if (typeof message.superseded_after !== 'string') return false;
  const at = Date.parse(message.superseded_after);
  return Number.isFinite(at) && nowSeconds * 1000 > at;
}

let s3: S3Client | null = null;

/** The deployed handler. */
export const handler = (event: SQSEvent): Promise<SQSBatchResponse> => {
  s3 ??= new S3Client({});
  return createHandler({
    s3,
    secret: process.env.AGENCY_REPORTS_CALLBACK_SECRET,
    launch: () => launchLambdaChromium(),
    log: jsonLog,
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now() / 1000,
    tmpDir: '/tmp',
  })(event);
};
