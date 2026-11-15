import {
  dedupeKeyName,
  type AgencyIngestDncScope,
  type AgencyIngestJob,
  type AgencyIngestReasonCode,
} from '../types/agency-campaign';
import { combinationMatch } from './agencyColumnMapping';

/**
 * The ingest summary, as arithmetic (requirement: *the counts
 * are displayed and reconcile to the file's row count*).
 *
 * ── The one thing this module exists to get right ────────────────────────────
 * **`accepted + rejected = rows_read`.** `duplicates` and DNC suppressions are
 * breakdowns *of* `rejected`, never additional addends. That is not a reading of
 * the prose — it is what the API's code does: a duplicate row calls the same
 * `reject()` that every other rejection calls (`agency-csv-ingest.ts`, the
 * `duplicate_phone` arm increments `duplicates` **and** `rejected`), and
 * `agency-ingest.service.ts` moves DNC-suppressed rows *across* from accepted to
 * rejected rather than counting them a third way, and the `agency_ingest_jobs` schema documenting
 * the invariant.
 *
 * **An earlier design sketch disagreed** — it shows four tiles said to
 * reconcile as `accepted + rejected + duplicates = rows read`. Built that way,
 * an operator adding the tiles up against their own spreadsheet gets a number
 * larger than their file, and the screen whose entire job is "you can trust
 * these numbers" is the screen that cannot be balanced. The wire wins; the tiles
 * below present duplicates as a *breakdown* line, not as an addend.
 *
 * ── The one number that is NOT part of that arithmetic ───────────────────────
 * `core_rejected_duplicate_rows` counts rows **the server refused on arrival** because
 * its roster already held them. `accepted`/`rejected` count what the API decided
 * to *send*. The two are measured on opposite sides of a network hop and cannot
 * be reconciled — that disagreement is the entire signal, and an earlier
 * defect is the record of what happens when a summary asserts an arithmetic the payload does
 * not support. So it is rendered as its own statement, never folded into the
 * identity, and never subtracted from `accepted` to mint a "really written"
 * figure: The API's own count can undercount, so any such subtraction would be an
 * upper bound presented as a fact.
 */

/**
 * A displayed counter. `accepted`, `skipped` and `rejected` sum to `rows_read`
 * (IM3); breakdowns do not. `skipped` is shown only when the job skipped any, so an
 * import into an empty campaign reads as it always did.
 */
export interface IngestCounter {
  key: 'rows_read' | 'accepted' | 'skipped' | 'rejected';
  label: string;
  value: number;
}

/** One "why rows were rejected" group. */
export interface RejectionGroup {
  code: AgencyIngestReasonCode | string;
  label: string;
  count: number;
}

/** Human copy per reason code. Mirrors the API's `REJECTION_LABEL`. */
export const REJECTION_LABELS: Record<AgencyIngestReasonCode, string> = {
  missing_phone_value: 'Empty phone number',
  invalid_phone: 'Not a valid phone number',
  duplicate_phone: 'Duplicate of an earlier row',
  duplicate_key: 'Duplicate of an earlier row (same value in the duplicate column)',
  ragged_row: 'Row does not match the header',
  value_too_large: 'A value is too large',
  row_too_large: 'The row is too large',
  dnc_suppressed: 'On the Do Not Call list',
};

/**
 * Rejections at or above this share of the file lead the summary with a warning
 * and a route back to the column mapping — the overwhelmingly likely cause is a
 * mis-mapped phone column, not 20% bad data.
 */
export const HIGH_REJECTION_RATIO = 0.2;

export interface IngestSummaryModel {
  /** The tiles that genuinely reconcile: rows read, then its three (or two) parts. */
  counters: IngestCounter[];
  /** True iff `accepted + skipped + rejected === rows_read`. */
  reconciles: boolean;
  /** Rows the campaign already held (IM3): skipped, not rejected. */
  skipped: number;
  /** What a skipped row means, or null when nothing was skipped. */
  skippedNotice: string | null;
  /**
   * Rendered under the tiles, always — an operator who cannot see the identity
   * has to trust it, and this screen exists so they do not have to.
   */
  reconciliationLine: string;
  /** Duplicate rows. A subset of `rejected`, and labelled as one. */
  duplicates: number;
  /**
   * What a duplicate was in this import, as a sentence: a repeated number, or a
   * repeated value in the operator's chosen column ("a Loan No that …").
   */
  duplicateMeaning: string;
  /** DNC suppressions, from `rejected_by_reason`. Also a subset of `rejected`. */
  dncSuppressed: number;
  /** Compliance line, or null when nothing was suppressed. */
  dncNotice: string | null;
  /**
   * Rows the server refused on arrival. **Not** a slice of `rejected` — see the module
   * header. `0` when nothing collided or when the API served an older payload.
   */
  coreRefused: number;
  /**
   * Statement of the above, or null when nothing was refused.
   *
   * Worded as a floor ("at least"), because the API's count drops a chunk whose
   * response was lost in transit and replayed.
   */
  coreRefusedNotice: string | null;
  /**
   * The colliding row numbers the API sampled, or null when there are none.
   *
   * Presented as examples from the start of the file and explicitly not as a
   * spread, because the cap is filled in file order — usually by chunk 0 alone.
   */
  coreRefusedSample: string | null;
  /** Grouped rejections, largest first. */
  groups: RejectionGroup[];
  /** `rejected / rows_read`, 0 when the file had no rows. */
  rejectionRatio: number;
  /** Non-null when rejections are high enough to suspect the mapping. */
  highRejectionWarning: string | null;
}

function labelFor(code: string, dedupeKey: string | null): string {
  // Names the columns the operator chose, so "Duplicate Loan No + Branch of an
  // earlier row" says which rule dropped the row. Falls back to the static label
  // for a job served without them.
  if (code === 'duplicate_key' && dedupeKey) return `Duplicate ${dedupeKey} of an earlier row`;
  return (REJECTION_LABELS as Record<string, string>)[code] ?? 'Rejected for another reason';
}

/**
 * Build everything the summary renders from one job payload.
 *
 * Pure, and separate from the component for the house reason (`analysisProfileForm.ts`,
 * `escalationForm.ts`): the arithmetic is the thing worth testing, and a test that
 * has to mount a component to check a sum tests the component instead.
 */
export function buildIngestSummary(job: AgencyIngestJob): IngestSummaryModel {
  const rowsRead = job.rows_read;
  // `?? []`: a job served before `dedupe_columns` has no key.
  const keyColumns = job.dedupe_columns ?? [];
  const dedupeKey = dedupeKeyName(keyColumns);
  const accepted = job.accepted;
  const rejected = job.rejected;

  const byReason = job.rejected_by_reason ?? {};
  const dncSuppressed = byReason.dnc_suppressed ?? 0;

  const groups: RejectionGroup[] = Object.entries(byReason)
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([code, count]) => ({ code, label: labelFor(code, dedupeKey), count: count as number }))
    // Largest first, then by code so the order is stable between polls — a list
    // that reorders while an operator is reading it looks like the numbers moved.
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  // `?? 0`: a job served before IM3 skipped nothing.
  const skipped = job.skipped ?? 0;
  const check = job.dry_run;
  const reconciles = accepted + skipped + rejected === rowsRead;
  const rejectionRatio = rowsRead > 0 ? rejected / rowsRead : 0;

  // `?? 0` / `?? []`: The API serves these and defaults them
  // itself, but a job row written before these counters existed has no key at
  // all, and a summary that renders `NaN duplicates` over a real import is worse
  // than one that renders nothing.
  const coreRefused = job.core_rejected_duplicate_rows ?? 0;
  const coreSample = job.core_duplicate_source_rows ?? [];

  return {
    counters: [
      { key: 'rows_read', label: check ? 'rows in the file' : 'rows read', value: rowsRead },
      { key: 'accepted', label: check ? 'ready to import' : 'imported', value: accepted },
      ...(skipped > 0 ? [{ key: 'skipped' as const, label: 'already in this campaign', value: skipped }] : []),
      { key: 'rejected', label: 'rejected', value: rejected },
    ],
    reconciles,
    skipped,
    skippedNotice:
      skipped > 0
        ? `${formatCount(skipped)} ${skipped === 1 ? 'row is' : 'rows are'} already in this campaign from an earlier import, so ${
          check ? (skipped === 1 ? 'it will be' : 'they will be') : (skipped === 1 ? 'it was' : 'they were')
        } skipped. Nothing about ${skipped === 1 ? 'that contact' : 'those contacts'} changes, and ${
          skipped === 1 ? 'it is' : 'they are'
        } not an error. To call them again, start a retry campaign.`
        : null,
    /**
     * Stated as the identity, with the real numbers in it. `duplicates` is named
     * on its own line below rather than inside this sum, because putting it here
     * is exactly the mistake the module header describes.
     */
    reconciliationLine: `${formatCount(accepted)} ${check ? 'ready' : 'imported'} + ${
      skipped > 0 ? `${formatCount(skipped)} already in this campaign + ` : ''
    }${formatCount(rejected)} rejected = ${formatCount(rowsRead)} rows ${check ? 'in the file' : 'read'}`,
    duplicates: job.duplicates,
    duplicateMeaning:
      keyColumns.length > 1
        ? `a row whose ${combinationMatch(keyColumns)} an earlier row in the file.`
        : dedupeKey
          ? `a ${dedupeKey} value that already appeared earlier in the file.`
          : 'a number that already appeared earlier in the file.',
    dncSuppressed,
    dncNotice: dncNotice(dncSuppressed, job.dnc_by_scope ?? {}, check),
    coreRefused,
    /**
     * Deliberately says what it is *separate from*, and deliberately quotes no
     * corrected total. An operator reading "11,712 accepted" next to a refusal
     * count will reach for subtraction, so the line has to name the reason that
     * does not work — the count is a floor, not a total.
     */
    coreRefusedNotice:
      coreRefused > 0
        ? `At least ${formatCount(coreRefused)} of the imported ${
            coreRefused === 1 ? 'rows was' : 'rows were'
          } already in this campaign, so the roster did not take ${
            coreRefused === 1 ? 'it' : 'them'
          } again. That is separate from the ${formatCount(rejected)} rejected above — those never left here — so the imported count overstates what was actually added. “At least”, because a chunk we had to re-send reports nothing back.`
        : null,
    coreRefusedSample:
      coreRefused > 0 && coreSample.length > 0
        ? `Rows ${coreSample.map((row) => formatCount(row)).join(', ')} are examples. They come from the start of the file — the list stops at ${formatCount(coreSample.length)}, so later repeats are counted but not named.`
        : null,
    groups,
    rejectionRatio,
    highRejectionWarning:
      rowsRead > 0 && rejectionRatio >= HIGH_REJECTION_RATIO
        ? `${Math.round(rejectionRatio * 100)}% of your rows were rejected. That usually means the wrong column is mapped as the phone number — check the mapping before you start this campaign.`
        : null,
  };
}

/** Each Do Not Call scope, in words (IM5), widest first. */
const DNC_SCOPE_WORDS: ReadonlyArray<[AgencyIngestDncScope, string]> = [
  ['tenant', 'for every campaign in your organisation'],
  ['account', 'for every campaign in this account'],
  ['campaign', 'for this campaign only'],
  ['unknown', 'on a list we could not name'],
];

/**
 * The Do Not Call line: how many, which list each is on, and what the operator can
 * and cannot do about it. Correcting the file does not import a Do Not Call row, so
 * the sentence says so rather than leaving the operator to find out on re-import.
 */
export function dncNotice(
  count: number,
  byScope: Partial<Record<AgencyIngestDncScope, number>>,
  check: boolean,
): string | null {
  if (count <= 0) return null;
  const parts = DNC_SCOPE_WORDS
    .filter(([scope]) => (byScope[scope] ?? 0) > 0)
    .map(([scope, words]) => `${formatCount(byScope[scope]!)} ${words}`);
  const where = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const verb = check ? (count === 1 ? 'will not be' : 'will not be') : (count === 1 ? 'was not' : 'were not');
  return `${formatCount(count)} ${count === 1 ? 'number is' : 'numbers are'} on the Do Not Call list${where}, so ${
    count === 1 ? 'it' : 'they'
  } ${verb} imported. Correcting the file does not change this: delete ${
    count === 1 ? 'the row' : 'those rows'
  }, or, if the customer has agreed to be called, ask an admin to remove the number from the Do Not Call list first. Counted in the rejected total.`;
}

/**
 * How the import came out against the check it was started from (IM2), or null when
 * they agree. The roster or the Do Not Call list can change in between (another
 * import, a colleague's Do Not Call entry), and the import's own counts are what
 * happened; this says so instead of letting two different numbers sit unexplained.
 */
export function checkComparison(check: AgencyIngestJob, imported: AgencyIngestJob): string | null {
  if (imported.status !== 'completed') return null;
  const same = imported.accepted === check.accepted
    && (imported.skipped ?? 0) === (check.skipped ?? 0)
    && imported.rejected === check.rejected;
  if (same) return null;
  return `The check expected ${formatCount(check.accepted)} to import; ${formatCount(imported.accepted)} ${
    imported.accepted === 1 ? 'was' : 'were'
  } imported. The campaign or its Do Not Call list changed between the check and the import (another import, or a new Do Not Call entry). The numbers above are what happened.`;
}

/** Thousands separators, in the operator's own locale. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}

/**
 * Copy for a terminal job that is not `completed`.
 *
 * A cancelled ingest is the case this module refuses to let go silent: some rows are
 * already in the roster, and an operator who is not told the number will assume
 * either all or none.
 */
export function terminalNotice(job: AgencyIngestJob): string | null {
  if (job.status === 'cancelled') {
    if (job.dry_run) return `Stopped. The check read ${formatCount(job.rows_read)} rows before it stopped; nothing was imported.`;
    return `Stopped. ${formatCount(job.accepted)} of ${formatCount(job.rows_read)} rows read so far were imported. To add the rest, import the same file again: the rows already imported are skipped, not added twice.`;
  }
  if (job.status === 'failed') {
    return job.error_message ?? 'The import failed. Your file was kept — you can try again.';
  }
  return null;
}

/** Terminal statuses stop the poll. */
export function isTerminal(status: AgencyIngestJob['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
