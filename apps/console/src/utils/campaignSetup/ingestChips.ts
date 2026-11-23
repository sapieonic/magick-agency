import type {
  AgencyColumnAnalysis,
  AgencyIngestJob,
  AgencyIngestReasonCode,
  AgencyUploadResponse,
} from '../../types/agency-campaign';
import type { StatusChipTone } from '../../components/campaign-setup';
import type { UploadPhase } from '../../hooks/useRosterIngest';
import { mappingBlockReason, type MappingState } from '../agencyColumnMapping';
import { HIGH_REJECTION_RATIO, checkStillImportable } from '../agencyIngestSummary';
import { formatCount } from '../format/number';

/**
 * Step 2 of the campaign setup, "Customers", as pure rules (docs/campaign-setup.md CS6, CS8):
 * when the phone column is sure enough to check the file straight away, the chips a finished
 * check or import shows, and the step's primary action.
 */

// ─── CS8: the phone column is found, not asked ──────────────────────────────

/**
 * The share of sampled rows that must hold a valid number in the suggested column before the
 * file is checked without asking. The complement of {@link HIGH_REJECTION_RATIO}: below it, the
 * check would open with the "wrong column mapped?" warning, so the mapper is shown instead.
 */
export const SURE_PHONE_SHARE = 1 - HIGH_REJECTION_RATIO;

/**
 * Whether the column analysis is sure which column holds the phone number: the server suggested
 * one (it withholds the suggestion when two columns are too close to call), that column is in the
 * file, and at least {@link SURE_PHONE_SHARE} of the sampled rows hold a valid number in it
 * (counted against every sampled row, blanks included, as `phoneValidityLine` counts).
 */
export function phoneColumnIsSure(analysis: AgencyColumnAnalysis): boolean {
  if (analysis.phone_column_ambiguous || analysis.suggested_phone_column === null) return false;
  const stat = analysis.columns.find((c) => c.name === analysis.suggested_phone_column);
  if (!stat || analysis.rows_sampled <= 0) return false;
  const valid = stat.phone_score * stat.non_empty;
  return valid / analysis.rows_sampled >= SURE_PHONE_SHARE;
}

/** The phases before a file's columns are known: leaving one for `mapping` is a fresh analysis. */
const BEFORE_ANALYSIS: readonly UploadPhase[] = ['idle', 'uploading', 'analyzing'];

/**
 * Whether the step starts the check by itself: only as a fresh analysis lands (from the upload
 * phases into `mapping`; React may batch `analyzing` away when the two answers come quickly),
 * when {@link phoneColumnIsSure} and the mapping it seeded can be sent. Going back to the mapping
 * ("Change columns", from `done`) is the supervisor asking, so it never checks by itself, and nor
 * does a step that mounts with the mapping already open (no previous phase).
 */
export function shouldAutoCheck(
  previousPhase: UploadPhase | null,
  phase: UploadPhase,
  analysis: AgencyColumnAnalysis | null,
  mapping: MappingState | null,
): boolean {
  if (previousPhase === null || !BEFORE_ANALYSIS.includes(previousPhase) || phase !== 'mapping') return false;
  if (analysis === null || mapping === null) return false;
  return phoneColumnIsSure(analysis) && mappingBlockReason(mapping) === null;
}

// ─── CS6: the chips ─────────────────────────────────────────────────────────

export type IngestChipKey = 'ready' | 'bad_phone' | 'duplicates' | 'other' | 'dnc' | 'skipped';

export interface IngestChip {
  key: IngestChipKey;
  tone: StatusChipTone;
  /** The rows the chip counts. The chips' counts add up to `rows_read` (IM3). */
  count: number;
  text: string;
  /** The download the chip offers: the rejected rows, or the skipped ones. */
  download: 'rejected' | 'skipped' | null;
}

/** Rejection codes counted as a bad phone number: an empty cell or one that is not a number. */
const BAD_PHONE_CODES: readonly AgencyIngestReasonCode[] = ['missing_phone_value', 'invalid_phone'];
/** A repeat of an earlier row in the file, on the phone or on the chosen key. */
const DUPLICATE_CODES: readonly AgencyIngestReasonCode[] = ['duplicate_phone', 'duplicate_key'];

function sumOf(byReason: AgencyIngestJob['rejected_by_reason'], codes: readonly string[]): number {
  return codes.reduce((total, code) => total + ((byReason as Record<string, number | undefined>)[code] ?? 0), 0);
}

function leftOut(count: number, check: boolean): string {
  if (check) return count === 1 ? 'It will be left out' : 'They will be left out';
  return count === 1 ? 'It was left out' : 'They were left out';
}

/**
 * The chips for a finished, completed check or import (CS6), from its counts exactly:
 * `accepted` ready (or added), each slice of `rejected` by its reason, and `skipped` (already in
 * this campaign, IM3). A chip with nothing to count is left out, except the ready one. Rejections
 * with no reason the chips name (a ragged row, a value too large, a reason this build does not
 * know, or a job served without `rejected_by_reason`) are one "another problem" chip, so the
 * chips always add up to the rows in the file. The rejected-rows download goes on the first
 * rejection chip shown; Details has the rest of the summary.
 *
 * `[]` for a job that did not complete: a failed or stopped job shows its full summary instead.
 */
export function ingestChips(job: AgencyIngestJob): IngestChip[] {
  if (job.status !== 'completed') return [];
  const check = job.dry_run;
  const byReason = job.rejected_by_reason ?? {};
  const rejected = job.rejected;
  // Each slice capped by what is left of `rejected`, so a payload whose breakdown overshoots
  // cannot make the chips add up to more than the file.
  let left = rejected;
  const take = (n: number) => {
    const taken = Math.max(0, Math.min(n, left));
    left -= taken;
    return taken;
  };
  const badPhone = take(sumOf(byReason, BAD_PHONE_CODES));
  const duplicates = take(sumOf(byReason, DUPLICATE_CODES));
  const dnc = take(byReason.dnc_suppressed ?? 0);
  const other = left;
  const skipped = job.skipped ?? 0;
  const accepted = job.accepted;

  const chips: IngestChip[] = [];
  chips.push({
    key: 'ready',
    tone: accepted > 0 ? 'success' : 'warning',
    count: accepted,
    text:
      accepted === 0
        ? check ? 'No new customers to add' : 'No customers were added'
        : `${formatCount(accepted)} ${accepted === 1 ? 'customer' : 'customers'} ${check ? 'ready' : 'added'}`,
    download: null,
  });
  if (badPhone > 0) {
    chips.push({
      key: 'bad_phone',
      tone: 'warning',
      count: badPhone,
      text: `${formatCount(badPhone)} ${badPhone === 1 ? 'row has' : 'rows have'} a bad phone number. ${leftOut(badPhone, check)}`,
      download: null,
    });
  }
  if (duplicates > 0) {
    chips.push({
      key: 'duplicates',
      tone: 'warning',
      count: duplicates,
      text: `${formatCount(duplicates)} ${duplicates === 1 ? 'row repeats' : 'rows repeat'} an earlier row. ${leftOut(duplicates, check)}`,
      download: null,
    });
  }
  if (other > 0) {
    chips.push({
      key: 'other',
      tone: 'warning',
      count: other,
      text: `${formatCount(other)} ${other === 1 ? 'row has' : 'rows have'} another problem. ${leftOut(other, check)}`,
      download: null,
    });
  }
  if (dnc > 0) {
    chips.push({
      key: 'dnc',
      tone: 'muted',
      count: dnc,
      text: `${formatCount(dnc)} on the Do Not Call list. ${leftOut(dnc, check)}`,
      download: null,
    });
  }
  if (skipped > 0) {
    chips.push({
      key: 'skipped',
      tone: 'info',
      count: skipped,
      text: `${formatCount(skipped)} already in this campaign`,
      download: job.has_skipped_export ? 'skipped' : null,
    });
  }
  if (job.has_rejected_export) {
    const first = chips.find((chip) => chip.key !== 'ready' && chip.key !== 'skipped');
    if (first) first.download = 'rejected';
  }
  return chips;
}

// ─── The file row ───────────────────────────────────────────────────────────

/** `48 KB`, `1.2 MB`: the uploaded file's size, for the file row. */
export function fileSizeWords(bytes: number): string {
  if (bytes < 1024) return `${formatCount(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${formatCount(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/**
 * The line under the file name: its size and its rows. The rows are the finished job's
 * `rows_read` when there is one (exact), else the analysis's sample, with a `+` when the analysis
 * read only part of the file. No upload time: the upload response carries none.
 */
export function fileRowLine(
  upload: Pick<AgencyUploadResponse, 'file_size_bytes'>,
  analysis: Pick<AgencyColumnAnalysis, 'rows_sampled' | 'truncated'> | null,
  job: Pick<AgencyIngestJob, 'rows_read' | 'status'> | null,
): string {
  const parts = [fileSizeWords(upload.file_size_bytes)];
  if (job && job.status === 'completed') {
    parts.push(`${formatCount(job.rows_read)} ${job.rows_read === 1 ? 'row' : 'rows'}`);
  } else if (analysis) {
    const n = analysis.rows_sampled;
    parts.push(`${formatCount(n)}${analysis.truncated ? '+' : ''} ${n === 1 && !analysis.truncated ? 'row' : 'rows'}`);
  }
  return parts.join(' · ');
}

// ─── The step's primary action ──────────────────────────────────────────────

export interface CustomersContinue {
  label: string;
  /** `import`: import the checked file (`importChecked`), then move on once it finishes. `next`: the next step. */
  action: 'import' | 'next';
}

/**
 * The footer's primary button on step 2 (CS8), or null while something is running (the upload,
 * the column read, a check or an import) or while the column mapper is open (its own "Check the
 * file" is the next move):
 *
 *  - nothing uploaded: "Skip for now";
 *  - a finished check with customers ready: "Add 1,240 customers", which imports it (a file is
 *    never imported unchecked from this step); a check with none ready, or one that failed or
 *    was stopped: "Skip for now";
 *  - a finished import: "Continue";
 *  - an import that failed or was stopped while its check can still be imported: "Add customers
 *    again" (IM2's retry); otherwise "Continue" when some rows landed, "Skip for now" when none.
 *
 * `importing` is the hook's flag for an import being started.
 */
export function customersContinue(
  phase: UploadPhase,
  job: AgencyIngestJob | null,
  checkJob: AgencyIngestJob | null,
  options: { importing?: boolean; now?: number } = {},
): CustomersContinue | null {
  if (options.importing) return null;
  if (phase === 'uploading' || phase === 'analyzing' || phase === 'mapping' || phase === 'ingesting') return null;
  const skip: CustomersContinue = { label: 'Skip for now', action: 'next' };
  if (phase === 'idle' || job === null) return skip;
  if (job.dry_run) {
    if (job.status === 'completed' && job.import_job_id === null && job.accepted > 0) {
      return {
        label: `Add ${formatCount(job.accepted)} ${job.accepted === 1 ? 'customer' : 'customers'}`,
        action: 'import',
      };
    }
    return skip;
  }
  if (job.status === 'completed') return { label: 'Continue', action: 'next' };
  if (checkJob !== null && checkStillImportable(checkJob, options.now)) {
    return { label: 'Add customers again', action: 'import' };
  }
  return job.accepted > 0 ? { label: 'Continue', action: 'next' } : skip;
}
