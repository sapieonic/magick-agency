/**
 * Export with fields (`docs/call-log.md` §10, rulings CL43–CL52): the extra columns a supervisor
 * adds to the campaign call export (`GET /proxy/agency/campaigns/:id/attempts.csv?fields=`).
 *
 *  - {@link parseCallExportFields}: `fields` read and checked (CL52), before anything is read.
 *  - {@link planCallExportFields}: what the chosen fields need (the analytics grant, which extras
 *    the call log read attaches) and the file's row ceiling (CL48).
 *  - {@link callExportCsvHeader} / {@link callExportCsvRow}: the file's columns, today's then the
 *    chosen ones in the order asked (CL43), each value written by {@link callExportCell} (CL49).
 *  - {@link callExportPreambleLines}: what the preamble says about them (CL51).
 *  - {@link attachCallExportExtras}: the internal call log read's `export_extras` on each row.
 *
 * Every cell still goes through `toCsvLine` and its formula guard: an AI summary is model output
 * and is treated as untrusted text. Nothing here escapes a cell itself (a second escape would
 * double the apostrophe).
 *
 * A LEAF module: types, constants and pure functions. No fastify, no db.
 */
import {
  AGENCY_CALL_EXPORT_AI_ROW_LIMIT,
  AGENCY_CALL_EXPORT_CALL_FIELD_PREFIX,
  AGENCY_CALL_EXPORT_DIMENSION_PREFIX,
  AGENCY_CALL_EXPORT_KEY_PATTERN,
  AGENCY_CALL_EXPORT_MAX_FIELDS,
  isCallExportAnalysisField,
  lowersCallExportRowLimit,
  type AgencyCallExportAnalysisField,
  type AgencyCallExportAnalysisFieldInfo,
  type AgencyCallExportCallFieldInfo,
  type AgencyCallExportDimensionInfo,
  type AgencyCallExportFieldsResponse,
} from '@magick-agency/contracts/api/agency/call-export-fields';
import { ANALYTICS_DIMENSION_TYPES, type AnalyticsDimensionType } from '@magick-agency/contracts/api/agency/shared';
import { AGENCY_CALL_LOG_TYPES } from '@magick-agency/contracts/api/agency/call-log';
import { AGENCY_CALL_FIELD_TYPES, type AgencyCallFieldType } from '@magick-agency/contracts/agency';
import { preambleLine, sanitizePreambleValue, toCsvLine } from './agency-csv.js';
import { ATTEMPT_CSV_COLUMNS, SPINE_EXPORT_MAX_ROWS, attemptCsvCells, type SpineAttemptRow } from './agency-spine.js';
import { multiParam } from './spine-filters.js';

// ─── Asking for fields (CL52) ──────────────────────────────────────────────

/** One chosen field: an analysis field, a dimension (`dim_<key>`) or a call detail (`field_<key>`). */
export type CallExportField =
  | { kind: 'analysis'; name: AgencyCallExportAnalysisField }
  | { kind: 'dimension'; name: string; key: string }
  | { kind: 'call_field'; name: string; key: string };

/** How much of a refused item the 400 echoes back: an item is a name, never this long. */
const ECHOED_ITEM_MAX_CHARS = 64;

export type CallExportFieldsParse =
  | { ok: true; fields: CallExportField[] }
  | { ok: false; invalid: string[]; count: number };

/** One `fields` item, or null when it is of no recognised shape. */
function readField(item: string): CallExportField | null {
  if (isCallExportAnalysisField(item)) return { kind: 'analysis', name: item };
  for (const [prefix, kind] of [
    [AGENCY_CALL_EXPORT_DIMENSION_PREFIX, 'dimension'],
    [AGENCY_CALL_EXPORT_CALL_FIELD_PREFIX, 'call_field'],
  ] as const) {
    if (item.startsWith(prefix)) {
      const key = item.slice(prefix.length);
      return AGENCY_CALL_EXPORT_KEY_PATTERN.test(key) ? { kind, name: item, key } : null;
    }
  }
  return null;
}

/**
 * `?fields=` as the export reads it (CL52): comma-separated or repeated (either form, as every
 * multi-value param), each item trimmed, blanks dropped, a repeat keeping its first place. Each
 * item is an analysis field, or `dim_` / `field_` and a key matching
 * `AGENCY_CALL_EXPORT_KEY_PATTERN`. More than `AGENCY_CALL_EXPORT_MAX_FIELDS`, or an item of any
 * other shape, is refused with the items named (each cut to a name's length). Absent or blank:
 * no fields, and the file is exactly the plain one.
 */
export function parseCallExportFields(raw: unknown): CallExportFieldsParse {
  const items = [...new Set(multiParam(raw) ?? [])];
  const fields: CallExportField[] = [];
  const invalid: string[] = [];
  for (const item of items) {
    const field = readField(item);
    if (field) fields.push(field);
    else invalid.push(item.length > ECHOED_ITEM_MAX_CHARS ? `${item.slice(0, ECHOED_ITEM_MAX_CHARS)}…` : item);
  }
  if (invalid.length > 0 || items.length > AGENCY_CALL_EXPORT_MAX_FIELDS) {
    return { ok: false, invalid, count: items.length };
  }
  return { ok: true, fields };
}

/** The 400 for a refused `fields` (`export_fields_invalid`), in plain words. */
export function callExportFieldsInvalidBody(refused: { invalid: string[]; count: number }): {
  error: string; code: 'export_fields_invalid'; message: string;
  details: { invalid: string[]; count: number; max: number };
} {
  const parts: string[] = [];
  if (refused.invalid.length > 0) {
    parts.push(`These fields cannot be added to the export: ${refused.invalid.join(', ')}.`);
  }
  if (refused.count > AGENCY_CALL_EXPORT_MAX_FIELDS) {
    parts.push(`At most ${AGENCY_CALL_EXPORT_MAX_FIELDS} fields can be added to one export; ${refused.count} were asked for.`);
  }
  return {
    error: 'Validation failed',
    code: 'export_fields_invalid',
    message: parts.join(' '),
    details: { invalid: refused.invalid, count: refused.count, max: AGENCY_CALL_EXPORT_MAX_FIELDS },
  };
}

/** The 403 for analysis or dimension fields asked without the analytics setting (CL47). */
export function callExportFieldsNotPermittedBody(names: readonly string[]): {
  error: string; code: 'export_fields_not_permitted'; message: string; details: { fields: string[] };
} {
  return {
    error: 'Forbidden',
    code: 'export_fields_not_permitted',
    message: `Call analysis is turned off for this campaign's account, so these fields cannot be added to the export: ${names.join(', ')}.`,
    details: { fields: [...names] },
  };
}

// ─── What the fields need (CL47, CL48) ─────────────────────────────────────

/** What a set of chosen fields asks of the export. */
export interface CallExportFieldPlan {
  fields: CallExportField[];
  /** The analysis and dimension fields: behind the campaign's account's analytics setting (CL47). */
  needsAnalysisGrant: string[];
  /** The call log read attaches the media leg's analysis (`include=analysis`). */
  includeAnalysis: boolean;
  /** The call log read attaches the soft-phone call's details (`include=call_fields`). */
  includeCallFields: boolean;
  /** The file's row ceiling: 20,000 with an AI field (CL48), else the export's own 50,000. */
  rowLimit: number;
}

export function planCallExportFields(fields: readonly CallExportField[]): CallExportFieldPlan {
  const needsAnalysisGrant = fields.filter((f) => f.kind !== 'call_field').map((f) => f.name);
  return {
    fields: [...fields],
    needsAnalysisGrant,
    includeAnalysis: needsAnalysisGrant.length > 0,
    includeCallFields: fields.some((f) => f.kind === 'call_field'),
    rowLimit: fields.some((f) => lowersCallExportRowLimit(f.name)) ? AGENCY_CALL_EXPORT_AI_ROW_LIMIT : SPINE_EXPORT_MAX_ROWS,
  };
}

/** The `include` the call log read is asked for, or null when the chosen fields need none. */
export function callExportInclude(plan: CallExportFieldPlan): string | null {
  const kinds = [
    ...(plan.includeAnalysis ? [CALL_LOG_INCLUDE_ANALYSIS] : []),
    ...(plan.includeCallFields ? [CALL_LOG_INCLUDE_CALL_FIELDS] : []),
  ];
  return kinds.length > 0 ? kinds.join(',') : null;
}

// ─── The internal read's extras ────────────────────────────────────────────

export const CALL_LOG_INCLUDE_ANALYSIS = 'analysis';
export const CALL_LOG_INCLUDE_CALL_FIELDS = 'call_fields';
/** `?include=` on the internal call log read: what it attaches to each row as `export_extras`. */
export const CALL_LOG_INCLUDES = [CALL_LOG_INCLUDE_ANALYSIS, CALL_LOG_INCLUDE_CALL_FIELDS] as const;
export type CallLogInclude = (typeof CALL_LOG_INCLUDES)[number];

/**
 * `?include=` read (either form, blanks dropped): the set asked for, or the unknown values. Absent:
 * the empty set, and the read answers exactly as it always has.
 */
export function parseCallLogInclude(raw: unknown): { ok: true; include: Set<CallLogInclude> } | { ok: false; unknown: string[] } {
  const items = multiParam(raw) ?? [];
  const unknown = items.filter((item) => !(CALL_LOG_INCLUDES as readonly string[]).includes(item));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, include: new Set(items as CallLogInclude[]) };
}

/**
 * What the internal read attaches to a row with `include`: its media leg's analysis (status and
 * stored result, null when not asked for, the row has no leg, or the leg is not this account's)
 * and, on a soft-phone row, the call details the agent entered (null on any other row).
 */
export interface CallExportExtras {
  analysis_status: string | null;
  call_analysis: unknown;
  call_fields: Record<string, unknown> | null;
}

/** A media leg's analysis, as the extras lookup reads it. */
export interface CallExportLegAnalysis {
  analysis_status: string | null;
  call_analysis: unknown;
}

/**
 * Put `export_extras` on each row from the page's two lookups: `legs` by the row's
 * `webrtc_call_id`, `callFields` by a soft-phone row's id. A kind that was not asked for is
 * passed as null and leaves its keys null.
 */
export function attachCallExportExtras<R extends { source: string; id: string; webrtc_call_id: string | null }>(
  rows: readonly R[],
  legs: ReadonlyMap<string, CallExportLegAnalysis> | null,
  callFields: ReadonlyMap<string, Record<string, unknown>> | null,
): Array<R & { export_extras: CallExportExtras }> {
  return rows.map((row) => {
    const leg = legs && row.webrtc_call_id ? legs.get(row.webrtc_call_id) : undefined;
    const fields = callFields && row.source === 'soft_phone' ? callFields.get(row.id) : undefined;
    return {
      ...row,
      export_extras: {
        analysis_status: leg?.analysis_status ?? null,
        call_analysis: leg?.call_analysis ?? null,
        call_fields: fields ?? null,
      },
    };
  });
}

// ─── The file (CL43, CL49) ─────────────────────────────────────────────────

/** A row of the export as the drain reads it: the attempt row, with the extras when asked for. */
export type CallExportRow = SpineAttemptRow & { export_extras?: Partial<CallExportExtras> | null };

/** `obj[key]` only when it is the object's own: a key such as `constructor` must not read the prototype. */
function own(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/** The value at `path` in the result. */
function at(result: unknown, path: readonly string[]): unknown {
  let value: unknown = result;
  for (const key of path) value = own(value, key);
  return value;
}

/** The current shape's value (`common.*`, `custom.*`), else the legacy flat one. */
function firstPresent(result: unknown, current: readonly string[], legacy: readonly string[]): unknown {
  const value = at(result, current);
  return value === null || value === undefined ? at(result, legacy) : value;
}

/**
 * One value as a cell (CL49): `true`/`false`, a number as written, text as it is (line breaks
 * kept: `toCsvLine` quotes them), a list joined with `; ` (each item the same way, an object in it
 * as JSON), any other object as JSON, nothing as an empty cell.
 */
export function callExportCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => (item !== null && typeof item === 'object' ? JSON.stringify(item) : callExportCell(item))).join('; ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The stored result, unless the leg's analysis was erased (`deleted`): an erasure leaves nothing to export. */
function storedResult(extras: Partial<CallExportExtras> | null | undefined): unknown {
  return extras?.analysis_status === 'deleted' ? null : extras?.call_analysis ?? null;
}

/** One chosen field's value on a row, before it is a cell. */
export function callExportValue(field: CallExportField, row: CallExportRow): unknown {
  const extras = row.export_extras;
  if (field.kind === 'call_field') {
    return row.source === 'soft_phone' ? own(extras?.call_fields, field.key) : undefined;
  }
  const result = storedResult(extras);
  if (field.kind === 'dimension') return firstPresent(result, ['custom', field.key], ['custom_dimensions', field.key]);
  switch (field.name) {
    case 'analysis_status': return extras?.analysis_status ?? 'none';
    case 'ai_summary': return firstPresent(result, ['common', 'summary'], ['summary']);
    case 'ai_sentiment': return firstPresent(result, ['common', 'overall_sentiment', 'label'], ['overall_sentiment', 'label']);
    case 'ai_sentiment_score': return firstPresent(result, ['common', 'overall_sentiment', 'score'], ['overall_sentiment', 'score']);
    case 'ai_key_topics': return firstPresent(result, ['common', 'key_topics'], ['key_topics']);
  }
}

/** The file's header: today's columns, then the chosen ones in the order asked (CL43). */
export function callExportCsvHeader(fields: readonly CallExportField[]): string {
  return toCsvLine([...ATTEMPT_CSV_COLUMNS, ...fields.map((f) => f.name)]);
}

/** One row: today's cells, then the chosen fields' (CL49), every cell through `toCsvLine`'s guard. */
export function callExportCsvRow(row: CallExportRow, fields: readonly CallExportField[]): string {
  return toCsvLine([...attemptCsvCells(row), ...fields.map((f) => callExportCell(callExportValue(f, row)))]);
}

// ─── The preamble (CL51) ───────────────────────────────────────────────────

/**
 * What the preamble says about the chosen fields: which were added and where, each dimension's
 * newest description (`descriptions`, by key; read from the field list with the file's own
 * filters), the ceiling that applied, what an empty analysis cell means, and that the added
 * columns are customer content. Every value goes through `sanitizePreambleValue`.
 */
export function callExportPreambleLines(input: {
  fields: readonly CallExportField[];
  descriptions: ReadonlyMap<string, string | null>;
  rowLimit: number;
}): string[] {
  const names = input.fields.map((f) => sanitizePreambleValue(f.name));
  const dimensions = input.fields.filter((f): f is Extract<CallExportField, { kind: 'dimension' }> => f.kind === 'dimension');
  const analysed = input.fields.some((f) => f.kind !== 'call_field');
  const lowered = input.rowLimit === AGENCY_CALL_EXPORT_AI_ROW_LIMIT;
  return [
    preambleLine(`Fields added after callback_of, in this order: ${names.join(', ')}`),
    ...dimensions.map((d) => {
      const description = input.descriptions.get(d.key);
      return preambleLine(`${sanitizePreambleValue(d.name)}: ${description
        ? sanitizePreambleValue(description)
        : '(no description: the key is found only in stored results)'}`);
    }),
    preambleLine(lowered
      ? `Row ceiling: ${AGENCY_CALL_EXPORT_AI_ROW_LIMIT.toLocaleString('en-US')} rows, because an AI field was chosen `
        + `(an analysis field other than analysis_status, or a dimension); without one it is ${SPINE_EXPORT_MAX_ROWS.toLocaleString('en-US')}.`
      : `Row ceiling: ${input.rowLimit.toLocaleString('en-US')} rows.`),
    ...(analysed
      ? [preambleLine(
        'analysis_status says why an analysis cell is empty (none: the call had no recording analysed). '
        + 'An empty dimension on a completed call means that call\'s profile did not have it.',
      )]
      : []),
    preambleLine(
      'The added columns are customer content: an AI summary, its topics, sentiment and dimensions are model '
      + 'output from the customer\'s call, and a call detail is what the agent typed. Handle and retain them '
      + 'as you would the call itself.',
    ),
  ];
}

// ─── The field list (`…/call-log/export-fields`, CL45) ─────────────────────

/**
 * The internal field-list read (`GET /agency-campaigns/:id/call-log/export-fields`): how many calls
 * the filters match, the analysis groups when asked for (`include_analysis=1`; `null` when not,
 * and then nothing of the analysis was read), and the call details found on the soft-phone rows.
 */
export interface CallExportFieldsRead {
  calls: number;
  analysis: {
    analysed: number;
    fields: AgencyCallExportAnalysisFieldInfo[];
    dimensions: AgencyCallExportDimensionInfo[];
  } | null;
  call_fields: AgencyCallExportCallFieldInfo[];
}

/** A dimension key as the set-based read aggregates it, before it is normalised. */
export interface RawCallExportDimension {
  key: string;
  types: unknown;
  options: unknown;
  description: string | null;
  calls: number | string;
  sources: unknown;
}

/** A call-field key as the read aggregates it: how many soft-phone calls carry it, and its current definition. */
export interface RawCallExportCallField {
  key: string;
  calls: number | string;
  label: string | null;
  type: string | null;
}

/** Most calls first, then by key (codepoint order, so every runtime sorts alike). */
function byCallsThenKey(a: { calls: number; key: string }, b: { calls: number; key: string }): number {
  if (a.calls !== b.calls) return b.calls - a.calls;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** The read's dimension rows → the contract's entries: types and sources narrowed and ordered, sorted. */
export function toCallExportDimensions(rows: readonly RawCallExportDimension[]): AgencyCallExportDimensionInfo[] {
  return rows.map((row) => {
    const sources = new Set(strings(row.sources));
    return {
      name: `${AGENCY_CALL_EXPORT_DIMENSION_PREFIX}${row.key}`,
      key: row.key,
      types: strings(row.types).filter((t): t is AnalyticsDimensionType => (ANALYTICS_DIMENSION_TYPES as readonly string[]).includes(t)),
      options: strings(row.options),
      description: typeof row.description === 'string' && row.description.trim().length > 0 ? row.description : null,
      calls: Number(row.calls),
      sources: AGENCY_CALL_LOG_TYPES.filter((type) => sources.has(type)),
    };
  }).sort(byCallsThenKey);
}

/** The read's call-field rows → the contract's entries, a label or type the settings no longer hold as null, sorted. */
export function toCallExportCallFields(rows: readonly RawCallExportCallField[]): AgencyCallExportCallFieldInfo[] {
  return rows.map((row) => ({
    name: `${AGENCY_CALL_EXPORT_CALL_FIELD_PREFIX}${row.key}`,
    key: row.key,
    label: typeof row.label === 'string' && row.label.trim().length > 0 ? row.label : null,
    type: row.type !== null && (AGENCY_CALL_FIELD_TYPES as readonly string[]).includes(row.type) ? row.type as AgencyCallFieldType : null,
    calls: Number(row.calls),
  })).sort(byCallsThenKey);
}

/**
 * The public route's answer (`AgencyCallExportFieldsResponse`) from the internal read. Without the
 * analytics setting the analysis groups are empty and `analysed` null, whatever the read held
 * (the public route never asks for them then).
 */
export function toCallExportFieldsResponse(read: CallExportFieldsRead, analysisAvailable: boolean): AgencyCallExportFieldsResponse {
  const analysis = analysisAvailable ? read.analysis : null;
  return {
    calls: read.calls,
    analysis_available: analysisAvailable,
    analysed: analysis ? analysis.analysed : null,
    analysis: analysis ? analysis.fields : [],
    dimensions: analysis ? analysis.dimensions : [],
    call_fields: read.call_fields,
    row_limit: SPINE_EXPORT_MAX_ROWS,
    ai_row_limit: AGENCY_CALL_EXPORT_AI_ROW_LIMIT,
  };
}
