/**
 * Every S3 key a report run reads or writes (docs/reports.md "S3 keys"). Derived here, on the
 * server, from ids the server already holds (the run row), never from anything a client sent:
 * a key built from client input is how one tenant reads another's objects (the ingest-key
 * lesson, `../agency-ingest-keys.ts`). The renderer receives the dataset key and the output
 * prefix in the render message and writes nowhere else; the callback's file keys are checked
 * against {@link reportOutputKey} before they are stored.
 *
 *   report-datasets/{tenant}/{scope}/{run}/dataset.json              (lifecycle 7 days, RP8)
 *   report-datasets/{tenant}/{scope}/{run}/details-{sheet}.ndjson.gz
 *   reports/{tenant}/{scope}/{run}/report.pdf | report.xlsx         (lifecycle 90 days, RP8)
 *
 * `{scope}` is the run's account id, or the literal `tenant` for a run not scoped to one account
 * (none in v1): never a second copy of the tenant id, so the two kinds of prefix cannot be
 * confused. Every id must be a UUID (refused otherwise, with a `RangeError`) and is written in
 * lower case, as Postgres renders it, so one run has one set of keys. The two top-level prefixes
 * are what the bucket's lifecycle rules and the renderer's IAM policy name.
 */
import { REPORT_DETAIL_SHEETS, type ReportDetailSheet, REPORT_OUTPUT_FILE_NAMES } from '@magick-agency/contracts/reports';
import { REPORT_FORMATS, type ReportFormat } from '@magick-agency/contracts/api/agency/reports';

/** Datasets and detail files (7-day lifecycle). */
export const REPORT_DATASETS_PREFIX = 'report-datasets/';
/** Rendered files (90-day lifecycle). */
export const REPORTS_PREFIX = 'reports/';
/** The `{scope}` segment of a run with no account. */
export const REPORT_TENANT_SCOPE = 'tenant';

/** The ids a run's keys are built from: the run row's own. */
export interface ReportKeyScope {
  tenantId: string;
  accountId: string | null;
  runId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(name: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new RangeError(`report key: ${name} must be a UUID`);
  }
  return value.toLowerCase();
}

/** `{tenant}/{scope}/{run}/`, validated. */
function runPath(scope: ReportKeyScope): string {
  const tenant = uuid('tenantId', scope.tenantId);
  const segment = scope.accountId === null ? REPORT_TENANT_SCOPE : uuid('accountId', scope.accountId);
  return `${tenant}/${segment}/${uuid('runId', scope.runId)}/`;
}

/** `report-datasets/{tenant}/{scope}/{run}/`: everything the assembler writes for a run. */
export function reportDatasetPrefix(scope: ReportKeyScope): string {
  return `${REPORT_DATASETS_PREFIX}${runPath(scope)}`;
}

/** The run's `dataset.json`. */
export function reportDatasetKey(scope: ReportKeyScope): string {
  return `${reportDatasetPrefix(scope)}dataset.json`;
}

/** One detail sheet's gzipped NDJSON. */
export function reportDetailKey(scope: ReportKeyScope, sheet: ReportDetailSheet): string {
  if (!(REPORT_DETAIL_SHEETS as readonly string[]).includes(sheet)) {
    throw new RangeError('report key: unknown detail sheet');
  }
  return `${reportDatasetPrefix(scope)}details-${sheet}.ndjson.gz`;
}

/** `reports/{tenant}/{scope}/{run}/`: the render message's `output_prefix`. */
export function reportOutputPrefix(scope: ReportKeyScope): string {
  return `${REPORTS_PREFIX}${runPath(scope)}`;
}

/** The one key a rendered file of `format` may have. */
export function reportOutputKey(scope: ReportKeyScope, format: ReportFormat): string {
  if (!(REPORT_FORMATS as readonly string[]).includes(format)) {
    throw new RangeError('report key: unknown format');
  }
  return `${reportOutputPrefix(scope)}${REPORT_OUTPUT_FILE_NAMES[format]}`;
}

/**
 * Is `key` exactly the output key of `format` for this run? The callback's check before its
 * file list is stored: a renderer (or a forged callback that got past the signature) naming any
 * other object is refused. False, never a throw, for any `key`; still throws on a bad scope.
 */
export function isReportOutputKey(scope: ReportKeyScope, format: ReportFormat, key: unknown): boolean {
  return typeof key === 'string' && key === reportOutputKey(scope, format);
}
