/** `AgencyAgentSessionRepository`: agent sessions and their transition event log. */
import { getPool } from '@magick-agency/db';
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
import { createChildLogger } from '@magick-agency/observability';
import type {
  AgencyAgentSessionRecord,
  AgencyCampaignSessionRecord,
  AgencyStationAttachRecord,
} from '../../models/agency.model.js';
import {
  AGENCY_INBOUND_RING_MAX_MISSES,
  AWAY_RING_BREAK_REASON,
  DEVICE_AWAY_BREAK_REASON,
  SOFTPHONE_BREAK_REASON,
  type AgencyAgentState,
  type AgencyClientKind,
  type AgencyPushPlatform,
  type AgencySessionKind,
} from '@magick-agency/contracts/agency';

const log = createChildLogger({ component: 'agency-repository' });

/**
 * What a join attempt learned, in the same shape as `ReservationResult` in
 * `src/agency/agent-state-machine.ts`.
 *
 * A discriminated result rather than a thrown error, and for the same reason the
 * reservation CAS returns `'lost'`: an agent who is still live on another
 * campaign is a NORMAL, expected outcome of a join — a supervisor reassigned
 * them mid-shift and they have not left their old station — not an exceptional
 * one. Throwing would push a routine 409 through the same channel as a dead
 * database, and every caller would have to unwrap it by inspecting an error
 * message.
 *
 * The conflicting `session` rides along on the failure because the caller cannot
 * usefully report the refusal without it: "you are still joined to a campaign"
 * with no name is not actionable, and re-reading the row in the route would open
 * the very window this result closes.
 */
type AgencyAgentJoinResult =
  /** `created`: a fresh row (201 on the wire); false for a rehydrate. */
  | { ok: true; session: AgencyAgentSessionRecord; created: boolean }
  /** Live on a DIFFERENT campaign: the refusal names it (`session_on_other_campaign`). */
  | { ok: false; reason: 'other_campaign'; session: AgencyCampaignSessionRecord }
  /**
   * Live on a soft-phone session (docs/softphone.md), which has no campaign to name;
   * the route answers `session_on_softphone`. Before 0005 every blocker was a
   * campaign session, so the route still also narrows on `isCampaignSession`.
   */
  | { ok: false; reason: 'on_softphone'; session: AgencyAgentSessionRecord }
  /**
   * Live (on a campaign or the soft phone) in ANOTHER tenant (OS1, `uq_agency_agent_live_agent`):
   * the route answers `session_in_other_tenant`, naming only the tenant. Nothing in this tenant
   * can end it.
   */
  | { ok: false; reason: 'other_tenant'; session: AgencyAgentSessionRecord };

/**
 * What a station-device claim learned (OS3, {@link AgencyAgentSessionRepository.claimStationDevice}).
 * `held_elsewhere` carries the app that last attached the station, for the refusal's copy.
 */
export type AgencyStationDeviceClaim =
  /**
   * This device holds the station. `endedAwayRing`: the claim moved the station off the device
   * that held it while the session was on `away_ring` (or ringing from it), which ended it in the
   * same statement (IQ67, OS3): `away_ring_since` cleared, a `break/away_ring` row rewritten to
   * `device_away`. The caller clears Redis's `ring` and tells the old device (`ring_off`,
   * `taken_over`).
   */
  | { ok: true; endedAwayRing?: { previousDeviceId: string | null } }
  | { ok: false; reason: 'held_elsewhere'; client_kind: AgencyClientKind }
  | { ok: false; reason: 'session_gone' };

/**
 * What `joinSoftphone` learned. The mirror image of {@link AgencyAgentJoinResult}:
 * the soft-phone session is the agent's one live session anywhere
 * (`uq_agency_agent_live_agent`, 0035), so an agent live on a campaign is refused, with
 * that session, and the remedy is the switch on it (`POST /sessions/:id/softphone`,
 * §4.2), never a second session.
 */
export type AgencySoftphoneJoinResult =
  /** `created`: a fresh row (201); false when the live soft-phone session was rehydrated (200). */
  | { ok: true; session: AgencyAgentSessionRecord & { kind: 'softphone'; campaign_id: null }; created: boolean }
  | { ok: false; reason: 'on_campaign'; session: AgencyCampaignSessionRecord }
  /**
   * The agent's live soft-phone session is in ANOTHER account of the tenant (the
   * route answers `session_on_softphone` with its account). Never rehydrated from
   * here: every soft-phone route is scoped to the session's account, so a console in
   * this account handed that session could dial nothing from it.
   */
  | { ok: false; reason: 'softphone_elsewhere'; session: AgencyAgentSessionRecord & { kind: 'softphone'; campaign_id: null } }
  /** Live in ANOTHER tenant (OS1): `session_in_other_tenant`, as on the campaign join. */
  | { ok: false; reason: 'other_tenant'; session: AgencyAgentSessionRecord };

/** The upsert's own answer, before either public method names the conflict. */
type LiveSessionUpsertResult =
  | { ok: true; session: AgencyAgentSessionRecord; created: boolean }
  | { ok: false; blocker: AgencyAgentSessionRecord };

/**
 * How many times `joinOrRehydrate` re-attempts its upsert when the row blocking
 * it disappears mid-call. See the loop for why this is not 1 and not unbounded.
 */
const JOIN_UPSERT_ATTEMPTS = 3;

/**
 * One state transition, as the UPDATE that performed it saw both sides.
 *
 * Every write below projects this shape, which is what makes the event log
 * exhaustive **by construction** rather than by anyone remembering: the four
 * methods on this class are the only writers of `agency_agent_sessions.state`
 * anywhere in the server (verified by grep, not by assumption — the callers are the
 * three session routes, the dialer's bridge and release paths, the wrap-up
 * manager, the two presence paths in `runtime.ts`, and the startup reaper), so a
 * transition that reaches the database and not the log is not reachable without
 * adding a fifth writer.
 *
 * `from_state` is read in the SAME statement as the write — see each method for
 * the `FROM (SELECT …)` idiom — because reading it first would open a window in
 * which another replica moved the agent, and the log would then record a
 * transition that never happened.
 */
interface AgencySessionTransitionRow {
  session_id: string;
  tenant_id: string;
  account_id: string;
  /** NULL for a soft-phone session, copied as the session row has it (0005). */
  campaign_id: string | null;
  agent_user_id: string;
  /** NULL when the session row was just created — there is no prior state. */
  from_state: AgencyAgentState | null;
  to_state: AgencyAgentState;
  from_break_reason: string | null;
  break_reason: string | null;
  /**
   * When the MUTATION happened — `clock_timestamp()` projected by the UPDATE
   * itself, never the moment the log INSERT later runs. See
   * {@link AgencyAgentSessionRepository.recordTransitions} for why the difference
   * is not cosmetic.
   *
   * ISO-8601 TEXT in UTC with microseconds (`2026-11-04T08:00:00.123456Z`), never a `Date`:
   * a JavaScript `Date` keeps milliseconds, so two transitions on one session that the row
   * lock serialises within the same millisecond would be logged with EQUAL instants, and a
   * reader ordering by `at` could put them back in either order (the chain then reads
   * `offline → on_call`, `offline → wrapup`). Inserted as `$9::timestamptz[]`, unchanged.
   */
  at: string;
}

/**
 * The transition's instant, projected by the statement that performs it: `clock_timestamp()`
 * as UTC ISO-8601 text with microseconds (see {@link AgencySessionTransitionRow.at} for why
 * not a `Date`). Every writer of the transition log projects it with this one expression.
 */
const TRANSITION_AT_SQL = `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;

/**
 * The session-transition UPDATE every writer of `agency_agent_sessions.state`
 * except the join upsert runs: `setState`, `leave`, `markAllOffline`.
 *
 * `prev` locks the rows `FOR UPDATE` in the same statement as the write, so
 * `prev.state` is the state being left with no window in between — see
 * {@link AgencyAgentSessionRepository.setState} for why a plain subquery is the
 * bug. `RETURNING` projects {@link AgencySessionTransitionRow}, whose `at` is the
 * transition's own instant: `clock_timestamp()` per row, which
 * `recordTransitions` inserts verbatim rather than letting the column's DEFAULT
 * now() stamp the log write (and which keeps a sweep of the whole floor from
 * collapsing to a single instant).
 */
function sessionTransitionSql(input: { prevWhere: string; set: string; where?: string }): string {
  return `WITH prev AS (
         SELECT id, state, break_reason FROM agency_agent_sessions
          WHERE ${input.prevWhere} FOR UPDATE
       )
       UPDATE agency_agent_sessions s
          SET ${input.set}
         FROM prev
        WHERE s.id = prev.id${input.where ? ` AND ${input.where}` : ''}
       RETURNING s.id AS session_id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
                 prev.state AS from_state, prev.break_reason AS from_break_reason,
                 s.state AS to_state, s.break_reason,
                 ${TRANSITION_AT_SQL}`;
}

/**
 * A live session on `away_ring` or ringing from it (`away_ring_since IS NOT NULL`, N1), as the
 * reconcile reads it (`AwayRingService.reconcile`), with the push device that holds its station
 * (`agency_push_devices` on `(agent_user_id, station_device_id)`; every `device_*` NULL when none).
 * Never a token: only whether one is registered.
 */
export interface AgencyAwayRingCandidate {
  id: string;
  tenant_id: string;
  account_id: string;
  campaign_id: string | null;
  kind: AgencySessionKind;
  agent_user_id: string;
  state: AgencyAgentState;
  break_reason: string | null;
  state_since: Date;
  away_ring_since: Date;
  station_device_id: string | null;
  device_platform: AgencyPushPlatform | null;
  device_ring_enabled: boolean | null;
  device_revoked: boolean | null;
  device_has_token: boolean | null;
}

/**
 * A live campaign session of one account on `away_ring` (or ringing from it) whose station's push
 * device can be rung: registered, not revoked, opted in, with a token for its platform (IQ58,
 * IQ60, IQ65). What the inbound connector reads at each search (`InboundConnector`'s agent views,
 * one statement). Never a token.
 */
export interface AgencyRingableSession {
  id: string;
  agent_user_id: string;
  campaign_id: string;
  device_platform: AgencyPushPlatform;
}

/** What {@link AgencyAgentSessionRepository.endAwayRing} ended: the session's identity, for the push and the audit. */
export interface AgencyAwayRingEnded {
  id: string;
  tenant_id: string;
  account_id: string;
  campaign_id: string | null;
  agent_user_id: string;
  station_device_id: string | null;
  /** The state the row was in (`break`, `offline` after a restart, `reserved` mid-ring). */
  from_state: AgencyAgentState;
}

export class AgencyAgentSessionRepository {
  /**
   * Append the transition log rows for a write that just happened.
   *
   * ── THIS MUST NEVER FAIL A STATE TRANSITION, and that is why it is a second
   *    statement rather than a CTE on the first one ──────────────────────────
   *
   * Folding the INSERT into the UPDATE would be atomic and tempting, and it would
   * be wrong: any failure of the insert — the events table unavailable, the `to_state` CHECK refusing a seventh
   * state someone added to the schema and not here, a disk full — would roll
   * back the transition itself. The consequences are not symmetric. **A dropped
   * event costs one occupancy row; a thrown error mid-transition takes an agent
   * off the floor or wedges a live call** — `releaseAgent` would not return them
   * to the pool, `enter` would not put them in wrap-up, `leave` would strand a
   * session that the tenant-unique index then blocks them from re-joining.
   *
   * So: separate statement, everything caught, logged at warn, and the caller
   * continues. The log line carries the states, because a swallowed CHECK
   * violation naming the offending state is the ONLY way the vocabulary drift
   * described above becomes discoverable.
   *
   * Awaited rather than fired and forgotten: an unawaited promise here would be
   * an unhandled rejection on a path that must not have one, and would make the
   * ordering of the log untestable. It is one INSERT on paths that already await
   * an UPDATE, and it is never on the pre-wire half of the bridge path — the
   * dialer sends the `bridged` frame to the agent BEFORE it mirrors any state, on
   * purpose.
   *
   * A transition that moved nothing writes nothing: a `setState` to the state the
   * session is already in (a double-click on Available, a release into a pool the
   * agent is already in) would otherwise log a zero-length interval, which sums
   * correctly and reads as noise. A `break → break` with a DIFFERENT reason is a
   * real transition and is kept, which is why the comparison includes the reason.
   *
   * ── `at` is CARRIED from the mutation, never defaulted by this INSERT ───────
   *
   * `at` has a `DEFAULT now()`, and leaning on it would stamp the
   * event when THIS statement runs rather than when the state actually changed.
   * Being a second statement is what makes that gap exist at all (see above), and
   * the gap is not merely a small skew: two transitions on one session racing from
   * two replicas take the row lock in one order and reach this INSERT in whatever
   * order the two round trips happen to complete. Inverted, `lead(at) OVER
   * (PARTITION BY session_id ORDER BY at)` differences the wrong pairs — every
   * state after the inversion is attributed to the wrong interval, and the
   * durations are wrong by the gap between the two events. The log would say the
   * agent went to `wrapup` and then back `on_call` when they did the opposite.
   *
   * So each row carries the timestamp its own UPDATE projected, and the log is
   * ordered by the mutations rather than by the writes that record them.
   * `clock_timestamp()` rather than `now()` at the source, because `now()` is the
   * TRANSACTION's start instant: the loser of a row-lock race can have begun its
   * transaction first and still perform its UPDATE second, so `now()` can order
   * two racing transitions opposite to the order the database applied them.
   * `clock_timestamp()` is read after the row is locked and updated, so it cannot.
   * It is deliberately a hair later than the same statement's `state_since =
   * now()`; the two answer different questions and only `at` has to sort.
   */
  private async recordTransitions(rows: AgencySessionTransitionRow[]): Promise<void> {
    const moved = rows.filter((r) =>
      r.from_state !== r.to_state || (r.from_break_reason ?? null) !== (r.break_reason ?? null));
    if (moved.length === 0) return;
    try {
      // One statement for the whole batch via UNNEST — `markAllOffline` can move
      // the entire floor at boot, and a query per agent would make the startup
      // reaper's cost scale with the roster on a path that runs before the pacing
      // supervisor is allowed to start.
      await getPool().query(
        `INSERT INTO agency_agent_session_events
           (session_id, tenant_id, account_id, campaign_id, agent_user_id,
            from_state, to_state, break_reason, at)
         SELECT * FROM UNNEST(
           $1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[],
           $6::varchar[], $7::varchar[], $8::varchar[], $9::timestamptz[])`,
        [
          moved.map((r) => r.session_id),
          moved.map((r) => r.tenant_id),
          moved.map((r) => r.account_id),
          moved.map((r) => r.campaign_id),
          moved.map((r) => r.agent_user_id),
          moved.map((r) => r.from_state),
          moved.map((r) => r.to_state),
          // Only carried into `break`. The session column keeps the last reason
          // after the agent returns, so copying it onto an `available` event would
          // label an interval with a reason that belongs to a different one.
          moved.map((r) => (r.to_state === 'break' ? r.break_reason : null)),
          // The mutation's own instant — see the header. Never omitted to let
          // the column's DEFAULT now() fill it in.
          moved.map((r) => r.at),
        ],
      );
    } catch (err) {
      log.warn(
        {
          err,
          sessions: moved.map((r) => r.session_id),
          transitions: moved.map((r) => `${r.from_state ?? 'new'}->${r.to_state}`),
        },
        'Could not record agent state transition events — occupancy will under-report this interval',
      );
    }
  }

  async findById(id: string): Promise<AgencyAgentSessionRecord | null> {
    const { rows } = await getPool().query<AgencyAgentSessionRecord>(
      'SELECT * FROM agency_agent_sessions WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * The station attach's session read, which also records the attaching app
   * (`client_kind`, 0006) — {@link findById}'s answer, in the same single round trip.
   *
   * Every attach states its client, and a "continue on this phone" rehydrates the SAME
   * session from another device, so the column is written on every attach rather than
   * at join. Folded into the read the attach already makes instead of a second
   * statement, and written only when it CHANGES: a reconnect from the same app (the
   * common case: every wifi blip) reads and writes nothing, so it costs no dead tuple
   * and takes no row lock. Never written on a session that has left.
   *
   * Returns the row as it stands after the write (the old row when nothing changed), or
   * null when there is no such session; the caller's `left_at` check is unchanged. The row
   * carries its campaign's `assignment_mode` as `campaign_assignment_mode` (null for a
   * soft-phone session), joined here so the attach reads the campaign row only on a `strict`
   * or `preferred` campaign, whose `ready` carries the agent's queue (CA3).
   *
   * `$2` is typed at each use (`42P08` otherwise). `cur` and `upd` project the same
   * table's columns in the same order, so the `UNION ALL` lines up; `cur` is the
   * statement's snapshot, so it is read only when `upd` wrote nothing.
   */
  async readForStationAttach(id: string, clientKind: AgencyClientKind): Promise<AgencyStationAttachRecord | null> {
    const { rows } = await getPool().query<AgencyStationAttachRecord>(
      `WITH cur AS (
         SELECT * FROM agency_agent_sessions WHERE id = $1
       ), upd AS (
         UPDATE agency_agent_sessions s
            SET client_kind = $2::varchar
           FROM cur
          WHERE s.id = cur.id
            AND cur.left_at IS NULL
            AND cur.client_kind IS DISTINCT FROM $2::varchar
         RETURNING s.*
       )
       SELECT r.*, c.assignment_mode AS campaign_assignment_mode
         FROM (SELECT * FROM upd
               UNION ALL
               SELECT * FROM cur WHERE NOT EXISTS (SELECT 1 FROM upd)) r
         LEFT JOIN agency_campaigns c ON c.id = r.campaign_id`,
      [id, clientKind],
    );
    return rows[0] ?? null;
  }

  /**
   * Join, or REHYDRATE an existing live session.
   *
   * A returning agent must resume their row rather than get a new one — the unique
   * index allows exactly one live session per agent, across tenants
   * (`uq_agency_agent_live_agent`, 0035, OS1) — and must land in `break`, never `available`, so the engine cannot dial into a
   * pool that has not demonstrably re-attached. The agent clicks once to go
   * available.
   *
   * ── Why the uniqueness is per AGENT and what that makes reachable ───
   * Were it unique per (campaign, agent), or per (tenant, agent) as it was before 0035, one
   * human could hold two live sessions on two campaigns. The reservation CAS key is
   * `agency:agent:{sessionId}:state` — per session — so those two sessions are two
   * independently reservable agents attached to one pair of ears, and both pacing
   * ticks can bridge a customer at once. `uq_agency_agent_live_agent` makes the database refuse the second
   * session, which is why this method can FAIL rather than always returning a
   * row.
   *
   * ── Why this is one statement and never check-then-insert ──────────────────
   * A `SELECT` for an existing live session followed by an `INSERT` has a window
   * between them, and that window is precisely the double-join this exists to
   * prevent — two console tabs, or a reconnect racing a fresh join, both read
   * "nothing live" and both insert. The arbiter index does the checking, inside
   * the same statement as the write.
   *
   * ── Why `DO UPDATE … WHERE tenant_id = … AND kind = … AND campaign_id IS NOT DISTINCT FROM … AND account_id = …` ─
   * The conflict has two meanings and they must not be collapsed:
   *   * same session (same kind, same campaign, same account) ⇒ this is a
   *     REHYDRATE. Update and return the row.
   *   * anything else ⇒ this is the refusal. The `WHERE` makes the DO UPDATE
   *     match nothing, so `RETURNING` yields zero rows — **and, critically, the
   *     other session's row is left exactly as it was.** An unconditional DO
   *     UPDATE would stamp this replica's `owner_replica` onto a session live on
   *     another campaign, i.e. quietly hijack the ownership of an agent who may
   *     be mid-conversation, and only then report a conflict.
   *
   * `IS NOT DISTINCT FROM`, never `=`: a soft-phone session's `campaign_id` is NULL
   * (0005), `NULL = NULL` is NULL, and the rehydrate arm then never matched — the
   * follow-up read found the agent's own soft-phone session, judged it "the
   * requested one", retried, and threw after three passes (a 500 on every
   * soft-phone reconnect). The JS comparison in the retry loop is `!==` on two
   * `string | null` values, which is already NULL-safe.
   *
   * `account_id` because a soft-phone session names no campaign, and so nothing else
   * ties it to an account: without it a soft-phone open in account A rehydrated the
   * agent's soft-phone session in sibling account B, and A's console was handed a
   * session every account-scoped route then refused (`session_not_found`). For a
   * campaign session it changes nothing (a campaign is one account's, and the join
   * route checks the campaign against the request's account).
   *
   * A campaign join while the agent is on a soft-phone session is refused
   * `on_softphone` (the route answers `session_on_softphone`).
   */
  async joinOrRehydrate(input: {
    tenantId: string;
    accountId: string;
    campaignId: string;
    agentUserId: string;
    replicaId: string;
  }): Promise<AgencyAgentJoinResult> {
    const result = await this.upsertLiveSession({ ...input, kind: 'campaign' });
    if (result.ok) return result;
    const blocker = result.blocker;
    if (blocker.tenant_id !== input.tenantId) return { ok: false, reason: 'other_tenant', session: blocker };
    return blocker.campaign_id === null
      ? { ok: false, reason: 'on_softphone', session: blocker }
      : { ok: false, reason: 'other_campaign', session: blocker as AgencyCampaignSessionRecord };
  }

  /**
   * Open, or REHYDRATE, the agent's soft-phone session (docs/softphone.md §2):
   * `kind = 'softphone'`, `campaign_id` NULL, created in `break` with the reserved
   * reason `soft_phone`, and never anything else while live
   * (`ck_agency_agent_session_softphone_state` allows only `break`/`offline`).
   *
   * The same single statement as {@link joinOrRehydrate}, on the same arbiter
   * (`uq_agency_agent_live_agent`): never check-then-insert, for the reason that
   * method's header gives. A rehydrate of an `offline` soft-phone session (the startup
   * reaper's `markAllOffline`) lands back in `break/soft_phone`, re-stamping the
   * reason, since `soft_phone` is the only break a soft-phone session can be on.
   *
   * Refused `on_campaign`, with the live campaign session, when the agent is live on
   * a campaign: the soft phone for that agent is the switch on that session (§4.2).
   * Refused `softphone_elsewhere`, with the session, when the agent's soft-phone
   * session is in another account of the tenant: it is closed there (`leave`, with
   * its account) before one opens here.
   */
  async joinSoftphone(input: {
    tenantId: string;
    accountId: string;
    agentUserId: string;
    replicaId: string;
  }): Promise<AgencySoftphoneJoinResult> {
    const result = await this.upsertLiveSession({ ...input, kind: 'softphone', campaignId: null });
    if (result.ok) {
      return {
        ok: true,
        session: result.session as AgencyAgentSessionRecord & { kind: 'softphone'; campaign_id: null },
        created: result.created,
      };
    }
    // A soft-phone blocker is one in another account (in this account it would have
    // been the rehydrate arm); any other is a campaign session, whose non-null
    // `campaign_id` is what the refusal carries. Either, in another tenant, is OS1's.
    const blocker = result.blocker;
    if (blocker.tenant_id !== input.tenantId) return { ok: false, reason: 'other_tenant', session: blocker };
    return blocker.campaign_id === null
      ? {
        ok: false,
        reason: 'softphone_elsewhere',
        session: blocker as AgencyAgentSessionRecord & { kind: 'softphone'; campaign_id: null },
      }
      : { ok: false, reason: 'on_campaign', session: blocker as AgencyCampaignSessionRecord };
  }

  /**
   * The upsert both joins run. `kind` and `campaignId` together name the session
   * proposed: `('campaign', <id>)` or `('softphone', null)`; the CHECK
   * `ck_agency_agent_session_kind_campaign` refuses any other pairing.
   */
  private async upsertLiveSession(input: {
    tenantId: string;
    accountId: string;
    kind: AgencySessionKind;
    campaignId: string | null;
    agentUserId: string;
    replicaId: string;
  }): Promise<LiveSessionUpsertResult> {
    const breakReason = input.kind === 'softphone' ? SOFTPHONE_BREAK_REASON : null;
    for (let attempt = 0; attempt < JOIN_UPSERT_ATTEMPTS; attempt++) {
      // ── The `prev` CTE is how a join gets logged ───────────
      //
      // The upsert has two outcomes and the transition log needs to tell them
      // apart: a fresh INSERT is the session's FIRST transition, which the log
      // records with `from_state = NULL`; a rehydrate is `offline → break` (or no
      // transition at all, when the agent's session was already live in a working
      // state and only `owner_replica`/`last_heartbeat` move).
      //
      // `RETURNING` on an `ON CONFLICT DO UPDATE` yields the NEW row, so it cannot
      // answer that on its own. All CTEs of one statement see the same snapshot,
      // so `prev` reads the row as it was before the upsert; the outer LEFT JOIN
      // then makes `from_state IS NULL` mean exactly "this row did not exist",
      // which is the same thing NULL means in the event log's `from_state`. The `xmax = 0`
      // inserted-vs-updated trick would answer the narrower question and still
      // leave the previous state unknown.
      //
      // ── …except for a row a CONCURRENT join inserted ─────────────────────────
      // `prev`'s snapshot is taken before the upsert waits on the arbiter index, so
      // when two first joins race (a double-click, two tabs) the loser's `prev` is
      // empty although its upsert took the DO UPDATE arm. Logged as is, that is a
      // second `NULL → break` "session started" event for a session that started
      // once. So `xmax = 0` is asked as well, for exactly that narrower question: a
      // row this statement did NOT insert, with no `prev`, was inserted as `break`
      // by the racing join an instant ago and left in its state by this update —
      // no transition, which `recordTransitions` drops. (`load/session-join-races`.)
      //
      // `prev` is keyed on the same predicate as the arbiter index — the agent's
      // one live session anywhere (`uq_agency_agent_live_agent`, 0035) — not on the proposed row,
      // because the conflicting row may be on a different campaign, or in a different tenant.
      const { rows } = await getPool().query<AgencyAgentSessionRecord & {
        from_state: AgencyAgentState | null;
        from_break_reason: string | null;
        at: string;
        inserted: boolean;
      }>(
        `WITH prev AS (
           SELECT id, state, break_reason FROM agency_agent_sessions
            WHERE agent_user_id = $4 AND left_at IS NULL
         ), upserted AS (
           INSERT INTO agency_agent_sessions
             (tenant_id, account_id, campaign_id, agent_user_id, state, owner_replica, last_heartbeat,
              kind, break_reason)
           VALUES ($1, $2, $3, $4, 'break', $5, now(), $6, $7)
           ON CONFLICT (agent_user_id) WHERE left_at IS NULL
           DO UPDATE SET owner_replica = EXCLUDED.owner_replica,
                         last_heartbeat = now(),
                         state = CASE WHEN agency_agent_sessions.state = 'offline'
                                      THEN 'break' ELSE agency_agent_sessions.state END,
                         -- A soft-phone session's only break is soft_phone; a campaign
                         -- rehydrate keeps whatever reason the row carries, as before.
                         break_reason = CASE WHEN agency_agent_sessions.kind = 'softphone'
                                             THEN EXCLUDED.break_reason
                                             ELSE agency_agent_sessions.break_reason END,
                         updated_at = now()
             WHERE agency_agent_sessions.tenant_id = EXCLUDED.tenant_id
               AND agency_agent_sessions.kind = EXCLUDED.kind
               AND agency_agent_sessions.campaign_id IS NOT DISTINCT FROM EXCLUDED.campaign_id
               AND agency_agent_sessions.account_id = EXCLUDED.account_id
           RETURNING *, (xmax = 0) AS inserted
         )
         SELECT upserted.*,
                CASE WHEN prev.id IS NOT NULL THEN prev.state
                     WHEN upserted.inserted THEN NULL
                     ELSE upserted.state END AS from_state,
                CASE WHEN prev.id IS NOT NULL THEN prev.break_reason
                     WHEN upserted.inserted THEN NULL
                     ELSE upserted.break_reason END AS from_break_reason,
                ${TRANSITION_AT_SQL}
           FROM upserted LEFT JOIN prev ON prev.id = upserted.id`,
        [input.tenantId, input.accountId, input.campaignId, input.agentUserId, input.replicaId,
          input.kind, breakReason],
      ).catch((err: unknown) => {
        // ── A race on the KEPT per-tenant index (0035, OS8) ───────────────────
        // `ON CONFLICT (agent_user_id)` absorbs a conflict on its own arbiter only. Two joins of
        // one agent in one tenant racing both pass the arbiter's pre-check; the loser's insert can
        // then trip `uq_agency_agent_live_tenant` (kept for rollback) before the arbiter, as a raw
        // 23505. It means exactly what an empty upsert means, "something live exists for this
        // agent", so it takes the same path: read the blocker and retry or refuse.
        if (isUniqueViolation(err, 'uq_agency_agent_live_tenant')) return { rows: [] };
        throw err;
      });
      const row = rows[0];
      if (row) {
        // Destructured rather than passed through: the two log-only columns must
        // not ride along on `AgencyAgentSessionRecord`, which is spread into the
        // bootstrap payload — an extra field on the wire is a contract nobody
        // agreed to and one that the console would start depending on.
        // `at` is destructured out for the same reason the two `from_*` columns
        // are: `AgencyAgentSessionRecord` is spread into the bootstrap payload,
        // and a log-only column riding along becomes a contract nobody agreed to.
        // `inserted` likewise: it steers `from_state` above and becomes `created`.
        const { from_state, from_break_reason, at, inserted, ...session } = row;
        await this.recordTransitions([{
          session_id: session.id,
          tenant_id: session.tenant_id,
          account_id: session.account_id,
          campaign_id: session.campaign_id,
          agent_user_id: session.agent_user_id,
          from_state,
          from_break_reason,
          to_state: session.state,
          break_reason: session.break_reason,
          at,
        }]);
        return { ok: true, session, created: inserted };
      }

      // Zero rows means the DO UPDATE's WHERE refused: something live exists for
      // this agent and it is not the row we proposed. Read it, so the refusal can
      // name the campaign the agent has to leave.
      //
      // This read is NOT synchronised with the upsert, and both branches below
      // exist because of that gap rather than in spite of it.
      // Anywhere, not in this tenant: the arbiter spans tenants (OS1), so the row that refused
      // the upsert may be in another one, and a tenant-scoped read would find nothing and retry
      // until the bound throws.
      const blocker = await this.findLiveForAgentAnyTenant(input.agentUserId);

      // `tenant_id`, `campaign_id` and `account_id` decide "the same session", as the DO
      // UPDATE's WHERE does: the CHECK ties `kind` to the campaign, and `!==` on
      // `string | null` is NULL-safe (a soft-phone blocker of a soft-phone join in
      // the same account is the rehydrate race below, not a conflict; one in another
      // account is a conflict, and retrying it would only throw after three passes).
      if (blocker && (blocker.tenant_id !== input.tenantId
        || blocker.campaign_id !== input.campaignId || blocker.account_id !== input.accountId)) {
        return { ok: false, blocker };
      }

      // Two ways to arrive here, and both mean "the obstacle is gone, try again":
      //
      //  * no blocker at all — the other session left between the upsert and this
      //    read (the agent clicked Leave on the old campaign at exactly the wrong
      //    moment);
      //  * a blocker on the REQUESTED campaign — a concurrent join for the same
      //    agent landed here in the same gap, so this is a rehydrate, not a
      //    conflict. Returning `other_campaign` for it would tell the agent to
      //    leave the station they are trying to reach: an instruction that cannot
      //    be followed, on the only error path the 1:1 rule makes reachable. The
      //    `ok:true` path carries an equivalent mismatch assertion in the route,
      //    and that one is documented as unreachable — this is the reachable half
      //    and it was the half with no guard.
      //
      // Bounded rather than `while (true)` because the loop's exit depends on
      // another actor: an agent flapping join/leave could otherwise hold this
      // request open indefinitely. Three passes cannot be reached by anything but
      // a pathological client, and exhausting them is a real anomaly worth
      // surfacing — the one case here that IS exceptional, hence the throw.
    }
    // No tenant or agent id in the message. Fastify serialises an uncaught error's
    // `message` into the 500 body, so anything interpolated here is returned to
    // whoever made the request; the identifiers belong in the log line the caller
    // writes, not on the wire.
    throw new Error(
      `Live-session join could not settle after ${JOIN_UPSERT_ATTEMPTS} attempts: ` +
      `the agent's live session kept changing between the upsert and the read`,
    );
  }

  /**
   * The agent's one live session in ANY tenant (`uq_agency_agent_live_agent`, OS1), if any. Only
   * the join's conflict read uses it: everything else asks within its own tenant
   * ({@link findLiveForAgent}), and must never act on a session in another.
   */
  async findLiveForAgentAnyTenant(agentUserId: string): Promise<AgencyAgentSessionRecord | null> {
    const { rows } = await getPool().query<AgencyAgentSessionRecord>(
      `SELECT * FROM agency_agent_sessions
        WHERE agent_user_id = $1 AND left_at IS NULL
        LIMIT 1`,
      [agentUserId],
    );
    return rows[0] ?? null;
  }

  /**
   * OS3: claim this live session's station for `deviceId`, in one statement.
   *
   *  * the device already holds it, no device does, or `takeOver`: the device holds it now;
   *  * another device holds it and `takeOver` is false: refused `held_elsewhere`, nothing written;
   *  * no `deviceId` (an older client): on a join or soft-phone open, allowed, and the holder is
   *    cleared, so the station is any device's to claim, as before 0035; on a token mint
   *    (`reconnect`), refused while a device holds the station,
   *    so a console tab still running the bundle from before this change cannot reconnect onto a
   *    station the agent moved (it can still rejoin, which is the agent's own choice);
   *  * the session has left: `session_gone`.
   *
   * Never check-then-write: two devices racing a claim (a reconnect against a take-over) must not
   * both read "mine" and both win. A refused claim reads the row back for the copy's
   * `client_kind`; the row may have left in between, which is `session_gone`.
   */
  async claimStationDevice(
    sessionId: string,
    { deviceId, takeOver }: { deviceId: string | null; takeOver: boolean },
    { reconnect = false }: { reconnect?: boolean } = {},
  ): Promise<AgencyStationDeviceClaim> {
    // One statement: `cur` locks the live row, `upd` writes only when the holder changes (a
    // reconnect from the holder writes nothing, so `updated_at` does not move on every mint),
    // and the outer read decides from the same locked row.
    //
    // Mode B (IQ67, OS3): a move that takes the station off the device that holds it while the
    // session is on `away_ring` (or ringing from it: `away_ring_since` is set) ends `away_ring` in
    // the same statement, so no reader ever sees the station on the new device with the session
    // still ringable for the old one: `away_ring_since` is cleared, and a `break/away_ring` row is
    // rewritten to `break/device_away` (a ring in flight keeps its state; its end is the
    // connector's). The rewrite is a transition, logged below.
    const { rows } = await getPool().query<{
      client_kind: AgencyClientKind;
      holder: string | null;
      moved: boolean;
      ended_away_ring: boolean;
      transition: AgencySessionTransitionRow | null;
    }>(
      `WITH cur AS (
         SELECT id, station_device_id, client_kind, state, break_reason, away_ring_since FROM agency_agent_sessions
          WHERE id = $1 AND left_at IS NULL
          FOR UPDATE
       ), upd AS (
         UPDATE agency_agent_sessions s
            SET station_device_id = $2::varchar,
                away_ring_since = NULL,
                break_reason = CASE WHEN cur.state = 'break' AND cur.break_reason = $5::varchar
                                    THEN $6::varchar ELSE s.break_reason END,
                state_since = CASE WHEN cur.state = 'break' AND cur.break_reason = $5::varchar
                                   THEN now() ELSE s.state_since END
           FROM cur
          WHERE s.id = cur.id
            AND cur.station_device_id IS DISTINCT FROM $2::varchar
            AND (($2::varchar IS NULL AND NOT $4::boolean) OR $3::boolean OR cur.station_device_id IS NULL)
          RETURNING s.id AS session_id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
                    cur.state AS from_state, cur.break_reason AS from_break_reason,
                    s.state AS to_state, s.break_reason,
                    ${TRANSITION_AT_SQL},
                    cur.away_ring_since IS NOT NULL AS ended_away_ring
       )
       SELECT cur.client_kind, cur.station_device_id AS holder, EXISTS (SELECT 1 FROM upd) AS moved,
              COALESCE((SELECT ended_away_ring FROM upd), false) AS ended_away_ring,
              (SELECT to_jsonb(upd) - 'ended_away_ring' FROM upd) AS transition
         FROM cur`,
      [sessionId, deviceId, takeOver && deviceId !== null, reconnect, AWAY_RING_BREAK_REASON, DEVICE_AWAY_BREAK_REASON],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: 'session_gone' };
    if (row.moved && row.ended_away_ring) {
      if (row.transition) await this.recordTransitions([row.transition]);
      return { ok: true, endedAwayRing: { previousDeviceId: row.holder } };
    }
    if (row.moved || row.holder === deviceId) return { ok: true };
    return { ok: false, reason: 'held_elsewhere', client_kind: row.client_kind };
  }

  /**
   * The agent's one live session anywhere in the tenant, if any.
   *
   * `LIMIT 1` is a formality, not a choice between candidates: `uq_agency_agent_live_agent`
   * permits at most one live row per agent, in any tenant. It is written this
   * way so a future reader does not have to reason about which row they get.
   */
  async findLiveForAgent(tenantId: string, agentUserId: string): Promise<AgencyAgentSessionRecord | null> {
    const { rows } = await getPool().query<AgencyAgentSessionRecord>(
      `SELECT * FROM agency_agent_sessions
        WHERE tenant_id = $1 AND agent_user_id = $2 AND left_at IS NULL
        LIMIT 1`,
      [tenantId, agentUserId],
    );
    return rows[0] ?? null;
  }

  /**
   * The one mirror write. Every agent-initiated move, every dialer release, the
   * wrap-up entry and both presence paths land here.
   *
   * ── The locking CTE is how the transition log learns `from_state` ──────────
   *
   * `prev` is read in the same statement as the write, so `prev.state` is the
   * state the agent is leaving and `s.state` the one they are entering with no
   * window in between. A `SELECT` before the `UPDATE` would have that window, and
   * another replica moving the agent inside it would make the log record a
   * transition that never happened. It is also why this is not two round trips on
   * the dial path.
   *
   * ── Why `FOR UPDATE`, and not a plain subquery ─────────────────────────────
   *
   * This was `FROM (SELECT … WHERE id = $1) prev`, on the reasoning that a
   * subquery sees the statement's own snapshot and therefore the pre-UPDATE row.
   * That is true, and it is the bug: under READ COMMITTED the snapshot is taken
   * when the statement STARTS. A second writer that blocks on the first's row
   * lock re-checks its WHERE against the updated row when it unblocks
   * (EvalPlanQual) but does NOT re-evaluate the joined subquery — so `prev` is
   * the value from before the wait. Two concurrent moves on one session logged
   * `offline → on_call` and `offline → wrapup`: the second event names a state
   * the agent had already left, which is exactly the "transition that never
   * happened" the paragraph above set out to prevent.
   *
   * A locking clause behaves differently, and that is the whole fix: `FOR UPDATE`
   * waits on the lock and then follows the update chain to the newest committed
   * version of the row, so `prev` is what the previous writer left behind. The
   * single-statement property is unchanged.
   *
   * `state_since` still restamps exactly as before; the log is additive.
   *
   * ── `offline` keeps the break reason unless one is given ───────────────────
   *
   * An `offline` write with no `breakReason` leaves `break_reason` as it was, as
   * `leave` and `markAllOffline` always have. A station drop is not a decision
   * about what the agent was doing: a campaign session on the `soft_phone` break
   * (docs/softphone.md §2) that drops must come back on the soft phone, and
   * nulling the reason here was what let its rehydrate treat it as an ordinary
   * break. The transition log is unaffected: a reason is only ever copied onto a
   * `break` event.
   */
  /**
   * IQ50: of `sessionIds`, the live sessions on a `device_away` pause applied less than `withinMs`
   * ago, each with the pause's age in ms (the database's clock, `state_since` as `setState` wrote
   * it). The inbound connector counts such an agent as one who could take a waiting caller.
   */
  async deviceAwayPauseAges(sessionIds: readonly string[], withinMs: number): Promise<Map<string, number>> {
    if (sessionIds.length === 0) return new Map();
    const { rows } = await getPool().query<{ id: string; age_ms: number }>(
      `SELECT s.id, (EXTRACT(EPOCH FROM (now() - s.state_since)) * 1000)::float8 AS age_ms
         FROM agency_agent_sessions s
        WHERE s.id = ANY($1::uuid[]) AND s.left_at IS NULL
          AND s.state = 'break' AND s.break_reason = $2::text
          AND s.state_since > now() - make_interval(secs => $3::double precision / 1000)`,
      [[...sessionIds], DEVICE_AWAY_BREAK_REASON, withinMs],
    );
    return new Map(rows.map((r) => [r.id, Math.max(0, Number(r.age_ms))]));
  }

  async setState(id: string, state: AgencyAgentState, breakReason?: string | null): Promise<void> {
    const keepReason = state === 'offline' && breakReason === undefined;
    // Mode B (N1, IQ62): `away_ring_since` is the reconcile's key, so every real end of `away_ring`
    // clears it here, in the same write: `available`, `offline`, and any break but `away_ring`
    // itself. A ring's own moves (`reserved`, then `on_call` and `wrapup` once answered) keep it:
    // the ring's end returns the session to `away_ring` (`restoreAwayRing`) or its release to
    // `available` ends it. `break/away_ring` stamps it once per absence (COALESCE: a return to
    // `away_ring` keeps the absence's start). `available` also resets the missed rings.
    const awayRingSince = keepReason
      ? 'NULL'
      : `CASE WHEN $2::varchar = 'break' AND $3::varchar = '${AWAY_RING_BREAK_REASON}' THEN COALESCE(s.away_ring_since, now())
              WHEN $2::varchar IN ('reserved', 'on_call', 'wrapup') THEN s.away_ring_since
              ELSE NULL END`;
    const ringMisses = keepReason ? 's.ring_misses' : "CASE WHEN $2::varchar = 'available' THEN 0 ELSE s.ring_misses END";
    const { rows } = await getPool().query<AgencySessionTransitionRow>(
      sessionTransitionSql({
        prevWhere: 'id = $1',
        set: keepReason
          ? `state = $2::varchar, state_since = now(), updated_at = now(), away_ring_since = ${awayRingSince}`
          : `state = $2::varchar, break_reason = $3::varchar, state_since = now(), updated_at = now(),
             away_ring_since = ${awayRingSince}, ring_misses = ${ringMisses}`,
      }),
      keepReason ? [id, state] : [id, state, breakReason ?? null],
    );
    await this.recordTransitions(rows);
  }

  // ─── Mode B: `away_ring` (IQ66, IQ67, N1) ───────────────────────────────────

  /**
   * A ring that ended unanswered restores the mirror (N1): `break/away_ring` again, only while the
   * session is live and still on its absence (`away_ring_since` set: nothing ended it meanwhile).
   * The ring's `setState('reserved')` nulled the reason; `releaseInboundToAwayRing` (Redis) and this
   * are the pair `AwayRingService.releaseInbound` runs. True: written.
   */
  async restoreAwayRing(id: string): Promise<boolean> {
    const { rows } = await getPool().query<AgencySessionTransitionRow>(
      sessionTransitionSql({
        prevWhere: 'id = $1 AND left_at IS NULL AND away_ring_since IS NOT NULL',
        set: `state = 'break', break_reason = $2::varchar, state_since = now(), updated_at = now()`,
      }),
      [id, AWAY_RING_BREAK_REASON],
    );
    await this.recordTransitions(rows);
    return rows.length > 0;
  }

  /**
   * End `away_ring` in the mirror (IQ67): `device_away`, on `break` (a station is attached) or
   * `offline` (none), and `away_ring_since` cleared. Only a live row still on its absence; null
   * when there is none (something else ended it first). Returns what the push and the audit need.
   */
  async endAwayRing(id: string, state: 'break' | 'offline'): Promise<AgencyAwayRingEnded | null> {
    // On its absence: `away_ring_since` set, OR the row still reads `break/away_ring`. The second
    // arm covers the reconcile's `clearAwayRingSince` landing between the end's Redis write and
    // this one (it read Redis already off `away_ring`): without it this matched nothing and the
    // row stayed `break/away_ring` with no `ring_off` and no audit.
    const { rows } = await getPool().query<AgencySessionTransitionRow & { station_device_id: string | null }>(
      `${sessionTransitionSql({
        prevWhere: `id = $1 AND left_at IS NULL AND (away_ring_since IS NOT NULL OR (state = 'break' AND break_reason = '${AWAY_RING_BREAK_REASON}'))`,
        set: `state = $2::varchar, break_reason = $3::varchar, state_since = now(), updated_at = now(), away_ring_since = NULL`,
      })}, s.station_device_id`,
      [id, state, DEVICE_AWAY_BREAK_REASON],
    );
    await this.recordTransitions(rows);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.session_id,
      tenant_id: row.tenant_id,
      account_id: row.account_id,
      campaign_id: row.campaign_id,
      agent_user_id: row.agent_user_id,
      station_device_id: row.station_device_id,
      from_state: row.from_state ?? 'offline',
    };
  }

  /**
   * Drop `away_ring_since` alone (no state written, nothing logged): the reconcile found Redis off
   * `away_ring` with nothing in flight, so whatever moved it already ended the absence and only
   * the mirror's key was left behind.
   */
  async clearAwayRingSince(id: string): Promise<void> {
    await getPool().query(
      'UPDATE agency_agent_sessions SET away_ring_since = NULL, updated_at = now() WHERE id = $1 AND away_ring_since IS NOT NULL',
      [id],
    );
  }

  /** Every live session on `away_ring` or ringing from it, with its station's push device (N1). */
  async findAwayRingCandidates(): Promise<AgencyAwayRingCandidate[]> {
    const { rows } = await getPool().query<AgencyAwayRingCandidate>(
      `SELECT s.id, s.tenant_id, s.account_id, s.campaign_id, s.kind, s.agent_user_id, s.state, s.break_reason,
              s.state_since, s.away_ring_since, s.station_device_id,
              d.platform AS device_platform,
              d.ring_enabled AS device_ring_enabled,
              CASE WHEN d.id IS NULL THEN NULL ELSE d.revoked_at IS NOT NULL END AS device_revoked,
              CASE WHEN d.id IS NULL THEN NULL
                   ELSE (CASE WHEN d.platform = 'android' THEN d.fcm_token ELSE d.voip_token END) IS NOT NULL END AS device_has_token
         FROM agency_agent_sessions s
         LEFT JOIN agency_push_devices d ON d.user_id = s.agent_user_id AND d.device_id = s.station_device_id
        WHERE s.away_ring_since IS NOT NULL AND s.left_at IS NULL
        ORDER BY s.away_ring_since`,
    );
    return rows;
  }

  /**
   * The account's sessions whose phone may be rung for an inbound caller (Mode B, docs/inbound.md
   * "Ringing an away phone"): live campaign sessions on an absence (`away_ring_since` set, N1)
   * joined to the push device that holds their station, usable for a ring, and short of
   * {@link AGENCY_INBOUND_RING_MAX_MISSES} missed rings (IQ62: one that reached it is ending, and is
   * never rung meanwhile). One statement, on `idx_agency_agent_sessions_away_ring` (0037); whether
   * Redis says `break, ring = 1` (or the ring in flight) is the caller's read.
   */
  async findRingableInAccount(tenantId: string, accountId: string): Promise<AgencyRingableSession[]> {
    const { rows } = await getPool().query<AgencyRingableSession>(
      `SELECT s.id, s.agent_user_id, s.campaign_id, d.platform AS device_platform
         FROM agency_agent_sessions s
         JOIN agency_push_devices d ON d.user_id = s.agent_user_id AND d.device_id = s.station_device_id
        WHERE s.tenant_id = $1 AND s.account_id = $2
          AND s.away_ring_since IS NOT NULL AND s.left_at IS NULL
          AND s.kind = 'campaign' AND s.campaign_id IS NOT NULL
          AND s.ring_misses < $3
          AND d.revoked_at IS NULL AND d.ring_enabled
          AND (CASE WHEN d.platform = 'android' THEN d.fcm_token ELSE d.voip_token END) IS NOT NULL`,
      [tenantId, accountId, AGENCY_INBOUND_RING_MAX_MISSES],
    );
    return rows;
  }

  /**
   * One more missed ring in a row (IQ62: expired, or answered and not bound in the grace). Returns
   * the count now; 0 when the session is gone or has left.
   */
  async noteRingMiss(id: string): Promise<number> {
    const { rows } = await getPool().query<{ ring_misses: number }>(
      `UPDATE agency_agent_sessions SET ring_misses = ring_misses + 1, updated_at = now()
        WHERE id = $1 AND left_at IS NULL RETURNING ring_misses`,
      [id],
    );
    return rows[0]?.ring_misses ?? 0;
  }

  /** The missed rings in a row now (IQ62); 0 when the session is gone or has left. */
  async ringMisses(id: string): Promise<number> {
    const { rows } = await getPool().query<{ ring_misses: number }>(
      'SELECT ring_misses FROM agency_agent_sessions WHERE id = $1 AND left_at IS NULL',
      [id],
    );
    return rows[0]?.ring_misses ?? 0;
  }

  /**
   * An answered ring bound: the missed rings reset (IQ62), and the absence it was rung from is
   * over (`away_ring_since` cleared: the agent is in the app, on the call). Otherwise a release
   * that never writes `available` (a queued `away_ring` after the wrap-up) would start the next
   * absence with this one's start, and the maximum age would end it early.
   */
  async ringAnswered(id: string): Promise<void> {
    await getPool().query(
      `UPDATE agency_agent_sessions SET ring_misses = 0, away_ring_since = NULL, updated_at = now()
        WHERE id = $1 AND (ring_misses <> 0 OR away_ring_since IS NOT NULL)`,
      [id],
    );
  }

  /**
   * The agent's live session whose station `deviceId` holds while it is on `away_ring` (or ringing
   * from it), in any tenant (one live session per agent, OS1): what "Stop ringing" and a removed
   * device end.
   */
  async findLiveAwayRingForDevice(agentUserId: string, deviceId: string): Promise<AgencyAgentSessionRecord | null> {
    const { rows } = await getPool().query<AgencyAgentSessionRecord>(
      `SELECT * FROM agency_agent_sessions
        WHERE agent_user_id = $1 AND station_device_id = $2 AND left_at IS NULL AND away_ring_since IS NOT NULL
        LIMIT 1`,
      [agentUserId, deviceId],
    );
    return rows[0] ?? null;
  }

  /**
   * Move a session from the soft phone's break to another break reason (SP7), unless
   * it holds an unsettled soft-phone call: `{ ok: false }` then, and nothing written.
   *
   * Serialised with the dial on the session ROW LOCK. `SoftphoneService.placeCall`
   * locks this row (`FOR UPDATE`) in the transaction that inserts the call, and
   * refuses there unless the row's reason is still `soft_phone`. Here the lock is
   * taken first, then the unsettled call is read in a LATER statement, so its snapshot
   * includes a dial that committed while this waited, and the reason is written under
   * the same lock. Either the dial commits first and this refuses, or this commits
   * first and the dial refuses `not_on_softphone`: no session ends up on another break
   * holding a live soft-phone call. (One statement with a `NOT EXISTS` would not do: a
   * statement that waited on the lock re-checks its row, not its subquery's snapshot.)
   */
  async setBreakLeavingSoftphone(id: string, breakReason: string): Promise<{ ok: boolean }> {
    const client = await getPool().connect();
    let rows: AgencySessionTransitionRow[];
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM agency_agent_sessions WHERE id = $1 FOR UPDATE', [id]);
      const owed = await client.query(
        'SELECT 1 FROM agency_manual_calls WHERE session_id = $1 AND settled_at IS NULL LIMIT 1',
        [id],
      );
      if (owed.rowCount) {
        await client.query('ROLLBACK');
        return { ok: false };
      }
      ({ rows } = await client.query<AgencySessionTransitionRow>(
        sessionTransitionSql({
          prevWhere: 'id = $1',
          set: "state = 'break', break_reason = $2, state_since = now(), updated_at = now()",
        }),
        [id, breakReason],
      ));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await this.recordTransitions(rows);
    return { ok: true };
  }

  async heartbeat(id: string): Promise<void> {
    await getPool().query(
      'UPDATE agency_agent_sessions SET last_heartbeat = now(), updated_at = now() WHERE id = $1',
      [id],
    );
  }

  /**
   * Leave the station. Logged like any other transition — the `offline` event is
   * what closes the agent's last interval, so an unlogged leave would leave that
   * interval open and running to `min(now, bucket_end)` forever.
   *
   * `left_at IS NULL` on the UPDATE, so a repeated leave writes nothing and
   * therefore logs nothing: zero rows returned, zero events.
   */
  async leave(id: string): Promise<void> {
    const { rows } = await getPool().query<AgencySessionTransitionRow>(
      sessionTransitionSql({
        prevWhere: 'id = $1',
        set: "state = 'offline', left_at = now(), updated_at = now(), away_ring_since = NULL",
        where: 's.left_at IS NULL',
      }),
      [id],
    );
    await this.recordTransitions(rows);
  }

  /** Live sessions on a campaign, whatever their state. */
  async findLiveForCampaign(campaignId: string): Promise<AgencyAgentSessionRecord[]> {
    const { rows } = await getPool().query<AgencyAgentSessionRecord>(
      'SELECT * FROM agency_agent_sessions WHERE campaign_id = $1 AND left_at IS NULL',
      [campaignId],
    );
    return rows;
  }

  /**
   * Every session → offline. The startup reaper's agent half.
   *
   * Logged, and this one matters more than it looks: it is the transition that
   * closes every interval the CRASHED process left open. Without it, an agent who
   * was `on_call` when the replica died would have an interval running from that
   * moment to `min(now, bucket_end)` — the whole outage attributed to their
   * on-call time — and the next thing they do would start a second one. The
   * event's `at` is the reap, so the outage is charged to `offline` from the reap
   * onward and to whatever they were doing up to it. The span between the crash
   * and the reap is still mis-attributed to the pre-crash state; that is
   * irreducible without a heartbeat-derived end, and it is bounded by the boot
   * time of one replica.
   *
   * The bulk `FROM (SELECT …)` self-join is the same idiom as `setState`, applied
   * per row: the subquery is the pre-update snapshot of exactly the rows the
   * UPDATE will touch, joined back on `id`. Returning the rows rather than
   * `rowCount` also makes the count the length of what was actually written.
   */
  /** Every live session's id (not left). The media-worker slot reap filters it by slot. */
  async findLiveIds(): Promise<string[]> {
    const { rows } = await getPool().query<{ id: string }>('SELECT id FROM agency_agent_sessions WHERE left_at IS NULL');
    return rows.map((r) => r.id);
  }

  async markAllOffline(): Promise<number> {
    const { rows } = await getPool().query<AgencySessionTransitionRow>(
      sessionTransitionSql({
        prevWhere: "left_at IS NULL AND state <> 'offline'",
        set: "state = 'offline', updated_at = now()",
      }),
    );
    await this.recordTransitions(rows);
    return rows.length;
  }
}

export const agencyAgentSessionRepository = new AgencyAgentSessionRepository();
