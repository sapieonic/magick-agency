import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import {
  AgencyIngestJobRepository,
  AGENCY_INGEST_JOB_STALE_MINUTES,
} from '../../../src/agency/agency-ingest-job.repository.js';

const repo = new AgencyIngestJobRepository();
const TENANT = 'tenant-1';

/** Normalise whitespace so assertions survive reformatting of the SQL. */
function sqlOf(callIndex = 0): string {
  return (mocks.query.mock.calls[callIndex]![0] as string).replace(/\s+/g, ' ').trim();
}
function paramsOf(callIndex = 0): unknown[] {
  return mocks.query.mock.calls[callIndex]![1] as unknown[];
}

describe('AgencyIngestJobRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [{ id: 'job-1' }], rowCount: 1 });
  });

  describe('create', () => {
    it('defaults dedupe_phones on and dry_run off', async () => {
      // Dedupe defaults ON because the customer asked for duplicate detection
      // by name; dry_run defaults OFF so an unqualified create is a real import.
      await repo.create({
        tenant_id: TENANT,
        s3_key: 'k',
        file_name: 'f.csv',
        phone_column: 'Mobile',
      });

      const params = paramsOf();
      expect(params[10]).toBe(true); // dedupe_phones
      expect(params[11]).toBe(false); // dry_run
    });

    it('preserves an explicit dedupe_phones=false', async () => {
      // Two people can legitimately share one number; the operator decides.
      await repo.create({
        tenant_id: TENANT,
        s3_key: 'k',
        file_name: 'f.csv',
        phone_column: 'Mobile',
        dedupe_phones: false,
      });
      expect(paramsOf()[10]).toBe(false);
    });

    it('stores an empty ignore list rather than NULL', async () => {
      // The column is NOT NULL with a '{}' default; passing NULL would violate
      // it, and a NULL ignore list is indistinguishable from "not yet mapped".
      await repo.create({
        tenant_id: TENANT,
        s3_key: 'k',
        file_name: 'f.csv',
        phone_column: 'Mobile',
      });
      expect(paramsOf()[8]).toEqual([]);
    });

    it('allows a null campaign for a dry run', async () => {
      await repo.create({
        tenant_id: TENANT,
        s3_key: 'k',
        file_name: 'f.csv',
        phone_column: 'Mobile',
        dry_run: true,
      });
      expect(paramsOf()[2]).toBeNull();
    });
  });

  describe('tenant scoping', () => {
    it('findById is scoped by tenant — a job id is not a capability', async () => {
      // A job carries the operator's file contents in its counters and export.
      await repo.findById('job-1', TENANT);
      expect(sqlOf()).toContain('WHERE id = $1 AND tenant_id = $2');
      expect(paramsOf()).toEqual(['job-1', TENANT]);
    });

    it('requestCancel is scoped by tenant', async () => {
      await repo.requestCancel('job-1', TENANT);
      expect(sqlOf()).toContain('tenant_id = $2');
      expect(sqlOf()).not.toContain('account_id');
    });

    // ClickUp `14ygtkj8rvv`: an account-scoped caller must not reach a sibling
    // account's job. Equality, never `IS NULL OR =` — a tenant-wide job is out
    // of an account-scoped caller's reach too.
    it('findById adds an account EQUALITY predicate when given an account', async () => {
      await repo.findById('job-1', TENANT, 'account-b');
      expect(sqlOf()).toContain('WHERE id = $1 AND tenant_id = $2 AND account_id = $3');
      expect(sqlOf()).not.toContain('IS NULL');
      expect(paramsOf()).toEqual(['job-1', TENANT, 'account-b']);
    });

    it('findById with a null account is the tenant-wide lookup', async () => {
      await repo.findById('job-1', TENANT, null);
      expect(sqlOf()).not.toContain('account_id');
      expect(paramsOf()).toEqual(['job-1', TENANT]);
    });

    it('requestCancel puts the account predicate in the UPDATE itself', async () => {
      await repo.requestCancel('job-1', TENANT, 'account-b');
      const sql = sqlOf();
      expect(sql).toContain('UPDATE agency_ingest_jobs');
      expect(sql).toContain('account_id = $3');
      expect(sql).not.toContain('IS NULL');
      expect(sql).toContain("status IN ('pending', 'running')");
      expect(paramsOf()).toEqual(['job-1', TENANT, 'account-b']);
    });

    it('returns null rather than throwing for a missing job', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(repo.findById('nope', TENANT)).resolves.toBeNull();
    });
  });

  describe('requestCancel', () => {
    it('only targets live jobs, and reports whether it hit one', async () => {
      // The route answers 409 on a miss rather than pretending to cancel
      // something already finished — which would leave the operator believing a
      // roster was not imported when it was.
      mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
      await expect(repo.requestCancel('job-1', TENANT)).resolves.toBe(true);
      expect(sqlOf()).toContain("status IN ('pending', 'running')");

      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(repo.requestCancel('job-1', TENANT)).resolves.toBe(false);
    });

    it('sets a flag and does NOT change status — the loop stops itself', async () => {
      // Cancelling mid-chunk would leave an in-flight chunk's idempotency key
      // in a state neither side can reason about, so cancellation is
      // cooperative: the ingest loop checks the flag between chunks.
      await repo.requestCancel('job-1', TENANT);
      const sql = sqlOf();
      expect(sql).toContain('cancel_requested = TRUE');
      expect(sql).not.toContain("status = 'cancelled'");
    });

    it('treats a null rowCount as "nothing cancelled"', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: null });
      await expect(repo.requestCancel('job-1', TENANT)).resolves.toBe(false);
    });
  });

  describe('terminal transitions', () => {
    it('complete stamps finished_at and the full counter set', async () => {
      await repo.complete('job-1', {
        progress: {
          rows_read: 3, accepted: 1, rejected: 2, duplicates: 1, bytes_read: 40, chunks_sent: 1,
          core_rejected_duplicate_rows: 0,
          core_duplicate_source_rows: [],
          core_rejected_duplicate_rows_may_undercount: false,
        },
        rejected_by_reason: { invalid_phone: 1, duplicate_phone: 1 },
        headers: ['Mobile', 'Name'],
        context_columns: ['Name'],
        rejected_s3_key: 'k',
        rejected_row_count: 2,
        rejected_truncated: false,
      });

      const sql = sqlOf();
      expect(sql).toContain("status = 'completed'");
      expect(sql).toContain('finished_at = NOW()');
      // JSONB is serialised, not passed as an object.
      expect(paramsOf()[7]).toBe(JSON.stringify({ invalid_phone: 1, duplicate_phone: 1 }));
    });

    it('persists dialer-side duplicate-rejection counters independent of accepted/rejected', async () => {
      // The fix this pins: accepted/rejected are about what the ingest service decided to
      // send; these two columns are the independent signal for what the dialer
      // roster handler actually refused on arrival (a re-upload into a populated campaign).
      await repo.complete('job-1', {
        progress: {
          rows_read: 5000, accepted: 5000, rejected: 0, duplicates: 0, bytes_read: 40, chunks_sent: 10,
          core_rejected_duplicate_rows: 5000,
          core_duplicate_source_rows: [2, 3, 4],
          core_rejected_duplicate_rows_may_undercount: false,
        },
        rejected_by_reason: {},
        headers: ['Mobile'],
        context_columns: [],
        rejected_s3_key: null,
        rejected_row_count: 0,
        rejected_truncated: false,
      });

      const sql = sqlOf();
      expect(sql).toContain('core_rejected_duplicate_rows = $14');
      expect(sql).toContain('core_duplicate_source_rows = $15');
      const params = paramsOf();
      expect(params[13]).toBe(5000);
      expect(params[14]).toEqual([2, 3, 4]);
    });

    it('persists whether that count is exact or a lower bound (migration 056)', async () => {
      // Without this column the terminal job row cannot tell "the dialer refused
      // nothing" from "the dialer could not tell us what it refused" — the same zero
      // on the wire, one a clean import and the other a summary that must not be
      // trusted to prove one. The flag is set here from the progress object, so a
      // completed job carries it as durably as the count it qualifies.
      await repo.complete('job-1', {
        progress: {
          rows_read: 5000, accepted: 5000, rejected: 0, duplicates: 0, bytes_read: 40, chunks_sent: 10,
          core_rejected_duplicate_rows: 0,
          core_duplicate_source_rows: [],
          core_rejected_duplicate_rows_may_undercount: true,
        },
        rejected_by_reason: {},
        headers: ['Mobile'],
        context_columns: [],
        rejected_s3_key: null,
        rejected_row_count: 0,
        rejected_truncated: false,
      });

      expect(sqlOf()).toContain('core_rejected_duplicate_rows_may_undercount = $16');
      expect(paramsOf()[15]).toBe(true);
    });

    it('complete() also tolerates the pre-055 schema — reachable independently of updateProgress', async () => {
      // A dry run or a small file can reach complete() before the first
      // PROGRESS_INTERVAL_MS flush, so this is not updateProgress's fallback
      // exercised again by coincidence — it is the FIRST write against these
      // columns for such a job, and needs its own tolerance.
      const undefinedColumnError = new Error(
        'column "core_duplicate_source_rows" of relation "agency_ingest_jobs" does not exist',
      );
      (undefinedColumnError as Error & { code: string }).code = '42703';
      // TWO rejections, because the ladder now has a middle rung: tier 0 names all
      // three dialer-side columns, tier 1 names the two from 055, tier 2 names none. A
      // pre-055 database rejects the first two.
      mocks.query
        .mockRejectedValueOnce(undefinedColumnError)
        .mockRejectedValueOnce(undefinedColumnError)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.complete('job-1', {
        progress: {
          rows_read: 1, accepted: 1, rejected: 0, duplicates: 0, bytes_read: 1, chunks_sent: 1,
          core_rejected_duplicate_rows: 0,
          core_duplicate_source_rows: [],
          core_rejected_duplicate_rows_may_undercount: false,
        },
        rejected_by_reason: {},
        headers: ['Mobile'],
        context_columns: [],
        rejected_s3_key: null,
        rejected_row_count: 0,
        rejected_truncated: false,
      });

      expect(mocks.query).toHaveBeenCalledTimes(3);
      const fallbackSql = sqlOf(2);
      expect(fallbackSql).not.toContain('core_rejected_duplicate_rows');
      expect(fallbackSql).not.toContain('core_duplicate_source_rows');
      expect(fallbackSql).toContain("status = 'completed'");
      // 13 params: id + the 12 pre-existing columns, no $14/$15/$16.
      expect(paramsOf(2)).toHaveLength(13);
    });

    it('keeps the COUNT in the 055-applied / 056-missing window', async () => {
      /**
       * The middle rung, and the reason it exists. A single all-or-nothing
       * fallback dropped all three dialer-side columns whenever ANY of them was missing —
       * so in this window an import where the dialer refused 5,000 rows recorded
       * `core_rejected_duplicate_rows = 0` (the column default, never written) and
       * no flag: a confident wrong zero, which is precisely the failure migration
       * 056 was added to end.
       *
       * Only the trust bit is lost here, and the read path renders an absent bit
       * as `may_undercount: true` — so the summary says "we cannot vouch for this"
       * over a count that is nonetheless correct.
       */
      const err = new Error(
        'column "core_rejected_duplicate_rows_may_undercount" of relation "agency_ingest_jobs" does not exist',
      );
      (err as Error & { code: string }).code = '42703';
      mocks.query
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.complete('job-1', {
        progress: {
          rows_read: 5000, accepted: 5000, rejected: 0, duplicates: 0, bytes_read: 40, chunks_sent: 10,
          core_rejected_duplicate_rows: 5000,
          core_duplicate_source_rows: [2, 3],
          core_rejected_duplicate_rows_may_undercount: false,
        },
        rejected_by_reason: {},
        headers: ['Mobile'],
        context_columns: [],
        rejected_s3_key: null,
        rejected_row_count: 0,
        rejected_truncated: false,
      });

      expect(mocks.query).toHaveBeenCalledTimes(2);
      const middleSql = sqlOf(1);
      expect(middleSql).toContain('core_rejected_duplicate_rows = $14');
      expect(middleSql).toContain('core_duplicate_source_rows = $15');
      expect(middleSql).not.toContain('may_undercount');
      // The count survives — that is the whole point of the rung.
      expect(paramsOf(1)[13]).toBe(5000);
      expect(paramsOf(1)).toHaveLength(15);
    });

    it('fail truncates a runaway error message', async () => {
      // Error text can carry a parser message built from file content; the
      // column is unbounded but the response is rendered in a wizard.
      await repo.fail('job-1', 'unexpected_error', 'x'.repeat(5000));
      expect((paramsOf()[2] as string).length).toBe(2000);
    });

    it('markCancelled stamps finished_at so the job leaves the live index', async () => {
      await repo.markCancelled('job-1');
      const sql = sqlOf();
      expect(sql).toContain("status = 'cancelled'");
      expect(sql).toContain('finished_at = NOW()');
    });

    it('markCancelled records what the cancel did to the roster', async () => {
      // Cancellation is only observed after a replace's supersede, so a cancelled
      // replace sits on an EMPTY campaign. Without the note the operator sees
      // `cancelled` and nothing about the contacts that are already gone.
      await repo.markCancelled('job-1', 'Your previous 5,000 contacts were already retired.');
      expect(sqlOf()).toContain('error_message = COALESCE($2, error_message)');
      expect(paramsOf()[1]).toBe('Your previous 5,000 contacts were already retired.');
      // NOT a failure: a client keying on `error_code` to decide "this job failed"
      // must not start seeing one on a cancel.
      expect(sqlOf()).not.toContain('error_code');
    });

    it('markCancelled with no note leaves an existing message alone', async () => {
      // COALESCE, not a blank write: an append cancel must not erase a message a
      // previous write put there.
      await repo.markCancelled('job-1');
      expect(paramsOf()[1]).toBeNull();
      expect(sqlOf()).toContain('COALESCE($2, error_message)');
    });

    it('markCancelled truncates a runaway note, exactly as fail does', async () => {
      await repo.markCancelled('job-1', 'x'.repeat(5000));
      expect((paramsOf()[1] as string).length).toBe(2000);
    });
  });

  describe('markRunning', () => {
    it('does not reset started_at on a re-entry', async () => {
      // COALESCE keeps the original start, so elapsed time stays honest.
      await repo.markRunning('job-1', 12);
      expect(sqlOf()).toContain('started_at = COALESCE(started_at, NOW())');
    });
  });

  describe('updateProgress', () => {
    it('writes the dialer-side duplicate-rejection running total alongside the rest', async () => {
      await repo.updateProgress('job-1', {
        rows_read: 500, accepted: 500, rejected: 0, duplicates: 0, bytes_read: 40, chunks_sent: 1,
        core_rejected_duplicate_rows: 250,
        core_duplicate_source_rows: [2, 3],
        core_rejected_duplicate_rows_may_undercount: false,
      });
      const sql = sqlOf();
      expect(sql).toContain('core_rejected_duplicate_rows = $8');
      expect(sql).toContain('core_duplicate_source_rows = $9');
      expect(paramsOf()[7]).toBe(250);
      expect(paramsOf()[8]).toEqual([2, 3]);
    });

    it('flushes the lower-bound flag on the same heartbeat as the count', async () => {
      // A job that is cancelled or fails never reaches complete(), so a flag
      // written only there would be lost for exactly the runs most likely to be
      // short. Same argument as `core_duplicate_source_rows` above — the count
      // and its qualifier must go stale, or survive, together.
      await repo.updateProgress('job-1', {
        rows_read: 500, accepted: 500, rejected: 0, duplicates: 0, bytes_read: 40, chunks_sent: 1,
        core_rejected_duplicate_rows: 0,
        core_duplicate_source_rows: [],
        core_rejected_duplicate_rows_may_undercount: true,
      });
      expect(sqlOf()).toContain('core_rejected_duplicate_rows_may_undercount = $10');
      expect(paramsOf()[9]).toBe(true);
    });

    describe('pre-055 schema tolerance (migration-ordering hazard)', () => {
      // `npm run migrate:up` is manual — nothing runs it automatically — so a
      // code-first rollout can have this process live against a database
      // that hasn't seen migration 055 yet. Without a fallback, the FIRST
      // progress flush of ANY ingest throws `column
      // "core_rejected_duplicate_rows" ... does not exist` (Postgres 42703)
      // and fails the whole import with an opaque error.
      //
      // `mockReset` (not the outer `beforeEach`'s `clearAllMocks`) because
      // these tests queue multi-value `mockRejectedValueOnce`/
      // `mockResolvedValueOnce` chains keyed to an EXACT call count —
      // `clearAllMocks` does not drain an unconsumed queued value, so a
      // mismatched call count in one test would leak a stale queued
      // implementation into the next.
      beforeEach(() => {
        mocks.query.mockReset();
        mocks.query.mockResolvedValue({ rows: [{ id: 'job-1' }], rowCount: 1 });
      });

      const undefinedColumnError = () => {
        const err = new Error('column "core_rejected_duplicate_rows" of relation "agency_ingest_jobs" does not exist');
        (err as Error & { code: string }).code = '42703';
        return err;
      };

      it('falls all the way back on a pre-055 schema and still writes everything else', async () => {
        // Two rejections to walk past the middle rung — see the ladder in
        // `writeWideningDown`.
        mocks.query
          .mockRejectedValueOnce(undefinedColumnError())
          .mockRejectedValueOnce(undefinedColumnError())
          .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        await repo.updateProgress('job-1', {
          rows_read: 500, accepted: 500, rejected: 0, duplicates: 0, bytes_read: 40, chunks_sent: 1,
          core_rejected_duplicate_rows: 250,
          core_duplicate_source_rows: [2, 3],
          core_rejected_duplicate_rows_may_undercount: false,
        });

        expect(mocks.query).toHaveBeenCalledTimes(3);
        const fallbackSql = sqlOf(2);
        expect(fallbackSql).not.toContain('core_rejected_duplicate_rows');
        expect(fallbackSql).not.toContain('core_duplicate_source_rows');
        expect(fallbackSql).toContain('rows_read = $2');
        // 7 params: id + the 6 pre-existing columns, no 8th/9th/10th.
        expect(paramsOf(2)).toEqual(['job-1', 500, 500, 0, 0, 40, 1]);
      });

      it('keeps the count when only migration 056 is missing', async () => {
        // The rung that stops the window producing a confident wrong zero.
        mocks.query
          .mockRejectedValueOnce(undefinedColumnError())
          .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        await repo.updateProgress('job-1', {
          rows_read: 500, accepted: 500, rejected: 0, duplicates: 0, bytes_read: 40, chunks_sent: 1,
          core_rejected_duplicate_rows: 250,
          core_duplicate_source_rows: [2, 3],
          core_rejected_duplicate_rows_may_undercount: true,
        });

        expect(mocks.query).toHaveBeenCalledTimes(2);
        const middleSql = sqlOf(1);
        expect(middleSql).toContain('core_rejected_duplicate_rows = $8');
        expect(middleSql).not.toContain('may_undercount');
        expect(paramsOf(1)).toEqual(['job-1', 500, 500, 0, 0, 40, 1, 250, [2, 3]]);
      });

      it('does NOT swallow an unrelated database error the same way', async () => {
        const connectionError = new Error('Connection terminated unexpectedly');
        mocks.query.mockRejectedValueOnce(connectionError);

        await expect(
          repo.updateProgress('job-1', {
            rows_read: 1, accepted: 1, rejected: 0, duplicates: 0, bytes_read: 1, chunks_sent: 1,
            core_rejected_duplicate_rows: 0,
            core_duplicate_source_rows: [],
            core_rejected_duplicate_rows_may_undercount: false,
          }),
        ).rejects.toBe(connectionError);
        // No fallback attempt for an error that isn't the specific "column
        // missing" one — retrying blind on any failure would mask real bugs.
        expect(mocks.query).toHaveBeenCalledTimes(1);
      });

      it('does not retry at all once the migration has landed', async () => {
        mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
        await repo.updateProgress('job-1', {
          rows_read: 1, accepted: 1, rejected: 0, duplicates: 0, bytes_read: 1, chunks_sent: 1,
          core_rejected_duplicate_rows: 0,
          core_duplicate_source_rows: [],
          core_rejected_duplicate_rows_may_undercount: false,
        });
        expect(mocks.query).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('reapStaleJobs', () => {
    it('fails everything live-and-stale at boot, with actionable copy', async () => {
      // The ingest runs in-process per replica. A row that is genuinely
      // orphaned (its owning process died) stops heartbeating `updated_at` and
      // is safe to fail; the wizard would otherwise poll it forever.
      mocks.query.mockResolvedValue({ rows: [], rowCount: 3 });
      await expect(repo.reapStaleJobs()).resolves.toBe(3);

      const sql = sqlOf();
      expect(sql).toContain("status IN ('pending', 'running')");
      expect(sql).toContain("error_code = 'interrupted'");
      expect(sql).toContain('Upload the file again');
    });

    it('reports zero when there was nothing to reap', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(repo.reapStaleJobs()).resolves.toBe(0);
    });

    it('scopes the reap to a heartbeat staleness window, not a bare boot event', async () => {
      // This is the multi-replica fix: an unconditional
      // `WHERE status IN ('pending','running')` would fail another replica's
      // still-progressing job the instant any replica restarts (a rolling
      // deploy does this routinely). Gating on `updated_at` age is what lets a
      // live job — whose `updateProgress()` heartbeat is normally under a
      // second old — survive a sibling replica's boot.
      await repo.reapStaleJobs();
      const sql = sqlOf();
      expect(sql).toContain('updated_at <');
      expect(sql).toContain("INTERVAL '1 minute'");
      expect(paramsOf()).toEqual([AGENCY_INGEST_JOB_STALE_MINUTES]);
    });

    it('accepts an explicit staleness override', async () => {
      await repo.reapStaleJobs(30);
      expect(paramsOf()).toEqual([30]);
    });
  });
});
