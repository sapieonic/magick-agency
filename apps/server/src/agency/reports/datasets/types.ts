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

/** What a builder is given: the claimed run row and the instant assembly reads "now" as. */
export interface ReportBuildContext {
  run: ReportRunRecord;
  /** The `generated_at` of the dataset and the "as of" of every as-of-now read. */
  now: Date;
}

/**
 * One detail sheet's rows. `rows()` yields one array per row, cells in `columns` order, typed as
 * `columns[i].type` says (ISO strings for `datetime`, `YYYY-MM-DD` for `date`, seconds for
 * `duration_s`, numbers for `percent` in 0–100). The assembler stops iterating at the cap and
 * calls `return()` on the iterator, so a source backed by a cursor or keyset pages must release
 * it in a `finally`.
 */
export interface ReportDetailSource {
  sheet: ReportDetailSheet;
  label: string;
  columns: ReportDetailColumn[];
  rows(): AsyncIterable<unknown[]>;
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
