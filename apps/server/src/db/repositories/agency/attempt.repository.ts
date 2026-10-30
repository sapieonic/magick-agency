/** `AgencyAttemptRepository`: call attempts — the dial lifecycle, dispositions, the attempts spines and the reaper reads. */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
// The `23505` predicate, matched on the CONSTRAINT NAME. A leaf module (see its
// header) so the catch arms below can ask the question without dragging config
// into the graph of every test that exercises them.
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
import { createChildLogger } from '@magick-agency/observability';
import {
  AGENCY_ATTEMPT_LIVE_STATES,
  type AgencyCallAttemptRecord,
  type AgencyLapsedWrapupRow,
} from '../../models/agency.model.js';
// The supervisor read surface's cursor. `KEYSET_AT_SQL` is projected
// alongside every paged row so the cursor carries `created_at` at its true
// MICROSECOND precision — see that module for why a millisecond round-trip
// silently drops rows.
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type { AgencyAttemptFilters } from '../../../agency/spine-filters.js';
import { PRIOR_ATTEMPT_LIMIT } from '@magick-agency/domain/retry-campaign-bounds';
import type { AgentAttemptFilters } from '../../../agency/agent-record.js';
import type {
  AgencyAbandonReason,
  AgencyAttemptOutcome,
  AgencyAttemptState,
  AgencyAttemptRow,
  AgencyKeysetPage,
} from '@magick-agency/contracts/agency';
import { attemptFilterConditions, keysetCondition, params, toKeysetPage } from './query-builders.js';
import { projectAttemptRow } from './projections.js';

const log = createChildLogger({ component: 'agency-repository' });

/** `AGENCY_ATTEMPT_LIVE_STATES` as a SQL literal list — constants only, never input. */
const LIVE_ATTEMPT_STATES_SQL = AGENCY_ATTEMPT_LIVE_STATES.map((state) => `'${state}'`).join(', ');

/**
 * The attempt-row projection the three attempt reads serve (`listForCampaign`,
 * `findForCampaign`, `listForAgent`), in the order {@link projectAttemptRow} reads
 * it. `a` is the attempt, `c` the contact, `s` the session (LEFT-joined on the
 * campaign spine, INNER on the agent's).
 */
const ATTEMPT_ROW_SELECT_SQL = `a.id, a.campaign_id, a.contact_id, a.attempt_number, c.phone_e164, a.caller_id,
             s.agent_user_id, a.reserved_agent_id, a.state, a.outcome,
             a.disposition_code, a.notes, a.callback_at,
             a.dispositioned_by_user_id, a.dispositioned_at, a.dispositioned_on_behalf,
             a.webrtc_call_id, a.dialed_at, a.answered_at, a.bridged_at, a.ended_at,
             a.talk_seconds, a.wrapup_seconds, a.created_at`;

/**
 * The contact join of every attempt read. `c.campaign_id = a.campaign_id` is
 * redundant for correctness and load-bearing for the plan — see
 * {@link AgencyAttemptRepository.listForCampaign}: both phone indexes are keyed
 * `(campaign_id, <expr>)`.
 */
const ATTEMPT_CONTACT_JOIN_SQL = `JOIN agency_contacts c
          ON c.id = a.contact_id AND c.campaign_id = a.campaign_id`;

export class AgencyAttemptRepository {
  /**
   * Create the attempt row for a claimed contact.
   *
   * Returns null when a unique index refuses it. The caller must treat null as
   * "someone else has this contact" and move on, never as an error to retry.
   *
   * ── `attempt_number` is DERIVED HERE, and never supplied by the caller ───────
   * It comes from `MAX(attempt_number)` over this contact's own attempt rows,
   * computed inside the INSERT. **The caller cannot pass it** — that is the point,
   * not an inconvenience.
   *
   * It used to be `contact.attempt_count + 1`, and that made a reaper-recovered
   * contact **permanently undialable for the life of the campaign**. `attempt_count`
   * was doing two unrelated jobs — retry-budget accounting *and* unique-number
   * generation — and they diverge the moment an attempt row exists that was never
   * counted. The reaper requeues without bumping the count (correctly: see below),
   * so the orphaned row already held the number the next derivation produced,
   * `uq_agency_attempt_number` is total rather than partial and does not care the
   * prior attempt ended, and the insert failed 23505 on every tick forever.
   *
   * **What made it invisible is worth remembering.** The contact went back to
   * `pending`, so nothing was stranded, no error surfaced, and the campaign was not
   * wedged — it simply never finished. The only signal was this method's own
   * `log.warn` about the duplicate-dial backstop, which is *exactly what a
   * correctly working backstop logs*. An operator reading it concluded the system
   * was protecting them. The two cases are now logged distinctly (below).
   *
   * Deriving from the attempts table instead separates the two concerns for good:
   * `attempt_count` stays purely the retry budget, and the number sequence stays
   * unique per contact across all history, which the retry policy reads.
   * Two concurrent inserts can still both read the same MAX — but that is now a
   * genuine, self-correcting race caught by the index and retried on the next tick,
   * rather than a permanent wedge, and `uq_agency_attempt_live` already makes two
   * live attempts per contact impossible.
   */
  async create(input: {
    campaignId: string;
    contactId: string;
    tenantId: string;
    accountId: string;
    callerId: string;
    reservedAgentId: string;
  }): Promise<AgencyCallAttemptRecord | null> {
    try {
      const { rows } = await getPool().query<AgencyCallAttemptRecord>(
        `INSERT INTO agency_call_attempts
           (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, reserved_agent_id, state)
         SELECT $1, $2, $3, $4,
                COALESCE(MAX(attempt_number), 0) + 1,
                $5, $6, 'queued'
           FROM agency_call_attempts
          WHERE contact_id = $2
         RETURNING *`,
        [
          input.campaignId, input.contactId, input.tenantId, input.accountId,
          input.callerId, input.reservedAgentId,
        ],
      );
      return rows[0] ?? null;
    } catch (err) {
      // 23505 = unique_violation. Both indexes mean "move on", but they mean very
      // different things operationally and MUST NOT share a log line — that
      // conflation is what once hid the attempt-numbering wedge. A live-attempt refusal
      // is a correctness backstop doing its job and is expected under contention;
      // an attempt-number refusal is a lost race that should be vanishingly rare,
      // and a *steady stream* of them means numbers are colliding systematically.
      // Alert on the second, never on the first.
      if (isUniqueViolation(err)) {
        const constraint = (err as { constraint?: string }).constraint;
        if (isUniqueViolation(err, 'uq_agency_attempt_number')) {
          log.warn(
            { contactId: input.contactId, constraint },
            'Attempt-number collision — lost a concurrent insert race; retrying next tick',
          );
        } else {
          log.warn(
            { contactId: input.contactId, constraint },
            'Duplicate-dial backstop refused an attempt',
          );
        }
        return null;
      }
      throw err;
    }
  }

  async setState(
    id: string,
    state: AgencyAttemptState,
    patch: {
      webrtc_call_id?: string | null;
      outcome?: AgencyAttemptOutcome | null;
      dialed_at?: Date;
      answered_at?: Date;
      bridged_at?: Date;
      ended_at?: Date;
      talk_seconds?: number;
      /** The wrap-up window owed on this attempt. Duration, not a
       *  deadline: with `ended_at` it says what was owed and from when, which is
       *  what lets the `no_disposition` sweep finish a wrap-up whose in-process
       *  timer died with its process. */
      wrapup_seconds?: number;
      /** When wrap-up actually began. Stamped by `WrapupManager`, deliberately never
       *  inferred from `ended_at` — two writers that agree today are still two
       *  writers. */
      wrapup_started_at?: Date;
      /** When wrap-up actually ended. */
      wrapup_ended_at?: Date;
      /** How it ended — a `WrapupResolution`. The column CHECKs the values, and
       *  `stats()`'s `avg_wrapup_seconds` averages only the ones that measure the
       *  work rather than an interruption. */
      wrapup_resolution?: string;
      /**
       * WHY this attempt reached no agent. Diagnosis only — the
       * compliance numerator keys on `ABANDONED_ATTEMPT_PREDICATE_SQL`, never on
       * this column, and NULL means "not an abandoned attempt" rather than
       * "cause unknown".
       */
      abandon_reason?: AgencyAbandonReason | null;
      /**
       * Advance `state` **only** if the row is currently one of these.
       *
       * The timestamp patch still lands either way — that is the whole point.
       * `answered` and `bridged` are emitted back-to-back by the bridge and their
       * handlers run concurrently (lifecycle listeners are invoked fire-and-forget),
       * so the two UPDATEs race and the loser wins the `state` column: a live,
       * bridged conversation could sit in the row as `answered` forever. Guarding
       * the whole statement instead would drop `answered_at` on that path, and
       * `answered_at` is the abandonment predicate's only input.
       *
       * Omit for an unconditional write — every caller that owns the transition
       * outright (dialing, ended, the sweeps) should.
       */
      only_from?: AgencyAttemptState[];
    } = {},
  ): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET state = CASE
                        WHEN $11::text[] IS NULL OR state = ANY($11::text[]) THEN $2
                        ELSE state
                      END,
              webrtc_call_id = COALESCE($3, webrtc_call_id),
              outcome = COALESCE($4, outcome),
              dialed_at = COALESCE($5, dialed_at),
              answered_at = COALESCE($6, answered_at),
              bridged_at = COALESCE($7, bridged_at),
              ended_at = COALESCE($8, ended_at),
              talk_seconds = COALESCE($9, talk_seconds),
              wrapup_seconds = COALESCE($10, wrapup_seconds),
              wrapup_started_at = COALESCE($12, wrapup_started_at),
              wrapup_ended_at = COALESCE($13, wrapup_ended_at),
              wrapup_resolution = COALESCE($14, wrapup_resolution),
              abandon_reason = COALESCE($15, abandon_reason),
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [
        id, state, patch.webrtc_call_id ?? null, patch.outcome ?? null,
        patch.dialed_at ?? null, patch.answered_at ?? null, patch.bridged_at ?? null,
        patch.ended_at ?? null, patch.talk_seconds ?? null,
        patch.wrapup_seconds ?? null,
        patch.only_from ?? null,
        // Appended rather than slotted in beside the other timestamps: `$11` is
        // read as `$11::text[]` in the CASE above, so renumbering to keep the
        // parameters tidy would silently rebind the state guard.
        patch.wrapup_started_at ?? null,
        patch.wrapup_ended_at ?? null,
        patch.wrapup_resolution ?? null,
        patch.abandon_reason ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * Record the media leg's id WITHOUT touching `state`.
   *
   * Separate from {@link setState} on purpose. The call id only exists once
   * `createBridgedCall` resolves, and by then the carrier may already have
   * answered — `onBridgeLifecycle` writes `bridged` from inside the dial. A
   * combined write would put `dialing` back over it and the row would read
   * `dialing` for the whole of a live conversation.
   *
   * A guarded "only if not already advanced" update would also close it, but this
   * removes the race rather than narrowing it: there is no state to lose, so no
   * ordering to get wrong. The attempt is already `dialing` from before the dial;
   * this write only ever had the id to contribute.
   */
  async attachWebrtcCall(attemptId: string, webrtcCallId: string): Promise<void> {
    await getPool().query(
      'UPDATE agency_call_attempts SET webrtc_call_id = $2, updated_at = now() WHERE id = $1',
      [attemptId, webrtcCallId],
    );
  }

  async findById(id: string): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      'SELECT * FROM agency_call_attempts WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Record a disposition, idempotently on the code.
   *
   * **One guarded statement, and that is the whole design.** The predicate
   * `disposition_code IS NULL OR disposition_code = $2` makes first-write and
   * same-code replay the same successful path, and a different code a no-op that
   * writes nothing — atomically, so two submissions racing cannot interleave a
   * read with a write and let the second quietly overwrite the first. A
   * read-then-write in the route would look identical in every test and lose a
   * conversation record under a double-click.
   *
   * `null` therefore means one of exactly two things — no such attempt, or a
   * *different* code is already recorded — which the caller separates with a
   * follow-up read. That extra read only happens on the refusal path, so the
   * common case stays a single round trip.
   *
   * `notes` and `callback_at` are last-write-wins on a replay rather than
   * COALESCEd: an agent correcting their own note has to be able to shorten or
   * clear it, and COALESCE would make an empty string un-writable.
   */
  async recordDisposition(input: {
    attemptId: string;
    dispositionCode: string;
    notes: string | null;
    callbackAt: Date | null;
    actorUserId: string;
    onBehalf: boolean;
  },
  /**
   * Run on the caller's client (decision B8) so the DNC route's optional disposition
   * commits or rolls back with its `dnc_entries` row. Omitted: the pool.
   */
  deps: { client?: Pick<PoolClient, 'query'> } = {},
  ): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET disposition_code = $2,
              notes = COALESCE($3, notes),
              callback_at = $4,
              dispositioned_by_user_id = $5,
              dispositioned_on_behalf = $6,
              dispositioned_at = now(),
              updated_at = now()
        WHERE id = $1
          AND (disposition_code IS NULL OR disposition_code = $2)
      RETURNING *`,
      [
        input.attemptId, input.dispositionCode, input.notes,
        input.callbackAt, input.actorUserId, input.onBehalf,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * Save notes without dispositioning. Last write wins; `''` clears.
   *
   * Deliberately separate from {@link recordDisposition} because the two happen
   * at different times: agents type while the customer is still talking, and a
   * call that ends before they pick a code must not discard what they wrote.
   */
  async saveNotes(attemptId: string, notes: string): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      'UPDATE agency_call_attempts SET notes = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [attemptId, notes],
    );
    return rows[0] ?? null;
  }

  /**
   * ALL non-terminal attempts, not just pre-answer ones. A bridged call still
   * holds an account concurrency slot, so excluding `answered`/`bridged` would
   * make the tick reserve agents and claim contacts only to be refused by the
   * guard, every tick, forever, whenever agents outnumber the account limit.
   */
  async countLive(campaignId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended'",
      [campaignId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Live calls on the WHOLE ACCOUNT: the non-terminal attempts of every campaign
   * of `(tenantId, accountId)` plus the account's live soft-phone calls
   * (`agency_manual_calls`, `state <> 'ended'`). Pacing headroom subtracts this from
   * the account's concurrency (docs/softphone.md §4.1): a manual call holds a
   * carrier slot exactly like a campaign call, and it belongs to no campaign, so no
   * per-campaign count can see it. {@link countLive} stays per campaign.
   *
   * "Live" as {@link countLive} means it (every non-terminal state, bridged
   * included). The attempt half spells the live states as a literal `IN` list, the
   * predicate of `idx_agency_attempts_live`, so the planner can prove the partial
   * index applies (a bound array parameter cannot be); the campaign set is the
   * account's campaigns. The manual half is served by `idx_agency_manual_calls_live`.
   *
   * An awaiting-outcome manual call (ended, unsettled) holds no slot and is not
   * counted.
   */
  async countLiveForAccount(tenantId: string, accountId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM agency_call_attempts a
           WHERE a.state IN (${LIVE_ATTEMPT_STATES_SQL})
             AND a.campaign_id IN (SELECT c.id FROM agency_campaigns c
                                    WHERE c.tenant_id = $1::uuid AND c.account_id = $2::uuid))
         +
         (SELECT COUNT(*) FROM agency_manual_calls m
           WHERE m.account_id = $2::uuid AND m.tenant_id = $1::uuid AND m.state <> 'ended')
       )::text AS n`,
      [tenantId, accountId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * One campaign's attempts, newest first, keyset-paginated — the supervisor
   * read of the audit spine.
   *
   * ── What this must NOT be ───────────────────────────────────────────────────
   * A list of CALLS (`agency_calls`) cannot answer the question this route exists
   * for: being a CALL list, it structurally cannot show an attempt that never produced a call
   * — a `queued` attempt the reaper ended as `orphaned`, an `abandoned` one that
   * rang and found no agent, a `failed` dial. Those are precisely the rows a
   * compliance question is about.
   *
   * So the FROM clause is `agency_call_attempts`, and `agency_calls` is not
   * joined at all — not even to enrich. `webrtc_call_id` is emitted as an id for
   * the client to resolve separately, because it is deliberately
   * un-FK'd so the attempt row outlives a purged call, and any join to that table
   * would silently drop exactly the attempts whose history was purged.
   *
   * ── The agent join is LEFT, and that is not defensive ────────────────────────
   * `reserved_agent_id` is NULL on every attempt that failed before an agent was
   * on it, and `agency_agent_sessions` rows are per-shift. An inner join here
   * drops every never-reserved attempt — which is the "naive join drops the rows
   * you came for" trap in one line of SQL.
   *
   * The contact join is inner, and can be: `contact_id` is `NOT NULL REFERENCES
   * agency_contacts(id) ON DELETE CASCADE`, so an attempt without a contact row
   * cannot exist.
   *
   * ── The join carries `c.campaign_id = a.campaign_id`, and that is a PLAN fix ─
   * It is redundant for correctness — an attempt's contact is always on the
   * attempt's own campaign. It is load-bearing for the phone filter: both phone
   * indexes on `agency_contacts` are keyed `(campaign_id, <expr>)`, so without
   * it the leading column is unbound and neither can be used. A `?phone=`
   * filter then fell back to a **parallel sequential scan of the tenant's
   * contacts** — measured 153ms (exact) and 181ms (suffix) on 400k rows,
   * against 0.29ms with the predicate present. That is the sequential-scan shape
   * the reporting indexes exist to remove, reappearing on this route. Do not "simplify" it away.
   *
   * ── Plan ────────────────────────────────────────────────────────────────────
   * Driven by `idx_agency_attempts_keyset (campaign_id, created_at DESC,
   * id DESC)`. Every filter here is a predicate applied to rows
   * that index has already produced in order, so the `LIMIT` stops the scan
   * early instead of sorting the campaign.
   *
   * ⚠️ The `id` column is what makes it a keyset index. An index on
   * `(campaign_id, created_at DESC)` alone (the baseline's
   * `idx_agency_attempts_reporting`, dropped in migration 0003 as a strict prefix
   * of this one) cannot serve the row-wise `(created_at, id) < ($1, $2)`
   * comparison: Postgres degrades to reading the whole `created_at` tie group and
   * sorting it, on every page. Ties here are the normal case, because the attempt
   * batcher and roster ingest both insert inside one transaction where `now()` is
   * fixed.
   */
  async listForCampaign(input: {
    campaignId: string;
    filters: AgencyAttemptFilters;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyAttemptRow>> {
    const bind = params();
    const conditions = [`a.campaign_id = ${bind.add(input.campaignId)}`];
    const f = input.filters;

    // Through the session, because the attempt row holds a SESSION id and a
    // session id is meaningless to the person reading this page.
    //
    // ── Written as a subquery on `reserved_agent_id`, NOT as `s.agent_user_id
    //    = $n` on the LEFT-joined side ────────────────────────────────────────
    // Both are correct; they plan very differently. Filtering on the joined
    // column makes the agent's identity a join condition, and the planner
    // materialises the whole session table per outer row — measured 6.3ms
    // against 3.7ms for this form on a 1M-attempt campaign, and 590ms against
    // 343ms in the no-match case below.
    //
    // The filter is campaign-scoped as well as agent-scoped so that an agent
    // who has worked several campaigns matches only their sessions on THIS one.
    // Sessions are per-shift, so this is a handful of ids.
    conditions.push(...attemptFilterConditions(f, bind, () => (f.agentUserId
      ? `a.reserved_agent_id = ANY(ARRAY(
           SELECT id FROM agency_agent_sessions
            WHERE campaign_id = ${bind.add(input.campaignId)} AND agent_user_id = ${bind.add(f.agentUserId)}))`
      : null)));
    if (input.after) conditions.push(keysetCondition(input.after, 'a', bind));

    const sql = `
      SELECT ${ATTEMPT_ROW_SELECT_SQL},
             ${keysetAtSql('a.created_at')} AS cursor_at
        FROM agency_call_attempts a
        ${ATTEMPT_CONTACT_JOIN_SQL}
        LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${bind.add(input.limit + 1)}`;

    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      phone_e164: string; agent_user_id: string | null; cursor_at: string;
    }>(sql, bind.values);

    return toKeysetPage(rows, input.limit, projectAttemptRow);
  }

  /**
   * One attempt, campaign-scoped, in the same shape the list serves.
   *
   * Campaign-scoped rather than by id alone, so the campaign's own ownership check
   * is what authorises the read: the route has already proved the caller owns the
   * campaign, and passing the campaign id here means an attempt id from a
   * different campaign — or a different tenant — cannot be substituted in the
   * path. Returning null for that case makes it a 404, which is also the honest
   * answer (that attempt is not on this campaign).
   *
   * Reuses `projectAttemptRow` and the list's projection deliberately: a detail
   * view whose fields drift from the list it was opened from is how a reader comes
   * to distrust both.
   */
  async findForCampaign(campaignId: string, attemptId: string): Promise<AgencyAttemptRow | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      phone_e164: string; agent_user_id: string | null;
    }>(
      `SELECT ${ATTEMPT_ROW_SELECT_SQL}
         FROM agency_call_attempts a
         ${ATTEMPT_CONTACT_JOIN_SQL}
         LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
        WHERE a.id = $1 AND a.campaign_id = $2`,
      [attemptId, campaignId],
    );
    const row = rows[0];
    return row ? projectAttemptRow(row) : null;
  }

  /**
   * The agent-scoped attempt spine — one PERSON's dials, across every campaign.
   *
   * ── Why this cannot be a filter on `listForCampaign` ────────────────────────
   *
   * That method is campaign-scoped by construction: `campaign_id = $1` is its
   * first condition, its index is keyed on `campaign_id`, and its agent filter is
   * a subquery over the sessions of THAT campaign. An agent who works three
   * campaigns has three sessions and their record is spread across three of those
   * queries, which the caller would then have to merge and re-page by hand — and
   * a keyset cursor cannot be merged across result sets, because it names a
   * position in one ordering. Cross-campaign is a different read, so it is a
   * different method.
   *
   * ── The join is INNER on the session, which is the OPPOSITE of the campaign
   *    spine's LEFT — and both are right ───────────────────────────────────────
   *
   * There, LEFT is load-bearing: `reserved_agent_id` is NULL on every attempt
   * that failed before an agent was on it, and an inner join would drop exactly
   * those rows — the "naive join drops the rows you came for" trap. Here the
   * filter IS the agent, so an attempt with no reserved agent is not this
   * person's work by definition and the inner join is the predicate rather than
   * an accident of it. Note the consequence: this list can never show an attempt
   * that was never reserved, so it is not a substitute for the campaign spine
   * when the question is "what did we dial".
   *
   * ── The attempt points at a SESSION, not at a person ────────────────────────
   *
   * `reserved_agent_id` is an `agency_agent_sessions.id`, and
   * `agent_user_id` — the app's `users.id`, opaque to the dialer tables (no FK) —
   * lives on the session. Sessions are per shift, so one person's history is a set of session
   * ids that grows every day they work. That two-hop join is why an agent's own
   * record needs its own route rather than a query parameter.
   *
   * ── Plan, stated honestly ───────────────────────────────────────────────────
   *
   * The campaign spine is driven end-to-end by `idx_agency_attempts_keyset`
   * (campaign_id, created_at DESC, id DESC) — the ORDER BY comes free and the
   * LIMIT stops the scan. Nothing gives that here: the leading column of every
   * attempt index is either `campaign_id` or `reserved_agent_id`, and this query
   * filters on a SET of session ids and orders by `created_at`. So the planner
   * drives from the session join and sorts what it gathers.
   *
   * Not even `idx_agency_attempts_agent_dialed` — the index the
   * sibling `/stats` route exists on. It is partial (`WHERE dialed_at IS NOT
   * NULL`) and this query carries no predicate implying that, deliberately (see
   * the `created_at` bound below: an attempt that never dialled must still be
   * listed), so the planner cannot use it without dropping rows.
   *
   * That is accepted rather than indexed away, and the bound is what makes it
   * acceptable: the row set is one person's attempts, not a campaign's — a full
   * shift is hundreds of dials, a year is tens of thousands. The index that would
   * make this a single range scan is `(reserved_agent_id, created_at DESC, id
   * DESC)`, and it is deliberately NOT added: `agency_call_attempts` is written on
   * every dial, a fourth overlapping index taxes
   * that write path, and nobody has measured how deep anyone actually pages
   * this. Add it when a plan on production volume says so, not on this reasoning.
   */
  async listForAgent(input: {
    tenantId: string;
    accountId: string;
    agentUserId: string;
    filters: AgentAttemptFilters;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyAttemptRow>> {
    const bind = params();
    const f = input.filters;
    // The PATH's agent, never `filters.agentUserId`. The query parameter is part
    // of the imported filter vocabulary and is ignored here on purpose — see
    // `parseAgentAttemptFilters`.
    //
    // ── The tenant/account scope is NOT optional, and it is on the SESSION ────
    //
    // `agent_user_id` is the app's `users.id` and is opaque here: the dialer
    // tables cannot tell whose it is, cannot tell a real one from a guess, and
    // this read has no route by which the caller proves they own it. Every other read on this surface is
    // scoped by resolving a CAMPAIGN the caller owns first (`requireOwned`); this
    // one has no campaign in its path, so the scope has to be a predicate. Without
    // it, any authenticated tenant could read any other tenant's agent by
    // supplying their user id — the whole cross-campaign history, phone numbers
    // and dispositions included.
    //
    // Scoped on the session rather than on the attempt because the session is what
    // makes the attempt this person's work; both rows are stamped from the same
    // campaign, so they cannot disagree.
    const conditions = [
      `s.agent_user_id = ${bind.add(input.agentUserId)}`,
      `s.tenant_id = ${bind.add(input.tenantId)}`,
      `s.account_id = ${bind.add(input.accountId)}`,
    ];

    if (f.campaignId) conditions.push(`a.campaign_id = ${bind.add(f.campaignId)}::uuid`);
    // The created_at bound inside is the opposite of the STATS endpoint, which
    // buckets on `dialed_at` precisely because it is aggregating dials rather than
    // listing attempts; the two are different questions and the divergence is
    // deliberate.
    conditions.push(...attemptFilterConditions(f, bind));
    if (input.after) conditions.push(keysetCondition(input.after, 'a', bind));

    const sql = `
      SELECT ${ATTEMPT_ROW_SELECT_SQL},
             ${keysetAtSql('a.created_at')} AS cursor_at
        FROM agency_call_attempts a
        ${ATTEMPT_CONTACT_JOIN_SQL}
        JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${bind.add(input.limit + 1)}`;

    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      phone_e164: string; agent_user_id: string | null; cursor_at: string;
    }>(sql, bind.values);

    return toKeysetPage(rows, input.limit, projectAttemptRow);
  }

  /**
   * Prior attempts on a contact's whole RETRY LINEAGE, newest first — the agent
   * panel's history block.
   *
   * ── This replaces a per-contact-row read, and the widening is the feature ──
   *
   * It used to be `WHERE contact_id = $1`, which is one campaign's worth of
   * history. Retry campaigns COPY contacts rather than sharing them (every
   * piece of per-campaign state lives on the row, and sharing one would make
   * `uq_agency_attempt_live` a cross-campaign lock), so "we called this person
   * twice last month" lives on a DIFFERENT row from the one being dialled now.
   * Keying on `root_contact_id` is what buys that history back, and the
   * denormalised root is what keeps it ONE indexed equality
   * instead of a recursive walk — see below for why that matters here
   * specifically.
   *
   * ── `ORDER BY` moved off `attempt_number`, and that is load-bearing ────────
   *
   * `attempt_number` is per contact ROW and **resets in every retry campaign**
   * (a retry is a fresh allowance, which is the point of authoring one).
   * Ordering by it interleaves two passes into nonsense: the parent's attempt 3
   * would sort above the child's attempt 1 even though the child's is more
   * recent. `ended_at DESC NULLS LAST` orders by when the dial actually finished,
   * and `NULLS LAST` keeps an attempt that never ended (reaped, orphaned) at the
   * bottom rather than at the top, where a NULL would otherwise sort first under
   * `DESC`. `attempt_number DESC` remains only as a deterministic tiebreaker for
   * two attempts that ended in the same microsecond.
   *
   * ── `campaign_name` joins the row because the agent needs it ───────────────
   *
   * "Attempt 2" means nothing once attempts come from two campaigns. The console
   * groups by campaign — this one first, then ancestors — which it cannot do from
   * an id it has no name for and no route to resolve.
   *
   * `c.campaign_id` is selected alongside `a.*` as the wire contract writes it;
   * the two hold the same value by construction (an attempt row carries the
   * campaign of its contact), and the join to `agency_contacts` is there for the
   * lineage predicate rather than for that column.
   *
   * ── ⚠️ THIS RUNS ON THE DIAL HOT PATH ─────────────────────────────────────
   *
   * `agency-dialer.ts#executeDial` calls it synchronously, BEFORE the dial, and
   * the pacing leader evaluates a campaign 4×/second. Three properties are not
   * negotiable and each has a test:
   *
   *   1. The caller's `try/catch` stays — history is nice-to-have and its absence
   *      must never cost the customer a call. A lineage query is a bigger thing
   *      to fail than a single-table read, which makes that guard more important
   *      rather than less.
   *   2. `PRIOR_ATTEMPT_LIMIT` stays. It is a display bound AND the bound on what
   *      this read can cost.
   *   3. Nothing may be added between the caller's `reserved` send and its dial.
   *
   * If this ever becomes slow enough to matter the answer is
   * `idx_agency_contacts_root` or dropping the campaign join —
   * never moving the send.
   *
   * @param rootContactId `agency_contacts.root_contact_id`, i.e. the head of the
   *   chain. Passing a plain `contact_id` for a contact that IS the head is the
   *   same value; passing it for a copied contact silently narrows the read to
   *   nothing, which is why the caller reads the column rather than reusing the id.
   */
  async findPriorForContactLineage(
    rootContactId: string,
    excludeAttemptId: string,
  ): Promise<Array<AgencyCallAttemptRecord & { campaign_name: string }>> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord & { campaign_name: string }>(
      `SELECT a.*, c.campaign_id, cam.name AS campaign_name
         FROM agency_call_attempts a
         JOIN agency_contacts  c   ON c.id  = a.contact_id
         JOIN agency_campaigns cam ON cam.id = c.campaign_id
        WHERE c.root_contact_id = $1 AND a.id <> $2
        ORDER BY a.ended_at DESC NULLS LAST, a.attempt_number DESC
        LIMIT ${PRIOR_ATTEMPT_LIMIT}`,
      [rootContactId, excludeAttemptId],
    );
    return rows;
  }

  /**
   * The **startup** reaper's sweep, and only that.
   *
   * ⚠️ **Do not call this from a running process.** The justification below holds
   * at boot and nowhere else: it is "any non-terminal attempt is dead *because
   * this process has just started and no other process could own it*", not "any
   * non-terminal attempt is dead". The periodic sweep was once found calling
   * this with an age cutoff, which quietly reinterpreted a boot-only argument as
   * a general one and reaped live conversations — see `sweepOnce` in
   * `src/agency/reaper.ts` for what that cost and what replaced it.
   *
   * The parameter is retained (and the only caller passes `null`) because
   * narrowing it away would silently change the startup semantics; a live sweep
   * wants {@link findNonTerminalOlderThan} + {@link reapByIds} instead, which can
   * exclude the attempts something still owns.
   *
   * Returns the reaped rows so their contacts can be returned to the roster.
   */
  async reapNonTerminal(olderThan: Date | null): Promise<AgencyCallAttemptRecord[]> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET state = 'ended', outcome = 'orphaned', ended_at = now(), updated_at = now()
        WHERE state = ANY($1::varchar[])
          AND ($2::timestamptz IS NULL OR created_at < $2)
      RETURNING *`,
      [AGENCY_ATTEMPT_LIVE_STATES as unknown as string[], olderThan],
    );
    return rows;
  }

  /**
   * Non-terminal attempts older than a cutoff — **candidates** for the periodic
   * sweep, not a verdict on any of them.
   *
   * Read-only on purpose. Deciding whether one of these is genuinely leaked needs
   * two liveness questions the database cannot answer — this replica's in-process
   * attempt map, and the Redis station-ownership key that says whether *some*
   * replica still holds the agent — so the decision cannot be a WHERE clause.
   */
  async findNonTerminalOlderThan(olderThan: Date): Promise<AgencyCallAttemptRecord[]> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `SELECT * FROM agency_call_attempts
        WHERE state = ANY($1::varchar[])
          AND created_at < $2
        ORDER BY created_at`,
      [AGENCY_ATTEMPT_LIVE_STATES as unknown as string[], olderThan],
    );
    return rows;
  }

  /**
   * Reap exactly these attempts, if they are *still* non-terminal.
   *
   * **The `state = ANY(live)` guard is the whole point and must not be dropped.**
   * It closes the window between the sweep's SELECT and this UPDATE: an attempt
   * that settled normally in between is already terminal, so this writes nothing
   * to it. Without the guard the sweep would overwrite a real outcome with
   * `orphaned` and return a contact whose call had in fact just connected —
   * the exactly-one-writer rule, enforced in SQL rather than hoped for.
   */
  async reapByIds(attemptIds: string[]): Promise<AgencyCallAttemptRecord[]> {
    if (attemptIds.length === 0) return [];
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET state = 'ended', outcome = 'orphaned', ended_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[])
          AND state = ANY($2::varchar[])
      RETURNING *`,
      [attemptIds, AGENCY_ATTEMPT_LIVE_STATES as unknown as string[]],
    );
    return rows;
  }

  /**
   * Conversations whose wrap-up lapsed with nothing written up.
   *
   * Every clause is load-bearing:
   * - `state='ended'` + `outcome='connected'` + `bridged_at IS NOT NULL` — there
   *   was a real conversation. `bridged_at` rather than the outcome alone for the
   *   same reason `dispositionRefusal` keys on it: the outcome is a
   *   classification that can be absent or late, `bridged_at` is the instant
   *   media joined the two parties.
   * - `disposition_code IS NULL` — the agent did not write it up. A row that has
   *   one must never be revisited; that is a record of what was said to a
   *   customer.
   * - `contacts.state = 'connected'` — the contact is still parked waiting for
   *   that write-up. This is the actual harm being repaired, and joining on it
   *   means a contact some other path already released is left alone.
   * - the `ended_at + wrapup_seconds + grace` clock — `wrapup_seconds` is the
   *   window the campaign promised the agent, per row, because it is read off the
   *   attempt rather than off today's campaign config (an operator shortening it
   *   mid-shift must not retroactively expire wrap-ups that were owed longer).
   *
   * The campaign's `disposition_catalog` rides along because the caller must ask
   * `requiresDisposition` before stamping anything — a campaign that never owed a
   * disposition must not be given one.
   */
  async findLapsedWrapups(graceSeconds: number, limit = 500): Promise<AgencyLapsedWrapupRow[]> {
    const { rows } = await getPool().query<AgencyLapsedWrapupRow>(
      `SELECT a.*,
              c.disposition_catalog AS campaign_disposition_catalog,
              c.retry_policy        AS campaign_retry_policy,
              -- The contact's retry BUDGET, not the attempt's own
              -- attempt_number. The two are deliberately decoupled,
              -- and the policy is evaluated against the budget. This path does NOT
              -- bump it (the attempt was counted when it ended), so the stored value
              -- is already the post-attempt count the policy is defined on.
              ct.attempt_count      AS contact_attempt_count
         FROM agency_call_attempts a
         JOIN agency_contacts  ct ON ct.id = a.contact_id
         JOIN agency_campaigns  c ON c.id  = a.campaign_id
        WHERE a.state = 'ended'
          AND a.outcome = 'connected'
          AND a.bridged_at IS NOT NULL
          AND a.disposition_code IS NULL
          AND a.ended_at IS NOT NULL
          AND ct.state = 'connected'
          AND a.ended_at + make_interval(secs => COALESCE(a.wrapup_seconds, 0) + $1) < now()
        ORDER BY a.ended_at
        LIMIT $2`,
      [graceSeconds, limit],
    );
    return rows;
  }

  /**
   * Stamp the auto-close, if nothing has been written up in the meantime.
   *
   * `disposition_code IS NULL` is the same guarded-UPDATE discipline
   * `recordDisposition` uses, and here it is what makes the sweep lose a race it
   * should lose: an agent submitting their real disposition between this sweep's
   * SELECT and this write keeps it, and the sweep writes nothing.
   *
   * `dispositioned_by_user_id` is deliberately left NULL — nobody recorded this,
   * which is the entire meaning of the code being written. Attributing it to the
   * reserved agent would put their name on an admission they did not make.
   */
  async recordAutoDisposition(attemptId: string, code: string): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET disposition_code = $2,
              dispositioned_at = now(),
              updated_at = now()
        WHERE id = $1
          AND disposition_code IS NULL
      RETURNING *`,
      [attemptId, code],
    );
    return rows[0] ?? null;
  }
}

export const agencyAttemptRepository = new AgencyAttemptRepository();
