/**
 * `@magick-agency/contracts/reports`: the report dataset and the render protocol, shared by the
 * server (which assembles datasets and receives callbacks) and `apps/report-renderer` (which
 * depends on nothing else, RP15). docs/reports.md is the design; the console wire types (runs,
 * subscriptions, downloads, refusals) are in `../api/agency/reports.ts`.
 *
 * The vocabularies a dataset uses from the console wire file are re-exported here so the
 * renderer imports one module.
 */
import type { AccountReportDataset } from './account';
import type { AgentReviewDataset } from './agent';
import type { CampaignReportDataset } from './campaign';

export * from './dataset';
export * from './agent';
export * from './campaign';
export * from './account';
export * from './render';
export * from './file-name';

export {
  REPORT_AUDIENCES,
  REPORT_FAILURE_CODES,
  REPORT_FORMAT_CONTENT_TYPES,
  REPORT_FORMATS,
  REPORT_KINDS,
  type ReportAudience,
  type ReportFormat,
  type ReportKind,
} from '../api/agency/reports';

// The Calls by type table's words, shared with the console's Insights (`docs/call-log.md` §6).
export {
  AGENCY_CALL_LOG_TYPE_LABELS,
  AGENCY_CALLS_BY_TYPE_NO_RATE,
  AGENCY_CALLS_BY_TYPE_RATE_LABELS,
  AGENCY_OUTBOUND_CONNECT_RATE_LABEL,
  agencyCallsByTypeFootnote,
  type AgencyCallLogType,
} from '../api/agency/call-log';

/** Every dataset, discriminated on `kind`. */
export type ReportDataset = AgentReviewDataset | CampaignReportDataset | AccountReportDataset;

/** The dataset of one kind. */
export type ReportDatasetOf<K extends ReportDataset['kind']> = Extract<ReportDataset, { kind: K }>;
