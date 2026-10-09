import { getPool } from '@magick-agency/db';
import type { AgencyIngestFailureCode } from './agency-csv-ingest.js';

/**
 * Postgres `42703 undefined_column` — the SQLSTATE for "this column doesn't
 * exist," which is exactly what a write against `core_rejected_duplicate_rows`
 * / `core_duplicate_source_rows` throws against a schema that lacks them.
 * Narrow on purpose: any other error (a real constraint violation, a
 * connection drop) must still propagate rather than being silently
 * downgraded to "maybe it's just the migration."
 */
function isUndefinedColumnError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42703';
}

/** Lifecycle of a roster ingest. `pending` → `running` → terminal. */
export type AgencyIngestJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Everything that can land in `agency_ingest_jobs.error_code`.
 *
 * A superset of {@link AgencyIngestFailureCode}: the file-level codes the wizard
 * renders copy for, **plus** the ones only the ingest SERVICE can raise, because
 * they are about applying the roster or the job's own preconditions rather than
 * about the file. The console types the field `AgencyIngestFailureCode | string |
 * null`, so these fall through to its generic branch by design.
 *
 * ── Why this type exists at all ─────────────────────────────────────────────
 * `fail()` took a bare `string`, so the union it was supposed to mirror had
 * quietly fallen four codes behind what the service writes — `dnc_unavailable`,
 * `roster_incomplete`, `core_rejected_chunk` and `unexpected_error` were all
 * being written by a service whose own type said they could not be. A hand-kept
 * list checked by nothing is not a contract; typing the write is what makes the
 * list have to be true.
 *
 * `replace_${...}` is a template literal type on purpose, and it is the cheapest
 * pin here: the call site builds the code as `` `replace_${err.code}` `` from
 * `RosterSupersedeError.code`, so the day that union grows a fifth supersede
 * refusal, that expression stops being assignable and this list has to be
 * extended in the same commit. Spelling the four out by hand would have been the same drift one
 * level down.
 *
 * NOTE `AgencyIngestJobRecord.error_code` stays `string | null`: it is READ back
 * out of a column that already holds rows written by earlier deployments, and
 * narrowing a read to a vocabulary history does not obey would be a lie in the
 * one direction nobody checks.
 */
export type AgencyIngestJobFailureCode =
  | AgencyIngestFailureCode
  /** A real (non-dry-run) import arrived without a campaign to import into. */
  | 'no_campaign'
  /** The final chunk's completeness check found some earlier chunk never applied. */
  | 'roster_incomplete'
  /** One chunk was refused outright (`RosterChunkError`). */
  | 'core_rejected_chunk'
  /** The catch-all arm, deliberately distinguishable in logs and dashboards. */
  | 'unexpected_error'
  /** The replace could not start — `RosterSupersedeError.code`, prefixed. */
  | 'replace_unsupported'
  | 'replace_campaign_not_found'
  | 'replace_refused'
  | 'replace_failed';

/**
 * What this import means to do to the campaign's existing roster.
 *
 * - `append` — today's behaviour. New rows are merged in; rows the roster
 *   already holds exactly are refused by `uq_agency_contacts_row_fingerprint`
 *   and reported back as `core_rejected_duplicate_rows`.
 * - `replace` — the campaign's existing contacts are RETIRED first
 *   (`supersedeRoster`), so afterwards only this import's rows are dialable. Not
 *   implemented: it fails `replace_unsupported` (decision B15).
 *
 * There is deliberately no third value and no `merge`/`upsert`: a contact cannot
 * be updated in place — an edited person hashes differently and is a new row —
 * so "correct my file" is expressible only as replace.
 */
export type AgencyIngestMode = 'append' | 'replace';

/** Mirrors `ck_agency_ingest_mode`, so an invalid mode fails before the database. */
export const AGENCY_INGEST_MODES: readonly AgencyIngestMode[] = ['append', 'replace'];

export interface AgencyIngestJobRecord {
  id: string;
  tenant_id: string;
  account_id: string | null;
  campaign_id: string | null;
  s3_key: string;
  file_name: string;
  file_size_bytes: string | null;
  phone_column: string;
  timezone_column: string | null;
  ignore_columns: string[];
  default_country_code: string | null;
  dedupe_phones: boolean;
  dry_run: boolean;
  /**
   * `undefined` — not merely `'append'` — on a row read back from a schema
   * without the `mode` column, because `create()` does not name the column for an
   * append (see its docstring). Every reader must therefore treat anything that
   * is not exactly `'replace'` as an append, which is also the fail-safe reading.
   */
  mode: AgencyIngestMode;
  /**
   * For `mode: 'replace'`: how many contacts were retired for this job, as a
   * BIGINT string. NULL when the question does not apply — an append, or a
   * replace that failed before it got that far.
   *
   * **Non-null on a FAILED job is the state that matters.** It is the difference
   * between "your import did not happen" and "your import did not happen and
   * your roster is already gone", and only the second one needs the operator to
   * do something.
   */
  replace_superseded_contacts: string | null;
  /**
   * TRUE when a replace may have retired the roster but the ingest could not
   * confirm it. Read together with the count above:
   *
   *   (N, false)    exactly N contacts were retired
   *   (NULL, false) nothing was retired; the campaign is as it was
   *   (NULL, true)  the roster MAY be gone and the count is unknown
   */
  replace_superseded_uncertain: boolean;
  status: AgencyIngestJobStatus;
  cancel_requested: boolean;
  rows_read: string;
  accepted: string;
  rejected: string;
  duplicates: string;
  rejected_by_reason: Record<string, number>;
  bytes_read: string;
  chunks_sent: number;
  chunks_total: number | null;
  headers: string[] | null;
  context_columns: string[] | null;
  rejected_s3_key: string | null;
  rejected_row_count: number;
  rejected_truncated: boolean;
  /**
   * Rows the ingest sent that `ON CONFLICT (campaign_id, row_fingerprint)`
   * refused because the roster already held them **exactly** — the same people
   * sent again, summed across every chunk. Independent of `accepted`/`rejected`:
   * those count what the ingest decided to send, this counts what the contact
   * table actually refused on arrival.
   */
  core_rejected_duplicate_rows: string;
  /** A capped sample of the colliding `source_row_number`s, across all chunks. */
  core_duplicate_source_rows: number[];
  /**
   * TRUE when the count above is a LOWER BOUND rather than an exact figure —
   * see the column's comment and `IngestProgress`'s field of the same name.
   */
  core_rejected_duplicate_rows_may_undercount: boolean;
  error_code: string | null;
  error_message: string | null;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

export interface CreateIngestJobInput {
  tenant_id: string;
  account_id?: string | null;
  campaign_id?: string | null;
  s3_key: string;
  file_name: string;
  file_size_bytes?: number;
  phone_column: string;
  timezone_column?: string | null;
  ignore_columns?: string[];
  default_country_code?: string | null;
  dedupe_phones?: boolean;
  dry_run?: boolean;
  /** Omitted means `append` — the column's own default, and the safe one. */
  mode?: AgencyIngestMode;
  created_by?: string | null;
}

/**
 * How stale (no progress heartbeat) a `pending`/`running` job's `updated_at`
 * must be before boot-time reap treats it as orphaned rather than live on
 * another replica.
 */
export const AGENCY_INGEST_JOB_STALE_MINUTES = 10;

/** Counters written on each progress tick. */
export interface IngestProgress {
  rows_read: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  bytes_read: number;
  chunks_sent: number;
  /**
   * Running total of `RosterChunkResponse.rejected_duplicate_rows` across
   * every chunk sent so far.
   *
   * **Exact unless `core_rejected_duplicate_rows_may_undercount` says
   * otherwise**, and when it does say otherwise this is a LOWER BOUND — it can
   * undercount, never overcount.
   *
   * The hazard, since it is not visible from here: a replay of a chunk
   * (`duplicate_chunk: true`) rolls back before the per-row conflict check and so
   * has no counts of its own. `applyIngestChunk` records the counts inside the
   * transaction that refused the rows and reads them back on replay — so the
   * number below is exact for every chunk whose counts were recorded, INCLUDING
   * an exact zero. The one residual case is a replay of a chunk whose counts were
   * never recorded (`agency_ingest_chunks.rejected_duplicate_rows IS NULL`),
   * where nothing can be reconstructed; the repository reports
   * `rejection_counts_unavailable` there rather than a confident zero, and that
   * is the ONLY thing that raises the flag field below.
   *
   * A non-zero value is always real — the repository never invents a collision.
   */
  core_rejected_duplicate_rows: number;
  /**
   * Capped sample of the colliding `source_row_number`s (see
   * `agency-ingest.service.ts`'s `MAX_CORE_DUPLICATE_SAMPLE`).
   *
   * **Skewed toward the earliest chunks, not a random cross-section.** Each
   * chunk's own `duplicate_source_rows` is capped at 20
   * (`MAX_REPORTED_DUPLICATE_ROWS` in `src/db/repositories/agency.repository.ts`), and this
   * sample stops accepting new rows once it reaches the same cap — so on a
   * heavily-colliding re-upload (the common case this field exists for),
   * chunk 0 alone typically fills the cap and every later chunk's collisions
   * are invisible in the sample even though the running TOTAL above still
   * counts them correctly. The sample answers "show me some examples," not
   * "show me a representative spread" — fine for an operator recognising the
   * pattern, not for auditing which rows specifically collided.
   */
  core_duplicate_source_rows: number[];
  /**
   * **Sticky**: true once any chunk of this ingest came back with
   * `rejection_counts_unavailable`, and never cleared by a later chunk that
   * reported cleanly. It qualifies the WHOLE-JOB total above, so one unknown
   * chunk makes the total a lower bound no matter how many exact chunks
   * surround it — a flag that flickered off on the next good chunk would
   * describe the last chunk rather than the import.
   *
   * **One flag, not two.** The only way a replay fails to report its true
   * count is the never-recorded case, and that case is exactly what the
   * repository flags. Two overlapping "this might be short" signals would leave
   * an operator arithmetic to do that nothing here can do for them.
   *
   * `false` is the fail-safe and is never inferred — only a live response
   * saying so raises it.
   */
  core_rejected_duplicate_rows_may_undercount: boolean;
}

export class AgencyIngestJobRepository {
  /**
   * `mode` is named in the INSERT **only for a replace**, and that asymmetry is
   * a tolerance for a schema without the `mode` column rather than an oversight.
   *
   * Nothing in this repo runs `migrate:up` on deploy, so a code-first rollout can
   * have this process live against a database whose schema has not caught up —
   * the same ordering hazard `updateProgress` documents at length. The usual try/catch-and-retry-without-the-column shape
   * is WRONG here and dangerously so: retrying a replace without its mode would
   * insert a job that then behaves as an append, which is a silent
   * reinterpretation of a destructive instruction.
   *
   * Splitting on the value instead gives the right outcome on both sides: an
   * append never names the column (so it inserts fine either way, and the column
   * defaults to `'append'` where it exists), while a replace names it and fails
   * loudly against a schema that cannot record it. A replace that cannot be
   * recorded must not run.
   */
  async create(input: CreateIngestJobInput): Promise<AgencyIngestJobRecord> {
    const pool = getPool();
    const values: unknown[] = [
      input.tenant_id,
      input.account_id ?? null,
      input.campaign_id ?? null,
      input.s3_key,
      input.file_name,
      input.file_size_bytes ?? null,
      input.phone_column,
      input.timezone_column ?? null,
      input.ignore_columns ?? [],
      input.default_country_code ?? null,
      input.dedupe_phones ?? true,
      input.dry_run ?? false,
      input.created_by ?? null,
    ];
    const replacing = input.mode === 'replace';
    if (replacing) values.push(input.mode);

    const result = await pool.query<AgencyIngestJobRecord>(
      `INSERT INTO agency_ingest_jobs
         (tenant_id, account_id, campaign_id, s3_key, file_name, file_size_bytes,
          phone_column, timezone_column, ignore_columns, default_country_code,
          dedupe_phones, dry_run, created_by${replacing ? ', mode' : ''})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${replacing ? ',$14' : ''})
       RETURNING *`,
      values,
    );
    return result.rows[0]!;
  }

  /**
   * Record how many contacts a replace retired.
   *
   * Written the moment the supersede answers and **before the first chunk is sent**, so
   * that a process killed mid-import still leaves the number behind. A count
   * recorded at completion would be missing from exactly the runs where it is
   * the only thing the operator needs to know.
   */
  async recordReplaceSuperseded(id: string, superseded: number): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE agency_ingest_jobs SET replace_superseded_contacts = $2 WHERE id = $1`,
      [id, superseded],
    );
  }

  /**
   * Record that a replace may have retired the roster without the ingest learning
   * how many.
   *
   * Deliberately a separate method from {@link recordReplaceSuperseded} rather
   * than an extra parameter: the two are written on mutually exclusive paths and
   * mean opposite things, and one method with a "…or maybe" flag is how a caller
   * ends up passing `0, true` and reporting "0 contacts were already retired".
   * `replace_superseded_contacts` is deliberately left NULL here — writing 0
   * beside the flag would be a count, and there is no count.
   */
  async recordReplaceUncertain(id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE agency_ingest_jobs SET replace_superseded_uncertain = TRUE WHERE id = $1`,
      [id],
    );
  }

  /**
   * Tenant-scoped by construction: an ingest job id is not a capability, and
   * a job carries the operator's file contents in its counters and export.
   *
   * `accountId` is the ACCOUNT axis: pass the caller's
   * own `membership.account_id` when that membership is account-scoped, and the
   * statement adds `AND account_id = $3`. Without it, an account-scoped viewer
   * of account B who knew a job id from sibling account A could poll A's job,
   * download its rejected-row CSV (roster PII) and — via {@link requestCancel}
   * — stop A's import. **Equality, not `IS NULL OR =`**: a job created by a
   * tenant-wide caller (`account_id IS NULL`) is correctly unreachable to an
   * account-scoped one, the same call `dncRepository.deleteById` makes. `null`
   * / omitted means a tenant-wide caller, unrestricted within the tenant.
   */
  async findById(
    id: string,
    tenantId: string,
    accountId?: string | null,
  ): Promise<AgencyIngestJobRecord | null> {
    const pool = getPool();
    const result = accountId
      ? await pool.query<AgencyIngestJobRecord>(
        `SELECT * FROM agency_ingest_jobs WHERE id = $1 AND tenant_id = $2 AND account_id = $3`,
        [id, tenantId, accountId],
      )
      : await pool.query<AgencyIngestJobRecord>(
        `SELECT * FROM agency_ingest_jobs WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
    return result.rows[0] ?? null;
  }

  /**
   * `fileSizeBytes` is what makes the wizard's progress bar determinate.
   *
   * It comes from S3's `ContentLength` at the moment the ingest opens the object,
   * never from the client: the upload response reports a size, but echoing that
   * back through `startIngest` would let a caller describe a file it did not
   * upload. Nothing populated the column before, so `bytesTotal` was always null
   * and the bar the API advertises stayed indeterminate until it jumped to 100%.
   *
   * `COALESCE` so a retry cannot blank a size already recorded.
   */
  async markRunning(id: string, chunksTotal: number | null, fileSizeBytes?: number): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE agency_ingest_jobs
          SET status = 'running', started_at = COALESCE(started_at, NOW()), chunks_total = $2,
              file_size_bytes = COALESCE($3, file_size_bytes)
        WHERE id = $1`,
      [id, chunksTotal, fileSizeBytes ?? null],
    );
  }

  /**
   * Run the widest statement the live schema will accept.
   *
   * ── Why a LADDER and not one fallback ──────────────────────────────────────
   * The baseline creates every column named here, so on a migrated database the
   * first tier always succeeds. The narrower tiers are for a database missing
   * the duplicate-count columns (`core_rejected_duplicate_rows`,
   * `core_duplicate_source_rows`), or only the trust bit
   * (`core_rejected_duplicate_rows_may_undercount`) — nothing in this repo runs
   * `migrate:up` on deploy, so code can be live against a schema that has not
   * caught up. A single all-or-nothing fallback would collapse those into "write
   * none of the count columns", which is the exact failure the trust bit exists
   * to prevent: with the counts present and the bit missing, an import where 5,000
   * rows were refused would record `core_rejected_duplicate_rows = 0` (the column
   * default, never written) and no flag — a confident wrong zero.
   *
   * Tiers are ordered widest-first and each drops exactly the columns the previous
   * tier could have been rejected for, so every window records as much as its
   * schema can hold. Without the trust bit the count is kept; only the bit is
   * lost, and the read path reports an absent bit as `may_undercount: true`
   * precisely because it could not be written.
   *
   * Self-healing by construction: no tier result is cached, so the very next call
   * after a migration lands writes the full row again with no restart.
   */
  private async writeWideningDown(
    tiers: ReadonlyArray<{ sql: string; values: unknown[] }>,
  ): Promise<void> {
    const pool = getPool();
    for (let i = 0; i < tiers.length; i += 1) {
      const tier = tiers[i]!;
      try {
        await pool.query(tier.sql, tier.values);
        return;
      } catch (err) {
        // The last tier names only the table's original columns, so a 42703
        // there is a real schema problem and must surface.
        if (!isUndefinedColumnError(err) || i === tiers.length - 1) throw err;
      }
    }
  }

  /**
   * Tolerates running against a schema without the duplicate-count columns —
   * the ordering hazard being guarded against.
   *
   * Nothing in this repo runs `migrate:up` on deploy, so a code-first rollout
   * can have this process live against a database that lacks them. Without this
   * guard, the FIRST progress flush of any ingest (`PROGRESS_INTERVAL_MS` =
   * 1s after `run()` starts streaming) throws `column
   * "core_rejected_duplicate_rows" of relation "agency_ingest_jobs" does not
   * exist` (Postgres `42703`), which propagates out of the `onBatch`
   * callback and fails EVERY ingest with `unexpected_error` — a total outage
   * of the feature, not a degraded corner of it, and the operator sees a
   * failed import with a raw Postgres error string as the only explanation.
   *
   * The fix does not cache "the column is missing" for the process lifetime
   * — that would leave a **permanently** degraded write path once the
   * migration lands underneath a still-running process (docs nobody reads at
   * 2am do not fix themselves; a self-healing write path does). Instead every
   * call attempts the full write first and only falls back — for that one
   * call — on a live `42703`, so the very next successful migration makes the
   * very next write whole again with no restart required. The cost is one
   * extra round trip per call during the ordering window, which is bounded by
   * how long that window actually is (a deploy, not indefinitely).
   *
   * `core_duplicate_source_rows` is flushed HERE too, on every tick — not
   * only at `complete()` — because a cancelled or failed run never reaches
   * `complete()` at all. Without this, `core_rejected_duplicate_rows` (the
   * running total) still survived on the last progress flush before a
   * cancel/fail, but the sample of WHICH rows collided did not — an operator
   * would see "250 collided" with an empty examples list. Both fields now
   * ride the same heartbeat, so they go stale (or survive) together, and
   * `core_rejected_duplicate_rows_may_undercount` rides it for
   * the same reason: a cancelled job whose total is a lower bound must still
   * say so.
   *
   * The ladder below has three tiers rather than one per column: with the
   * count columns present and the trust bit missing, the middle tier keeps the
   * count and loses only the bit; with the count columns missing too, the last
   * tier writes only the original counters, so the total stops advancing until
   * the schema catches up. That self-heals on the next call exactly as above,
   * and a finer ladder would multiply this method's SQL to shorten a window that
   * a single `migrate:up` closes.
   */
  async updateProgress(id: string, progress: IngestProgress): Promise<void> {
    const base = [
      id,
      progress.rows_read,
      progress.accepted,
      progress.rejected,
      progress.duplicates,
      progress.bytes_read,
      progress.chunks_sent,
    ];
    const BASE_SET = `rows_read = $2, accepted = $3, rejected = $4,
                duplicates = $5, bytes_read = $6, chunks_sent = $7`;

    await this.writeWideningDown([
      {
        sql: `UPDATE agency_ingest_jobs
            SET ${BASE_SET},
                core_rejected_duplicate_rows = $8, core_duplicate_source_rows = $9,
                core_rejected_duplicate_rows_may_undercount = $10
          WHERE id = $1`,
        values: [
          ...base,
          progress.core_rejected_duplicate_rows,
          progress.core_duplicate_source_rows,
          progress.core_rejected_duplicate_rows_may_undercount,
        ],
      },
      // Count columns present, trust bit missing: keep the COUNT, lose only the
      // bit. The read path turns that absence into `may_undercount: true`, so the
      // summary is honest rather than confidently wrong.
      {
        sql: `UPDATE agency_ingest_jobs
            SET ${BASE_SET},
                core_rejected_duplicate_rows = $8, core_duplicate_source_rows = $9
          WHERE id = $1`,
        values: [
          ...base,
          progress.core_rejected_duplicate_rows,
          progress.core_duplicate_source_rows,
        ],
      },
      // No count columns: only the table's original counters.
      { sql: `UPDATE agency_ingest_jobs SET ${BASE_SET} WHERE id = $1`, values: base },
    ]);
  }

  async complete(
    id: string,
    result: {
      progress: IngestProgress;
      rejected_by_reason: Record<string, number>;
      headers: string[];
      context_columns: string[];
      rejected_s3_key: string | null;
      rejected_row_count: number;
      rejected_truncated: boolean;
    },
  ): Promise<void> {
    // Same schema tolerance as `updateProgress` above, through the same
    // ladder — see `writeWideningDown`. A dry run or a small file can reach
    // `complete()` before the first `PROGRESS_INTERVAL_MS` progress flush, so this
    // is not `updateProgress`'s fallback repeated defensively; it is independently
    // reachable as the FIRST write against these columns for such a job.
    const base = [
      id,
      result.progress.rows_read,
      result.progress.accepted,
      result.progress.rejected,
      result.progress.duplicates,
      result.progress.bytes_read,
      result.progress.chunks_sent,
      JSON.stringify(result.rejected_by_reason),
      result.headers,
      result.context_columns,
      result.rejected_s3_key,
      result.rejected_row_count,
      result.rejected_truncated,
    ];
    const BASE_SET = `status = 'completed', finished_at = NOW(),
                rows_read = $2, accepted = $3, rejected = $4, duplicates = $5,
                bytes_read = $6, chunks_sent = $7, rejected_by_reason = $8,
                headers = $9, context_columns = $10,
                rejected_s3_key = $11, rejected_row_count = $12, rejected_truncated = $13`;

    await this.writeWideningDown([
      {
        sql: `UPDATE agency_ingest_jobs
            SET ${BASE_SET},
                core_rejected_duplicate_rows = $14, core_duplicate_source_rows = $15,
                core_rejected_duplicate_rows_may_undercount = $16
          WHERE id = $1`,
        values: [
          ...base,
          result.progress.core_rejected_duplicate_rows,
          result.progress.core_duplicate_source_rows,
          result.progress.core_rejected_duplicate_rows_may_undercount,
        ],
      },
      {
        sql: `UPDATE agency_ingest_jobs
            SET ${BASE_SET},
                core_rejected_duplicate_rows = $14, core_duplicate_source_rows = $15
          WHERE id = $1`,
        values: [
          ...base,
          result.progress.core_rejected_duplicate_rows,
          result.progress.core_duplicate_source_rows,
        ],
      },
      { sql: `UPDATE agency_ingest_jobs SET ${BASE_SET} WHERE id = $1`, values: base },
    ]);
  }

  async fail(
    id: string,
    errorCode: AgencyIngestJobFailureCode,
    errorMessage: string,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE agency_ingest_jobs
          SET status = 'failed', finished_at = NOW(), error_code = $2, error_message = $3
        WHERE id = $1`,
      [id, errorCode, errorMessage.slice(0, 2000)],
    );
  }

  /**
   * `note` carries what a cancel did to the campaign's EXISTING roster.
   *
   * Cancellation is only observed between chunks, i.e. after a replace has
   * already superseded the old roster — so a cancelled replace leaves an empty
   * campaign, and with no note the operator sees `cancelled` and nothing else.
   * The structured facts are already on the row (`replace_superseded_contacts` /
   * `replace_superseded_uncertain`, written at supersede time); this is the
   * sentence that goes with them, and it is the same sentence `fail` writes.
   *
   * It reuses `error_message` rather than adding a column: that field is already
   * echoed on the job payload for every status, so a note lands where the wizard
   * is already looking. `error_code` is deliberately left NULL — a cancel is not
   * a failure, and a client keying on `error_code` to decide "this job failed"
   * must not start seeing one.
   *
   * `COALESCE` on the note so a cancel cannot blank a message a previous write
   * put there, and the same 2,000-char bound `fail` applies.
   */
  async markCancelled(id: string, note?: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE agency_ingest_jobs
          SET status = 'cancelled', finished_at = NOW(),
              error_message = COALESCE($2, error_message)
        WHERE id = $1`,
      [id, note ? note.slice(0, 2000) : null],
    );
  }

  /**
   * Request cancellation. A flag, not a kill: a chunk already in flight must be
   * allowed to finish, or its idempotency key is left in a state neither side
   * can reason about. The ingest loop checks this between chunks.
   *
   * Returns false when the job is already terminal, so the route can answer 409
   * rather than pretending it cancelled something that had finished. It also
   * returns false for a job outside the caller's scope — the route tells those
   * apart with {@link findById} under the same scope, so a sibling account's
   * job answers 404 rather than 409.
   *
   * `accountId` scopes the write exactly as it scopes {@link findById}: the
   * predicate is in the SAME statement as the UPDATE, so no read-then-write
   * window lets an account-scoped caller cancel a sibling account's import.
   */
  async requestCancel(id: string, tenantId: string, accountId?: string | null): Promise<boolean> {
    const pool = getPool();
    const result = accountId
      ? await pool.query(
        `UPDATE agency_ingest_jobs
            SET cancel_requested = TRUE
          WHERE id = $1 AND tenant_id = $2 AND account_id = $3 AND status IN ('pending', 'running')`,
        [id, tenantId, accountId],
      )
      : await pool.query(
        `UPDATE agency_ingest_jobs
            SET cancel_requested = TRUE
          WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'running')`,
        [id, tenantId],
      );
    return (result.rowCount ?? 0) > 0;
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query<{ cancel_requested: boolean }>(
      `SELECT cancel_requested FROM agency_ingest_jobs WHERE id = $1`,
      [id],
    );
    return result.rows[0]?.cancel_requested ?? false;
  }

  /**
   * Fail every job left `running` (or `pending`) by a restart — but ONLY the
   * ones that are actually orphaned, not merely running somewhere else.
   *
   * ── Why not every non-terminal row ─────────────────────────────────────────
   * Failing every non-terminal row unconditionally rests on the premise that
   * "the ingest runs in-process, so a job in `running` at boot has no worker and
   * will never progress." That holds for a lone process but not once more than
   * one replica is live, which a rolling deploy always produces. A roster upload
   * lands on whichever replica the balancer picks, and that replica's in-process
   * ingest keeps running for however long the file takes — minutes, for a
   * 1M-row CSV. A rolling deploy boots replica B while replica A is still
   * mid-ingest for a different job; an unconditional reap on B's startup would
   * mark A's live job `failed` out from under it, mid-file, with rows already
   * applied that the operator's UI then reports as an error.
   *
   * ── The fix: scope by heartbeat staleness, not by boot event ───────────────
   * `updated_at` is already a heartbeat with no new column needed: every
   * `updateProgress()` call during an active ingest is an UPDATE, and the
   * `agency_ingest_jobs_updated_at` trigger bumps `updated_at` on every one of
   * them (`PROGRESS_INTERVAL_MS` = 1s in `agency-ingest.service.ts`, so a live
   * job's heartbeat is normally under a second old). A job that is *actually*
   * orphaned — its owning process crashed or was killed — stops heartbeating
   * the instant that happens, so its `updated_at` ages past any reasonable
   * threshold long before a human would investigate. Gating the reap on
   * `updated_at < NOW() - staleMinutes` therefore reaps true orphans on any
   * replica's boot while leaving another replica's live job alone — the
   * "no worker will ever advance this" test, applied per-row instead of
   * per-table. A 10-minute stale-heartbeat threshold rather than a new
   * owner/instance column — the schema already carries what's needed.
   */
  async reapStaleJobs(staleMinutes = AGENCY_INGEST_JOB_STALE_MINUTES): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE agency_ingest_jobs
          SET status = 'failed', finished_at = NOW(),
              error_code = 'interrupted',
              error_message = 'The import was interrupted by a service restart. Upload the file again.'
        WHERE status IN ('pending', 'running')
          AND updated_at < NOW() - ($1 * INTERVAL '1 minute')`,
      [staleMinutes],
    );
    return result.rowCount ?? 0;
  }
}

export const agencyIngestJobRepository = new AgencyIngestJobRepository();
