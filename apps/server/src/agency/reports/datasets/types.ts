/**
 * The seam between the report pipeline (assembler, `agency/reports/`) and the dataset builders
 * (`agency/reports/datasets/`): what a builder is given and what it hands back.
 *
 * A builder reads with the SAME code the screens use (insights `compute*`, the agent record and
 * roster reads, the shared repositories), so a report cannot hold a second opinion about a
 * number (RP1, `docs/reports.md`). It returns the dataset WITHOUT `detail_files` and, separately,
 * one row source per detail sheet; the assembler streams each source into a gzipped NDJSON file
 * in S3, stops at `maxDetailRows` (RP12) and fills `detail_files` itself, so the cap and the
 * storage live in one place and a builder never touches S3.
 */
import type { ReportKind } from '@magick-agency/contracts/api/agency/reports';
import type {
  ReportDatasetOf,
  ReportDetailColumn,
  ReportDetailSheet,
} from '@magick-agency/contracts/reports';
import type { ReportRunRecord } from '../../../db/repositories/agency/report-run.repository.js';

/**
 * The wall-clock deadline on one run's build: the builder, its detail files and `dataset.json`
 * (the assembler's "Deadline"). Here, at the seam, rather than in the assembler, because the
 * report cursor (`reportCursorRows`) bounds its own transaction by it and the repository layer
 * must not import the assembler (which imports the repository).
 */
export const REPORT_BUILD_TIMEOUT_MS = 10 * 60_000;

/** What a builder is given: the claimed run row and the instant assembly reads "now" as. */
export interface ReportBuildContext {
  run: ReportRunRecord;
  /** The `generated_at` of the dataset and the "as of" of every as-of-now read. */
  now: Date;
  /**
   * The assembler's deadline (`REPORT_BUILD_TIMEOUT_MS`, the whole assembly). A builder checks it
   * between its stages of reads (`signal?.throwIfAborted()`), so past the deadline it starts no
   * further statement; the statements already sent on the shared pool finish on their own (the
   * seam hands a builder no client to cancel them on).
   */
  signal?: AbortSignal;
}

/**
 * One detail sheet's rows. `rows()` yields one array per row, cells in `columns` order, typed as
 * `columns[i].type` says (ISO strings for `datetime`, `YYYY-MM-DD` for `date`, seconds for
 * `duration_s`, numbers for `percent` in 0–100). The assembler stops iterating at the cap and
 * calls `return()` on the iterator, so a source backed by a cursor or keyset pages must release
 * it in a `finally`. `signal` is the assembler's deadline: a cursor-backed source passes it to
 * `reportCursorRows`, which cancels a statement in flight when it fires.
 */
export interface ReportDetailSource {
  sheet: ReportDetailSheet;
  label: string;
  columns: ReportDetailColumn[];
  rows(signal?: AbortSignal): AsyncIterable<unknown[]>;
}

/** A builder's answer: the dataset minus `detail_files`, and its detail sources in sheet order. */
export interface BuiltReport<K extends ReportKind = ReportKind> {
  dataset: Omit<ReportDatasetOf<K>, 'detail_files'>;
  details: ReportDetailSource[];
}

export type ReportDatasetBuilder<K extends ReportKind = ReportKind> = (ctx: ReportBuildContext) => Promise<BuiltReport<K>>;

/**
 * Thrown by a builder when the run's subject no longer exists or is no longer readable in the
 * run's tenant and account (a deleted campaign, an agent removed from the account). The assembler
 * fails the run with `subject_unavailable` instead of `assembly_failed`.
 */
export class ReportSubjectUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportSubjectUnavailableError';
  }
}

/**
 * Thrown by the campaign builder when the campaign's time zone changed between the request (or
 * the tick that made a subscription's run) and the build: the run's window was cut in the old
 * zone, the Insights reads cut days in the new one. The subject is still there, so the run fails
 * `assembly_failed` (the next run, or a re-run, uses the new zone) and no subscription stops.
 */
export class ReportZoneChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportZoneChangedError';
  }
}
