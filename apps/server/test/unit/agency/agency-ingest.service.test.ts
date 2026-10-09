import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  getFileStream: vi.fn(),
  headFile: vi.fn().mockResolvedValue({}),
  uploadFile: vi.fn().mockResolvedValue(undefined),
  sendRosterChunk: vi.fn(),
  supersedeRoster: vi.fn(),
  repo: {
    markRunning: vi.fn().mockResolvedValue(undefined),
    recordReplaceSuperseded: vi.fn().mockResolvedValue(undefined),
    recordReplaceUncertain: vi.fn().mockResolvedValue(undefined),
    updateProgress: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    markCancelled: vi.fn().mockResolvedValue(undefined),
    isCancelRequested: vi.fn().mockResolvedValue(false),
    reapStaleJobs: vi.fn().mockResolvedValue(0),
  },
  filterSuppressed: vi.fn(),
}));

vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: mocks.getFileStream,
  headFile: mocks.headFile,
  uploadFile: mocks.uploadFile,
}));
vi.mock('../../../src/agency/agency-roster.client.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/agency/agency-roster.client.js')>(
    '../../../src/agency/agency-roster.client.js',
  );
  // The error CLASSES come from `actual` so the service's `instanceof` checks
  // match — a locally-declared stand-in would make the fail-closed branch
  // untestable while looking correct (the same reason `DncUnavailableError` is
  // imported for real below).
  return {
    ...actual,
    sendRosterChunk: mocks.sendRosterChunk,
    supersedeRoster: mocks.supersedeRoster,
  };
});
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: mocks.repo,
}));
vi.mock('@magick-agency/observability', async () => ({
  ...(await vi.importActual<typeof import('@magick-agency/observability')>('@magick-agency/observability')),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// `DncUnavailableError` is imported from the real module so `instanceof` in the
// service's catch matches — a locally-declared stand-in class would make the
// fail-closed branch untestable while looking correct.
vi.mock('../../../src/dnc/dnc.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/dnc/dnc.service.js')>(
    '../../../src/dnc/dnc.service.js',
  );
  return { ...actual, dncService: { filterSuppressed: mocks.filterSuppressed } };
});

import { RosterSupersedeError } from '../../../src/agency/agency-roster.client.js';
import {
  AgencyIngestService,
  startAgencyIngestReaper,
  AGENCY_INGEST_REAP_INTERVAL_MS,
} from '../../../src/agency/agency-ingest.service.js';
import type { AgencyIngestJobRecord } from '../../../src/agency/agency-ingest-job.repository.js';

const service = new AgencyIngestService();

function job(overrides: Partial<AgencyIngestJobRecord> = {}): AgencyIngestJobRecord {
  return {
    id: 'job-1',
    tenant_id: 'tenant-1',
    account_id: 'account-1',
    campaign_id: 'campaign-1',
    s3_key: 'agency-ingest/tenant-1/u/roster.csv',
    file_name: 'roster.csv',
    file_size_bytes: '1000',
    phone_column: 'Mobile',
    timezone_column: null,
    ignore_columns: [],
    default_country_code: '91',
    dedupe_phones: true,
    dry_run: false,
    status: 'pending',
    cancel_requested: false,
    rows_read: '0',
    accepted: '0',
    rejected: '0',
    duplicates: '0',
    rejected_by_reason: {},
    bytes_read: '0',
    chunks_sent: 0,
    chunks_total: null,
    headers: null,
    context_columns: null,
    rejected_s3_key: null,
    rejected_row_count: 0,
    rejected_truncated: false,
    core_rejected_duplicate_rows: '0',
    core_duplicate_source_rows: [],
    core_rejected_duplicate_rows_may_undercount: false,
    error_code: null,
    error_message: null,
    created_by: null,
    created_at: new Date(),
    started_at: null,
    finished_at: null,
    updated_at: new Date(),
    ...overrides,
  } as AgencyIngestJobRecord;
}

function csvStream(content: string): void {
  mocks.getFileStream.mockResolvedValue({
    body: Readable.from([Buffer.from(content, 'utf8')]),
    contentLength: Buffer.byteLength(content),
  });
}

const GOOD_CHUNK = {
  accepted: 1,
  duplicate_chunk: false,
  total_contacts: 1,
  rejected_duplicate_rows: 0,
  duplicate_source_rows: [] as number[],
};

describe('AgencyIngestService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headFile.mockResolvedValue({});
    mocks.repo.isCancelRequested.mockResolvedValue(false);
    mocks.sendRosterChunk.mockResolvedValue({ ...GOOD_CHUNK, roster_complete: true });
    // Nothing suppressed by default, so the pre-existing cases keep asking their
    // own questions rather than becoming DNC tests by accident.
    mocks.filterSuppressed.mockResolvedValue(new Set<string>());
    mocks.supersedeRoster.mockResolvedValue({
      superseded: 5000,
      retained: 0,
      contacts_total: 0,
      already_applied: false,
      attempts: 1,
    });
  });

  it('streams accepted contacts to the dialer and completes the job', async () => {
    csvStream('Mobile,Name\n9876543210,Asha\n9123456780,Ravi\n');
    await service.run({ job: job() });

    // One data chunk plus the final marker.
    expect(mocks.sendRosterChunk).toHaveBeenCalledTimes(2);
    const dataChunk = mocks.sendRosterChunk.mock.calls[0]![0];
    expect(dataChunk.contacts).toHaveLength(2);
    expect(dataChunk.contacts[0].phone_e164).toBe('+919876543210');
    expect(dataChunk.isFinal).toBe(false);

    const finalChunk = mocks.sendRosterChunk.mock.calls[1]![0];
    expect(finalChunk.isFinal).toBe(true);
    expect(finalChunk.chunkCount).toBe(1);

    expect(mocks.repo.complete).toHaveBeenCalledOnce();
    expect(mocks.repo.fail).not.toHaveBeenCalled();
  });

  it('always sends a final marker, even when the row count divides evenly', async () => {
    // The dialer needs an is_final call to report completeness; without a terminator
    // a file whose rows exactly fill its chunks would never get one.
    csvStream('Mobile\n9876543210\n');
    await service.run({ job: job() });
    const last = mocks.sendRosterChunk.mock.calls.at(-1)![0];
    expect(last.isFinal).toBe(true);
    expect(last.contacts).toEqual([]);
  });

  it('reconciles accepted + rejected to rows_read', async () => {
    csvStream('Mobile,Name\n9876543210,A\nnotaphone,B\n+919876543210,C\n');
    await service.run({ job: job() });

    const { progress } = mocks.repo.complete.mock.calls[0]![1];
    expect(progress.rows_read).toBe(3);
    expect(progress.accepted).toBe(1);
    expect(progress.rejected).toBe(2);
    // duplicates is a BREAKDOWN of rejected, never a fourth addend.
    expect(progress.duplicates).toBe(1);
    expect(progress.accepted + progress.rejected).toBe(progress.rows_read);
  });

  it('accumulates dialer-side duplicate rejections across chunks instead of discarding them', async () => {
    // The bug this pins: `sendRosterChunk`'s return value used to be
    // discarded at both call sites, so a chunk the dialer reported as fully
    // rejected (every row already in the roster) never moved any counter —
    // the operator's summary stayed "accepted" for a re-upload that changed
    // nothing on the dialer's side.
    const rows = Array.from({ length: 1200 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    csvStream(`Mobile\n${rows}\n`);
    mocks.sendRosterChunk
      .mockResolvedValueOnce({ ...GOOD_CHUNK, rejected_duplicate_rows: 500, duplicate_source_rows: [2, 3] })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, rejected_duplicate_rows: 200, duplicate_source_rows: [502, 503] })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, roster_complete: true }); // final marker, no contacts

    await service.run({ job: job() });

    expect(mocks.repo.complete).toHaveBeenCalledOnce();
    const completeArg = mocks.repo.complete.mock.calls[0]![1];
    expect(completeArg.progress.core_rejected_duplicate_rows).toBe(700);
    expect(completeArg.progress.core_duplicate_source_rows).toEqual([2, 3, 502, 503]);
  });

  it('caps the dialer-duplicate sample without under-counting the running total', async () => {
    // The exact total must never be capped even once the SAMPLE array is full —
    // an operator needs to know "how many", the sample is only "which ones".
    const rows = Array.from({ length: 1200 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    csvStream(`Mobile\n${rows}\n`);
    const bigSample = Array.from({ length: 15 }, (_, i) => i + 1);
    mocks.sendRosterChunk
      .mockResolvedValueOnce({ ...GOOD_CHUNK, rejected_duplicate_rows: 15, duplicate_source_rows: bigSample })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, rejected_duplicate_rows: 15, duplicate_source_rows: bigSample.map((n) => n + 100) })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, roster_complete: true });

    await service.run({ job: job() });

    const completeArg = mocks.repo.complete.mock.calls[0]![1];
    expect(completeArg.progress.core_rejected_duplicate_rows).toBe(30);
    expect(completeArg.progress.core_duplicate_source_rows).toHaveLength(20);
  });

  it('an UNFLAGGED replay contributes an exact zero and leaves the summary trustworthy', async () => {
    // This case used to be the honest ceiling of what the ingest could know: the dialer's
    // `applyIngestChunk` rolls back BEFORE re-running the per-row conflict check
    // on a replay, so it had no counts of its own and answered a confident zero
    // it had no basis for. Migration 084 closed that — the counts are
    // recorded inside the transaction that refused the rows and read back on
    // replay — so a replay reporting 0 with NO `rejection_counts_unavailable`
    // flag now genuinely means "that chunk refused nothing".
    //
    // Which makes this the guard on the fail-safe: absence of the flag must
    // continue to mean "trustworthy", so a service that starts mistrusting every
    // replay would raise a warning on every ordinary retry.
    const rows = Array.from({ length: 700 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    csvStream(`Mobile\n${rows}\n`);
    mocks.sendRosterChunk
      .mockResolvedValueOnce({ ...GOOD_CHUNK, duplicate_chunk: true, rejected_duplicate_rows: 0, duplicate_source_rows: [] })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, roster_complete: true });

    await service.run({ job: job() });

    const completeArg = mocks.repo.complete.mock.calls[0]![1];
    expect(completeArg.progress.core_rejected_duplicate_rows).toBe(0);
    expect(completeArg.progress.core_rejected_duplicate_rows_may_undercount).toBe(false);
    expect(completeArg.progress.accepted).toBeGreaterThan(0);
  });

  it('a chunk that could not report what it refused marks the whole total a lower bound', async () => {
    // The residual case that cannot be fixed: a replay of a chunk applied BEFORE
    // migration 084 recorded nothing, and a row refused by
    // `uq_agency_contacts_row_fingerprint` leaves no residue to recount. The dialer says
    // `rejection_counts_unavailable` rather than inventing a zero, and the ingest has
    // to carry that forward — otherwise the operator reads "0 refused" for an
    // import that may have refused every row it sent.
    const rows = Array.from({ length: 700 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    csvStream(`Mobile\n${rows}\n`);
    mocks.sendRosterChunk
      .mockResolvedValueOnce({
        ...GOOD_CHUNK,
        duplicate_chunk: true,
        rejected_duplicate_rows: 0,
        duplicate_source_rows: [],
        rejection_counts_unavailable: true,
      })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, roster_complete: true });

    await service.run({ job: job() });

    const completeArg = mocks.repo.complete.mock.calls[0]![1];
    expect(completeArg.progress.core_rejected_duplicate_rows_may_undercount).toBe(true);
  });

  it('the lower-bound flag is STICKY — a later clean chunk does not clear it', async () => {
    // The flag qualifies the whole-job total, not the most recent chunk. Assigning
    // instead of OR-ing would let the ordinary final-marker chunk (which reports
    // cleanly, always) wipe the one honest warning the import produced — and the
    // final marker is guaranteed to arrive after every real chunk, so the bug
    // would be total rather than occasional.
    const rows = Array.from({ length: 1200 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    csvStream(`Mobile\n${rows}\n`);
    mocks.sendRosterChunk
      .mockResolvedValueOnce({ ...GOOD_CHUNK, duplicate_chunk: true, rejection_counts_unavailable: true })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, rejected_duplicate_rows: 3, duplicate_source_rows: [7] })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, roster_complete: true });

    await service.run({ job: job() });

    const completeArg = mocks.repo.complete.mock.calls[0]![1];
    expect(completeArg.progress.core_rejected_duplicate_rows_may_undercount).toBe(true);
    // And the exact counts from the other chunks are still added — an unknown
    // chunk makes the total a LOWER BOUND, it does not discard what is known.
    expect(completeArg.progress.core_rejected_duplicate_rows).toBe(3);
  });

  it('rides the same progress heartbeat as the counts, so a cancelled job still says it may be short', async () => {
    // Same reasoning as `core_duplicate_source_rows`: a job that never reaches
    // complete() would otherwise persist a count from its last progress flush
    // with no indication that the count is a floor.
    const rows = Array.from({ length: 700 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    csvStream(`Mobile\n${rows}\n`);
    mocks.sendRosterChunk
      .mockResolvedValueOnce({ ...GOOD_CHUNK, duplicate_chunk: true, rejection_counts_unavailable: true })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, roster_complete: true });

    await service.run({ job: job() });

    const firstFlush = mocks.repo.updateProgress.mock.calls[0]![1];
    expect(firstFlush.core_rejected_duplicate_rows_may_undercount).toBe(true);
  });

  it('flushes the duplicate-source sample on periodic progress ticks, not only at complete()', async () => {
    // The gap this closes: only complete() used to receive the sample, so a
    // job that never reaches complete() (cancelled or failed mid-ingest)
    // reported a non-zero core_rejected_duplicate_rows count from its last
    // progress flush with an empty examples list — the count said "N
    // collided" and the sample showed nothing. Both now ride the same
    // `progress` object, so a periodic `updateProgress()` flush carries
    // whatever the sample holds at that moment.
    const rows = Array.from({ length: 700 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    csvStream(`Mobile\n${rows}\n`);
    mocks.sendRosterChunk
      .mockResolvedValueOnce({ ...GOOD_CHUNK, rejected_duplicate_rows: 5, duplicate_source_rows: [9, 10] })
      .mockResolvedValueOnce({ ...GOOD_CHUNK, roster_complete: true });

    await service.run({ job: job() });

    // The very first flushProgress() call in a fresh run always fires
    // (lastProgressFlush starts at 0), and it happens right after the first
    // chunk is folded — so it must already carry that chunk's sample.
    expect(mocks.repo.updateProgress).toHaveBeenCalled();
    const firstFlush = mocks.repo.updateProgress.mock.calls[0]![1];
    expect(firstFlush.core_duplicate_source_rows).toEqual([9, 10]);
    expect(firstFlush.core_rejected_duplicate_rows).toBe(5);
  });

  it('a dry run sends NOTHING to the dialer but still reports the full summary', async () => {
    // This is what lets the wizard say "95% of your rows are valid" before the
    // operator commits to a campaign.
    csvStream('Mobile\n9876543210\nnotaphone\n');
    await service.run({ job: job({ dry_run: true, campaign_id: null }) });

    expect(mocks.sendRosterChunk).not.toHaveBeenCalled();
    expect(mocks.repo.complete).toHaveBeenCalledOnce();
    const { progress } = mocks.repo.complete.mock.calls[0]![1];
    expect(progress.accepted).toBe(1);
    expect(progress.rejected).toBe(1);
  });

  it('refuses a real import with no campaign rather than half-running it', async () => {
    csvStream('Mobile\n9876543210\n');
    await service.run({ job: job({ dry_run: false, campaign_id: null }) });
    expect(mocks.repo.fail).toHaveBeenCalledWith('job-1', 'no_campaign', expect.any(String));
    expect(mocks.sendRosterChunk).not.toHaveBeenCalled();
  });

  it('writes a rejected-rows export with the resolved column set', async () => {
    csvStream('Mobile,Name,SSN\nnotaphone,Asha,SECRET\n9876543210,Ravi,X\n');
    await service.run({ job: job({ ignore_columns: ['SSN'] }) });

    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    const [key, buffer, contentType] = mocks.uploadFile.mock.calls[0]!;
    const document = (buffer as Buffer).toString('utf8');

    expect(key).toBe('agency-ingest/tenant-1/job-1/rejected-rows.csv');
    expect(contentType).toBe('text/csv');
    // Original columns plus `_reason`, so the operator fixes it in Excel.
    expect(document).toContain('_row,Mobile,Name,_reason');
    expect(document).toContain('notaphone');
    // The ignored column must not reappear in the export — that would be the
    // leak the `Ignore` mapping existed to prevent.
    expect(document).not.toContain('SSN');
    expect(document).not.toContain('SECRET');
  });

  it('writes no export when nothing was rejected', async () => {
    csvStream('Mobile\n9876543210\n');
    await service.run({ job: job() });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.repo.complete.mock.calls[0]![1].rejected_s3_key).toBeNull();
  });

  it('fails the job when the dialer reports a gap rather than dialing a partial list', async () => {
    csvStream('Mobile\n9876543210\n');
    mocks.sendRosterChunk
      .mockResolvedValueOnce(GOOD_CHUNK)
      .mockResolvedValueOnce({ ...GOOD_CHUNK, roster_complete: false, missing_chunks: [3] });

    await service.run({ job: job() });

    expect(mocks.repo.fail).toHaveBeenCalledWith(
      'job-1',
      'roster_incomplete',
      expect.stringContaining('3'),
    );
    expect(mocks.repo.complete).not.toHaveBeenCalled();
  });

  it('records a whole-file parse failure with its structured code', async () => {
    csvStream('Mobile,Name\n9876543210,Asha\n');
    await service.run({ job: job({ phone_column: 'NotAColumn' }) });
    expect(mocks.repo.fail).toHaveBeenCalledWith(
      'job-1',
      'phone_column_missing',
      expect.any(String),
    );
  });

  it('cancels between chunks and marks the job cancelled', async () => {
    // A chunk already in flight must finish — cancelling mid-chunk leaves its
    // idempotency key in a state neither side can reason about.
    const rows = Array.from({ length: 1200 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    csvStream(`Mobile\n${rows}\n`);
    mocks.repo.isCancelRequested.mockResolvedValueOnce(false).mockResolvedValue(true);

    await service.run({ job: job() });

    // No roster note: this is an append, so nothing was retired to explain.
    expect(mocks.repo.markCancelled).toHaveBeenCalledWith('job-1', undefined);
    expect(mocks.repo.complete).not.toHaveBeenCalled();
    // The first chunk went out in full before the cancel took effect.
    expect(mocks.sendRosterChunk.mock.calls[0]![0].contacts).toHaveLength(500);
  });

  it('never rejects — a detached run records every outcome on the job row', async () => {
    // A promise that throws here is an unhandled rejection AND a job stuck in
    // `running` forever, which the wizard polls indefinitely.
    mocks.getFileStream.mockRejectedValue(new Error('S3 exploded'));
    await expect(service.run({ job: job() })).resolves.toBeUndefined();
    expect(mocks.repo.fail).toHaveBeenCalledWith('job-1', 'unexpected_error', 'S3 exploded');
  });

  it('passes the campaign country code through to normalisation', async () => {
    csvStream('Mobile\n4155550123\n');
    await service.run({ job: job({ default_country_code: '1' }) });
    expect(mocks.sendRosterChunk.mock.calls[0]![0].contacts[0].phone_e164).toBe('+14155550123');
  });

  it('honours dedupe_phones=false so a shared number keeps both people', async () => {
    csvStream('Mobile,Name\n+919876543210,Asha\n+919876543210,Ravi\n');
    await service.run({ job: job({ dedupe_phones: false }) });
    expect(mocks.sendRosterChunk.mock.calls[0]![0].contacts).toHaveLength(2);
  });

  // ── DNC suppression at ingest ──────────────────────────────

  describe('DNC suppression', () => {
    it('drops a suppressed contact and never sends it to the dialer', async () => {
      mocks.filterSuppressed.mockResolvedValue(new Set(['+919876543210']));
      csvStream('Mobile,Name\n9876543210,Asha\n9123456780,Ravi\n');

      await service.run({ job: job() });

      const dataChunk = mocks.sendRosterChunk.mock.calls[0]![0];
      // The design's implementable clause: suppressed rows "never enter the roster".
      // The ingest cannot cause a dialer-side `state='suppressed'` row — the dialer's
      // `AgencyIngestContact` has no state field — so dropping is the only reading
      // of that sentence the ingest can act on.
      expect(dataChunk.contacts).toHaveLength(1);
      expect(dataChunk.contacts[0].phone_e164).toBe('+919123456780');
    });

    it('checks BEFORE sending, once per batch, with the full E.164 list', async () => {
      csvStream('Mobile\n9876543210\n9123456780\n');

      await service.run({ job: job() });

      // One query per batch, served by `idx_dnc_entries_tenant_phone` — the plain
      // index the design requires because the COALESCE unique index cannot answer a
      // per-number lookup. Per-contact probes would be 1M queries on a 1M roster.
      expect(mocks.filterSuppressed).toHaveBeenCalledTimes(1);
      expect(mocks.filterSuppressed.mock.calls[0]![1]).toEqual([
        '+919876543210',
        '+919123456780',
      ]);
    });

    it('looks up with the CAMPAIGN scope, because scoped rows are enforced only here', async () => {
      csvStream('Mobile\n9876543210\n');

      await service.run({ job: job() });

      // The dialer's flat `dnc:{tenantId}` set cannot express account or campaign scope,
      // so ingest is the ONLY place a scoped row is ever applied. Omitting the
      // campaign from the lookup would make every campaign-scoped entry inert.
      expect(mocks.filterSuppressed.mock.calls[0]![0]).toEqual({
        tenantId: 'tenant-1',
        accountId: 'account-1',
        campaignId: 'campaign-1',
      });
    });

    it('counts a suppression as a REJECTION, keeping accepted + rejected = rows_read', async () => {
      mocks.filterSuppressed.mockResolvedValue(new Set(['+919876543210']));
      csvStream('Mobile,Name\n9876543210,Asha\n9123456780,Ravi\nnotaphone,C\n');

      await service.run({ job: job() });

      const { progress, rejected_by_reason } = mocks.repo.complete.mock.calls[0]![1];
      /**
       * Migration 053 asserts this invariant explicitly — `duplicates` is a
       * breakdown of `rejected`, never a fourth addend, "so an operator can
       * reconcile against their spreadsheet". A third addend for DNC would have
       * broken exactly that, so the suppressed rows move from accepted to
       * rejected instead, and the count lives in the breakdown.
       */
      expect(progress.rows_read).toBe(3);
      expect(progress.accepted).toBe(1);
      expect(progress.rejected).toBe(2);
      expect(progress.accepted + progress.rejected).toBe(progress.rows_read);
      expect(rejected_by_reason['dnc_suppressed']).toBe(1);
    });

    it('omits the dnc_suppressed key entirely when nothing was suppressed', async () => {
      csvStream('Mobile\n9876543210\n');

      await service.run({ job: job() });

      const { rejected_by_reason } = mocks.repo.complete.mock.calls[0]![1];
      // A `dnc_suppressed: 0` key renders as a zero row in the wizard's rejection
      // breakdown on every clean import.
      expect('dnc_suppressed' in rejected_by_reason).toBe(false);
    });

    it('puts suppressed rows in the rejected-rows export, with their context', async () => {
      mocks.filterSuppressed.mockResolvedValue(new Set(['+919876543210']));
      csvStream('Mobile,Name\n9876543210,Asha\n');

      await service.run({ job: job() });

      const document = (mocks.uploadFile.mock.calls[0]![1] as Buffer).toString('utf8');
      // The operator has to reconcile 10,000 uploaded rows against 9,999 dialable
      // ones; "on the Do Not Call list" is the only answer that does not read as a
      // bug. The original columns come back so the row is identifiable.
      // The export carries the human LABEL, not the code — `_reason` is what an
      // operator reads in a spreadsheet. The code lives in `rejected_by_reason`.
      expect(document).toContain('On the Do Not Call list');
      expect(document).toContain('Asha');
      const { rejected_row_count } = mocks.repo.complete.mock.calls[0]![1];
      expect(rejected_row_count).toBe(1);
    });

    it('sends NO chunk at all when every row in a batch was suppressed', async () => {
      mocks.filterSuppressed.mockResolvedValue(new Set(['+919876543210']));
      csvStream('Mobile\n9876543210\n');

      await service.run({ job: job() });

      // Only the final marker. An empty data chunk would burn a chunk index and
      // make the dialer's completeness check count a chunk carrying no contacts.
      expect(mocks.sendRosterChunk).toHaveBeenCalledTimes(1);
      expect(mocks.sendRosterChunk.mock.calls[0]![0].isFinal).toBe(true);
      expect(mocks.repo.complete).toHaveBeenCalledOnce();
    });

    it('a DRY RUN checks DNC too, so its dialable count is the real one', async () => {
      mocks.filterSuppressed.mockResolvedValue(new Set(['+919876543210']));
      csvStream('Mobile\n9876543210\n9123456780\n');

      await service.run({ job: job({ dry_run: true }) });

      // The dry run exists to tell the operator "95% of your rows are valid"
      // before they commit. Skipping the check would promise a dialable count the
      // real import cannot deliver, which is worse than not offering the estimate.
      expect(mocks.filterSuppressed).toHaveBeenCalledTimes(1);
      expect(mocks.sendRosterChunk).not.toHaveBeenCalled();
      const { progress } = mocks.repo.complete.mock.calls[0]![1];
      expect(progress.accepted).toBe(1);
      expect(progress.rejected).toBe(1);
    });

    it('FAILS the job when the list cannot be read — never imports unchecked rows', async () => {
      const { DncUnavailableError } = await import('../../../src/dnc/dnc.service.js');
      mocks.filterSuppressed.mockRejectedValue(new DncUnavailableError('list unavailable'));
      csvStream('Mobile\n9876543210\n9123456780\n');

      await service.run({ job: job() });

      /**
       * The polarity assertion. Completing with the rows checked before the outage
       * and the rest sent unchecked is a compliance violation at volume, wearing a
       * green summary the operator would reasonably trust. A failed import costs
       * them a retry; a wrongly-dialed suppressed number is a regulatory event.
       */
      expect(mocks.repo.fail).toHaveBeenCalledWith(
        'job-1',
        'dnc_unavailable',
        expect.stringContaining('Do Not Call list could not be checked'),
      );
      expect(mocks.repo.complete).not.toHaveBeenCalled();
      // And nothing reached the dialer — not even the rows from before the failure.
      expect(mocks.sendRosterChunk).not.toHaveBeenCalled();
    });

    it('does not mistake a DNC outage for a generic unexpected error', async () => {
      const { DncUnavailableError } = await import('../../../src/dnc/dnc.service.js');
      mocks.filterSuppressed.mockRejectedValue(new DncUnavailableError('list unavailable'));
      csvStream('Mobile\n9876543210\n');

      await service.run({ job: job() });

      // `unexpected_error` would give the wizard no copy to render and would make
      // a compliance halt indistinguishable in dashboards from an S3 failure.
      const [, code] = mocks.repo.fail.mock.calls[0]!;
      expect(code).toBe('dnc_unavailable');
    });
  });

  /**
   * ── `mode: 'replace'` ──────────────────────────────────────────────────────
   *
   * Migration 083 made a corrected re-upload MERGE rather than be
   * refused, because the dialer cannot tell a correction from a top-up — the two are
   * the same request. Only the ingest holds the file, the mapping and the operator's
   * intent, so the resolution is a mode on the import, and its whole safety
   * argument lives in this service's ordering.
   */
  describe('replace mode', () => {
    const replaceJob = () => job({ mode: 'replace' });

    it('checks the file exists, THEN retires, THEN sends the first chunk', async () => {
      // Two constraints, and they pull in opposite directions until the check is
      // a HEAD:
      //
      //  - Retire before the first CHUNK is forced. `uq_agency_contacts_row_fingerprint`
      //    is unique over LIVE rows, so ingesting first and retiring afterwards
      //    would have every UNCHANGED person in the corrected file collide with
      //    their own still-live old row, be refused, and then have that old row
      //    retired underneath them — they would vanish from the campaign.
      //  - Retire before the file is proved to exist is NOT forced, and was
      //    wrong: a mistyped key retired the roster and only then failed the
      //    import.
      //
      // A HEAD satisfies both — it sends no chunk, and it holds no S3 body open
      // across the supersede's four possible 30s attempts.
      const order: string[] = [];
      mocks.headFile.mockImplementation(async () => {
        order.push('head');
        return { contentLength: 20 };
      });
      mocks.supersedeRoster.mockImplementation(async () => {
        order.push('supersede');
        return { superseded: 5000, retained: 0, contacts_total: 0, already_applied: false, attempts: 1 };
      });
      mocks.getFileStream.mockImplementation(async () => {
        order.push('open-file');
        return {
          body: Readable.from([Buffer.from('Mobile\n9876543210\n', 'utf8')]),
          contentLength: 20,
        };
      });
      mocks.sendRosterChunk.mockImplementation(async () => {
        order.push('chunk');
        return { ...GOOD_CHUNK, roster_complete: true };
      });

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      expect(order[0]).toBe('head');
      expect(order[1]).toBe('supersede');
      expect(order[2]).toBe('open-file');
      expect(order.slice(3).every((step) => step === 'chunk')).toBe(true);
    });

    it('retires NOTHING when the S3 object is missing', async () => {
      // The finding this ordering exists for: an unreadable file could never have
      // produced a roster, so it must not cost the operator the one they have.
      mocks.headFile.mockRejectedValue(new Error('NoSuchKey: the specified key does not exist'));

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      expect(mocks.supersedeRoster).not.toHaveBeenCalled();
      expect(mocks.getFileStream).not.toHaveBeenCalled();
      expect(mocks.sendRosterChunk).not.toHaveBeenCalled();
      const [, code, message] = mocks.repo.fail.mock.calls[0]!;
      expect(code).toBe('unexpected_error');
      // And no roster warning, because there is nothing to warn about.
      expect(message).not.toContain('already retired');
      expect(message).not.toContain('could not be confirmed');
    });

    it('an append pays for no extra S3 round trip', async () => {
      // The probe exists for the destructive path only. Adding a HEAD to every
      // import would put a new failure mode in front of appends that work today.
      csvStream('Mobile\n9876543210\n');
      await service.run({ job: job() });
      expect(mocks.headFile).not.toHaveBeenCalled();
    });

    it('scopes the supersede to this job and forwards the operator\'s expected count', async () => {
      csvStream('Mobile\n9876543210\n');
      await service.run({ job: replaceJob(), expectedContactsTotal: 4321 });

      expect(mocks.supersedeRoster).toHaveBeenCalledOnce();
      expect(mocks.supersedeRoster.mock.calls[0]![0]).toMatchObject({
        campaignId: 'campaign-1',
        ingestJobId: 'job-1',
        expectedContactsTotal: 4321,
        reason: 'replace',
      });
    });

    it('records the retired count immediately, not at completion', async () => {
      // From the moment the dialer answers, the campaign has no dialable roster of its
      // own. A process killed on the next line must still leave that number
      // where the operator can find it — recorded at completion it would be
      // missing from exactly the runs where it is the only thing that matters.
      csvStream('Mobile\n9876543210\n');
      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      expect(mocks.repo.recordReplaceSuperseded).toHaveBeenCalledWith('job-1', 5000);
      // Before any chunk — the assertion that makes "immediately" mean something.
      const recordOrder = mocks.repo.recordReplaceSuperseded.mock.invocationCallOrder[0]!;
      const firstChunkOrder = mocks.sendRosterChunk.mock.invocationCallOrder[0]!;
      expect(recordOrder).toBeLessThan(firstChunkOrder);
    });

    it('an append never touches the existing roster', async () => {
      // The default, and the whole reason a missing mode is safe.
      csvStream('Mobile\n9876543210\n');
      await service.run({ job: job() });
      expect(mocks.supersedeRoster).not.toHaveBeenCalled();
    });

    it('a dry run never retires anything, even if it somehow carries the mode', async () => {
      // The route refuses this combination outright; this is the second line of
      // defence, and it is worth having because a preview that destroys the
      // thing it is previewing is the least recoverable mistake in the feature.
      csvStream('Mobile\n9876543210\n');
      await service.run({ job: job({ mode: 'replace', dry_run: true, campaign_id: null }) });
      expect(mocks.supersedeRoster).not.toHaveBeenCalled();
    });

    it('a refused replace sends NOTHING and says the roster is untouched', async () => {
      // The gate. The dialer does not implement the supersede hop yet, so every
      // replace fails here — and it must fail having mutated nothing, or a
      // half-built destructive path would look like it works.
      //
      // `attempts: 1` is what licenses the categorical wording; see the
      // retry-after-commit cases below for why it cannot be assumed.
      csvStream('Mobile\n9876543210\n');
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError('This deployment cannot replace a roster yet.', 404, 'unsupported', undefined, 1),
      );

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      expect(mocks.sendRosterChunk).not.toHaveBeenCalled();
      expect(mocks.repo.complete).not.toHaveBeenCalled();
      expect(mocks.repo.recordReplaceSuperseded).not.toHaveBeenCalled();
      const [, code, message] = mocks.repo.fail.mock.calls[0]!;
      expect(code).toBe('replace_unsupported');
      expect(message).toContain('were not touched');
    });

    it('distinguishes the dialer\'s refusal from its absence, because the fixes differ', async () => {
      csvStream('Mobile\n9876543210\n');
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError('The campaign is running.', 409, 'refused', 'campaign_dialing', 1),
      );

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      const [, code] = mocks.repo.fail.mock.calls[0]!;
      expect(code).toBe('replace_refused');
    });

    it('will NOT claim the roster is untouched once a retry happened', async () => {
      /**
       * The lie this closes. `supersedeRoster` makes up to four attempts, so
       * attempt 1 can retire 5,000 contacts and commit, lose its response, and
       * attempt 2 be refused by the dialer's compare-and-swap with
       * `409 contacts_total_mismatch`. The ingest then reported a refusal AND told the
       * operator their contacts were not touched — while the roster was empty and
       * `replace_superseded_contacts` sat at NULL, so the field documented as the
       * one to render loudest on a failed replace rendered nothing.
       *
       * `attempts > 1` is the discriminator, and it is deliberately coarse in the
       * safe direction: a 409 on attempt 2 may genuinely be a colleague's
       * concurrent top-up, and that is reported as uncertain too. Saying "check
       * your roster" when it is fine costs a page refresh.
       */
      csvStream('Mobile\n9876543210\n');
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError(
          'Roster has 0 contacts, expected 5000.',
          409,
          'refused',
          'contacts_total_mismatch',
          2,
        ),
      );

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      const [, code, message] = mocks.repo.fail.mock.calls[0]!;
      expect(code).toBe('replace_refused');
      expect(message).not.toContain('were not touched');
      expect(message).toContain('may have retired your existing contacts');
      // And it is RECORDED, not merely said — this is what puts a non-null signal
      // on the field the UI renders.
      expect(mocks.repo.recordReplaceUncertain).toHaveBeenCalledWith('job-1');
    });

    it('an exhausted retry produces a real message, not a bare dialer error', async () => {
      // `withRetry` rethrows the raw error, which is not a
      // RosterSupersedeError, so this used to reach the generic
      // `unexpected_error` arm with a bare 503 message and
      // NOTHING about the roster. The client now wraps it, so it lands here.
      csvStream('Mobile\n9876543210\n');
      mocks.supersedeRoster.mockRejectedValue(
        new RosterSupersedeError(
          'Could not reach the dialer runtime to change this roster (4 attempts): the handler returned 503',
          0,
          'failed',
          undefined,
          4,
        ),
      );

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      const [, code, message] = mocks.repo.fail.mock.calls[0]!;
      expect(code).toBe('replace_failed');
      expect(code).not.toBe('unexpected_error');
      expect(message).toContain('may have retired your existing contacts');
      expect(mocks.repo.recordReplaceUncertain).toHaveBeenCalledWith('job-1');
      expect(mocks.sendRosterChunk).not.toHaveBeenCalled();
    });

    it('treats already_applied as UNKNOWN, never as a count of zero', async () => {
      /**
       * `already_applied: true` means the dialer found the work done — by a previous run
       * or by an attempt of this one whose response was lost. The roster IS retired
       * and the ingest does not know by how much. Recording
       * `recordReplaceSuperseded(job.id, 0)` was the bug: a job that retired 5,000
       * contacts rendered `0`, and its failure message went on to say "your
       * previous 0 contacts were already retired".
       */
      csvStream('Mobile\n9876543210\n');
      mocks.supersedeRoster.mockResolvedValue({
        superseded: 0,
        retained: 0,
        contacts_total: 0,
        already_applied: true,
        attempts: 2,
      });
      mocks.sendRosterChunk.mockRejectedValue(new Error('handler exploded'));

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      // Never a zero count.
      expect(mocks.repo.recordReplaceSuperseded).not.toHaveBeenCalled();
      expect(mocks.repo.recordReplaceUncertain).toHaveBeenCalledWith('job-1');
      const [, , message] = mocks.repo.fail.mock.calls[0]!;
      expect(message).not.toContain('previous 0 contacts');
      expect(message).toContain('could not be confirmed');
    });

    it('a failure AFTER the retire tells the operator their roster is already gone', async () => {
      // The dangerous state this feature creates, and the entire mitigation is
      // that the operator is told. "The import failed" is reassuring and, after a
      // supersede, false — they would believe they still have this morning's
      // roster.
      csvStream('Mobile\n9876543210\n');
      mocks.sendRosterChunk.mockRejectedValue(new Error('handler exploded'));

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      const [, code, message] = mocks.repo.fail.mock.calls[0]!;
      expect(code).toBe('unexpected_error');
      expect(message).toContain('5,000 contacts were already retired');
      expect(message).toContain('cannot be started');
    });

    it('a CANCEL after the retire says the contacts are gone, not just "cancelled"', async () => {
      /**
       * Cancellation is only ever observed in `onBatch`, which runs after the
       * supersede — so a cancelled replace leaves an EMPTY campaign. Writing
       * `status='cancelled'` and nothing else told the operator their import
       * stopped and said nothing about the roster it had already retired: the same
       * class of defect as the failure paths, reached by the one exit that skipped
       * `failJob`.
       */
      const rows = Array.from({ length: 1200 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
      csvStream(`Mobile\n${rows}\n`);
      mocks.repo.isCancelRequested.mockResolvedValueOnce(false).mockResolvedValue(true);

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      const [, note] = mocks.repo.markCancelled.mock.calls[0]!;
      expect(note).toContain('5,000 contacts were already retired');
      expect(note).toContain('cannot be started');
      // A cancel is not a failure: still `cancelled`, never `failed`.
      expect(mocks.repo.fail).not.toHaveBeenCalled();
    });

    it('a CANCEL after an UNCONFIRMED retire hedges, exactly as the failure paths do', async () => {
      // The three-state `RosterRetirement` is shared, so cancel cannot invent a
      // fourth reading — `already_applied` means the roster is retired by an
      // unknown amount, and that is what the note has to say.
      const rows = Array.from({ length: 1200 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
      csvStream(`Mobile\n${rows}\n`);
      mocks.supersedeRoster.mockResolvedValue({
        superseded: 0, retained: 0, contacts_total: 0, already_applied: true, attempts: 2,
      });
      mocks.repo.isCancelRequested.mockResolvedValueOnce(false).mockResolvedValue(true);

      await service.run({ job: replaceJob(), expectedContactsTotal: 5000 });

      const [, note] = mocks.repo.markCancelled.mock.calls[0]!;
      expect(note).toContain('could not be confirmed');
      expect(note).not.toContain('previous 0 contacts');
    });

    it('a cancelled APPEND carries no note at all', async () => {
      // Nothing was retired, so there is nothing to explain — and a note on every
      // cancel would train operators to ignore the one that matters. `undefined`
      // rather than an empty string, so the column stays NULL.
      const rows = Array.from({ length: 1200 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
      csvStream(`Mobile\n${rows}\n`);
      mocks.repo.isCancelRequested.mockResolvedValueOnce(false).mockResolvedValue(true);

      await service.run({ job: job() });

      expect(mocks.repo.markCancelled).toHaveBeenCalledWith('job-1', undefined);
    });

    it('an APPEND failure carries no such warning — nothing was retired', async () => {
      // The counterpart assertion, and the one that keeps the sentence
      // meaningful: bolting it onto every failure would train operators to
      // ignore it.
      csvStream('Mobile\n9876543210\n');
      mocks.sendRosterChunk.mockRejectedValue(new Error('handler exploded'));

      await service.run({ job: job() });

      const [, , message] = mocks.repo.fail.mock.calls[0]!;
      expect(message).not.toContain('already retired');
    });
  });
});

describe('startAgencyIngestReaper — the periodic sweep the boot-time reap needs', () => {
  // A sibling describe, not nested under `AgencyIngestService` — its
  // `beforeEach` (which clears mocks per test) does not reach here, so this
  // block resets `reapStaleJobs` itself.
  beforeEach(() => {
    mocks.repo.reapStaleJobs.mockReset();
    mocks.repo.reapStaleJobs.mockResolvedValue(0);
  });

  // The bug this pins: a one-shot boot-time `reapStaleJobs()` call catches
  // almost nothing, because a process killed mid-ingest leaves `updated_at`
  // only a second or two old — the REPLACEMENT replica boots seconds later
  // and finds nothing stale yet. Without a sweep that keeps re-checking after
  // boot, a job orphaned even a few minutes into a replica's uptime sits
  // `running` forever with no future reap ever scheduled.
  it('runs reapStaleJobs on the interval', async () => {
    vi.useFakeTimers();
    try {
      const handle = startAgencyIngestReaper();
      expect(mocks.repo.reapStaleJobs).not.toHaveBeenCalled();

      // Exact tick boundary, not a generous one — a wrong interval must fail
      // this, not slide through on a loose `toBeGreaterThan(0)`.
      await vi.advanceTimersByTimeAsync(AGENCY_INGEST_REAP_INTERVAL_MS - 1);
      expect(mocks.repo.reapStaleJobs).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.repo.reapStaleJobs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(AGENCY_INGEST_REAP_INTERVAL_MS);
      expect(mocks.repo.reapStaleJobs).toHaveBeenCalledTimes(2);

      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops sweeping once its handle is cleared, so shutdown is clean', async () => {
    vi.useFakeTimers();
    try {
      const handle = startAgencyIngestReaper();
      clearInterval(handle);

      await vi.advanceTimersByTimeAsync(AGENCY_INGEST_REAP_INTERVAL_MS * 3);
      expect(mocks.repo.reapStaleJobs).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing sweep is logged and does not throw out of the interval callback', async () => {
    vi.useFakeTimers();
    try {
      mocks.repo.reapStaleJobs.mockRejectedValueOnce(new Error('db down'));
      const handle = startAgencyIngestReaper();

      await vi.advanceTimersByTimeAsync(AGENCY_INGEST_REAP_INTERVAL_MS);
      // The interval itself must survive a rejected sweep — Node would
      // otherwise treat it as an unhandled rejection, and worse, a thrown
      // callback silently ends the timer, losing the sweep for good.
      await vi.advanceTimersByTimeAsync(AGENCY_INGEST_REAP_INTERVAL_MS);
      expect(mocks.repo.reapStaleJobs).toHaveBeenCalledTimes(2);

      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });
});
