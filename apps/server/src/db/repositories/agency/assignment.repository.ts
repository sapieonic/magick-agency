/**
 * Contact assignment writes: the supervisor's operations (preview and commit), the unstaff
 * return (CA6), the per-contact history, and the staffing probe the operations check.
 *
 * ── One plan, two uses ──────────────────────────────────────────────────────
 * Every operation is planned by ONE SQL builder ({@link planCtes}): a CTE chain ending in
 * `plan(id, from_user_id, to_user_id)`, one row per selected contact that is not on a call.
 * The preview aggregates it ({@link FINGERPRINT_SQL}); the commit runs the very same chain
 * inside its transaction and writes it, gated on the aggregate equalling the preview token
 * (`operation.ts` describes the token). The preview and the commit cannot disagree because
 * there is no second definition to disagree with.
 *
 * ── Shape of a plan ─────────────────────────────────────────────────────────
 *  - `sel`: the operation's candidate rows on the campaign, each with `live` (`in_flight` /
 *    `connected`: never moved, counted `skipped_live`) and `gkey`, its group: the number's
 *    digits (`CONTACT_PHONE_DIGITS_SQL`) with `group_same_number`, else its own id. Groups
 *    are formed among the SELECTED contacts only; a same-number contact outside the
 *    selection keeps its owner.
 *  - `nl` / `cum`: per non-live row, its group's size, order key and start position (window
 *    functions; see {@link planCtes}). A group with a live member: the live member stays
 *    where it is, the rest move together.
 *  - `plan`: each row's target agent (or NULL, the pool). A split walks the groups in a
 *    seeded hash order (`hashtextextended(seed:gkey)`) and cuts the running total into K equal ranges by
 *    each unit's start position, so agents differ by at most one group (one contact without
 *    grouping). `count`/`reassign`/`unassign` with a count take units in roster order
 *    (`created_at`, `csv_line_number`, `id`) while the unit STARTS before the count, so a
 *    group at the boundary is taken whole (at most one group over).
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 * The commit first locks the rows its plan moves (`FOR NO KEY UPDATE` in a MATERIALIZED CTE,
 * in id order: the UPDATE's own lock mode, so an attempt insert's FK check on a contact is
 * not blocked), then re-plans and writes in one statement whose UPDATE re-checks each row (not
 * live, still with the planned owner). The pacing claim uses `SKIP LOCKED`, so it passes
 * over the rows being moved rather than waiting on them. A row that entered the plan
 * unlocked (a contact that changed meanwhile) changes the fingerprint, the gate refuses,
 * nothing is written, and the caller answers `409 preview_stale` with the fresh preview. A
 * large operation (100+ moves) is let through when its move and to-pool counts are within 2%
 * of the preview's (`commitDrift`): on a running campaign claims and settlements move rows
 * every second. It then writes the plan as it stands; the UPDATE re-checks each row under its
 * own lock, and a shortfall against the plan still rolls everything back.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type {
  AgencyAssignmentAgentDelta,
  AgencyAssignmentEvent,
  AgencyAssignmentPreview,
  AgencyAssignmentReason,
  AgencyAssignmentResult,
} from '@magick-agency/contracts/api/agency/assignment';
import { publishPacingInvalidation } from '../../../agency/pacing/invalidation-bus.js';
import {
  agentOrder,
  commitDrift,
  decodePreviewToken,
  encodePreviewToken,
  rebalanceQuotas,
  seedOf,
  type CanonicalAssignment,
  type PlanFingerprint,
  type RebalanceLoad,
  type RebalanceQuotas,
} from '../../../agency/assignment/operation.js';
import { contactBucketSql, LIVE_STATES_SQL, openContactSql, returnToPoolSql } from './assignment-sql.js';
import { params } from './query-builders.js';
import { iso } from './projections.js';
import { contactPhoneDigitsSql } from './sql-fragments.js';

type Bind = ReturnType<typeof params>;
type Queryable = Pick<PoolClient, 'query'>;

/** The campaign facts a plan reads. */
export interface AssignmentCampaignScope {
  campaignId: string;
  tenantId: string;
  /** `callbackCodes(campaign.disposition_catalog)`: rebalance leaves callbacks alone. */
  callbackCodes: string[];
}

/** The roster order: upload order, ties by line, then id. */
const ROSTER_ORDER_SQL = 'c.created_at, c.csv_line_number NULLS LAST, c.id';

interface PlanSpec {
  selection: string[];
  /** Order units: by seeded hash, by roster position, or none (a single target, no limit). */
  order: { kind: 'hash'; seed: string } | { kind: 'roster' } | { kind: 'none' };
  /** Take units while their start is below this many contacts. */
  limit: number | null;
  target: { kind: 'single'; agent: string } | { kind: 'pool' } | { kind: 'split'; agents: string[] };
  group: boolean;
  /** Rows the commit's UPDATE may still move (re-checked under the lock). */
  writeGuard: string;
}

/** A plan's own clauses for each operation kind (rebalance has its own chain). */
function specFor(op: Exclude<CanonicalAssignment, { kind: 'rebalance' }>, bind: Bind): PlanSpec {
  const notLive = `c.state NOT IN ${LIVE_STATES_SQL}`;
  // "Open" (CA2): pending and not DNC — a contact something will still dial.
  const open = openContactSql('c');
  const owned = (onlyUnassigned: boolean) =>
    onlyUnassigned ? 'c.assigned_user_id IS NULL' : `(c.assigned_user_id IS NULL OR c.state = 'pending')`;
  switch (op.kind) {
    case 'random_split':
      return {
        selection: [owned(op.onlyUnassigned)],
        order: { kind: 'hash', seed: op.seed },
        limit: null,
        target: { kind: 'split', agents: op.agents },
        group: op.group,
        writeGuard: notLive,
      };
    case 'filter': {
      const conds = [owned(op.onlyUnassigned)];
      const f = op.filter;
      if (f.states) conds.push(`c.state = ANY(${bind.add(f.states)}::varchar[])`);
      if (f.lastDispositions) conds.push(`c.last_disposition = ANY(${bind.add(f.lastDispositions)}::varchar[])`);
      if (f.column) {
        conds.push(`btrim(c.context ->> ${bind.add(f.column.name)}::text) = ANY(${bind.add(f.column.values)}::text[])`);
      }
      const split = op.agents.length > 1;
      return {
        selection: conds,
        order: split ? { kind: 'hash', seed: op.seed! } : { kind: 'none' },
        limit: null,
        target: split ? { kind: 'split', agents: op.agents } : { kind: 'single', agent: op.agents[0]! },
        group: op.group,
        writeGuard: notLive,
      };
    }
    case 'count':
      // "The next N to work": open unassigned contacts only (a reached, exhausted or DNC row is
      // nothing to work); contacts on a call are passed over, not counted against N.
      return {
        selection: ['c.assigned_user_id IS NULL', open],
        order: { kind: 'roster' },
        limit: op.count,
        target: { kind: 'single', agent: op.agent },
        group: op.group,
        writeGuard: `${open} AND c.assigned_user_id IS NULL`,
      };
    case 'range':
      // Named ids that are open move; live ones are counted `skipped_live`; any other id (closed,
      // DNC, not on the campaign) is skipped silently (CA2), so a drag-selected page never moves
      // another agent's reached contacts.
      return {
        selection: [`c.id = ANY(${bind.add(op.contactIds)}::uuid[])`,
          `((${open}) OR c.state IN ${LIVE_STATES_SQL})`],
        order: { kind: 'none' },
        limit: null,
        target: { kind: 'single', agent: op.agent },
        group: op.group,
        writeGuard: open,
      };
    case 'reassign':
      return {
        selection: [`c.assigned_user_id = ${bind.add(op.from)}::uuid`, `c.state = 'pending'`],
        order: op.count === null ? { kind: 'none' } : { kind: 'roster' },
        limit: op.count,
        target: { kind: 'single', agent: op.to },
        group: op.group,
        writeGuard: `c.state = 'pending'`,
      };
    case 'unassign':
      if (op.contactIds) {
        // Only open contacts go back to the pool (CA2); on-call ones are counted as skipped.
        return {
          selection: [`c.id = ANY(${bind.add(op.contactIds)}::uuid[])`, `c.state IN ('pending', 'in_flight', 'connected')`],
          order: { kind: 'none' },
          limit: null,
          target: { kind: 'pool' },
          group: op.group,
          writeGuard: `c.state = 'pending'`,
        };
      }
      return {
        selection: [`c.assigned_user_id = ${bind.add(op.from)}::uuid`, `c.state = 'pending'`],
        order: op.count === null ? { kind: 'none' } : { kind: 'roster' },
        limit: op.count,
        target: { kind: 'pool' },
        group: op.group,
        writeGuard: `c.state = 'pending'`,
      };
  }
}

function groupKeySql(group: boolean): string {
  if (!group) return 'c.id::text';
  const digits = contactPhoneDigitsSql('c');
  // A number with no digits at all is its own group, never one group of every such row.
  return `COALESCE(NULLIF(${digits}, ''), c.id::text)`;
}

/**
 * The CTE chain (without `WITH`) ending in `plan(id, from_user_id, to_user_id, size, gi)`,
 * plus `sel` for the live count. Exported for the plan tests.
 *
 * Window functions only, never a join of one CTE back onto another: a CTE scan carries no
 * statistics, and a nested loop between two 10,000-row CTEs is 10^8 comparisons. Each row
 * carries its group's `size`, its group's order key `ord`, and `gi` (its position in the
 * group; `gi = 1` is the group's head). Rows sorted by `(ord, gkey, gi)` keep a group
 * contiguous, so a running sum of the heads' sizes, minus the row's group size, is the
 * group's start position on every member, and every member gets the same target.
 */
export function planCtes(
  op: CanonicalAssignment,
  scope: AssignmentCampaignScope,
  bind: Bind,
  quotas?: RebalanceQuotas,
): { ctes: string; writeGuard: string } {
  const campaign = bind.add(scope.campaignId);
  if (op.kind === 'rebalance') return rebalanceCtes(op, scope, campaign, bind, quotas!);

  const spec = specFor(op, bind);
  const rn = spec.order.kind === 'roster' ? `, row_number() OVER (ORDER BY ${ROSTER_ORDER_SQL}) AS rn` : '';
  const sel = `sel AS MATERIALIZED (
      SELECT c.id, c.assigned_user_id AS from_user_id,
             (c.state IN ${LIVE_STATES_SQL}) AS live,
             ${groupKeySql(spec.group)} AS gkey${rn}
        FROM agency_contacts c
       WHERE c.campaign_id = ${campaign}::uuid AND ${spec.selection.join(' AND ')}
    )`;

  let ord: string;
  switch (spec.order.kind) {
    case 'hash': ord = `hashtextextended(${bind.add(spec.order.seed)}::text || ':' || s.gkey, 0)`; break;
    case 'roster': ord = 'min(s.rn) OVER (PARTITION BY s.gkey)'; break;
    case 'none': ord = '0::bigint'; break;
  }
  const nl = `nl AS (
      SELECT s.id, s.from_user_id, s.gkey,
             count(*) OVER (PARTITION BY s.gkey) AS size,
             ${ord} AS ord,
             row_number() OVER (PARTITION BY s.gkey ORDER BY s.id) AS gi
        FROM sel s WHERE NOT s.live
    )`;
  const cum = spec.order.kind === 'none' && spec.limit === null && spec.target.kind !== 'split'
    ? `cum AS (SELECT nl.*, 0::bigint AS cum_start, 0::bigint AS total FROM nl)`
    : `cum AS (
      SELECT nl.*,
             (sum(CASE WHEN nl.gi = 1 THEN nl.size ELSE 0 END)
                OVER (ORDER BY nl.ord, nl.gkey, nl.gi ROWS UNBOUNDED PRECEDING))::bigint - nl.size AS cum_start,
             count(*) OVER () AS total
        FROM nl
    )`;

  let target: string;
  switch (spec.target.kind) {
    case 'single': target = `${bind.add(spec.target.agent)}::uuid`; break;
    case 'pool': target = 'NULL::uuid'; break;
    case 'split': {
      const k = spec.target.agents.length;
      // The group's start position cut into K equal ranges (bigint division floors).
      target = `(${bind.add(spec.target.agents)}::uuid[])[((cum.cum_start * ${k}) / NULLIF(cum.total, 0))::int + 1]`;
      break;
    }
  }
  const limit = spec.limit === null ? '' : `WHERE cum.cum_start < ${bind.add(spec.limit)}::bigint`;
  const plan = `plan AS MATERIALIZED (
      SELECT cum.id, cum.from_user_id, ${target} AS to_user_id, cum.size, cum.gi FROM cum ${limit}
    )`;
  return { ctes: [sel, nl, cum, plan].join(',\n    '), writeGuard: spec.writeGuard };
}

/**
 * Rebalance: open, never-attempted, non-callback contacts of the over-target agents, newest
 * in roster order first, up to each giver's quota (a group is taken only if it fits whole),
 * dealt to the under-target agents by cumulative quota. Groups are per giver.
 */
function rebalanceCtes(
  op: Extract<CanonicalAssignment, { kind: 'rebalance' }>,
  scope: AssignmentCampaignScope,
  campaign: string,
  bind: Bind,
  quotas: RebalanceQuotas,
): { ctes: string; writeGuard: string } {
  const codes = bind.add(scope.callbackCodes);
  const givers = bind.add(quotas.givers.map((g) => g.agent));
  const gives = bind.add(quotas.givers.map((g) => g.give));
  const recv = bind.add(quotas.receivers.map((r) => r.agent));
  const ends = bind.add(quotas.receivers.map((r) => r.end));
  const sel = `sel AS MATERIALIZED (
      SELECT c.id, c.assigned_user_id AS from_user_id, false AS live,
             ${groupKeySql(op.group)} AS gkey,
             row_number() OVER (ORDER BY ${ROSTER_ORDER_SQL}) AS rn
        FROM agency_contacts c
       WHERE c.campaign_id = ${campaign}::uuid
         AND c.assigned_user_id = ANY(${givers}::uuid[])
         AND c.state = 'pending' AND c.attempt_count = 0
         AND ${contactBucketSql('c', codes)} = 'pending'
    )`;
  const nl = `nl AS (
      SELECT s.id, s.from_user_id, s.gkey,
             count(*) OVER (PARTITION BY s.from_user_id, s.gkey) AS size,
             max(s.rn) OVER (PARTITION BY s.from_user_id, s.gkey) AS ord,
             row_number() OVER (PARTITION BY s.from_user_id, s.gkey ORDER BY s.id) AS gi
        FROM sel s
    )`;
  const giv = `giv AS (
      SELECT nl.*, g.idx, g.give,
             (sum(CASE WHEN nl.gi = 1 THEN nl.size ELSE 0 END)
                OVER (PARTITION BY nl.from_user_id ORDER BY nl.ord DESC, nl.gkey, nl.gi ROWS UNBOUNDED PRECEDING))::bigint AS end_in_giver
        FROM nl JOIN unnest(${givers}::uuid[], ${gives}::int[]) WITH ORDINALITY AS g(uid, give, idx) ON g.uid = nl.from_user_id
    )`;
  const cum = `cum AS (
      SELECT giv.*,
             (sum(CASE WHEN giv.gi = 1 THEN giv.size ELSE 0 END)
                OVER (ORDER BY giv.idx, giv.ord DESC, giv.gkey, giv.gi ROWS UNBOUNDED PRECEDING))::bigint - giv.size AS cum_start
        FROM giv WHERE giv.end_in_giver <= giv.give
    )`;
  const plan = `plan AS MATERIALIZED (
      SELECT t.* FROM (
        SELECT cum.id, cum.from_user_id,
               (SELECT r.uid FROM unnest(${recv}::uuid[], ${ends}::int[]) AS r(uid, e)
                 WHERE cum.cum_start < r.e ORDER BY r.e LIMIT 1) AS to_user_id,
               cum.size, cum.gi
          FROM cum) t
       WHERE t.to_user_id IS NOT NULL
    )`;
  return { ctes: [sel, nl, giv, cum, plan].join(',\n    '), writeGuard: `c.state = 'pending'` };
}

/** `mv` (each plan row and whether it moves) and the aggregate the token pins. */
const MOVES_CTE = `mv AS (
      SELECT p.*, (p.from_user_id IS DISTINCT FROM p.to_user_id) AS moving FROM plan p
    )`;
const FINGERPRINT_SQL = `SELECT
      count(*)::int AS planned,
      (count(*) FILTER (WHERE moving))::int AS moving,
      (count(*) FILTER (WHERE moving AND to_user_id IS NULL))::int AS to_pool,
      (SELECT count(*) FROM sel WHERE live)::int AS skipped_live,
      (count(*) FILTER (WHERE gi = 1 AND size > 1))::int AS groups,
      COALESCE(bit_xor(hashtextextended(
        id::text || '>' || COALESCE(from_user_id::text, '') || '>' || COALESCE(to_user_id::text, ''), 0))
        FILTER (WHERE moving), 0)::text AS digest,
      (SELECT COALESCE(json_agg(json_build_object('agent_user_id', x.uid, 'receiving', x.r, 'giving', x.g)), '[]'::json)
         FROM (SELECT y.uid, sum(y.r)::int AS r, sum(y.g)::int AS g
                 FROM (SELECT to_user_id AS uid, 1 AS r, 0 AS g FROM mv WHERE moving AND to_user_id IS NOT NULL
                       UNION ALL
                       SELECT from_user_id, 0, 1 FROM mv WHERE moving AND from_user_id IS NOT NULL) y
                GROUP BY y.uid) x) AS per_agent
    FROM mv`;

interface FingerprintRow extends PlanFingerprint {
  per_agent: AgencyAssignmentAgentDelta[];
}

/** Thrown inside the commit's transaction to roll it back as stale. */
class StalePlan extends Error {}

export type AssignmentCommitOutcome =
  | { ok: true; result: AgencyAssignmentResult }
  | { ok: false; preview: AgencyAssignmentPreview };

/** Per-campaign outcome of an unstaff (CA6). */
export interface UnstaffReturn {
  campaign_id: string;
  /** The campaign's owning account (the audit row is filed under it). */
  account_id: string;
  on_unstaff: 'return_to_pool' | 'keep';
  batch_id: string;
  /** Open contacts returned to the pool. */
  moved: number;
  /** Contacts on a call or awaiting a write-up: left with the agent. */
  skipped_live: number;
  /** Open contacts left with the agent because the campaign keeps them. */
  kept: number;
}

export class AgencyAssignmentRepository {
  /**
   * Which of `userIds` hold no active staffing row on the campaign (`agent_not_staffed`).
   * Tenant-scoped like every staffing read.
   */
  async unstaffed(tenantId: string, campaignId: string, userIds: readonly string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT u.id::text AS id
         FROM unnest($3::uuid[]) WITH ORDINALITY AS u(id, i)
        WHERE NOT EXISTS (
          SELECT 1 FROM agency_campaign_agents s
           WHERE s.tenant_id = $1 AND s.campaign_id = $2 AND s.user_id = u.id AND s.unassigned_at IS NULL)
        ORDER BY u.i`,
      [tenantId, campaignId, userIds],
    );
    return rows.map((r) => r.id);
  }

  /** What `op` would do now. Writes nothing. */
  async preview(op: CanonicalAssignment, scope: AssignmentCampaignScope): Promise<AgencyAssignmentPreview> {
    const quotas = op.kind === 'rebalance' ? await this.rebalanceQuotas(getPool(), op, scope) : undefined;
    const fp = await this.fingerprint(getPool(), op, scope, quotas);
    return toPreview(op, fp);
  }

  /**
   * Commit `op` if its plan still equals `token`'s. One transaction: lock the moving rows,
   * re-plan, and write the moves and their history rows in one gated statement. A refusal
   * carries the fresh preview, computed under the same locks.
   */
  async commit(input: {
    op: CanonicalAssignment;
    scope: AssignmentCampaignScope;
    token: string;
    actorUserId: string | null;
  }): Promise<AssignmentCommitOutcome> {
    const { op, scope } = input;
    const expected = decodePreviewToken(input.token, op);
    // A token for another operation (or none at all) is stale before anything is locked.
    if (!expected) return { ok: false, preview: await this.preview(op, scope) };
    const drift = commitDrift(expected);
    const batchId = randomUUID();
    try {
      const outcome = await withTransaction(async (client, tx) => {
        await client.query(`SET LOCAL lock_timeout = '10s'`);
        const quotas = op.kind === 'rebalance' ? await this.rebalanceQuotas(client, op, scope) : undefined;

        const lockBind = params();
        const lock = planCtes(op, scope, lockBind, quotas);
        await client.query(
          `WITH ${lock.ctes},
           lk AS MATERIALIZED (
             SELECT c.id FROM agency_contacts c JOIN plan p ON p.id = c.id
              WHERE p.from_user_id IS DISTINCT FROM p.to_user_id
              ORDER BY c.id
                FOR NO KEY UPDATE OF c)
           SELECT count(*)::int AS n FROM lk`,
          lockBind.values,
        );

        const bind = params();
        const plan = planCtes(op, scope, bind, quotas);
        // Contact for contact, or (a large operation, CA13) its counts within the drift.
        const moving = bind.add(expected.moving);
        const toPool = bind.add(expected.to_pool);
        const exact = [
          `fp.planned = ${bind.add(expected.planned)}::int`,
          `fp.moving = ${moving}::int`,
          `fp.to_pool = ${toPool}::int`,
          `fp.skipped_live = ${bind.add(expected.skipped_live)}::int`,
          `fp.groups = ${bind.add(expected.groups)}::int`,
          `fp.digest = ${bind.add(expected.digest)}::text`,
        ].join(' AND ');
        const within = drift > 0
          ? ` OR (fp.moving > 0 AND abs(fp.moving - ${moving}::int) <= ${bind.add(drift)}::int`
            + ` AND abs(fp.to_pool - ${toPool}::int) <= ${bind.add(drift)}::int)`
          : '';
        const gate = `(${exact})${within}`;
        const actor = bind.add(input.actorUserId);
        const { rows } = await client.query<FingerprintRow & { ok: boolean; written: number }>(
          `WITH ${plan.ctes},
           ${MOVES_CTE},
           fp AS (${FINGERPRINT_SQL}),
           gate AS (SELECT (${gate}) AS ok FROM fp),
           upd AS (
             UPDATE agency_contacts c
                SET assigned_user_id = m.to_user_id,
                    assigned_at = CASE WHEN m.to_user_id IS NULL THEN NULL ELSE now() END,
                    assigned_by_user_id = CASE WHEN m.to_user_id IS NULL THEN NULL ELSE ${actor}::uuid END
               FROM mv m, gate g
              WHERE g.ok AND m.moving AND c.id = m.id
                AND c.campaign_id = ${bind.add(scope.campaignId)}::uuid
                AND ${plan.writeGuard}
                AND c.assigned_user_id IS NOT DISTINCT FROM m.from_user_id
             RETURNING c.id, m.from_user_id, m.to_user_id),
           ins AS (
             INSERT INTO agency_contact_assignment_events
               (tenant_id, campaign_id, contact_id, from_user_id, to_user_id, actor_user_id, reason, batch_id)
             SELECT ${bind.add(scope.tenantId)}::uuid, ${bind.add(scope.campaignId)}::uuid, u.id, u.from_user_id,
                    u.to_user_id, ${actor}::uuid, ${bind.add(op.kind satisfies AgencyAssignmentReason)}, ${bind.add(batchId)}::uuid
               FROM upd u
             RETURNING 1)
           SELECT fp.*, (SELECT ok FROM gate) AS ok, (SELECT count(*) FROM ins)::int AS written FROM fp`,
          bind.values,
        );
        const row = rows[0]!;
        if (!row.ok) {
          await tx.rollback();
          return { ok: false as const, preview: toPreview(op, row) };
        }
        // Every planned move was locked; a shortfall means a row changed anyway. Roll back.
        if (row.written !== row.moving) throw new StalePlan();
        return {
          ok: true as const,
          result: {
            kind: op.kind,
            batch_id: batchId,
            moved: row.written,
            skipped_live: row.skipped_live,
            unchanged: row.planned - row.moving,
            to_pool: row.to_pool,
            per_agent: sortDeltas(op, row.per_agent),
          },
        };
      }, { pool: getPool() });
      if (outcome.ok && outcome.result.moved > 0) {
        // A quiescent strict/preferred campaign may now have work for someone.
        publishPacingInvalidation({ type: 'contacts_changed', campaignId: scope.campaignId });
      }
      return outcome;
    } catch (err) {
      // A shortfall, a lock we could not take in time, or a deadlock with another writer (the
      // unstaff return locks in scan order): the roster is moving under us.
      const code = (err as { code?: string }).code;
      if (err instanceof StalePlan || code === '55P03' || code === '40P01') {
        return { ok: false, preview: await this.preview(op, scope) };
      }
      throw err;
    }
  }

  private async fingerprint(
    db: Queryable,
    op: CanonicalAssignment,
    scope: AssignmentCampaignScope,
    quotas: RebalanceQuotas | undefined,
  ): Promise<FingerprintRow> {
    const bind = params();
    const plan = planCtes(op, scope, bind, quotas);
    const { rows } = await db.query<FingerprintRow>(`WITH ${plan.ctes}, ${MOVES_CTE} ${FINGERPRINT_SQL}`, bind.values);
    return rows[0]!;
  }

  /** Each rebalanced agent's open backlog and how much of it may move. */
  private async rebalanceQuotas(
    db: Queryable,
    op: Extract<CanonicalAssignment, { kind: 'rebalance' }>,
    scope: AssignmentCampaignScope,
  ): Promise<RebalanceQuotas> {
    const bind = params();
    const agents = bind.add(op.agents);
    const campaign = bind.add(scope.campaignId);
    const codes = bind.add(scope.callbackCodes);
    const { rows } = await db.query<RebalanceLoad>(
      `SELECT a.uid::text AS agent,
              count(c.id)::int AS backlog,
              (count(c.id) FILTER (WHERE c.attempt_count = 0
                 AND ${contactBucketSql('c', `${codes}::text[]`)} = 'pending'))::int AS movable
         FROM unnest(${agents}::uuid[]) WITH ORDINALITY AS a(uid, i)
         LEFT JOIN agency_contacts c
           ON c.campaign_id = ${campaign}::uuid AND c.assigned_user_id = a.uid AND c.state = 'pending'
        GROUP BY a.uid, a.i
        ORDER BY a.i`,
      bind.values,
    );
    return rebalanceQuotas(rows);
  }

  /**
   * CA6: `userId` was unstaffed from `campaignIds` (the campaigns whose staffing row just
   * closed). On each campaign whose `on_unstaff` is `return_to_pool`, their `pending`
   * contacts lose their owner (history reason `unstaffed`, one batch per campaign); on
   * `keep`, nothing moves. Contacts on a call are never moved. One statement over every
   * campaign. Returns a row per campaign where the agent held an open contact (or one on a
   * call), so the caller audits exactly those.
   */
  async returnOnUnstaff(input: {
    tenantId: string;
    userId: string;
    campaignIds: readonly string[];
    actorUserId: string | null;
  }): Promise<UnstaffReturn[]> {
    if (input.campaignIds.length === 0) return [];
    const { rows } = await getPool().query<UnstaffReturn>(
      `WITH camp AS MATERIALIZED (
         SELECT ac.id, ac.account_id, ac.on_unstaff, gen_random_uuid() AS batch_id
           FROM agency_campaigns ac
          WHERE ac.tenant_id = $1 AND ac.id = ANY($3::uuid[])
       ),
       held AS (
         SELECT c.campaign_id,
                (count(*) FILTER (WHERE c.state = 'pending'))::int AS open,
                (count(*) FILTER (WHERE c.state IN ${LIVE_STATES_SQL}))::int AS live
           FROM agency_contacts c JOIN camp ON camp.id = c.campaign_id
          WHERE c.assigned_user_id = $2::uuid AND c.state IN ('pending', 'in_flight', 'connected')
          GROUP BY c.campaign_id
       ),
       upd AS (
         UPDATE agency_contacts c
            SET assigned_user_id = NULL, assigned_at = NULL, assigned_by_user_id = NULL
           FROM camp
          WHERE c.campaign_id = camp.id AND camp.on_unstaff = 'return_to_pool'
            AND c.assigned_user_id = $2::uuid AND c.state = 'pending'
         RETURNING c.id, c.campaign_id, camp.batch_id),
       ins AS (
         INSERT INTO agency_contact_assignment_events
           (tenant_id, campaign_id, contact_id, from_user_id, to_user_id, actor_user_id, reason, batch_id)
         SELECT $1::uuid, u.campaign_id, u.id, $2::uuid, NULL, $4::uuid, 'unstaffed', u.batch_id FROM upd u
         RETURNING campaign_id)
       SELECT camp.id::text AS campaign_id, camp.account_id::text AS account_id, camp.on_unstaff,
              camp.batch_id::text AS batch_id,
              (SELECT count(*) FROM ins WHERE ins.campaign_id = camp.id)::int AS moved,
              held.live AS skipped_live,
              CASE WHEN camp.on_unstaff = 'keep' THEN held.open ELSE 0 END AS kept
         FROM camp JOIN held ON held.campaign_id = camp.id
        ORDER BY camp.id`,
      [input.tenantId, input.userId, input.campaignIds, input.actorUserId],
    );
    for (const r of rows) {
      if (r.moved > 0) publishPacingInvalidation({ type: 'contacts_changed', campaignId: r.campaign_id });
    }
    return rows;
  }

  /**
   * The unstaff return's catch-up (CA6), one campaign, one statement: every `pending` contact
   * whose owner has NO active staffing row on the campaign loses its owner (history reason
   * `unstaffed`, actor NULL: the system, under `batchId`). Run by the pacing leader's owner
   * sweep on a running `strict` / `preferred` campaign whose `on_unstaff` is `return_to_pool`.
   *
   * {@link returnOnUnstaff} moves only what is `pending` at the moment of the unstaff; a contact
   * on a call then settles back to `pending` still owned by an agent who can no longer join, and
   * nothing else would ever dial it. The same holds for a callback an unstaffed agent with a
   * session still open books (CA4), and for a return the unstaff statement lost to an error.
   *
   * Cost: the owners are found by a loose index scan of `idx_agency_contacts_assignee` (one
   * probe per distinct owner), the staffing check is per owner, and only the unstaffed owners'
   * `pending` rows are read, so a campaign whose owners are all staffed costs a few probes.
   * Never a live contact: the pick is `pending` under `FOR UPDATE SKIP LOCKED`, and the UPDATE
   * re-checks it. At most `limit` moves; the rest go on the next sweep.
   */
  async returnUnstaffedOwners(input: {
    campaignId: string;
    batchId: string;
    limit: number;
  }): Promise<Array<{ contactId: string; fromUserId: string }>> {
    if (input.limit <= 0) return [];
    const { rows } = await getPool().query<{ contact_id: string; from_user_id: string }>(
      `WITH RECURSIVE owners(uid) AS (
         (SELECT c.assigned_user_id FROM agency_contacts c
           WHERE c.campaign_id = $1 AND c.assigned_user_id IS NOT NULL
           ORDER BY c.assigned_user_id LIMIT 1)
         UNION ALL
         SELECT (SELECT c.assigned_user_id FROM agency_contacts c
                  WHERE c.campaign_id = $1 AND c.assigned_user_id > o.uid
                  ORDER BY c.assigned_user_id LIMIT 1)
           FROM owners o WHERE o.uid IS NOT NULL
       ),
       gone AS MATERIALIZED (
         SELECT o.uid FROM owners o
          WHERE o.uid IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM agency_campaign_agents a
               WHERE a.campaign_id = $1 AND a.user_id = o.uid AND a.unassigned_at IS NULL)
       ),
       due AS MATERIALIZED (
         SELECT c.id, c.assigned_user_id
           FROM agency_contacts c JOIN gone g ON c.assigned_user_id = g.uid
          WHERE c.campaign_id = $1 AND c.state = 'pending'
          ORDER BY c.id
          LIMIT $3
            FOR UPDATE OF c SKIP LOCKED
       ),
       ${returnToPoolSql('unstaffed', '$2')}`,
      [input.campaignId, input.batchId, input.limit],
    );
    return rows.map((r) => ({ contactId: r.contact_id, fromUserId: r.from_user_id }));
  }

  /** Whether `contactId` is a contact of `campaignId` (the history's 404). */
  async contactOnCampaign(campaignId: string, contactId: string): Promise<boolean> {
    const { rows } = await getPool().query(
      'SELECT 1 FROM agency_contacts WHERE id = $1::uuid AND campaign_id = $2::uuid',
      [contactId, campaignId],
    );
    return rows.length > 0;
  }

  /** Who held a contact and when, newest first, at most `limit` rows. */
  async history(campaignId: string, contactId: string, limit = 200): Promise<AgencyAssignmentEvent[]> {
    const { rows } = await getPool().query<AgencyAssignmentEvent & { created_at: Date }>(
      `SELECT id, from_user_id, to_user_id, actor_user_id, reason, batch_id, created_at
         FROM agency_contact_assignment_events
        WHERE contact_id = $1::uuid AND campaign_id = $2::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [contactId, campaignId, limit],
    );
    return rows.map((r) => ({ ...r, created_at: iso(r.created_at)! }));
  }
}

function sortDeltas(op: CanonicalAssignment, deltas: readonly AgencyAssignmentAgentDelta[]): AgencyAssignmentAgentDelta[] {
  const order = agentOrder(op);
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };
  return [...deltas].sort((a, b) => rank(a.agent_user_id) - rank(b.agent_user_id) || a.agent_user_id.localeCompare(b.agent_user_id));
}

function toPreview(op: CanonicalAssignment, fp: FingerprintRow): AgencyAssignmentPreview {
  return {
    kind: op.kind,
    preview_token: encodePreviewToken(op, fp),
    seed: seedOf(op),
    matched: fp.planned + fp.skipped_live,
    moving: fp.moving,
    skipped_live: fp.skipped_live,
    unchanged: fp.planned - fp.moving,
    to_pool: fp.to_pool,
    per_agent: sortDeltas(op, fp.per_agent),
    same_number_groups: fp.groups,
  };
}

export const agencyAssignmentRepository = new AgencyAssignmentRepository();
