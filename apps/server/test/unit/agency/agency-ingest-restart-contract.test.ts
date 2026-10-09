import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import {
  AgencyIngestJobRepository,
  AGENCY_INGEST_JOB_STALE_MINUTES,
} from '../../../src/agency/agency-ingest-job.repository.js';
import {
  ingestAgencyCsv,
  type AgencyIngestContact,
  type AgencyIngestRejection,
} from '../../../src/agency/agency-csv-ingest.js';

/**
 * The ingest service's half of the restart contract,
 * asserted on the ingest side.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * `test/integration/agency/agency-ingest-idempotency.test.ts` proves the roster
 * chunk handler does not duplicate a re-uploaded roster. But its restart arm is
 * built on three facts about the INGEST SERVICE, and every one of them lives in
 * that file's own prose header rather than in an assertion anywhere:
 *
 *   1. the ingest never reuses a job id across a restart;
 *   2. `POST /ingest/jobs` always creates a fresh row;
 *   3. the ingest derives `source_row_number` from the FILE LINE (`startLine`).
 *
 * That test synthesises all three itself — `randomUUID()` supplies the "new job
 * id", and its own helper supplies row numbers identical across both runs. So if
 * the ingest resumed a job id, re-chunked at a different size, or numbered rows by
 * accepted-count instead of file line, **that test stays green and the roster
 * duplicates in production.** That is a test writing both sides of a contract.
 *
 * This file asserts the ingest service's three obligations against its real
 * code, so that comment stops being the only place they live.
 *
 * ── A correction to that header, found while writing this ─────────────────────
 * It states that "`reapStaleJobs()` fails every live job at boot".
 * **It does not, and it must not.** The statement is gated on a heartbeat
 * staleness window (`updated_at < NOW() - AGENCY_INGEST_JOB_STALE_MINUTES`), and
 * that gate is load-bearing: the ingest runs in-process per replica, so an
 * unconditional reap would fail another replica's still-progressing job every
 * time any replica restarts — which a rolling deploy does routinely.
 *
 * That correction does NOT weaken the conclusion, and the distinction is worth
 * being precise about because it relocates the guarantee. The fresh job id does
 * not come from the reap at all — it comes from `create()` being an
 * unconditional INSERT whose id is assigned by the DATABASE ("a fresh job row"
 * below). The reap only stops the wizard polling an orphan forever. So a
 * re-upload gets a new id whether or not the old job was reaped, which is a
 * stronger position than that header claims — and it is the reason arm (c) is
 * asserted here as two independent properties rather than one chained one.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo convention: each test file defines its own helpers. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Normalise whitespace so assertions survive reformatting of the SQL. */
function sqlOf(callIndex = 0): string {
  return (mocks.query.mock.calls[callIndex]![0] as string).replace(/\s+/g, ' ').trim();
}
function paramsOf(callIndex = 0): unknown[] {
  return mocks.query.mock.calls[callIndex]![1] as unknown[];
}

const repo = new AgencyIngestJobRepository();
const TENANT = 'tenant-1';

/** The same file, uploaded twice. Byte-identical by construction. */
const CREATE_INPUT = {
  tenant_id: TENANT,
  campaign_id: 'camp-1',
  s3_key: 'uploads/renewals.csv',
  file_name: 'renewals.csv',
  phone_column: 'Mobile',
} as const;

describe('the ingest service’s restart contract ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Obligation 1 + 2: a re-upload always gets a FRESH job id ──────────────

  describe('a fresh job row, and therefore a fresh job id', () => {
    it('mints a new job id on every create — the id comes from the DATABASE, never from the input', async () => {
      // This is the property the idempotency test's restart arm actually depends on,
      // and the one its `randomUUID()` fabricates. If `create` were ever made to resume — an
      // upsert keyed on `(campaign_id, s3_key)` is the obvious "optimisation",
      // and it would look like deduplicating redundant uploads — then run 2 would
      // reuse run 1's id, the ingest's chunk keys would collide with the ones the dialer
      // already holds, and its chunk-key layer would refuse the WHOLE chunk
      // rather than letting the row-level index adjudicate row by row. The
      // roster would silently short by every chunk run 1 had committed.
      let issued = 0;
      mocks.query.mockImplementation(async () => ({
        rows: [{ id: `job-${(issued += 1)}` }],
        rowCount: 1,
      }));

      const first = await repo.create({ ...CREATE_INPUT });
      const second = await repo.create({ ...CREATE_INPUT });

      // Two distinct rows from two byte-identical uploads.
      expect(first.id).toBe('job-1');
      expect(second.id).toBe('job-2');
      expect(first.id).not.toBe(second.id);
      expect(mocks.query).toHaveBeenCalledTimes(2);

      for (const call of [0, 1]) {
        const sql = sqlOf(call);
        // An INSERT, and only an INSERT.
        expect(sql).toContain('INSERT INTO agency_ingest_jobs');
        expect(sql).toContain('RETURNING *');
        // The three shapes that would turn this into a resume. Asserted
        // explicitly rather than inferred from "it contains INSERT", because an
        // upsert contains INSERT too.
        expect(sql).not.toContain('ON CONFLICT');
        expect(sql).not.toContain('UPDATE');
        expect(sql).not.toContain('SELECT');
        // And the caller never supplies an id, so it cannot pin one. A bound id
        // is the mechanism by which a resume would happen at all.
        expect(paramsOf(call)).not.toContain(first.id);
        expect(paramsOf(call).some((p) => typeof p === 'string' && p.startsWith('job-'))).toBe(false);
      }
    });

    it('never reads an existing job before creating one, so there is no row it could resume', async () => {
      // The composed statement: `create` issues exactly ONE statement, and it is
      // the INSERT. A resume needs a lookup first; the absence of one is the
      // structural guarantee, and it is cheaper to keep true than a comment is.
      mocks.query.mockResolvedValue({ rows: [{ id: 'job-1' }], rowCount: 1 });

      await repo.create({ ...CREATE_INPUT });

      expect(mocks.query).toHaveBeenCalledTimes(1);
      expect(sqlOf()).toMatch(/^INSERT INTO agency_ingest_jobs/);
    });

    it('exposes no method that returns a terminal job to a runnable state', () => {
      // Over comment-stripped source, because the words "resume" and "running"
      // appear all over this file's prose and a naive search for them is
      // satisfied by a comment. Measured on this project: a comment naming a
      // field kept a test green after the field's spread was deleted.
      const raw = readFileSync(
        resolve(__dirname, '../../../src/agency/agency-ingest-job.repository.ts'), 'utf8',
      );
      const source = stripComments(raw);

      // The comment-stripping is itself load-bearing here, and this asserts it
      // rather than trusting it: the RAW file DOES contain the words "ON
      // CONFLICT" — in prose, describing the index on the dialer's side — so the
      // check below run over `raw` would be satisfied by that comment and would
      // pass against an upsert. (An earlier draft of this test used a proximity
      // regex instead and silently failed to catch the mutation; measured.)
      expect(raw).toContain('ON CONFLICT');

      // Every write in this repository targets `agency_ingest_jobs`, so a single
      // blanket check is exact: no upsert anywhere, and nothing sets a job back
      // to a runnable status.
      expect(source).not.toContain('ON CONFLICT');
      expect(source).not.toMatch(/status\s*=\s*'pending'/);

      // `markRunning` exists and does write `status = 'running'` — it is how a
      // freshly created job starts. What matters is that it is reached only with
      // an id `create` just returned; it is NOT a resume entry point, because
      // there is no way to obtain a terminal job's id and re-enter the pipeline
      // (see the two tests above). Pinned so that if a `resumeJob(id)` ever
      // lands, this assertion is where the restart contract is re-examined.
      const methods = [...source.matchAll(/^ {2}(?:private )?async ([a-zA-Z]+)\(/gm)].map((m) => m[1]);
      expect(methods).toContain('create');
      expect(methods).toContain('reapStaleJobs');
      expect(methods).not.toContain('resume');
      expect(methods).not.toContain('resumeJob');
      expect(methods).not.toContain('restart');
    });
  });

  // ── The reap: terminal, actionable, and WINDOWED ───────────────────────────

  describe('reapStaleJobs — what it really guarantees', () => {
    it('drives a stale job to a TERMINAL status, so nothing can poll or resume it', async () => {
      // The idempotency test's header leans on the reap "failing" the old job. The load-bearing
      // part is that `failed` is terminal and `finished_at` is stamped — an
      // interrupted job left `running` would keep the wizard polling forever and
      // would leave an operator believing an import is still progressing.
      mocks.query.mockResolvedValue({ rows: [], rowCount: 2 });

      await expect(repo.reapStaleJobs()).resolves.toBe(2);

      const sql = sqlOf();
      expect(sql).toContain("status = 'failed'");
      expect(sql).toContain('finished_at = NOW()');
      expect(sql).toContain("error_code = 'interrupted'");
      // The operator is told what to DO, not just that it broke.
      expect(sql).toContain('Upload the file again');
    });

    it('is gated on a heartbeat window — it does NOT fail every live job at boot', async () => {
      // Explicitly contradicting the sentence in the idempotency test's header, so
      // the two cannot keep disagreeing silently.
      //
      // The gate is what makes the ingest safe under a rolling deploy: the
      // work runs in-process per replica, so an unconditional
      // `WHERE status IN ('pending','running')` would fail a SIBLING replica's
      // still-progressing import the instant this one boots. A live job
      // heartbeats `updated_at` through `updateProgress`, normally sub-second, so
      // the window is what lets it survive.
      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await repo.reapStaleJobs();

      const sql = sqlOf();
      expect(sql).toContain("status IN ('pending', 'running')");
      // Both halves ANDed. An assertion on the status list alone would pass
      // against the unconditional statement this window exists to prevent.
      expect(sql).toMatch(/status IN \('pending', 'running'\)\s*AND\s*updated_at </);
      expect(sql).toContain("INTERVAL '1 minute'");
      expect(paramsOf()).toEqual([AGENCY_INGEST_JOB_STALE_MINUTES]);
      // A real, non-zero window. `0` would make the statement unconditional
      // again while still matching every substring above.
      expect(AGENCY_INGEST_JOB_STALE_MINUTES).toBeGreaterThan(0);
    });
  });

  // ── Obligation 3: source_row_number is the FILE LINE, stably ───────────────

  describe('source_row_number is the file line, and is stable across runs', () => {
    /**
     * A file whose accepted rows land on lines 2, 4 and 6.
     *
     * Every element is load-bearing:
     *   - line 3 is REJECTED, so accepted-count numbering (1,2,3) diverges from
     *     file-line numbering (2,4,6);
     *   - the record starting on line 4 spans TWO lines via a quoted embedded
     *     newline, so counting emitted records instead of `info.lines` drifts by
     *     one line for that row and every row after it.
     *
     * Without both, a wrong implementation still produces the right numbers.
     */
    const LINES = [
      'Mobile,Name',                 // line 1 — header
      '+919000000001,Alice',         // line 2 — accepted
      'not-a-phone,Bob',             // line 3 — REJECTED
      '+919000000003,"Carol',        // line 4 — accepted, record starts here
      'Multiline"',                  // line 5 —   … and ends here
      '+919000000005,Dave',          // line 6 — accepted
    ];
    const CSV = `${LINES.join('\n')}\n`;

    /** File lines the accepted records START on, read off the fixture above. */
    const EXPECTED_FILE_LINES = [2, 4, 6];

    async function runIngest(batchSize: number) {
      const accepted: AgencyIngestContact[] = [];
      const rejections: AgencyIngestRejection[] = [];
      const batches: number[][] = [];
      const summary = await ingestAgencyCsv({
        source: Readable.from([CSV]),
        phoneColumn: 'Mobile',
        batchSize,
        onBatch: (contacts) => {
          accepted.push(...contacts);
          batches.push(contacts.map((c) => c.source_row_number));
        },
        onRejected: (r) => { rejections.push(r); },
      });
      return { accepted, rejections, batches, summary };
    }

    it('numbers accepted rows by FILE LINE, not by accepted count', async () => {
      const { accepted, rejections } = await runIngest(500);

      expect(accepted.map((c) => c.phone_e164)).toEqual([
        '+919000000001', '+919000000003', '+919000000005',
      ]);
      expect(accepted.map((c) => c.source_row_number)).toEqual(EXPECTED_FILE_LINES);

      // The discriminator. Accepted-count numbering would be [1,2,3] and would
      // satisfy every "the numbers are stable" assertion below just as well —
      // while making a re-upload's rows collide with DIFFERENT rows of the
      // original, which is the failure the dialer side cannot see.
      expect(accepted.map((c) => c.source_row_number)).not.toEqual([1, 2, 3]);

      // The rejected row is reported against its own file line, so the operator's
      // error list and the dialer's collision report share one coordinate system.
      expect(rejections.map((r) => r.row_number)).toEqual([3]);
    });

    it('produces IDENTICAL row numbers on a second run of the same file — the restart case', async () => {
      // Run 1 is killed after the dialer commits; run 2 streams the same file from the
      // beginning. The dialer's row-level index can only recognise run 2's rows as
      // replays if run 2 numbers them the same way — and only if the
      // CONTENT is identical too, which is asserted alongside.
      const runOne = await runIngest(500);
      const runTwo = await runIngest(500);

      expect(runTwo.accepted.map((c) => c.source_row_number))
        .toEqual(runOne.accepted.map((c) => c.source_row_number));
      // Content parity, not just number parity: the dialer keys
      // row identity on md5(phone + context + timezone), so a re-upload that
      // renumbered identically but reshaped `context` would still duplicate.
      expect(runTwo.accepted).toEqual(runOne.accepted);
      expect(runTwo.accepted.map((c) => c.source_row_number)).toEqual(EXPECTED_FILE_LINES);
    });

    it('re-chunking at a different batch size does not change any row number', async () => {
      // The third of the three prose claims. The ingest picks `batchSize`, and a
      // restart under different config (or a future adaptive size) must not
      // renumber anything — the row number is a property of the FILE, never of
      // the chunk it happened to travel in.
      const big = await runIngest(500);
      const small = await runIngest(1);

      // Genuinely different chunking …
      expect(big.batches).toEqual([EXPECTED_FILE_LINES]);
      expect(small.batches).toEqual([[2], [4], [6]]);
      // … and identical numbering.
      expect(small.accepted.map((c) => c.source_row_number))
        .toEqual(big.accepted.map((c) => c.source_row_number));
      expect(small.accepted).toEqual(big.accepted);
    });

    it('declares source_row_number as REQUIRED on the wire type', () => {
      // The roster route types the field `source_row_number?: number` and its
      // repository writes `?? null`, so a payload without it is accepted and
      // stored with the CSV line NULL. Nothing duplicates
      // (the dialer keys on the content fingerprint, asserted in
      // `test/integration/agency/agency-ingest-route-seam.test.ts`),
      // but the ingest's collision REPORT loses the ability to name which rows
      // collided.
      //
      // So the ingest's required field is what keeps that report meaningful, and it
      // is a TypeScript property on one side of an HTTP boundary that
      // `npm run lint` never checks in test files. Pinned as text over
      // comment-stripped source: the optional marker is one character, and the
      // interface's own prose says "1-based line in the source file", which
      // satisfies any search for the concept.
      const source = stripComments(
        readFileSync(resolve(__dirname, '../../../src/agency/agency-csv-ingest.ts'), 'utf8'),
      );

      const iface = /export interface AgencyIngestContact \{[\s\S]*?\n\}/.exec(source);
      expect(iface, 'could not find AgencyIngestContact').toBeTruthy();
      expect(iface![0]).toMatch(/\n\s*source_row_number:\s*number;/);
      expect(iface![0]).not.toMatch(/source_row_number\?/);

      // And the value assigned to it is the file line, at the one site that
      // builds an outgoing contact.
      expect(source).toMatch(/source_row_number:\s*startLine/);
      expect(source).toMatch(/const startLine\s*=\s*previousEndLine \+ 1/);
    });
  });
});
