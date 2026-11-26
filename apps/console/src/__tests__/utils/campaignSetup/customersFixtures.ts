import { vi } from 'vitest';
import type { AgencyColumnAnalysis, AgencyIngestJob, AgencyUploadResponse } from '../../../types/agency-campaign';
import { initialMapping } from '../../../utils/agencyColumnMapping';
import type { CustomersIngest } from '../../../pages/campaigns/agency/setup/CustomersStep';

/**
 * Step 2's fixtures: a column analysis, a complete ingest job (every field the contract
 * declares, as the builder page's tests build it) and a `useRosterIngest` return object.
 */

type Stat = AgencyColumnAnalysis['columns'][number];

function stat(name: string, index: number, samples: string[], over: Partial<Stat> = {}): Stat {
  return { name, index, samples, non_empty: 100, phone_score: 0, distinct: 100, distinct_phones: 0, ...over };
}

/** Sure of its phone column: suggested, not ambiguous, 95% valid. */
export const ANALYSIS: AgencyColumnAnalysis = {
  headers: ['Cust Mobile', 'Full Name', 'City', 'Amount Due', 'Due Date', 'Loan No', 'Branch', 'TZ'],
  columns: [
    stat('Cust Mobile', 0, ['9820041772', '9876543210', '+919812345678'], { phone_score: 0.95, distinct_phones: 95 }),
    stat('Full Name', 1, ['Priya Menon', 'Arjun Rao', 'Meena Iyer']),
    stat('City', 2, ['Pune', 'Chennai', 'Hyderabad']),
    stat('Amount Due', 3, ['12500', '8000', '4300']),
    stat('Due Date', 4, ['2026-11-30', '2026-12-05', '2026-12-10']),
    stat('Loan No', 5, ['LN-1', 'LN-2', 'LN-3']),
    stat('Branch', 6, ['Kothrud', 'Adyar', 'Banjara Hills']),
    stat('TZ', 7, ['Asia/Kolkata']),
  ],
  rows_sampled: 100,
  truncated: true,
  suggested_phone_column: 'Cust Mobile',
  phone_column_ambiguous: false,
  phone_column_candidates: ['Cust Mobile'],
};

export const UPLOAD: AgencyUploadResponse = {
  s3_key: 'agency-ingest/upload-1.csv',
  file_name: 'collections_nov.csv',
  file_size_bytes: 48 * 1024,
  format: 'csv',
};

/** An Excel upload: the server read its first sheet and stored it as CSV (IM8). */
export function xlsxUpload(otherSheetNames: string[] = [], otherSheetCount = otherSheetNames.length): AgencyUploadResponse {
  return {
    s3_key: 'agency-ingest/upload-2.csv',
    file_name: 'Customers May.xlsx',
    file_size_bytes: 64 * 1024,
    format: 'xlsx',
    sheet: { name: 'Customers', other_sheet_names: otherSheetNames, other_sheet_count: otherSheetCount },
  };
}

export function ingestJob(over: Partial<AgencyIngestJob> = {}): AgencyIngestJob {
  return {
    job_id: 'check-1',
    campaign_id: null,
    status: 'completed',
    dry_run: true,
    file_name: 'collections_nov.csv',
    dedupe_columns: [],
    progress_pct: 100,
    rows_read: 1_266,
    accepted: 1_240,
    rejected: 20,
    duplicates: 0,
    rejected_by_reason: { invalid_phone: 9, missing_phone_value: 3, dnc_suppressed: 8 },
    core_rejected_duplicate_rows: 0,
    core_duplicate_source_rows: [],
    chunks_sent: 0,
    headers: ANALYSIS.headers,
    context_columns: null,
    has_rejected_export: true,
    rejected_row_count: 20,
    rejected_truncated: false,
    skipped: 6,
    dnc_by_scope: { account: 8 },
    rejected_sample: [],
    has_skipped_export: true,
    skipped_row_count: 6,
    skipped_truncated: false,
    check_job_id: null,
    import_job_id: null,
    check_expires_at: '2026-11-23T10:00:00.000Z',
    error_code: null,
    error_message: null,
    created_by: '11111111-2222-4333-8444-555555555555',
    created_at: '2026-11-22T10:00:00.000Z',
    started_at: '2026-11-22T10:00:01.000Z',
    finished_at: '2026-11-22T10:00:09.000Z',
    ...over,
  };
}

/** A `useRosterIngest` return in the idle phase, with spies; override what a test needs. */
export function fakeIngest(over: Partial<CustomersIngest> = {}): CustomersIngest {
  return {
    limits: { max_rows: 1_000_000, max_columns: 50, max_cell_bytes: 4096, max_file_bytes: 512 * 1024 * 1024 },
    phase: 'idle',
    setPhase: vi.fn(),
    running: false,
    finished: false,
    reviewing: false,
    retryable: false,
    checkJob: null,
    importing: false,
    uploadingWorkbook: false,
    upload: null,
    analysis: null,
    mapping: null,
    setMapping: vi.fn(),
    job: null,
    error: null,
    downloading: false,
    downloadError: null,
    startIngest: vi.fn(async () => {}),
    onCancelIngest: vi.fn(async () => {}),
    onDownloadRejected: vi.fn(async () => {}),
    onDownloadSkipped: vi.fn(async () => {}),
    reset: vi.fn(),
    ...over,
  };
}

/** A finished, unimported check of {@link UPLOAD}: the review. */
export function reviewingIngest(over: Partial<CustomersIngest> = {}): CustomersIngest {
  return fakeIngest({
    phase: 'done',
    finished: true,
    reviewing: true,
    upload: UPLOAD,
    analysis: ANALYSIS,
    mapping: initialMapping(ANALYSIS),
    job: ingestJob(),
    ...over,
  });
}
