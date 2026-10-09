import { parse, type Info } from 'csv-parse';
import { Transform, type Readable } from 'node:stream';
import { normalizePhoneToE164 } from '../utils/phone-normalizer.js';
import {
  AgencyIngestError,
  EncodingGuard,
  dedupeHeaders,
  AGENCY_MAX_COLUMNS,
} from './agency-csv-ingest.js';

/**
 * The read that powers the column-mapping screen — the most important screen in
 * the upload wizard, because the phone column will not be called `phone`
 * and picking the wrong one dials the wrong people.
 *
 * It is a separate pass from {@link ingestAgencyCsv} for one structural reason:
 * the ingest requires a phone column to already be chosen, and this is the pass
 * that helps choose it. It reads a bounded prefix of the file (not the whole
 * thing) because it only has to populate a dropdown and three sample values per
 * column.
 *
 * ── Why scoring reads values and not just headers ──────────────────────────
 * A realistic file has `Mobile`, `Alt Mobile` and `Ref No`. Header text
 * alone cannot separate those, and `Ref No` may well hold ten-digit integers
 * that normalise cleanly. So each column is scored on the **proportion of
 * sampled rows whose value parses to E.164**, with header text used only as a
 * tie-breaking nudge. A suggestion is returned, never applied: the operator
 * confirms it.
 */

/** Rows read to build samples and score columns. */
const ANALYSIS_ROW_SAMPLE = 200;

/** Sample values shown per column on the mapping screen. */
const SAMPLE_VALUES_PER_COLUMN = 3;

/**
 * If the two best-scoring columns are within this margin, nothing is
 * preselected and the UI shows "Two columns look like phone numbers — pick
 * one." Guessing wrong here is not a cosmetic error.
 */
const PHONE_TIE_MARGIN = 0.1;

/** Headers that suggest a phone column. */
const PHONE_HEADER_HINT = /(phone|mobile|cell|contact|msisdn|number|tel)/i;

/**
 * Weight of a phone-ish header, deliberately set just ABOVE {@link PHONE_TIE_MARGIN}
 * so it can decide a tie between columns whose values score identically.
 *
 * That sounds like letting header text dominate, and it is worth being precise
 * about why it does not. The bonus only changes an outcome when exactly ONE
 * candidate's header looks like a phone column: in the hard case —
 * `Mobile` vs `Alt Mobile`, both full of valid numbers — both match the hint,
 * the bonus cancels, and the tie stands so the operator chooses. What it does
 * resolve is `Mobile` vs `Ref No` where `Ref No` happens to hold ten-digit
 * integers that normalise cleanly; there, the header is genuinely the only
 * signal that separates them, and a suggestion the operator can see and
 * override is more useful than a shrug.
 */
const PHONE_HEADER_BONUS = 0.15;

export interface AgencyColumnStat {
  /** Header text, de-duplicated exactly as the ingest will write it. */
  name: string;
  /** Position in the file, 0-based. */
  index: number;
  /** Up to three non-empty sample values, in file order. */
  samples: string[];
  /** Rows sampled that had a non-empty value in this column. */
  non_empty: number;
  /** Proportion of NON-EMPTY sampled values that parse to E.164, 0..1. */
  phone_score: number;
}

export interface AgencyColumnAnalysis {
  headers: string[];
  columns: AgencyColumnStat[];
  /** Data rows sampled (bounded; not the file's row count). */
  rows_sampled: number;
  /** True when the file has more rows than were sampled. */
  truncated: boolean;
  /**
   * Best-guess phone column, or null when two columns are too close to call.
   * A suggestion for the UI to preselect — never applied on the server.
   */
  suggested_phone_column: string | null;
  /** True when the suggestion was withheld because of a near-tie. */
  phone_column_ambiguous: boolean;
  /** The columns that tied, when ambiguous — so the UI can name them. */
  phone_column_candidates: string[];
}

class HeadTruncator extends Transform {
  private seen = 0;
  constructor(private readonly limitBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    if (this.seen >= this.limitBytes) {
      cb();
      return;
    }
    const remaining = this.limitBytes - this.seen;
    this.seen += chunk.length;
    cb(null, chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  }
}

export interface AnalyzeOptions {
  source: Readable;
  rowSample?: number;
  maxColumns?: number;
  /** Country code used when scoring local-format numbers. */
  defaultCountryCode?: string;
  /**
   * Byte ceiling on the prefix read. Guards against a file whose first "row" is
   * a single unterminated 500MB line.
   */
  maxBytes?: number;
}

export async function analyzeAgencyCsvColumns(options: AnalyzeOptions): Promise<AgencyColumnAnalysis> {
  const {
    source,
    rowSample = ANALYSIS_ROW_SAMPLE,
    maxColumns = AGENCY_MAX_COLUMNS,
    defaultCountryCode,
    maxBytes = 16 * 1024 * 1024,
  } = options;

  const parser = parse({
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    columns: false,
    info: true,
  });

  let headers: string[] = [];
  const samples: string[][] = [];
  const nonEmpty: number[] = [];
  const phoneParsed: number[] = [];
  let rowsSampled = 0;
  let truncated = false;

  // The SAME encoding guard the ingest uses, and it matters more here than
  // there: this is the wizard's FIRST call, and a UTF-16 file without it parses
  // into headers full of NULs that the operator is then invited to map a phone
  // column against. Catching it at ingest instead would mean the operator had
  // already picked columns from garbage.
  const guard = new EncodingGuard();
  const truncator = new HeadTruncator(maxBytes);
  source.on('error', (err) => guard.destroy(err));
  guard.on('error', (err) => truncator.destroy(err));
  truncator.on('error', (err) => parser.destroy(err));
  const stream = source.pipe(guard).pipe(truncator).pipe(parser);

  try {
    for await (const item of stream as AsyncIterable<{ info: Info; record: string[] }>) {
      const { record } = item;

      if (headers.length === 0) {
        if (record.length > maxColumns) {
          throw new AgencyIngestError(
            'too_many_columns',
            `The file has ${record.length} columns. The maximum is ${maxColumns}.`,
          );
        }
        headers = dedupeHeaders(record);
        for (let i = 0; i < headers.length; i += 1) {
          samples.push([]);
          nonEmpty.push(0);
          phoneParsed.push(0);
        }
        continue;
      }

      if (rowsSampled >= rowSample) {
        truncated = true;
        break;
      }
      rowsSampled += 1;

      for (let i = 0; i < headers.length; i += 1) {
        const value = record[i]?.trim() ?? '';
        if (value === '') continue;
        nonEmpty[i] = (nonEmpty[i] ?? 0) + 1;
        if (samples[i]!.length < SAMPLE_VALUES_PER_COLUMN) samples[i]!.push(value);
        if (normalizePhoneToE164(value, defaultCountryCode ? { defaultCountryCode } : {}) !== null) {
          phoneParsed[i] = (phoneParsed[i] ?? 0) + 1;
        }
      }
    }
  } catch (err) {
    source.destroy();
    if (err instanceof AgencyIngestError) throw err;
    throw new AgencyIngestError(
      'malformed_csv',
      `Could not read the CSV: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  } finally {
    source.destroy();
  }

  const columns: AgencyColumnStat[] = headers.map((name, index) => ({
    name,
    index,
    samples: samples[index] ?? [],
    non_empty: nonEmpty[index] ?? 0,
    // Scored over non-empty values only: a column that is 90% blank but always
    // holds a valid number when populated is still a phone column.
    phone_score: (nonEmpty[index] ?? 0) === 0 ? 0 : (phoneParsed[index] ?? 0) / (nonEmpty[index] ?? 1),
  }));

  const suggestion = suggestPhoneColumn(columns);

  return {
    headers,
    columns,
    rows_sampled: rowsSampled,
    truncated,
    ...suggestion,
  };
}

/**
 * Pick the phone column, or decline to. Exported for direct testing because the
 * tie rule is the part with real consequences.
 */
export function suggestPhoneColumn(columns: AgencyColumnStat[]): {
  suggested_phone_column: string | null;
  phone_column_ambiguous: boolean;
  phone_column_candidates: string[];
} {
  // A column nothing parses out of is not a candidate at any margin.
  const scored = columns
    .filter((c) => c.phone_score > 0 && c.non_empty > 0)
    .map((c) => ({
      column: c,
      effective: c.phone_score + (PHONE_HEADER_HINT.test(c.name) ? PHONE_HEADER_BONUS : 0),
    }))
    .sort((a, b) => b.effective - a.effective);

  if (scored.length === 0) {
    return { suggested_phone_column: null, phone_column_ambiguous: false, phone_column_candidates: [] };
  }

  const best = scored[0]!;
  const runnerUp = scored[1];

  if (runnerUp && best.effective - runnerUp.effective < PHONE_TIE_MARGIN) {
    // Withhold rather than guess. The UI says "Two columns look like phone
    // numbers — pick one" and the operator decides.
    return {
      suggested_phone_column: null,
      phone_column_ambiguous: true,
      phone_column_candidates: scored
        .filter((s) => best.effective - s.effective < PHONE_TIE_MARGIN)
        .map((s) => s.column.name),
    };
  }

  return {
    suggested_phone_column: best.column.name,
    phone_column_ambiguous: false,
    phone_column_candidates: [best.column.name],
  };
}
