import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
// The `23505` predicate, matched on the CONSTRAINT NAME. A leaf module (see its
// header) so the catch arms below can ask the question without dragging config
// into the graph of every test that exercises them.
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
// BEGIN / COMMIT / ROLLBACK / release, and joining a caller's transaction (decision
// B8). A leaf too: the pool is passed in, so the `getPool` mock stays in charge.
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { createChildLogger } from '@magick-agency/observability';
import {
  AGENCY_ATTEMPT_LIVE_STATES,
  type AgencyAgentSessionRecord,
  type AgencyCallAttemptRecord,
  type AgencyContactInput,
  type AgencyContactRecord,
  type AgencyLapsedWrapupRow,
} from '../models/agency.model.js';
// The supervisor read surface's cursor. `KEYSET_AT_SQL` is projected
// alongside every paged row so the cursor carries `created_at` at its true
// MICROSECOND precision — see that module for why a millisecond round-trip
// silently drops rows.
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type { AgencyAttemptFilters, AgencyContactFilters } from '../../agency/spine-filters.js';
// A LEAF module by design — see its header. Importing the predicate from the
// metrics module instead would give this repository a dependency on the thing it
// exists to independently audit.
import {
  ABANDONED_ATTEMPT_PREDICATE_SQL,
  ABANDONMENT_WINDOW_HOURS,
  type AgencyAbandonmentWindowRow,
} from '@magick-agency/domain/abandonment-predicate';
import { PRIOR_ATTEMPT_LIMIT } from '@magick-agency/domain/retry-campaign-bounds';
// The roster's rate-reportability floor. Imported rather than restated because it
// is a SHARED number: the console renders "not enough calls" from the same
// threshold, and a second copy here is how these percentiles come to exclude a
// row the console still labels reportable.
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '@magick-agency/contracts/agency';
import type {
  AgencyAgentOccupancy,
  AgencyAgentState,
  AgencyAgentStats,
  AgencyAgentStatsBucket,
  AgencyAgentCampaignRow,
  AgencyAbandonReason,
  AgencyAttemptOutcome,
  AgencyAttemptState,
  AgencyAttemptRow,
  AgencyContactRow,
  AgencyContactDetail,
  AgencyGroupDimension,
  AgencyGroupKey,
  AgencyGroupPage,
  AgencyGroupRow,
  AgencyGroupSort,
  AgencyKeysetPage,
  AgencyRosterAgentRow,
  AgencyRosterBenchmark,
  AgencyRosterPage,
} from '@magick-agency/contracts/agency';
// THE null-not-zero rate rule, in one place. Imported rather than re-expressed at
// each of the five call sites below — see the module for why a `0` on an empty
// denominator is the failure this exists to prevent.
import { ratePct, ratio } from '@magick-agency/domain/rates';
// The agent record's parsed window, its bucket vocabulary and the ONE spelling of
// a bucket boundary. `bucketStartSql` is shared by both aggregates below so the
// attempt buckets and the occupancy buckets cannot be cut differently.
// The roster read adds its own three: the ranking rule (nulls last both ways,
// `agent_user_id` as the tiebreaker), the percentile rule, and the parsed params.
// All three are pure and live there so they can be exercised without a pool — see
// `roster()` for why the ranking cannot happen in SQL at all.
import {
  bucketStartSql,
  bucketTruncSql,
  foldOccupancy,
  groupedPageHasSingleZone,
  rosterPercentiles,
  sortRosterRows,
  zeroOccupancy,
} from '../../agency/agent-record.js';
import type {
  AgentAttemptFilters,
  AgentGroupedParams,
  AgentRosterParams,
  AgentStatsParams,
} from '../../agency/agent-record.js';
// THE single definition of "the same number", imported rather than re-expressed.
// `DncRegistry.check` runs this on both sides of its comparison and
// `markDnc` runs it before storing; `suppressByPhone` below must agree
// with both to the byte or it suppresses a different set of rows than the mark
// claims to have suppressed. See its own header for why a second, SQL-shaped copy
// of this rule was deliberately not written.
import { normalizeE164 } from '../../agency/dnc-registry.js';
import {
  AGENCY_ATTEMPT_METRICS_SQL,
  AGENCY_RESOLVED_ZONE_JOIN_SQL,
  AGENCY_RESOLVED_ZONE_SQL,
  CONTACT_PHONE_DIGITS_SQL,
  occupancyIntervalsCtes,
  readAttemptMetrics,
} from './agency/sql-fragments.js';
import {
  attemptFilterConditions,
  contactFilterConditions,
  keysetCondition,
  params,
  phoneCondition,
  toKeysetPage,
} from './agency/query-builders.js';
import { hasRateDenominator, projectAttemptRow, projectContactRow } from './agency/projections.js';

export { occupancyIntervalsCtes } from './agency/sql-fragments.js';
export { AgencyCampaignRepository, agencyCampaignRepository } from './agency/campaign.repository.js';

const log = createChildLogger({ component: 'agency-repository' });

/** Result of applying one roster-ingest chunk. */
interface AgencyIngestResult {
  accepted: number;
  duplicate_chunk: boolean;
  total_contacts: number;
  /**
   * Rows this chunk carried that the roster already held **exactly** — same
   * phone, same `context`, same `timezone` — and which were therefore discarded.
   *
   * The identity is the row's CONTENT, not its position in the file (job-id
   * namespacing would be the wrong key). That makes this number narrow and
   * useful: not "this campaign is already populated" but "you sent us these exact people
   * again". A top-up carrying genuinely new rows reports zero here.
   *
   * Reported rather than silently absorbed because `accepted: 0` otherwise has
   * two completely different meanings to an operator — "this chunk held no valid
   * rows" and "every row you sent was already on the roster" — and the ingest
   * job cannot tell them which if all it receives is a zero.
   *
   * Note this is **not** the same signal as `duplicate_chunk`, which means the
   * whole chunk was replayed under the same idempotency key (a retry, and
   * success). This one is a *different* job carrying rows we already hold — the
   * shape a re-upload after a server restart takes (the ingest job mints a fresh
   * job id on every run), and the case the row-level index carries alone.
   */
  rejected_duplicate_rows: number;
  /**
   * The `source_row_number`s of the discarded rows, capped — enough for the
   * ingest summary to name them without an unbounded payload on a 1M-row
   * campaign. When `rejected_duplicate_rows` exceeds the cap, this is a sample, not
   * the set. Rows carrying no row number are counted above but cannot be named
   * here.
   */
  duplicate_source_rows: number[];
  /**
   * Set (and only ever `true`) when this is a REPLAY of a chunk applied without
   * recorded rejection counts.
   *
   * **`rejected_duplicate_rows: 0` alongside this flag means "unknown", not
   * "none".** That reading matters: a replay that reported a confident zero
   * would make the operator's ingest summary undercount what the original
   * application refused. It can never overcount.
   *
   * Absent on every other response — every fresh application, and every replay of
   * a chunk that recorded its counts, where the recorded number (including a
   * recorded 0) is exact. Absence therefore means "these counts are trustworthy",
   * which is the fail-safe default: a reader that ignores the flag never
   * mistrusts good counts.
   *
   * Deliberately a separate boolean rather than making `rejected_duplicate_rows`
   * nullable — the ingest job (`agency-ingest.service.ts`) sums that field as a
   * number into the summary the console renders, so widening its type would
   * break both. This adds surface instead of changing it.
   */
  rejection_counts_unavailable?: boolean;
}

/**
 * How many colliding row numbers to name back. A sample, not the set.
 *
 * Bounds what is STORED as well as what is returned: the sample is
 * persisted on the chunk marker so a replay can reproduce it, and an unbounded
 * array on a table holding one row per 500-row chunk of every roster ever uploaded
 * is not something to write down.
 */
const MAX_REPORTED_DUPLICATE_ROWS = 20;

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

export class AgencyContactRepository {
  /**
   * Claim up to `limit` dialable contacts for this tick.
   *
   * `FOR UPDATE SKIP LOCKED` is the correctness mechanism, not an optimisation:
   * with it, even a split-brain window — GC pause, partition, clock skew — cannot
   * hand the same contact to two leaders. The Redis leader lease is only the
   * efficiency mechanism that stops us doing the work twice.
   *
   * The first three terms are exactly what `idx_agency_contacts_dialable` serves,
   * which is why anything not dialable right now must not satisfy them.
   *
   * ── The fourth term, and why it is NOT in the index ──────────────────────
   *
   * `suppressed_reason IS DISTINCT FROM 'dnc'` is DEFENCE IN DEPTH on a
   * compliance-terminal action. The real fix is in {@link markState}, which
   * refuses to move a DNC suppression at all; this term is what makes a future
   * path that finds a way around that guard still unable to dial the number.
   * Two properties, deliberately, because they fail independently — a `pending`
   * row is only harmful if something claims it.
   *
   * ⚠️ `IS DISTINCT FROM`, never `<> 'dnc'`. The column is NULL for the entire
   * roster, `NULL <> 'dnc'` is NULL, and a NULL conjunct is not TRUE — the
   * campaign would claim nothing and stall looking exactly like an empty list.
   *
   * **The index is deliberately left alone, and the plan is unaffected.** An
   * extra conjunct never disqualifies a partial index: Postgres still uses
   * `idx_agency_contacts_dialable` for `campaign_id`/`state`/`next_attempt_at`
   * and applies this one as a filter on the tuples it returns. Narrowing the
   * index's own predicate to match would mean `DROP INDEX` + `CREATE INDEX`
   * under `ACCESS EXCLUSIVE` inside the startup migration transaction (where
   * `CONCURRENTLY` is not available) — blocking THE hot dialing
   * query on up to 1M rows — to remove a handful of rows from an index. The rows
   * this term excludes are ones the `markState` guard makes impossible to create
   * going forward, so the selectivity won back is ~zero and the lock is not.
   *
   * That does mean the predicate is no longer *identical* to the index's, which
   * is a real weakening of the rule that the claim's predicate IS the index's.
   * The rule that still holds,
   * and the one to check a future term against: every term must either be served
   * by the index or be cheap to evaluate on an already-narrowed row set. A term
   * that is neither belongs in the index, migration cost and all.
   */
  async claimDialable(campaignId: string, limit: number): Promise<AgencyContactRecord[]> {
    if (limit <= 0) return [];
    const { rows } = await getPool().query<AgencyContactRecord>(
      `UPDATE agency_contacts SET state = 'in_flight', updated_at = now()
        WHERE id IN (
          SELECT id FROM agency_contacts
           WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at <= now()
             AND suppressed_reason IS DISTINCT FROM 'dnc'
           ORDER BY next_attempt_at
             FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
      RETURNING *`,
      [campaignId, limit],
    );
    return rows;
  }

  /**
   * Return a claimed contact to the pool.
   *
   * `nextAttemptAt` must move the clock forward for any condition that has NOT
   * cleared. A contact returned with `now()` because it was outside its
   * calling window is re-claimed on the very next tick, and a campaign whose
   * contacts are all out of hours spins at 4 claims/second all night burning agent
   * reservations on calls it will never place.
   */
  async unclaim(contactId: string, nextAttemptAt: Date): Promise<void> {
    await getPool().query(
      `UPDATE agency_contacts
          SET state = 'pending', next_attempt_at = $2, updated_at = now()
        WHERE id = $1 AND state = 'in_flight'`,
      [contactId, nextAttemptAt],
    );
  }

  /**
   * {@link unclaim} for several contacts in one statement, all at the same
   * `nextAttemptAt` (the same rule applies: move the clock forward for anything
   * that has not cleared). The pacing tick returns a halted batch this way.
   */
  async unclaimMany(contactIds: readonly string[], nextAttemptAt: Date): Promise<void> {
    if (contactIds.length === 0) return;
    await getPool().query(
      `UPDATE agency_contacts
          SET state = 'pending', next_attempt_at = $2, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND state = 'in_flight'`,
      [contactIds, nextAttemptAt],
    );
  }

  /**
   * Charge one attempt against a contact's retry budget and report the new total.
   *
   * Exists because the outcome policy needs the **post-bump** count and `markState`
   * bumps inside its own `UPDATE`, returning nothing — so a caller that both bumps
   * and decides had no way to learn the number it was deciding on. Reading the row
   * first and adding one in TypeScript would be a read-then-write race with anything
   * else touching the contact; letting Postgres do the arithmetic and return the
   * result cannot be raced.
   *
   * **Deliberately does not set `state`.** The caller writes the state afterwards,
   * from the decision this count produces. The contact is `in_flight` in between,
   * which is safe by construction: `claimDialable` only ever claims `pending`, so
   * nothing can pick it up, and a crash in the gap leaves exactly the stuck
   * `in_flight` row the reaper's periodic sweep already exists to requeue.
   */
  async chargeAttempt(contactId: string, outcome: string | null): Promise<number> {
    const { rows } = await getPool().query<{ attempt_count: number }>(
      `UPDATE agency_contacts
          SET attempt_count = attempt_count + 1,
              last_outcome  = COALESCE($2, last_outcome),
              updated_at    = now()
        WHERE id = $1
        RETURNING attempt_count`,
      [contactId, outcome],
    );
    return rows[0]?.attempt_count ?? 0;
  }

  /**
   * Charge one OUR-FAULT redial and report the new total.
   *
   * The deliberate omission is `attempt_count`. This is the whole point: an
   * agent's socket dropping before the call bridged, or our own replica dying
   * mid-attempt, must not spend the CUSTOMER's retry allowance — with
   * `max_attempts: 3`, three of our faults would otherwise retire someone whose
   * phone was never even answered.
   *
   * Mirrors {@link chargeAttempt}'s shape for the same reason it exists: the
   * bound is evaluated on the POST-bump count, and reading the row first then
   * adding one in TypeScript would be a read-then-write race. Postgres does the
   * arithmetic and returns the result, which cannot be raced.
   *
   * Like `chargeAttempt`, deliberately does not set `state` — the caller writes
   * it from the decision this count produces.
   */
  async chargeOurFaultAttempt(contactId: string, outcome: string | null): Promise<number> {
    const { rows } = await getPool().query<{ our_fault_attempts: number }>(
      `UPDATE agency_contacts
          SET our_fault_attempts = our_fault_attempts + 1,
              last_outcome       = COALESCE($2, last_outcome),
              updated_at         = now()
        WHERE id = $1
        RETURNING our_fault_attempts`,
      [contactId, outcome],
    );
    return rows[0]?.our_fault_attempts ?? 0;
  }

  /**
   * Write a contact's state, with **one transition the database refuses**: a row
   * carrying `suppressed_reason = 'dnc'` stays `suppressed`, whatever was asked.
   *
   * ── The defect this closes ────────────────────────────────────────────────
   *
   * An agent presses mark-DNC mid-call; {@link suppressByPhone} writes
   * `suppressed`/`dnc`. The call then ends on an AGENT-SIDE path — the station
   * socket drops after the bridge, or this replica dies and the reaper writes
   * `orphaned` — and that path calls this method with the outcome policy's answer.
   * `DEFAULT_RETRY_POLICY` carries `agent_disconnected: { 5min, ×3 }` and
   * `orphaned: { 0min, ×3 }`, so `resolveRetryDecision` and
   * `resolveOurFaultRedial` both answer `pending`; `claimDialable` used to gate on
   * `state = 'pending'` alone. The roster then hands the customer who said "stop
   * calling me" back to the same campaign's dialer inside five minutes, with
   * `dnc_recorded: true` and every dashboard green.
   *
   * The dial-time check also refuses that number: `markDnc` writes a
   * campaign-scoped `dnc_entries` row in the mark's own transaction (decision B8),
   * and `DncRegistry.check` widens by scope, so the pre-dial gate suppresses the
   * contact before a dial. This guard is the roster-side half and must hold on its
   * own: without it the contact row says `pending` for a number the list refuses,
   * and every reader of the roster sees a dialable contact.
   *
   * ── Why the guard is keyed on the REASON ──────────────────────────────────
   *
   * Not on the TARGET state being `pending`: the `bridged` handler writes
   * `'connected'`, and `agency-dialer.ts` records at that site that its write can
   * land AFTER the `ended` handler's because lifecycle listeners are
   * fire-and-forget. A target-keyed guard lets `connected` launder the row out of
   * `suppressed`, after which nothing is guarded at all.
   *
   * Not on the current STATE being `suppressed`: `invalid` (the pre-dial gate,
   * `resolveRetryDecision`) and ingest suppression are data-quality states other
   * subsystems may legitimately move, and freezing them is a behaviour change
   * nobody asked for and a way to strand contacts.
   *
   * `suppressed_reason = 'dnc'` is exactly the compliance-terminal predicate, and
   * the reason itself is frozen the same way as the state. A plain
   * `COALESCE($7, suppressed_reason)` means "the caller's value, else keep what
   * is there" — the same argument-order trap {@link suppressByPhone} documents —
   * so a later caller that PASSES a reason overwrites `dnc`. The `invalid`
   * outcome path does (`resolveRetryDecision` returns `suppressedReason:
   * 'invalid'`, and `agency-dialer.ts` forwards it). After that both this CASE
   * freeze and `claimDialable`'s `IS DISTINCT FROM 'dnc'` filter no longer apply,
   * and a following `pending` write puts the number back on the roster.
   *
   * The ELSE branch keeps the ordinary COALESCE so a first write of `dnc` (the
   * `do_not_call` disposition) still lands, and so an `invalid` reason on a row
   * that is not DNC is still writable. {@link suppressByPhone} is the mark itself
   * and does not go through this method.
   *
   * ── Why a rewrite, not a `WHERE` ──────────────────────────────────────────
   *
   * `WHERE … AND suppressed_reason IS DISTINCT FROM 'dnc'` would refuse the whole
   * UPDATE. Mark-DNC on a live call is supported and the agent's write-up arrives
   * AFTERWARDS through the disposition route, which reaches this method carrying
   * `last_disposition`; refusing the row would silently drop the record of what
   * was said. So the STATE and the retry instant are frozen and every
   * record-keeping column still lands.
   *
   * `THEN 'suppressed'` rather than `THEN state` is also deliberate: a row left
   * `pending` + `dnc` by a pre-fix build — those exist in production, written by
   * exactly the path above — self-heals the next time anything touches it, and a
   * pre-dial gate that wants to suppress such a row is not itself refused.
   *
   * `next_attempt_at` is frozen for the reason `agency.routes.ts` already records
   * for the losing disposition arm: inert for dialing, but "suppressed, next call
   * Wednesday" is the precedence contradicting itself in a field a console and a
   * compliance export both read.
   *
   * ── Every caller, and the decision about each ─────────────────────────────
   *
   * The guard is HERE and not at the call sites because one of them (`reaper.ts`'s
   * orphan requeue) hardcodes `'pending'` rather than taking a decision, and a
   * rule spelled nine times is a rule with eight chances to be forgotten. The
   * enumeration is recorded so a future reader can check a new caller against it
   * rather than re-deriving which ones mattered:
   *
   *   * `agency-dialer.ts` outcome branch — `resolveRetryDecision` ⇒ `'pending'`
   *     for any retryable outcome under its cap. **THE reported defect.** Guarded.
   *   * `agency-dialer.ts` our-fault branch — `resolveOurFaultRedial` ⇒ `'pending'`
   *     for `agent_disconnected` under the bound. The second half of the same
   *     defect, and the likelier one: it is the agent-side drop the report names.
   *     Guarded.
   *   * `agency-dialer.ts` `bridged` / `connected` writes — `'connected'`. Not
   *     `pending`, but its own comment records that this write can land AFTER the
   *     `ended` handler's, which would launder the row out of `suppressed` and
   *     leave the NEXT write unguarded. Guarded, and the reason the key is the
   *     reason rather than the target state.
   *   * `reaper.ts` lapsed-wrap-up sweep — `resolveRetryDecision` ⇒ `'pending'`.
   *     Guarded.
   *   * `reaper.ts` our-fault-bounded retire — terminal states only. Guarded
   *     anyway; `suppressed` is at least as terminal as what it asked for.
   *   * `reaper.ts` orphan requeue — literal `'pending'`. Guarded.
   *   * `agency.routes.ts` disposition — a disposition decision, which can be
   *     `'pending'` (a callback). Guarded on the state; `last_disposition` still
   *     lands, deliberately.
   *   * `pacing-engine.ts` pre-dial gate — `'suppressed'`. A no-op under the
   *     guard, which is correct, and the `THEN 'suppressed'` branch means it can
   *     still park a legacy `pending` + `dnc` row where it belongs.
   *   * {@link unclaim} — writes `'pending'` but is already
   *     `WHERE state = 'in_flight'`, which a suppressed row cannot satisfy. No
   *     change, and it is the one caller that needed none.
   *   * {@link suppressByPhone} — writes the DNC suppression itself and must not
   *     be guarded by it.
   *   * `applyIngestChunk` — INSERTs new rows at the `pending` column default. Out
   *     of scope by construction: a re-uploaded roster row is a NEW contact with
   *     no reason to freeze, and the dial-time read of `dnc_entries` is what
   *     covers a re-upload.
   */
  async markState(
    contactId: string,
    state: string,
    patch: {
      last_outcome?: string | null;
      last_disposition?: string | null;
      next_attempt_at?: Date | null;
      suppressed_reason?: string | null;
      bump_attempt?: boolean;
    } = {},
  ): Promise<boolean> {
    // The CASE expressions read the row's PRE-update `suppressed_reason`, which is
    // what makes the DNC write itself (`suppressed_reason = 'dnc'` arriving in
    // `$7` on a row that has none yet) take the ELSE branch and land normally.
    // The reason column is frozen the same way: COALESCE($7, col) would let a
    // later non-null $7 (the `invalid` outcome) strip `dnc` and un-key the guard.
    const { rows } = await getPool().query<{ state: string; suppressed_reason: string | null }>(
      `UPDATE agency_contacts
          SET state = CASE WHEN suppressed_reason = 'dnc' THEN 'suppressed' ELSE $2 END,
              attempt_count = attempt_count + $3,
              last_outcome = COALESCE($4, last_outcome),
              last_disposition = COALESCE($5, last_disposition),
              next_attempt_at = CASE WHEN suppressed_reason = 'dnc' THEN next_attempt_at ELSE COALESCE($6, next_attempt_at) END,
              suppressed_reason = CASE WHEN suppressed_reason = 'dnc' THEN suppressed_reason ELSE COALESCE($7, suppressed_reason) END,
              updated_at = now()
        WHERE id = $1
      RETURNING state, suppressed_reason`,
      [
        contactId,
        state,
        patch.bump_attempt ? 1 : 0,
        patch.last_outcome ?? null,
        patch.last_disposition ?? null,
        patch.next_attempt_at ?? null,
        patch.suppressed_reason ?? null,
      ],
    );

    // Postgres decided; this only reports. `RETURNING` is what makes the refusal
    // observable at all — without it the guard is a statement that quietly does
    // less than its caller believes, which is the shape of the defect it closes.
    // `warn` rather than `error`: the guard doing its job is not a fault, but an
    // outcome path repeatedly bouncing off a DNC row is something an operator
    // wants to be able to see.
    const landed = rows[0];
    if (landed && landed.state !== state) {
      log.warn(
        {
          contactId,
          requestedState: state,
          state: landed.state,
          suppressedReason: landed.suppressed_reason,
        },
        'Refused a state transition on a DNC-suppressed contact — the row stays suppressed',
      );
    }

    /**
     * ── Whether the requested state actually LANDED ──────────────────────────
     *
     * Returned as of 2026-09-11, because resolving `void` made this function
     * indistinguishable from success to every caller, and one of them was using
     * "the await did not reject" as proof of a durable retirement.
     *
     * Two ways this resolves without the requested state landing, and neither
     * throws:
     *
     * 1. **The DNC guard refused it.** The `CASE` above keeps a `dnc`-suppressed
     *    row `suppressed` and the statement still succeeds — that is the whole
     *    design, and the warn above is the only trace.
     * 2. **No row matched** (`rows[0]` undefined) — a contact id that is not
     *    there. `UPDATE … WHERE id = $1` affecting zero rows is not an error.
     *
     * Callers that only care about "best-effort bookkeeping" can keep ignoring
     * this, which is why the change is additive rather than a thrown error. But
     * a caller drawing a CONCLUSION from the write — incrementing a counter that
     * asserts a person was permanently retired, say — must gate on it. See
     * `agency_our_fault_retirement_total`'s two producers.
     */
    return landed !== undefined && landed.state === state;
  }

  /**
   * Suppress EVERY roster row in this campaign that carries this number — not
   * just the one an attempt points at.
   *
   * ── Why this exists, and what breaks without it ──────────────────────────
   *
   * `markState(attempt.contact_id, …)` takes ONE row off this campaign's
   * roster. The `dnc_entries` row `markDnc` writes in the same transaction
   * (decision B8) stops the dial-time check passing the number for the whole
   * campaign, but it does not touch the roster: a second row with the same number
   * would stay `pending`, and every reader of the roster would count it dialable.
   *
   * That second row is not hypothetical. The schema refuses a
   * `UNIQUE (campaign_id, phone_e164)` **on purpose** — "two people on one
   * household landline, two contacts behind one company switchboard, a shared
   * family mobile" are legitimate rows and dropping one is data loss — so one
   * campaign holding the same number twice is a supported, common state. Suppress
   * only the dialled row and the duplicate stays `pending`: the roster goes on
   * offering a customer who said "stop calling me" to the same campaign, with
   * every dashboard green, and only the dial-time check stands between that row
   * and a call.
   *
   * DNC is a property of the NUMBER, never of the roster row, which is why every
   * row matching it goes. That is no broader than the mark itself: the
   * campaign-scoped `dnc_entries` row already blocks the number across this
   * whole campaign.
   *
   * ── Matching: `normalizeE164`, in TypeScript, deliberately ────────────────
   *
   * `phone_e164` is stored **as the roster gave it** — `applyIngestChunk` inserts
   * the ingest's string unchanged and there is no normalizing trigger or CHECK on
   * the column, which is exactly why `markDnc` normalizes before storing and why
   * the pre-dial gate normalizes before checking. So this cannot compare
   * `phone_e164 = $x`; `+1 (415) 555-0100` and `+14155550100` are the same number
   * and different strings.
   *
   * The comparison therefore runs {@link normalizeE164} itself, on both sides, in
   * TypeScript. Re-expressing that function in SQL was written and thrown away:
   * its whitespace class is JavaScript's `\s` (which includes NBSP and friends — a
   * thing spreadsheet exports really do put in phone columns) while Postgres'
   * `[[:space:]]` generally does not, so a SQL twin would silently skip a row the
   * one true function considers a match. That is a fail-OPEN, in the same shape
   * the registry's header warns about, produced by an optimisation.
   *
   * What SQL does instead is a strictly LOOSER prefilter — "same digits, ignoring
   * every non-digit" — which is a provable superset of what `normalizeE164` can
   * match (anything it normalizes contains only digits, `+`, spaces, `-`, `(`,
   * `)`), and is index-backed by `idx_agency_contacts_campaign_phone_digits`.
   * The narrow, exact decision stays in TypeScript. Keep the
   * expression below byte-identical to that index's or the plan silently degrades
   * to a scan.
   *
   * ── The SELECT is `FOR UPDATE`, in one transaction with the UPDATE ────────
   *
   * An unlocked SELECT then a second UPDATE lets {@link claimDialable} take a
   * duplicate BETWEEN the two. The tick already holds that contact in memory,
   * and its pre-dial check reads `dnc_entries` as committed, so a check that runs
   * before the mark's transaction commits does not see the new row — that press
   * still places the call. That is the duplicate-row hole this lock closes.
   *
   * `FOR UPDATE` (not `SKIP LOCKED`) holds every candidate until the UPDATE
   * commits. `claimDialable` uses `SKIP LOCKED`, so it skips a row we hold
   * rather than waiting, and cannot take it. We wait if a claim is already in
   * flight, then suppress the now-`in_flight` row; that one call may still
   * complete (the tick has it in memory — a known residual), but
   * {@link markState} then refuses to resurrect it.
   *
   * ── `next_attempt_at` is NOT touched, and that is the invariant ──────────
   *
   * {@link markState} COALESCEs it, so a contact that already had a retry instant
   * KEEPS it; this method preserves that by leaving the column out of the SET list
   * entirely (identical semantics, `COALESCE(NULL, next_attempt_at)`). It is inert
   * — `claimDialable` gates on `state = 'pending'` — but it means the STATE is what
   * takes a contact off the roster and the STATE is what a test here must assert.
   * Clearing the column is not a compliance write's job.
   *
   * @param reason value for `suppressed_reason`. Written unconditionally to
   *   `alwaysContactId`'s row — the agent marked THAT row, and an explicit mark
   *   outranks whatever it was suppressed for before. On every other matched row it
   *   is written only if that row has no reason yet, so a contact the pre-dial gate
   *   suppressed as `invalid` is not relabelled `dnc`: nobody at that number asked
   *   not to be called, and a compliance reason on a data-quality row is a claim the
   *   system cannot support. ⚠️ NOT `COALESCE($n, col)` on a required argument —
   *   see the argument-order note on the UPDATE; `reason` is required, so that
   *   shape is inert here and relabels everything.
   * @param opts.alwaysContactId the row the agent actually marked. Suppressed
   *   unconditionally, **including when the phone does not normalize at all** —
   *   an unusable number is a data problem and the customer in front of the agent
   *   must still leave the roster (the guarantee `POST /attempts/:id/dnc` has
   *   always made, and the one a naive by-phone rewrite quietly drops).
   * @param opts.lastDisposition written to `alwaysContactId`'s row ONLY. A
   *   disposition is a statement about one call with one person; stamping it onto
   *   the housemate's row because they share a landline would be inventing a
   *   record of a conversation that never happened.
   * @returns the ids actually suppressed, for the route's log line. Never trust it
   *   as the proof of the write — assert the rows.
   */
  async suppressByPhone(
    campaignId: string,
    phoneE164: string,
    reason: string,
    opts: { alwaysContactId?: string | undefined; lastDisposition?: string | undefined } = {},
    /**
     * Join the CALLER's transaction instead of opening one (decision B8): the agent's DNC
     * mark writes `dnc_entries`, the roster suppression and the optional disposition in ONE
     * transaction (`POST /attempts/:id/dnc`). The caller owns BEGIN / COMMIT / ROLLBACK and
     * release; the SELECT … FOR UPDATE then UPDATE run on its client, so the row locks are
     * held until its COMMIT. Omitted, this method opens its own transaction.
     */
    deps: { client?: PoolClient } = {},
  ): Promise<string[]> {
    const pool = getPool();
    const target = normalizeE164(phoneE164);
    const ids = new Set<string>();
    if (opts.alwaysContactId) ids.add(opts.alwaysContactId);

    const write = async (db: Pick<PoolClient, 'query'>): Promise<string[]> => {
      // ── ⚠️ COALESCE ARGUMENT ORDER: which side may be NULL is the whole meaning ──
      //
      // `COALESCE($n, col)` means "the caller's value, or keep what is there" and is
      // correct ONLY where `$n` can actually be NULL. Every other such write in this
      // file feeds one from an OPTIONAL patch field (`patch.x ?? null`) or an
      // explicitly nullable parameter, so NULL genuinely means "not supplied".
      //
      // `reason` is a REQUIRED `string`. It is never NULL, so `COALESCE($3, …)` here
      // was an inert guard that always selected `$3` — every swept row was relabelled
      // `'dnc'`, including one the pre-dial gate had suppressed as `'invalid'`. That
      // puts a compliance claim on a data-quality row: nobody asked not to be called,
      // and the only surviving evidence of why the row left the roster is overwritten.
      // The idiom was copied from `markState`, where the parameter really is optional;
      // carried into a required-argument method it does nothing at all, silently, and
      // a unit tier with a mocked pool cannot see it (integration T-DNC6 did).
      //
      // So the direction is reversed for the SWEPT rows — `COALESCE(col, $3)`, "keep
      // an existing reason, else record this one" — while the MARKED row is written
      // unconditionally. That asymmetry is deliberate and mirrors `last_disposition`
      // immediately below, so the two columns read as one pattern:
      //
      //   * the marked row is the one the agent explicitly acted on, and an explicit
      //     DNC mark is the strongest statement the system has about it. It must not
      //     be at the mercy of a stale value — and this is reachable, not theoretical:
      //     the disposition route writes `suppressed_reason` on this same contact
      //     (`agency.routes.ts`, `markState` with `decision.suppressedReason`), and
      //     mark-DNC on an already-dispositioned attempt is explicitly supported. A
      //     plain `COALESCE(col, $3)` would drop the agent's DNC on that path;
      //   * a swept row is a DIFFERENT PERSON who merely shares the number, so
      //     whatever it was already suppressed for stands.
      const { rows } = await db.query<{ id: string }>(
        `UPDATE agency_contacts
            SET state = 'suppressed',
                suppressed_reason = CASE WHEN id = $4::uuid
                                         THEN $3
                                         ELSE COALESCE(suppressed_reason, $3) END,
                last_disposition = CASE WHEN id = $4::uuid
                                        THEN COALESCE($5, last_disposition)
                                        ELSE last_disposition END,
                updated_at = now()
          WHERE campaign_id = $1 AND id = ANY($2::uuid[])
          RETURNING id`,
        // `campaign_id` is re-asserted rather than trusted from the id list: the
        // scope of this write is one campaign, and that must be true of the marked
        // row too, not only of the ones this method looked up itself.
        [
          campaignId,
          [...ids],
          reason,
          opts.alwaysContactId ?? null,
          opts.lastDisposition ?? null,
        ],
      );
      return rows.map((r) => r.id);
    };

    if (!target) {
      log.error(
        { campaignId, contactId: opts.alwaysContactId ?? null },
        'Contact phone is not usable E.164 — only the marked row could be suppressed, '
        + 'any duplicate of it in this campaign stays dialable',
      );
      if (ids.size === 0) return [];
      return write(deps.client ?? pool);
    }

    // One transaction, SELECT FOR UPDATE then UPDATE: claimDialable uses
    // SKIP LOCKED, so a duplicate we hold cannot be taken between the two. With
    // `deps.client` both run inside the caller's transaction instead, and
    // `withTransaction` issues nothing of its own.
    return withTransaction(async (client, tx) => {
      const { rows } = await client.query<{ id: string; phone_e164: string }>(
        `SELECT id, phone_e164 FROM agency_contacts
          WHERE campaign_id = $1
            AND (${CONTACT_PHONE_DIGITS_SQL} = $2
                 OR ($3::uuid IS NOT NULL AND id = $3::uuid))
          FOR UPDATE`,
        // The target's digits, i.e. the normalized form minus its leading '+'.
        // `$3` re-locks the marked row even when its stored string would not
        // survive the prefilter, so the guarantee `alwaysContactId` makes is
        // held for the same duration as the sweep.
        [campaignId, target.slice(1), opts.alwaysContactId ?? null],
      );
      for (const row of rows) {
        // The prefilter is a superset; THIS is the decision, and it is the same
        // function every other side of this comparison runs. The marked row is
        // already in `ids` and is not re-decided here.
        if (normalizeE164(row.phone_e164) === target) ids.add(row.id);
      }
      if (ids.size === 0) {
        await tx.rollback();
        return [];
      }
      return write(client);
    }, { pool, client: deps.client });
  }


  /**
   * One campaign's roster, newest first, keyset-paginated.
   *
   * ── `context` is deliberately absent from this projection ───────────────────
   * Columns the operator marked `Ignore` at ingest never reach the stored JSONB
   * at all (`agency-csv-ingest.ts` drops them before the row is written), so
   * the exclusion marking a column `Ignore` promises *is* enforced at ingest
   * rather than at render. But `context_display.hidden` is a render
   * rule, and this list has a wider audience than the agent screen that rule was
   * written for — and it feeds a CSV export, which is a materially larger
   * exposure than one drawer. So the bulk read simply does not carry it: the
   * columns are served by {@link findDetailScoped}, one contact at a time, where
   * a client can apply `hidden` the way the console does.
   *
   * ── Plan ────────────────────────────────────────────────────────────────────
   * Needs `idx_agency_contacts_reporting (campaign_id, created_at DESC, id DESC)`.
   * Every other index on this table is built for the
   * DIAL path — `idx_agency_contacts_dialable` is partial on `state = 'pending'`,
   * i.e. it excludes most of what a supervisor reads — so without it this is a
   * sequential scan plus a sort of up to a million rows on a route someone pages
   * through.
   */
  async listForCampaign(input: {
    campaignId: string;
    filters: AgencyContactFilters;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyContactRow>> {
    const bind = params();
    const f = input.filters;
    // The four vocabulary dimensions come from the SHARED builder, because this
    // list is where a retry selection is authored and the seeding statement has to
    // mean the same thing by them — see `contactFilterConditions`. The three below
    // are this route's own: they are deliberately not retry-selector dimensions.
    const conditions = [
      `c.campaign_id = ${bind.add(input.campaignId)}`,
      ...contactFilterConditions(f, 'c', bind),
    ];

    if (f.phone) conditions.push(phoneCondition(f.phone, 'c', bind));
    if (f.from) conditions.push(`c.created_at >= ${bind.add(f.from)}`);
    if (f.to) conditions.push(`c.created_at <= ${bind.add(f.to)}`);
    if (input.after) conditions.push(keysetCondition(input.after, 'c', bind));

    const sql = `
      SELECT c.id, c.phone_e164, c.state, c.attempt_count, c.our_fault_attempts,
             c.last_outcome, c.last_disposition, c.next_attempt_at,
             c.suppressed_reason, c.timezone, c.csv_line_number,
             c.created_at, c.updated_at,
             ${keysetAtSql('c.created_at')} AS cursor_at
        FROM agency_contacts c
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ${bind.add(input.limit + 1)}`;

    const { rows } = await getPool().query<AgencyContactRecord & { cursor_at: string }>(sql, bind.values);
    return toKeysetPage(rows, input.limit, projectContactRow);
  }

  /**
   * One contact, scoped to a campaign the caller has already been proven to own
   * — the drill-down's row, and the only read that carries `context`.
   *
   * `campaignId` is a predicate rather than a post-hoc check because the route
   * proves ownership of the CAMPAIGN, not of the contact: without it, any
   * contact id in the tenant (or outside it) would resolve through a route
   * authorised against a campaign the caller does own.
   */
  async findDetailScoped(campaignId: string, contactId: string): Promise<AgencyContactDetail | null> {
    const { rows } = await getPool().query<AgencyContactRecord>(
      `SELECT * FROM agency_contacts WHERE id = $1::uuid AND campaign_id = $2`,
      [contactId, campaignId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...projectContactRow(row),
      // Unfiltered. Every value is untrusted display text; the client applies
      // `context_display.hidden` before rendering. See the class note above.
      context: row.context ?? {},
    };
  }

  async findById(id: string): Promise<AgencyContactRecord | null> {
    const { rows } = await getPool().query<AgencyContactRecord>(
      'SELECT * FROM agency_contacts WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Apply one roster-ingest chunk, all-or-nothing.
   *
   * The chunk marker and its rows commit in ONE transaction, so partial
   * application is impossible rather than merely detectable — which is what lets
   * a replay be a single cheap conflict on `uq_agency_ingest_chunk` instead of 500
   * per-row upserts.
   *
   * `uq_agency_contacts_row_fingerprint` sits beneath it, and is not merely
   * defence in depth: the ingest job gets a fresh job id on every run
   * (`AgencyIngestJobRepository.create` is an unconditional INSERT), so a
   * re-upload after a restart cannot conflict on the chunk marker at all and the row-level
   * guard is the only thing stopping the rows that already landed from landing
   * twice. It keys on row CONTENT rather than on the file position, which is what
   * makes topping up a live campaign possible without giving that guard away.
   */
  async applyIngestChunk(input: {
    campaignId: string;
    tenantId: string;
    accountId: string;
    ingestJobId: string;
    chunkIndex: number;
    chunkCount: number | null;
    idempotencyKey: string;
    contacts: AgencyContactInput[];
  }): Promise<AgencyIngestResult> {
    return withTransaction<AgencyIngestResult>(async (client, tx) => {
      // ── The campaign row is locked FIRST, before anything is written ────────
      //
      // `contacts_total` below is a COUNT taken by an UPDATE of this row. Under READ
      // COMMITTED, a second chunk whose UPDATE blocked on the first's row lock resumes
      // after the first commits but evaluates the COUNT with its own statement
      // snapshot, which predates that commit: it answered, and stored, a total
      // short by the other chunk. Taking the lock as the transaction's first
      // statement makes a concurrent chunk for the same campaign wait here, holding
      // nothing, and every statement after the wait sees the committed chunk.
      //
      // `FOR NO KEY UPDATE`, not `FOR UPDATE`: it is exactly the lock the UPDATE
      // below takes anyway, taken earlier, so it adds no lock mode to this row. It
      // does not conflict with the `FOR KEY SHARE` that foreign-key checks take
      // (calls, attempts, sessions, retry children inserted against a running
      // campaign); `FOR UPDATE` would make each of those wait for the chunk.
      //
      // Lock order: the campaign row, then only rows this transaction creates. No
      // other path holds this row's lock while waiting on an ingest's rows, so this
      // cannot deadlock. Chunks of one ingest job are sent one at a time, so the
      // only serialisation this adds is between two ingests on one campaign.
      await client.query(
        'SELECT 1 FROM agency_campaigns WHERE id = $1 FOR NO KEY UPDATE',
        [input.campaignId],
      );

      const marker = await client.query<{ id: string }>(
        `INSERT INTO agency_ingest_chunks
           (campaign_id, ingest_job_id, chunk_index, idempotency_key, chunk_count, row_count)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (campaign_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          input.campaignId, input.ingestJobId, input.chunkIndex,
          input.idempotencyKey, input.chunkCount, input.contacts.length,
        ],
      );

      // Conflict ⇒ this chunk already landed. Roll back and say so explicitly —
      // the ingest job treats it as success and needs the signal to avoid
      // double-counting.
      //
      // **The rollback semantics below are load-bearing and unchanged.** Nothing is
      // re-applied here; the chunk marker's transactional idempotency is the whole
      // point. The replay also says something: it reads back the
      // counts the ORIGINAL application recorded, so a replay answers what
      // the original answered. It has no counts of its own — it rolls back before
      // the rows are inserted — so without the recorded ones it could only return a
      // confident zero, and the ingest summary would undercount every row the
      // original refused.
      if (marker.rowCount === 0) {
        await tx.rollback();
        // Read AFTER the rollback, on the same client in autocommit: the marker
        // was committed by the original transaction, so this is an ordinary read,
        // and keeping it outside the aborted one avoids any suggestion that the
        // replay path still holds a transaction open.
        const recorded = await this.recordedRejections(input.campaignId, input.idempotencyKey, client);
        return {
          accepted: 0,
          duplicate_chunk: true,
          total_contacts: await this.countForCampaign(input.campaignId, client),
          rejected_duplicate_rows: recorded.rejected ?? 0,
          duplicate_source_rows: recorded.sourceRows ?? [],
          // NULL ⇒ the chunk recorded no counts, so the zeros above are "unknown", not
          // "none". Never invented as a number; the flag is how the response says
          // it does not know.
          ...(recorded.rejected === null ? { rejection_counts_unavailable: true } : {}),
        };
      }

      // ── The whole chunk in ONE statement ─────────────────────────────────────
      //
      // One `INSERT … SELECT FROM unnest(…) WITH ORDINALITY`, in input order, rather
      // than one round trip per row. What each input row's fate is, and therefore
      // what the operator is told, is exactly what the row-at-a-time loop decided:
      //
      //   * a fingerprint the roster already held ⇒ every input row carrying it is
      //     refused;
      //   * a fingerprint new to the roster ⇒ the FIRST input row carrying it lands
      //     (the ORDER BY feeds the rows in file order, and a row inserted earlier
      //     in the same statement is visible to the next one's conflict check), and
      //     every later one is refused as a duplicate of it.
      //
      // `RETURNING row_fingerprint` names the fingerprints that landed, and the
      // final SELECT maps them back to input rows by that rule. The rejected rows'
      // line numbers come back in input order, so the sample is the first
      // `MAX_REPORTED_DUPLICATE_ROWS` refused rows, as before.
      //
      // The conflict target is NAMED, not bare. A bare `ON CONFLICT DO NOTHING`
      // absorbs *every* constraint violation — so a genuine data problem (a bad
      // FK, a CHECK the ingest should have caught) was indistinguishable from a
      // replayed row, and both surfaced as a silent decrement of `accepted`.
      // Naming the index means only the row-idempotency collision is swallowed
      // and anything else throws — the whole chunk, marker included, since it is
      // one statement in one transaction.
      //
      // The target is `row_fingerprint`, not `source_row_number`:
      // the row number is the position in ONE file, so a second file's rows
      // 2..N would collide with the first's and a top-up could never land. The
      // fingerprint is computed **in SQL from the same values that are stored**,
      // by the same function the retry seeding path uses, so there is exactly one
      // definition of "the same roster row". The arrays are typed `varchar[]` so
      // the function sees the types it is declared on.
      //
      // ── `source_row_number` IS DELIBERATELY NOT IN THIS COLUMN LIST ──
      //
      // Naming the fingerprint index is not enough on its own:
      // `uq_agency_contacts_source_row` is STILL in the schema, so writing the
      // column would make a top-up file's row 2 collide with the first file's
      // row 2, and that 23505 is not swallowed because the conflict target names
      // a different index. The top-up arms of `agency-ingest-idempotency.test.ts`
      // fail on exactly that constraint if the column comes back.
      //
      // That index is PARTIAL on `source_row_number IS NOT NULL`, so a row that
      // stores NULL sits outside it. Leaving the column out of this list is what
      // makes top-up work. The CSV line
      // number is not lost — it goes to `csv_line_number`, which is
      // unindexed provenance and can never reinstate the collision.
      //
      // Do not "tidy" the column back in. It reads like restoring a dropped
      // field and it re-breaks top-up the moment two files share a line number.
      const applied = await client.query<{ accepted: string; rejected_lines: Array<number | null> }>(
        `WITH input AS (
           SELECT u.ord, u.phone_e164, u.context, u.csv_line_number, u.timezone,
                  agency_contact_row_fingerprint(u.phone_e164, u.context, u.timezone) AS fingerprint
             FROM unnest($4::varchar[], $5::jsonb[], $6::integer[], $7::varchar[])
                  WITH ORDINALITY AS u(phone_e164, context, csv_line_number, timezone, ord)
         ), inserted AS (
           INSERT INTO agency_contacts
             (campaign_id, tenant_id, account_id, phone_e164, context, csv_line_number, timezone,
              row_fingerprint)
           SELECT $1::uuid, $2::uuid, $3::uuid,
                  i.phone_e164, i.context, i.csv_line_number, i.timezone, i.fingerprint
             FROM input i
            ORDER BY i.ord
           ON CONFLICT (campaign_id, row_fingerprint) WHERE row_fingerprint IS NOT NULL
             DO NOTHING
           RETURNING row_fingerprint
         ), fate AS (
           -- inserted holds each fingerprint at most once (it is a unique key),
           -- so the LEFT JOIN cannot fan out.
           SELECT i.ord, i.csv_line_number,
                  n.row_fingerprint IS NOT NULL
                    AND i.ord = MIN(i.ord) OVER (PARTITION BY i.fingerprint) AS accepted
             FROM input i
             LEFT JOIN inserted n ON n.row_fingerprint = i.fingerprint
         )
         SELECT (SELECT COUNT(*) FROM inserted)::text AS accepted,
                COALESCE(array_agg(f.csv_line_number ORDER BY f.ord) FILTER (WHERE NOT f.accepted),
                         '{}') AS rejected_lines
           FROM fate f`,
        [
          input.campaignId, input.tenantId, input.accountId,
          input.contacts.map((c) => c.phone_e164),
          input.contacts.map((c) => JSON.stringify(c.context ?? {})),
          // The INPUT's `source_row_number` (the ingest's field name, unchanged),
          // stored into `csv_line_number`. The input contract does not move just
          // because the column did.
          input.contacts.map((c) => c.source_row_number ?? null),
          input.contacts.map((c) => c.timezone ?? null),
        ],
      );
      const accepted = Number(applied.rows[0]?.accepted ?? 0);
      const rejectedLines = applied.rows[0]?.rejected_lines ?? [];
      const rejectedDuplicateRows = rejectedLines.length;
      // Reported from the INPUT row, never from a stored value — which is why
      // the column the number is stored in changes nothing about what the operator
      // is told. A refused row with no row number is counted but cannot be named.
      const duplicateRows = rejectedLines
        .filter((line): line is number => line !== null)
        .slice(0, MAX_REPORTED_DUPLICATE_ROWS);

      // Record what this chunk refused, in the SAME transaction that refused it.
      // It cannot be recomputed later: a row rejected by
      // `uq_agency_contacts_row_fingerprint` leaves nothing behind — the surviving
      // contact is the one that was already there and is byte-identical to the one
      // we dropped — so if the number is not written down here it is gone, and the
      // replay path has nothing truthful to answer with.
      //
      // An UPDATE rather than folding these into the marker INSERT above, because
      // the INSERT has to happen FIRST: it is the conflict on that insert which
      // detects the replay, and it has to do so before the rows are inserted. Same
      // transaction either way, so the marker and its counts are still
      // all-or-nothing.
      await client.query(
        `UPDATE agency_ingest_chunks
            SET rejected_duplicate_rows = $2,
                duplicate_source_rows   = $3::integer[]
          WHERE id = $1`,
        [marker.rows[0]!.id, rejectedDuplicateRows, duplicateRows],
      );

      // Recomputed as a COUNT rather than incremented, which is what makes it
      // self-healing under replay; `RETURNING` hands the new total back from the
      // same statement instead of a second count of the roster. Exact under
      // concurrent chunks only because of the row lock taken at the top.
      const totalled = await client.query<{ contacts_total: number }>(
        `UPDATE agency_campaigns
            SET contacts_total = (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1),
                updated_at = now()
          WHERE id = $1
        RETURNING contacts_total`,
        [input.campaignId],
      );

      return {
        accepted,
        duplicate_chunk: false,
        total_contacts: Number(totalled.rows[0]?.contacts_total ?? 0),
        rejected_duplicate_rows: rejectedDuplicateRows,
        duplicate_source_rows: duplicateRows,
      };
    }, { pool: getPool() });
  }

  /**
   * What a previously-applied chunk recorded that it refused.
   *
   * `rejected: null` is the honest "never recorded" —
   * and is reported as `rejection_counts_unavailable` rather than as a zero. A
   * chunk that recorded its counts has a real number, so a recorded `0` genuinely means
   * "this chunk refused nothing".
   *
   * `sourceRows` is a capped sample (`MAX_REPORTED_DUPLICATE_ROWS`), matching the
   * API field of the same name. `node-pg` decodes `INTEGER[]` to `number[]`.
   */
  private async recordedRejections(
    campaignId: string,
    idempotencyKey: string,
    /**
     * Run on the caller's ALREADY-HELD client rather than checking out a second
     * connection. `applyIngestChunk` calls this while still holding `client`, and a
     * checkout-while-holding is a classic pool deadlock: with `DB_POOL_MAX` at N,
     * N concurrent chunks each holding one connection and requesting another wait
     * on each other forever. The transaction has been rolled back by then, so this
     * is an ordinary read on an idle connection.
     */
    executor: Pick<PoolClient, 'query'> = getPool(),
  ): Promise<{ rejected: number | null; sourceRows: number[] | null }> {
    const { rows } = await executor.query<{
      rejected_duplicate_rows: number | null;
      duplicate_source_rows: number[] | null;
    }>(
      `SELECT rejected_duplicate_rows, duplicate_source_rows
         FROM agency_ingest_chunks
        WHERE campaign_id = $1 AND idempotency_key = $2`,
      [campaignId, idempotencyKey],
    );
    const row = rows[0];
    // A missing row here should be unreachable — we are on this path precisely
    // because the unique index refused our insert — but it is treated as "not
    // recorded" rather than as zero for the same reason NULL is: an invented
    // number is the defect being fixed.
    if (!row) return { rejected: null, sourceRows: null };
    // `?? null` normalizes an absent column to the same "not recorded" as a NULL
    // one. Postgres returns `null` for a NULL `INTEGER`, so this is belt-and-braces
    // — but the two must not diverge, because `undefined` slipping through would
    // reach the `=== null` test below as "recorded" and reinstate the confident zero.
    return {
      rejected: row.rejected_duplicate_rows ?? null,
      sourceRows: row.duplicate_source_rows ?? null,
    };
  }

  async countForCampaign(
    campaignId: string,
    /** See `recordedRejections` — avoids a second checkout while a client is held. */
    executor: Pick<PoolClient, 'query'> = getPool(),
  ): Promise<number> {
    const { rows } = await executor.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM agency_contacts WHERE campaign_id = $1',
      [campaignId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Chunk indexes the ingest job sent that never landed — lets it re-send just the gap. */
  async missingChunks(campaignId: string, ingestJobId: string, chunkCount: number): Promise<number[]> {
    const { rows } = await getPool().query<{ chunk_index: number }>(
      'SELECT chunk_index FROM agency_ingest_chunks WHERE campaign_id = $1 AND ingest_job_id = $2',
      [campaignId, ingestJobId],
    );
    const seen = new Set(rows.map((r) => r.chunk_index));
    const missing: number[] = [];
    for (let i = 0; i < chunkCount; i++) if (!seen.has(i)) missing.push(i);
    return missing;
  }
}

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
  | { ok: true; session: AgencyAgentSessionRecord }
  | { ok: false; reason: 'other_campaign'; session: AgencyAgentSessionRecord };

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
  campaign_id: string;
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
   */
  at: Date;
}

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
                 clock_timestamp() AS at`;
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
   * Join, or REHYDRATE an existing live session.
   *
   * A returning agent must resume their row rather than get a new one — the unique
   * index allows exactly one live session per (tenant, agent)
   * (`uq_agency_agent_live_tenant`) — and must land in `break`, never `available`, so the engine cannot dial into a
   * pool that has not demonstrably re-attached. The agent clicks once to go
   * available.
   *
   * ── Why the uniqueness is per TENANT and what that makes reachable ───
   * Were it unique per (campaign, agent), one human could hold
   * two live sessions on two campaigns. The reservation CAS key is
   * `agency:agent:{sessionId}:state` — per session — so those two sessions are two
   * independently reservable agents attached to one pair of ears, and both pacing
   * ticks can bridge a customer at once. `uq_agency_agent_live_tenant` makes the database refuse the second
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
   * ── Why `DO UPDATE … WHERE campaign_id = EXCLUDED.campaign_id` ─────────────
   * The conflict has two meanings and they must not be collapsed:
   *   * same campaign  ⇒ this is a REHYDRATE. Update and return the row.
   *   * other campaign ⇒ this is the refusal. The `WHERE` makes the DO UPDATE
   *     match nothing, so `RETURNING` yields zero rows — **and, critically, the
   *     other campaign's row is left exactly as it was.** An unconditional DO
   *     UPDATE would stamp this replica's `owner_replica` onto a session live on
   *     another campaign, i.e. quietly hijack the ownership of an agent who may
   *     be mid-conversation, and only then report a conflict.
   */
  async joinOrRehydrate(input: {
    tenantId: string;
    accountId: string;
    campaignId: string;
    agentUserId: string;
    replicaId: string;
  }): Promise<AgencyAgentJoinResult> {
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
      // `prev` is keyed on the same predicate as the arbiter index — the agent's
      // one live session in the tenant (`uq_agency_agent_live_tenant`) — not on the proposed row, because
      // the conflicting row may be on a different campaign.
      const { rows } = await getPool().query<AgencyAgentSessionRecord & {
        from_state: AgencyAgentState | null;
        from_break_reason: string | null;
        at: Date;
      }>(
        `WITH prev AS (
           SELECT id, state, break_reason FROM agency_agent_sessions
            WHERE tenant_id = $1 AND agent_user_id = $4 AND left_at IS NULL
         ), upserted AS (
           INSERT INTO agency_agent_sessions
             (tenant_id, account_id, campaign_id, agent_user_id, state, owner_replica, last_heartbeat)
           VALUES ($1, $2, $3, $4, 'break', $5, now())
           ON CONFLICT (tenant_id, agent_user_id) WHERE left_at IS NULL
           DO UPDATE SET owner_replica = EXCLUDED.owner_replica,
                         last_heartbeat = now(),
                         state = CASE WHEN agency_agent_sessions.state = 'offline'
                                      THEN 'break' ELSE agency_agent_sessions.state END,
                         updated_at = now()
             WHERE agency_agent_sessions.campaign_id = EXCLUDED.campaign_id
           RETURNING *
         )
         SELECT upserted.*, prev.state AS from_state, prev.break_reason AS from_break_reason,
                clock_timestamp() AS at
           FROM upserted LEFT JOIN prev ON prev.id = upserted.id`,
        [input.tenantId, input.accountId, input.campaignId, input.agentUserId, input.replicaId],
      );
      const row = rows[0];
      if (row) {
        // Destructured rather than passed through: the two log-only columns must
        // not ride along on `AgencyAgentSessionRecord`, which is spread into the
        // bootstrap payload — an extra field on the wire is a contract nobody
        // agreed to and one that the console would start depending on.
        // `at` is destructured out for the same reason the two `from_*` columns
        // are: `AgencyAgentSessionRecord` is spread into the bootstrap payload,
        // and a log-only column riding along becomes a contract nobody agreed to.
        const { from_state, from_break_reason, at, ...session } = row;
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
        return { ok: true, session };
      }

      // Zero rows means the DO UPDATE's WHERE refused: something live exists for
      // this agent and it is not the row we proposed. Read it, so the refusal can
      // name the campaign the agent has to leave.
      //
      // This read is NOT synchronised with the upsert, and both branches below
      // exist because of that gap rather than in spite of it.
      const blocker = await this.findLiveForAgent(input.tenantId, input.agentUserId);

      if (blocker && blocker.campaign_id !== input.campaignId) {
        return { ok: false, reason: 'other_campaign', session: blocker };
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
      `joinOrRehydrate could not settle after ${JOIN_UPSERT_ATTEMPTS} attempts: ` +
      `the agent's live session kept changing between the upsert and the read`,
    );
  }

  /**
   * The agent's one live session anywhere in the tenant, if any.
   *
   * `LIMIT 1` is a formality, not a choice between candidates: `uq_agency_agent_live_tenant`
   * (`uq_agency_agent_live_tenant`) permits at most one row to satisfy this predicate. It is written this
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
   */
  async setState(id: string, state: AgencyAgentState, breakReason?: string | null): Promise<void> {
    const { rows } = await getPool().query<AgencySessionTransitionRow>(
      sessionTransitionSql({
        prevWhere: 'id = $1',
        set: 'state = $2, break_reason = $3, state_since = now(), updated_at = now()',
      }),
      [id, state, breakReason ?? null],
    );
    await this.recordTransitions(rows);
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
        set: "state = 'offline', left_at = now(), updated_at = now()",
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

/**
 * The rolling abandonment window.
 *
 * Its own class because it is the one reader whose whole purpose is to be an
 * INDEPENDENT audit of the Prometheus counters — it touches nothing in process,
 * derives everything from raw columns, and must stay that way. See
 * `src/agency/abandonment-metrics.ts` for why that independence is load-bearing.
 */
export class AgencyAbandonmentRepository {
  /**
   * Answered and abandoned counts per campaign over the rolling window.
   *
   * One grouped aggregate rather than a query per campaign: this runs on a timer
   * against a table that grows for the life of the account, and N+1 over campaigns
   * would scale with the thing most likely to grow.
   *
   * The window is bounded on `answered_at`, not `created_at`: the regulatory
   * question is "of the calls a customer picked up in the last 24 hours, how many
   * reached nobody", so an attempt that was placed yesterday and answered ten
   * minutes ago belongs in this window.
   */
  async window24h(): Promise<AgencyAbandonmentWindowRow[]> {
    const { rows } = await getPool().query<{
      tenant_id: string; campaign_id: string; answered: string; abandoned: string;
      status: string | null; ceiling_pct: number | null;
    }>(
      `SELECT a.tenant_id,
              a.campaign_id,
              COUNT(*)::text AS answered,
              COUNT(*) FILTER (WHERE ${ABANDONED_ATTEMPT_PREDICATE_SQL})::text AS abandoned,
              c.status,
              c.abandonment_ceiling_pct AS ceiling_pct
         FROM agency_call_attempts a
         LEFT JOIN agency_campaigns c ON c.id = a.campaign_id
        WHERE a.state = 'ended'
          AND a.answered_at IS NOT NULL
          AND a.answered_at > now() - ($1 || ' hours')::interval
        GROUP BY a.tenant_id, a.campaign_id, c.status, c.abandonment_ceiling_pct`,
      [ABANDONMENT_WINDOW_HOURS],
    );
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      campaign_id: r.campaign_id,
      answered: Number(r.answered),
      abandoned: Number(r.abandoned),
      status: r.status,
      ceiling_pct: r.ceiling_pct,
    }));
  }

}

/**
 * One row of the live-concurrency read: how many attempts a campaign is holding
 * in one non-terminal state, right now.
 *
 * `state` is deliberately typed `string` and NOT `AgencyAttemptState`, even
 * though `ck_agency_attempt_state` does constrain the column to
 * exactly that union. Typing it would make the CHECK constraint the definition of
 * a **Prometheus label vocabulary**, and the house rule is that label values are
 * bounded by *source code*, never by anything outside it — a migration can widen
 * that constraint in a commit that touches no TypeScript, and the assertion would
 * go on typechecking while the metric store minted a new permanent series.
 * Narrowing therefore happens once, in the publisher, against
 * `AGENCY_ATTEMPT_LIVE_STATES`; typing it here would let a reader assume that had
 * already happened.
 */
export interface AgencyLiveAttemptStateRow {
  tenant_id: string;
  campaign_id: string;
  state: string;
  live: number;
}

/**
 * The dialer's live-concurrency read — attempts in flight, split by state.
 *
 * It feeds `agency_live_attempts_current` (published by
 * `live-concurrency-metrics.ts`), the dialer's "how many calls are up" number,
 * derived from the attempts table rather than from any in-process map.
 *
 * Its own class for the same reason `AgencyAbandonmentRepository` has one — it
 * exists solely to be read by a metrics publisher on a timer, touches nothing in
 * process, and derives everything from raw columns. Nothing on the dial path may
 * come to depend on it, because a metrics read that acquires a caller is a
 * metrics read that can fail a call.
 *
 * ── Not tenant-scoped, deliberately ────────────────────────────────────────
 * Every `/api/v1/*` read is scoped by both headers; this is not one. It is the
 * same fleet-wide operator read as `window24h()` — a replica publishes what it
 * can see of the whole floor, and Prometheus labels the result per tenant.
 */
export class AgencyLiveConcurrencyRepository {
  /**
   * Non-terminal attempts per `(tenant, campaign, state)`.
   *
   * **One grouped aggregate, never a query per campaign.** Campaigns are created
   * per roster upload and are unbounded over an account's life, so an N+1 here
   * would scale with the thing most likely to grow — and it would do so on a
   * timer, which is how a metrics poller becomes the reason the database is busy.
   *
   * `state <> 'ended'` is written as a **literal, not a bound parameter**, and
   * that is load-bearing twice over:
   *
   * 1. It matches `uq_agency_attempt_live`'s partial-index predicate
   *    (`ON agency_call_attempts (contact_id) WHERE state <> 'ended'`) *byte for byte*, which is what lets the planner prove the
   *    index covers the query. Bound as `$1` the predicate is opaque at plan
   *    time and this degrades to a scan of a table that grows for the life of
   *    the account. So the cost of this read is bounded by **live concurrency**
   *    (tens of rows) rather than by history.
   * 2. It sidesteps the `42P08` parameter-typing trap this codebase has shipped
   *    twice (`transitionStatus`, `claimTerminal`): a statement with no
   *    parameters cannot have a `$n` deduced into conflicting types, and a
   *    mocked pool never parses SQL, so a unit test could not have caught it.
   *
   * It is also the **same predicate `AgencyAttemptRepository.countLive` uses** for
   * the pacing tick's `occupied` term. That is the point of matching it rather
   * than listing the five live states: the gauge and the tick then cannot
   * disagree about what "in flight" means, so the published family reconciles
   * with the number the tick subtracted from the account limit. Two definitions of
   * occupancy — one an operator reads, one the dialer acts on — would drift apart.
   *
   * ⚠️ Reconciling it in PromQL means `sum by (state)` ACROSS STATES and then
   * `max` ACROSS REPLICAS, in that order — never a bare `sum()`. This query is
   * fleet-wide and unleadered, so every replica publishes the identical series and
   * a bare `sum()` returns R times the truth. An earlier version of this
   * paragraph said `sum(agency_live_attempts_current)` *is* occupancy, which is
   * true of one replica's samples and false of the metric anyone actually queries.
   * See the aggregator note on the gauge in
   * `@magick-agency/observability/metrics/agency`.
   *
   * No `ORDER BY`: the consumer publishes a set of gauge samples, so ordering
   * would buy nothing and cost a sort on every tick.
   */
  async liveByState(): Promise<AgencyLiveAttemptStateRow[]> {
    const { rows } = await getPool().query<{
      tenant_id: string; campaign_id: string; state: string; live: string;
    }>(
      `SELECT tenant_id,
              campaign_id,
              state,
              COUNT(*)::text AS live
         FROM agency_call_attempts
        WHERE state <> 'ended'
        GROUP BY tenant_id, campaign_id, state`,
    );
    // `::text` because pg hands `int8` back as a string; parsed here rather than
    // in the publisher so a gauge can never be `set` to a string.
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      campaign_id: r.campaign_id,
      state: r.state,
      live: Number(r.live),
    }));
  }
}

/**
 * Every group dimension's SQL, as the inverted `Record` — and this object IS the
 * injection answer for `group_by`.
 *
 * `sort`, `order`, `group_by` and `limit` all arrive as free text. `limit` is a
 * bound parameter; the other three resolve through a `Record` lookup keyed on a
 * union member that {@link parseGroupedStatsQuery} has already validated, to a
 * fragment written here in source. So no caller-supplied character can reach the
 * statement even if the vocabulary check were removed — the lookup would simply
 * miss.
 *
 * `Record<AgencyGroupDimension, …>` rather than a `switch`: a seventh dimension
 * added to the union is a missing required key here, i.e. a build error naming it,
 * where a `switch` with a `default` would compile and silently group by whatever
 * the fallback picked.
 *
 * ── Three fragments per dimension, and the split is load-bearing ───────────
 *
 * `select` is the CTE's expression, in its NATURAL type. `project` is the outer
 * select item, which is where a numeric dimension is cast to text. They are not
 * one fragment because the ORDER BY reads `g.<alias>` — the CTE's column, at the
 * CTE's type — and **a text-typed hour sorts `'10'` before `'9'`**. Casting inside
 * the CTE would therefore make `sort=key` on an hour-of-day series silently
 * mis-order the x-axis, and with the slice now in SQL it would also change WHICH
 * hours a `limit` returns. Keeping the cast at the outer boundary makes the
 * ordering numeric because the column is.
 *
 * The cast still has to happen, though, and `::int::text` is deliberate on both
 * halves: node-pg hands `numeric` back as a STRING and `int4` back as a JS number,
 * so `EXTRACT`'s `numeric` would give this row mapper two conventions in one row.
 * `::int` states that the value is integral (a day-of-week is not `3.0`), and
 * `::text` puts every column on this statement through the same `Number()` hop as
 * the counters — which is also the only way a fixture that types them as strings,
 * the way node-pg actually returns them, exercises the mapping at all.
 *
 * `day` reuses {@link bucketStartSql}, not a second `to_char(date_trunc(...))`:
 * the contract says a `day` key has the same format as the per-agent record's
 * `bucket_start`, and sharing the expression is what makes that true rather than
 * claimed. It also inherits that function's reason for formatting in SQL — node-pg
 * parses a bare `timestamp` into a LOCAL-time `Date`, putting the server's zone
 * back on a value the query removed it from. It sorts correctly as text because
 * `YYYY-MM-DD` is lexicographically chronological, which is half of why that
 * format was chosen.
 */
const GROUP_DIMENSION_SQL: Record<
  AgencyGroupDimension,
  { select: string; alias: string; project: string }
> = {
  agent: { select: 's.agent_user_id', alias: 'agent_user_id', project: 'g.agent_user_id' },
  campaign: { select: 'a.campaign_id', alias: 'campaign_id', project: 'g.campaign_id' },
  // NULL is a real key value here, not a gap — an attempt with no disposition
  // submitted is the number a supervisor came for. `GROUP BY` puts every NULL in
  // one group, which is exactly the wanted behaviour and is NOT true of a join.
  // It is also the ONLY dimension that can be null, which is what the explicit
  // NULLS LAST in every ORDER BY is there for.
  disposition: {
    select: 'a.disposition_code', alias: 'disposition_code', project: 'g.disposition_code',
  },
  day: {
    select: bucketStartSql('day', 'a.dialed_at', AGENCY_RESOLVED_ZONE_SQL),
    // NOT `day`: that is an SQL keyword. Non-reserved, so `AS day` is legal -- but
    // the tree has no precedent for aliasing a keyword and `day_start` costs nothing
    // while matching the per-agent read's own `bucket_start`. The wire key is still
    // `day`; GROUP_KEY_READERS maps it. (Written when this statement had never run
    // against Postgres; it now does, in `agent-grouped-read.test.ts`, which groups
    // by this dimension -- the alias is kept on the two reasons that survive rather
    // than on the one that expired.)
    alias: 'day_start',
    project: 'g.day_start',
  },
  // 0 = Sunday .. 6 = Saturday, which is `EXTRACT(DOW)`'s own numbering and the
  // reason the contract types this as a NUMBER: restating it as a day name invites
  // an off-by-one against ISO's 1=Monday, and the name is a locale decision the
  // console owns.
  day_of_week: {
    select: `EXTRACT(DOW FROM (a.dialed_at AT TIME ZONE ${AGENCY_RESOLVED_ZONE_SQL}))::int`,
    alias: 'day_of_week',
    project: 'g.day_of_week::text AS day_of_week',
  },
  hour_of_day: {
    select: `EXTRACT(HOUR FROM (a.dialed_at AT TIME ZONE ${AGENCY_RESOLVED_ZONE_SQL}))::int`,
    alias: 'hour_of_day',
    project: 'g.hour_of_day::text AS hour_of_day',
  },
};

/**
 * The ORDER BY term for each METRIC sort key. `key` is absent on purpose — it is
 * the grouped dimensions themselves, assembled from
 * {@link GROUP_DIMENSION_SQL} at the call site, so it has no fixed text.
 *
 * ── Two things every entry here has to get right ────────────────────────────
 *
 *  1. **`::numeric`, always.** The shared metric builder casts every counter to
 *     `::text`, so ordering them as they arrive would rank `'9'` above `'400'` —
 *     a silently wrong "top 200 by attempts" that no type checker can see.
 *  2. **`NULLIF(<denominator>, 0)`, never a bare division.** Postgres raises
 *     `22012 division_by_zero` on `x / 0`, which nothing maps to a status, so a
 *     single group that connected nobody would 500 the whole page under
 *     `?sort=success_rate_pct`. `NULLIF` makes it NULL, which the explicit
 *     `NULLS LAST` then files where the contract says an unranked row goes.
 *
 * ⚠️ **These expressions ORDER the rows; they do not PRODUCE the served rates.**
 * The payload's `connect_rate_pct` / `success_rate_pct` / `aht_seconds` come from
 * {@link ratePct} / {@link ratio} in {@link groupRowFromSql}, like every other rate
 * on this surface. Two reasons the numbers are not read off these columns instead:
 * a Postgres `numeric` division round-tripped through text can differ in its last
 * digits from the JS float division the roster and the per-agent record use, so the
 * same data would report two slightly different rates on two adjacent screens; and
 * the null-on-empty-denominator rule would then have two implementations. What
 * these must agree with the helpers on is only the ORDER — which holds because
 * `x/d` and `100·x/d` rank identically for positive `d`, and both are null on
 * exactly `d = 0`.
 */
const GROUP_SORT_ORDER_SQL: Record<Exclude<AgencyGroupSort, 'key'>, string> = {
  attempts: 'g.attempts::numeric',
  connected: 'g.connected::numeric',
  successes: 'g.successes::numeric',
  connect_rate_pct: 'g.connected::numeric / NULLIF(g.attempts::numeric, 0)',
  success_rate_pct: 'g.successes::numeric / NULLIF(g.connected::numeric, 0)',
  aht_seconds:
    '(g.talk_seconds::numeric + g.wrapup_seconds::numeric) / NULLIF(g.connected::numeric, 0)',
};

/**
 * One row as the grouped statement returns it: every column a string, and the key
 * columns present only when their dimension was grouped.
 *
 * Optional on the type rather than asserted, because the statement genuinely does
 * not select them — a mapper that read `row.day` on an agent-grouped read must be
 * a compile error, not an `undefined` that becomes the string `"undefined"` in a
 * key.
 */
interface AgencyGroupRawRow {
  agent_user_id?: string;
  campaign_id?: string;
  disposition_code?: string | null;
  day_start?: string;
  day_of_week?: string;
  hour_of_day?: string;
  attempts: string;
  connected: string;
  successes: string;
  talk_seconds: string;
  wrapup_seconds: string;
  total_groups: string;
}

/**
 * How each dimension is read back onto the key, as the inverted `Record` for the
 * third time — and the three objects are separate deliberately.
 *
 * {@link AGENCY_GROUP_DIMENSIONS} guards the 400, {@link GROUP_DIMENSION_SQL}
 * builds the statement, and this reads the answer. They guard three different
 * failures, and a dimension present in one and missing from another is a build
 * error whichever one was forgotten.
 *
 * ⚠️ `disposition` assigns UNCONDITIONALLY, including when the value is `null`.
 * That is the grouped-stats contract's null-key rule expressed in one line: `null` is a real key value
 * — the un-dispositioned group — so the member must be PRESENT and null, never
 * absent. `?? null` also normalises a missing column to `null` rather than letting
 * `undefined` reach a JSON payload, where it would vanish and make the group look
 * un-grouped.
 */
const GROUP_KEY_READERS: Record<
  AgencyGroupDimension,
  (row: AgencyGroupRawRow, key: AgencyGroupKey) => void
> = {
  agent: (row, key) => { key.agent_user_id = row.agent_user_id ?? ''; },
  campaign: (row, key) => { key.campaign_id = row.campaign_id ?? ''; },
  disposition: (row, key) => { key.disposition_code = row.disposition_code ?? null; },
  day: (row, key) => { key.day = row.day_start ?? ''; },
  // `?? '0'`, and NOT a bare `Number(...)`. The contract types both of these
  // `number`, `Number(undefined)` is `NaN`, and `JSON.stringify` turns `NaN` into
  // `null` -- so a missing column would ship a null on a non-nullable field and be
  // invisible on the wire, which is the same failure the readers above spend their
  // `?? ''` on. The fallback is unreachable (the column is selected iff the
  // dimension is grouped, and the three Records above are what keep that true), and
  // that unreachability is what makes 0 an acceptable choice even though 0 is also a
  // REAL value for both -- Sunday, and midnight. A legal in-range value a console
  // can render beats a null the type says cannot happen; if this ever fires, the
  // bug is a missing Record entry, not the payload.
  day_of_week: (row, key) => { key.day_of_week = Number(row.day_of_week ?? '0'); },
  hour_of_day: (row, key) => { key.hour_of_day = Number(row.hour_of_day ?? '0'); },
};

/**
 * One SQL row → one {@link AgencyGroupRow}.
 *
 * A free function rather than an inline `map` body for the same reason
 * `rosterBenchmark` is one: it is pure, it issues no statement, and the rules it
 * carries — which key members exist, and that every rate comes from the shared
 * helper — are the two things a reviewer needs to check without reading SQL.
 *
 * The key is assembled by walking `groupBy` rather than by inspecting which
 * columns the row happens to have, so `AgencyGroupPage.group_by` and the key's
 * members cannot disagree: the echoed list IS the list that built the key.
 *
 * Every rate goes through {@link ratePct} / {@link ratio}. A hand-rolled
 * `n / d * 100` here would answer `NaN` on a zero denominator, `NaN` serialises to
 * `null` in JSON, and the bug would be invisible on the wire until a consumer did
 * arithmetic with it.
 */
function groupRowFromSql(row: AgencyGroupRawRow, groupBy: readonly AgencyGroupDimension[]): AgencyGroupRow {
  const key: AgencyGroupKey = {};
  for (const dimension of groupBy) GROUP_KEY_READERS[dimension](row, key);

  const {
    attempts, connected, successes, talk_seconds: talkSeconds, wrapup_seconds: wrapupSeconds,
  } = readAttemptMetrics(row);

  return {
    key,
    attempts,
    connected,
    successes,
    talk_seconds: talkSeconds,
    wrapup_seconds: wrapupSeconds,
    // `null`, never `0`, on a zero denominator — the imported rule, unchanged.
    //
    // Note that `attempts` is >= 1 on every row this statement can emit (`COUNT(*)`
    // over an all-INNER `GROUP BY` filtered on `dialed_at IS NOT NULL` cannot
    // produce a group with no rows), so `connect_rate_pct` is never actually null
    // here. It goes through the helper anyway: the rule belongs to one function
    // rather than to a reachability argument that a later `LEFT JOIN` would quietly
    // invalidate.
    connect_rate_pct: ratePct(connected, attempts),
    // The denominator is CONNECTED, not attempts: a call that never bridged had no
    // conversation to convert. This one IS reachably null — a group that connected
    // nobody is an ordinary row.
    success_rate_pct: ratePct(successes, connected),
    aht_seconds: ratio(talkSeconds + wrapupSeconds, connected),
    // The SERVER decides whether these rates may be quoted as numbers, because a
    // consumer recomputing the threshold from the exported constant would disagree
    // with this line the moment the threshold is tuned. Same constant as the roster
    // row, not a second one holding the same value.
    //
    // `attempts` — the row's headline denominator — so one bool covers the one rate
    // built on it, and the reading holds whatever was grouped: enough dials behind
    // this cell to quote a connect rate for it, whether the cell is a person, a
    // campaign, a disposition or one weekday-hour of a heatmap.
    rates_reportable: attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
    // The SECOND flag, and it is not a nicety: `attempts >= 20` says nothing about
    // `connected`, so a row of 20 dials with ONE connect and one conversion is
    // `rates_reportable` and carries `success_rate_pct: 100` — which is the exact
    // number, beside a named person on the contribution screen, that the first flag
    // was added to stop a console printing. One threshold on one denominator could
    // not cover two denominators; this is the per-metric floor the house rule asks
    // for, from the same constant and the same predicate the roster's percentile
    // pools use.
    success_rate_reportable: hasRateDenominator({ connected }),
  };
}

/**
 * The agent's own record (`GET /api/v1/agency-agents/:agentUserId/stats`).
 *
 * Its own class for the same reason `AgencyAbandonmentRepository` has one: the
 * question it answers is not a campaign's. Every other read here starts from a
 * campaign id; this one starts from a PERSON, joins to their sessions, and only
 * then reaches attempts and campaigns — so its predicates, its indexes and its
 * grouping have nothing in common with the supervisor dashboard's.
 *
 * ── Two round trips, on purpose ─────────────────────────────────────────────
 *
 * `campaignStats` keeps every scalar aggregate in ONE statement because its
 * numerator and denominator both resolve `now()` and a rate built from two
 * statements can exceed 100% on arithmetic alone. That hazard does not exist
 * here: both reads are bounded by the SAME caller-supplied `[from, to)` window,
 * not by `now()`, so they cannot disagree about which window they measured. The
 * one place `now()` does appear — closing an open final interval — is in the
 * occupancy read alone and has no counterpart in the other.
 *
 * What they do not share is shape: one aggregates ATTEMPTS by (bucket,
 * campaign), the other aggregates INTERVALS by (bucket, state) from a different
 * table with a window function and a lateral series. There is no honest single
 * statement, and they are issued in parallel.
 *
 * ── Every counter in `totals` is the SUM of the buckets, computed here ───────
 *
 * Not read as a second aggregate with the grouping removed. The buckets, the
 * per-campaign rows and the totals are three foldings of one row set, so they
 * cannot disagree — the same reasoning `agents_by_state` uses when it tallies the
 * roster it already fetched rather than issuing its own `GROUP BY`. It also makes
 * the "cross-campaign totals sum exactly" property of the per-campaign-timezone
 * bucketing (see `AgencyAgentStats`) structural rather than a claim.
 */
export class AgencyAgentStatsRepository {
  /**
   * `scope` is the caller's tenant and account, and it is a REQUIRED predicate
   * rather than a filter.
   *
   * There is no campaign in this route's path, so there is nothing to run
   * `requireOwned` against: `agent_user_id` is the app's `users.id`, opaque to
   * the dialer tables, which cannot tell a real one from a guess. Both reads below therefore
   * scope on `agency_agent_sessions` — which carries the tenant and account
   * stamped from the campaign — so an agent id from another tenant resolves to no
   * sessions, no attempts and no events, i.e. an empty record rather than someone
   * else's.
   */
  async stats(
    scope: { tenantId: string; accountId: string; agentUserId: string },
    query: AgentStatsParams,
  ): Promise<AgencyAgentStats> {
    const [attemptRows, occupancyRows] = await Promise.all([
      this.attemptBuckets(scope, query),
      // ── Occupancy degrades ALONE; the rest of the record does not ─────────
      //
      // The two reads answer different questions and only one of them depends on
      // the session event log. An occupancy-specific failure — the events table
      // unreadable, the same drift the write
      // path already swallows — must not discard attempt totals that were read
      // successfully: the caller asked "what did I do", and answering it with a
      // 500 because a second statement about where their time went could not run
      // is strictly worse than answering it with the occupancy block at zero.
      //
      // This is the read-side counterpart of `recordTransitions`, which is
      // deliberately best-effort for the mirror-image reason (a dropped event
      // costs one occupancy row; a thrown error mid-transition takes an agent off
      // the floor). Both sides of the log are therefore non-fatal, and the warn
      // log is the only symptom either produces.
      //
      // ⚠️ The degraded value is `[]`, which `foldOccupancy` turns into
      // `zeroOccupancy()` — all six states present at zero. That is the only shape
      // available: `AgencyAgentOccupancy` documents `by_state` as "all six states,
      // always present", so there is no way to say "not measured" on this payload
      // and the degraded record is INDISTINGUISHABLE from an agent who has no
      // events at all (a session with no recorded transitions). Making the two distinguishable is
      // a contract change, not a catch block; until then the log line below is the
      // only place the difference exists.
      this.occupancyBuckets(scope, query).catch((err: unknown) => {
        log.warn(
          {
            err,
            agentUserId: scope.agentUserId,
            from: query.from.toISOString(),
            to: query.to.toISOString(),
          },
          'Agent occupancy read failed — serving the record with occupancy at zero',
        );
        return [] as { bucket_start: string; state: string; seconds: number }[];
      }),
    ]);
    const agentUserId = scope.agentUserId;

    /** One accumulator per bucket label, built from BOTH reads. */
    interface BucketAcc {
      attempts: number; connected: number; successes: number;
      talk: number; wrapup: number;
      occupancy: { state: string; seconds: number }[];
    }
    const emptyBucket = (): BucketAcc =>
      ({ attempts: 0, connected: 0, successes: 0, talk: 0, wrapup: 0, occupancy: [] });
    const buckets = new Map<string, BucketAcc>();
    const bucketFor = (label: string): BucketAcc => {
      const existing = buckets.get(label);
      if (existing) return existing;
      const fresh = emptyBucket();
      buckets.set(label, fresh);
      return fresh;
    };

    const campaigns = new Map<string, AgencyAgentCampaignRow>();

    for (const row of attemptRows) {
      const bucket = bucketFor(row.bucket_start);
      bucket.attempts += row.attempts;
      bucket.connected += row.connected;
      bucket.successes += row.successes;
      bucket.talk += row.talk_seconds;
      bucket.wrapup += row.wrapup_seconds;

      const campaign = campaigns.get(row.campaign_id) ?? {
        campaign_id: row.campaign_id,
        attempts: 0, connected: 0, successes: 0, talk_seconds: 0, wrapup_seconds: 0,
      };
      campaign.attempts += row.attempts;
      campaign.connected += row.connected;
      campaign.successes += row.successes;
      campaign.talk_seconds += row.talk_seconds;
      campaign.wrapup_seconds += row.wrapup_seconds;
      campaigns.set(row.campaign_id, campaign);
    }

    // A bucket that carries occupancy and no attempts is created here rather than
    // skipped: an agent who was on the floor and never dialled is one of the more
    // useful rows on this payload, and dropping it would make the record look like
    // they were not at work.
    for (const row of occupancyRows) {
      bucketFor(row.bucket_start).occupancy.push({ state: row.state, seconds: row.seconds });
    }

    // Lexicographic on `YYYY-MM-DD` IS chronological, which is half the reason the
    // label is formatted that way (the other half is that node-pg would parse a
    // bare timestamp into a local-time Date — see `bucketStartSql`).
    const labels = [...buckets.keys()].sort();

    const wireBuckets: AgencyAgentStatsBucket[] = labels.map((label) => {
      const acc = buckets.get(label) as BucketAcc;
      return {
        bucket_start: label,
        attempts: acc.attempts,
        connected: acc.connected,
        successes: acc.successes,
        talk_seconds: acc.talk,
        wrapup_seconds: acc.wrapup,
        occupancy: foldOccupancy(acc.occupancy),
      };
    });

    const totals = wireBuckets.reduce(
      (acc, bucket) => {
        acc.attempts += bucket.attempts;
        acc.connected += bucket.connected;
        acc.successes += bucket.successes;
        acc.talk += bucket.talk_seconds;
        acc.wrapup += bucket.wrapup_seconds;
        return acc;
      },
      { attempts: 0, connected: 0, successes: 0, talk: 0, wrapup: 0 },
    );
    // Folded from every occupancy row in one pass rather than by adding the
    // buckets' `shift_seconds` together — same rows, same answer, and it keeps the
    // "unknown state" and "negative interval" guards in exactly one place.
    const occupancy: AgencyAgentOccupancy = foldOccupancy(occupancyRows);

    return {
      agent_user_id: agentUserId,
      bucket: query.bucket,
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      totals: {
        attempts: totals.attempts,
        connected: totals.connected,
        // `null`, never `0`, on a zero denominator — the imported rule. Nothing
        // dialled is not a 0% connect rate.
        connect_rate_pct: ratePct(totals.connected, totals.attempts),
        successes: totals.successes,
        // The denominator is CONNECTED, not attempts: a call that never bridged
        // had no conversation to convert.
        success_rate_pct: ratePct(totals.successes, totals.connected),
        talk_seconds: totals.talk,
        wrapup_seconds: totals.wrapup,
        // Talk PLUS wrap-up over connected calls — deliberately a different
        // definition from `AgencyCampaignStats.aht_seconds` (talk only, voicemail
        // excluded). See the field's doc comment; the denominator is on the
        // payload so the number is always reproducible by the reader.
        aht_seconds: ratio(totals.talk + totals.wrapup, totals.connected),
        campaigns: campaigns.size,
        occupancy,
      },
      buckets: wireBuckets,
      by_campaign: [...campaigns.values()],
    };
  }

  /**
   * Attempts per (bucket, campaign) over `[from, to)` on `dialed_at`.
   *
   * ── The bucket is cut in the CAMPAIGN's timezone, per row ───────────────────
   *
   * `bucketStartSql` interpolates the validated unit and the resolved zone; the
   * product argument for having no `tz` parameter is on `AgencyAgentStats`. The
   * mechanical point here is that `c.default_timezone` comes off the attempt's own
   * campaign, so a cross-campaign query cuts each attempt in its own zone and
   * every attempt still lands in exactly one bucket.
   *
   * ── The zone is RESOLVED, never used raw ───────────────────────────────────
   *
   * `default_timezone` is `VARCHAR(64)` with no constraint and is populated from
   * customer-facing config, so it can hold anything. `some_ts AT TIME ZONE
   * 'Mars/Olympus'` raises `22023 invalid_parameter_value`, which nothing maps to
   * a status — so ONE campaign with a typo would 500 the whole record, including
   * every other campaign's numbers. The LEFT JOIN to `pg_timezone_names` turns
   * that into a fallback: a zone Postgres will not resolve yields NULL and the
   * COALESCE buckets those rows in UTC.
   *
   * That is the same shape as `calling-hours.ts`, which caches a per-zone
   * `Intl.DateTimeFormat` and returns null for one it cannot construct rather than
   * letting a `RangeError` out of the pacing tick — and it is deliberately as
   * strict: `pg_timezone_names` carries zone NAMES, not the abbreviations in
   * `pg_timezone_abbrevs`, so a bare `IST` falls back to UTC exactly as
   * `isUsableTimezone` refuses it. The join is once per statement over a ~1,200
   * row view, not once per attempt.
   *
   * It is also LATERAL and `LIMIT 1`, and that is about CARDINALITY rather than cost
   * — the join sits inside an aggregate's FROM, so two matching zone rows for one
   * campaign would double every counter for that campaign's attempts. See
   * {@link AGENCY_RESOLVED_ZONE_JOIN_SQL}, which is the single spelling all three
   * statements carrying this join interpolate.
   *
   * Bucketed on `dialed_at` and nothing else: `created_at` precedes the dial by a
   * dispatch hop (so it can bucket an attempt into a day nothing was dialled in)
   * and `ended_at` pushes a call straddling midnight into the later day while
   * leaving a live one in no day at all. `hourlyBuckets` states both, and this
   * follows it — including formatting the label in SQL, because node-pg parses a
   * bare `timestamp` into a LOCAL-time `Date` and would put the server's zone back
   * on the way out.
   */
  private async attemptBuckets(
    scope: { tenantId: string; accountId: string; agentUserId: string },
    p: AgentStatsParams,
  ): Promise<{
    bucket_start: string; campaign_id: string;
    attempts: number; connected: number; successes: number;
    talk_seconds: number; wrapup_seconds: number;
  }[]> {
    const zone = AGENCY_RESOLVED_ZONE_SQL;
    const bind = params();
    for (const value of [scope.agentUserId, p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
    const campaignFilter = p.campaignId
      ? `\n          AND a.campaign_id = ${bind.add(p.campaignId)}::uuid`
      : '';

    const { rows } = await getPool().query<{
      bucket_start: string; campaign_id: string;
      attempts: string; connected: string; successes: string;
      talk_seconds: string; wrapup_seconds: string;
    }>(
      `SELECT ${bucketStartSql(p.bucket, 'a.dialed_at', zone)} AS bucket_start,
              a.campaign_id,
              ${AGENCY_ATTEMPT_METRICS_SQL}
         FROM agency_call_attempts a
         JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
         JOIN agency_campaigns c ON c.id = a.campaign_id
         ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
        WHERE s.agent_user_id = $1
          AND s.tenant_id = $4
          AND s.account_id = $5
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $2
          AND a.dialed_at < $3${campaignFilter}
        GROUP BY 1, a.campaign_id
        ORDER BY 1, a.campaign_id`,
      bind.values,
    );

    return rows.map((r) => ({
      bucket_start: r.bucket_start,
      campaign_id: r.campaign_id,
      ...readAttemptMetrics(r),
    }));
  }

  /**
   * Seconds per (bucket, state), from the transition log.
   *
   * ── How an interval is built ────────────────────────────────────────────────
   *
   * The log records instants, not durations: an event says "this agent entered
   * `wrapup` at 14:02:11". The duration is therefore the gap to the NEXT event on
   * the same session, which is `lead(at) OVER (PARTITION BY session_id ORDER BY
   * at)`.
   *
   * Three clips make that safe at the edges:
   *
   *  1. **An OPEN final interval** — the newest event of a session, with nothing
   *     after it — is the agent's current state, and it has no end. It runs to
   *     `LEAST(now(), to)`: to the query's own upper bound if the window is
   *     historical, and to `now()` if it reaches into the present. Without this the
   *     current state contributes nothing at all, so the state an agent has been in
   *     all afternoon would be the one the record does not mention.
   *  2. **The event that CARRIES IN.** The state at `from` is set by the last event
   *     BEFORE `from`, which is not in the window. `carried` fetches exactly that
   *     one row per session (`DISTINCT ON … ORDER BY at DESC, id DESC`) and
   *     `GREATEST(at, from)` clips its interval to the window's start. Without it,
   *     an agent who went `available` at 08:55 and made their first call at 09:30
   *     would show 35 minutes of nothing in a window starting at 09:00 — and every
   *     occupancy figure would be low by however long the agent had been in their
   *     state.
   *
   *     **That clip is why `sess` is bounded to sessions overlapping the window,
   *     and the two are one mechanism rather than two.** `carried` fetches one row
   *     per session, so the read is bounded by the window only if the SESSION SET
   *     is — and per-session is per-shift. Left unbounded, every session the agent
   *     has ever closed still has a terminal event before `from`, and each one
   *     therefore carries in an interval with no successor inside the window, i.e.
   *     one that runs the window's full width. Sixty past shifts read as sixty
   *     full-window intervals: `by_state.offline` scaling with tenure rather than
   *     with the window, and `shift_seconds` inflated too for any session abandoned
   *     in a non-`offline` state. The `joined_at`/`left_at` overlap predicate is
   *     what makes “bounded by the window” true of the whole read.
   *  3. **Bucket splitting.** An interval that spans midnight belongs to two
   *     buckets, so it is CROSS JOINed to the buckets it covers and clipped to each
   *     (`LEAST(ended, bucket_end) - GREATEST(started, bucket_start)`). Attributing
   *     the whole interval to the bucket its START falls in would be the easy
   *     version and would put a night shift's whole occupancy on the first day.
   *
   * The bucket series is generated per interval from the same truncation
   * `bucketStartSql` uses, converted back through the campaign's zone so a DST day
   * is measured as the 23 or 25 hours it actually was.
   *
   * ── A session with no events reads as zero, and that is the honest answer ────
   *
   * Sessions with no recorded transitions have no rows here, so they contribute no
   * intervals and every state comes back 0 — see `zeroOccupancy`. The alternative
   * would be reconstructing time-in-state from `agency_agent_sessions.state_since`,
   * which is a snapshot every transition overwrites: it would attribute an agent's
   * ENTIRE history to whichever state they happen to be in now. Occupancy is
   * meaningful only where events were recorded.
   *
   * `offline` is measured and returned but excluded from `shift_seconds`
   * (`foldOccupancy`), so a session that ended hours ago cannot dilute occupancy
   * merely by having its final `offline` interval run to the end of the window.
   */
  private async occupancyBuckets(
    scope: { tenantId: string; accountId: string; agentUserId: string },
    p: AgentStatsParams,
  ): Promise<{
    bucket_start: string; state: string; seconds: number;
  }[]> {
    const bind = params();
    for (const value of [scope.agentUserId, p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
    const campaignFilter = p.campaignId
      ? `\n            AND s.campaign_id = ${bind.add(p.campaignId)}::uuid`
      : '';
    // The clipped overlap of one interval with one bucket. Named because it is
    // needed twice — in the SUM and in the HAVING that drops a zero-width bucket
    // (the series is inclusive of the bucket containing `ended`, so an interval
    // ending exactly on a boundary generates one bucket it does not occupy).
    const overlap =
      'EXTRACT(EPOCH FROM (LEAST(i.ended, b.bucket_end) - GREATEST(i.started, b.bucket_start)))';
    const zone = AGENCY_RESOLVED_ZONE_SQL;

    const { rows } = await getPool().query<{
      bucket_start: string; state: string; seconds: string;
    }>(
      `${occupancyIntervalsCtes('agent', campaignFilter)}       SELECT ${bucketStartSql(p.bucket, 'b.bucket_start', 'i.zone')} AS bucket_start,
              i.state,
              SUM(${overlap})::text AS seconds
         FROM intervals i
         CROSS JOIN LATERAL (
           SELECT (gs AT TIME ZONE i.zone) AS bucket_start,
                  ((gs + interval '1 ${p.bucket}') AT TIME ZONE i.zone) AS bucket_end
             FROM generate_series(
                    ${bucketTruncSql(p.bucket, 'i.started', 'i.zone')},
                    ${bucketTruncSql(p.bucket, 'i.ended', 'i.zone')},
                    interval '1 ${p.bucket}') gs
         ) b
        WHERE i.ended > i.started
        GROUP BY 1, i.state
       HAVING SUM(${overlap}) > 0
        ORDER BY 1, i.state`,
      bind.values,
    );

    return rows.map((r) => ({
      bucket_start: r.bucket_start,
      state: r.state,
      seconds: Number(r.seconds),
    }));
  }

  /**
   * ── THE ROSTER: every agent's performance in ONE read ─────────────────────
   *
   * `GET /api/v1/agency-agents/stats`. This is {@link stats} grouped one level
   * UP — per agent instead of per bucket — over the same half-open window, the
   * same two-hop join and the same scope predicate. There is no bucket on this
   * route, so there is no `date_trunc`, no `generate_series`, and **no campaign
   * timezone to resolve**: the `pg_timezone_names` LEFT JOIN both statements above
   * carry exists only to keep an unresolvable zone from raising `22023` inside a
   * bucket expression, and with no bucket expression there is nothing to protect.
   *
   * ── Scope, again, and for the same reason ─────────────────────────────────
   *
   * `tenant_id` AND `account_id` on `agency_agent_sessions` in EVERY statement.
   * There is no path parameter here at all, so there is even less to run an
   * ownership check against than on the per-agent record — the only thing
   * separating one account's floor from another's is the pair of predicates below.
   * A tenant-wide roster is a separate future mode; it must not be reachable by
   * omitting a parameter, which is why `accountId` is a required field of `scope`
   * rather than an optional filter on `params`.
   *
   * ── TWO READS, SEQUENTIAL — the one place this diverges from `stats()` ────
   *
   * `stats()` issues its two statements in parallel because both are bounded by
   * one agent id it already holds. This one cannot, and the reason is an index:
   * `idx_agency_session_events_agent` is `(agent_user_id, at)`, and **the index is only reachable because the reader
   * predicates on `agent_user_id`** — `session_id` is deliberately not indexed at
   * all. A roster-shaped occupancy read has no single agent, so issued in parallel
   * it would range on `e.at` with nothing on the index's leading column and drive
   * the join from an unindexed `session_id`: a sequential scan of the table
   * written on every state transition.
   *
   * So the attempts aggregate runs FIRST and its agent ids are bound into the
   * occupancy read as an array. That restores the exact predicate the index needs,
   * costs one round trip in series instead of two in parallel, and needs no new
   * index on a hot table. It also stops the occupancy read fetching agents the
   * roster is about to discard — see the row-set note below — and it lets the
   * second statement be skipped outright when nobody dialled.
   *
   * ── OCCUPANCY DEGRADES ALONE ─────────────────────────────────────────────
   *
   * Identical precedent to `stats()`, and the sequential order does not weaken it:
   * an occupancy-read failure is caught, warned, and serves the roster with every
   * agent's `shift_seconds`/`break_seconds` at 0 and `occupancy_pct` at `null`.
   * The supervisor asked who dialled what; answering with a 500 because a second
   * statement about where the floor's time went could not run discards numbers
   * that were already in hand. The mirror case is deliberately NOT caught: if the
   * attempts read fails there is no roster to serve.
   *
   * ── The row set is ATTEMPTS-driven, which is a correctness property ────────
   *
   * One row per agent who DIALLED in the window — the cohort
   * `AgencyRosterBenchmark` defines. An agent with occupancy and no dials gets no
   * line, unlike the per-agent record which deliberately emits their empty bucket.
   * Beyond matching the frozen cohort definition, this is what makes the degrade
   * above safe: if occupancy could ADD rows, a failed events-table read would
   * silently DELETE agents from the page, which is far worse than serving their
   * occupancy as zero. The row set must not change shape when a subsidiary read
   * fails.
   *
   * ── Why the ranking and the percentiles are NOT in SQL ────────────────────
   *
   * This is the design decision most likely to be read as laziness, so it is
   * derived rather than asserted. It is forced, in two steps:
   *
   *  1. `benchmark.occupancy_pct`'s percentiles are quantiles of
   *     `(talk + wrapup) / shift_seconds` **over the whole cohort**. `talk` and
   *     `wrapup` come from the attempts statement and `shift_seconds` from the
   *     occupancy statement, so that metric exists in neither one alone. Any
   *     `LIMIT` applied inside the attempts statement therefore destroys an input
   *     the benchmark needs — the limited page carries talk/wrapup for its own
   *     rows only.
   *  2. So the attempts statement must return the whole post-scope, pre-`limit`
   *     cohort, and `limit` can only be applied after the merge. Once the slice is
   *     out of SQL, so is the `ORDER BY` it slices: sorting in SQL and slicing in
   *     TypeScript would be two spellings of one comparator that must agree
   *     exactly on nulls and on the tiebreaker, and one of them would eventually
   *     be edited alone.
   *
   * The cohort is bounded by an account's HEADCOUNT (one row per agent, and
   * `limit`'s ceiling is 200), not by call volume, so the rows the aggregate
   * returns are cheap to carry. The upside is that `sort` and `order` never reach
   * a query at all: {@link sortRosterRows} is the single comparator, and the
   * injection surface for the two params that arrive as free text is zero rather
   * than merely well-guarded.
   *
   * `total_agents` is that same pre-`limit`, post-scope count, so the console can
   * say "showing 100 of 137" rather than implying the floor is the page.
   */
  async roster(
    scope: { tenantId: string; accountId: string },
    query: AgentRosterParams,
  ): Promise<AgencyRosterPage> {
    const attemptRows = await this.rosterAttemptTotals(scope, query);
    const agentIds = attemptRows.map((row) => row.agent_user_id);

    // Skipped rather than issued with an empty array: nobody dialled, so there is
    // no row for an occupancy figure to attach to, and `= ANY('{}')` is a
    // statement whose answer is known.
    const occupancyRows = agentIds.length === 0
      ? []
      : await this.rosterOccupancyTotals(scope, query, agentIds).catch((err: unknown) => {
        // Same catch, same warning, same reasoning as `stats()`: the realistic
        // failure is the event table being unreadable, which is
        // the drift the WRITE path already swallows in `recordTransitions`. Both
        // sides of the transition log are non-fatal and the warn line is the only
        // symptom either produces.
        log.warn(
          {
            err,
            tenantId: scope.tenantId,
            accountId: scope.accountId,
            agents: agentIds.length,
            from: query.from.toISOString(),
            to: query.to.toISOString(),
          },
          'Agent roster occupancy read failed — serving the roster with occupancy at zero',
        );
        return [] as { agent_user_id: string; state: string; seconds: number }[];
      });

    // Folded through `foldOccupancy` per agent rather than summed here, so the
    // unknown-state drop, the negative-interval clamp and the "shift excludes
    // offline" rule keep exactly one definition across both read surfaces.
    const byAgent = new Map<string, { state: string; seconds: number }[]>();
    for (const row of occupancyRows) {
      const existing = byAgent.get(row.agent_user_id);
      if (existing) existing.push(row);
      else byAgent.set(row.agent_user_id, [row]);
    }

    const rows: AgencyRosterAgentRow[] = attemptRows.map((row) => {
      const occupancy = byAgent.has(row.agent_user_id)
        ? foldOccupancy(byAgent.get(row.agent_user_id) as { state: string; seconds: number }[])
        : zeroOccupancy();
      const handled = row.talk_seconds + row.wrapup_seconds;
      return {
        agent_user_id: row.agent_user_id,
        attempts: row.attempts,
        connected: row.connected,
        successes: row.successes,
        talk_seconds: row.talk_seconds,
        wrapup_seconds: row.wrapup_seconds,
        // `null`, never `0`, on a zero denominator — the imported rule, and the
        // same helper every other rate on this surface uses. Nothing dialled is
        // not a 0% connect rate.
        connect_rate_pct: ratePct(row.connected, row.attempts),
        // The denominator is CONNECTED, not attempts: a call that never bridged
        // had no conversation to convert, so charging it here would make an
        // agent's conversion a function of the list's answer rate.
        success_rate_pct: ratePct(row.successes, row.connected),
        aht_seconds: ratio(handled, row.connected),
        campaigns: row.campaigns,
        shift_seconds: occupancy.shift_seconds,
        break_seconds: occupancy.by_state.break,
        // This route PICKS a denominator where `AgencyAgentOccupancy` deliberately
        // does not, because a roster column has to be one number. Break time is
        // INCLUDED; `shift_seconds - break_seconds` is the other reading and both
        // parts are on the row, so nothing is lost. `null` — never 0 — on a zero
        // shift, which is also what a degraded occupancy read produces.
        //
        // ── And `null` when the numerator EXCEEDS the denominator ───────────
        //
        // Nothing constrains this ratio to <= 1, because its two halves are
        // measured on two INDEPENDENT tables: the numerator (talk + wrapup) on
        // `agency_call_attempts`, which every settled attempt writes
        // transactionally, and the denominator on `agency_agent_session_events`,
        // whose writes are BEST-EFFORT — `recordTransitions` swallows a failed
        // INSERT with a warn and no rethrow. A dropped transition shortens the
        // shift while the calls it contained stay counted, so the ratio can pass
        // 100% by an arbitrary factor; 716% has been observed on a real read.
        //
        // NOT clamped to 100. A clamp hands the reader a plausible number computed
        // from an inconsistency, and "fully occupied" is a claim this data cannot
        // support. `null` is the value this column already documents for
        // "unmeasured", and reusing it drops the row from the percentile pools for
        // free — they filter nulls — which is the half that actually matters: an
        // impossible value left in the pool drags `occupancy_pct.p75` upward and
        // every other agent is then flagged against a cohort containing it, and
        // the same row ranks #1 under `?sort=occupancy_pct&order=desc`.
        //
        // `>=` rather than `>` so the equal case — including 0/0 — still goes
        // through `ratePct`, which is what keeps the zero-shift null a property of
        // one helper rather than of two branches.
        occupancy_pct: occupancy.shift_seconds >= handled
          ? ratePct(handled, occupancy.shift_seconds)
          : null,
        last_dialed_at: row.last_dialed_at,
        // The row's HEADLINE denominator. A row that fails this contributes to no
        // percentile pool, which is what makes the flag usable as the single gate
        // its contract doc promises. The rates are still served either way.
        rates_reportable: row.attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
        // The CONNECTED floor, from the same predicate the `success_rate` and `aht`
        // pools are admitted by — so a console gating on this flag withholds
        // exactly the rows the benchmark refused to rank, rather than a set that
        // agrees with it by coincidence.
        success_rate_reportable: hasRateDenominator(row),
      };
    });

    return {
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      campaign_id: query.campaignId ?? null,
      sort: query.sort,
      order: query.order,
      limit: query.limit,
      // PRE-`limit`, post-scope. Taken from `rows` rather than from a third
      // `COUNT(*)` statement, which is what makes it structurally equal to
      // `benchmark.agents` instead of a number two reads have to keep agreeing on.
      total_agents: rows.length,
      rows: sortRosterRows(rows, query.sort, query.order).slice(0, query.limit),
      // Computed over EVERY row, before the slice. A benchmark drawn from the page
      // would move when the caller changed `limit` — a different number under the
      // same name, which is the failure its own doc comment names about
      // `include_inactive`.
      benchmark: rosterBenchmark(rows),
    };
  }

  /**
   * One row per agent who dialled, over `[from, to)` on `dialed_at`.
   *
   * `stats()`'s `attemptBuckets` with the bucket removed and the agent id moved
   * from a predicate into the `GROUP BY`. Every column definition is the same,
   * character for character, and for the reasons stated there — the AGENT's leg for talk time
   * rather than the persisted column, orphans excluded because the reaper stamps
   * `ended_at` at sweep time, MEASURED wrap-up rather than the campaign's
   * allotment — because the roster and the per-agent record are read side by side
   * and a supervisor will subtract one from the other.
   *
   * ── The index this drives, and why it is the BILLING one ──────────────────
   *
   * Not `idx_agency_attempts_agent_dialed`. That index is
   * `(reserved_agent_id, dialed_at DESC) WHERE dialed_at IS NOT NULL` and its
   * leading column is a session id this statement has no predicate on — the whole
   * point of a roster is that it does not name an agent. What fits exactly is
   * `idx_agency_attempts_billing`:
   * `(dialed_at, campaign_id) WHERE dialed_at IS NOT NULL`, whose own comment says
   * `dialed_at` MUST lead because the billing sweep "is a time range across all
   * campaigns and has no campaign_id to filter on". That is this statement's shape
   * too, and `?campaign_id=` narrows on the index's second column when supplied.
   * The sessions and campaigns then join by primary key.
   *
   * So the roster's attempt aggregate needs no new index, and `idx_agency_attempts_agent_dialed` stays the single-agent read's index,
   * not this one's.
   */
  private async rosterAttemptTotals(
    scope: { tenantId: string; accountId: string },
    p: AgentRosterParams,
  ): Promise<{
    agent_user_id: string;
    attempts: number; connected: number; successes: number;
    talk_seconds: number; wrapup_seconds: number;
    campaigns: number; last_dialed_at: string | null;
  }[]> {
    const bind = params();
    for (const value of [p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
    const campaignFilter = p.campaignId
      ? `\n          AND a.campaign_id = ${bind.add(p.campaignId)}::uuid`
      : '';

    const { rows } = await getPool().query<{
      agent_user_id: string;
      attempts: string; connected: string; successes: string;
      talk_seconds: string; wrapup_seconds: string;
      campaigns: string; last_dialed_at: string | null;
    }>(
      `SELECT s.agent_user_id,
              ${AGENCY_ATTEMPT_METRICS_SQL},
              -- Distinct CAMPAIGNS dialled, not sessions joined: a session is per
              -- shift, so an agent who worked one campaign across three days would
              -- otherwise read as three campaigns.
              COUNT(DISTINCT a.campaign_id)::text AS campaigns,
              -- Formatted in SQL for the same reason every other instant on this
              -- surface is: node-pg's parsing of a bare timestamp reintroduces the
              -- server's zone. Never NULL in practice -- the WHERE clause requires
              -- dialed_at -- but typed nullable rather than asserted.
              to_char(MAX(a.dialed_at) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_dialed_at
         FROM agency_call_attempts a
         JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
         JOIN agency_campaigns c ON c.id = a.campaign_id
        WHERE s.tenant_id = $3
          AND s.account_id = $4
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $1
          AND a.dialed_at < $2${campaignFilter}
        GROUP BY s.agent_user_id
        ORDER BY s.agent_user_id`,
      bind.values,
    );

    return rows.map((r) => ({
      agent_user_id: r.agent_user_id,
      ...readAttemptMetrics(r),
      campaigns: Number(r.campaigns),
      last_dialed_at: r.last_dialed_at,
    }));
  }

  /**
   * ── GET /api/v1/agency-agents/grouped-stats — ONE GENERAL GROUPED AGGREGATE ─
   *
   * `rosterAttemptTotals`' row set, regrouped by one or two CALLER-CHOSEN
   * dimensions instead of by agent. The five metric expressions are the shared
   * {@link AGENCY_ATTEMPT_METRICS_SQL} — the same string this file's two other
   * attempts aggregates interpolate — which is what makes a grouped cell, a roster
   * line and an agent's own scorecard agree on the same attempts.
   *
   * Precisely: that row set TIMES its matching `pg_timezone_names` rows, because
   * this statement carries a join `rosterAttemptTotals` does not
   * ({@link AGENCY_RESOLVED_ZONE_JOIN_SQL}). The two are the same row set only
   * because that join is LATERAL and `LIMIT 1`, so the multiplier is exactly one for
   * every campaign — matched or not. That is the whole reason it is written as a
   * lateral: without it, "regrouped" would be a claim about tzdata's contents rather
   * than about this statement.
   *
   * ⚠️ And "that row set" holds EXACTLY when `agent` is grouped. Where it is not,
   * this read is deliberately WIDER than the roster's: the session join goes LEFT,
   * so attempts that never reached an agent are counted too. That is stated here as
   * well as at the join because a reader arriving from `rosterAttemptTotals` will
   * otherwise subtract one from the other and expect zero. See the join for why the
   * two questions differ.
   *
   * ── ONE aggregate statement, and `limit` is pushed DOWN into it ────────────
   *
   * The opposite of `roster()`, and the difference is worth stating because the
   * two reads sit next to each other. The roster CANNOT carry a `LIMIT`: its
   * benchmark's occupancy percentiles need per-agent talk+wrapup from one statement
   * and shift_seconds from another, for the WHOLE cohort, so a limit inside either
   * destroys an input the payload needs — and a test pins the absence. This read
   * has no benchmark and no aggregate over the rows the page omits, so nothing
   * outside the page depends on them, and the limit belongs where the rows are:
   * in SQL, so a 400-group matrix costs 200 rows over the wire instead of 400.
   *
   * `total_groups` is the one thing that DOES need the pre-limit count, and it
   * comes from `COUNT(*) OVER ()` in the outer select rather than from a second
   * `COUNT(*)` statement. Window functions are evaluated before `LIMIT`, so the
   * number is the pre-limit group count by construction — where two statements
   * would be two scans that could disagree if a write landed between them.
   *
   * ⚠️ And that window has a COST worth naming, because it partly offsets the
   * paragraph above. An EMPTY partition (`OVER ()`) cannot emit its first row until
   * it has seen the last one, so the plan MATERIALISES all `total_groups` rows —
   * spilling to disk past `work_mem` — even when `limit` is 1. Two dimensions over
   * a 92-day window can be tens of thousands of groups, and the server sets no
   * `statement_timeout` anywhere, so nothing cuts that short. Pushing the slice down
   * still wins on what crosses the WIRE, which is what it was for; it does not make
   * the read cheap, and the window cap is the only thing bounding it.
   *
   * ── The ORDER BY is TOTAL, which is what makes `limit` reproducible ────────
   *
   * Every ORDER BY here ends with the full grouped key ascending. The key is unique
   * per row by definition of `GROUP BY`, so the ordering has no ties at all — and
   * with the slice now in SQL, a partial order would mean two identical requests
   * returning DIFFERENT rows rather than merely the same rows in a different order.
   * `NULLS LAST` is spelled explicitly in both directions (Postgres defaults it
   * last only under `ASC`), so an unranked row is never on the first page of a
   * ranked question — the same rule, and the same words, as {@link sortRosterRows}.
   *
   * ── `sort` / `order` / `group_by` / `limit` still interpolate NOTHING ──────
   *
   * Unlike the roster, this read's ordering and slicing DO happen in SQL — so the
   * injection answer cannot be "they never reach a statement". It is instead that
   * every one of them resolves through a TypeScript `Record` lookup keyed on a
   * validated union member to a static fragment written in this file:
   * {@link GROUP_DIMENSION_SQL}, {@link GROUP_SORT_ORDER_SQL}. No caller-supplied
   * character reaches the statement; `limit` is a bound parameter like every value.
   *
   * ── The zone apparatus is reused unchanged, and joined UNCONDITIONALLY ─────
   *
   * {@link AGENCY_RESOLVED_ZONE_JOIN_SQL} with {@link AGENCY_RESOLVED_ZONE_SQL},
   * exactly as `attemptBuckets` has it and for exactly the reason stated there:
   * `default_timezone` is `VARCHAR(64)` with no constraint, `ts AT TIME ZONE
   * 'Mars/Olympus'` raises `22023 invalid_parameter_value`, and nothing maps that to
   * a status — so ONE campaign with a typo would take out every other campaign's
   * numbers in the same statement. The LEFT JOIN turns that into a per-row fallback
   * to UTC, and the LATERAL `LIMIT 1` is what keeps it from being able to FAN OUT —
   * read that constant, because the cardinality is what this statement's numbers
   * rest on, not merely its cost.
   *
   * Joined even when no time dimension is grouped, for two reasons and only the
   * second is about cost. The FIRST: making the FROM clause depend on `group_by`
   * means a future dimension whose expression reads `z.name` with no `z` in scope —
   * a runtime `42P01` on a statement that type-checks, discovered by whoever asked
   * the new question first. The SECOND: one join against a ~1,200-row view, once per
   * statement, which is cheap enough that the first reason wins uncontested.
   *
   * Whether a time dimension may be grouped AT ALL is decided in
   * {@link parseGroupedStatsQuery}: across campaigns in different
   * zones "the 18:00 row" is not one thing, so it is refused rather than answered
   * in UTC. That refusal is a product rule and lives with the other parsing rules;
   * by the time this method runs, the zone is already unambiguous.
   *
   * ── No new index ──────────────────────────────────────────────────────────
   *
   * The driving predicate is the half-open window on `dialed_at` plus an optional
   * `campaign_id`, with the sessions and campaigns joined by primary key — which is
   * `idx_agency_attempts_billing`, `(dialed_at, campaign_id) WHERE
   * dialed_at IS NOT NULL`, leading on exactly the column this scan is driven from.
   * Same argument as `rosterAttemptTotals`, and the same conclusion: nothing here
   * wants an index that does not exist. Grouping columns do not want indexes anyway
   * — the aggregate has to visit every qualifying row whatever it groups by.
   */
  async groupedStats(
    scope: { tenantId: string; accountId: string },
    p: AgentGroupedParams,
  ): Promise<AgencyGroupPage> {
    // Bound in the SAME ORDER as `rosterAttemptTotals`: from, to, tenant, account,
    // then the optional campaign. That statement and this one share their whole
    // FROM clause and their whole WHERE clause, so a future editor will diff or
    // copy between them — and a swapped from/to survives review, because an
    // inverted window is an empty result rather than an error. `limit` goes last
    // because it is the only parameter that belongs to the page rather than to the
    // rows.
    const bind = params();
    for (const value of [p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
    const campaignFilter = p.campaignId
      ? `\n          AND a.campaign_id = ${bind.add(p.campaignId)}::uuid`
      : '';

    // Every fragment below comes from a `Record` keyed on a validated union member.
    // `p.groupBy` is already canonical and deduplicated (`parseGroupedStatsQuery`),
    // so the ordinals, the select list and the key mapper walk the same list in the
    // same order — which is what makes the echoed `group_by` describe the row shape.
    const dimensions = p.groupBy.map((dimension) => GROUP_DIMENSION_SQL[dimension]);
    const innerSelect = dimensions
      .map((dimension) => `${dimension.select} AS ${dimension.alias}`)
      .join(',\n              ');
    // Ordinals rather than repeating the expressions: `date_trunc(...)` in a GROUP
    // BY has to be spelled identically to the select-list copy or Postgres treats
    // them as different expressions, and one spelling cannot drift from itself.
    const groupOrdinals = dimensions.map((_dimension, index) => index + 1).join(', ');
    // `project`, not `g.<alias>`: a numeric dimension is cast to text HERE and not
    // in the CTE, so the ORDER BY below still reads an integer column. See
    // GROUP_DIMENSION_SQL — a text-typed hour sorts '10' before '9'.
    const outerSelect = dimensions.map((dimension) => dimension.project).join(', ');

    const direction = p.order === 'asc' ? 'ASC' : 'DESC';
    // The key, ascending, terminates EVERY ordering — see the header. Under
    // `sort=key` it IS the ordering and takes the caller's direction; under a metric
    // sort it is the tiebreak and stays ascending, so flipping an unrelated column's
    // direction cannot reshuffle a stable page.
    const keyOrder = (keyDirection: string): string => dimensions
      .map((dimension) => `g.${dimension.alias} ${keyDirection} NULLS LAST`)
      .join(', ');
    const orderBy = p.sort === 'key'
      ? keyOrder(direction)
      : `${GROUP_SORT_ORDER_SQL[p.sort]} ${direction} NULLS LAST, ${keyOrder('ASC')}`;

    const limitPlaceholder = bind.add(p.limit);

    // ── The SECOND statement, and why there is one at all ────────────────────
    //
    // `resolved_timezone` is the zone this page's buckets were ACTUALLY cut in, and
    // it exists only when there IS one zone: a zoned dimension grouped AND the read
    // filtered to one campaign (`groupedPageHasSingleZone`, which carries the
    // derivation). A `campaign,hour_of_day` read with no filter spans every
    // campaign in the account, each row cut in its own zone, and reports `null`.
    //
    // It is read from `agency_campaigns` rather than off the CTE's rows, and that
    // is the whole reason it cannot ride the statement above: a zoned read whose
    // window holds NO attempts returns zero rows, so a zone taken off the rows
    // would be `null` on precisely the page that most needs its axis labelled — an
    // empty heatmap is still a heatmap, and an unlabelled hour axis re-introduces
    // "the 18:00 column is not a fact until a zone is named" at the presentation
    // layer.
    //
    // ⚠️ A deliberate, narrow exception to this read's one-statement rule, and
    // it is not in tension with the reason this read refuses occupancy: occupancy
    // scans `agency_agent_session_events`, whose `session_id` is indexed
    // by nothing, against a row count that is a PRODUCT of cardinalities. This is a
    // primary-key lookup of one campaign row plus a lateral against a ~1,200-row
    // view, at most once per request, and only on the single-campaign zoned read —
    // the reads that refusal protects do not issue it at all.
    const zoneCampaignId = groupedPageHasSingleZone(p) ? p.campaignId : undefined;

    // ── The session join is LEFT unless `agent` is what is being ATTRIBUTED ────
    //
    // `agency_call_attempts.reserved_agent_id` is NULLABLE and it is
    // NULL on every attempt that failed before an agent was ever on it. An INNER
    // join therefore DROPS those attempts, and on a campaign-shaped read
    // (`hour_of_day`, `campaign`, `disposition`, `day`, with no `agent`) dropping
    // them is wrong three ways: it understates the very hour a supervisor is about
    // to move staffing to, it disagrees with the billing sweep (which selects on
    // `dialed_at IS NOT NULL` and joins no session at all), and it disagrees with
    // the campaign attempt spine, which LEFT joins the session ON PURPOSE and says
    // so. "When do dials connect" includes a dial that never reached an agent: that
    // dial is a real attempt, with a real outcome, in a real hour.
    //
    // When `agent` IS grouped the join stays INNER, and that is not an
    // inconsistency. There the join IS the attribution mechanism —
    // `s.agent_user_id` is the KEY — and an attempt with no session belongs to no
    // agent and therefore to no group. A LEFT join there would emit a `null`-keyed
    // row: a person-shaped group that is not a person, on a payload whose key is
    // documented as an agent id.
    //
    // ⚠️ So the two readings deliberately do NOT reconcile: an hour-grouped total
    // can exceed the sum of the agent-grouped rows over the same window, and the
    // difference is exactly the unreserved attempts. That is the same asymmetry
    // `inactive_omitted` documents in `agency-agent-identity.ts`, one layer down, and it is a
    // property of the QUESTION rather than a defect of the statement.
    //
    // ── Which is why the scope predicate now sits on the ATTEMPT ───────────────
    //
    // It read `s.tenant_id = $3 AND s.account_id = $4`, which cannot survive a LEFT
    // join: the NULL side fails it, so every unreserved attempt would be dropped by
    // the WHERE clause instead of by the join, and the fix above would be silently
    // undone. The scope is therefore a predicate on `a` — which is where it belongs
    // anyway. The attempt is the row being counted, `a.tenant_id`/`a.account_id` are
    // `NOT NULL`, and that is the column pair the billing sweep
    // scopes on. The session's own scope is not lost: it moves into the JOIN
    // condition, so a session in another account cannot attribute this account's
    // attempt under EITHER join word — it drops the row where `agent` is grouped,
    // exactly as before, and reads as unattributed where it is not.
    //
    // ── And the LEFT join costs nothing, which is checkable rather than assumed ─
    //
    // `s.id` is the primary key, so the join is at most one row per attempt: the
    // LEFT join cannot fan out and cannot double a counter, which matters here for
    // the same reason it does on the zone lateral. Better than that, `s` is not
    // SELECTED at all on the reads that take the LEFT join — `agent` is the only
    // dimension that reads it — so Postgres's join-removal rewrite drops the join
    // outright. Verified on this statement's real shape against Postgres 16: the
    // plan for an `hour_of_day` read contains no `agency_agent_sessions` node at
    // all. So the LEFT join is not a cost traded for correctness; it is free, and
    // keeping it (rather than emitting no session join at all) is what stops a
    // future dimension that reads `s` from meeting a `42P01` at runtime on a
    // statement that type-checks.
    //
    // One spelling of the ON clause, one varying word. The alternative — two whole
    // join clauses — is how the tenant predicate comes to be present on one of them.
    const sessionJoin = `${p.groupBy.includes('agent') ? 'JOIN' : 'LEFT JOIN'} agency_agent_sessions s ON s.id = a.reserved_agent_id
          AND s.tenant_id = $3
          AND s.account_id = $4`;

    // ── ONE CLIENT, ONE TRANSACTION, ONE SNAPSHOT ─────────────────────────────
    //
    // The two statements were issued in PARALLEL on the pool, which is two
    // connections and therefore two READ COMMITTED snapshots taken at two instants.
    // A `default_timezone` UPDATE committing between them is all it takes for the
    // zone this page REPORTS to differ from the zone its buckets were CUT in — the
    // one thing this field exists to rule out. Nor is it a hypothetical race over a
    // never-touched column: `default_timezone` is customer-facing config, and an
    // operator correcting a typo'd zone is PRECISELY the moment the two reads
    // disagree — which is also the moment the stored value and the resolved value
    // differ, i.e. the case the whole apparatus was built for.
    //
    // So both reads go on one client inside one `REPEATABLE READ` transaction. That
    // isolation level takes its snapshot at the FIRST statement and holds it for the
    // rest of the transaction, so the zone lookup necessarily reads the same
    // `agency_campaigns` row the grouped statement bucketed with, whatever commits
    // in between. `READ ONLY` is spelled out because both statements are reads and a
    // transaction that cannot write cannot be turned into one by a later edit.
    //
    // ⚠️ The grouped statement goes FIRST, and that is load-bearing twice: it is the
    // statement that TAKES the snapshot (so the zone can never be read from BEFORE
    // the buckets were cut), and every `sql()`/`params()` assertion in
    // `agent-grouped-repository.test.ts` reads the first non-control statement.
    //
    // The transaction is opened only when there IS a second statement to hold inside
    // it. A lone statement is one snapshot by construction, and wrapping it would
    // add a BEGIN and a COMMIT round trip to every contribution and trend read on
    // this surface — the ~all of them that report no zone — for a guarantee they
    // already have. Both branches issue the identical text with the identical
    // values, built once here, so they cannot drift in what they ASK; they differ
    // only in whether a companion read is held to the same snapshot.
    const groupedSql = `WITH grouped AS (
       SELECT ${innerSelect},
              ${AGENCY_ATTEMPT_METRICS_SQL}
         FROM agency_call_attempts a
         ${sessionJoin}
         JOIN agency_campaigns c ON c.id = a.campaign_id
         ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
        WHERE a.tenant_id = $3
          AND a.account_id = $4
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $1
          AND a.dialed_at < $2${campaignFilter}
        GROUP BY ${groupOrdinals}
     )
     SELECT ${outerSelect},
            g.attempts, g.connected, g.successes, g.talk_seconds, g.wrapup_seconds,
            -- PRE-limit by construction: a window function is evaluated before
            -- LIMIT, so this counts the groups the CTE produced rather than the
            -- rows that survived the slice. A second COUNT(*) statement would be a
            -- second scan that could disagree with this one.
            COUNT(*) OVER ()::text AS total_groups
       FROM grouped g
      ORDER BY ${orderBy}
      LIMIT ${limitPlaceholder}`;

    let rows: AgencyGroupRawRow[];
    let resolvedTimezone: string | null = null;
    if (zoneCampaignId === undefined) {
      ({ rows } = await getPool().query<AgencyGroupRawRow>(groupedSql, bind.values));
    } else {
      // On a throw `withTransaction` rolls back, which here undoes nothing — the
      // transaction is READ ONLY — and only releases the snapshot.
      ({ rows, resolvedTimezone } = await withTransaction(async (client) => ({
        rows: (await client.query<AgencyGroupRawRow>(groupedSql, bind.values)).rows,
        resolvedTimezone: await this.resolvedCampaignZone(scope, zoneCampaignId, client),
      }), { pool: getPool(), isolation: 'REPEATABLE READ', readOnly: true }));
    }

    return {
      from: p.from.toISOString(),
      to: p.to.toISOString(),
      campaign_id: p.campaignId ?? null,
      // Echoed in CANONICAL order, which is the order the request was
      // canonicalised into rather than the order it was spelled in.
      group_by: [...p.groupBy],
      resolved_timezone: resolvedTimezone,
      sort: p.sort,
      order: p.order,
      limit: p.limit,
      // 0 on an empty result rather than from a nullish read: with no rows there is
      // no window-function value to carry the count, and "no groups" is exactly 0.
      total_groups: rows.length === 0 ? 0 : Number(rows[0]?.total_groups ?? 0),
      rows: rows.map((row) => groupRowFromSql(row, p.groupBy)),
    };
  }

  /**
   * ONE campaign's RESOLVED zone — the value `COALESCE(z.name, 'UTC')` produces,
   * not the value stored in the column.
   *
   * ── Reading the column back would BE the bug ────────────────────────────────
   *
   * `agency_campaigns.default_timezone` is `VARCHAR(64)` with no constraint,
   * populated from customer-facing config, and the join that resolves it is LEFT
   * (and LATERAL, and `LIMIT 1`) precisely so an unresolvable value cannot raise
   * `22023 invalid_parameter_value` and take out every other campaign's numbers in
   * the same statement. The consequence is that the stored value and the zone the
   * buckets were actually cut in differ **exactly when the stored value is
   * garbage** — so `SELECT c.default_timezone` here would hand a console
   * `Asia/Calcutta_typo` to print over columns that are in fact UTC, on precisely
   * the campaign whose zone is broken. This selects
   * {@link AGENCY_RESOLVED_ZONE_SQL} through {@link AGENCY_RESOLVED_ZONE_JOIN_SQL}
   * — the same two constants `groupedStats` cuts its buckets with, so the reported
   * zone and the zone used cannot drift.
   *
   * ── It takes the CLIENT, and the parameter is required for a reason ────────
   *
   * `client`, not `getPool()`. This statement and the grouped statement have to see
   * the SAME `agency_campaigns` row, and on the pool they would not: two
   * connections are two READ COMMITTED snapshots, so a `default_timezone` UPDATE
   * committing between them makes this method report a zone the buckets were never
   * cut in — the exact confusion the field exists to remove. The caller holds both
   * on one client in one `REPEATABLE READ` transaction; see `groupedStats`.
   *
   * Required rather than defaulted to the pool, and it is the only reason this
   * parameter is not optional: a default would let a future caller — or a
   * refactor of this one — reintroduce the two-snapshot read by omission, in
   * silence, on a method whose whole contract is that it agrees with a statement
   * somewhere else. A missing argument is a build error that names the call site.
   *
   * ── The scope is a predicate here too ──────────────────────────────────────
   *
   * `tenant_id` and `account_id`, not a bare primary-key lookup: `campaign_id`
   * arrives from the caller and a UUID from another account must not resolve to
   * that account's configuration, however small the leak. It also settles the
   * degenerate case honestly — a `campaign_id` naming no campaign IN SCOPE matches
   * no row, and `null` is then the right answer, because a filter that selected no
   * campaign did not select "exactly one" and the page it produced (necessarily
   * empty) was cut in no zone at all.
   *
   * A matched row can never yield SQL NULL: the COALESCE guarantees a value. So the
   * `?? null` maps ONLY "no such campaign in this account", and never a row whose
   * zone failed to resolve — that row returns `'UTC'`, which is what the buckets
   * actually used.
   */
  private async resolvedCampaignZone(
    scope: { tenantId: string; accountId: string },
    campaignId: string,
    client: PoolClient,
  ): Promise<string | null> {
    const { rows } = await client.query<{ resolved_timezone: string }>(
      `SELECT ${AGENCY_RESOLVED_ZONE_SQL} AS resolved_timezone
         FROM agency_campaigns c
         ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
        WHERE c.id = $1::uuid
          AND c.tenant_id = $2
          AND c.account_id = $3`,
      [campaignId, scope.tenantId, scope.accountId],
    );
    return rows[0]?.resolved_timezone ?? null;
  }

  /**
   * Seconds per (agent, state) over the window, for a KNOWN set of agents.
   *
   * `stats()`'s `occupancyBuckets` with the bucket machinery removed and the
   * single agent id widened to an array. The interval clips it documents at length
   * are all still here and still load-bearing — the open final interval running to
   * `LEAST(now(), to, left_at)`, the event that CARRIES IN from before `from`, and
   * the `sess` CTE bounded to sessions overlapping the window (which is what keeps
   * `carried` from handing every closed session in an agent's tenure a full-window
   * interval). Read that method's header for why each exists; nothing about them
   * changes when the read covers a floor instead of a person, and the two
   * statements are kept BYTE-COMPARABLE on all of it — same clips, same tiebreaks,
   * same parameter positions — because they must agree and a divergence between
   * them is worse than either bug alone.
   *
   * What DOES go away is bucket splitting. With no buckets there is no
   * `generate_series`, no `CROSS JOIN LATERAL`, and no campaign timezone —
   * `bucketTruncSql` is the only thing that ever needed the zone, and the
   * `pg_timezone_names` LEFT JOIN existed only to stop an unresolvable one raising
   * `22023` inside it. A duration is zone-independent, so the whole apparatus
   * drops out rather than being carried along unused.
   *
   * ── `agent_user_id = ANY($1)` is not a filter, it is the driving predicate ──
   *
   * It appears on BOTH event reads, exactly as `stats()` carries `= $1` on both,
   * and for the identical reason spelled out above:
   * `idx_agency_session_events_agent` is `(agent_user_id, at)` and `session_id` is
   * deliberately not indexed, so without a predicate on the leading column the
   * planner has nothing to drive the range on `at` from. The ids come from the
   * attempts aggregate, which is why the two reads are sequential here where the
   * per-agent record runs them in parallel.
   *
   * It also carries the scope a second time over: the ids are already the output
   * of a tenant-and-account-scoped statement, and `sess` re-applies both
   * predicates anyway. That is deliberate belt-and-braces on a surface where the
   * WHERE clause is the only thing separating two accounts' floors — an
   * `agent_user_id` is opaque to the dialer tables and could legitimately collide across
   * tenants.
   */
  private async rosterOccupancyTotals(
    scope: { tenantId: string; accountId: string },
    p: AgentRosterParams,
    agentUserIds: readonly string[],
  ): Promise<{ agent_user_id: string; state: string; seconds: number }[]> {
    // Bound in the SAME ORDER as `occupancyBuckets`: the agent selector first,
    // then from, to, tenant, account. The two statements are ~90% identical text
    // and a future editor will diff or copy between them, so binding the same five
    // values at different positions is a trap -- a swapped from/to survives review
    // because `WHERE i.ended > i.started` absorbs an inverted window as an empty
    // result rather than as an error. One convention across both: the selector, if
    // the statement has one, is $1.
    const bind = params();
    for (const value of [[...agentUserIds], p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
    const campaignFilter = p.campaignId
      ? `\n            AND s.campaign_id = ${bind.add(p.campaignId)}::uuid`
      : '';

    const { rows } = await getPool().query<{
      agent_user_id: string; state: string; seconds: string;
    }>(
      `${occupancyIntervalsCtes('roster', campaignFilter)}       SELECT i.agent_user_id,
              i.state,
              SUM(EXTRACT(EPOCH FROM (i.ended - i.started)))::text AS seconds
         FROM intervals i
        WHERE i.ended > i.started
        GROUP BY i.agent_user_id, i.state
        ORDER BY i.agent_user_id, i.state`,
      bind.values,
    );

    return rows.map((r) => ({
      agent_user_id: r.agent_user_id,
      state: r.state,
      seconds: Number(r.seconds),
    }));
  }
}

/**
 * The cohort the roster's rows are read against.
 *
 * A free function rather than a method because it is a pure fold over rows the
 * repository has already produced — it issues no statement, and computing it from
 * the rows rather than from a third aggregate is what makes `benchmark.agents` and
 * `AgencyRosterPage.total_agents` the same number by construction instead of two
 * counts that have to keep agreeing.
 *
 * ── Pooled rates and percentiles are DIFFERENT numbers, both on the payload ──
 *
 * `connect_rate_pct` here is the floor's actual rate: total connected over total
 * attempts. `connect_rate.median` is the middle AGENT's rate. They diverge exactly
 * when agents differ in volume, which is always, and a consumer handed one cannot
 * derive the other — so both are served.
 *
 * The pooled rates are computed over EVERY row, thin ones included; the
 * percentiles are not. That is not an inconsistency. A pooled rate is a ratio of
 * two sums, so a row contributes in proportion to its own size — eleven calls move
 * it by eleven calls' worth. A median is a ratio of ratios, where those same
 * eleven calls cast one full vote alongside an agent's four hundred. The asymmetry
 * is the whole reason `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` gates one and not the
 * other.
 *
 * ── Which rows enter each percentile pool ─────────────────────────────────────
 *
 * `rates_reportable` is the row-level gate and a row that fails it enters NONE of
 * the three pools — that is what makes the flag mean what its contract comment
 * promises. On top of it:
 *
 *   * `success_rate` additionally requires `connected >=` the threshold, because
 *     that rate's own denominator is `connected`. 400 dials with three connects is
 *     a reportable row whose 33% conversion is three calls of evidence. That extra
 *     floor is `hasRateDenominator`, the same predicate the row's own
 *     `success_rate_reportable` is set from, so the flag on the wire and the pool
 *     admission cannot disagree. Note it makes the `rated` prefilter REDUNDANT for
 *     this pool and for `aht`: `connected <= attempts` always, so `connected >= 20`
 *     already implies `attempts >= 20`. The prefilter is kept anyway — it costs
 *     nothing and it states the rule that governs all three pools — but a reader
 *     hunting for the case where the two floors disagree will not find one.
 *   * `occupancy_pct` takes every reportable row with a non-null value. Its
 *     denominator is a DURATION and the threshold counts CALLS, so the same
 *     integer cannot gate it; the exclusion that matters there is the `null` a zero
 *     `shift_seconds` already produces — which is also what a degraded occupancy
 *     read produces, so a failed events-table read empties this pool rather than
 *     filling it with zeros.
 *
 * A `null` rate is never passed through in any pool. `rosterPercentiles` ranks
 * numbers, and JavaScript sorts `null` as 0 — one agent who connected nobody would
 * otherwise sit at the bottom of the distribution as a hard 0% and drag p25 down
 * with them, which is the exact false reading the null exists to prevent.
 */
function rosterBenchmark(rows: readonly AgencyRosterAgentRow[]): AgencyRosterBenchmark {
  const pooled = rows.reduce(
    (acc, row) => {
      acc.attempts += row.attempts;
      acc.connected += row.connected;
      acc.successes += row.successes;
      acc.talk += row.talk_seconds;
      acc.wrapup += row.wrapup_seconds;
      // Pooled in the SAME reduce as the counters, over the SAME rows, rather than
      // in a second pass — which is what makes it impossible for the cohort's
      // shift to describe a different agent set from the cohort's talk time. Both
      // are 0 when the occupancy read degraded, exactly as every row's is.
      acc.shift += row.shift_seconds;
      acc.break_ += row.break_seconds;
      return acc;
    },
    { attempts: 0, connected: 0, successes: 0, talk: 0, wrapup: 0, shift: 0, break_: 0 },
  );

  const rated = rows.filter((row) => row.rates_reportable);
  /** Non-null values of one metric, over the rows that qualified for its pool. */
  const pool = (
    qualifies: (row: AgencyRosterAgentRow) => boolean,
    read: (row: AgencyRosterAgentRow) => number | null,
  ): number[] => rated
    .filter(qualifies)
    .map(read)
    .filter((value): value is number => value !== null);

  return {
    agents: rows.length,
    agents_rated: rated.length,
    attempts: pooled.attempts,
    connected: pooled.connected,
    successes: pooled.successes,
    talk_seconds: pooled.talk,
    wrapup_seconds: pooled.wrapup,
    connect_rate_pct: ratePct(pooled.connected, pooled.attempts),
    success_rate_pct: ratePct(pooled.successes, pooled.connected),
    aht_seconds: ratio(pooled.talk + pooled.wrapup, pooled.connected),
    // `rates_reportable` IS `attempts >= threshold`, so the pool needs no further
    // predicate: connect_rate's denominator is exactly the one the flag gates.
    connect_rate: rosterPercentiles(pool(() => true, (row) => row.connect_rate_pct)),
    // `hasRateDenominator`, the SAME function object both of these are handed and
    // the same one that sets the row's `success_rate_reportable` — not two copies
    // of one comparison that happen to agree today. `aht_seconds` divides by
    // `connected` exactly as `success_rate_pct` does, so the two pools take the
    // same floor, and passing the predicate rather than restating it is what makes
    // them unable to drift when the threshold is next argued about.
    success_rate: rosterPercentiles(pool(hasRateDenominator, (row) => row.success_rate_pct)),
    occupancy_pct: rosterPercentiles(pool(() => true, (row) => row.occupancy_pct)),
    shift_seconds: pooled.shift,
    break_seconds: pooled.break_,
    aht: rosterPercentiles(pool(hasRateDenominator, (row) => row.aht_seconds)),
  };
}

export const agencyAbandonmentRepository = new AgencyAbandonmentRepository();
export const agencyLiveConcurrencyRepository = new AgencyLiveConcurrencyRepository();
export const agencyContactRepository = new AgencyContactRepository();
export const agencyAttemptRepository = new AgencyAttemptRepository();
export const agencyAgentSessionRepository = new AgencyAgentSessionRepository();
export const agencyAgentStatsRepository = new AgencyAgentStatsRepository();

