/**
 * The render protocol between the server and the renderer (`apps/report-renderer`, RP15).
 *
 * 1. The server writes `dataset.json` (a {@link ReportDataset}) and its detail files, then sends
 *    a {@link ReportRenderMessage}: as an SQS message body (renderer `sqs`) or as the argument of
 *    the in-process call (renderer `inline`). The same JSON either way.
 * 2. The renderer reads the dataset, writes one file per format to
 *    `${output_prefix}${REPORT_OUTPUT_FILE_NAMES[format]}` in `bucket`, and POSTs a
 *    {@link ReportRenderCallback} to `callback_url`, signed (below). On a failure it still calls
 *    back, with `status: 'failed'`.
 * 3. The server applies the callback only when `run_id` and `attempt` match the run's current
 *    render attempt (RP13 fencing); a stale attempt's callback is acknowledged (2xx) and ignored.
 *
 * ── Signature ───────────────────────────────────────────────────────────────
 * Headers {@link REPORT_TIMESTAMP_HEADER} (unix seconds, decimal) and
 * {@link REPORT_SIGNATURE_HEADER} = lowercase hex HMAC-SHA256, keyed with
 * `AGENCY_REPORTS_CALLBACK_SECRET`, of {@link reportSignaturePayload}`(timestamp, rawBody)`,
 * where `rawBody` is the exact request body bytes as UTF-8. The server refuses (401) a missing
 * or bad signature and a timestamp more than {@link REPORT_CALLBACK_MAX_SKEW_SECONDS} from its
 * clock, and compares signatures in constant time. The HMAC itself is the server's and the
 * renderer's to compute (Node `crypto`); this package stays runtime-neutral.
 */
import type { ReportFailureCode, ReportFormat, ReportRendererFailureCode } from '../api/agency/reports';
import type { REPORT_DATASET_VERSION } from './dataset';

/** Header carrying the callback's hex HMAC-SHA256 signature. */
export const REPORT_SIGNATURE_HEADER = 'x-mgkvc-report-signature';
/** Header carrying the callback's unix timestamp in seconds. */
export const REPORT_TIMESTAMP_HEADER = 'x-mgkvc-report-timestamp';
/** A callback whose timestamp is further than this from the server's clock is refused. */
export const REPORT_CALLBACK_MAX_SKEW_SECONDS = 300;

/** The object name of each format under `output_prefix`. */
export const REPORT_OUTPUT_FILE_NAMES = {
  pdf: 'report.pdf',
  xlsx: 'report.xlsx',
} as const satisfies Record<ReportFormat, string>;

/** The SQS body (or inline argument) asking the renderer to render one run's files. */
export interface ReportRenderMessage {
  run_id: string;
  /** The run's render attempt, 1-based; echoed in the callback for fencing (RP13). */
  attempt: number;
  /** The dataset's `dataset_version`, so a renderer can refuse before reading it. */
  dataset_version: typeof REPORT_DATASET_VERSION;
  /** The S3 bucket holding the dataset, its detail files, and the output. */
  bucket: string;
  /** Key of `dataset.json`. Detail files are at their `ReportDetailFile.key`, same bucket. */
  dataset_key: string;
  /** Key prefix for the output, ending in `/` (`reports/{tenant}/{account|tenant}/{run}/`). */
  output_prefix: string;
  /** The formats to render, non-empty. */
  formats: ReportFormat[];
  /** Absolute URL of `POST /webhooks/reports/rendered`. */
  callback_url: string;
}

/** The renderer's signed `POST` to `callback_url`. */
export interface ReportRenderCallback {
  run_id: string;
  attempt: number;
  status: 'rendered' | 'failed';
  /** Every rendered file; one per requested format when `rendered`, may be partial or empty when `failed`. */
  files: Array<{ format: ReportFormat; key: string; bytes: number }>;
  /** Null when `rendered`. `message` is for logs, never shown to users verbatim. */
  error: { code: ReportRendererFailureCode; message: string } | null;
  /** The renderer's own version (its package version), recorded on the run for diagnosis. */
  renderer_version: string;
}

/** The string the callback signature is computed over: `${timestamp}.${rawBody}`. */
export function reportSignaturePayload(timestamp: string | number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** Re-exported for the renderer, which reports a subset of the run's failure codes. */
export type { ReportFailureCode, ReportRendererFailureCode };
