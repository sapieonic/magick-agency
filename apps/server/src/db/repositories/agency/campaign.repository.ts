/**
 * `AgencyCampaignRepository`: campaign rows, their lifecycle and the reads that
 * hang off one campaign. The retry and dashboard bodies live in
 * `campaign-retry.ts` and `campaign-stats.ts`; the methods here delegate.
 */
import { getPool } from '@magick-agency/db';
import { UUID_RE } from '../../../utils/uuid.js';
import {
  AGENCY_CAMPAIGN_TERMINAL_STATUSES,
  type AgencyCampaignDependent,
  type AgencyCampaignRecord,
} from '../../models/agency.model.js';
import type { AgencyCampaignLineage, AgencyCampaignActor } from '@magick-agency/contracts/agency';
import { DEFAULT_ABANDONMENT_CEILING_PCT } from '../../../agency/campaign-thresholds.js';
import { CAMPAIGN_INSERT_COLUMNS_SQL } from './sql-fragments.js';
import { iso } from './projections.js';
import { createRetryCampaign, previewRetry } from './campaign-retry.js';
import { campaignHealthInputs, campaignStats, campaignStatsSeries } from './campaign-stats.js';

/**
 * The columns {@link AgencyCampaignRepository.update} may write. Deliberately not
 * `status` — lifecycle is `transitionStatus` only.
 */
const CAMPAIGN_PATCHABLE_COLUMNS: ReadonlySet<string> = new Set([
  'name', 'caller_ids', 'telephony_provider',
  'calling_window_start', 'calling_window_end', 'calling_days', 'default_timezone',
  'wrapup_seconds', 'wrapup_auto_return', 'retry_policy', 'disposition_catalog',
  'break_reasons',
  'context_display', 'record_calls', 'analysis_profile_id',
  // The abandonment ceiling is an operator setting, so it is
  // patchable on a live campaign. NOT nullable — the column is NOT NULL with
  // a DEFAULT, so "unset it" means "put it back to the default", which the
  // caller expresses by sending the default rather than by sending null.
  'abandonment_ceiling_pct',
  // The abandon announcement. Patchable, and `null` legitimately clears it back to
  // "hang up without an apology" — so this key must survive `v === undefined`
  // filtering in `update()`, which it does, and must not be defaulted anywhere.
  'abandon_announcement_id',
]);

/**
 * The patchable columns that are JSONB, which `update()` binds as `JSON.stringify`
 * text cast `::jsonb`.
 *
 * Every JSONB column in {@link CAMPAIGN_PATCHABLE_COLUMNS} must be here. A JS array
 * bound raw is serialised by node-pg as a Postgres ARRAY literal, which a jsonb
 * column refuses (`22P02`); `break_reasons` was missing, so every PATCH carrying a
 * non-empty list 500'd and an empty one (`{}`, a jsonb object) failed
 * `ck_agency_campaign_break_reasons`. Pinned on a real database by
 * `agency-campaign-update.test.ts`.
 */
const CAMPAIGN_JSONB_COLUMNS: ReadonlySet<string> = new Set([
  'retry_policy', 'disposition_catalog', 'context_display', 'break_reasons',
]);

export class AgencyCampaignRepository {
  async findById(id: string): Promise<AgencyCampaignRecord | null> {
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      'SELECT * FROM agency_campaigns WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  async create(input: {
    tenant_id: string; account_id: string; name: string; caller_ids: string[];
    telephony_provider?: string;
    calling_window_start?: string; calling_window_end?: string;
    calling_days?: number[]; default_timezone?: string;
    wrapup_seconds?: number; wrapup_auto_return?: boolean;
    retry_policy?: unknown; disposition_catalog?: unknown; context_display?: unknown;
    break_reasons?: unknown;
    record_calls?: boolean; analysis_profile_id?: string | null; created_by?: string | null;
    abandon_announcement_id?: string | null;
    abandonment_ceiling_pct?: number;
  }): Promise<AgencyCampaignRecord> {
    // ── Every placeholder inside a COALESCE must carry its column's type ───────
    //
    // A bare `$n` in `VALUES (...)` gets its type from the target column, which is
    // why `$1`/`$4`/`$6`/`$18`/`$20` need no help. A `$n` inside `COALESCE(...)`
    // does NOT: COALESCE resolves its own result type from its arguments alone,
    // and an untyped placeholder beside an untyped quoted literal makes both
    // `text`. Postgres then refuses to assign `text` to any column it has no
    // assignment cast to — which is exactly the 42804 that made campaign creation
    // fail outright in 1.73.1 on `calling_window_start`:
    //
    //   column "calling_window_start" is of type time without time zone
    //   but expression is of type text
    //
    // `calling_window_end` (TIME) and `calling_days` (SMALLINT[]) are the same
    // defect; the error only ever named the first column Postgres reached. The
    // other COALESCEd parameters are safe for a reason, not by luck: `$5`/`$10`
    // target VARCHAR (text→varchar is assignment-castable), `$11`/`$12`/`$17` sit
    // beside `30`/`true`/`false` which are already-typed literals that pull the
    // placeholder to integer/boolean, and `$13`–`$16` carry an explicit `::jsonb`
    // on the whole expression. `update()` is unaffected throughout: it writes
    // `col = $n`, so the column supplies the type.
    //
    // NOTE (drift): the defaults below duplicate the schema's column defaults,
    // and `CAMPAIGN_CONFIG_COLUMN_DEFAULTS` in `src/agency/campaign-config.ts`
    // duplicates them a third time. Omitting the NULL columns from the INSERT
    // entirely and letting the DB defaults apply would collapse this copy — a
    // worthwhile follow-up, deliberately not bundled into a production hotfix.
    // If you change a default here, change it in the schema too.
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `INSERT INTO agency_campaigns
         (${CAMPAIGN_INSERT_COLUMNS_SQL})
       VALUES ($1,$2,$3,$4,COALESCE($5,'voicelink'),
               COALESCE($6::time,'09:00'),COALESCE($7::time,'20:00'),COALESCE($8::smallint[],'{1,2,3,4,5}'),COALESCE($9,'UTC'),
               COALESCE($10,30),COALESCE($11,true),COALESCE($12,'{}')::jsonb,COALESCE($13,'[]')::jsonb,
               COALESCE($14,'{}')::jsonb,COALESCE($15,'[]')::jsonb,COALESCE($16,false),$17,$18,
               $19, $20)
       RETURNING *`,
      [
        input.tenant_id, input.account_id, input.name, input.caller_ids,
        input.telephony_provider ?? null,
        input.calling_window_start ?? null, input.calling_window_end ?? null,
        input.calling_days ?? null, input.default_timezone ?? null,
        input.wrapup_seconds ?? null, input.wrapup_auto_return ?? null,
        input.retry_policy ? JSON.stringify(input.retry_policy) : null,
        input.disposition_catalog ? JSON.stringify(input.disposition_catalog) : null,
        input.context_display ? JSON.stringify(input.context_display) : null,
        input.break_reasons ? JSON.stringify(input.break_reasons) : null,
        input.record_calls ?? null, input.analysis_profile_id ?? null, input.created_by ?? null,
        input.abandon_announcement_id ?? null,
        // NOT a SQL COALESCE to a literal, unlike its neighbours above: the
        // column's DEFAULT and this fallback are the SAME constant, so the
        // default is applied from the one exported value rather than restated as
        // a third copy in SQL. `?? `, not `||`, so an explicit 0 would still
        // reach the CHECK and be refused rather than silently become 3.
        input.abandonment_ceiling_pct ?? DEFAULT_ABANDONMENT_CEILING_PCT,
      ],
    );
    return rows[0]!;
  }

  /** What a retry selector would seed, without seeding it; see {@link previewRetry}. */
  async retryPreview(...args: Parameters<typeof previewRetry>): ReturnType<typeof previewRetry> {
    return previewRetry(...args);
  }

  /** Create a retry campaign and seed its roster, all or nothing; see {@link createRetryCampaign}. */
  async retryFromCampaign(
    input: Parameters<typeof createRetryCampaign>[1],
  ): ReturnType<typeof createRetryCampaign> {
    return createRetryCampaign(this, input);
  }

  /**
   * The campaign a spent retry idempotency key already created, if any.
   *
   * Scoped to tenant AND account, matching the index's scope.
   * Both halves matter and for different reasons: a key from another tenant is a
   * different intent that happens to collide, and a key from a sibling ACCOUNT is
   * a different customer's desk — answering it with this row would hand that
   * account's caller IDs, name and selector to a caller who may not read them,
   * and would refuse them a retry of their own. The caller passes the PARENT's
   * tenant and account, and the parent reached this call through `requireOwned`,
   * so those are the authenticated caller's own scope rather than a hint.
   */
  async findByRetryIdempotencyKey(
    tenantId: string,
    accountId: string,
    key: string,
  ): Promise<AgencyCampaignRecord | null> {
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `SELECT * FROM agency_campaigns
        WHERE tenant_id = $1 AND account_id = $2 AND retry_idempotency_key = $3`,
      [tenantId, accountId, key],
    );
    return rows[0] ?? null;
  }

  /**
   * Every pass of one campaign — `GET /agency-campaigns/:id/lineage`.
   *
   * ── `COALESCE(root_campaign_id, id)`, on BOTH sides ───────────────────────
   *
   * `root_campaign_id` is deliberately left NULL on a generation-0
   * campaign (stamping it would need a trigger on `agency_campaigns` or a backfill
   * that restamps `updated_at` on every row, and unlike the contacts case this
   * read is not on the dial hot path). So the chain head is
   * `COALESCE(root_campaign_id, id)` — for the campaign the caller named AND for
   * every candidate row — and spelling it only on one side silently returns a
   * chain of one for every parent.
   *
   * ── A campaign in no chain answers with ITSELF, not a 404 ─────────────────
   *
   * `COALESCE(root, id) = own id` matches the row itself, so the ordinary case
   * falls out of the same query with no branch. The supervisor's header renders
   * this strip unconditionally; a 404 would make the console branch on a
   * distinction the payload already carries in its length.
   *
   * Tenant- and account-scoped like every other campaign read, and the scoping is
   * what bounds the scan: there is no index on `root_campaign_id` (an account holds campaigns in the hundreds and an expression
   * comparison would not use one anyway).
   */
  async campaignLineage(
    tenantId: string,
    accountId: string,
    campaignId: string,
  ): Promise<AgencyCampaignLineage | null> {
    const { rows } = await getPool().query<{
      id: string;
      name: string;
      status: AgencyCampaignRecord['status'];
      retry_generation: number;
      parent_campaign_id: string | null;
      contacts_total: number;
      created_at: Date;
      started_at: Date | null;
      ended_at: Date | null;
      root_campaign_id: string;
    }>(
      `WITH anchor AS (
         SELECT COALESCE(root_campaign_id, id) AS root
           FROM agency_campaigns
          WHERE id = $1 AND tenant_id = $2 AND account_id = $3
       )
       SELECT c.id, c.name, c.status, c.retry_generation, c.parent_campaign_id,
              c.contacts_total, c.created_at, c.started_at, c.ended_at,
              a.root AS root_campaign_id
         FROM agency_campaigns c, anchor a
        WHERE COALESCE(c.root_campaign_id, c.id) = a.root
          AND c.tenant_id = $2 AND c.account_id = $3
        ORDER BY c.retry_generation, c.created_at`,
      [campaignId, tenantId, accountId],
    );

    // Empty means the anchor matched nothing — the campaign was deleted between
    // the route's ownership check and this read. It cannot mean "a campaign with
    // no chain", because such a campaign is its own chain of one.
    const root = rows[0]?.root_campaign_id;
    if (!root) return null;

    return {
      root_campaign_id: root,
      campaigns: rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        retry_generation: row.retry_generation,
        parent_campaign_id: row.parent_campaign_id,
        contacts_total: row.contacts_total,
        created_at: iso(row.created_at) ?? '',
        started_at: iso(row.started_at),
        ended_at: iso(row.ended_at),
      })),
    };
  }

  /**
   * One page of the account's campaigns, newest first, with the matching total.
   *
   * `statuses` narrows both the page and the total. The console uses it to read
   * every started-and-not-finished campaign however old it is, while the rest of
   * the history stays a page at a time. Omitted (or empty) is every status.
   */
  async list(
    tenantId: string,
    accountId: string,
    limit: number,
    offset: number,
    statuses?: readonly string[],
  ): Promise<{ rows: AgencyCampaignRecord[]; total: number }> {
    const pool = getPool();
    const only = statuses && statuses.length > 0 ? [...statuses] : null;
    const [list, count] = await Promise.all([
      pool.query<AgencyCampaignRecord>(
        `SELECT * FROM agency_campaigns WHERE tenant_id = $1 AND account_id = $2
          AND ($5::text[] IS NULL OR status = ANY($5::text[]))
          ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [tenantId, accountId, limit, offset, only],
      ),
      pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM agency_campaigns WHERE tenant_id = $1 AND account_id = $2
          AND ($3::text[] IS NULL OR status = ANY($3::text[]))`,
        [tenantId, accountId, only],
      ),
    ]);
    return { rows: list.rows, total: Number(count.rows[0]?.n ?? 0) };
  }

  /**
   * The campaigns a soft-phone call may be logged to (docs/softphone.md §6, bootstrap):
   * the account's campaigns in `statuses`, and — with `staffedUserId` — only those the
   * user is actively staffed on, newest first, at most `limit`. The staffing filter is
   * IN the statement, before the cap, so an agent's campaigns are never cut by the
   * account's newer ones (`uq_agency_campaign_agent_active_campaign` serves the probe).
   */
  async listSoftphoneTaggable(
    tenantId: string,
    accountId: string,
    opts: { statuses: readonly string[]; staffedUserId: string | null; limit: number },
  ): Promise<AgencyCampaignRecord[]> {
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `SELECT c.* FROM agency_campaigns c
        WHERE c.tenant_id = $1::uuid AND c.account_id = $2::uuid
          AND c.status = ANY($3::text[])
          AND ($4::uuid IS NULL OR EXISTS (
                SELECT 1 FROM agency_campaign_agents a
                 WHERE a.tenant_id = $1::uuid AND a.user_id = $4::uuid
                   AND a.campaign_id = c.id AND a.unassigned_at IS NULL))
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $5`,
      [tenantId, accountId, [...opts.statuses], opts.staffedUserId, opts.limit],
    );
    return rows;
  }

  /**
   * Patch mutable configuration. Deliberately cannot write `status` — lifecycle is
   * {@link transitionStatus} only, so a config edit can never race the pacing
   * leader's `running → completed` / `stopping → stopped` transitions.
   */
  async update(id: string, patch: Record<string, unknown>): Promise<AgencyCampaignRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      if (!CAMPAIGN_PATCHABLE_COLUMNS.has(k) || v === undefined) continue;
      const json = CAMPAIGN_JSONB_COLUMNS.has(k);
      values.push(json ? JSON.stringify(v) : v);
      sets.push(`${k} = $${values.length}${json ? '::jsonb' : ''}`);
    }
    if (sets.length === 0) return this.findById(id);
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `UPDATE agency_campaigns SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  /** Supervisor dashboard payload; see {@link campaignStats}. */
  async stats(...args: Parameters<typeof campaignStats>): ReturnType<typeof campaignStats> {
    return campaignStats(...args);
  }

  /** The campaign's trend line; see {@link campaignStatsSeries}. */
  async statsSeries(...args: Parameters<typeof campaignStatsSeries>): ReturnType<typeof campaignStatsSeries> {
    return campaignStatsSeries(...args);
  }

  /** Campaigns the pacing supervisor should be leading. */
  async findActive(): Promise<AgencyCampaignRecord[]> {
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      "SELECT * FROM agency_campaigns WHERE status IN ('running','stopping') ORDER BY started_at",
    );
    return rows;
  }

  /**
   * Move a campaign to a new status. Returns the updated row, or null when the
   * `from` guard did not match — which is how the pacing leader's exclusive claim
   * on `running → completed` / `stopping → stopped` is enforced (exactly one
   * writer, no race with the supervisor's controls).
   *
   * ── The lifecycle stamps are DERIVED FROM `to`, not passed in ─
   *
   * `started_at` and `ended_at`/`completed_at` are not a `patch` the caller
   * assembles. Were the routes to pass `{ started_at: new Date() }` on `/resume`
   * as well as `/start` with `COALESCE($n, started_at)` — new value FIRST — every
   * resume would overwrite the original: a campaign that began at 09:00, paused
   * for lunch and resumed at 14:05 would report 14:05, and any elapsed-time
   * reading of it would be short by the morning.
   *
   * Both are computed here from the TARGET STATUS. That is not tidying: it
   * moves the invariant from "what four call sites remember to pass" to a property
   * of the single statement that moves a status, so a fifth transition route
   * cannot reintroduce the bug by forgetting a parameter — there is no parameter
   * to forget.
   *
   *   * `started_at` — FIRST-WRITE-WINS (`COALESCE(started_at, now())`), and only
   *     on the way INTO `running`. A resume finds a value and keeps it.
   *   * `ended_at` — first-write-wins on the way into a terminal status. Terminal
   *     is absorbing (no `from` list anywhere names `completed`/`stopped`), so the
   *     COALESCE is belt-and-braces rather than load-bearing; it costs nothing and
   *     it means a future re-open cannot silently restamp an end that happened.
   *   * `completed_at` — the LEGACY spelling of `ended_at`, written from the SAME
   *     `CASE` so the two cannot drift. It is retained because it is already
   *     on the wire, and its name is wrong for a `stopped` campaign.
   *
   * `now()` rather than a JS `Date`: it is the statement timestamp, so these
   * stamps and `updated_at` are the same instant by construction instead of two
   * clocks that agree approximately.
   *
   * ── `last_transition_by_*` is written UNCONDITIONALLY ───────────────────────
   *
   * Same rule as the pause metadata below, and for the same reason: the columns
   * answer "who caused the CURRENT status", so every transition has an opinion
   * about them and "leave whatever was there" is wrong for all of them. An
   * absent `patch.last_transition_by` therefore writes NULL — which is what makes
   * `running → completed` CLEAR the supervisor who started the campaign, rather
   * than leaving them attributed to a completion the list's exhaustion caused.
   *
   * The ONE exception is `stopping → stopped`, which INHERITS the actor already on
   * the row: `stopped` is reachable only from `stopping`, and `stopping` only from
   * an operator pressing Stop, so the cause of a stopped campaign is that
   * operator. The inline comment on the CASE has the full argument.
   */
  async transitionStatus(
    id: string,
    from: readonly string[],
    to: string,
    patch: { last_transition_by?: AgencyCampaignActor | null } = {},
  ): Promise<AgencyCampaignRecord | null> {
    // Pause metadata is written UNCONDITIONALLY, never COALESCE'd, because every
    // transition has an opinion about it and "leave whatever was there" is wrong
    // for all of them. A resume that preserved `pause_reason`
    // would leave a running campaign claiming to be paused for a breach, and the
    // health strip's top-priority diagnosis reads exactly that field. Moving to
    // `paused` is a supervisor action by construction — the guardrail's own
    // pause goes through `pauseForAbandonment`, not here — so this is the one
    // place `'supervisor'` is written, and every other target clears the lot.
    const pausing = to === 'paused';
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `UPDATE agency_campaigns
          -- The cast on the assignment is LOAD-BEARING, not decoration.
          -- $3 is used twice over: as the value assigned to status (VARCHAR(20) in
          -- the baseline schema, so Postgres deduces character varying) and in the five untyped
          -- literal comparisons below, which deduce text. Without the cast the two
          -- deductions collide and the statement does not PARSE --
          -- 42P08 inconsistent types deduced for parameter $3, raised before any row
          -- is touched, i.e. every lifecycle route 500s and maybeFinalize throws on
          -- every tick. Casting the COMPARISONS to ::text instead does NOT work: it
          -- pins the parameter to text and the assignment becomes the conflicting side.
          SET status = $3::varchar,
              started_at = CASE WHEN $3 = 'running'
                                THEN COALESCE(started_at, now())
                                ELSE started_at END,
              ended_at = CASE WHEN $3 IN ('completed','stopped')
                              THEN COALESCE(ended_at, now())
                              ELSE ended_at END,
              -- The legacy spelling, from the SAME condition rather than a second
              -- one — two CASEs is how the pair comes to disagree on a status
              -- someone adds to one list and not the other.
              completed_at = CASE WHEN $3 IN ('completed','stopped')
                                  THEN COALESCE(completed_at, now())
                                  ELSE completed_at END,
              -- Written UNCONDITIONALLY -- except for the ONE transition whose
              -- cause is on the row already.
              --
              -- stopping -> stopped is performed by the pacing leader, so it has
              -- no HTTP actor and the unconditional write would store NULL. But
              -- stopped is reachable ONLY from stopping, and stopping is
              -- reachable only from an operator pressing Stop -- so the cause of a
              -- stopped campaign IS whoever set it stopping, and that actor is
              -- sitting in these very columns. Clearing it would lose the single
              -- most useful attribution on this payload ("who stopped this
              -- campaign") to a bookkeeping transition, and it would report the
              -- stop as automatic, which is exactly what NULL is documented to
              -- deny.
              --
              -- running -> completed is the opposite case and correctly clears:
              -- nobody completed the campaign, the list ran out.
              --
              -- Expressed here rather than by having the leader read the row and
              -- re-pass the actor, for the same reason the timestamps above are
              -- derived from $3: the whole lifecycle-stamp policy stays in the
              -- one statement that moves a status, so no call site can get it
              -- wrong by omission. An actor passed FOR stopped is therefore
              -- ignored; there is no caller that can supply one.
              last_transition_by_user_id = CASE WHEN $3 = 'stopped'
                                                THEN last_transition_by_user_id
                                                ELSE $4 END,
              last_transition_by_name = CASE WHEN $3 = 'stopped'
                                             THEN last_transition_by_name
                                             ELSE $5 END,
              pause_reason = $6,
              paused_at = $7,
              pause_abandonment_rate_pct = NULL,
              updated_at = now()
        WHERE id = $1 AND status = ANY($2::varchar[])
      RETURNING *`,
      [
        id, from, to,
        patch.last_transition_by?.user_id ?? null,
        patch.last_transition_by?.name ?? null,
        pausing ? 'supervisor' : null,
        pausing ? new Date() : null,
      ],
    );
    return rows[0] ?? null;
  }

  /** The SQL half of the dashboard's health strip; see {@link campaignHealthInputs}. */
  async healthInputs(...args: Parameters<typeof campaignHealthInputs>): ReturnType<typeof campaignHealthInputs> {
    return campaignHealthInputs(...args);
  }

  /**
   * Pause a campaign because its rolling rate crossed its ceiling.
   *
   * **A conditional claim, not a read-then-write.** The abandonment refresh is a
   * per-replica `setInterval`, so every replica evaluates the same breach in the
   * same window and would otherwise each pause it, each write an audit row and
   * each raise an alert for one event. `status = 'running'` in the WHERE makes
   * exactly one of them win; the losers get zero rows and stay silent. Same idiom
   * as `transitionStatus` and `claimTerminal`.
   *
   * It also means a campaign a supervisor paused a millisecond earlier is not
   * re-paused with a different reason, and a `stopping`/`completed` campaign is
   * never dragged back to `paused`.
   *
   * `measuredPct` is stored rather than re-read later — see the column comment.
   */
  async pauseForAbandonment(
    campaignId: string,
    measuredPct: number,
  ): Promise<AgencyCampaignRecord | null> {
    const { rows } = await getPool().query<AgencyCampaignRecord>(
      `UPDATE agency_campaigns
          SET status = 'paused',
              pause_reason = 'abandonment_ceiling',
              paused_at = now(),
              pause_abandonment_rate_pct = $2,
              -- CLEARED, not left alone. This is the one
              -- transition with no human behind it at all, so
              -- last_transition_by must read null — "we do not know who", the
              -- documented meaning. Preserving whatever was there would leave the
              -- supervisor who STARTED the campaign attributed to a pause the
              -- guardrail imposed on them, which is worse than an absent actor:
              -- it is a confident wrong answer on the row a console renders
              -- beside "paused: abandonment ceiling breached". Same reason
              -- transitionStatus writes the pair unconditionally.
              last_transition_by_user_id = NULL,
              last_transition_by_name = NULL,
              updated_at = now()
        WHERE id = $1 AND status = 'running'
      RETURNING *`,
      [campaignId, measuredPct],
    );
    return rows[0] ?? null;
  }

  /**
   * A campaign is complete when nothing is outstanding — no pending contact, none
   * in flight, none connected-but-undispositioned. Note this is genuinely
   * different from "list exhausted": `next_attempt_at` can be hours out, so the
   * supervisor dashboard shows *contacts remaining* and *retries pending*
   * separately.
   */
  async countOutstanding(campaignId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agency_contacts
        WHERE campaign_id = $1 AND state IN ('pending','in_flight','connected')`,
      [campaignId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * The roster gate's two numbers, in one round trip (`total`, and how much of it
   * is still dialable).
   *
   * **Both are needed, because they are different operator problems.** A campaign
   * with `total = 0` was never populated and the fix is to upload a roster; a
   * campaign with `total > 0` and `dialable = 0` has been run to the end and the fix
   * is a fresh list. Reporting only "no contacts" for both sends the second operator
   * looking for an upload that already succeeded.
   *
   * `dialable` matches {@link countOutstanding}'s predicate rather than
   * `claimDialable`'s: a contact whose `next_attempt_at` is hours out is scheduled
   * work, not exhausted work, and refusing to start a campaign that is entirely in
   * retry backoff would be wrong.
   */
  async rosterCounts(campaignId: string): Promise<{ total: number; dialable: number }> {
    const { rows } = await getPool().query<{ total: string; dialable: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE state IN ('pending','in_flight','connected'))::text AS dialable
         FROM agency_contacts WHERE campaign_id = $1`,
      [campaignId],
    );
    return { total: Number(rows[0]?.total ?? 0), dialable: Number(rows[0]?.dialable ?? 0) };
  }

  /**
   * Campaigns that would break if this analysis profile stopped being usable —
   * the read half of the reference check that lets a live campaign veto removing
   * the profile it depends on.
   *
   * `agency_campaigns.analysis_profile_id` is **live configuration**: the pacing
   * engine passes it into `createBridgedCall` on every dial, which stamps it onto
   * that leg, and the end-of-call gate then resolves it with the UNSCOPED
   * `callAnalysisProfileRepository.findById`. So a profile deactivated under a
   * live campaign does not fail loudly — it keeps being resolved, and the
   * campaign goes on analysing against a definition its operator believes is
   * retired. That is the failure this predicate exists to refuse, and it is why
   * the check cannot live on the read side instead: by the time that gate runs,
   * "gone" and "retired but still resolvable" look nothing alike.
   *
   * Contrast `agency_calls.analysis_profile_id`, which carries no dependency worth
   * guarding. Note the reason carefully, because the column's own comment in the
   * baseline gets it wrong: that column IS re-read at run time —
   * `bridge-analysis-hooks.ts` resolves a profile from it at end of call. What makes it safe is that it is read exactly once, minutes after
   * intake, through the UNSCOPED `findById`, which ignores `is_active` — so a
   * concurrent retire cannot break it. The call snapshots the pre-edit version,
   * which is precisely what provenance wants.
   *
   * So the load-bearing fact is `findById`'s indifference to `is_active`, not
   * "never re-read". Anyone tightening `findById` to `is_active = true` — an
   * obvious-looking hardening — breaks BOTH referrers at once, and would be
   * reassured by the wrong version of this sentence.
   *
   * Scoped to the profile's own tenant/account on purpose. Both writers of the
   * column preflight ownership (`preflightAnalysisProfile`), so a cross-tenant
   * reference should not exist — and if one ever did, naming another tenant's
   * campaign in a refusal body would be a worse bug than the one being reported.
   *
   * **No foreign key, and this is not a stand-in for one.** The link is un-FK'd on
   * purpose — `analysis_profile_id` is declared `UUID` with no
   * `REFERENCES`, the posture taken for this whole
   * subsystem — so the check is advisory by construction: a campaign committed
   * between this read and the caller's write is invisible to it. A lock has been
   * proposed for it more than once in review, so the reasons not to take one are
   * recorded here rather than re-argued each time.
   *
   * *The cost.* Closing the window means every writer of
   * `agency_campaigns.analysis_profile_id` — the campaign POST and PATCH in
   * `agency-campaigns.routes.ts` today, and every future one — taking a row lock on
   * `call_analysis_profiles` inside its own write. That is the coupling the
   * un-FK'd link exists to avoid, bought back by hand and in the harder-to-see
   * direction: a campaign write blocking on a lock held by a profile edit.
   *
   * *The size.* The window is the gap from this read to the mutation committing —
   * one round trip for the `retire`/`edit` path, two when the caller also takes the
   * inheritance count (`agencyDependencyRejected` reads both before answering).
   *
   * *What losing it actually costs, per dependency class, because the two differ
   * and an earlier version of this paragraph flattened them:*
   *
   * - **A campaign that NAMES the profile** keeps measuring exactly what it was
   *   measuring. The pacing engine stamps `analysis_profile_id` onto each leg and
   *   the end-of-call gate resolves it with the UNSCOPED `findById`, which ignores
   *   `is_active`, so the retired row still resolves in full. Nothing is corrupted
   *   and nothing is silently emptied; the guard's value here is telling the
   *   operator, not preventing a loss.
   * - **A campaign created inside the window that names NOTHING** inherits the
   *   account default that is being retired, and there is now no active default to
   *   inherit: `findDefault` filters on `is_active`, so its snapshot collapses to
   *   `{ custom_dimensions: [] }` (see
   *   {@link countLiveCampaignsInheritingAccountDefault}). That is a real
   *   degradation, and it is not what the sentence above claims. What makes it
   *   still not worth a lock is that **no lock can buy the invariant**: creating an
   *   inheriting campaign in an account with no active default is permitted, and
   *   produces the identical empty snapshot with no race involved at all. The guard
   *   protects campaigns that already exist from having the rug pulled; it never
   *   promised every future campaign a resolvable definition, and serialising these
   *   two writes would not deliver one.
   *
   * So: advisory, and losing the race lands on the behaviour that shipped before
   * this guard existed rather than on corruption. If the inheriting hole is ever
   * worth closing, the instrument is an invariant on the campaign write ("an
   * inheriting campaign requires an active account default"), not a lock on a
   * profile row from an agency route.
   *
   * **Unbounded on purpose, and bounded where it escapes.** There is no `LIMIT`
   * here because both things the caller builds from these rows have to be complete
   * to be true: the count it reports, and the status breakdown it groups. A `LIMIT`
   * would make "40 agency campaigns (1 running, 39 draft)" read "20 agency
   * campaigns (1 running, 19 draft)" — a refusal that understates itself, which is
   * worse than a long list. The list that leaves the process IS capped, at the
   * route, with the true total beside it (`DEPENDENT_SAMPLE_LIMIT` in
   * `call-analysis-profiles.routes.ts`). What remains unbounded is one
   * `{uuid, status}` row per live campaign, held briefly, on a refusal path that
   * runs only when someone edits or retires a profile. If an account ever makes
   * that hurt, the fix is to aggregate the census in SQL — `COUNT(*)` plus a
   * `GROUP BY status` plus a capped id list — not to `LIMIT` this query and let the
   * count lie.
   */
  async findLiveDependentsOnAnalysisProfile(
    profileId: string,
    tenantId: string,
    accountId: string,
  ): Promise<AgencyCampaignDependent[]> {
    const { rows } = await getPool().query<AgencyCampaignDependent>(
      `SELECT id, status
         FROM agency_campaigns
        WHERE analysis_profile_id = $1
          AND tenant_id = $2
          AND account_id = $3
          AND NOT (status = ANY($4))
        ORDER BY created_at ASC`,
      [profileId, tenantId, accountId, [...AGENCY_CAMPAIGN_TERMINAL_STATUSES]],
    );
    return rows;
  }

  /**
   * Live campaigns that name NO profile, and therefore depend on whichever one is
   * the account default.
   *
   * ── Why this is a second, separate question ────────────────────────────────
   * `analysis_profile_id` on a campaign is OPT-IN — it has no
   * default, so `NULL` is the ordinary case. And the end-of-call gate resolves
   * `explicit id → account default → none` (`webrtc-bridge-manager.ts`). So a
   * campaign with a NULL reference is not a campaign with no dependency; it is a
   * campaign depending on the account default, which the predicate above cannot
   * see because there is no id in the row to match on.
   *
   * That hole was the worse half of the two. In the matched case the retired row
   * still resolves through the unscoped `findById`, so the campaign carries on
   * measuring the same things; here, retiring the default leaves `findDefault`
   * (active + `is_default`) with nothing to return and the snapshot collapses to
   * `{ custom_dimensions: [] }` — analysis continuing with no context and no
   * dimensions, silently. The guard was refusing the benign path and permitting
   * the destructive one.
   *
   * ── Loss is refused; CHANGE is not ────────────────────────────────────────
   * The rule here is deliberately weaker than the one above, and the difference is
   * what the campaign actually asked for. A campaign naming a version named THAT
   * version, so replacing it silently changes what it measures and is refused. A
   * campaign naming nothing asked for "whatever the account default is" — so a new
   * default, or an edit to the current one, is inside what it requested and is
   * allowed. Only an operation that leaves the account with NO active default is
   * refused, because that is the one outcome the campaign cannot have meant.
   *
   * Concretely: `DELETE` of the default is refused, and a `PUT` that sets
   * `is_default: false` on it is refused. A `PUT` that carries the flag forward is
   * not — the successor is active and default, so the inheritance still resolves.
   * Nor is `POST` with `is_default: true`, which demotes the old default while
   * leaving it active: that is the documented way to change defaults, and refusing
   * it would make a first agency campaign permanently freeze the account's default.
   *
   * A COUNT rather than rows: the caller needs to know that inheritors exist and
   * how many, and unlike the matched case there is no per-row remedy to point at.
   *
   * ── This count is where the advisory window actually bites ────────────────
   * Read the race note on {@link findLiveDependentsOnAnalysisProfile} with this
   * method in mind: a campaign naming a profile survives a lost race intact, but
   * one created inside the window naming NOTHING lands on an account with no
   * active default and analyses against `{ custom_dimensions: [] }`. Recorded here
   * too because a reader arriving at the destructive half should not have to find
   * the note on the benign one — and because the reason it is still not a lock is
   * specific to THIS class: the same empty snapshot is reachable with no race at
   * all, by creating an inheriting campaign in an account that has no default.
   */
  async countLiveCampaignsInheritingAccountDefault(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    const { rows } = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM agency_campaigns
        WHERE analysis_profile_id IS NULL
          AND tenant_id = $1
          AND account_id = $2
          AND NOT (status = ANY($3))`,
      [tenantId, accountId, [...AGENCY_CAMPAIGN_TERMINAL_STATUSES]],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * The name and status of every campaign in `ids` that this tenant AND account own:
   * `requireOwned`'s rule (`agency-campaigns.routes.ts`) applied to a set, in one
   * statement. An id that is unknown, owned by another account or tenant, or not
   * uuid-shaped is simply absent from the answer (never a `22P02`).
   *
   * Read through the internal `GET /agency-campaigns/summaries`, which the staffing
   * plugin's `my-*` routes use to label an agent's assignments in one round trip.
   */
  async findOwnedSummaries(
    ids: readonly string[],
    tenantId: string,
    accountId: string,
  ): Promise<Array<Pick<AgencyCampaignRecord, 'id' | 'name' | 'status'>>> {
    const candidates = [...new Set(ids)].filter((id) => UUID_RE.test(id));
    if (candidates.length === 0 || !UUID_RE.test(tenantId) || !UUID_RE.test(accountId)) return [];
    const { rows } = await getPool().query<Pick<AgencyCampaignRecord, 'id' | 'name' | 'status'>>(
      `SELECT id, name, status
         FROM agency_campaigns
        WHERE id = ANY($1::uuid[])
          AND tenant_id = $2::uuid
          AND account_id = $3::uuid`,
      [candidates, tenantId, accountId],
    );
    return rows;
  }
}

export const agencyCampaignRepository = new AgencyCampaignRepository();
