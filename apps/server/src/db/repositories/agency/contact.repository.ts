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
import { CONTACT_PHONE_DIGITS_SQL } from './sql-fragments.js';
import {
  contactFilterConditions,
  keysetCondition,
  params,
  phoneCondition,
  toKeysetPage,
} from './query-builders.js';
import { projectContactRow } from './projections.js';

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
   */
  async claimDialable(campaignId: string, limit: number): Promise<AgencyContactRecord[]> {
    if (limit <= 0) return [];
    const { rows } = await getPool().query<AgencyContactRecord>(
      `WITH picked AS MATERIALIZED (
         SELECT id FROM agency_contacts
          WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at <= now()
            AND suppressed_reason IS DISTINCT FROM 'dnc'
          ORDER BY next_attempt_at
            FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE agency_contacts c SET state = 'in_flight', updated_at = now()
         FROM picked
        WHERE c.id = picked.id
       RETURNING c.*`,
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
   * (`next_attempt_at` kept). Either way `attempt_count + 1` when the call was
   * placed (`placed`: the manual call has a `dialed_at`), and `last_outcome` /
   * `last_disposition` land.
   *
   * ⚠️ `attemptsUsed` for `resolveDispositionDecision` is therefore the contact's
   * stored `attempt_count` PLUS this call when placed — this method does the bump,
   * the decision is computed before it (the claim keeps anything else off the row).
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
      /** The dial reached the carrier (`dialed_at` set): counts against the retry budget. */
      placed: boolean;
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
                attempt_count = c.attempt_count + CASE WHEN cur.held AND $3::boolean THEN 1 ELSE 0 END,
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
        input.placed,
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

export const agencyContactRepository = new AgencyContactRepository();
