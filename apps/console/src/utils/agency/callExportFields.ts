import {
  AGENCY_CALL_EXPORT_ANALYSIS_FIELDS,
  AGENCY_CALL_EXPORT_MAX_FIELDS,
  lowersCallExportRowLimit,
  type AgencyCallExportAnalysisField,
  type AgencyCallExportCallFieldInfo,
  type AgencyCallExportDimensionInfo,
  type AgencyCallExportFieldsResponse,
} from '@magick-agency/contracts/api/agency/call-export-fields';
import type { AgencyCallFieldType } from '@magick-agency/contracts/agency';
import type { AgencyAttemptFilters } from '../../types/agency-spine';
import {
  AGENCY_CALLS_TYPE_FILTER_LABELS,
  AGENCY_CALL_LOG_TYPE_LABELS,
  type AgencyCallLogStatus,
  type AgencyCallLogTypeFilter,
} from '../../types/agency-call-log';
import { formatDayMonth } from '../format/date';
import { formatCount, plural } from '../format/number';
import { errorCode } from '../agencyErrors';
import { humaniseCode } from '../agencyCatalogSync';
import { DIMENSION_TYPE_LABELS } from '../analysisDimensionTypes';
import { CALL_FIELD_TYPE_LABELS } from '../softphone/fieldSettings';

/**
 * Export with fields (`docs/call-log.md` §10, rulings CL43–CL52): the rules the campaign Call
 * log's dialog is drawn by. Pure: the dialog (`components/agency/callLog/ExportFieldsDialog`)
 * renders what these return, and the storage of a remembered choice is
 * `callExportFieldsStore.ts`.
 */

// ─── The query ───────────────────────────────────────────────────────────────

/** The Call log's export query: its filters, the soft-phone status and the chip as `source`. */
export type CallLogExportQuery = Record<string, string | string[] | undefined>;

/**
 * What the campaign call export is asked for: the list's filters (the dates among them), its
 * soft-phone status, and its chip as the export's `source` (`all` is no `source`). The ONE
 * builder: the plain Export CSV, Export with fields' download and its field list
 * (`getCallExportFields`) all read it, so the dialog can never offer fields for other calls than the file holds.
 */
export function callLogExportQuery(
  filters: AgencyAttemptFilters,
  view: { type: AgencyCallLogTypeFilter; status: AgencyCallLogStatus | null },
): CallLogExportQuery {
  return {
    ...(filters as CallLogExportQuery),
    ...(view.status ? { status: view.status } : {}),
    ...(view.type !== 'all' ? { source: view.type } : {}),
  };
}

// ─── Words ───────────────────────────────────────────────────────────────────

/**
 * A dimension's type in words, its option's second line: "Choice: firm, vague, none", "Yes / No",
 * "Number", "Text"; a key a profile changed the type of, "Changed type: Text, then Choices"; a key
 * found only in stored results, "Found in stored results".
 */
export function dimensionTypeWords(dimension: Pick<AgencyCallExportDimensionInfo, 'types' | 'options'>): string {
  const { types, options } = dimension;
  if (types.length === 0) return 'Found in stored results';
  if (types.length > 1) return `Changed type: ${types.map((t) => DIMENSION_TYPE_LABELS[t] ?? t).join(', then ')}`;
  const only = types[0]!;
  if (only === 'enum' && options.length > 0) return `Choice: ${options.join(', ')}`;
  return DIMENSION_TYPE_LABELS[only] ?? only;
}

/** A call field's type in words; a field the soft phone no longer has says so. */
export function callFieldTypeWords(type: AgencyCallFieldType | null): string {
  if (type === null) return 'No longer in the soft phone’s call details';
  return CALL_FIELD_TYPE_LABELS[type] ?? type;
}

/**
 * A call field's name in the dialog: the soft phone's label, else its key as words (a field the
 * soft phone no longer has).
 */
export function callFieldLabel(field: Pick<AgencyCallExportCallFieldInfo, 'key' | 'label'>): string {
  const label = field.label?.trim();
  return label ? label : humaniseCode(field.key);
}

/** The analysis's common fields as the dialog names them, with a hint where one helps. */
export const CALL_EXPORT_ANALYSIS_COPY: Readonly<Record<AgencyCallExportAnalysisField, { label: string; hint?: string }>> = {
  analysis_status: { label: 'Analysis status', hint: 'Says why a row has no analysis' },
  ai_summary: { label: 'Summary', hint: 'A few sentences per call' },
  ai_sentiment: { label: 'Sentiment', hint: 'Positive, neutral, negative or mixed' },
  ai_sentiment_score: { label: 'Sentiment score' },
  ai_key_topics: { label: 'Key topics', hint: 'Joined with “; ”' },
};

/** What the file always has, said in the dialog's first group. */
export const CALL_EXPORT_ALWAYS_NOTE =
  'Call, contact, agent, outcome, notes, callback, promise to pay, times, talk and wrap-up, '
  + 'call type, and an inbound call’s wait and missed reason.';

/** Said in place of the analysis groups when the account's analytics setting is off (CL47). */
export const CALL_EXPORT_ANALYSIS_OFF_NOTE = 'Call analysis is off for this account, so its fields can’t be added.';

/** Under Download CSV while nothing is ticked: the plain file is the split button's main part. */
export const CALL_EXPORT_NOTHING_CHOSEN_HINT = 'Tick at least one field, or use Export CSV for the usual file.';

/** The file's usual columns as the preview shows them: the first two, then the last two. */
export const CALL_EXPORT_BASE_COLUMNS_PREVIEW = 'attempt_id, contact_id, … missed_reason, callback_of';

// ─── The groups ──────────────────────────────────────────────────────────────

type CallExportGroupId = 'call_fields' | 'analysis' | 'dimensions';

/** One field the dialog offers. */
interface CallExportOption {
  /** The column, and what `fields` sends. */
  name: string;
  label: string;
  /** The second line (a type in words, a hint), or null. */
  detail: string | null;
  /** Calls with a value for it. */
  calls: number;
  /** A dimension found on one call type only: that type's label ("Inbound"). */
  badge: string | null;
  /** A dimension's newest description, for its tooltip. */
  description: string | null;
}

export interface CallExportGroup {
  id: CallExportGroupId;
  title: string;
  hint: string | null;
  options: CallExportOption[];
}

function callFieldOption(field: AgencyCallExportCallFieldInfo): CallExportOption {
  return {
    name: field.name,
    label: callFieldLabel(field),
    detail: callFieldTypeWords(field.type),
    calls: field.calls,
    badge: null,
    description: null,
  };
}

function dimensionOption(dimension: AgencyCallExportDimensionInfo): CallExportOption {
  const only = dimension.sources.length === 1 ? dimension.sources[0]! : null;
  return {
    name: dimension.name,
    // A key as words (CL44: a dimension has no label): `promise_strength` → "Promise strength".
    label: humaniseCode(dimension.key),
    detail: dimensionTypeWords(dimension),
    calls: dimension.calls,
    badge: only ? AGENCY_CALL_LOG_TYPE_LABELS[only] ?? null : null,
    description: dimension.description,
  };
}

/**
 * The dialog's groups, in order (Call details the agent entered, Call analysis, Custom
 * dimensions), each option in the order it is shown. A group with nothing to offer is left out.
 * With the analytics setting off the analysis groups are left out whatever the response holds
 * (CL47); the dialog says why ({@link CALL_EXPORT_ANALYSIS_OFF_NOTE}).
 *
 * The analysis fields follow {@link AGENCY_CALL_EXPORT_ANALYSIS_FIELDS}' order; dimensions and
 * call fields keep the server's (most calls first, then by key).
 */
export function callExportGroups(response: AgencyCallExportFieldsResponse): CallExportGroup[] {
  const groups: CallExportGroup[] = [];
  if (response.call_fields.length > 0) {
    groups.push({
      id: 'call_fields',
      title: 'Call details the agent entered',
      hint: 'Soft-phone calls only',
      options: response.call_fields.map(callFieldOption),
    });
  }
  if (!response.analysis_available) return groups;
  const byName = new Map(response.analysis.map((field) => [field.name, field]));
  const analysis = AGENCY_CALL_EXPORT_ANALYSIS_FIELDS
    .filter((name) => byName.has(name))
    .map((name): CallExportOption => ({
      name,
      label: CALL_EXPORT_ANALYSIS_COPY[name].label,
      detail: CALL_EXPORT_ANALYSIS_COPY[name].hint ?? null,
      calls: byName.get(name)!.calls,
      badge: null,
      description: null,
    }));
  if (analysis.length > 0) {
    groups.push({
      id: 'analysis',
      title: 'Call analysis',
      hint: `${formatCount(response.analysed ?? 0)} of ${plural(response.calls, 'call')} analysed`,
      options: analysis,
    });
  }
  if (response.dimensions.length > 0) {
    groups.push({
      id: 'dimensions',
      title: 'Custom dimensions',
      hint: null,
      options: response.dimensions.map(dimensionOption),
    });
  }
  return groups;
}

/** Every name the groups offer, in display order. */
export function offeredFieldNames(groups: readonly CallExportGroup[]): string[] {
  return groups.flatMap((group) => group.options.map((option) => option.name));
}

/**
 * The chosen fields in the dialog's display order (group order, then option order): the order
 * the preview shows them and the order `fields` sends, so the file's columns read as the dialog
 * did. A chosen name the groups do not offer is dropped.
 */
export function orderedChosenFields(groups: readonly CallExportGroup[], chosen: ReadonlySet<string>): string[] {
  return offeredFieldNames(groups).filter((name) => chosen.has(name));
}

/**
 * A remembered choice against what this view offers (CL50): the remembered fields this view
 * offers are ticked. The others are not lost: {@link rememberedFieldsToStore} keeps them for a
 * later view that offers them. Nothing remembered ticks nothing.
 */
export function rememberedStillOffered(remembered: readonly string[] | null, groups: readonly CallExportGroup[]): Set<string> {
  if (!remembered || remembered.length === 0) return new Set();
  const offered = new Set(offeredFieldNames(groups));
  return new Set(remembered.filter((name) => offered.has(name)));
}

/**
 * What a Download with Remember on stores (CL50): the fields chosen now, in the order sent, then
 * the remembered fields this view did not offer (a dimension the current dates do not hold), so
 * they are ticked again when a later view offers them. A field this view offers and the person
 * left unticked is not kept: unticking it is how it is forgotten. At most
 * `AGENCY_CALL_EXPORT_MAX_FIELDS`, the newest choice first, so the oldest unoffered names go first.
 */
export function rememberedFieldsToStore(
  chosen: readonly string[],
  remembered: readonly string[] | null,
  groups: readonly CallExportGroup[],
): string[] {
  const offered = new Set(offeredFieldNames(groups));
  const kept = (remembered ?? []).filter((name) => !offered.has(name));
  return [...new Set([...chosen, ...kept])].slice(0, AGENCY_CALL_EXPORT_MAX_FIELDS);
}

/**
 * The ceiling note (CL48): with a field that lowers the ceiling chosen, the file's limit, and
 * when this view holds more calls than that, how to get the rest. Null with none chosen. The
 * numbers are the response's.
 */
export function callExportCeilingNote(
  chosen: readonly string[],
  response: Pick<AgencyCallExportFieldsResponse, 'calls' | 'ai_row_limit'>,
): { limit: string; overLimit: string | null } | null {
  if (!chosen.some(lowersCallExportRowLimit)) return null;
  return {
    limit: `With AI fields the file holds at most ${formatCount(response.ai_row_limit)} rows.`,
    overLimit: response.calls > response.ai_row_limit
      ? `This view has ${formatCount(response.calls)} calls: narrow the dates to get the rest.`
      : null,
  };
}

// ─── The subtitle ────────────────────────────────────────────────────────────

/**
 * The dates the export follows, in words: "20 Nov", "20 Nov to 27 Nov", "from 20 Nov",
 * "up to 27 Nov", "every date", written to sit mid-sentence (the subtitle capitalises its start).
 * To follow up is every open missed call whatever the dates (CL14).
 */
export function callExportDatesWords(filters: Pick<AgencyAttemptFilters, 'from' | 'to'>, type: AgencyCallLogTypeFilter): string {
  if (type === 'to_follow_up') return 'whatever the dates';
  const day = (iso: string | undefined): string | null => {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : formatDayMonth(date);
  };
  const from = day(filters.from);
  const to = day(filters.to);
  if (from && to) return from === to ? from : `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `up to ${to}`;
  return 'every date';
}

/** The chip as the subtitle names it: "all call types", "Dialler", "To follow up". */
export function callExportTypeWords(type: AgencyCallLogTypeFilter): string {
  return type === 'all' ? 'all call types' : AGENCY_CALLS_TYPE_FILTER_LABELS[type];
}

/** "4,812 calls · 20 Nov to 27 Nov · Dialler"; before the count is known, "Every date · all call types". */
export function callExportSubtitle(calls: number | null, dates: string, type: string): string {
  const line = [calls === null ? null : plural(calls, 'call'), dates, type]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/** 403 `export_fields_not_permitted`: the analytics setting went off while the dialog was open. */
export const EXPORT_FIELDS_NOT_PERMITTED_COPY = 'Call analysis is off for this account, so its fields can’t be exported.';
/** 400 `export_fields_invalid`: a field this console sent the server does not take. */
export const EXPORT_FIELDS_INVALID_COPY = 'One of the chosen fields can’t be exported. Close this and open Export with fields again.';

/** The sentence for a refused download with fields, or null for any other failure. */
export function callExportFieldsRefusal(err: unknown): string | null {
  const code = errorCode(err);
  if (code === 'export_fields_not_permitted') return EXPORT_FIELDS_NOT_PERMITTED_COPY;
  if (code === 'export_fields_invalid') return EXPORT_FIELDS_INVALID_COPY;
  return null;
}
