import { parse, type Info } from 'csv-parse';
import { Transform, type Readable } from 'node:stream';
import { normalizePhoneToE164 } from '../utils/phone-normalizer.js';
import { unguardFormulaSigil } from './agency-csv.js';
import { dedupeKeyName } from '@magick-agency/contracts/api/agency/agency-campaign';

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
 *     so this pass holds O(batchSize + distinct duplicate keys), not O(file).
 *     Its callers add their own, bounded or not: the ingest service keeps up to
 *     `MAX_EXPORT_ROWS` (50k) rejected and 50k skipped rows, each with its columns,
 *     for the downloads, and the screen for a column key holds every key of the
 *     campaign's roster (O(contacts already in the campaign);
 *     `agency-ingest-screen.ts`). A check runs the same pass, so it costs the same.
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
 * `dnc_suppressed` is raised from the caller's `screen` answer: the DNC lookup
 * needs a database and this module is deliberately transport-free (see the header),
 * so the caller asks the list and this module settles the row (before its key is
 * claimed, IM4). The code set is contract — QA pins the exact string per fixture,
 * and the rejected-rows export and the wizard's summary both read it.
 */
export type AgencyIngestErrorCode =
  | 'missing_phone_value'
  | 'invalid_phone'
  | 'duplicate_phone'
  | 'duplicate_key'
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
  | 'dedupe_column_missing'
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
 * exception came back as "Could not read the file" (`malformed_csv`), about a file that was fine.
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

/**
 * The words of the whole-file limits, shared by the ingest, the column analysis and the
 * upload's Excel conversion (IM8), which refuses a workbook over them before storing it.
 * "The file", never "the CSV": an Excel upload reaches these too. Numbers are grouped the
 * Indian way (`10,00,000`), as the console shows the same limits.
 */
export const AGENCY_LIMIT_MESSAGES = {
  tooManyRows: (maxRows: number): string =>
    `The file has more than ${maxRows.toLocaleString('en-IN')} rows. Split it into smaller campaigns.`,
  tooManyColumns: (columns: number, maxColumns: number): string =>
    `The file has ${columns.toLocaleString('en-IN')} columns. The maximum is ${maxColumns.toLocaleString('en-IN')}.`,
};

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
  duplicate_key: 'Duplicate of an earlier row (same value in the duplicate column)',
  ragged_row: 'Row does not match the header',
  value_too_large: 'A value is too large',
  row_too_large: 'The row is too large',
  dnc_suppressed: 'On the Do Not Call list',
};

export function rejectionLabel(code: AgencyIngestErrorCode): string {
  return REJECTION_LABEL[code];
}

/**
 * Why a row was SKIPPED rather than rejected: nothing is wrong with it, the campaign
 * already holds it (IM3). Not an error code, so not in {@link AgencyIngestErrorCode},
 * and a skipped row is counted in `skipped`, never in `rejected`:
 * `accepted + skipped + rejected = rows_read`.
 */
export type AgencyIngestSkipCode = 'already_in_campaign';

/**
 * The widest Do Not Call entry that suppresses a number, as the ingest's screen
 * reports it: the whole organisation (`tenant`), this account, or this campaign.
 * `unknown` when the list said "suppressed" but the scope could not be read back:
 * the row is still rejected (fail-closed), only the wording is weaker.
 */
export type AgencyDncScope = 'tenant' | 'account' | 'campaign' | 'unknown';

/**
 * The per-row reasons, in plain British English, each saying how to fix the row
 * (IM6). They are the rejected-rows download's `_reason` column, beside the
 * operator's own columns, so whoever fixes the file in a spreadsheet reads them
 * there. The wire codes beside them are unchanged.
 */
export const ROW_REASON = {
  missingPhone: (column: string) =>
    `The '${column}' column is empty. Add the customer's phone number, or delete the row.`,
  invalidPhone: (raw: string, countryCode: string | undefined) =>
    `'${raw}' is not a phone number we can dial. Check the digits${
      countryCode ? `, and add the country code if it is not +${countryCode}` : ', and add the country code'
    }.`,
  // Names the row it repeats, never the number: a reason that started with `+91…` would be
  // read as a formula by a spreadsheet, and the phone cell is beside it in the download.
  duplicatePhone: (firstRow: number) =>
    `The same phone number is already on row ${firstRow} of this file, so this row was left out. Delete one of the two rows, or keep both by choosing "Don't remove duplicates".`,
  duplicateKey: (keyLabel: string, firstRow: number) =>
    `Same ${keyLabel} as row ${firstRow} of this file, so this row was left out. Delete one of the two rows, or correct the ${keyLabel}.`,
  ragged: (values: number, columns: number) =>
    `This row has ${values} values but the header has ${columns} columns, usually because a value contains an unquoted comma. Put that value in double quotes, or remove the comma.`,
  valueTooLarge: (column: string, max: number) =>
    `The value in '${column}' is longer than ${max.toLocaleString('en-GB')} bytes. Shorten it.`,
  rowTooLarge: (max: number) =>
    `This row is longer than ${max.toLocaleString('en-GB')} bytes across its columns. Shorten its longest values.`,
  dnc: (scope: AgencyDncScope) => {
    const where =
      scope === 'tenant' ? ' for every campaign in your organisation'
        : scope === 'account' ? ' for every campaign in this account'
          : scope === 'campaign' ? ' for this campaign'
            : '';
    return `This number is on the Do Not Call list${where}, so it cannot be imported. If the customer has agreed to be called again, an admin must remove it from the Do Not Call list first; otherwise delete the row.`;
  },
  alreadyInCampaign: () =>
    'Already in this campaign from an earlier import, so it was skipped. Nothing about that contact was changed.',
} as const;

/**
 * A duplicate key from its parts, the one definition shared by the in-file check
 * (`rowKey` below) and the campaign check (`agency-ingest-screen.ts`, which reads
 * the parts back off contacts already in the campaign through
 * `roster-presence.repository.ts`): each part compared by
 * {@link dedupeKey}, `null` when any part is blank (never a duplicate), one part as
 * itself and several as their JSON array, so `["a,b","c"]` and `["a","b,c"]` stay
 * apart where a joined string would not.
 */
export function combineKeyParts(parts: ReadonlyArray<string | null | undefined>): string | null {
  const keyed: string[] = [];
  for (const part of parts) {
    const value = dedupeKey(part ?? '');
    if (value === '') return null;
    keyed.push(value);
  }
  if (keyed.length === 0) return null;
  return keyed.length === 1 ? keyed[0]! : JSON.stringify(keyed);
}

// ─── Result shapes ──────────────────────────────────────────────────────────

/** One accepted contact, in the shape the roster hand-off (`sendRosterChunk`) expects. */
export interface AgencyIngestContact {
  phone_e164: string;
  /** Every retained non-phone column, original (de-duplicated) header as key. */
  context: Record<string, string>;
  /** 1-based row of the uploaded file this record is on, as a spreadsheet shows it (records and blank lines before it, IM8). */
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
  /**
   * The mapped column the rejection is about; null for whole-row problems. A
   * `duplicate_key` over several columns names them all, joined ` + `.
   */
  column: string | null;
  raw_value: string;
  reason_code: AgencyIngestErrorCode;
  reason: string;
  /** The row's retained columns, so the export can reproduce the original line. */
  context: Record<string, string>;
}

/** One skipped row: the row is fine, the campaign already holds it. Same shape as a rejection. */
export interface AgencyIngestSkip {
  row_number: number;
  column: string | null;
  raw_value: string;
  reason_code: AgencyIngestSkipCode;
  reason: string;
  context: Record<string, string>;
}

/**
 * A row that passed every check this module can make alone, waiting for the
 * caller's {@link AgencyIngestOptions.screen} (the Do Not Call list and the
 * campaign's roster) before its duplicate key is claimed.
 */
export interface AgencyIngestCandidate extends AgencyIngestContact {
  /** The row's duplicate key (normalised number, or the key columns' parts), null when it has none. */
  key: string | null;
  /** The phone cell as the file has it, for the rejected-rows download (the operator fixes that text). */
  raw_phone: string;
}

/** What the caller's screen found about one batch of candidates. */
export interface AgencyIngestScreenResult {
  /** Numbers on the Do Not Call list, each with the widest scope that suppresses it. */
  dnc: ReadonlyMap<string, AgencyDncScope>;
  /** Indexes (into the candidates passed) of rows the campaign already holds. */
  existing: ReadonlySet<number>;
}

/** The resolved key, passed to the screen so it can read the same key off the roster. */
export interface AgencyIngestKeyInfo {
  /** `phone`: the normalised number; `column`: the key columns; `none`: no duplicate check. */
  mode: 'phone' | 'column' | 'none';
  /** The key columns as the file names them (resolved headers), in the operator's order. */
  columns: string[];
  /** Per key column: true when it is the phone column (compared as the normalised number). */
  phone_parts: boolean[];
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
  /** `accepted + skipped + rejected = rows_read`, exactly. */
  accepted: number;
  rejected: number;
  /** Rows the campaign already held (the screen's `existing`): neither imported nor rejected. */
  skipped: number;
  duplicates: number;
  /** Do Not Call rejections by the widest scope that suppressed them; a breakdown of `rejected`. */
  dnc_by_scope: Partial<Record<AgencyDncScope, number>>;
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
  /** Receives every skipped row (the campaign already holds it). */
  onSkipped?: (skip: AgencyIngestSkip) => Promise<void> | void;
  /**
   * The checks this module cannot make alone, asked once per batch BEFORE any row
   * of the batch claims its duplicate key: which numbers are on the Do Not Call
   * list, and which rows the campaign already holds. Awaited like `onBatch`, and
   * an error it throws is the caller's own (the DNC lookup's fail-closed
   * `DncUnavailableError` reaches the caller unchanged).
   *
   * Asking before the claim is what lets a Do Not Call row NOT claim its key (IM4):
   * a later row with the same loan number on a callable number is imported rather
   * than dropped as a duplicate of a row that was never imported. A skipped row
   * claims no key either: its key is in the campaign, so a later row carrying it is
   * skipped too (IM3, `flush`). Without a screen every candidate is accepted.
   *
   * The check and the import run this same function, so a check cannot drift from
   * the import it previews (IM1).
   */
  screen?: (
    candidates: readonly AgencyIngestCandidate[],
    key: AgencyIngestKeyInfo,
  ) => Promise<AgencyIngestScreenResult> | AgencyIngestScreenResult;
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
  /**
   * Dedupe on these columns instead of the phone: a later row whose values in
   * ALL of them repeat an earlier row accepted here is rejected `duplicate_key`.
   * Takes precedence over `dedupePhones`. For a loan book, the loan number: one
   * borrower with two loans is two rows on one number, and both must be called.
   * Up to `AGENCY_MAX_DEDUPE_COLUMNS` columns combine into one key when no single
   * column is unique (a loan number repeated across branches: loan + branch).
   * Every column must match for a row to be a duplicate, so each column added
   * can only drop fewer rows, never more.
   *
   * Values are compared by {@link dedupeKey} (trimmed, case-insensitive); the
   * phone column, when it is one of them, by its normalised number. A row with
   * ANY key blank is never a duplicate: it is kept, unchecked, because a missing
   * loan number is not evidence that two rows are the same loan. Naming only the
   * phone column means the phone dedupe (`duplicate_phone`).
   *
   * The columns must be RETAINED, not ignored. The roster dedupes again at insert
   * on `row_fingerprint` (phone, `context`, timezone), and an ignored column is
   * not in `context`, so two rows differing only in an ignored key would pass
   * here and collapse into one contact there. `POST /ingest/jobs` refuses the
   * combination; this module does not re-check it.
   *
   * Keeping two rows on one number is safe to dial because
   * `AgencyContactRepository.claimDialable` never has two calls live to one
   * number in a campaign.
   */
  dedupeColumns?: string[];
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

/**
 * How a value in the duplicate column is compared: trimmed and case-insensitive,
 * so `LN-001`, `ln-001` and ` LN-001 ` are one loan. The column analysis keys its
 * `distinct` count the same way, so "100% unique" there means no `duplicate_key`
 * here (within the sample). The phone dedupe compares normalised numbers instead;
 * its counterpart in the analysis is `distinct_phones`.
 */
export function dedupeKey(value: string): string {
  return value.trim().toLowerCase();
}

const hasNul = (value: string): boolean => value.includes('\u0000');

/**
 * One data row's cells as the import reads them. Two things a spreadsheet does not
 * show are undone, and nothing else is touched (a row needing neither is returned as is):
 *
 *  - **A NUL** past the encoding probe's first 512 bytes is dropped. Postgres stores no
 *    U+0000 in text or jsonb, so one left in a cell would fail the roster insert, the
 *    screen's exact-copy lookup or the job's review sample, after earlier chunks
 *    landed. It is invisible in a spreadsheet, so the cell is read as the operator sees it.
 *    (A header carrying one is refused instead: headers are the mapping's keys.)
 *  - **The formula guard's apostrophe** (`'+919876543210`), which our own downloads add
 *    (`agency-csv.ts`): a rejected row fixed and uploaded again reads as the value it was.
 *
 * Shared with the column analysis, so the mapping screen samples the same values.
 */
export function readDataCells(record: string[]): string[] {
  if (!record.some((cell) => hasNul(cell) || cell.charCodeAt(0) === 0x27)) return record;
  return record.map((cell) => unguardFormulaSigil(hasNul(cell) ? cell.replace(/\u0000/g, '') : cell));
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

/**
 * Whether two header names resolve to the same column here. The ingest route
 * refuses a key named twice or ignored by this same rule, so its checks hold for
 * what the ingest resolves.
 */
export function sameHeader(a: string, b: string): boolean {
  return normalizeHeader(a) === normalizeHeader(b);
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
    onSkipped,
    screen,
    batchSize = AGENCY_INGEST_BATCH_SIZE,
    maxRows = AGENCY_MAX_ROWS,
    maxColumns = AGENCY_MAX_COLUMNS,
    maxErrors = MAX_ERRORS,
    maxCellBytes = AGENCY_MAX_CELL_BYTES,
    maxRowBytes = AGENCY_MAX_ROW_BYTES,
    defaultCountryCode,
    rowLimit,
    dedupePhones = true,
    dedupeColumns,
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
    // Byte offsets for the progress bar, and `empty_lines`, which the row
    // numbers below need (see `previousRow`).
    info: true,
  });

  let headers: string[] = [];
  let retainedHeaders: string[] = [];
  let phoneIndex = -1;
  let timezoneIndex = -1;
  /** The duplicate key's column indexes, in the operator's order; empty for the phone dedupe (or none). */
  let keyIndexes: number[] = [];
  /** How a `duplicate_key` rejection names the key: `Loan No`, or `Loan No + Branch`. */
  let keyLabel = '';
  const ignored = new Set(ignoreColumns.map(normalizeHeader));

  let rowsRead = 0;
  let accepted = 0;
  let rejected = 0;
  let skipped = 0;
  let duplicates = 0;
  let errorsTruncated = 0;
  let bytesRead = 0;
  let truncated = false;
  const errors: AgencyIngestRejection[] = [];
  const rejectedByReason: Record<string, number> = {};
  const dncByScope: Partial<Record<AgencyDncScope, number>> = {};

  // See the module header: O(distinct phones), and deliberately so. Holds
  // normalised numbers for the phone dedupe, or the key built by `rowKey` for
  // duplicate columns: O(distinct keys) either way, and empty with dedupe off.
  // The value is the line of the row that claimed the key, so a duplicate's
  // reason can say which row it repeats.
  const seen = new Map<string, number>();
  /** Rows that passed the checks above, waiting for the screen and their key claim. */
  let pending: AgencyIngestCandidate[] = [];
  let keyInfo: AgencyIngestKeyInfo = { mode: 'none', columns: [], phone_parts: [] };

  // A record's row number is the row a spreadsheet shows it on, which is how the
  // operator finds it again (IM8): one row per record before it, plus one per
  // blank line before it. A blank line is a blank row in a spreadsheet, and
  // `skip_empty_lines` skips it, so the records alone would drift by one at every
  // blank line (an Excel upload keeps its blank rows as blank lines, so that row N
  // here is row N of the sheet). A record whose quoted cell holds a line break is
  // still ONE row, as a spreadsheet opens it: counting the file's lines instead
  // (`info.lines`, as this did before IM8) put every row after such a cell one
  // further down per line break than the spreadsheet shows it.
  let previousRow = 0;
  let previousEmptyLines = 0;

  // Settled with the header row. `none` until then, which no data row can see.
  let dedupeMode: 'phone' | 'column' | 'none' = 'none';

  /**
   * The row's duplicate key over `keyIndexes`, or null when any part is blank
   * (never a duplicate). One column keys on its value alone, as before keys could
   * combine; several key on their JSON array, so `["a,b","c"]` and `["a","b,c"]`
   * stay apart where a joined string would not.
   */
  function rowKey(record: string[], phoneE164: string): string | null {
    return combineKeyParts(keyIndexes.map((i) => (i === phoneIndex ? phoneE164 : record[i] ?? '')));
  }

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

  /**
   * Settle the pending rows, in file order: screen them, then for each row
   *
   *   1. already in the campaign → skipped (IM3). First, because it is true of every
   *      row carrying that key, a repeat in the file or a Do Not Call number
   *      included: none of them would be imported, and "already imported" is the
   *      answer that tells the operator there is nothing to fix. It claims no key:
   *      a later row with the same key is in the campaign too.
   *   2. a key an earlier accepted row claimed → rejected as a duplicate;
   *   3. on the Do Not Call list → rejected, WITHOUT claiming its key (IM4);
   *   4. otherwise accepted, claiming its key.
   *
   * The accepted rows go to `onBatch` as one batch. `onBatch` is called for every
   * settled batch, even one that accepted nothing, so a caller's per-batch work
   * (the cancel check) sees every batch boundary.
   */
  async function flush(): Promise<void> {
    if (pending.length === 0) return;
    const candidates = pending;
    pending = [];
    const screened: AgencyIngestScreenResult = screen
      ? await fromCaller(() => screen(candidates, keyInfo))
      : { dnc: new Map(), existing: new Set() };

    const outgoing: AgencyIngestContact[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const { key, raw_phone: rawPhone, ...contact } = candidates[i]!;
      const row = contact.source_row_number;
      const phoneHeader = headers[phoneIndex]!;

      if (screened.existing.has(i)) {
        skipped += 1;
        if (onSkipped) {
          const skip: AgencyIngestSkip = {
            row_number: row,
            column: null,
            raw_value: rawPhone,
            reason_code: 'already_in_campaign',
            reason: ROW_REASON.alreadyInCampaign(),
            context: contact.context,
          };
          await fromCaller(() => onSkipped(skip));
        }
        continue;
      }

      const firstRow = key === null ? undefined : seen.get(key);
      if (firstRow !== undefined) {
        duplicates += 1;
        await reject(
          keyInfo.mode === 'phone'
            ? {
              row_number: row,
              column: phoneHeader,
              raw_value: rawPhone,
              reason_code: 'duplicate_phone',
              reason: ROW_REASON.duplicatePhone(firstRow),
              context: contact.context,
            }
            : {
              // The reason names the columns and never their values, which may sit
              // in a column the rejected-rows export must not leak.
              row_number: row,
              column: keyLabel,
              raw_value: rawPhone,
              reason_code: 'duplicate_key',
              reason: ROW_REASON.duplicateKey(keyLabel, firstRow),
              context: contact.context,
            },
        );
        continue;
      }

      const dncScope = screened.dnc.get(contact.phone_e164);
      if (dncScope !== undefined) {
        dncByScope[dncScope] = (dncByScope[dncScope] ?? 0) + 1;
        await reject({
          row_number: row,
          column: phoneHeader,
          raw_value: rawPhone,
          reason_code: 'dnc_suppressed',
          reason: ROW_REASON.dnc(dncScope),
          context: contact.context,
        });
        continue;
      }

      if (key !== null) seen.set(key, row);
      accepted += 1;
      outgoing.push(contact);
    }

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
      const { info } = item;
      // A data row's NULs and formula-guard apostrophes (`readDataCells`); the header row as written.
      const record = headers.length > 0 ? readDataCells(item.record) : item.record;
      bytesRead = info.bytes;
      const startLine = previousRow + 1 + (info.empty_lines - previousEmptyLines);
      previousRow = startLine;
      previousEmptyLines = info.empty_lines;

      // ── Header row ──────────────────────────────────────────────────────
      if (headers.length === 0) {
        if (record.length > maxColumns) {
          throw new AgencyIngestError(
            'too_many_columns',
            AGENCY_LIMIT_MESSAGES.tooManyColumns(record.length, maxColumns),
          );
        }

        headers = dedupeHeaders(record);

        // A replacement character (or a NUL) in a HEADER is fatal: headers are the keys the
        // operator maps against and the keys `context` is written with, so a
        // mangled one is unmappable and unrenderable. The same character inside
        // a data cell is tolerated — see the row loop — because rejecting a
        // million-row file over one accented name in row 900,000 is worse than
        // showing the agent a slightly mangled one.
        if (headers.some((h) => h.includes('�') || hasNul(h))) {
          throw new AgencyIngestError(
            'unsupported_encoding',
            'The column headers contain characters that are not valid UTF-8. Save the file as CSV UTF-8 or as an Excel Workbook (.xlsx) and upload it again.',
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

        for (const column of dedupeColumns ?? []) {
          const index = resolveColumn(headers, column);
          if (index === -1) {
            throw new AgencyIngestError(
              'dedupe_column_missing',
              `The column chosen to find duplicates, '${column}', is not in the file.`,
            );
          }
          // A column named twice is one key part; the route refuses it, this
          // module does not depend on that.
          if (!keyIndexes.includes(index)) keyIndexes.push(index);
        }
        // The phone column chosen alone is the phone dedupe, on the normalised
        // number rather than the raw text. In a combination it is one part,
        // still compared as the normalised number (`rowKey`).
        if (keyIndexes.length === 1 && keyIndexes[0] === phoneIndex) keyIndexes = [];
        keyLabel = dedupeKeyName(keyIndexes.map((i) => headers[i]!)) ?? '';
        // A key that came down to the phone alone is the phone dedupe whatever
        // `dedupePhones` says (the route refuses a key with `dedupe_phones: false`).
        dedupeMode = keyIndexes.length > 0
          ? 'column'
          : (dedupeColumns?.length ?? 0) > 0 || dedupePhones ? 'phone' : 'none';
        keyInfo = dedupeMode === 'column'
          ? {
            mode: 'column',
            columns: keyIndexes.map((i) => headers[i]!),
            phone_parts: keyIndexes.map((i) => i === phoneIndex),
          }
          : dedupeMode === 'phone'
            ? { mode: 'phone', columns: [headers[phoneIndex]!], phone_parts: [true] }
            : { mode: 'none', columns: [], phone_parts: [] };

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
          AGENCY_LIMIT_MESSAGES.tooManyRows(maxRows),
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
          reason: ROW_REASON.ragged(record.length, headers.length),
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
          reason: ROW_REASON.valueTooLarge(oversizeColumn, maxCellBytes),
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
          reason: ROW_REASON.rowTooLarge(maxRowBytes),
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
          reason: ROW_REASON.missingPhone(headers[phoneIndex]!),
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
          reason: ROW_REASON.invalidPhone(rawPhone, defaultCountryCode),
          context,
        });
        continue;
      }

      // The duplicate key: the NORMALISED number for the phone dedupe, so
      // `09876543210`, `+91 98765 43210` and `9876543210` are one contact rather
      // than three calls to one person (see `dedupePhones` for why it is
      // switchable), or the operator's columns. It is checked and claimed in
      // `flush`, after the screen, never here: a row this module rejects above
      // never claims its key (a first row rejected for a bad number does not cost
      // a later, good row with the same loan number), and since IM4 neither does a
      // row the Do Not Call list rejects.
      const key = dedupeMode === 'phone'
        ? phoneE164
        : dedupeMode === 'column' ? rowKey(record, phoneE164) : null;

      const timezone =
        timezoneIndex === -1 ? undefined : record[timezoneIndex]?.trim() || undefined;

      pending.push({
        phone_e164: phoneE164,
        context,
        source_row_number: startLine,
        ...(timezone !== undefined ? { timezone } : {}),
        key,
        raw_phone: rawPhone,
      });

      if (pending.length >= batchSize) await flush();
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
      `Could not read the file: ${err instanceof Error ? err.message : 'unknown error'}`,
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
    skipped,
    duplicates,
    dnc_by_scope: dncByScope,
    // In file order: the screened rejections are settled a batch after the
    // structural ones, so they arrive out of order.
    errors: errors.sort((a, b) => a.row_number - b.row_number),
    errors_truncated: errorsTruncated,
    rejected_by_reason: rejectedByReason,
    bytes_read: bytesRead,
    truncated,
  };
}
