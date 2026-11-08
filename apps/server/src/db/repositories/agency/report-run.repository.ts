/**
 * Report runs (docs/reports.md, RP1–RP16): `report_runs` (`0023_reports.sql`). Every write the
 * report pipeline makes to a run is one guarded statement here.
 *
 * ── Lifecycle and who moves it ───────────────────────────────────────────────
 *   queued ──claimNextQueued──► assembling ──markAssembled──► (assembling, dataset_key set)
 *     ──markSent──► rendering ──applyRenderResult──► ready | failed;  ready ──expireDue──► expired
 *   markFailed ends an assembling or rendering run with a ReportFailureCode.
 *
 * ── Fencing ──────────────────────────────────────────────────────────────────
 *  - **The assembler's claim** bumps `claim_generation`; {@link ReportRunRepository.markAssembled},
 *    {@link ReportRunRepository.markSent} and {@link ReportRunRepository.markFailed} called with
 *    `{ claimGeneration }` write only while the row is still `assembling` under that generation.
 *    An assembler that stalled past the stale cutoff, and whose run was claimed again, finds its
 *    writes refused (`false` / `null`) and must stop.
 *  - **The render attempt**: every send bumps `render_attempt`. A callback is applied only for the
 *    run's current attempt while it is `rendering` (RP13), so the late callback of a superseded
 *    send is `stale`. A re-send by the tick is fenced on the attempt it read
 *    (`{ renderAttempt }`), so two passes that read the same row send it once.
 *
 * ── Claims ───────────────────────────────────────────────────────────────────
 * `WITH picked AS MATERIALIZED (SELECT … FOR UPDATE SKIP LOCKED LIMIT n)` (packages/db CLAUDE.md):
 * concurrent claimers never take the same row and never more than `n`.
 *
 * ── The per-tenant pending limit ─────────────────────────────────────────────
 * {@link ReportRunRepository.create} counts the tenant's queued, assembling and rendering runs and
 * inserts in one transaction under a transaction-scoped advisory lock on the tenant
 * ({@link REPORT_RUN_PENDING_LOCK_SQL}), so concurrent requests cannot both pass a count of
 * `limit - 1`. A subscription's run ({@link ReportRunRepository.createForSubscription}) is not
 * refused by the limit (a scheduled period must not be dropped) but counts toward it.
 *
 * Every id is bound as a parameter and cast once; callers validate ids at the edge (`22P02`).
 */
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { AgencyKeysetPage } from '@magick-agency/contracts/agency';
import type {
  ReportAudience,
  ReportFailureCode,
  ReportFormat,
  ReportKind,
  ReportRendererFailureCode,
  ReportRunStatus,
} from '@magick-agency/contracts/api/agency/reports';
import type { ReportDetailFile } from '@magick-agency/contracts/reports';
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type { PoolClient } from 'pg';
import { keysetCondition, params, toKeysetPage } from './query-builders.js';

type Queryable = Pick<PoolClient, 'query'>;

/** One rendered file as stored on the run (`files`). */
export interface ReportRunFile {
  format: ReportFormat;
  key: string;
  bytes: number;
}

/** A `report_runs` row. Dates are `YYYY-MM-DD` strings; ids are lower-case UUID strings. */
export interface ReportRunRecord {
  id: string;
  tenant_id: string;
  account_id: string | null;
  kind: ReportKind;
  subject_id: string;
  /** Account runs only: the campaigns covered; null = every campaign of the account. */
  campaign_ids: string[] | null;
  /** The read window's instants, `[range_from, range_to)`. */
  range_from: Date;
  range_to: Date;
  /** The window as requested: local dates, both inclusive, in `timezone`. */
  local_from: string;
  local_to: string;
  timezone: string;
  formats: ReportFormat[];
  audience: ReportAudience;
  requested_by: string | null;
  email_me: boolean;
  subscription_id: string | null;
  period_start: string | null;
  status: ReportRunStatus;
  claim_generation: number;
  claimed_at: Date | null;
  render_attempt: number;
  sent_at: Date | null;
  dataset_key: string | null;
  detail_files: ReportDetailFile[];
  files: ReportRunFile[];
  truncated: boolean;
  renderer_version: string | null;
  error_code: ReportFailureCode | null;
  error_message: string | null;
  notified_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
}

/** What an ad hoc run is created with. The route has validated every field. */
export interface ReportRunCreateInput {
  tenantId: string;
  accountId: string | null;
  kind: ReportKind;
  subjectId: string;
  /** Account runs only; omit or null for every campaign. */
  campaignIds?: string[] | null;
  localFrom: string;
  localTo: string;
  timezone: string;
  /** `localDayBounds(localFrom, localTo, timezone)` (`agency/reports/schedule.ts`). */
  rangeFrom: Date;
  rangeTo: Date;
  formats: ReportFormat[];
  audience: ReportAudience;
  requestedBy: string | null;
  emailMe?: boolean;
}

/** A subscription's run: always the `supervisor` audience, no requester, no `email_me`. */
export interface ReportRunSubscriptionInput
  extends Omit<ReportRunCreateInput, 'audience' | 'requestedBy' | 'emailMe'> {
  subscriptionId: string;
  /** The period's first local day (`periodFor(...).from`); equals `localFrom`. */
  periodStart: string;
}

export type ReportRunCreateOutcome =
  | { ok: true; run: ReportRunRecord }
  /** The tenant already had `pending` runs queued, assembling or rendering (≥ the limit). */
  | { ok: false; reason: 'queue_full'; pending: number };

/** What a pipeline write is fenced on: the assembler's claim, or the render attempt it read. */
export type ReportRunFence = { claimGeneration: number } | { renderAttempt: number };

/** What the assembler records once the dataset and detail files are in S3. */
export interface ReportAssembledInput {
  datasetKey: string;
  detailFiles: ReportDetailFile[];
  truncated: boolean;
}

/** The renderer's callback, as the webhook has verified and checked it. */
export type ReportRenderResult =
  | {
    status: 'rendered';
    /** Every key already checked with `isReportOutputKey` (`agency/reports/report-keys.ts`). */
    files: ReportRunFile[];
    rendererVersion: string;
    /** `AGENCY_REPORTS_RETENTION_DAYS`: `expires_at = finished_at + retentionDays` (RP8). */
    retentionDays: number;
  }
  | {
    status: 'failed';
    error: { code: ReportRendererFailureCode; message: string };
    rendererVersion: string;
  };

export type ReportRenderApplyOutcome =
  | { result: 'applied'; run: ReportRunRecord }
  /** Not the run's current attempt, or the run is no longer rendering: acknowledge and ignore. */
  | { result: 'stale' };

/** Counts for the pending gauges (`agency_reports_pending_runs`, `_oldest_pending_seconds`). */
export interface ReportPendingStats {
  queued: number;
  assembling: number;
  rendering: number;
  /** `created_at` of the oldest pending run; null when none is pending. */
  oldestCreatedAt: Date | null;
}

export interface ReportRunListParams {
  tenantId: string;
  /** The context account; null lists the tenant's runs not scoped to an account. */
  accountId: string | null;
  kind?: ReportKind;
  subjectId?: string;
  subscriptionId?: string;
  /** A caller without `agency.supervise` sees only the runs they requested. */
  requestedBy?: string;
  after?: AgencyKeysetPosition;
  limit: number;
}

/** The pending statuses (`REPORT_PENDING_STATUSES`), as SQL. */
const PENDING_SQL = `('queued', 'assembling', 'rendering')`;

/** The row as {@link ReportRunRecord}, from alias `r`. */
export const REPORT_RUN_COLUMNS = `
  r.id::text AS id, r.tenant_id::text AS tenant_id, r.account_id::text AS account_id, r.kind,
  r.subject_id::text AS subject_id, r.campaign_ids::text[] AS campaign_ids, r.range_from, r.range_to,
  r.local_from::text AS local_from, r.local_to::text AS local_to, r.timezone, r.formats, r.audience,
  r.requested_by::text AS requested_by, r.email_me, r.subscription_id::text AS subscription_id,
  r.period_start::text AS period_start, r.status, r.claim_generation, r.claimed_at, r.render_attempt,
  r.sent_at, r.dataset_key, r.detail_files, r.files, r.truncated, r.renderer_version, r.error_code,
  r.error_message, r.notified_at, r.created_at, r.finished_at, r.expires_at`;

/** Serialises {@link ReportRunRepository.create} per tenant. `$1` tenant id. */
export const REPORT_RUN_PENDING_LOCK_SQL =
  `SELECT pg_advisory_xact_lock(hashtext('report_runs.pending'), hashtext($1::text))`;

/**
 * The assembler's claim: the oldest queued run, or an `assembling` run whose claim is older than
 * `$1` and whose dataset was never recorded (its assembler died). A run already assembled but not
 * sent is the tick's to re-send, not re-assemble ({@link ReportRunRepository.findAssembledUnsent}).
 */
export const REPORT_RUN_CLAIM_SQL = `
  WITH picked AS MATERIALIZED (
    SELECT id FROM report_runs
     WHERE status = 'queued'
        OR (status = 'assembling' AND dataset_key IS NULL AND claimed_at < $1::timestamptz)
     ORDER BY created_at, id
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE report_runs r
     SET status = 'assembling', claim_generation = r.claim_generation + 1, claimed_at = now()
    FROM picked
   WHERE r.id = picked.id
  RETURNING ${REPORT_RUN_COLUMNS}`;

const INSERT_COLUMNS = `tenant_id, account_id, kind, subject_id, campaign_ids, local_from, local_to, timezone,
  range_from, range_to, formats, audience, requested_by, email_me, subscription_id, period_start`;

function insertValues(
  input: Omit<ReportRunCreateInput, 'emailMe'> & { emailMe: boolean; subscriptionId: string | null; periodStart: string | null },
): unknown[] {
  return [
    input.tenantId, input.accountId, input.kind, input.subjectId, input.campaignIds ?? null,
    input.localFrom, input.localTo, input.timezone, input.rangeFrom, input.rangeTo, input.formats,
    input.audience, input.requestedBy, input.emailMe, input.subscriptionId, input.periodStart,
  ];
}

const INSERT_PLACEHOLDERS = `$1::uuid, $2::uuid, $3, $4::uuid, $5::uuid[], $6::date, $7::date, $8,
  $9::timestamptz, $10::timestamptz, $11::text[], $12, $13::uuid, $14, $15::uuid, $16::date`;

/** The fence as a WHERE fragment, binding its value through `bind`. */
function fenceSql(fence: ReportRunFence, bind: ReturnType<typeof params>): string {
  if ('claimGeneration' in fence) {
    return `r.status = 'assembling' AND r.claim_generation = ${bind.add(fence.claimGeneration)}::int`;
  }
  return `r.status IN ('assembling', 'rendering') AND r.render_attempt = ${bind.add(fence.renderAttempt)}::int`;
}

export class ReportRunRepository {
  /**
   * Queue an ad hoc run, unless the tenant already has `pendingLimit` runs pending
   * (`AGENCY_REPORTS_TENANT_PENDING_LIMIT`). The count and the insert are one transaction under
   * the tenant's advisory lock, so the limit holds under concurrent requests.
   */
  async create(input: ReportRunCreateInput, pendingLimit: number): Promise<ReportRunCreateOutcome> {
    return withTransaction(async (client) => {
      await client.query(REPORT_RUN_PENDING_LOCK_SQL, [input.tenantId]);
      const { rows: counted } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM report_runs WHERE tenant_id = $1::uuid AND status IN ${PENDING_SQL}`,
        [input.tenantId],
      );
      const pending = counted[0]?.n ?? 0;
      if (pending >= pendingLimit) return { ok: false as const, reason: 'queue_full' as const, pending };
      const { rows } = await client.query<ReportRunRecord>(
        `INSERT INTO report_runs AS r (${INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})
         RETURNING ${REPORT_RUN_COLUMNS}`,
        insertValues({ ...input, emailMe: input.emailMe ?? false, subscriptionId: null, periodStart: null }),
      );
      return { ok: true as const, run: rows[0]! };
    }, { pool: getPool() });
  }

  /**
   * A subscription's run for one period, or null when that (subscription, period) already has
   * one (`uq_report_runs_subscription_period`, ON CONFLICT DO NOTHING; the metric's `duplicate`).
   * `db` joins the subscription claim's transaction, so the run and the subscription's advance
   * commit together.
   */
  async createForSubscription(input: ReportRunSubscriptionInput, db: Queryable = getPool()): Promise<ReportRunRecord | null> {
    const { rows } = await db.query<ReportRunRecord>(
      `INSERT INTO report_runs AS r (${INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})
       ON CONFLICT (subscription_id, period_start) WHERE subscription_id IS NOT NULL DO NOTHING
       RETURNING ${REPORT_RUN_COLUMNS}`,
      insertValues({
        ...input, audience: 'supervisor', requestedBy: null, emailMe: false,
        subscriptionId: input.subscriptionId, periodStart: input.periodStart,
      }),
    );
    return rows[0] ?? null;
  }

  /** One run of the tenant, or null. The route checks the account and the caller's reach. */
  async findById(tenantId: string, id: string): Promise<ReportRunRecord | null> {
    const { rows } = await getPool().query<ReportRunRecord>(
      `SELECT ${REPORT_RUN_COLUMNS} FROM report_runs r WHERE r.id = $1::uuid AND r.tenant_id = $2::uuid`,
      [id, tenantId],
    );
    return rows[0] ?? null;
  }

  /**
   * One run by id alone, for the paths that hold no tenant: the signed render callback (to check
   * its file keys against the run's before applying) and the tick. Never for a console route.
   */
  async findByIdAnyTenant(id: string): Promise<ReportRunRecord | null> {
    const { rows } = await getPool().query<ReportRunRecord>(
      `SELECT ${REPORT_RUN_COLUMNS} FROM report_runs r WHERE r.id = $1::uuid`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * The history page: newest first, keyset on `(created_at DESC, id DESC)` over
   * `idx_report_runs_history` (or `idx_report_runs_requester` with `requestedBy`). `accountId`
   * null lists only runs with no account, never every account's.
   */
  async list(input: ReportRunListParams): Promise<AgencyKeysetPage<ReportRunRecord>> {
    const bind = params();
    const conditions = [
      `r.tenant_id = ${bind.add(input.tenantId)}::uuid`,
      input.accountId === null ? 'r.account_id IS NULL' : `r.account_id = ${bind.add(input.accountId)}::uuid`,
    ];
    if (input.kind) conditions.push(`r.kind = ${bind.add(input.kind)}::varchar`);
    if (input.subjectId) conditions.push(`r.subject_id = ${bind.add(input.subjectId)}::uuid`);
    if (input.subscriptionId) conditions.push(`r.subscription_id = ${bind.add(input.subscriptionId)}::uuid`);
    if (input.requestedBy) conditions.push(`r.requested_by = ${bind.add(input.requestedBy)}::uuid`);
    if (input.after) conditions.push(keysetCondition(input.after, 'r', bind));
    const { rows } = await getPool().query<ReportRunRecord & { cursor_at: string }>(
      `SELECT ${REPORT_RUN_COLUMNS}, ${keysetAtSql('r.created_at')} AS cursor_at
         FROM report_runs r
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${bind.add(input.limit + 1)}`,
      bind.values,
    );
    return toKeysetPage(rows, input.limit, ({ cursor_at: _cursor, ...run }) => run);
  }

  /** Ad hoc runs `userId` requested at or after `since` (`AGENCY_REPORTS_USER_PER_MINUTE`). */
  async countRequestedSince(tenantId: string, userId: string, since: Date): Promise<number> {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM report_runs
        WHERE requested_by = $1::uuid AND created_at >= $2::timestamptz AND tenant_id = $3::uuid`,
      [userId, since, tenantId],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * The assembler's claim ({@link REPORT_RUN_CLAIM_SQL}): the oldest queued run, or one stuck in
   * `assembling` with no dataset since before `staleBefore`, moved to `assembling` with
   * `claim_generation + 1` and `claimed_at = now()`. Null when there is nothing to claim. The
   * returned `claim_generation` is the fence for the assembler's later writes.
   */
  async claimNextQueued(staleBefore: Date): Promise<ReportRunRecord | null> {
    const { rows } = await getPool().query<ReportRunRecord>(REPORT_RUN_CLAIM_SQL, [staleBefore]);
    return rows[0] ?? null;
  }

  /** Record the dataset (still `assembling`), fenced on the claim. False: the claim was lost. */
  async markAssembled(id: string, claimGeneration: number, input: ReportAssembledInput): Promise<boolean> {
    const { rowCount } = await getPool().query(
      `UPDATE report_runs r
          SET dataset_key = $3, detail_files = $4::jsonb, truncated = $5
        WHERE r.id = $1::uuid AND r.status = 'assembling' AND r.claim_generation = $2::int`,
      [id, claimGeneration, input.datasetKey, JSON.stringify(input.detailFiles), input.truncated],
    );
    return rowCount === 1;
  }

  /**
   * About to send the run to the renderer: `render_attempt + 1`, `rendering`, `sent_at = now()`,
   * for a run whose dataset is recorded. Fenced: `{ claimGeneration }` from the assembler (still
   * its claim), `{ renderAttempt }` from the tick's re-send (the attempt it read). Resolves to the
   * new attempt, the one the render message carries; null when the fence did not hold (someone
   * else sent it, or the run moved on): send nothing.
   */
  async markSent(id: string, fence: ReportRunFence): Promise<number | null> {
    const bind = params();
    const idParam = bind.add(id);
    const { rows } = await getPool().query<{ render_attempt: number }>(
      `UPDATE report_runs r
          SET status = 'rendering', render_attempt = r.render_attempt + 1, sent_at = now()
        WHERE r.id = ${idParam}::uuid AND r.dataset_key IS NOT NULL AND ${fenceSql(fence, bind)}
        RETURNING r.render_attempt`,
      bind.values,
    );
    return rows[0]?.render_attempt ?? null;
  }

  /**
   * Apply the renderer's callback (RP13): only for the run's current `attempt` while it is
   * `rendering`. Rendered: `ready`, the files, `finished_at = now()`, `expires_at = finished_at +
   * retentionDays`. Failed: `failed` with the renderer's code and message. Either way the
   * renderer's version is recorded. Anything else is `stale`.
   */
  async applyRenderResult(id: string, attempt: number, result: ReportRenderResult): Promise<ReportRenderApplyOutcome> {
    const { rows } = result.status === 'rendered'
      ? await getPool().query<ReportRunRecord>(
        `UPDATE report_runs r
            SET status = 'ready', files = $3::jsonb, renderer_version = $4, finished_at = now(),
                expires_at = now() + make_interval(days => $5::int)
          WHERE r.id = $1::uuid AND r.render_attempt = $2::int AND r.status = 'rendering'
          RETURNING ${REPORT_RUN_COLUMNS}`,
        [id, attempt, JSON.stringify(result.files), result.rendererVersion, result.retentionDays],
      )
      : await getPool().query<ReportRunRecord>(
        `UPDATE report_runs r
            SET status = 'failed', error_code = $3, error_message = $4, renderer_version = $5, finished_at = now()
          WHERE r.id = $1::uuid AND r.render_attempt = $2::int AND r.status = 'rendering'
          RETURNING ${REPORT_RUN_COLUMNS}`,
        [id, attempt, result.error.code, result.error.message, result.rendererVersion],
      );
    return rows[0] ? { result: 'applied', run: rows[0] } : { result: 'stale' };
  }

  /**
   * End a run as `failed` with `code` (the assembler: `assembly_failed`, `subject_unavailable`,
   * under `{ claimGeneration }`; the tick: `render_timed_out`, under `{ renderAttempt }`). The
   * failed run, or null when the fence did not hold.
   */
  async markFailed(id: string, code: ReportFailureCode, message: string, fence: ReportRunFence): Promise<ReportRunRecord | null> {
    const bind = params();
    const idParam = bind.add(id);
    const codeParam = bind.add(code);
    const messageParam = bind.add(message);
    const { rows } = await getPool().query<ReportRunRecord>(
      `UPDATE report_runs r
          SET status = 'failed', error_code = ${codeParam}::varchar, error_message = ${messageParam}::text, finished_at = now()
        WHERE r.id = ${idParam}::uuid AND ${fenceSql(fence, bind)}
        RETURNING ${REPORT_RUN_COLUMNS}`,
      bind.values,
    );
    return rows[0] ?? null;
  }

  /**
   * Runs whose dataset was recorded but that were never sent (the assembler died between
   * `markAssembled` and `markSent`), claimed before `olderThan`. The tick re-sends them with
   * `markSent(id, { renderAttempt: run.render_attempt })`.
   */
  async findAssembledUnsent(olderThan: Date, limit = 50): Promise<ReportRunRecord[]> {
    const { rows } = await getPool().query<ReportRunRecord>(
      `SELECT ${REPORT_RUN_COLUMNS} FROM report_runs r
        WHERE r.status = 'assembling' AND r.dataset_key IS NOT NULL AND r.claimed_at < $1::timestamptz
        ORDER BY r.claimed_at, r.id
        LIMIT $2`,
      [olderThan, limit],
    );
    return rows;
  }

  /** Rendering runs sent before `cutoff` with no callback applied (RP13's reconcile), oldest send first. */
  async findRenderingSentBefore(cutoff: Date, limit: number): Promise<ReportRunRecord[]> {
    const { rows } = await getPool().query<ReportRunRecord>(
      `SELECT ${REPORT_RUN_COLUMNS} FROM report_runs r
        WHERE r.status = 'rendering' AND r.sent_at < $1::timestamptz
        ORDER BY r.sent_at, r.id
        LIMIT $2`,
      [cutoff, limit],
    );
    return rows;
  }

  /**
   * Finished (ready or failed) runs that email someone (`email_me`, or a subscription's run) and
   * whose email has not been handled, oldest first (`idx_report_runs_unnotified`).
   */
  async findFinishedUnnotified(limit: number): Promise<ReportRunRecord[]> {
    const { rows } = await getPool().query<ReportRunRecord>(
      `SELECT ${REPORT_RUN_COLUMNS} FROM report_runs r
        WHERE r.notified_at IS NULL AND r.status IN ('ready', 'failed')
          AND (r.email_me OR r.subscription_id IS NOT NULL)
        ORDER BY r.finished_at, r.id
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /** Mark the run's email handled. True for the one caller that marked it (mark, then send: at most once). */
  async markNotified(id: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      'UPDATE report_runs SET notified_at = now() WHERE id = $1::uuid AND notified_at IS NULL',
      [id],
    );
    return rowCount === 1;
  }

  /** Ready runs whose `expires_at` is at or before `now` turn `expired` (RP8). Returns how many. */
  async expireDue(now: Date): Promise<number> {
    const { rowCount } = await getPool().query(
      `UPDATE report_runs SET status = 'expired' WHERE status = 'ready' AND expires_at <= $1::timestamptz`,
      [now],
    );
    return rowCount ?? 0;
  }

  /** Runs pending by status and the oldest pending `created_at`, for the tick's gauges. */
  async pendingStats(): Promise<ReportPendingStats> {
    const { rows } = await getPool().query<{ status: 'queued' | 'assembling' | 'rendering'; n: number; oldest: Date }>(
      `SELECT status, count(*)::int AS n, min(created_at) AS oldest
         FROM report_runs WHERE status IN ${PENDING_SQL} GROUP BY status`,
    );
    const stats: ReportPendingStats = { queued: 0, assembling: 0, rendering: 0, oldestCreatedAt: null };
    for (const row of rows) {
      stats[row.status] = row.n;
      if (stats.oldestCreatedAt === null || row.oldest < stats.oldestCreatedAt) stats.oldestCreatedAt = row.oldest;
    }
    return stats;
  }
}

export const reportRunRepository = new ReportRunRepository();
