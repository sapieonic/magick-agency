import { parse, type Info } from 'csv-parse';
import { Transform, type Readable } from 'node:stream';
import { normalizePhoneToE164 } from '../utils/phone-normalizer.js';

/**
 * Streaming CSV ingest for Agency Dialer campaign rosters.
 *
 * This is a NEW module deliberately placed beside `contact-lists/csv-parser.ts`,
 * NOT a rewrite of it. The existing parser must absorb none of this module's
 * risk — it stays synchronous, stays capped at
 * 10k rows, and keeps its hardcoded `phone`/`email` header detection. **Nothing
 * here imports it and nothing here changes it**, and that isolation is asserted
 * by a test (`agency-csv-ingest.isolation.test.ts`), because the isolation is
 * the whole risk mitigation.
 *
 * What this one does differently, and why each difference exists:
 *
 *  1. **It streams.** `parseCsv(buffer)` buffers the whole file and then builds
 *     a second full copy as row objects. At the 1M-contact target that is
 *     gigabytes resident on the server. Here the source is a `Readable` consumed as
 *     a stream, and accepted rows are handed to `onBatch` in fixed-size batches,
 *     so peak memory is O(batchSize + distinct phone numbers), not O(file).
 *  2. **The phone column is mapped, not named.** The operator picks any header
 *     in the column-mapping step; nothing requires it to be called `phone`.
 *  3. **Every other column is retained unchanged** — original header text as the
 *     key — because the agent screen renders `agency_contacts.context` as-is
 *     and the roster is deliberately schemaless.
 *  4. **Duplicates are counted and suppressed**, not reduced to one warning
 *     string. Accepted/rejected/duplicate is a required summary that must
 *     visibly reconcile to rows-read, not a nicety.
 *  5. **An invalid phone rejects the row.** The existing parser blanks the cell
 *     and keeps the row, which is right for a mixed phone/email contact list and
 *     wrong for a dialer roster — a contact with no number is not a contact.
 *
 * ── Why it takes a `Readable` and not an S3 key ────────────────────────────
 * The S3 fetch is a thin caller (`agency-ingest.service.ts`). Keeping this
 * module transport-free means the whole fixture matrix runs in the unit tier
 * against an in-memory stream with zero infrastructure — adding an object store
 * to the test stack to exercise a parser would be the tail wagging the dog.
 *
 * ── The one structure that grows with the file ─────────────────────────────
 * `seen` holds every distinct normalised E.164 in the file, because exact
 * in-file dedupe cannot be done in less. It is O(distinct phones), NOT O(file
 * size): a 1M-row file with 40 columns is hundreds of megabytes of CSV but
 * ~1M short strings here. That is the intended trade. If it ever needs to
 * shrink, the replacement is a hash set of 64-bit digests (collision risk
 * ~1e-8 at 1M, and a collision costs one wrongly-suppressed row) — not
 * abandoning exact dedupe.
 *
 * ── INVARIANT: the column-mapping UI must be populated from `dedupeHeaders()` ─
 * Header text is trimmed here (`"First Name "` → `"First Name"`) and repeats
 * are suffixed `(2)`/`(3)`. Those resolved strings become the keys of
 * `agency_contacts.context`, and the campaign's `AgencyContextDisplay`
 * (`hero`/`order`/`hidden`) is matched against those keys **byte-for-byte**.
 *
 * So whatever populates the operator's mapping UI MUST be this module's
 * `dedupeHeaders()` output — today that is `agency-column-analysis.ts`, which
 * calls it. If anyone ever populates that UI from another source (a re-parse
 * with different options, a cached header list, a customer-supplied template),
 * an operator's `hero: ["First Name"]` silently matches nothing: no error, no
 * log, just an agent screen that quietly falls back to unordered columns, months
 * after the change that caused it. `AgencyContextDisplay` carries the matching
 * note.
 *
 * Rejections are NOT accumulated. `errors` is capped for the API response and
 * every rejection is additionally streamed to `onRejected`, so the caller can
 * write a complete rejected-rows report without this module holding a million
 * error objects.
 */

// ─── Limits ─────────────────────────────────────────────────────────────────
// These are published through the ingest-limits metadata route rather than
// hardcoded in the UI, because the wizard must tell the admin the real number
// and a copy of a constant is not the constant.

/** Roster chunk size: 500 rows per `sendRosterChunk` call. */
export const AGENCY_INGEST_BATCH_SIZE = 500;

/**
 * 1M contacts per campaign is the stated scale target. This is a
 * guard-rail against a runaway file, not a product limit — it is 100× the
 * existing parser's cap precisely because that cap is what this module exists
 * to escape.
 */
export const AGENCY_MAX_ROWS = 1_000_000;

/**
 * 40+ arbitrary columns is an explicit requirement and QA's fixture matrix
 * includes a 43-column file, so the existing parser's 50 is far too close to
 * the ask to be a safe ceiling. 100 is double it, comfortably clear of any
 * realistic CRM export, and still bounds the per-row object.
 *
 * This number is load-bearing for QA: the "too many columns"
 * fixture must be built above it.
 */
export const AGENCY_MAX_COLUMNS = 100;

/**
 * Per-cell ceiling. A `context` value is pushed down the station socket on
 * every reservation and rendered on the agent's screen, so an unbounded
 * cell is both a memory problem and a UI one. 8KB is ~2 pages of prose — far
 * beyond any real "Notes" column, far below the 256KB cell that motivated it.
 */
export const AGENCY_MAX_CELL_BYTES = 8 * 1024;

/** Per-row ceiling across all retained columns, for the same reason. */
export const AGENCY_MAX_ROW_BYTES = 64 * 1024;

/** How many rejections are retained inline for the summary response. */
const MAX_ERRORS = 100;

// ─── Error taxonomy ─────────────────────────────────────────────────────────
// Published deliberately and in one place: QA pins the exact code for every
// fixture, so these strings are contract, not implementation detail.

/**
 * Why one row was not ingested. The file is still processed.
 *
 * `dnc_suppressed` is the one code this module never raises itself: the DNC check
 * needs a database and this module is deliberately transport-free (see the header),
 * so `agency-ingest.service.ts` raises it. It lives here because the code set is
 * contract — QA pins the exact string per fixture, and the rejected-rows export
 * and the wizard's summary both read it.
 */
export type AgencyIngestErrorCode =
  | 'missing_phone_value'
  | 'invalid_phone'
  | 'duplicate_phone'
  | 'ragged_row'
  | 'value_too_large'
  | 'row_too_large'
  | 'dnc_suppressed';

/**
 * Why the whole file was unusable. Nothing is ingested.
 *
 * **The wizard's vocabulary**, mirrored member-for-member by the console's
 * `AgencyIngestFailureCode` (`apps/console/src/types/agency-campaign.ts`) — these are the
 * codes the failure screen renders specific copy for.
 *
 * `dnc_unavailable` is the one code this module never raises itself, for the
 * same reason `dnc_suppressed` is above it: the DNC check needs a database and
 * this module is deliberately transport-free, so `agency-ingest.service.ts`
 * raises it. It lives here because the code set is contract.
 *
 * Codes that only the SERVICE can produce, and that the wizard has no specific
 * copy for, are NOT here — see `AgencyIngestJobFailureCode` in
 * `agency-ingest-job.repository.ts`. Keeping them out is what lets
 * `AgencyIngestError` below stay honest: it is thrown by this module, and this
 * module cannot know that the roster hand-off rejected a chunk.
 */
export type AgencyIngestFailureCode =
  | 'malformed_csv'
  | 'phone_column_missing'
  | 'timezone_column_missing'
  | 'too_many_columns'
  | 'too_many_rows'
  | 'unsupported_encoding'
  | 'dnc_unavailable';

/**
 * Marks an error that came out of a CALLER's callback rather than out of parsing.
 *
 * ── The bug this fixes, and it was not hypothetical ─────────────────────────
 * The `catch` at the end of `ingestAgencyCsv` re-labels anything that is not an
 * `AgencyIngestError` as `malformed_csv`. It was written for parser and stream
 * failures, which is right — but `onBatch` and `onRejected` are the CALLER's
 * code, and an error they raise travels the same path. So a caller's own
 * exception came back as "Could not read the CSV", about a file that was fine.
 *
 * Two live consequences, one of them silent:
 *
 *  - the ingest's fail-closed DNC halt threw `DncUnavailableError` from
 *    `onBatch` and arrived at the service as `malformed_csv` — a compliance halt
 *    indistinguishable in logs and dashboards from a bad upload.
 *  - `agency-ingest.service.ts`'s cancel path throws `IngestCancelled` from
 *    `onBatch`, so its `err instanceof IngestCancelled` arm has **never** been
 *    reachable. Cancellation works only because the service also sets a
 *    `cancelled` flag before throwing. Two mechanisms, one of them decorative,
 *    and the decorative one is the one a reader trusts.
 *
 * Marking rather than wrapping, because the caller must receive its own error
 * object — `instanceof` on the far side is the whole point.
 */
const CALLER_ERROR = Symbol('agencyIngestCallerError');

async function fromCaller<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err !== null && typeof err === 'object') {
      Object.defineProperty(err, CALLER_ERROR, { value: true, enumerable: false });
    }
    throw err;
  }
}

function isCallerError(err: unknown): boolean {
  return err !== null && typeof err === 'object' && CALLER_ERROR in err;
}

export class AgencyIngestError extends Error {
  constructor(
    public readonly code: AgencyIngestFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgencyIngestError';
  }
}

/** Human copy for a rejection code. Matches the upload summary's groupings. */
const REJECTION_LABEL: Record<AgencyIngestErrorCode, string> = {
  missing_phone_value: 'Empty phone number',
  invalid_phone: 'Not a valid phone number',
  duplicate_phone: 'Duplicate of an earlier row',
  ragged_row: 'Row does not match the header',
  value_too_large: 'A value is too large',
  row_too_large: 'The row is too large',
  dnc_suppressed: 'On the Do Not Call list',
};

export function rejectionLabel(code: AgencyIngestErrorCode): string {
  return REJECTION_LABEL[code];
}

// ─── Result shapes ──────────────────────────────────────────────────────────

/** One accepted contact, in the shape the roster hand-off (`sendRosterChunk`) expects. */
export interface AgencyIngestContact {
  phone_e164: string;
  /** Every retained non-phone column, original (de-duplicated) header as key. */
  context: Record<string, string>;
  /** 1-based line in the uploaded file on which this record starts. */
  source_row_number: number;
  /** From the mapped timezone column; undefined ⇒ campaign default. */
  timezone?: string;
}

/**
 * One rejected row. Shaped to serve both the API `errors[]` contract
 * (`{ row_number, column, raw_value, reason_code, reason }`) and the
 * rejected-rows CSV export, which needs the original columns back.
 */
export interface AgencyIngestRejection {
  row_number: number;
  /** The mapped column the rejection is about; null for whole-row problems. */
  column: string | null;
  raw_value: string;
  reason_code: AgencyIngestErrorCode;
  reason: string;
  /** The row's retained columns, so the export can reproduce the original line. */
  context: Record<string, string>;
}

export interface AgencyIngestProgress {
  /** Data rows read so far (excludes the header). */
  rows_read: number;
  /** Source bytes consumed so far — the determinate progress signal. */
  bytes_read: number;
}

export interface AgencyIngestSummary {
  /**
   * Header row, as written and in file order, with duplicates suffixed. These are
   * the exact keys `context` uses, so the column mapper must map against these
   * and not against the raw file text.
   */
  headers: string[];
  /**
   * The headers actually written into `context` — every header except the phone
   * column and the `Ignore`d ones. This is the column set the rejected-rows
   * export reproduces, and the set the agent console can expect to render.
   */
  context_columns: string[];
  /** Data rows read (excludes the header; includes rejected and duplicate). */
  rows_read: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  /** First `maxErrors` rejections, for immediate display. */
  errors: AgencyIngestRejection[];
  /** Rejections beyond `maxErrors` and therefore not in `errors`. */
  errors_truncated: number;
  /** Per-reason counts over ALL rejections, for the grouped summary. */
  rejected_by_reason: Record<string, number>;
  /** Source bytes consumed. */
  bytes_read: number;
  /** True when `rowLimit` stopped the read before the end of the file. */
  truncated: boolean;
}

export interface AgencyIngestOptions {
  /** CSV source. An S3 object body in production; an in-memory stream in tests. */
  source: Readable;
  /** Header of the column holding the phone number. Matched case-insensitively. */
  phoneColumn: string;
  /** Optional header of an IANA timezone column. Never inferred. */
  timezoneColumn?: string;
  /**
   * Headers the operator marked `Ignore`. Excluded from `context` **entirely**,
   * enforced here rather than hidden in the client: a field in `context` is a
   * field on an agent's screen the moment anyone changes the render rules, and
   * this is the mechanism that keeps internal scores and PII off that screen.
   */
  ignoreColumns?: string[];
  /**
   * Receives accepted contacts in batches. Awaited, which pauses the source
   * stream — that back-pressure is the mechanism by which a 1M-row file never
   * materialises in memory.
   */
  onBatch?: (contacts: AgencyIngestContact[], progress: AgencyIngestProgress) => Promise<void> | void;
  /** Receives EVERY rejection, including ones past the `errors` cap. */
  onRejected?: (rejection: AgencyIngestRejection) => Promise<void> | void;
  /**
   * Suppress rows whose normalised E.164 already appeared earlier in the file.
   * Default true — the customer asked for duplicate detection by name.
   *
   * **It is an option because it is a judgement call, not an invariant.** Two
   * rows with the same number and different context are legitimate and common:
   * two people behind one company switchboard, a shared family mobile — in
   * exactly the market this targets. With dedupe on, the second person is
   * dropped and it looks like dedupe working correctly, which is a data-loss
   * bug wearing a correctness costume. The contact table deliberately does NOT enforce
   * `UNIQUE (campaign_id, phone_e164)` for that reason; its idempotency
   * constraint is on `(campaign_id, source_row_number)` instead. So this flag
   * controls a *product* behaviour and never an idempotency guarantee — the two
   * must not be conflated, or the customer's "duplicates: 34" stops meaning
   * "your file repeated 34 numbers".
   */
  dedupePhones?: boolean;
  batchSize?: number;
  maxRows?: number;
  maxColumns?: number;
  maxErrors?: number;
  maxCellBytes?: number;
  maxRowBytes?: number;
  /**
   * Country code applied to local-format numbers. This is the **campaign's**
   * default, not the platform's: a campaign of US contacts in local format
   * would otherwise silently become `+91…` — valid E.164, wrong country, and
   * dialed. Callers must pass the campaign value.
   */
  defaultCountryCode?: string;
  /**
   * Stop after this many data rows and report what was read, with
   * `truncated: true`. Powers the preview and the column-sampling pass without
   * reading a 1M-row file.
   */
  rowLimit?: number;
}

/**
 * Rejects a source whose bytes are obviously not UTF-8 CSV before the parser
 * turns them into plausible-looking garbage. A UTF-16 file parses "successfully"
 * into headers full of NULs, the operator's column mapping silently fails to
 * match, and the failure surfaces as "phone column missing" — which is true but
 * useless. Catching the encoding names the actual problem.
 */
export class EncodingGuard extends Transform {
  private checked = false;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    if (!this.checked) {
      this.checked = true;
      const err = detectUnsupportedEncoding(chunk);
      if (err) {
        cb(err);
        return;
      }
    }
    cb(null, chunk);
  }
}

function detectUnsupportedEncoding(head: Buffer): AgencyIngestError | null {
  // UTF-16/UTF-32 byte-order marks.
  if (head.length >= 2) {
    const b0 = head[0]!;
    const b1 = head[1]!;
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
      return new AgencyIngestError(
        'unsupported_encoding',
        'The file looks like UTF-16. Save it as CSV UTF-8 and upload it again.',
      );
    }
  }
  // BOM-less UTF-16 has no marker, but ASCII text in it is interleaved with NUL
  // bytes — and a NUL never appears in a legitimate UTF-8 CSV.
  if (head.subarray(0, 512).includes(0x00)) {
    return new AgencyIngestError(
      'unsupported_encoding',
      'The file contains binary data and is not a UTF-8 CSV. Save it as CSV UTF-8 and upload it again.',
    );
  }
  return null;
}

/**
 * Make headers unique by suffixing repeats ` (2)`, ` (3)`, first occurrence
 * unchanged. `context` is a JSONB object, so two columns called `Notes` would
 * otherwise silently collapse into one — data loss the agent can never detect,
 * on a screen whose entire job is showing the agent what we know about the
 * person on the line.
 */
export function dedupeHeaders(headers: string[]): string[] {
  const counts = new Map<string, number>();
  return headers.map((header) => {
    const key = header.trim().toLowerCase();
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    return seen === 0 ? header.trim() : `${header.trim()} (${seen + 1})`;
  });
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

/**
 * Resolve a mapped column name to its index. Matching is case-insensitive and
 * trim-tolerant because the operator picks the name from a dropdown we populated
 * from these same headers, but the file may round-trip through a spreadsheet
 * that pads them.
 */
function resolveColumn(headers: string[], wanted: string): number {
  const target = normalizeHeader(wanted);
  return headers.findIndex((h) => normalizeHeader(h) === target);
}

/**
 * Stream a CSV into accepted contacts, rejections and a summary.
 *
 * Throws {@link AgencyIngestError} only for whole-file problems. Per-row
 * problems are reported through `onRejected` and the summary counters, and an
 * empty file is a structured zero result, never a throw — the caller decides
 * whether zero rows is an error in its context.
 */
export async function ingestAgencyCsv(options: AgencyIngestOptions): Promise<AgencyIngestSummary> {
  const {
    source,
    phoneColumn,
    timezoneColumn,
    ignoreColumns = [],
    onBatch,
    onRejected,
    batchSize = AGENCY_INGEST_BATCH_SIZE,
    maxRows = AGENCY_MAX_ROWS,
    maxColumns = AGENCY_MAX_COLUMNS,
    maxErrors = MAX_ERRORS,
    maxCellBytes = AGENCY_MAX_CELL_BYTES,
    maxRowBytes = AGENCY_MAX_ROW_BYTES,
    defaultCountryCode,
    rowLimit,
    dedupePhones = true,
  } = options;

  const parser = parse({
    // A spreadsheet export routinely carries a UTF-8 BOM. Without this the first
    // header becomes "﻿Mobile" and the operator's mapping never matches —
    // the exact bug the existing parser still has, left there deliberately.
    bom: true,
    skip_empty_lines: true,
    // Ragged rows are a per-ROW decision below, not a file-level abort: one bad
    // line must not cost the operator the other 999,999.
    relax_column_count: true,
    trim: true,
    // Arrays, not objects: `columns: true` silently collapses duplicate headers,
    // and duplicate headers need suffixing, not collapsing.
    columns: false,
    // Line numbers and byte offsets. `info.lines` is what keeps
    // `source_row_number` correct after a record containing an embedded
    // newline — counting emitted records instead would drift by one line for
    // every multiline row, and every row number after it would be wrong.
    info: true,
  });

  let headers: string[] = [];
  let retainedHeaders: string[] = [];
  let phoneIndex = -1;
  let timezoneIndex = -1;
  const ignored = new Set(ignoreColumns.map(normalizeHeader));

  let rowsRead = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let errorsTruncated = 0;
  let bytesRead = 0;
  let truncated = false;
  const errors: AgencyIngestRejection[] = [];
  const rejectedByReason: Record<string, number> = {};

  // See the module header: O(distinct phones), and deliberately so.
  const seen = new Set<string>();
  let batch: AgencyIngestContact[] = [];

  // `info.lines` is the line on which the current record ENDS. The line it
  // STARTS on is what a spreadsheet shows the operator, so track the previous
  // record's end and add one.
  let previousEndLine = 0;

  async function reject(rejection: AgencyIngestRejection): Promise<void> {
    rejected += 1;
    rejectedByReason[rejection.reason_code] = (rejectedByReason[rejection.reason_code] ?? 0) + 1;
    if (errors.length < maxErrors) {
      errors.push(rejection);
    } else {
      errorsTruncated += 1;
    }
    if (onRejected) await fromCaller(() => onRejected(rejection));
  }

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const outgoing = batch;
    batch = [];
    if (onBatch) {
      await fromCaller(() => onBatch(outgoing, { rows_read: rowsRead, bytes_read: bytesRead }));
    }
  }

  // `pipe` does NOT forward errors downstream, so an encoding rejection raised
  // in the guard would surface as an unhandled error while the `for await`
  // below waited forever for data that is never coming. Forward explicitly so
  // the failure arrives where it is caught.
  const guard = new EncodingGuard();
  source.on('error', (err) => guard.destroy(err));
  guard.on('error', (err) => parser.destroy(err));
  const stream = source.pipe(guard).pipe(parser);

  try {
    // `for await` applies back-pressure: while this body awaits `onBatch`, the
    // parser and the underlying source stay paused. That is the mechanism by
    // which a 1M-row file never materialises in memory — not an optimisation.
    for await (const item of stream as AsyncIterable<{ info: Info; record: string[] }>) {
      const { info, record } = item;
      bytesRead = info.bytes;
      const startLine = previousEndLine + 1;
      previousEndLine = info.lines;

      // ── Header row ──────────────────────────────────────────────────────
      if (headers.length === 0) {
        if (record.length > maxColumns) {
          throw new AgencyIngestError(
            'too_many_columns',
            `The file has ${record.length} columns. The maximum is ${maxColumns}.`,
          );
        }

        headers = dedupeHeaders(record);

        // A replacement character in a HEADER is fatal: headers are the keys the
        // operator maps against and the keys `context` is written with, so a
        // mangled one is unmappable and unrenderable. The same character inside
        // a data cell is tolerated — see the row loop — because rejecting a
        // million-row file over one accented name in row 900,000 is worse than
        // showing the agent a slightly mangled one.
        if (headers.some((h) => h.includes('�'))) {
          throw new AgencyIngestError(
            'unsupported_encoding',
            'The column headers contain characters that are not valid UTF-8. Save the file as CSV UTF-8 and upload it again.',
          );
        }

        phoneIndex = resolveColumn(headers, phoneColumn);
        if (phoneIndex === -1) {
          throw new AgencyIngestError(
            'phone_column_missing',
            `The selected phone column '${phoneColumn}' is not in the file.`,
          );
        }

        if (timezoneColumn !== undefined) {
          timezoneIndex = resolveColumn(headers, timezoneColumn);
          if (timezoneIndex === -1) {
            throw new AgencyIngestError(
              'timezone_column_missing',
              `The selected timezone column '${timezoneColumn}' is not in the file.`,
            );
          }
        }

        retainedHeaders = headers.filter(
          (h, i) => i !== phoneIndex && !ignored.has(normalizeHeader(h)),
        );
        continue;
      }

      if (rowLimit !== undefined && rowsRead >= rowLimit) {
        truncated = true;
        break;
      }

      rowsRead += 1;
      if (rowsRead > maxRows) {
        throw new AgencyIngestError(
          'too_many_rows',
          `The file has more than ${maxRows.toLocaleString()} rows. Split it into smaller campaigns.`,
        );
      }

      const rawPhone = record[phoneIndex]?.trim() ?? '';

      // Build `context` from the retained columns only. A short row pads with
      // empty strings (see below), so index past the end is expected and fine.
      const context: Record<string, string> = {};
      let rowBytes = 0;
      let oversizeColumn: string | null = null;
      for (let i = 0; i < headers.length; i += 1) {
        const header = headers[i]!;
        if (i === phoneIndex || ignored.has(normalizeHeader(header))) continue;
        const value = record[i]?.trim() ?? '';
        const valueBytes = Buffer.byteLength(value, 'utf8');
        if (valueBytes > maxCellBytes && oversizeColumn === null) oversizeColumn = header;
        rowBytes += valueBytes;
        context[header] = value;
      }

      // ── Per-row rejections, in the order that gives the best message ─────

      // MORE fields than the header means the row is misaligned — almost always
      // an unquoted comma inside a value — so the cell we read as the phone
      // number may be some other column's data. Rejecting is the safe read:
      // accepting risks dialing a number parsed out of the wrong field.
      // FEWER fields is benign (a trailing empty column) and pads, so it falls
      // through to normal validation.
      if (record.length > headers.length) {
        await reject({
          row_number: startLine,
          column: null,
          raw_value: rawPhone,
          reason_code: 'ragged_row',
          reason: `Row has ${record.length} values but the header has ${headers.length} columns — check for an unquoted comma.`,
          context,
        });
        continue;
      }

      if (oversizeColumn !== null) {
        await reject({
          row_number: startLine,
          column: oversizeColumn,
          raw_value: rawPhone,
          reason_code: 'value_too_large',
          reason: `The value in '${oversizeColumn}' is larger than ${maxCellBytes} bytes.`,
          context: {},
        });
        continue;
      }

      if (rowBytes > maxRowBytes) {
        await reject({
          row_number: startLine,
          column: null,
          raw_value: rawPhone,
          reason_code: 'row_too_large',
          reason: `The row is larger than ${maxRowBytes} bytes across its columns.`,
          context: {},
        });
        continue;
      }

      if (rawPhone === '') {
        await reject({
          row_number: startLine,
          column: headers[phoneIndex]!,
          raw_value: '',
          reason_code: 'missing_phone_value',
          reason: `No value in the '${headers[phoneIndex]}' column.`,
          context,
        });
        continue;
      }

      const phoneE164 = normalizePhoneToE164(
        rawPhone,
        defaultCountryCode ? { defaultCountryCode } : {},
      );
      if (phoneE164 === null) {
        await reject({
          row_number: startLine,
          column: headers[phoneIndex]!,
          raw_value: rawPhone,
          reason_code: 'invalid_phone',
          reason: `'${rawPhone}' is not a valid phone number.`,
          context,
        });
        continue;
      }

      // Dedupe on the NORMALISED number, so `09876543210`, `+91 98765 43210`
      // and `9876543210` are one contact rather than three calls to one person.
      // See `dedupePhones` for why this is switchable.
      if (dedupePhones && seen.has(phoneE164)) {
        duplicates += 1;
        await reject({
          row_number: startLine,
          column: headers[phoneIndex]!,
          raw_value: rawPhone,
          reason_code: 'duplicate_phone',
          reason: `${phoneE164} already appears earlier in this file.`,
          context,
        });
        continue;
      }
      seen.add(phoneE164);

      const timezone =
        timezoneIndex === -1 ? undefined : record[timezoneIndex]?.trim() || undefined;

      batch.push({
        phone_e164: phoneE164,
        context,
        source_row_number: startLine,
        ...(timezone !== undefined ? { timezone } : {}),
      });
      accepted += 1;

      if (batch.length >= batchSize) await flush();
    }

    await flush();
  } catch (err) {
    // Stop pulling from S3 the moment the file is known to be unusable rather
    // than paying for the rest of the transfer.
    source.destroy();
    if (err instanceof AgencyIngestError) throw err;
    // The caller's own error, unchanged. Only failures originating in THIS
    // module's parsing get classified below.
    if (isCallerError(err)) throw err;
    throw new AgencyIngestError(
      'malformed_csv',
      `Could not read the CSV: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  return {
    // An empty file yields empty headers and zero rows rather than throwing:
    // "this file has nothing in it" is a result the wizard renders, not an
    // exception it has to catch. Same for a header-only file, which resolves
    // its columns normally and simply reads no rows.
    headers,
    context_columns: retainedHeaders,
    rows_read: rowsRead,
    accepted,
    rejected,
    duplicates,
    errors,
    errors_truncated: errorsTruncated,
    rejected_by_reason: rejectedByReason,
    bytes_read: bytesRead,
    truncated,
  };
}
