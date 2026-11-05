/** `AgencyContactRepository`: the roster — claims, settlement, DNC suppression, the contacts spine and ingest. */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
// BEGIN / COMMIT / ROLLBACK / release, and joining a caller's transaction (decision
// B8). A leaf too: the pool is passed in, so the `getPool` mock stays in charge.
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyContactInput, AgencyContactRecord } from '../../models/agency.model.js';
import type { AgencyContactState } from '@magick-agency/contracts/agency';
// The supervisor read surface's cursor. `KEYSET_AT_SQL` is projected
// alongside every paged row so the cursor carries `created_at` at its true
// MICROSECOND precision — see that module for why a millisecond round-trip
// silently drops rows.
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type { AgencyContactFilters } from '../../../agency/spine-filters.js';
import type {
  AgencyContactRow,
  AgencyContactDetail,
  AgencyKeysetPage,
} from '@magick-agency/contracts/agency';
// THE single definition of "the same number", imported rather than re-expressed.
// `DncRegistry.check` runs this on both sides of its comparison and
// `markDnc` runs it before storing; `suppressByPhone` below must agree
// with both to the byte or it suppresses a different set of rows than the mark
// claims to have suppressed. See its own header for why a second, SQL-shaped copy
// of this rule was deliberately not written.
import { normalizeE164 } from '../../../agency/dnc-registry.js';
import { CONTACT_PHONE_DIGITS_SQL, contactPhoneDigitsSql } from './sql-fragments.js';
import {
  contactListFilterConditions,
  keysetCondition,
  params,
  toKeysetPage,
} from './query-builders.js';
import { projectContactRow } from './projections.js';
import { contactBucketSql, numberLiveSql, openContactSql, presentSessionSql, returnToPoolSql } from './assignment-sql.js';
import {
  applyExtraAttemptOverride,
  type OverrideGrant,
  type SpendableDecision,
} from '../../../agency/contact-overrides.js';

const log = createChildLogger({ component: 'agency-repository' });

/** The assignment modes that pair a contact with its owner (`strict`, `preferred`); `pool` claims through `claimDialable`. */
export type AgencyOwnerClaimMode = 'strict' | 'preferred';

/** One contact {@link AgencyContactRepository.claimForAgents} claimed, and the agent (user id) it was claimed for. */
export interface AgencyAgentClaim {
  agentUserId: string;
  contact: AgencyContactRecord;
}

/**
 * Where one agent's own queue stands ({@link AgencyContactRepository.probeAgentQueues}). "Open"
 * is `pending` and not DNC, as the claim reads it.
 */
export interface AgencyAgentQueueProbeRow {
  agentUserId: string;
  /** An own open contact is due now (`next_attempt_at <= now()`). */
  ownDue: boolean;
  /** The earliest `next_attempt_at` among the agent's own open contacts; null when they have none. */
  ownNextAt: Date | null;
  /**
   * Whether any own open contact is NOT a callback (`contactBucketSql`). Read only when the agent
   * has open contacts and none is due (the one case the queue reason needs it); null otherwise.
   */
  ownHasNonCallback: boolean | null;
}

/** The unassigned pool, as a `preferred` agent sees it. */
export interface AgencyPoolQueueProbe {
  /** Due pool contacts, counted up to the probe's cap (never more). */
  dueCount: number;
  nextAt: Date | null;
  /** As {@link AgencyAgentQueueProbeRow.ownHasNonCallback}, for the pool. */
  hasNonCallback: boolean | null;
}

export interface AgencyAgentQueueProbe {
  agents: AgencyAgentQueueProbeRow[];
  /** Null unless the probe was asked for the pool (`preferred`). */
  pool: AgencyPoolQueueProbe | null;
}

/** A due callback the grace/fallback sweep handed back to the pool. */
export interface AgencyCallbackFallbackMove {
  contactId: string;
  fromUserId: string;
}

/** What {@link AgencyContactRepository.releaseFromDisposition} wrote. */
export interface DispositionRelease {
  state: AgencyContactState;
  suppressed_reason: string | null;
  next_attempt_at: Date;
  /** An `extra_attempts` override kept the contact `pending` (CA8 spend). */
  extraAttemptSpent: boolean;
  /** The entry's override replaced the contact's (CA8 grant). */
  overrideGranted: boolean;
  /** The callback's new owner (CA4), or null when the owner did not change. */
  assignedTo: string | null;
}

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
 * How many due rows {@link AgencyContactRepository.claimDialable} reads per
 * claimed slot before keeping one contact per number. Bounds the read; a tick
 * that meets a longer run of one number claims fewer and the next tick moves on.
 */
const CLAIM_CANDIDATE_FACTOR = 4;

/**
 * The terms every claim ({@link AgencyContactRepository.claimDialable} and the owner claim) puts
 * on a candidate row `alias`: open (`pending`), due, not DNC, and its number not live on the
 * ACCOUNT, on any of its campaigns (`numberLiveSql`, decisions MC4). The caller scopes `alias` to
 * its campaign itself. {@link AgencyContactRepository.countDialable} reads the same terms, so
 * the pacing round's demand counts what a claim could take. See `claimDialable`'s header for
 * why each term is there and why DNC is `IS DISTINCT FROM`. Spelled in the order the index
 * serves them (`state`, `next_attempt_at`), not through `openContactSql`.
 */
function dueAndNotBusySql(alias: string): string {
  const c = alias;
  return `${c}.state = 'pending' AND ${c}.next_attempt_at <= now()
            AND ${c}.suppressed_reason IS DISTINCT FROM 'dnc'
            AND NOT ${numberLiveSql(c)}`;
}

/**
 * {@link AgencyContactRepository.claimForAgents}' statement. `$1` campaign, `$2` the agents' user
 * ids in reservation order, `$3` (preferred only) the pool candidate factor.
 */
function ownerClaimSql(mode: AgencyOwnerClaimMode): string {
  const pool = mode === 'preferred'
    ? `,
       pool_locked AS MATERIALIZED (
         SELECT c.id, c.next_attempt_at, ${contactPhoneDigitsSql('c')} AS digits
           FROM agency_contacts c
          WHERE c.campaign_id = $1::uuid AND c.assigned_user_id IS NULL
            AND ${dueAndNotBusySql('c')}
          ORDER BY c.next_attempt_at
          LIMIT ((SELECT count(*) FROM agents) - (SELECT count(*) FROM own)) * $3::int
            FOR UPDATE OF c SKIP LOCKED
       ),
       needy AS MATERIALIZED (
         SELECT a.agent_user_id, row_number() OVER (ORDER BY a.ord) AS rn
           FROM agents a
          WHERE NOT EXISTS (SELECT 1 FROM own o WHERE o.agent_user_id = a.agent_user_id)
       ),
       pool_one AS MATERIALIZED (
         SELECT p.id, row_number() OVER (ORDER BY p.next_attempt_at, p.id) AS rn
           FROM (
             SELECT DISTINCT ON (l.digits) l.id, l.next_attempt_at
               FROM pool_locked l
              WHERE NOT EXISTS (SELECT 1 FROM own_one o WHERE o.digits = l.digits)
              ORDER BY l.digits, l.next_attempt_at, l.id
           ) p
       )`
    : '';
  const pickedFromPool = mode === 'preferred'
    ? `
         UNION ALL
         SELECT n.agent_user_id, p.id FROM needy n JOIN pool_one p ON p.rn = n.rn`
    : '';
  return `WITH agents AS MATERIALIZED (
         SELECT DISTINCT ON (a.agent_user_id) a.agent_user_id, a.ord
           FROM unnest($2::uuid[]) WITH ORDINALITY AS a(agent_user_id, ord)
          ORDER BY a.agent_user_id, a.ord
       ),
       own AS MATERIALIZED (
         SELECT a.agent_user_id, a.ord, x.id, x.digits
           FROM agents a
          CROSS JOIN LATERAL (
            SELECT c.id, ${contactPhoneDigitsSql('c')} AS digits
              FROM agency_contacts c
             WHERE c.campaign_id = $1::uuid AND c.assigned_user_id = a.agent_user_id
               AND ${dueAndNotBusySql('c')}
             ORDER BY c.next_attempt_at
             LIMIT 1
               FOR UPDATE OF c SKIP LOCKED
          ) x
       ),
       own_one AS MATERIALIZED (
         SELECT DISTINCT ON (digits) agent_user_id, id, digits
           FROM own
          ORDER BY digits, ord
       )${pool},
       picked AS MATERIALIZED (
         SELECT agent_user_id, id FROM own_one${pickedFromPool}
       )
       UPDATE agency_contacts c SET state = 'in_flight', updated_at = now()
         FROM picked
        WHERE c.id = picked.id
       RETURNING picked.agent_user_id AS claimed_for_user_id, c.*`;
}

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
   *
   * ── At most `limit` rows, and why the pick is a MATERIALIZED CTE ─────────
   *
   * The pacing tick pairs these rows with the agents it reserved by index, so a
   * claim longer than `limit` hands its tail an `undefined` session (an
   * `agency:agent:undefined:state` lease, a dial with no agent). Written as
   * `WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT $2)`, the claim could be
   * planned as a nested-loop semi join with the locking subquery as its inner
   * side, re-run for every outer row; each re-run skips the rows this statement
   * has already updated, so LIMIT 1 claimed the whole roster. Postgres picks that
   * plan from table statistics (rows deleted, then analysed), so it came and went.
   * A MATERIALIZED CTE runs the pick exactly once. Pinned on a real database by
   * `agency-contact-claim-limit.test.ts`.
   *
   * ── One live call per number ─────────────────────────────────────────────
   *
   * A campaign can hold the same number on several contacts: the schema refuses
   * `UNIQUE (campaign_id, phone_e164)` on purpose, an append upload can repeat a
   * number, and an upload deduped on another column (one borrower, two loan
   * numbers) keeps both rows. And an account can run several campaigns at once
   * (decisions MC6), whose rosters can share a number: a retry child and its parent
   * always do. The claim must never put two calls on one number at once, so it:
   *
   *  - skips a contact whose number is already live on its ACCOUNT, on this campaign
   *    or any other of the account's (decisions MC4): a contact on it is `in_flight`
   *    (claimed, dialing, or a soft-phone claim) or `connected` (bridged, or parked
   *    for the agent's write-up; a bridged call writes `connected` while the call is
   *    still up). Another account's call on the same number does not count;
   *  - takes at most one contact per number in one claim (the earliest due).
   *
   * "The same number" is the digits projection the soft phone's match and
   * `suppressByPhone` prefilter on (`CONTACT_PHONE_DIGITS_SQL`), so the busy
   * probe is one `idx_agency_contacts_account_live_digits` lookup per candidate
   * (0015: the account's live contacts by digits, partial on the live states, so it
   * stays as small as the account's live calls however many rosters it holds).
   * Ingest stores E.164, so digits and number agree for every roster row.
   *
   * The one-per-number pass needs `DISTINCT ON`, which cannot take `FOR UPDATE`, so
   * the locking pick (`SKIP LOCKED`, past rows other transactions hold, as before)
   * takes up to `limit * CLAIM_CANDIDATE_FACTOR` due rows, and one contact per
   * number, at most `limit`, is claimed from those. The extra rows are locked only
   * until the statement ends (a few ms); a soft-phone {@link claimForManual} that
   * meets one of them in that window answers `busy`, as it does for a row a tick is
   * claiming. Locking in the FIRST scan matters: a pick over an unlocked candidate
   * list could find its whole window held by another transaction and claim nothing
   * while dialable rows sat further down (`contact-claim-contention.test.ts`). When
   * the head of the queue is a run of rows on one number, a tick can claim fewer
   * than `limit`; the next tick sees that number busy and moves past it.
   *
   * **What the guard does not cover.** The busy probe is a read, not a lock.
   * Against other pacing ticks that is enough: ticks for one campaign never overlap
   * (`PacingEngine.ticking`) on this single-replica deployment, and the engine runs
   * the claims of one ACCOUNT's campaigns one at a time (decisions MC4), so the ticks
   * of two campaigns of one account no longer overlap at the claim either: each
   * claim's probe sees the other's committed `in_flight` rows. Two different
   * accounts' claims may overlap, and need not see each other. It is not enough
   * against the soft phone, which claims contacts in its own transaction: a manual
   * claim of one row and a tick's claim of another row on the same number, in the
   * same few milliseconds, can each miss the other's uncommitted write. And the
   * soft phone's own pre-dial rule (`pickRosterContact`, docs/softphone.md §5)
   * refuses only an `in_flight` match, so a tagged manual call to a number whose
   * contact is `connected` goes ahead. Closing either needs a per-number lock or a
   * soft-phone ruling, not this statement. Pinned on a real database by
   * `agency-contact-claim-one-per-number.test.ts`.
   */
  async claimDialable(campaignId: string, limit: number): Promise<AgencyContactRecord[]> {
    if (limit <= 0) return [];
    const { rows } = await getPool().query<AgencyContactRecord>(
      `WITH locked AS MATERIALIZED (
         SELECT c.id, c.next_attempt_at, ${contactPhoneDigitsSql('c')} AS digits
           FROM agency_contacts c
          WHERE c.campaign_id = $1 AND ${dueAndNotBusySql('c')}
          ORDER BY c.next_attempt_at
            FOR UPDATE OF c SKIP LOCKED
          LIMIT $3
       ),
       picked AS MATERIALIZED (
         SELECT id FROM (
           SELECT DISTINCT ON (digits) id, next_attempt_at
             FROM locked
            ORDER BY digits, next_attempt_at, id
         ) one_per_number
          ORDER BY next_attempt_at, id
          LIMIT $2
       )
       UPDATE agency_contacts c SET state = 'in_flight', updated_at = now()
         FROM picked
        WHERE c.id = picked.id
       RETURNING c.*`,
      [campaignId, limit, limit * CLAIM_CANDIDATE_FACTOR],
    );
    return rows;
  }

  /**
   * How many contacts {@link claimDialable}`(campaignId, limit)` could claim right now: a read,
   * no lock, no write. The pacing round asks each running campaign of an account for its demand
   * before it splits the account's headroom between them (decisions MC1, MC2), so a campaign
   * with agents ready but nothing to dial does not hold slots another campaign could use.
   *
   * It reads exactly the claim's window, so it never promises more than one claim takes:
   * the same terms (`dueAndNotBusySql`: open, due, not DNC, the number not live on the
   * account), the same first `limit * CLAIM_CANDIDATE_FACTOR` due rows in `next_attempt_at`
   * order (one `idx_agency_contacts_dialable` range scan, bounded whatever the roster's size),
   * one per number (distinct digits, as the claim's `DISTINCT ON`), at most `limit`. A run of
   * one number at the head of the queue counts once, as the claim would take it once.
   *
   * What it cannot see: rows another transaction holds locked, which the claim skips (a
   * soft-phone claim in its few milliseconds), so it can count one the claim then misses; and
   * a number that goes live between this read and the claim. Both make the claim take fewer,
   * never more: the count is an upper bound for the tick that follows, not a reservation.
   * Pool claims only: an owner claim ({@link claimForAgents}) has its own per-agent terms.
   */
  async countDialable(campaignId: string, limit: number): Promise<number> {
    if (limit <= 0) return 0;
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT LEAST(count(DISTINCT w.digits), $2::int)::int AS n
         FROM (
           SELECT ${contactPhoneDigitsSql('c')} AS digits
             FROM agency_contacts c
            WHERE c.campaign_id = $1::uuid AND ${dueAndNotBusySql('c')}
            ORDER BY c.next_attempt_at
            LIMIT $3::int
         ) w`,
      [campaignId, limit, limit * CLAIM_CANDIDATE_FACTOR],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * The contact-assignment claim (`strict` and `preferred` campaigns; `pool` keeps
   * {@link claimDialable}): at most ONE due contact for each of `agentUserIds`, and for each
   * row returned, the agent it was claimed for.
   *
   *  - `strict`: an agent's own contacts only (`assigned_user_id` = them). Nothing unassigned,
   *    nothing of another agent's, ever.
   *  - `preferred`: the agent's own earliest due contact; an agent with NO own contact
   *    claimable now takes one from the pool (`assigned_user_id IS NULL`). Never another
   *    agent's. An agent whose own pick lost the same-number tie below gets nothing this tick
   *    rather than a pool contact: they have own work due, and the next tick takes it.
   *
   * `agentUserIds` is the reservation order (the tick's longest-idle fairness order): it
   * decides ties, so the pairing is deterministic. A repeated id counts once.
   *
   * ── Every property of {@link claimDialable}, kept ─────────────────────────
   *
   * Same terms (`pending`, `next_attempt_at <= now()`, DNC `IS DISTINCT FROM`, the busy probe:
   * `dueAndNotBusySql`), the same `FOR UPDATE … SKIP LOCKED` as the correctness mechanism
   * against a second leader, and every pick in a MATERIALIZED CTE so it runs exactly once (no
   * `IN (SELECT … LIMIT n FOR UPDATE)` the planner can re-run, `packages/db/CLAUDE.md`). One
   * live call per number holds ACROSS agents: two agents' own picks on one number keep the
   * first agent's (`own_one`), and a pool pick on a number an own pick took is dropped, so
   * one claim never puts two calls on a number; the next tick sees it busy and moves on.
   *
   * ── Never more rows than agents ───────────────────────────────────────────
   *
   * `own` is one LATERAL pick per agent with `LIMIT 1`; `own_one` only removes rows; the pool
   * rows are joined 1:1 by rank to the agents with no own pick (`needy`), which are disjoint
   * from the agents in `own`. So each agent appears at most once and the final UPDATE joins a
   * materialised list of distinct ids. Pinned under the forced re-run plan by
   * `agency-contact-claim-owner.test.ts`.
   *
   * ── One statement, and the plan ───────────────────────────────────────────
   *
   * One round trip per tick, like {@link claimDialable}: the per-agent picks run inside the
   * statement (a LATERAL index probe per agent) instead of one claim per agent from the
   * engine. Each own pick is a range scan of `idx_agency_contacts_assignee` (`campaign_id`,
   * `assigned_user_id`, `state`, `next_attempt_at <= now()` as the index condition, DNC as a
   * filter), read in `next_attempt_at` order and stopped at the first row it can lock, so its
   * cost does not grow with the agent's queue. The pool pick (preferred only) reads the due
   * head of the campaign (`idx_agency_contacts_dialable`, or the assignee index's NULL range)
   * for `needy × CLAIM_CANDIDATE_FACTOR` rows, and `LIMIT 0` — no rows read, none locked — when
   * every agent had their own pick. EXPLAIN ANALYZE on a 200k-row seeded campaign (50 agents
   * × 2k own, 100k pool), 3 agents: ~15 ms, `Index Scan using idx_agency_contacts_assignee`
   * with `Limit → LockRows` per agent (loops=3).
   *
   * A bounded loop of per-agent claims was the alternative: N round trips per tick with the
   * one-per-number rule re-checked between them by a read the next claim could race. Nothing
   * the single statement gives up made that worth it.
   *
   * The busy probe is a read, not a lock, exactly as in {@link claimDialable} (see its "What
   * the guard does not cover"): enough against other ticks, which never overlap per campaign,
   * and whose claims the engine runs one at a time per account (decisions MC4). Like
   * {@link claimDialable}'s, the probe is account-wide: a number live on another campaign of
   * the account is not claimed for an agent here.
   */
  async claimForAgents(
    campaignId: string,
    agentUserIds: readonly string[],
    mode: AgencyOwnerClaimMode,
  ): Promise<AgencyAgentClaim[]> {
    if (agentUserIds.length === 0) return [];
    const values: unknown[] = [campaignId, [...agentUserIds]];
    if (mode === 'preferred') values.push(CLAIM_CANDIDATE_FACTOR);
    const { rows } = await getPool().query<AgencyContactRecord & { claimed_for_user_id: string }>(
      ownerClaimSql(mode),
      values,
    );
    return rows.map(({ claimed_for_user_id, ...contact }) => ({
      agentUserId: claimed_for_user_id,
      contact: contact as AgencyContactRecord,
    }));
  }

  /**
   * Where each agent's own queue stands, for pacing (who has something due, so who is worth
   * reserving) and for the agent's `queue` frame (why nothing is due). One statement for every
   * agent; with `pool`, one row more for the unassigned pool (`preferred`).
   *
   * Every read is an index probe that stops early, never a count of a queue: the earliest own
   * open contact per agent (`idx_agency_contacts_assignee`, `next_attempt_at` order, LIMIT 1;
   * due iff it is due now), and only for an agent with nothing due, whether ANY open contact is
   * not a callback (`contactBucketSql`, the one definition of a callback), which stops at the
   * first one. The pool's due count stops at `pool.dueCap`.
   *
   * "Due" here is the claim's open-and-due terms without the busy probe: an agent whose only
   * due contact shares a number with a live call reads as due and is reserved, and the claim
   * then gives them nothing that tick, as a short claim does in pool mode.
   *
   * @param callbackCodes the campaign's `callbackCodes(catalog)`.
   */
  async probeAgentQueues(
    campaignId: string,
    agentUserIds: readonly string[],
    opts: { callbackCodes: readonly string[]; pool?: { dueCap: number } },
  ): Promise<AgencyAgentQueueProbe> {
    const pool = opts.pool ?? null;
    if (agentUserIds.length === 0 && !pool) return { agents: [], pool: null };
    const p = params();
    const campaign = p.add(campaignId);
    const ids = p.add([...agentUserIds]);
    const codes = p.add([...opts.callbackCodes]);
    const open = (alias: string) => `${alias}.campaign_id = ${campaign} AND ${openContactSql(alias)}`;
    const poolSql = pool
      ? `
       UNION ALL
       SELECT NULL::uuid, head.next_at, head.next_at <= now(),
              CASE WHEN head.next_at > now() THEN EXISTS (
                SELECT 1 FROM agency_contacts n
                 WHERE ${open('n')} AND n.assigned_user_id IS NULL
                   AND ${contactBucketSql('n', codes)} <> 'callback') END,
              (SELECT count(*)::int FROM (
                 SELECT 1 FROM agency_contacts d
                  WHERE ${open('d')} AND d.assigned_user_id IS NULL AND d.next_attempt_at <= now()
                  LIMIT ${p.add(Math.max(0, Math.floor(pool.dueCap)))}::int) due)
         FROM (SELECT (SELECT h.next_attempt_at FROM agency_contacts h
                        WHERE ${open('h')} AND h.assigned_user_id IS NULL
                        ORDER BY h.next_attempt_at LIMIT 1) AS next_at) head`
      : '';
    const { rows } = await getPool().query<{
      agent_user_id: string | null;
      next_at: Date | null;
      due: boolean | null;
      has_non_callback: boolean | null;
      due_count: number | null;
    }>(
      `SELECT a.agent_user_id, own.next_at, own.next_at <= now() AS due,
              CASE WHEN own.next_at > now() THEN EXISTS (
                SELECT 1 FROM agency_contacts n
                 WHERE ${open('n')} AND n.assigned_user_id = a.agent_user_id
                   AND ${contactBucketSql('n', codes)} <> 'callback') END AS has_non_callback,
              NULL::int AS due_count
         FROM (SELECT DISTINCT unnest(${ids}::uuid[]) AS agent_user_id) a
         LEFT JOIN LATERAL (
           SELECT c.next_attempt_at AS next_at FROM agency_contacts c
            WHERE ${open('c')} AND c.assigned_user_id = a.agent_user_id
            ORDER BY c.next_attempt_at LIMIT 1
         ) own ON true${poolSql}`,
      p.values,
    );
    const agents: AgencyAgentQueueProbeRow[] = [];
    let poolRow: AgencyPoolQueueProbe | null = null;
    for (const r of rows) {
      if (r.agent_user_id === null) {
        poolRow = { dueCount: r.due_count ?? 0, nextAt: r.next_at, hasNonCallback: r.has_non_callback };
      } else {
        agents.push({
          agentUserId: r.agent_user_id,
          ownDue: r.due === true,
          ownNextAt: r.next_at,
          ownHasNonCallback: r.has_non_callback,
        });
      }
    }
    return { agents, pool: pool ? poolRow ?? { dueCount: 0, nextAt: null, hasNonCallback: null } : null };
  }

  /**
   * The callback grace/fallback (CA5), one campaign, one statement: every DUE callback (bucket
   * `callback` by `contactBucketSql`, `next_attempt_at <= now() - grace`) whose owner has no
   * live session on the campaign loses its owner, and each move writes its
   * `agency_contact_assignment_events` row (`callback_fallback`, actor NULL: the system) under
   * `batchId`. Both in one statement, so a move without its history row cannot exist.
   *
   * "Live session" is `presentSessionSql`: joined (`left_at IS NULL`) and not `offline` (a
   * station that closed, or a reaped one), the rule the supervisor's progress reads too.
   *
   * Never a live contact: only `pending` rows are picked, under `FOR UPDATE SKIP LOCKED` in a
   * MATERIALIZED pick (a row a tick is claiming is skipped, not waited on), and the UPDATE
   * re-checks `pending` on the locked row. Returns the moves (at most `limit`).
   */
  async fallBackOverdueCallbacks(input: {
    campaignId: string;
    graceMinutes: number;
    callbackCodes: readonly string[];
    batchId: string;
    limit: number;
  }): Promise<AgencyCallbackFallbackMove[]> {
    if (input.callbackCodes.length === 0 || input.limit <= 0) return [];
    const { rows } = await getPool().query<{ contact_id: string; from_user_id: string }>(
      `WITH due AS MATERIALIZED (
         SELECT c.id, c.assigned_user_id
           FROM agency_contacts c
          WHERE c.campaign_id = $1::uuid
            AND c.state = 'pending'
            AND c.assigned_user_id IS NOT NULL
            AND c.next_attempt_at <= now() - make_interval(mins => $2::int)
            AND ${contactBucketSql('c', '$3')} = 'callback'
            AND NOT EXISTS (
              SELECT 1 FROM agency_agent_sessions s
               WHERE s.campaign_id = $1::uuid AND s.agent_user_id = c.assigned_user_id
                 AND ${presentSessionSql('s')})
          ORDER BY c.next_attempt_at
          LIMIT $5
            FOR UPDATE OF c SKIP LOCKED
       ),
       ${returnToPoolSql('callback_fallback', '$4')}`,
      [input.campaignId, input.graceMinutes, [...input.callbackCodes], input.batchId, input.limit],
    );
    return rows.map((r) => ({ contactId: r.contact_id, fromUserId: r.from_user_id }));
  }

  /**
   * Return a claimed contact to the pool.
   *
   * `nextAttemptAt` must move the clock forward for any condition that has NOT
   * cleared. A contact returned with `now()` because it was outside its
   * calling window is re-claimed on the very next tick, and a campaign whose
   * contacts are all out of hours spins at 4 claims/second all night burning agent
   * reservations on calls it will never place.
   *
   * `restoreAgentReopen`: the contact's paced attempt consumed a reopen marker
   * (`agent_reopened`) and was abandoned before its dial (the dispatcher refused it, or the
   * tick lost its lease after the insert): the marker goes back, so the dial that does happen
   * carries the flag.
   */
  async unclaim(contactId: string, nextAttemptAt: Date, opts: { restoreAgentReopen?: boolean } = {}): Promise<void> {
    await getPool().query(
      `UPDATE agency_contacts
          SET state = 'pending', next_attempt_at = $2,
              agent_reopen_pending = agent_reopen_pending OR $3::boolean,
              updated_at = now()
        WHERE id = $1 AND state = 'in_flight'`,
      [contactId, nextAttemptAt, opts.restoreAgentReopen === true],
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

  // ─── The soft phone's roster match and claim (docs/softphone.md §4.1, §5) ────

  /**
   * The contacts of `campaignId` whose number is `phoneE164` — the soft phone's
   * pre-dial roster match on the tagged campaign (§4.1 step 2).
   *
   * Matched exactly as {@link suppressByPhone} matches: the SQL is the LOOSER
   * digits prefilter, byte-identical to `idx_agency_contacts_campaign_phone_digits`
   * (`CONTACT_PHONE_DIGITS_SQL`, so the read is one index probe), and the decision
   * is {@link normalizeE164} on both sides in TypeScript. Re-expressing the
   * normaliser in SQL is the fail-open that header describes.
   *
   * A LIST, oldest first, because one campaign may hold the same number twice (a
   * household landline: the schema refuses `UNIQUE (campaign_id, phone_e164)` on
   * purpose). The caller picks; the rule §5 implies: any match `in_flight` refuses
   * `contact_in_flight`, else the oldest `pending` match is the one to claim, else the
   * oldest match is linked. An unusable `phoneE164` matches nothing.
   */
  async findForManualMatch(campaignId: string, phoneE164: string): Promise<AgencyContactRecord[]> {
    const target = normalizeE164(phoneE164);
    if (!target) return [];
    const { rows } = await getPool().query<AgencyContactRecord>(
      // No ORDER BY: sorting here would let the planner prefer the
      // `(campaign_id, created_at, id)` reporting index (sort-free) over the digits
      // probe on a small table. The matches are a handful of rows; sorted below.
      `SELECT * FROM agency_contacts
        WHERE campaign_id = $1 AND ${CONTACT_PHONE_DIGITS_SQL} = $2`,
      [campaignId, target.slice(1)],
    );
    return rows
      .filter((row) => normalizeE164(row.phone_e164) === target)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * The oldest contact `in_flight` on ANY campaign of the account whose number is
   * `phoneE164`, or null: the soft phone's account-wide roster guard (§4.1 step 2). An
   * untagged dial is refused `contact_in_flight` on any match; a tagged dial is refused
   * on a match on another campaign of the account (decisions MC4: several campaigns may
   * run per account, so a sibling's call is live on that customer too). Read only: the
   * guard never claims or settles a contact (SP6).
   *
   * Served by the partial `idx_agency_contacts_in_flight` (only the in-flight rows),
   * then narrowed to the account and the digits prefilter; the decision is
   * {@link normalizeE164} on both sides, as in {@link findForManualMatch}.
   */
  async findInFlightForAccount(
    tenantId: string,
    accountId: string,
    phoneE164: string,
  ): Promise<AgencyContactRecord | null> {
    const target = normalizeE164(phoneE164);
    if (!target) return null;
    const { rows } = await getPool().query<AgencyContactRecord>(
      `SELECT * FROM agency_contacts
        WHERE state = 'in_flight' AND tenant_id = $1 AND account_id = $2
          AND ${CONTACT_PHONE_DIGITS_SQL} = $3`,
      [tenantId, accountId, target.slice(1)],
    );
    return rows
      .filter((row) => normalizeE164(row.phone_e164) === target)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
      ?? null;
  }

  /**
   * Claim a roster contact for a soft-phone call (§4.1 step 3, §5): `pending →
   * in_flight`, the same transition `claimDialable` makes for pacing, so pacing
   * cannot take the contact while the call is live or awaiting its outcome.
   *
   * **Run it on the caller's transaction client**, the one that then inserts the
   * manual call row (`AgencyManualCallRepository.create`) with the answer: the row
   * lock taken here is held until that transaction commits, and a refused insert
   * (`session_has_unsettled_call`) rolls the claim back with it.
   *
   * `FOR UPDATE SKIP LOCKED`, as `claimDialable`: a contact a pacing tick is
   * claiming right now is skipped rather than waited on, and answered `busy`, which
   * the caller treats as `contact_in_flight` (the tick is about to dial it).
   *
   * - `claimed` — it was `pending` and is now `in_flight`; `priorState` is what
   *   lapse and restart release it back to (`pending`). Store both on the call.
   * - `linked` — any other state: the call links it and does not claim it (§5). An
   *   `in_flight` contact (a live campaign attempt, or another manual call's claim)
   *   comes back as `linked` with `state: 'in_flight'`, which the caller REFUSES
   *   (`contact_in_flight`, no override); it is never claimed twice. A `pending`
   *   row carrying `suppressed_reason = 'dnc'` (a pre-fix leftover `claimDialable`
   *   also refuses) is linked, never claimed.
   * - `busy` — row-locked by a concurrent claim.
   * - `not_found` — no such contact on this campaign.
   */
  async claimForManual(
    campaignId: string,
    contactId: string,
    deps: { client?: Pick<PoolClient, 'query'> } = {},
  ): Promise<
    | { outcome: 'claimed'; priorState: AgencyContactState; contact: AgencyContactRecord }
    | { outcome: 'linked'; state: AgencyContactState; contact: AgencyContactRecord }
    | { outcome: 'busy' }
    | { outcome: 'not_found' }
  > {
    const db = deps.client ?? getPool();
    const { rows: locked } = await db.query<AgencyContactRecord>(
      `SELECT * FROM agency_contacts
        WHERE id = $1 AND campaign_id = $2
          FOR UPDATE SKIP LOCKED`,
      [contactId, campaignId],
    );
    const row = locked[0];
    if (!row) {
      const { rows } = await db.query<{ id: string }>(
        'SELECT id FROM agency_contacts WHERE id = $1 AND campaign_id = $2',
        [contactId, campaignId],
      );
      return rows[0] ? { outcome: 'busy' } : { outcome: 'not_found' };
    }
    if (row.state !== 'pending' || row.suppressed_reason === 'dnc') {
      return { outcome: 'linked', state: row.state, contact: row };
    }
    // Re-asserted in the WHERE although the row is locked: the claim is a guarded
    // write whether or not a future caller forgets the transaction.
    const { rows } = await db.query<AgencyContactRecord>(
      `UPDATE agency_contacts SET state = 'in_flight', updated_at = now()
        WHERE id = $1 AND state = 'pending'
      RETURNING *`,
      [contactId],
    );
    const claimed = rows[0];
    return claimed
      ? { outcome: 'claimed', priorState: row.state, contact: claimed }
      : { outcome: 'linked', state: row.state, contact: row };
  }

  /**
   * Give a manual call's claim back: the contact returns to the state recorded at
   * the claim (`contact_prior_state`), for lapse (§4.1 step 8), restart (step 10)
   * and a dial that failed before it was placed.
   *
   * Only if this call still holds it: the manual-call row says it claimed THIS
   * contact (`contact_claimed`), and the contact is still `in_flight`. A contact
   * something else moved since (a DNC mark suppressed it) is left alone. Nothing else
   * changes: `attempt_count`, `next_attempt_at` and `last_*` are exactly as the
   * claim found them, so a release is an undo, not a settlement — use
   * {@link settleFromManual} when the call's outcome should count.
   *
   * The DNC freeze {@link markState} applies holds here too: a row carrying
   * `suppressed_reason = 'dnc'` goes to `suppressed`, never back to `pending`.
   *
   * @returns the contact's state after the release, or null when nothing was
   *   released (no claim, already released, or moved by something else).
   */
  async releaseManualClaim(
    manualCallId: string,
    deps: { client?: Pick<PoolClient, 'query'> } = {},
  ): Promise<{ contactId: string; state: AgencyContactState } | null> {
    const { rows } = await (deps.client ?? getPool()).query<{ id: string; state: AgencyContactState }>(
      `UPDATE agency_contacts c
          SET state = CASE WHEN c.suppressed_reason = 'dnc' THEN 'suppressed' ELSE m.contact_prior_state END,
              updated_at = now()
         FROM agency_manual_calls m
        WHERE m.id = $1
          AND m.contact_claimed
          AND m.contact_prior_state IS NOT NULL
          AND c.id = m.contact_id
          AND c.campaign_id = m.campaign_id
          AND c.state = 'in_flight'
      RETURNING c.id, c.state`,
      [manualCallId],
    );
    const row = rows[0];
    return row ? { contactId: row.id, state: row.state } : null;
  }

  /**
   * Settle a roster contact from a soft-phone call's outcome — the §5 table, given
   * the disposition decision the caller resolved with the existing pure functions
   * (`resolveDispositionDecision`; a `RetryDecision` is the same shape), or `null`
   * when the call settles with no outcome (unanswered, step 6).
   *
   * **The call CLAIMED the contact, and still holds it** (`contact_claimed`, the
   * contact still `in_flight`): the decision applies as on the station — suppress →
   * `suppressed` (+ `suppressed_reason`), terminal / success → `completed`, callback
   * or retry → `pending` at `nextAttemptAt`, attempts spent → `exhausted` — through
   * the same DNC freeze {@link markState} has. `null` → back to `pending` unchanged
   * (`next_attempt_at` kept). Either way the call is charged to the ledger `charge`
   * names — `attempt` (`attempt_count + 1`, the customer's allowance: a placed call),
   * `our_fault` (`our_fault_attempts + 1`: a placed call OUR side ended before it
   * bridged, the campaign path's rule in `contact-settlement.ts`) or `none` — and
   * `last_outcome` / `last_disposition` land.
   *
   * ⚠️ `attemptsUsed` for `resolveDispositionDecision` / `resolveRetryDecision` (and
   * `ourFaultAttemptsUsed` for `resolveOurFaultRedial`) is therefore the contact's
   * stored count PLUS this call — this method does the bump, the decision is computed
   * before it (the claim keeps anything else off the row).
   *
   * **Linked only** (not claimed, or the claim is gone): only `suppressed` applies,
   * from any state but an already DNC-suppressed one, which keeps its reason; every
   * other decision writes nothing. A terminal contact (`completed`, `exhausted`,
   * `suppressed`) is never reopened, and a `connected` contact's own campaign
   * disposition is left to settle it.
   *
   * Forward-only by construction: the claimed arm requires `state = 'in_flight'`, so
   * it can never write over a contact that left `in_flight` some other way.
   *
   * Run it on the transaction that records the outcome (with the DNC write for a
   * suppress code, B8) so the three commit together.
   *
   * @returns where the contact landed and which arm ran, or null when the call has
   *   no contact (untagged, or no roster match) or the contact row is gone.
   */
  async settleFromManual(
    input: {
      manualCallId: string;
      decision: {
        contactState: AgencyContactState;
        nextAttemptAt: Date | null;
        suppressedReason: string | null;
      } | null;
      /**
       * Which ledger this call is charged to: `attempt` for a placed call (`dialed_at`
       * set), `our_fault` for a placed call our side ended before it bridged, `none`
       * for a dial the carrier never saw. Only the claimed arm charges.
       */
      charge: 'attempt' | 'our_fault' | 'none';
      lastOutcome: string | null;
      lastDisposition: string | null;
    },
    deps: { client?: Pick<PoolClient, 'query'> } = {},
  ): Promise<{
    contactId: string;
    state: AgencyContactState;
    nextAttemptAt: Date | null;
    /** `settled`: the claimed arm ran. `suppressed`: a linked contact was suppressed. `unchanged`: nothing applied. */
    applied: 'settled' | 'suppressed' | 'unchanged';
  } | null> {
    const db = deps.client ?? getPool();
    const d = input.decision;
    // One statement, three arms, decided in SQL off the locked row so the arm and
    // the write cannot disagree:
    //   claimed — the call claimed the contact and it is still in_flight;
    //   suppress — a linked contact and a suppress decision;
    //   otherwise the row is returned unchanged (the `cur` arm below).
    const { rows } = await db.query<{
      id: string; state: AgencyContactState; next_attempt_at: Date | null; applied: 'settled' | 'suppressed' | 'unchanged';
    }>(
      `WITH cur AS (
         SELECT c.id, c.state, c.next_attempt_at, c.suppressed_reason,
                (m.contact_claimed AND c.state = 'in_flight') AS held
           FROM agency_manual_calls m
           JOIN agency_contacts c ON c.id = m.contact_id AND c.campaign_id = m.campaign_id
          WHERE m.id = $1
            FOR UPDATE OF c
       ), upd AS (
         UPDATE agency_contacts c
            SET state = CASE
                          WHEN c.suppressed_reason = 'dnc' THEN 'suppressed'
                          WHEN cur.held THEN COALESCE($2::varchar, 'pending')
                          ELSE 'suppressed'
                        END,
                attempt_count = c.attempt_count + CASE WHEN cur.held AND $3::varchar = 'attempt' THEN 1 ELSE 0 END,
                our_fault_attempts = c.our_fault_attempts
                                     + CASE WHEN cur.held AND $3::varchar = 'our_fault' THEN 1 ELSE 0 END,
                last_outcome = CASE WHEN cur.held THEN COALESCE($4::varchar, c.last_outcome) ELSE c.last_outcome END,
                last_disposition = COALESCE($5::varchar, c.last_disposition),
                next_attempt_at = CASE
                                    WHEN c.suppressed_reason = 'dnc' OR NOT cur.held THEN c.next_attempt_at
                                    ELSE COALESCE($6::timestamptz, c.next_attempt_at)
                                  END,
                suppressed_reason = CASE
                                      WHEN c.suppressed_reason = 'dnc' THEN c.suppressed_reason
                                      ELSE COALESCE($7::varchar, c.suppressed_reason)
                                    END,
                updated_at = now()
           FROM cur
          WHERE c.id = cur.id
            AND (cur.held OR ($2::varchar = 'suppressed' AND cur.suppressed_reason IS DISTINCT FROM 'dnc'))
         RETURNING c.id, c.state, c.next_attempt_at,
                   CASE WHEN cur.held THEN 'settled' ELSE 'suppressed' END AS applied
       )
       SELECT id, state, next_attempt_at, applied FROM upd
       UNION ALL
       SELECT cur.id, cur.state, cur.next_attempt_at, 'unchanged' FROM cur
        WHERE NOT EXISTS (SELECT 1 FROM upd)`,
      [
        input.manualCallId,
        d?.contactState ?? null,
        input.charge,
        input.lastOutcome,
        input.lastDisposition,
        d?.nextAttemptAt ?? null,
        d?.suppressedReason ?? null,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.applied === 'settled' && d && row.state !== d.contactState) {
      log.warn(
        { contactId: row.id, requestedState: d.contactState, state: row.state },
        'Refused a soft-phone settlement on a DNC-suppressed contact — the row stays suppressed',
      );
    }
    return { contactId: row.id, state: row.state, nextAttemptAt: row.next_attempt_at, applied: row.applied };
  }

  /**
   * A same-code REPLAY of a soft-phone outcome that corrected its callback time: move
   * the contact's `next_attempt_at` to the new instant, as the station's disposition
   * route re-runs `markState` on its replays. Only the contact THIS call settled
   * (`contact_claimed`), only while it is still `pending` on that code — pacing has not
   * claimed it since and nothing else has written it up — and never a DNC-suppressed
   * one. Nothing else changes: the first save already counted the attempt. Null when
   * no row qualifies.
   */
  async rescheduleFromManualReplay(
    input: { manualCallId: string; dispositionCode: string; nextAttemptAt: Date },
    deps: { client?: Pick<PoolClient, 'query'> } = {},
  ): Promise<{ contactId: string; state: AgencyContactState; nextAttemptAt: Date | null } | null> {
    const db = deps.client ?? getPool();
    const { rows } = await db.query<{ id: string; state: AgencyContactState; next_attempt_at: Date | null }>(
      `UPDATE agency_contacts c
          SET next_attempt_at = $3::timestamptz, updated_at = now()
         FROM agency_manual_calls m
        WHERE m.id = $1 AND m.contact_claimed
          AND c.id = m.contact_id AND c.campaign_id = m.campaign_id
          AND c.state = 'pending' AND c.last_disposition = $2::varchar
          AND c.suppressed_reason IS DISTINCT FROM 'dnc'
        RETURNING c.id, c.state, c.next_attempt_at`,
      [input.manualCallId, input.dispositionCode, input.nextAttemptAt],
    );
    const row = rows[0];
    return row ? { contactId: row.id, state: row.state, nextAttemptAt: row.next_attempt_at } : null;
  }

  /**
   * Contacts stranded `in_flight`: claimed, with no live attempt, and nothing
   * written to the contact or to any of its attempts since `olderThan`.
   *
   * `in_flight` is set by `claimDialable` and cleared by whoever settles the
   * attempt, so a contact still in it with every attempt terminal (or none at
   * all) was left by a write that failed or a process that died between the two
   * — the dialer's contact settlement throwing after the attempt row was ended,
   * or a crash between `claimDialable` and the attempt INSERT. No attempt sweep
   * can see those: they start from a non-terminal attempt.
   *
   * The attempt clause also has `updated_at >= $1`, so a contact whose attempt
   * has just ended is left alone while its settlement is still running. Served by
   * `idx_agency_contacts_in_flight` (the few contacts mid-call), with the attempts
   * read through `uq_agency_attempt_number`'s `contact_id` prefix.
   *
   * ── It CLAIMS what it finds, so two sweeps cannot requeue one contact twice ──
   *
   * The caller charges the our-fault ledger for every row returned, and that
   * charge is unconditional. This was a plain SELECT, so two sweeps whose reads
   * overlapped (one outlasting the 60s interval — `start()` fires them `void`
   * with no in-flight guard — or two replicas) both returned the same contact and
   * both charged it: four overlapping sweeps retired contacts `exhausted` after a
   * single stranding (`test/integration/load/contact-claim-contention.test.ts`).
   * So the read is the leak sweep's shape instead (`reapByIds`: a guarded UPDATE
   * whose RETURNING decides who requeues): the rows are locked `SKIP LOCKED`,
   * stamped `updated_at = now()` — which takes them out of `updated_at < $1` for
   * any later sweep — and only this statement's RETURNING gets them. A crash
   * after the claim and before the requeue leaves the contact `in_flight` with a
   * fresh stamp, found again one threshold later. The outer re-check is the same
   * belt as `claimDialable`'s: the pick runs once (MATERIALIZED), and the UPDATE
   * re-asserts what it picked on.
   */
  async findStrandedInFlight(
    olderThan: Date,
    limit = 500,
  ): Promise<Array<{ id: string; tenant_id: string; campaign_id: string }>> {
    const { rows } = await getPool().query<{ id: string; tenant_id: string; campaign_id: string }>(
      `WITH picked AS MATERIALIZED (
         SELECT ct.id
           FROM agency_contacts ct
          WHERE ct.state = 'in_flight'
            AND ct.updated_at < $1::timestamptz
            AND NOT EXISTS (
                  SELECT 1 FROM agency_call_attempts a
                   WHERE a.contact_id = ct.id
                     AND (a.state <> 'ended' OR a.updated_at >= $1::timestamptz))
            -- A soft-phone call's claim (docs/softphone.md §5): a contact held by a
            -- live manual call, or by one that ended and awaits its outcome, is not
            -- stranded — its settlement is coming from the outcome or the lapse
            -- sweep. Served by idx_agency_manual_calls_contact (partial on unsettled).
            AND NOT EXISTS (
                  SELECT 1 FROM agency_manual_calls m
                   WHERE m.contact_id = ct.id AND m.settled_at IS NULL)
          ORDER BY ct.updated_at
            FOR UPDATE OF ct SKIP LOCKED
          LIMIT $2
       )
       UPDATE agency_contacts c SET updated_at = now()
         FROM picked
        WHERE c.id = picked.id
          AND c.state = 'in_flight'
          AND c.updated_at < $1::timestamptz
       RETURNING c.id, c.tenant_id, c.campaign_id`,
      [olderThan, limit],
    );
    return rows;
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
   * nothing can pick it up, and a crash in the gap leaves a stuck `in_flight`
   * row behind a terminal attempt, which the reaper's stranded-contact sweep
   * ({@link findStrandedInFlight}) requeues.
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
   * Return the contact of an attempt the reaper ended to the roster, charged to the
   * our-fault ledger, **only if the contact still belongs to that attempt**. One
   * statement: the ownership check, the charge, the bound and the state write cannot be
   * separated by anything else touching the row.
   *
   * ── Why the check ───────────────────────────────────────────────────────────
   *
   * The reaper ends an attempt some time after it stopped being driven: the unrecorded-
   * ends and leak sweeps up to a minute later. Meanwhile the contact may have moved on.
   * The dialer's abandon path writes the attempt `ended` and unclaims the contact as two
   * statements, so when only the first fails the contact is `pending` again, and pacing
   * (or a soft-phone call) can claim it and dial it before the sweep. A requeue that
   * wrote `pending` regardless then pulled that `in_flight` contact out from under its
   * new live attempt (claimable again while that call runs), or reopened a contact the
   * new attempt had already settled (`completed`, or `connected` awaiting its write-up).
   *
   * So the write lands only while the contact is still the reaped attempt's:
   *
   *  - `reapedAttemptId` set (the startup, slot, leak and unrecorded-ends reaps): the
   *    contact is `in_flight` (claimed for it) or `connected` (parked by its bridge), no
   *    attempt on it is newer than the reaped one (`attempt_number` is derived per
   *    contact as MAX + 1, `AgencyAttemptRepository.create`, so "newer" is exact; and
   *    `uq_agency_attempt_live` allows no older live one), and no soft-phone call holds
   *    its claim.
   *  - `reapedAttemptId` null (the stranded-contact sweep, which has no attempt): the
   *    contact is `in_flight`, with no live attempt and no soft-phone call holding it,
   *    the same test `findStrandedInFlight` picked it by.
   *
   * A contact that is `pending` already (the abandon path's unclaim did land) is left as
   * it is, with the `next_attempt_at` that unclaim gave it, and nothing is charged.
   *
   * ── What it writes ─────────────────────────────────────────────────────────
   *
   * `our_fault_attempts` + 1 (never `attempt_count`: our crash must not spend the
   * customer's retries), `last_outcome`, and then `pending` at `notBefore`, or
   * `retiredState` once the post-bump count reaches `bound` (`resolveOurFaultRedial`'s
   * rule; the caller passes its `ourFaultRedialBound` and `OUR_FAULT_RETIRED_STATE`). A
   * row carrying `suppressed_reason = 'dnc'` stays `suppressed` with its
   * `next_attempt_at`, as {@link markState} keeps it.
   *
   * `holdUnknownDialsMs` (the stranded-contact sweep's, which has no attempt to read a hold
   * from): `next_attempt_at` is moved on to `dialed_at` + that much for any dial of this
   * contact, a campaign attempt or a soft-phone call, that was sent (`dialed_at` set; a
   * soft-phone dial the carrier never saw has it cleared), never answered or bridged, and
   * not ended by a carrier answer (`no_answer`, `busy`, `invalid`): the carrier may still be
   * placing it. In the same statement, so a contact whose own hold write failed
   * (`holdOutcomeUnknownContact`, a soft-phone settle) is not handed back early by the
   * sweep that recovers it. It errs on holding: a dial whose end this cannot tell (a carrier
   * refusal, a failure before the carrier, a teardown, an orphan) is held too.
   *
   * Returns the state and count that landed, or null when the contact no longer belongs
   * to the reaped attempt (or does not exist) and nothing was written.
   *
   * The dialer uses it too, for the contact of a dial whose outcome is unknown
   * (`holdOutcomeUnknownContact`, `agency/dialer/contact-settlement.ts`): the attempt it
   * just ended as `reapedAttemptId`, `notBefore` the 15-minute hold. The same write, so the
   * hold and its our-fault charge land together and the bound ends a run of such dials.
   */
  async requeueOrphaned(
    contactId: string,
    opts: {
      reapedAttemptId: string | null;
      notBefore: Date;
      outcome: string;
      bound: number;
      retiredState: string;
      holdUnknownDialsMs?: number | null;
    },
  ): Promise<{ state: AgencyContactState; our_fault_attempts: number } | null> {
    // GREATEST ignores the NULL the subquery gives when no dial qualifies.
    const { rows } = await getPool().query<{ state: AgencyContactState; our_fault_attempts: number }>(
      `UPDATE agency_contacts c
          SET our_fault_attempts = c.our_fault_attempts + 1,
              last_outcome = $3,
              state = CASE
                        WHEN c.suppressed_reason = 'dnc' THEN 'suppressed'
                        WHEN c.our_fault_attempts + 1 >= $5 THEN $6
                        ELSE 'pending'
                      END,
              next_attempt_at = CASE
                                  WHEN c.suppressed_reason = 'dnc' OR c.our_fault_attempts + 1 >= $5 THEN c.next_attempt_at
                                  WHEN $7::bigint IS NULL THEN $4
                                  ELSE GREATEST($4, (
                                    SELECT max(d.dialed_at) + make_interval(secs => $7::bigint / 1000.0)
                                      FROM (
                                        SELECT a.dialed_at, a.answered_at, a.bridged_at, a.outcome
                                          FROM agency_call_attempts a WHERE a.contact_id = c.id
                                        UNION ALL
                                        SELECT m.dialed_at, m.answered_at, m.bridged_at, m.outcome
                                          FROM agency_manual_calls m WHERE m.contact_id = c.id
                                      ) d
                                     WHERE d.dialed_at IS NOT NULL
                                       AND d.answered_at IS NULL
                                       AND d.bridged_at IS NULL
                                       AND d.outcome IS DISTINCT FROM 'no_answer'
                                       AND d.outcome IS DISTINCT FROM 'busy'
                                       AND d.outcome IS DISTINCT FROM 'invalid'))
                                END,
              updated_at = now()
        WHERE c.id = $1
          AND CASE
                WHEN $2::uuid IS NULL THEN
                  c.state = 'in_flight'
                  AND NOT EXISTS (
                        SELECT 1 FROM agency_call_attempts a
                         WHERE a.contact_id = c.id AND a.state <> 'ended')
                ELSE
                  c.state IN ('in_flight', 'connected')
                  AND EXISTS (
                        SELECT 1 FROM agency_call_attempts r
                         WHERE r.id = $2::uuid
                           AND r.contact_id = c.id
                           AND NOT EXISTS (
                                 SELECT 1 FROM agency_call_attempts a
                                  WHERE a.contact_id = c.id
                                    AND a.attempt_number > r.attempt_number))
              END
          AND NOT EXISTS (
                SELECT 1 FROM agency_manual_calls m
                 WHERE m.contact_id = c.id AND m.settled_at IS NULL AND m.contact_claimed)
      RETURNING c.state, c.our_fault_attempts`,
      [
        contactId, opts.reapedAttemptId, opts.outcome, opts.notBefore, opts.bound, opts.retiredState,
        opts.holdUnknownDialsMs ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * Write the disposition route's contact decision for one attempt, **only while the
   * contact still belongs to that attempt**. One statement: the ownership check and the
   * write cannot be separated by anything else touching the row. The same shape as
   * {@link requeueOrphaned} and `AgencyAttemptRepository.closeLapsedWrapup`.
   *
   * ── Why the check ───────────────────────────────────────────────────────────
   *
   * `recordDisposition` is idempotent on the code, so a same-code replay (the console
   * retrying a submit after a network blip, a queued retry flushed late, a supervisor
   * re-submitting a write-up from the attempt history) succeeds and reaches this write
   * again. Written with {@link markState}, that replay moved the contact whatever had
   * happened to it since: a `voicemail` replay of call 1 arriving after call 2 had closed
   * the contact as a sale put it back to `pending` (the customer who said yes is dialled
   * again), and one arriving while pacing or a soft-phone call held the contact
   * `in_flight` handed it back to the roster under a live call.
   *
   * So the write lands only while, on the row as it is now:
   *
   *  - no attempt on the contact is newer than this one (`attempt_number` is MAX + 1 per
   *    contact, `AgencyAttemptRepository.create`, so "newer" is exact);
   *  - no soft-phone call holds the contact's claim, and none has claimed it since this
   *    attempt was created. A manual call settles the contact without an attempt row, so
   *    the attempt test cannot see it; and it can only have claimed the contact after
   *    this attempt released it, because {@link claimForManual} claims only `pending`;
   *  - the contact is in a state this attempt's disposition can own:
   *     - `connected`: parked waiting for this write-up (the first submit);
   *     - `pending` with `last_disposition` already this code: the replay that corrects a
   *       callback time (`callback_at` is last-write-wins on the attempt and the contact's
   *       `next_attempt_at` follows it, as {@link rescheduleFromManualReplay} does for the
   *       soft phone);
   *     - `suppressed_reason = 'dnc'`: an agent who marked DNC mid-call still writes the
   *       call up afterwards, and `last_disposition` must land (the state stays frozen).
   *
   * Anything else is left as it is: `in_flight` (claimed for a new dial whose attempt row
   * may not exist yet), or `completed` / `exhausted` / `suppressed` by this disposition's
   * first write or by a later settlement. For a replay that is the idempotent answer: the
   * first write already landed.
   *
   * ── What it writes ─────────────────────────────────────────────────────────
   *
   * What {@link markState} wrote for the route: `state`, `last_outcome`,
   * `last_disposition`, `next_attempt_at` (COALESCEd), `suppressed_reason`, never
   * `attempt_count` (the attempt was counted when it ended), under the DNC rule (a row
   * carrying `suppressed_reason = 'dnc'` stays `suppressed` with its `next_attempt_at`
   * and its reason).
   *
   * Returns the state that landed, or null when the contact no longer belongs to the
   * attempt (or either row does not exist) and nothing was written.
   */
  async releaseFromDisposition(opts: {
    contactId: string;
    attemptId: string;
    dispositionCode: string;
    state: AgencyContactState;
    lastOutcome: string | null;
    nextAttemptAt: Date | null;
    suppressedReason: string | null;
    /**
     * CA8 grant: the recorded entry's `override` (`overrideGrantOf`). The contact's
     * `override_*` columns are REPLACED with it, `override_disposition` = this code. Absent or
     * null: an existing grant is left alone.
     */
    grant?: OverrideGrant | null;
    /**
     * CA8 spend: the decision is the disposition `retry`'s max-attempts exhaustion
     * (`disposition_attempts_reached`); `delayMinutes` is that rule's delay. An unspent
     * `extra_attempts` then keeps the contact `pending` instead.
     */
    extraAttempt?: { reason: string; delayMinutes: number; now: Date } | null;
    /**
     * CA4: the decision booked a callback on a strict / preferred campaign; the agent who took
     * the call (the attempt's reserved agent). A contact in the pool is assigned to them.
     */
    callbackOwner?: { userId: string } | null;
  }): Promise<DispositionRelease | null> {
    return withTransaction(async (client) => {
      // ── The row, locked: everything decided below reads it as it is now ────────
      // The grant, the spend and the owner are decided on the locked row and written by the
      // ONE guarded statement below, so they land exactly when the release lands.
      const { rows: [locked] } = await client.query<Pick<AgencyContactRecord,
        'state' | 'suppressed_reason' | 'last_disposition' | 'assigned_user_id' | 'override_extra_attempts'
        | 'tenant_id' | 'campaign_id'>>(
        `SELECT state, suppressed_reason, last_disposition, assigned_user_id, override_extra_attempts,
                tenant_id, campaign_id
           FROM agency_contacts WHERE id = $1 FOR UPDATE`,
        [opts.contactId],
      );
      if (!locked) return null;
      const dnc = locked.suppressed_reason === 'dnc';
      // The FIRST write of this attempt's disposition: the contact is parked for it. The only
      // write that grants, spends or assigns. A same-code replay (`pending` on this code)
      // re-lands the record but never grants again (a replay must not top a spent grant back
      // up), never spends again, and keeps the state the first write chose.
      const firstWrite = locked.state === 'connected' && !dnc;
      const replay = !dnc && locked.state === 'pending' && locked.last_disposition === opts.dispositionCode;

      const grant = firstWrite ? (opts.grant ?? null) : null;
      let state: AgencyContactState = opts.state;
      let nextAttemptAt = opts.nextAttemptAt;
      let extraAttempts: number | null = grant ? grant.extraAttempts : null;
      let extraAttemptSpent = false;
      if (opts.extraAttempt && firstWrite) {
        const remaining = grant ? grant.extraAttempts : locked.override_extra_attempts;
        const applied = applyExtraAttemptOverride(
          { contactState: opts.state, nextAttemptAt: opts.nextAttemptAt, reason: opts.extraAttempt.reason },
          remaining,
          { delayMinutes: opts.extraAttempt.delayMinutes },
          opts.extraAttempt.now,
        );
        if (applied.spent) {
          state = applied.decision.contactState;
          nextAttemptAt = applied.decision.nextAttemptAt;
          extraAttempts = remaining - 1;
          extraAttemptSpent = true;
        }
      } else if (replay && state !== 'pending') {
        // A replay whose decision closes the contact, finding it `pending` on this code: the
        // first write left it open (it spent an extra attempt), or the agent reopened it since
        // (agent retry). Either way the replay keeps it `pending` at its time and spends
        // nothing: re-closing it would undo what happened after the first write.
        state = 'pending';
        nextAttemptAt = null;
      }
      const assignTo = firstWrite && opts.callbackOwner && locked.assigned_user_id === null
        ? opts.callbackOwner.userId
        : null;

      const { rows } = await client.query<{ state: AgencyContactState; suppressed_reason: string | null; next_attempt_at: Date }>(
        `UPDATE agency_contacts c
            SET state = CASE WHEN c.suppressed_reason = 'dnc' THEN 'suppressed' ELSE $4::varchar END,
                last_outcome = COALESCE($5::varchar, c.last_outcome),
                last_disposition = $3::varchar,
                next_attempt_at = CASE WHEN c.suppressed_reason = 'dnc' THEN c.next_attempt_at
                                       ELSE COALESCE($6::timestamptz, c.next_attempt_at) END,
                suppressed_reason = CASE WHEN c.suppressed_reason = 'dnc' THEN c.suppressed_reason
                                         ELSE COALESCE($7::varchar, c.suppressed_reason) END,
                -- CA8: a grant replaces every part; a spend decrements (never below 0, the CHECK).
                override_disposition = CASE WHEN $8::boolean THEN $3::varchar ELSE c.override_disposition END,
                override_granted_at = CASE WHEN $8::boolean THEN now() ELSE c.override_granted_at END,
                override_retry_delay = CASE WHEN $8::boolean THEN $9::boolean ELSE c.override_retry_delay END,
                override_calling_hours = CASE WHEN $8::boolean THEN $10::boolean ELSE c.override_calling_hours END,
                -- Not COALESCE(GREATEST(0, $11), col): GREATEST ignores a NULL argument,
                -- so that would write 0 over every grant on every non-granting outcome.
                override_extra_attempts = CASE WHEN $11::int IS NULL THEN c.override_extra_attempts
                                               ELSE GREATEST(0, $11::int) END,
                -- CA4: a callback in the pool goes to the agent who took the call.
                assigned_user_id = COALESCE(c.assigned_user_id, $12::uuid),
                assigned_at = CASE WHEN c.assigned_user_id IS NULL AND $12::uuid IS NOT NULL THEN now() ELSE c.assigned_at END,
                assigned_by_user_id = CASE WHEN c.assigned_user_id IS NULL AND $12::uuid IS NOT NULL THEN $12::uuid
                                           ELSE c.assigned_by_user_id END,
                updated_at = now()
           FROM agency_call_attempts r
          WHERE c.id = $1
            AND r.id = $2
            AND r.contact_id = c.id
            AND (c.state = 'connected'
                 OR (c.state = 'pending' AND c.last_disposition = $3::varchar)
                 OR c.suppressed_reason = 'dnc')
            AND NOT EXISTS (
                  SELECT 1 FROM agency_call_attempts n
                   WHERE n.contact_id = c.id AND n.attempt_number > r.attempt_number)
            AND NOT EXISTS (
                  SELECT 1 FROM agency_manual_calls m
                   WHERE m.contact_id = c.id AND m.contact_claimed
                     AND (m.settled_at IS NULL OR m.created_at > r.created_at))
        RETURNING c.state, c.suppressed_reason, c.next_attempt_at`,
        [
          opts.contactId,
          opts.attemptId,
          opts.dispositionCode,
          state,
          opts.lastOutcome,
          nextAttemptAt,
          opts.suppressedReason,
          grant !== null,
          grant?.retryDelay ?? false,
          grant?.callingHours ?? false,
          extraAttempts,
          assignTo,
        ],
      );
      const landed = rows[0] ?? null;
      if (!landed) return null;
      if (landed.state !== state) {
        log.warn(
          {
            contactId: opts.contactId,
            requestedState: state,
            state: landed.state,
            suppressedReason: landed.suppressed_reason,
          },
          'Refused a state transition on a DNC-suppressed contact — the row stays suppressed',
        );
      }
      if (extraAttemptSpent) {
        await client.query(
          `UPDATE agency_call_attempts
              SET override_applied = array_append(override_applied, 'extra_attempts')
            WHERE id = $1 AND NOT ('extra_attempts' = ANY(override_applied))`,
          [opts.attemptId],
        );
      }
      if (assignTo) {
        await client.query(
          `INSERT INTO agency_contact_assignment_events
             (tenant_id, campaign_id, contact_id, from_user_id, to_user_id, actor_user_id, reason, batch_id)
           VALUES ($1, $2, $3, NULL, $4::uuid, $4::uuid, 'callback', gen_random_uuid())`,
          [locked.tenant_id, locked.campaign_id, opts.contactId, assignTo],
        );
      }
      return {
        state: landed.state,
        suppressed_reason: landed.suppressed_reason,
        next_attempt_at: landed.next_attempt_at,
        extraAttemptSpent,
        overrideGranted: grant !== null,
        assignedTo: assignTo,
      };
    }, { pool: getPool() });
  }

  /**
   * The settlement's write for an attempt whose outcome-policy decision EXHAUSTS the contact
   * because the rule's `max_attempts` is spent (`max_attempts_reached`), with the CA8 spend:
   * when the contact holds an unspent `extra_attempts` override it stays `pending`, due after
   * the rule's delay, one extra attempt is spent and the attempt being settled records
   * `override_applied += 'extra_attempts'`. Otherwise it is exactly {@link markState}'s write
   * of the decision.
   *
   * One transaction, contact row first then the attempt's (the order the disposition's write
   * takes them in, so the two can never deadlock). Spent at most once per attempt: an attempt
   * that already records the spend (a replayed settlement) writes nothing and spends nothing,
   * and the decrement never goes below 0. The DNC freeze is {@link markState}'s: a row carrying
   * `suppressed_reason = 'dnc'` stays `suppressed` and spends nothing.
   *
   * @returns the state that landed and whether an extra attempt was spent; null when the
   *   contact or the attempt does not exist (nothing written).
   */
  async markExhaustedOrSpendExtraAttempt(opts: {
    contactId: string;
    attemptId: string;
    decision: SpendableDecision;
    delayMinutes: number;
    now: Date;
  }): Promise<{ state: AgencyContactState; extraAttemptSpent: boolean; nextAttemptAt: Date | null } | null> {
    return withTransaction(async (client) => {
      const { rows: [contact] } = await client.query<Pick<AgencyContactRecord, 'override_extra_attempts' | 'suppressed_reason'>>(
        'SELECT override_extra_attempts, suppressed_reason FROM agency_contacts WHERE id = $1 FOR UPDATE',
        [opts.contactId],
      );
      const { rows: [attempt] } = await client.query<{ override_applied: string[] }>(
        'SELECT override_applied FROM agency_call_attempts WHERE id = $1 AND contact_id = $2 FOR UPDATE',
        [opts.attemptId, opts.contactId],
      );
      if (!contact || !attempt) return null;
      if (attempt.override_applied.includes('extra_attempts')) {
        // This attempt's settlement already spent one: nothing is decided twice.
        return { state: 'pending', extraAttemptSpent: false, nextAttemptAt: null };
      }
      const remaining = contact.suppressed_reason === 'dnc' ? 0 : contact.override_extra_attempts;
      const applied = applyExtraAttemptOverride(opts.decision, remaining, { delayMinutes: opts.delayMinutes }, opts.now);
      const { rows: [landed] } = await client.query<{ state: AgencyContactState; suppressed_reason: string | null }>(
        `UPDATE agency_contacts
            SET state = CASE WHEN suppressed_reason = 'dnc' THEN 'suppressed' ELSE $2 END,
                next_attempt_at = CASE WHEN suppressed_reason = 'dnc' THEN next_attempt_at ELSE COALESCE($3, next_attempt_at) END,
                override_extra_attempts = GREATEST(0, override_extra_attempts - $4::int),
                updated_at = now()
          WHERE id = $1
        RETURNING state, suppressed_reason`,
        [opts.contactId, applied.decision.contactState, applied.decision.nextAttemptAt, applied.spent ? 1 : 0],
      );
      if (applied.spent) {
        await client.query(
          `UPDATE agency_call_attempts
              SET override_applied = array_append(override_applied, 'extra_attempts')
            WHERE id = $1`,
          [opts.attemptId],
        );
      }
      if (landed && landed.state !== applied.decision.contactState) {
        log.warn(
          { contactId: opts.contactId, requestedState: applied.decision.contactState, state: landed.state },
          'Refused a state transition on a DNC-suppressed contact — the row stays suppressed',
        );
      }
      return {
        state: landed?.state ?? applied.decision.contactState,
        extraAttemptSpent: applied.spent,
        nextAttemptAt: applied.decision.nextAttemptAt,
      };
    }, { pool: getPool() });
  }

  /**
   * Park the contact of an ended conversation (or of a wrap-up redial) in `connected`,
   * held for the agent's write-up, **only while the call still holds it**: the contact is
   * `in_flight` (claimed for this dial) or `connected` (parked at the bridge), and the
   * attempt has no disposition yet. Anything else means the write-up already decided the
   * contact's fate, and re-parking it would hold the customer behind a write-up that is
   * already taken: `connected` with a dispositioned attempt is released by nothing (the
   * lapsed-wrap-up sweep reads `disposition_code IS NULL`).
   *
   * The case it exists for: the agent saves the outcome while the call is still live
   * (bridged), the disposition route releases the contact (`releaseFromDisposition`:
   * `completed`, a retry, a callback), and the call's end then arrives here. An
   * unconditional `markState('connected')` put that contact back in `connected` for good.
   *
   * `bumpAttempt` (a paced call) is charged whether or not the park lands: the dial
   * happened, and the disposition route never charges (the attempt is counted when it
   * ends). `last_outcome` is written only with the park. The DNC rule is
   * {@link markState}'s: a row carrying `suppressed_reason = 'dnc'` stays `suppressed`.
   *
   * Returns whether the contact was parked (false also when either row is missing).
   */
  async parkForWriteUp(opts: {
    contactId: string;
    attemptId: string;
    lastOutcome: string | null;
    bumpAttempt?: boolean;
  }): Promise<boolean> {
    const { rows } = await getPool().query<{ parked: boolean }>(
      `WITH held AS (
         SELECT c.id,
                (c.state IN ('in_flight', 'connected') AND r.disposition_code IS NULL) AS hold
           FROM agency_contacts c
           JOIN agency_call_attempts r ON r.id = $2 AND r.contact_id = c.id
          WHERE c.id = $1
       )
       UPDATE agency_contacts c
          SET state = CASE WHEN c.suppressed_reason = 'dnc' THEN 'suppressed'
                           WHEN held.hold THEN 'connected'
                           ELSE c.state END,
              attempt_count = c.attempt_count + $4::int,
              last_outcome = CASE WHEN held.hold THEN COALESCE($3::varchar, c.last_outcome)
                                  ELSE c.last_outcome END,
              updated_at = now()
         FROM held
        WHERE c.id = held.id
          -- Nothing to write when the call no longer holds the contact and nothing is
          -- charged: the row is left exactly as the write-up left it.
          AND (held.hold OR $4::int > 0)
      RETURNING held.hold AND c.state = 'connected' AS parked`,
      [opts.contactId, opts.attemptId, opts.lastOutcome, opts.bumpAttempt ? 1 : 0],
    );
    return rows[0]?.parked ?? false;
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
   * AFTERWARDS through the disposition route ({@link releaseFromDisposition}, which
   * applies this same rule) carrying `last_disposition`; refusing the row would
   * silently drop the record of what was said. So the STATE and the retry instant are frozen and every
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
   * orphan requeue, since moved to {@link requeueOrphaned}) hardcoded `'pending'` rather than taking a decision, and a
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
   *   * `reaper.ts` lapsed-wrap-up sweep — no longer a caller:
   *     `AgencyAttemptRepository.closeLapsedWrapup` writes its `resolveRetryDecision`
   *     answer in one guarded statement with the same `CASE`, keyed on the same reason.
   *   * `reaper.ts` orphan requeue and our-fault-bounded retire — no longer a
   *     caller: {@link requeueOrphaned} writes them in one statement with the
   *     same `CASE`, keyed on the same reason.
   *   * the disposition route (`api/routes/agency/attempts.ts`) — no longer a
   *     caller: {@link releaseFromDisposition} writes its decision in one statement
   *     with the same `CASE`, and only while the contact still belongs to the
   *     attempt being written up. `last_disposition` still lands on a DNC row,
   *     deliberately.
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
      //     (`releaseFromDisposition` with `decision.suppressedReason`), and
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
    /** `callbackCodes(campaign.disposition_catalog)`; required by `waiting=retry|callback`. */
    callbackCodes?: readonly string[];
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyContactRow>> {
    const bind = params();
    // The four vocabulary dimensions come from the SHARED builder, because this
    // list is where a retry selection is authored and the seeding statement has to
    // mean the same thing by them — see `contactFilterConditions`. The rest are this
    // list's own (`contactListFilterConditions`): deliberately not retry-selector
    // dimensions, and shared with `countListed` so the total counts these rows.
    const conditions = [
      `c.campaign_id = ${bind.add(input.campaignId)}`,
      ...contactListFilterConditions(input.filters, 'c', bind, input.callbackCodes),
    ];
    if (input.after) conditions.push(keysetCondition(input.after, 'c', bind));

    const sql = `
      SELECT c.id, c.phone_e164, c.state, c.attempt_count, c.our_fault_attempts,
             c.last_outcome, c.last_disposition, c.next_attempt_at,
             c.suppressed_reason, c.timezone, c.csv_line_number,
             c.assigned_user_id, c.assigned_at,
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
   * How many contacts {@link listForCampaign} would list with these filters, across every
   * page: the opt-in `total` (`?include_total=1`). The same WHERE terms, no keyset, no limit.
   *
   * Every column the list filters read except the phone digits and `created_at` is a key or
   * INCLUDE column of `idx_agency_contacts_insights` (0011), so a count by state, waiting
   * bucket, attempted, owner, outcome or disposition is a scan of that index's
   * `(campaign_id[, state])` prefix (index-only once the visibility map is set).
   */
  async countListed(input: {
    campaignId: string;
    filters: AgencyContactFilters;
    callbackCodes?: readonly string[];
  }): Promise<number> {
    const bind = params();
    const conditions = [
      `c.campaign_id = ${bind.add(input.campaignId)}`,
      ...contactListFilterConditions(input.filters, 'c', bind, input.callbackCodes),
    ];
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agency_contacts c WHERE ${conditions.join(' AND ')}`,
      bind.values,
    );
    return Number(rows[0]?.n ?? 0);
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

export const agencyContactRepository = new AgencyContactRepository();
