import { getPool } from '../connection.js';

/*
 * PORT NOTE (magick-agency): ported verbatim from master
 * `src/db/repositories/agency-campaign-agent.repository.ts` (v3.24.0). Master has
 * no separate model file; the record and input types live here, as in master.
 * Comments are master's and describe master's two-database world (core-owned
 * campaign ids, the proxy); in this app `agency_campaigns` is in the same
 * database, but the table still has no FK on `campaign_id` (baseline).
 */

/**
 * A row of `agency_campaign_agents` (migration 060, index widened by 064) — one
 * agent's staffing on one campaign, active while `unassigned_at` is NULL. An agent
 * may hold several such rows; being LIVE on one campaign is core's session index,
 * not this table.
 *
 * `campaign_id` is core's, with no FK behind it (separate databases), so a row can
 * legitimately outlive the campaign it names. Readers resolve the name through the
 * proxy and report what they find rather than assuming the row is stale.
 */
export interface AgencyCampaignAgentRecord {
  id: string;
  tenant_id: string;
  account_id: string | null;
  campaign_id: string;
  user_id: string;
  assigned_by: string | null;
  assigned_at: Date;
  unassigned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AssignAgentInput {
  tenant_id: string;
  account_id?: string | null;
  campaign_id: string;
  user_id: string;
  assigned_by?: string | null;
}

/**
 * How many times {@link AgencyCampaignAgentRepository.assign} re-runs its insert.
 *
 * Three, and the bound matters more than the number. Since migration 064 the only
 * way to consume an attempt is a concurrent *unassign* closing the very row our
 * insert just conflicted with — a supervisor unstaffing somebody in the instant
 * another supervisor staffs them onto the same campaign. That terminates after one
 * extra pass for any real workload; the bound is here so a pathological client
 * cannot turn it into a spin against the database.
 */
const ASSIGN_MAX_ATTEMPTS = 3;

/**
 * Thrown when a second assignment cannot be created because migration 064 has not
 * been applied yet — 060's one-active-assignment-per-tenant index is still in force.
 *
 * A typed error rather than a generic throw because the route turns it into a 409
 * with an actionable sentence. The alternatives are both worse: a 500 tells a
 * supervisor nothing, and silently moving the agent (060's behaviour) would make the
 * result of the same request depend on which migration had run, which is the class of
 * inconsistency that is hardest to diagnose from a bug report.
 *
 * Only reachable in the window between deploying this code and applying 064 — or
 * after a `migrate down`. It should never be seen in a settled deployment.
 */
export class StaffingUpgradePendingError extends Error {
  readonly code = 'staffing_upgrade_pending';

  constructor(
    readonly userId: string,
    readonly currentCampaignId: string,
    readonly requestedCampaignId: string,
  ) {
    super(
      `Cannot staff user ${userId} onto campaign ${requestedCampaignId}: they are already ` +
        `active on ${currentCampaignId} and this database still enforces one campaign per ` +
        'person (migration 064 not applied).',
    );
    this.name = 'StaffingUpgradePendingError';
  }
}

/**
 * The name of migration 064's index. Probed rather than assumed — see
 * {@link hasPerCampaignIndex}.
 */
const PER_CAMPAIGN_INDEX = 'uq_agency_campaign_agent_active_campaign';

/**
 * Memoized answer to "has migration 064 been applied?", cached for the process.
 *
 * A `Promise` rather than a boolean so concurrent first callers share one probe
 * instead of stampeding the catalog. Cleared on failure so a transient error does
 * not pin a wrong answer for the lifetime of the process.
 */
let perCampaignIndexProbe: Promise<boolean> | null = null;

/**
 * Whether the database enforces staffing per CAMPAIGN (migration 064) or per
 * TENANT (migration 060).
 *
 * ── Why this is probed and not inferred ────────────────────────────────────
 * `assign()` uses a bare `ON CONFLICT DO NOTHING`, which matches whichever index
 * exists — that is what makes the code correct across the migration. The cost is
 * that a conflict no longer says WHICH index refused, and one situation is
 * genuinely ambiguous from row state alone:
 *
 *   insert conflicted · no live row for this campaign · a live row for another
 *
 * Under 060 that is "they are staffed elsewhere and a second assignment is not
 * expressible". Under 064 it is "the row we conflicted with was just unassigned,
 * and their other campaigns have nothing to do with it" — an ordinary race, and the
 * one the retry loop exists for.
 *
 * An earlier revision read that state as the first case unconditionally, so a
 * multi-staffed agent hitting the race got a misleading 409 instead of a completed
 * assignment (found by review on PR #218). No amount of row inspection can
 * separate the two, so the schema is asked directly.
 *
 * Read from `pg_indexes` rather than from a migration count: the catalog is the
 * outcome, a migrations table only records intent, and a hand-dropped index would
 * make the second lie.
 *
 * ── Failing OPEN is the safe direction ────────────────────────────────────
 * If the probe itself fails we assume 064 IS present, because that is the settled
 * state of every deployment past this release: the cost is that a genuinely pre-064
 * database reports the retry-exhaustion error instead of the tailored 409, which is
 * a worse message for a rare case. Assuming the opposite would hand a confident,
 * wrong "finish upgrading" 409 to every racing assign on a healthy database.
 */
async function hasPerCampaignIndex(): Promise<boolean> {
  perCampaignIndexProbe ??= (async () => {
    const pool = getPool();
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'agency_campaign_agents'
            AND indexname = $1
       ) AS exists`,
      [PER_CAMPAIGN_INDEX],
    );
    return result.rows[0]?.exists ?? true;
  })().catch(() => {
    // Do not pin a wrong answer for the process; fail open (see above).
    perCampaignIndexProbe = null;
    return true;
  });
  return perCampaignIndexProbe;
}

/** Test seam: forget the probed index shape. */
export function resetPerCampaignIndexProbe(): void {
  perCampaignIndexProbe = null;
}

/**
 * The ceiling on one `listAllForUser` page, and the floor under a silly request.
 *
 * `MAX` is a product judgement rather than a database one: a staffing history is
 * read by a person deciding "was I on this campaign in March", and two hundred
 * rows is far past what any screen renders and far short of what an account with
 * years of reassignments accumulates. `to`/`from` is how the rest is reached.
 *
 * `MIN` of 1 rather than 0 is the deliberate half. `agency_campaign_agents` has
 * already produced one defect that rendered every agent's history empty, and an
 * empty page is indistinguishable from it — so a caller that asks for nothing
 * gets one row and something to notice, not silence.
 */
export const HISTORY_LIMIT_MAX = 200;
const HISTORY_LIMIT_MIN = 1;

/** Clamp a requested history page size into `[MIN, MAX]`; absent means MAX. */
function clampHistoryLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return HISTORY_LIMIT_MAX;
  return Math.min(HISTORY_LIMIT_MAX, Math.max(HISTORY_LIMIT_MIN, Math.floor(requested)));
}

/** Postgres `23505 unique_violation`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export class AgencyCampaignAgentRepository {
/**
   * Every campaign this agent is staffed on — the agent's own question, "where
   * am I supposed to be today?"
   *
   * Plural since migration 064. It used to be singular by construction, because
   * `uq_agency_campaign_agent_active` allowed one live row per person per tenant
   * and assigning somebody to a second campaign silently unstaffed them from the
   * first. That made an ordinary afternoon handover destructive and left the
   * agent's landing page unable to express "which of my campaigns now?". The
   * index is now per-campaign and this returns the set.
   *
   * Tenant-scoped in the same statement as the read, per rule 1 of the RBAC
   * section in docs/reference/magick-master/CLAUDE.md — an assignment id is not a capability and a user id
   * says nothing about which tenant is asking.
   *
   * `ORDER BY assigned_at ASC, id ASC` is a STABLE total order, not a ranking:
   * the id tiebreaks two rows written in the same transaction (a supervisor
   * staffing somebody onto two campaigns at once), because a bare `assigned_at`
   * would let equal timestamps come back in a different order on every read and
   * the picker's rows would shuffle under the agent's cursor.
   */
  async listActiveForUser(
    tenantId: string,
    userId: string,
  ): Promise<AgencyCampaignAgentRecord[]> {
    const pool = getPool();
    const result = await pool.query<AgencyCampaignAgentRecord>(
      `SELECT * FROM agency_campaign_agents
        WHERE tenant_id = $1 AND user_id = $2 AND unassigned_at IS NULL
        ORDER BY assigned_at ASC, id ASC`,
      [tenantId, userId],
    );
    return result.rows;
  }

  /**
   * The OLDEST active assignment, or null.
   *
   * Exists only to serve the deprecated singular `GET /my-assignment`, which a
   * browser tab loaded before this release is still calling. Oldest rather than
   * newest so the answer is the one that has been stable longest — a stale
   * console keeps being sent where it was being sent yesterday, instead of
   * following staffing edits it has no UI to explain.
   *
   * Do not reach for this in new code: outside that back-compat route, picking
   * one of an agent's campaigns without asking them is the bug migration 064
   * exists to fix. Use {@link listActiveForUser}.
   *
   * @deprecated Use {@link listActiveForUser}.
   */
  async findActiveForUser(
    tenantId: string,
    userId: string,
  ): Promise<AgencyCampaignAgentRecord | null> {
    const rows = await this.listActiveForUser(tenantId, userId);
    return rows[0] ?? null;
  }

  /**
   * The agent's own FULL staffing history — active rows AND closed ones.
   *
   * ── Why this exists beside {@link listActiveForUser} rather than inside it ──
   * Migration 060 closes rows (`unassigned_at`) instead of deleting them, and its
   * header says exactly why: *"who was staffed on this campaign in March" is a
   * question supervisors and disputes actually ask, and a delete cannot answer
   * it.* Until this method existed nothing in the platform could ask it. Every
   * reader — `listActiveForUser`, `listActiveForCampaign`, `findActiveForUser` —
   * carries `unassigned_at IS NULL`, so the history was being written and was
   * unreadable: storage paying for a promise no code kept.
   *
   * It is a SECOND method rather than a flag on the first because every existing
   * caller of `listActiveForUser` wants active-only and would be wrong with more:
   * the landing page's picker must not offer a campaign the agent was taken off,
   * and the deprecated singular route picks `rows[0]` and would start answering
   * with an assignment that ended months ago. A boolean parameter puts that
   * distinction one wrong argument away; two methods put it in the name.
   *
   * ── Ordering is NEWEST first, unlike its active-only sibling ───────────────
   * `listActiveForUser` sorts ascending because it feeds a stable picker. This
   * feeds a history, where the useful end is the recent one, and an agent with two
   * years of closed rows should not have to scroll to find this month. Still a
   * TOTAL order (`assigned_at DESC, id DESC`) for the same reason its sibling
   * tiebreaks: both audit loggers and both write paths batch, so two rows written
   * in one transaction share a timestamp to the microsecond, and a bare
   * `assigned_at` would let equal rows come back in a different order per read.
   *
   * Tenant-scoped in the same statement as the read, per rule 1 of docs/reference/magick-master/CLAUDE.md's
   * RBAC section.
   *
   * ── BOUNDED, which an earlier revision of this docstring said it was not ───
   * It used to end "deliberately UNBOUNDED … a handful per campaign per year, not
   * a growing log", and then nominated the remedy: *"If that assumption ever
   * breaks, the fix is a `from`/`to` window rather than a page, because the
   * question this answers is always about a period."* The assumption does not
   * survive contact with the table. This returns CLOSED rows as well as open ones,
   * so the row count only ever grows: every reassignment adds one, every
   * offboarding-and-rehire adds more, and `closeAllForUser` manufactures a closed
   * row per assignment in one statement. Nothing ever removes one — that is the
   * entire point of migration 060 closing rather than deleting. And the only
   * caller is `GET /proxy/agency/my-campaigns`, which an `agent` — the lowest
   * privileged role there is — reaches on their own console, and which spends one
   * core round trip per distinct campaign on the result.
   *
   * So the nominated shape is implemented rather than described: a hard `LIMIT`
   * the caller cannot raise, and an optional `from`/`to` window on `assigned_at`
   * so the rows past the ceiling stay reachable by asking for the period they are
   * in. The window bounds `assigned_at` — the column the ordering is on — so
   * "newest first, capped" and "this period" compose rather than fight.
   *
   * `limit` is clamped here rather than trusted, because a repository that accepts
   * an unbounded number from a route is only as bounded as its least careful
   * caller. A non-positive value clamps to 1 and not to 0: this table's own
   * history includes a defect that rendered every agent's staffing empty, and
   * "asked for nothing, got nothing" is indistinguishable from it.
   */
  async listAllForUser(
    tenantId: string,
    userId: string,
    options: { limit?: number; from?: Date; to?: Date } = {},
  ): Promise<AgencyCampaignAgentRecord[]> {
    const pool = getPool();
    const limit = clampHistoryLimit(options.limit);

    const conditions = ['tenant_id = $1', 'user_id = $2'];
    const values: unknown[] = [tenantId, userId];
    if (options.from) {
      values.push(options.from);
      conditions.push(`assigned_at >= $${values.length}`);
    }
    if (options.to) {
      values.push(options.to);
      conditions.push(`assigned_at < $${values.length}`);
    }
    values.push(limit);

    const result = await pool.query<AgencyCampaignAgentRecord>(
      `SELECT * FROM agency_campaign_agents
        WHERE ${conditions.join(' AND ')}
        ORDER BY assigned_at DESC, id DESC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows;
  }

  /**
   * Close EVERY open assignment this user holds in this tenant. Returns the rows
   * it closed — id, campaign and account — or an empty array when there were none.
   *
   * ── The leak this closes ───────────────────────────────────────────────────
   * `DELETE /users/:id/membership` removed a membership and dropped a cache key,
   * and nothing else. Nothing in master called any bulk unassign — this repository's
   * only caller was the staffing route — so a departed agent stayed on every
   * supervisor's staffing list forever, and `GET /campaigns/:id/agents` went on
   * resolving them to a name and an email out of `users`. The same held for a role
   * change away from `agent`.
   *
   * ── Closing a row REVOKES NOTHING, and that is what makes this automatic ───
   * Staffing is not authorization (migration 060's header, and the module header
   * of `proxy-agency-staffing.routes.ts`): nothing consults this table to decide
   * whether a join is allowed — `agency.station.connect` does, and the membership
   * removal is what takes that away. So this is a tidy-up of a navigation list,
   * safe to do without asking, and its failure is survivable. It is emphatically
   * NOT the mechanism that ends someone's access, and it must never be made into
   * one: a caller that treats a closed row as a revocation has re-introduced the
   * conflation 064's header spent a page separating.
   *
   * ── Returns the ROWS, not a count ─────────────────────────────────────────
   * One `agency_campaign_agent.unassigned` audit row is written per closed
   * assignment, and that row's `resource_id` has to be the assignment (the mistake
   * `unassign`'s docstring records is filing the campaign id under
   * `resource_type: 'agency_campaign_agent'`). `campaign_id` comes back too because
   * the audit row carries it as a first-class column — a count could express
   * neither, so the signature is what would have made the wrong value the
   * convenient one.
   *
   * ── `accountId` narrows the close for an account-scoped CALLER ────────────
   * A tenant-wide caller (`accountId` omitted) closes every open assignment for
   * this person in this tenant, as before. An ACCOUNT-scoped caller passes their
   * own `account_id`, and the statement adds `AND account_id = $3` — an equality,
   * not `IS NULL OR =`, so a tenant-level assignment (`account_id IS NULL`) is
   * correctly unreachable to a scoped close, matching `dncRepository.deleteById`'s
   * identical reasoning. Without this, the caller-scope guard the offboarding
   * routes apply to WHICH MEMBERSHIP they may change was undermined by this side
   * effect: an account_admin scoped to account A, offboarding a user out of A,
   * still closed that user's staffing on every campaign in every sibling account
   * — a cross-account mutation the membership guard was supposed to prevent.
   *
   * ── `account_id` comes back for the same reason, and it is load-bearing ────
   * A tenant-wide close reaches assignments across EVERY account in the tenant,
   * and `GET /audit-log` is account-scoped (`auditAccountScope` in
   * `audit.routes.ts`: an account-scoped membership only ever sees rows stamped
   * with its own account). Stamping the audit rows with the ACTOR's
   * `request.accountId` — one value for a whole tenant's worth of assignments —
   * therefore filed every row under whichever
   * account the offboarding admin happened to have selected, and the
   * `account_admin` whose roster just changed saw no trail at all. So the account
   * travels with each row and the caller stamps per row.
   *
   * The column is attribution rather than authority (see `assertCampaignInScope`
   * in `proxy-agency-staffing.routes.ts`): it records the account context the
   * assignment was MADE in, and a tenant-level member writes NULL. NULL is
   * returned as NULL rather than back-filled here — the caller must not invent an
   * account for a row that never had one, which is the defect this returns the
   * column to fix.
   *
   * A single statement, so it cannot half-apply: the alternative — read the open
   * rows, then close them one by one — leaves an interrupted offboarding with some
   * rows closed and no way to tell which, and it is N round trips for one fact.
   */
  async closeAllForUser(
    tenantId: string,
    userId: string,
    accountId?: string,
  ): Promise<Array<{ id: string; campaign_id: string; account_id: string | null }>> {
    const pool = getPool();
    const result = accountId === undefined
      ? await pool.query<{ id: string; campaign_id: string; account_id: string | null }>(
        `UPDATE agency_campaign_agents
            SET unassigned_at = NOW()
          WHERE tenant_id = $1
            AND user_id = $2
            AND unassigned_at IS NULL
        RETURNING id, campaign_id, account_id`,
        [tenantId, userId],
      )
      : await pool.query<{ id: string; campaign_id: string; account_id: string | null }>(
        `UPDATE agency_campaign_agents
            SET unassigned_at = NOW()
          WHERE tenant_id = $1
            AND user_id = $2
            AND account_id = $3
            AND unassigned_at IS NULL
        RETURNING id, campaign_id, account_id`,
        [tenantId, userId, accountId],
      );
    return result.rows;
  }

  /**
   * The supervisor's question: "who is staffed on this campaign?"
   *
   * Tenant-scoped as well as campaign-scoped, and the tenant predicate is the
   * security property rather than a filter: `campaign_id` arrives from the URL
   * and carries no FK, so without it a supervisor could name another tenant's
   * campaign id and read back that tenant's staffing. A foreign campaign id and
   * an unknown one are then indistinguishable — both return an empty list, which
   * is the same reason a cross-tenant miss answers 404 rather than 403.
   */
  async listActiveForCampaign(
    campaignId: string,
    tenantId: string,
  ): Promise<AgencyCampaignAgentRecord[]> {
    const pool = getPool();
    const result = await pool.query<AgencyCampaignAgentRecord>(
      `SELECT * FROM agency_campaign_agents
        WHERE campaign_id = $1 AND tenant_id = $2 AND unassigned_at IS NULL
        ORDER BY assigned_at ASC`,
      [campaignId, tenantId],
    );
    return result.rows;
  }

/**
   * Staff a user onto a campaign. Idempotent.
   *
   * ── This used to MOVE them, and no longer does ─────────────────────────────
   * Under migration 060's per-tenant index, assigning somebody already staffed
   * elsewhere closed that row first — so `assign()` was a two-statement
   * transaction with a bounded retry loop around a lost-race case. Migration 064
   * widened the index to `(tenant_id, user_id, campaign_id)`, which deletes that
   * whole problem rather than solving it: there is no other row to close, so
   * there is no move, so there is no race to lose and nothing to retry.
   *
   * What survives from the old design is the ONE property the old index was
   * really bought for — a double-clicked Assign is a no-op rather than a
   * duplicate row — and it is now the only thing the index has to do.
   *
   * ── `ON CONFLICT … DO NOTHING` plus a read-back, not `DO UPDATE` ───────────
   * Re-assigning somebody to a campaign they are already on must not churn
   * `assigned_at`: "staffed since Tuesday" is a fact supervisors read off this
   * table, and a supervisor double-clicking Assign has not restaffed anybody.
   * `DO UPDATE` would rewrite it; `DO NOTHING` leaves the existing row alone, and
   * the read-back returns it as it stands.
   *
   * The read-back is a SEPARATE statement and needs no transaction around it.
   * The only reason it can find nothing inserted is that a live row for this
   * exact `(tenant, user, campaign)` already existed, and closing an assignment
   * is a supervisor action rather than anything this method does — so a concurrent
   * unassign landing in between is a genuine "they were just unstaffed", not a
   * torn read. It is retried for exactly that case — up to
   * `ASSIGN_MAX_ATTEMPTS` — and then reported: a caller handed `undefined` as a
   * record would report a staffing change that never happened.
   *
   * ── The arbiter is deliberately UNNAMED, and that is a deployability property ─
   * `ON CONFLICT DO NOTHING` with no target matches ANY unique index on the table.
   * Naming one — `(tenant_id, user_id, campaign_id) WHERE unassigned_at IS NULL` —
   * also works, and reads better, but it couples this statement to the exact shape
   * of migration 064's index: run it against 060's `(tenant_id, user_id)` index and
   * Postgres cannot infer an arbiter at all and raises `42P10`, which surfaces as a
   * 500 on every staffing write rather than as anything diagnosable.
   *
   * That coupling is a real hazard rather than a hypothetical one, and it bites in
   * the direction people actually go: a code ROLLBACK past 064 leaves the wide index
   * in place, and any release whose `assign()` names the old two-column arbiter then
   * breaks. The bare form is immune in both directions — it is correct under 060's
   * index and under 064's — so the code stops caring which migration has run. See
   * migration 064's header for the rollback note.
   *
   * The cost of the bare form is that a conflict no longer tells us WHICH index
   * refused, which is why the read-back below distinguishes the two cases itself.
   */
  async assign(input: AssignAgentInput): Promise<AgencyCampaignAgentRecord> {
    const pool = getPool();

    for (let attempt = 1; attempt <= ASSIGN_MAX_ATTEMPTS; attempt += 1) {
      try {
        const inserted = await pool.query<AgencyCampaignAgentRecord>(
          `INSERT INTO agency_campaign_agents
             (tenant_id, account_id, campaign_id, user_id, assigned_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            input.tenant_id,
            input.account_id ?? null,
            input.campaign_id,
            input.user_id,
            input.assigned_by ?? null,
          ],
        );
        if (inserted.rows[0]) return inserted.rows[0];

        // Nothing inserted ⇒ some live row blocked us. Read the one for this exact
        // triple: already staffed here, by us on a previous click or by whoever won
        // the race, and either way the requested state holds.
        const existing = await pool.query<AgencyCampaignAgentRecord>(
          `SELECT * FROM agency_campaign_agents
            WHERE tenant_id = $1 AND user_id = $2 AND campaign_id = $3
              AND unassigned_at IS NULL`,
          [input.tenant_id, input.user_id, input.campaign_id],
        );
        if (existing.rows[0]) return existing.rows[0];

        /**
         * Nothing for this campaign either, so what refused us? Two possibilities,
         * and which one it is depends on WHICH INDEX EXISTS — not on what rows this
         * person has. See {@link hasPerCampaignIndex} for why that distinction
         * cannot be made from row state, and for the bug that made when it was
         * attempted.
         *
         *  - **064 applied (the normal case).** The insert conflicts only on this
         *    campaign, so an empty read-back means that row was just unassigned. Any
         *    other assignments this agent holds are irrelevant. Retry.
         *  - **064 NOT applied.** 060's `(tenant_id, user_id)` index is in force and
         *    they are staffed elsewhere, so a second assignment is not expressible.
         *    Retrying cannot help, and silently "moving" them would make the outcome
         *    depend on which migration had run — the destructive behaviour 064 exists
         *    to remove.
         */
        if (!(await hasPerCampaignIndex())) {
          const elsewhere = await pool.query<{ campaign_id: string }>(
            `SELECT campaign_id FROM agency_campaign_agents
              WHERE tenant_id = $1 AND user_id = $2 AND unassigned_at IS NULL
              LIMIT 1`,
            [input.tenant_id, input.user_id],
          );
          if (elsewhere.rows[0]) {
            throw new StaffingUpgradePendingError(
              input.user_id,
              elsewhere.rows[0].campaign_id,
              input.campaign_id,
            );
          }
        }

        // The blocking row was closed. Retry.
      } catch (err) {
        // A `23505` the `ON CONFLICT` arbiter did not absorb: a conflicting row
        // committing between the index probe and our insert, or a second unique
        // constraint added later that this statement does not name. Same remedy,
        // same bound; anything else propagates untouched.
        if (!isUniqueViolation(err) || attempt === ASSIGN_MAX_ATTEMPTS) throw err;
      }
    }

    throw new Error(
      `Could not assign user ${input.user_id} to campaign ${input.campaign_id} after ` +
        `${ASSIGN_MAX_ATTEMPTS} attempts — a concurrent unassign kept closing the row ` +
        'this insert then conflicted with.',
    );
  }

  /**
   * Close an assignment. Returns the CLOSED ROW'S ID, or null when there was
   * nothing to close.
   *
   * ── Why an id and not a boolean ────────────────────────────────────────────
   * The caller writes an audit row whose `resource_type` is
   * `agency_campaign_agent`, so its `resource_id` has to be the assignment — the
   * campaign id was filed there for one commit, which made the two halves of a
   * row's history unjoinable (POST files the assignment id) and pointed a reader
   * at a resource of a different type. A boolean cannot express the id, so the
   * signature is what made the wrong value the convenient one.
   *
   * `null`/id also still answers "did anything change", so the route's
   * conditional audit is unaffected.
   *
   * Tenant- AND campaign-scoped: unassigning is expressed as "remove this person
   * from THIS campaign", so a stale console holding an old campaign id must not
   * be able to unstaff someone from the campaign they were since moved to. Note
   * the campaign predicate is NOT the account check — the route proves campaign
   * ownership through core before calling this (`assertCampaignInScope`), because
   * this table has no trustworthy account column to check against.
   */
  async unassign(
    tenantId: string,
    campaignId: string,
    userId: string,
  ): Promise<string | null> {
    const pool = getPool();
    const result = await pool.query<{ id: string }>(
      `UPDATE agency_campaign_agents
          SET unassigned_at = NOW()
        WHERE tenant_id = $1
          AND campaign_id = $2
          AND user_id = $3
          AND unassigned_at IS NULL
      RETURNING id`,
      [tenantId, campaignId, userId],
    );
    return result.rows[0]?.id ?? null;
  }
}

export const agencyCampaignAgentRepository = new AgencyCampaignAgentRepository();
