/**
 * Export with fields (`docs/call-log.md` §10, rulings CL43–CL52): the extra columns a supervisor
 * may add to the campaign call export (`GET /proxy/agency/campaigns/:id/attempts.csv?fields=`),
 * and the list of what can be added for the calls on screen
 * (`GET /proxy/agency/campaigns/:id/call-log/export-fields`). Both are `agency.supervise`.
 *
 * Three kinds of field, each named in the file by a fixed prefix so it can never take the name
 * of one of the file's own columns (CL44):
 *
 *  - the call analysis's common fields, {@link AGENCY_CALL_EXPORT_ANALYSIS_FIELDS};
 *  - a custom dimension, `dim_<key>` ({@link AGENCY_CALL_EXPORT_DIMENSION_PREFIX}), the key as
 *    the analysis stored it (`call_analysis.custom.<key>`), never respelled;
 *  - a call detail the agent entered on a soft-phone call, `field_<key>`
 *    ({@link AGENCY_CALL_EXPORT_CALL_FIELD_PREFIX}), the key of the soft phone's call fields.
 *
 * The analysis's fields and the dimensions are behind the campaign's account's analytics setting
 * (`analyze_calls`): without it they are not offered, and asking for one is refused (CL47). The
 * transcript is not a field and never will be in this file (CL46).
 *
 * The chosen fields are added after the file's last column (`callback_of`), in the order asked,
 * so a consumer reading the file by position keeps its columns; with no `fields` the file is
 * exactly what it was (CL43).
 */

import type { AnalyticsDimensionType } from './shared';
import type { AgencyCallLogType } from './call-log';
import type { DialerAnalysisStatus } from './webrtc-call';
import type { AgencyCallFieldType } from '../../agency';
import { SOFTPHONE_CALL_FIELD_KEY_MAX } from '../../agency/softphone';
import type { AllListed } from '../../primitives';

/** The call analysis's common fields, in the order the dialog offers them. */
export type AgencyCallExportAnalysisField =
  | 'analysis_status'
  | 'ai_summary'
  | 'ai_sentiment'
  | 'ai_sentiment_score'
  | 'ai_key_topics';

export const AGENCY_CALL_EXPORT_ANALYSIS_FIELDS = [
  'analysis_status',
  'ai_summary',
  'ai_sentiment',
  'ai_sentiment_score',
  'ai_key_topics',
] as const satisfies readonly AgencyCallExportAnalysisField[];

const _allAnalysisFieldsListed: AllListed<AgencyCallExportAnalysisField, typeof AGENCY_CALL_EXPORT_ANALYSIS_FIELDS> = true;
void _allAnalysisFieldsListed;

/** A custom dimension's column is this prefix and the dimension's key: `dim_promise_strength`. */
export const AGENCY_CALL_EXPORT_DIMENSION_PREFIX = 'dim_';

/** A soft-phone call detail's column is this prefix and the field's key: `field_loan_account_no`. */
export const AGENCY_CALL_EXPORT_CALL_FIELD_PREFIX = 'field_';

/**
 * A dimension or call-field key, as the profile and soft-phone validators allow it: snake_case,
 * starting with a letter, at most {@link SOFTPHONE_CALL_FIELD_KEY_MAX} (50) characters, the
 * dimension validator's cap too. The length is in the pattern, not beside it, because the server
 * also hands `.source` to Postgres. A `fields` item whose key does not match is refused (400),
 * before anything is read.
 */
export const AGENCY_CALL_EXPORT_KEY_PATTERN = new RegExp(`^[a-z][a-z0-9_]{0,${SOFTPHONE_CALL_FIELD_KEY_MAX - 1}}$`);

/**
 * The most fields one export may ask for: the five analysis fields, a profile's 20 dimensions
 * for each of the three call types, and the soft phone's 20 call fields, with room to spare.
 */
export const AGENCY_CALL_EXPORT_MAX_FIELDS = 100;

/**
 * The file's row ceiling when any analysis field other than `analysis_status`, or any dimension,
 * is chosen (CL48, Manas's ruling): those cells can each be long text, and a file of 50,000 such
 * rows does not finish inside the export's time budget. Otherwise the ceiling stays the export's
 * own 50,000. Call fields do not lower it.
 */
export const AGENCY_CALL_EXPORT_AI_ROW_LIMIT = 20_000;

/**
 * What the `analysis_status` column holds: the media leg's own status (`agency_calls.analysis_status`,
 * wire codes, never respelled), or `none` when the call has no media leg or was never queued for
 * analysis (not recorded, or analysis off when it was placed). `deleted` is an erasure on request.
 */
export type AgencyCallExportAnalysisStatus = 'none' | DialerAnalysisStatus;

export const AGENCY_CALL_EXPORT_ANALYSIS_STATUSES = [
  'none',
  'awaiting_recording',
  'pending',
  'completed',
  'failed',
  'skipped',
  'expired',
  'deleted',
] as const satisfies readonly AgencyCallExportAnalysisStatus[];

const _allAnalysisStatusesListed: AllListed<AgencyCallExportAnalysisStatus, typeof AGENCY_CALL_EXPORT_ANALYSIS_STATUSES> = true;
void _allAnalysisStatusesListed;

/** One of the analysis's common fields, with how many of the calls carry a value for it. */
export interface AgencyCallExportAnalysisFieldInfo {
  name: AgencyCallExportAnalysisField;
  /** Calls with a value in this column. `analysis_status` always has one, so it is `calls`. */
  calls: number;
}

/**
 * A custom dimension found on the calls: in the dimensions their analysis was run with (each
 * analysis job keeps a copy of its profile's dimensions) or in a stored result. One entry per
 * key, whichever profiles and versions it came from (CL45).
 */
export interface AgencyCallExportDimensionInfo {
  /** The column: `dim_<key>`. */
  name: string;
  key: string;
  /**
   * The types the key was declared with, oldest first. Usually one; two when a profile changed
   * the key's type between versions, and the column then holds both, each as stored. Empty for
   * a key found only in stored results.
   */
  types: AnalyticsDimensionType[];
  /** A choice's options, every version's, first-seen order, no repeats. Empty for other types. */
  options: string[];
  /** The newest declaration's description (the analysis prompt's wording), else null. */
  description: string | null;
  /** Calls whose stored result has a value for the key. */
  calls: number;
  /** The call types those calls are, in `AGENCY_CALL_LOG_TYPES` order. */
  sources: AgencyCallLogType[];
}

/** A call detail the agent entered on soft-phone calls. */
export interface AgencyCallExportCallFieldInfo {
  /** The column: `field_<key>`. */
  name: string;
  key: string;
  /** The soft phone's current label for the key, else null (the field was removed since). */
  label: string | null;
  /** The soft phone's current type for the key, else null. */
  type: AgencyCallFieldType | null;
  /** Soft-phone calls with a value for the key. */
  calls: number;
}

/**
 * `GET /proxy/agency/campaigns/:id/call-log/export-fields`: what can be added to the export of
 * the calls the Call log's filters match (the same query as the Call log: its filters, `type`,
 * `status`). Read when the dialog opens.
 */
export interface AgencyCallExportFieldsResponse {
  /** Calls the filters match: the rows the file would hold, before any ceiling. */
  calls: number;
  /** The campaign's account's analytics setting. False: `analysis` and `dimensions` are empty. */
  analysis_available: boolean;
  /** Calls whose analysis completed; null when `analysis_available` is false. */
  analysed: number | null;
  analysis: AgencyCallExportAnalysisFieldInfo[];
  /** Most calls first, then by key. */
  dimensions: AgencyCallExportDimensionInfo[];
  /** Most calls first, then by key. */
  call_fields: AgencyCallExportCallFieldInfo[];
  /** The export's own row ceiling (50,000). */
  row_limit: number;
  /** The ceiling with an AI field chosen ({@link AGENCY_CALL_EXPORT_AI_ROW_LIMIT}). */
  ai_row_limit: number;
}

/** True when `name` is one of the analysis's common fields. */
export function isCallExportAnalysisField(name: string): name is AgencyCallExportAnalysisField {
  return (AGENCY_CALL_EXPORT_ANALYSIS_FIELDS as readonly string[]).includes(name);
}

/**
 * True when choosing `name` lowers the file's ceiling to {@link AGENCY_CALL_EXPORT_AI_ROW_LIMIT}:
 * an analysis field other than `analysis_status`, or a dimension (CL48).
 */
export function lowersCallExportRowLimit(name: string): boolean {
  return (isCallExportAnalysisField(name) && name !== 'analysis_status')
    || name.startsWith(AGENCY_CALL_EXPORT_DIMENSION_PREFIX);
}
