import type {
  AgencyIngestJob,
  AgencyIngestReasonCode,
} from '../types/agency-campaign';

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

/** A displayed counter. `addend` tiles sum to `rows_read`; breakdowns do not. */
export interface IngestCounter {
  key: 'rows_read' | 'accepted' | 'rejected';
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
  /** The three tiles that genuinely reconcile. */
  counters: IngestCounter[];
  /** True iff `accepted + rejected === rows_read`. */
  reconciles: boolean;
  /**
   * Rendered under the tiles, always — an operator who cannot see the identity
   * has to trust it, and this screen exists so they do not have to.
   */
  reconciliationLine: string;
  /** Duplicate rows. A subset of `rejected`, and labelled as one. */
  duplicates: number;
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

function labelFor(code: string): string {
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
  const accepted = job.accepted;
  const rejected = job.rejected;

  const byReason = job.rejected_by_reason ?? {};
  const dncSuppressed = byReason.dnc_suppressed ?? 0;

  const groups: RejectionGroup[] = Object.entries(byReason)
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([code, count]) => ({ code, label: labelFor(code), count: count as number }))
    // Largest first, then by code so the order is stable between polls — a list
    // that reorders while an operator is reading it looks like the numbers moved.
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const reconciles = accepted + rejected === rowsRead;
  const rejectionRatio = rowsRead > 0 ? rejected / rowsRead : 0;

  // `?? 0` / `?? []`: The API serves these and defaults them
  // itself, but a job row written before these counters existed has no key at
  // all, and a summary that renders `NaN duplicates` over a real import is worse
  // than one that renders nothing.
  const coreRefused = job.core_rejected_duplicate_rows ?? 0;
  const coreSample = job.core_duplicate_source_rows ?? [];

  return {
    counters: [
      { key: 'rows_read', label: 'rows read', value: rowsRead },
      { key: 'accepted', label: 'accepted', value: accepted },
      { key: 'rejected', label: 'rejected', value: rejected },
    ],
    reconciles,
    /**
     * Stated as the identity, with the real numbers in it. `duplicates` is named
     * on its own line below rather than inside this sum, because putting it here
     * is exactly the mistake the module header describes.
     */
    reconciliationLine: `${formatCount(accepted)} accepted + ${formatCount(rejected)} rejected = ${formatCount(rowsRead)} rows read`,
    duplicates: job.duplicates,
    dncSuppressed,
    dncNotice:
      dncSuppressed > 0
        ? `${formatCount(dncSuppressed)} ${dncSuppressed === 1 ? 'number is' : 'numbers are'} on your Do Not Call list and ${dncSuppressed === 1 ? 'was' : 'were'} skipped. ${dncSuppressed === 1 ? 'It is' : 'They are'} counted in the rejected total.`
        : null,
    coreRefused,
    /**
     * Deliberately says what it is *separate from*, and deliberately quotes no
     * corrected total. An operator reading "11,712 accepted" next to a refusal
     * count will reach for subtraction, so the line has to name the reason that
     * does not work — the count is a floor, not a total.
     */
    coreRefusedNotice:
      coreRefused > 0
        ? `At least ${formatCount(coreRefused)} of the accepted ${
            coreRefused === 1 ? 'rows was' : 'rows were'
          } already in this campaign, so the roster did not take ${
            coreRefused === 1 ? 'it' : 'them'
          } again. That is separate from the ${formatCount(rejected)} rejected above — those never left here — so the accepted count overstates what was actually added. “At least”, because a chunk we had to re-send reports nothing back.`
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
    return `Stopped. ${formatCount(job.accepted)} of ${formatCount(job.rows_read)} rows read so far were imported — you can start with these, or clear and re-upload.`;
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
