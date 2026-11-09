/**
 * Report subscriptions (docs/reports.md, RP4, RP14): `report_subscriptions` (`0023_reports.sql`), one
 * schedule each that produces one `report_runs` row per period.
 *
 * ── The due claim, and why a crash cannot double-send ────────────────────────
 * {@link ReportSubscriptionRepository.claimDue} is the reports tick's (main process) only path
 * from a schedule to a run. Each due subscription is taken in ITS OWN transaction:
 *   1. pick it with `WITH picked AS MATERIALIZED (… FOR UPDATE SKIP LOCKED LIMIT 1)`
 *      ({@link REPORT_SUBSCRIPTION_CLAIM_DUE_SQL}), so a second tick (or a slow one overlapping
 *      the next) skips it rather than waiting or taking it too;
 *   2. hand it, with the transaction's client, to the caller's handler, which creates the run
 *      (`ReportRunRepository.createForSubscription(input, client)`) and answers when the
 *      subscription next runs;
 *   3. write that `next_run_at` (and the zone the handler cut it in, when it changed), or disable
 *      it, and commit.
 * The run and the advance commit together or not at all: a crash before the commit leaves the
 * subscription due and no run; after it, both. The unique `(subscription_id, period_start)` index
 * is the backstop under all of it: a handler that runs twice for one period (a retry after an
 * error, a run-now racing the tick) gets `null` back from `createForSubscription` and creates
 * nothing. A handler that throws rolls its transaction back (no run, `next_run_at` unchanged);
 * that subscription is skipped for the rest of the call and reported, the others proceed.
 *
 * `next_run_at` is NULL exactly while disabled (`ck_report_subscriptions_enabled`); the schedule
 * math is `agency/reports/schedule.ts` (`nextRunAt`, `previousRunAt`, `periodFor`), never SQL.
 */
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type {
  ReportCadence,
  ReportFormat,
  ReportKind,
  ReportRunStatus,
} from '@magick-agency/contracts/api/agency/reports';
import type { PoolClient } from 'pg';
import { params } from './query-builders.js';

/** A `report_subscriptions` row with its newest run. */
export interface ReportSubscriptionRecord {
  id: string;
  tenant_id: string;
  account_id: string | null;
  kind: ReportKind;
  subject_id: string;
  cadence: ReportCadence;
  /** `HH:MM`. */
  send_local_time: string;
  send_weekday: number | null;
  send_monthday: number | null;
  timezone: string;
  formats: ReportFormat[];
  recipient_user_ids: string[];
  enabled: boolean;
  next_run_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  /** The run with the latest `period_start` it produced; null before the first. */
  last_run: { id: string; status: ReportRunStatus; period_start: string } | null;
}

export interface ReportSubscriptionCreateInput {
  tenantId: string;
  accountId: string | null;
  kind: ReportKind;
  subjectId: string;
  cadence: ReportCadence;
  /** `HH:MM`. */
  sendLocalTime: string;
  sendWeekday: number | null;
  sendMonthday: number | null;
  timezone: string;
  formats: ReportFormat[];
  recipientUserIds: string[];
  enabled: boolean;
  /** `nextRunAt(schedule, now)` when enabled; null when disabled. */
  nextRunAt: Date | null;
  createdBy: string;
}

/**
 * A PATCH: any subset. The route recomputes `nextRunAt` whenever the schedule or `enabled`
 * changes (null to disable) and sends the day fields the resulting cadence needs (null for the
 * other); the CHECKs refuse an inconsistent row (23514).
 */
export interface ReportSubscriptionPatch {
  cadence?: ReportCadence;
  sendLocalTime?: string;
  sendWeekday?: number | null;
  sendMonthday?: number | null;
  timezone?: string;
  formats?: ReportFormat[];
  recipientUserIds?: string[];
  enabled?: boolean;
  nextRunAt?: Date | null;
}

/** What the due handler decides for one subscription. */
export type ReportSubscriptionDueDecision =
  /**
   * The next send; must be after the claim's `now`. `timezone`, when given, is written with it: a
   * campaign subscription follows its campaign's CURRENT zone (RP3), re-read at each claim.
   */
  | { nextRunAt: Date; timezone?: string }
  /** Stop scheduling it (its subject or account is gone): `enabled = false`, `next_run_at = NULL`. */
  | { disable: true };

export type ReportSubscriptionDueOutcome =
  | { subscriptionId: string; outcome: 'advanced'; nextRunAt: Date }
  | { subscriptionId: string; outcome: 'disabled' }
  /** The handler threw: rolled back, left due, skipped for the rest of this call. */
  | { subscriptionId: string; outcome: 'error'; error: unknown };

/** The handler of one due subscription, inside its transaction. */
export type ReportSubscriptionDueHandler = (
  subscription: ReportSubscriptionRecord,
  client: PoolClient,
) => Promise<ReportSubscriptionDueDecision>;

const SUBSCRIPTION_COLUMNS = `
  s.id::text AS id, s.tenant_id::text AS tenant_id, s.account_id::text AS account_id, s.kind,
  s.subject_id::text AS subject_id, s.cadence, to_char(s.send_local_time, 'HH24:MI') AS send_local_time,
  s.send_weekday, s.send_monthday, s.timezone, s.formats, s.recipient_user_ids::text[] AS recipient_user_ids,
  s.enabled, s.next_run_at, s.created_by::text AS created_by, s.created_at, s.updated_at,
  CASE WHEN lr.id IS NULL THEN NULL
       ELSE json_build_object('id', lr.id::text, 'status', lr.status, 'period_start', lr.period_start::text) END AS last_run`;

/** The newest run of `s`: one backward step of `uq_report_runs_subscription_period`. */
const LAST_RUN_JOIN = `
  LEFT JOIN LATERAL (
    SELECT r.id, r.status, r.period_start FROM report_runs r
     WHERE r.subscription_id = s.id
     ORDER BY r.period_start DESC
     LIMIT 1
  ) lr ON true`;

/**
 * One due subscription, locked for the claim's transaction: enabled, `next_run_at <= $1`, not in
 * `$2` (the ones this call already failed on), earliest first.
 */
export const REPORT_SUBSCRIPTION_CLAIM_DUE_SQL = `
  WITH picked AS MATERIALIZED (
    SELECT id FROM report_subscriptions
     WHERE enabled AND next_run_at <= $1::timestamptz AND NOT (id = ANY($2::uuid[]))
     ORDER BY next_run_at, id
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  SELECT ${SUBSCRIPTION_COLUMNS}
    FROM report_subscriptions s
    JOIN picked ON picked.id = s.id
    ${LAST_RUN_JOIN}`;

/** The patch's fields and their columns (the only columns an update may write). */
const PATCH_COLUMNS: Record<keyof ReportSubscriptionPatch, { column: string; cast: string }> = {
  cadence: { column: 'cadence', cast: 'varchar' },
  sendLocalTime: { column: 'send_local_time', cast: 'time' },
  sendWeekday: { column: 'send_weekday', cast: 'smallint' },
  sendMonthday: { column: 'send_monthday', cast: 'smallint' },
  timezone: { column: 'timezone', cast: 'text' },
  formats: { column: 'formats', cast: 'text[]' },
  recipientUserIds: { column: 'recipient_user_ids', cast: 'uuid[]' },
  enabled: { column: 'enabled', cast: 'boolean' },
  nextRunAt: { column: 'next_run_at', cast: 'timestamptz' },
};

export class ReportSubscriptionRepository {
  async create(input: ReportSubscriptionCreateInput): Promise<ReportSubscriptionRecord> {
    const { rows } = await getPool().query<ReportSubscriptionRecord>(
      `WITH s AS (
         INSERT INTO report_subscriptions
           (tenant_id, account_id, kind, subject_id, cadence, send_local_time, send_weekday, send_monthday,
            timezone, formats, recipient_user_ids, enabled, next_run_at, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::time, $7::smallint, $8::smallint,
                 $9, $10::text[], $11::uuid[], $12, $13::timestamptz, $14::uuid)
         RETURNING *
       )
       SELECT ${SUBSCRIPTION_COLUMNS} FROM s ${LAST_RUN_JOIN}`,
      [
        input.tenantId, input.accountId, input.kind, input.subjectId, input.cadence, input.sendLocalTime,
        input.sendWeekday, input.sendMonthday, input.timezone, input.formats, input.recipientUserIds,
        input.enabled, input.nextRunAt, input.createdBy,
      ],
    );
    return rows[0]!;
  }

  /** Apply a PATCH (any subset; `updated_at = now()`). Null when the tenant has no such subscription. */
  async update(tenantId: string, id: string, patch: ReportSubscriptionPatch): Promise<ReportSubscriptionRecord | null> {
    const bind = params();
    const sets = ['updated_at = now()'];
    for (const [field, value] of Object.entries(patch) as Array<[keyof ReportSubscriptionPatch, unknown]>) {
      if (value === undefined) continue;
      const spec = PATCH_COLUMNS[field];
      if (!spec) throw new Error(`report subscription update: unknown field ${String(field)}`);
      sets.push(`${spec.column} = ${bind.add(value)}::${spec.cast}`);
    }
    const { rows } = await getPool().query<ReportSubscriptionRecord>(
      `WITH s AS (
         UPDATE report_subscriptions SET ${sets.join(', ')}
          WHERE id = ${bind.add(id)}::uuid AND tenant_id = ${bind.add(tenantId)}::uuid
          RETURNING *
       )
       SELECT ${SUBSCRIPTION_COLUMNS} FROM s ${LAST_RUN_JOIN}`,
      bind.values,
    );
    return rows[0] ?? null;
  }

  /** Remove it; the runs it produced are kept (and still name it). False when there was none. */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      'DELETE FROM report_subscriptions WHERE id = $1::uuid AND tenant_id = $2::uuid',
      [id, tenantId],
    );
    return rowCount === 1;
  }

  async findById(tenantId: string, id: string): Promise<ReportSubscriptionRecord | null> {
    const { rows } = await getPool().query<ReportSubscriptionRecord>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM report_subscriptions s ${LAST_RUN_JOIN}
        WHERE s.id = $1::uuid AND s.tenant_id = $2::uuid`,
      [id, tenantId],
    );
    return rows[0] ?? null;
  }

  /** The account's subscriptions, newest first; `accountId` null lists the tenant's unscoped ones only. */
  async list(tenantId: string, accountId: string | null): Promise<ReportSubscriptionRecord[]> {
    const { rows } = await getPool().query<ReportSubscriptionRecord>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM report_subscriptions s ${LAST_RUN_JOIN}
        WHERE s.tenant_id = $1::uuid AND ${accountId === null ? 's.account_id IS NULL' : 's.account_id = $2::uuid'}
        ORDER BY s.created_at DESC, s.id DESC`,
      accountId === null ? [tenantId] : [tenantId, accountId],
    );
    return rows;
  }

  /**
   * Take up to `limit` subscriptions due at `now`, each in its own transaction (module header):
   * lock it, run `handler` (which creates the period's run on the client it is given), write the
   * decision, commit. Returns what happened to each, in claim order; fewer than `limit` when
   * fewer were due.
   */
  async claimDue(now: Date, limit: number, handler: ReportSubscriptionDueHandler): Promise<ReportSubscriptionDueOutcome[]> {
    const outcomes: ReportSubscriptionDueOutcome[] = [];
    const failed: string[] = [];
    while (outcomes.length < limit) {
      const claimed: { id: string | null } = { id: null };
      try {
        const outcome = await withTransaction(async (client) => {
          const { rows } = await client.query<ReportSubscriptionRecord>(REPORT_SUBSCRIPTION_CLAIM_DUE_SQL, [now, failed]);
          const sub = rows[0];
          if (!sub) return null;
          claimed.id = sub.id;
          const decision = await handler(sub, client);
          if ('disable' in decision) {
            await client.query(
              `UPDATE report_subscriptions SET enabled = false, next_run_at = NULL, updated_at = now() WHERE id = $1::uuid`,
              [sub.id],
            );
            return { subscriptionId: sub.id, outcome: 'disabled' as const };
          }
          if (!(decision.nextRunAt instanceof Date) || !(decision.nextRunAt.getTime() > now.getTime())) {
            // Writing a next run at or before `now` would hand the same subscription straight back.
            throw new Error(`report subscription ${sub.id}: next run ${String(decision.nextRunAt)} is not after the claim`);
          }
          await client.query(
            `UPDATE report_subscriptions SET next_run_at = $2::timestamptz, timezone = COALESCE($3::text, timezone), updated_at = now()
              WHERE id = $1::uuid`,
            [sub.id, decision.nextRunAt, decision.timezone ?? null],
          );
          return { subscriptionId: sub.id, outcome: 'advanced' as const, nextRunAt: decision.nextRunAt };
        }, { pool: getPool() });
        if (outcome === null) break;
        outcomes.push(outcome);
      } catch (error) {
        // Nothing was claimed: the claim itself failed (the database), so stop rather than spin.
        if (claimed.id === null) throw error;
        failed.push(claimed.id);
        outcomes.push({ subscriptionId: claimed.id, outcome: 'error', error });
      }
    }
    return outcomes;
  }

  /** Stop scheduling a subscription (`enabled = false`, `next_run_at = NULL`). False when already disabled or gone. */
  async disable(id: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      `UPDATE report_subscriptions SET enabled = false, next_run_at = NULL, updated_at = now()
        WHERE id = $1::uuid AND enabled`,
      [id],
    );
    return rowCount === 1;
  }
}

export const reportSubscriptionRepository = new ReportSubscriptionRepository();
