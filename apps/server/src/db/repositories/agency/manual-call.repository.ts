/**
 * `AgencyManualCallRepository`: the soft phone's audit spine, `agency_manual_calls`
 * (0005, docs/softphone.md §3): create, the guarded lifecycle, the outcome and its
 * settlement, the lapse and orphan sweeps, and the reads.
 *
 * ── Who owns what ──────────────────────────────────────────────────────────────
 * This file writes the manual-call row and nothing else. The roster contact's half
 * (claim, release, §5 settlement) is `AgencyContactRepository`'s
 * (`claimForManual`, `releaseManualClaim`, `settleFromManual`), the DNC write is the
 * DNC path's, and the Redis `manual` claim is the runtime's. The runtime composes
 * them on ONE transaction client where the docs say "in the same transaction": every
 * write here takes `deps.client` for that (decision B8).
 *
 * ── The lifecycle, as the attempt's ────────────────────────────────────────────
 * `queued → dialing → ringing → answered → bridged → ended`, forward only
 * ({@link AgencyManualCallRepository.advanceState}), with `answered_at` and
 * `bridged_at` stamped by their own events and never back-filled or overwritten.
 * `ended` is written only by {@link AgencyManualCallRepository.end} and the orphan
 * sweep; `settled_at` only by the outcome, the unanswered settle, the lapse sweep
 * and the orphan sweep (an unbridged orphan). `uq_agency_manual_call_unsettled`
 * allows one unsettled row per session: the backstop under the Redis claim.
 */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import {
  SOFTPHONE_OUTCOME_LAPSE_MS,
  type AgencyCallFieldValues,
  type AgencyContactState,
  type AgencyKeysetPage,
  type AgencyManualCall,
  type AgencyManualCallDispositionSource,
  type AgencyManualCallEndReason,
  type AgencyManualCallOutcome,
  type AgencyManualCallState,
} from '@magick-agency/contracts/agency';
import type { AgencyManualCallRecord } from '../../models/agency.model.js';
// The auto-close code an attempt's lapsed wrap-up gets; a lapsed manual call that
// owed an outcome gets the same one, so "auto-closed" reads the same on both spines.
import { AUTO_DISPOSITION_CODE } from '../../../agency/disposition.js';
import { keysetCondition, params, toKeysetPage } from './query-builders.js';
import { projectManualCallRow, type AgencyManualCallJoinedRow } from './projections.js';

type Db = Pick<PoolClient, 'query'>;

/** The lifecycle states {@link AgencyManualCallRepository.advanceState} may move to. `ended` is `end`'s. */
export type AgencyManualCallAdvanceState = Exclude<AgencyManualCallState, 'queued' | 'ended'>;

/** Forward order of the lifecycle; the SQL guard compares positions in this list. */
const MANUAL_CALL_STATE_ORDER: readonly AgencyManualCallState[] = [
  'queued', 'dialing', 'ringing', 'answered', 'bridged', 'ended',
];
const STATE_ORDER_SQL = `ARRAY[${MANUAL_CALL_STATE_ORDER.map((st) => `'${st}'`).join(', ')}]::varchar[]`;

/**
 * How long after it ended the lapse sweep leaves an unsettled call that never
 * bridged for the dialer's own settle (§4.1 step 6) before closing it itself. The
 * dialer's settle takes milliseconds; this is the margin that keeps the sweep from
 * racing it, and it is short because such a call owes nothing and holds the session.
 */
export const MANUAL_UNANSWERED_SETTLE_GRACE_MS = 30_000;

/** UUID shape, so a malformed id from a path never reaches a `uuid` comparison (22P02). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string): boolean => UUID_RE.test(value);

/**
 * The joins every wire read carries: the tag's name and the contact's state now.
 * Both LEFT and both without FK on the manual-call side, so a purged campaign or
 * contact never drops the call from its own audit trail.
 */
const WIRE_FROM_SQL = `agency_manual_calls m
        LEFT JOIN agency_campaigns cam ON cam.id = m.campaign_id
        LEFT JOIN agency_contacts  ct  ON ct.id  = m.contact_id`;
const WIRE_SELECT_SQL = 'm.*, cam.name AS campaign_name, ct.state AS contact_state';

/** Everything the dial path fixes on the row at insert (§4.1 step 3). Every field is required, deliberately. */
export interface AgencyManualCallCreateInput {
  tenantId: string;
  accountId: string;
  /** The caller's live session, on `break/soft_phone`. */
  sessionId: string;
  agentUserId: string;
  /** The tag; null = untagged. */
  campaignId: string | null;
  /**
   * The roster match on the tag, as `AgencyContactRepository.claimForManual`
   * answered: `claimed` with `priorState` for a claim, `claimed: false` and
   * `priorState: null` for a linked contact. Null: no match (or untagged).
   */
  contact: { contactId: string; claimed: boolean; priorState: AgencyContactState | null } | null;
  /** Normalised E.164. */
  destinationE164: string;
  callerId: string;
  /** Call-field values already validated against the field set in force. */
  fields: AgencyCallFieldValues;
  recordingRequested: boolean;
  analysisProfileId: string | null;
  /** SP1: the note (10–500 chars trimmed, CHECKed) and the overridden `dnc_entries.id`. */
  dncOverride: { note: string; entryId: string } | null;
  /** SP2. */
  hoursOverrideNote: string | null;
}

/** Filters of the two list reads, already parsed and validated by the API layer from `AgencyManualCallListQuery`. */
export interface AgencyManualCallListFilters {
  /** Account list only (`agency.supervise`); `listForAgent` takes the agent from its own argument. */
  agentUserId?: string;
  /** A campaign tag, or `'untagged'` for calls logged to none. */
  campaign?: { campaignId: string } | 'untagged';
  /** `live`: not ended; `awaiting_outcome`: ended and unsettled; `settled`. */
  status?: 'live' | 'awaiting_outcome' | 'settled';
  outcome?: AgencyManualCallOutcome;
  dispositionCode?: string;
  /** Digits only; matched as a SUFFIX of `destination_e164` ("the last four digits"). */
  phoneDigits?: string;
  /** Bounds on `created_at`: inclusive start, exclusive end. */
  from?: Date;
  to?: Date;
}

/**
 * A row of the two list reads: the wire row plus its media leg's `analysis_status`
 * (NULL when there is no leg, it was purged, or analysis never ran). The console's
 * `AgencyManualCallListRow` (`packages/contracts/src/api/agency/softphone.ts`).
 */
export type AgencyManualCallListRow = AgencyManualCall & { analysis_status: string | null };

/** Why {@link AgencyManualCallRepository.recordDisposition} refused. */
export type AgencyManualCallDispositionRefusal =
  /** No such call. */
  | 'not_found'
  /** The call has not ended. */
  | 'live'
  /** The call ended without bridging: there was no conversation to write up (settled, or about to be). */
  | 'not_bridged'
  /** Another code is already saved. */
  | 'different_code'
  /** The lapse sweep closed it `no_disposition`. */
  | 'lapsed';

export class AgencyManualCallRepository {
  /**
   * Insert the call, `queued` (§4.1 step 3), on the caller's transaction client —
   * the one that claimed the contact (`claimForManual`) first, so a refused insert
   * rolls the claim back with it.
   *
   * One unsettled call per session (`uq_agency_manual_call_unsettled`) is answered as
   * `session_has_unsettled_call` with that call, not thrown: `ON CONFLICT … DO
   * NOTHING` on the partial index keeps the caller's transaction usable (a caught
   * 23505 would have aborted it). The CALLER then rolls back, and answers
   * `manual_call_live` (the existing call is not ended) or `outcome_pending` (it is).
   *
   * Every column is named in the INSERT and every input field is required, so no
   * value can be dropped by an optional field the column list forgot.
   */
  async create(
    input: AgencyManualCallCreateInput,
    deps: { client?: Db } = {},
  ): Promise<
    | { ok: true; call: AgencyManualCallRecord }
    | { ok: false; reason: 'session_has_unsettled_call'; existing: AgencyManualCallRecord | null }
  > {
    const db = deps.client ?? getPool();
    const { rows } = await db.query<AgencyManualCallRecord>(
      `INSERT INTO agency_manual_calls
         (tenant_id, account_id, session_id, agent_user_id, campaign_id,
          contact_id, contact_claimed, contact_prior_state,
          destination_e164, caller_id, state, fields,
          recording_requested, analysis_profile_id,
          dnc_override_note, dnc_override_entry_id, hours_override_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', $11::jsonb, $12, $13, $14, $15, $16)
       ON CONFLICT (session_id) WHERE settled_at IS NULL DO NOTHING
       RETURNING *`,
      [
        input.tenantId, input.accountId, input.sessionId, input.agentUserId, input.campaignId,
        input.contact?.contactId ?? null,
        input.contact?.claimed ?? false,
        input.contact?.claimed ? input.contact.priorState : null,
        input.destinationE164, input.callerId, JSON.stringify(input.fields),
        input.recordingRequested, input.analysisProfileId,
        input.dncOverride?.note ?? null, input.dncOverride?.entryId ?? null,
        input.hoursOverrideNote,
      ],
    );
    const call = rows[0];
    if (call) return { ok: true, call };
    return {
      ok: false,
      reason: 'session_has_unsettled_call',
      existing: await this.findUnsettledForSession(input.sessionId, deps),
    };
  }

  /**
   * Move the call FORWARD to `state`, stamping the instant that state records:
   * `dialing` → `dialed_at`, `answered` → `answered_at`, `bridged` → `bridged_at`.
   *
   * Two guards, independent on purpose, as on the attempt (`setState`'s `only_from`):
   *
   * - **The state never moves backwards.** `answered` and `bridged` arrive
   *   back-to-back from the bridge and their handlers race; a `bridged` row must not
   *   be put back to `answered`, and an `ended` row never moves at all.
   * - **The timestamp lands even when the state does not**, but only into a NULL
   *   column (first stamp wins, never overwritten) and only while the call is
   *   unsettled. A `bridged` event processed after `ended` still records the
   *   conversation (`bridged_at` is what makes an outcome owed); `answered_at` is
   *   never back-filled from `bridged`. After settlement nothing is stamped, so a
   *   late event cannot make a settled call look like it owes an outcome.
   *
   * @returns the row and whether anything changed (state or a stamp) — send the
   *   `manual_call` frame when it did — or null when there is no such call.
   */
  async advanceState(
    id: string,
    state: AgencyManualCallAdvanceState,
    at: Date = new Date(),
    deps: { client?: Db } = {},
  ): Promise<{ call: AgencyManualCallRecord; changed: boolean; stateChanged: boolean } | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyManualCallRecord & {
      prev_state: AgencyManualCallState;
      prev_dialed_at: Date | null;
      prev_answered_at: Date | null;
      prev_bridged_at: Date | null;
    }>(
      `WITH prev AS (
         SELECT id, state, dialed_at, answered_at, bridged_at
           FROM agency_manual_calls WHERE id = $1 FOR UPDATE
       )
       UPDATE agency_manual_calls m
          SET state = CASE
                        WHEN array_position(${STATE_ORDER_SQL}, $2::varchar)
                             > array_position(${STATE_ORDER_SQL}, m.state)
                        THEN $2::varchar ELSE m.state
                      END,
              dialed_at = CASE WHEN $2::varchar = 'dialing' AND m.settled_at IS NULL
                               THEN COALESCE(m.dialed_at, $3::timestamptz) ELSE m.dialed_at END,
              answered_at = CASE WHEN $2::varchar = 'answered' AND m.settled_at IS NULL
                                 THEN COALESCE(m.answered_at, $3::timestamptz) ELSE m.answered_at END,
              bridged_at = CASE WHEN $2::varchar = 'bridged' AND m.settled_at IS NULL
                                THEN COALESCE(m.bridged_at, $3::timestamptz) ELSE m.bridged_at END,
              updated_at = now()
         FROM prev
        WHERE m.id = prev.id
      RETURNING m.*, prev.state AS prev_state, prev.dialed_at AS prev_dialed_at,
                prev.answered_at AS prev_answered_at, prev.bridged_at AS prev_bridged_at`,
      [id, state, at],
    );
    const row = rows[0];
    if (!row) return null;
    const { prev_state, prev_dialed_at, prev_answered_at, prev_bridged_at, ...call } = row;
    const stateChanged = prev_state !== call.state;
    const stamped = (prev_dialed_at === null) !== (call.dialed_at === null)
      || (prev_answered_at === null) !== (call.answered_at === null)
      || (prev_bridged_at === null) !== (call.bridged_at === null);
    return { call, changed: stateChanged || stamped, stateChanged };
  }

  /**
   * Record the media leg's id (`agency_calls.id`) WITHOUT touching `state`, for the
   * reason the attempt's `attachWebrtcCall` gives: the id exists only once the dial
   * resolves, by which time lifecycle events may already have advanced the row.
   * First write wins: a call has one leg, and a different id is refused (false).
   */
  async attachWebrtcCall(id: string, webrtcCallId: string, deps: { client?: Db } = {}): Promise<boolean> {
    const { rowCount } = await (deps.client ?? getPool()).query(
      `UPDATE agency_manual_calls SET webrtc_call_id = $2::uuid, updated_at = now()
        WHERE id = $1 AND (webrtc_call_id IS NULL OR webrtc_call_id = $2::uuid)`,
      [id, webrtcCallId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * End the call (§4.1 step 6): `state = 'ended'`, `ended_at`, the classified
   * outcome, why it ended and the talk time. First end wins (`state <> 'ended'`):
   * a second terminal event writes nothing and gets null, so the caller re-reads
   * rather than double-settling.
   *
   * `unplaced` says the carrier never accepted the dial (the bridge refused it
   * before the carrier, the carrier refused it, or it was abandoned before either):
   * `dialed_at` is cleared, so it keeps exactly one meaning for every reader — the
   * usage counts' dials (SP5), the contact settlement's "placed" — "the carrier took
   * this dial". It is stamped by the `dialing` write just before the bridge is asked,
   * and only the dialer knows when that ask failed.
   *
   * Does NOT settle. An unanswered call with no outcome owed is then closed with
   * {@link settleWithoutDisposition} (and its contact with `settleFromManual`); a
   * bridged one waits for its outcome or the lapse.
   */
  async end(
    id: string,
    input: {
      outcome: AgencyManualCallOutcome | null;
      endReason: AgencyManualCallEndReason;
      talkSeconds: number | null;
      endedAt?: Date;
      unplaced?: boolean;
    },
    deps: { client?: Db } = {},
  ): Promise<AgencyManualCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyManualCallRecord>(
      `UPDATE agency_manual_calls
          SET state = 'ended',
              ended_at = COALESCE($2::timestamptz, now()),
              outcome = COALESCE($3, outcome),
              end_reason = $4,
              talk_seconds = $5,
              dialed_at = CASE WHEN $6::boolean THEN NULL ELSE dialed_at END,
              updated_at = now()
        WHERE id = $1 AND state <> 'ended'
      RETURNING *`,
      [id, input.endedAt ?? null, input.outcome, input.endReason, input.talkSeconds, input.unplaced === true],
    );
    return rows[0] ?? null;
  }

  /**
   * Replace the call details and/or the notes (`PATCH /calls/:id`), while the call
   * is live or awaiting its outcome (`settled_at IS NULL`). Last write wins; an
   * absent field is kept, `notes: ''` clears the notes. `fields` must already be
   * validated against the field set in force.
   *
   * @returns the row, or null when there is no such call or it is settled.
   */
  async updateDetails(
    id: string,
    patch: { fields?: AgencyCallFieldValues; notes?: string },
    deps: { client?: Db } = {},
  ): Promise<AgencyManualCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyManualCallRecord>(
      `UPDATE agency_manual_calls
          SET fields = COALESCE($2::jsonb, fields),
              notes = CASE WHEN $3::boolean THEN NULLIF($4::text, '') ELSE notes END,
              updated_at = now()
        WHERE id = $1 AND settled_at IS NULL
      RETURNING *`,
      [
        id,
        patch.fields === undefined ? null : JSON.stringify(patch.fields),
        patch.notes !== undefined,
        patch.notes ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * Save the outcome AND settle the call, in one guarded statement (§4.1 step 7).
   *
   * The attempt's `recordDisposition` discipline: `disposition_code IS NULL OR
   * disposition_code = $code` makes the first write and a same-code replay one
   * successful path (notes, callback and fields last-write-wins; `notes: null` keeps
   * the stored notes), and a different code a no-op — atomically, so two submissions
   * cannot interleave. On top of it, the call must have ENDED after it BRIDGED
   * (`dispositionRefusal`'s rule: `bridged_at` is the instant there was a
   * conversation), and a lapsed `no_disposition` call is never overwritten.
   *
   * `settled_at` is stamped by the first write and kept by a replay.
   * `disposition_source` must match the tag (`campaign` iff tagged; CHECKed).
   *
   * Run it on the transaction that then writes DNC (suppress codes, B8) and settles
   * the contact (`settleFromManual`) — ONLY when `replay` is false: a replay must not
   * settle the contact a second time.
   */
  async recordDisposition(
    input: {
      id: string;
      code: string;
      source: AgencyManualCallDispositionSource;
      notes: string | null;
      callbackAt: Date | null;
      /** Replaces the stored values when given; already validated (required fields filled). */
      fields?: AgencyCallFieldValues;
      actorUserId: string;
      onBehalf: boolean;
    },
    deps: { client?: Db } = {},
  ): Promise<
    | { ok: true; call: AgencyManualCallRecord; replay: boolean }
    | { ok: false; reason: AgencyManualCallDispositionRefusal; call: AgencyManualCallRecord | null }
  > {
    const db = deps.client ?? getPool();
    const { rows } = await db.query<AgencyManualCallRecord & { prev_code: string | null }>(
      `WITH prev AS (
         SELECT id, disposition_code FROM agency_manual_calls WHERE id = $1 FOR UPDATE
       )
       UPDATE agency_manual_calls m
          SET disposition_code = $2::varchar,
              disposition_source = $3,
              notes = COALESCE($4, m.notes),
              callback_at = $5,
              fields = COALESCE($6::jsonb, m.fields),
              dispositioned_by_user_id = $7,
              dispositioned_on_behalf = $8,
              dispositioned_at = now(),
              settled_at = COALESCE(m.settled_at, now()),
              updated_at = now()
         FROM prev
        WHERE m.id = prev.id
          AND m.state = 'ended'
          AND m.bridged_at IS NOT NULL
          AND m.disposition_code IS DISTINCT FROM '${AUTO_DISPOSITION_CODE}'
          AND ((m.disposition_code IS NULL AND m.settled_at IS NULL) OR m.disposition_code = $2::varchar)
      RETURNING m.*, prev.disposition_code AS prev_code`,
      [
        input.id, input.code, input.source, input.notes, input.callbackAt,
        input.fields === undefined ? null : JSON.stringify(input.fields),
        input.actorUserId, input.onBehalf,
      ],
    );
    const row = rows[0];
    if (row) {
      const { prev_code, ...call } = row;
      return { ok: true, call, replay: prev_code === input.code };
    }
    // The refusal path only: one more read to say why.
    const { rows: found } = await db.query<AgencyManualCallRecord>(
      'SELECT * FROM agency_manual_calls WHERE id = $1',
      [input.id],
    );
    const call = found[0] ?? null;
    if (!call) return { ok: false, reason: 'not_found', call: null };
    if (call.state !== 'ended') return { ok: false, reason: 'live', call };
    if (call.disposition_code === AUTO_DISPOSITION_CODE) return { ok: false, reason: 'lapsed', call };
    if (call.bridged_at === null) return { ok: false, reason: 'not_bridged', call };
    return { ok: false, reason: 'different_code', call };
  }

  /**
   * Settle an ended call that owes no outcome (§4.1 step 6): it never bridged. Only
   * `settled_at` is written; the outcome is the classifier's, from {@link end}.
   *
   * Refused (null) for a bridged call — that owes an outcome, and only the agent or
   * the lapse sweep closes it — and for a live, already-settled or missing one. Run
   * it on the transaction that settles the contact (`settleFromManual` with a null
   * decision), then release the Redis claim.
   */
  async settleWithoutDisposition(id: string, deps: { client?: Db } = {}): Promise<AgencyManualCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyManualCallRecord>(
      `UPDATE agency_manual_calls
          SET settled_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'ended' AND settled_at IS NULL
          AND bridged_at IS NULL AND disposition_code IS NULL
      RETURNING *`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * The lapse sweep (§4.1 step 8): close every ended, unsettled call whose outcome
   * did not come within `lapseMs` of `ended_at`, or whose session has LEFT. A call
   * that bridged (so owed an outcome) is stamped `no_disposition` with the source
   * its tag implies and no `dispositioned_by_user_id` (nobody recorded it — the
   * attempt's `recordAutoDisposition` rule); one that never bridged just settles.
   *
   * A call that never bridged owes NO outcome, so it is not given the 30 minutes: it
   * is closed once `unansweredGraceMs` has passed since it ended. The dialer settles
   * it the instant it ends (§4.1 step 6); this is the backstop for a settle that
   * failed, which otherwise left the session refusing every dial `outcome_pending`
   * for half an hour with no outcome pad to clear it. The grace only keeps this
   * sweep from racing the dialer's own settle on a call that ended a moment ago.
   *
   * **Releases nothing.** It returns the rows it closed; the caller settles each
   * one's contact claim (`contact_claimed` rows; `manual-settlement.ts`) and clears
   * its Redis `manual` field. A crash between the two leaves the contact `in_flight`
   * behind a settled call, which the stranded-contact sweep then requeues.
   *
   * The pick is a MATERIALIZED `FOR UPDATE SKIP LOCKED` CTE, run once, so two
   * overlapping sweeps cannot both close (and both release) one call, and an agent
   * saving the outcome concurrently either wins (the UPDATE's `settled_at IS NULL`
   * re-check) or waits for the row.
   */
  async lapseUnsettled(
    opts: { lapseMs?: number; unansweredGraceMs?: number; limit?: number } = {},
  ): Promise<AgencyManualCallRecord[]> {
    const { rows } = await getPool().query<AgencyManualCallRecord>(
      `WITH picked AS MATERIALIZED (
         SELECT m.id
           FROM agency_manual_calls m
           JOIN agency_agent_sessions s ON s.id = m.session_id
          WHERE m.settled_at IS NULL
            AND m.state = 'ended'
            AND (m.ended_at < now() - make_interval(secs => $1::double precision / 1000)
                 OR (m.bridged_at IS NULL
                     AND m.ended_at < now() - make_interval(secs => $3::double precision / 1000))
                 OR s.left_at IS NOT NULL)
          ORDER BY m.ended_at
            FOR UPDATE OF m SKIP LOCKED
          LIMIT $2
       )
       UPDATE agency_manual_calls m
          SET settled_at = now(),
              disposition_code = CASE WHEN m.bridged_at IS NOT NULL
                                      THEN '${AUTO_DISPOSITION_CODE}' ELSE m.disposition_code END,
              disposition_source = CASE WHEN m.bridged_at IS NULL THEN m.disposition_source
                                        WHEN m.campaign_id IS NULL THEN 'softphone'
                                        ELSE 'campaign' END,
              dispositioned_at = CASE WHEN m.bridged_at IS NOT NULL THEN now() ELSE m.dispositioned_at END,
              updated_at = now()
         FROM picked
        WHERE m.id = picked.id AND m.settled_at IS NULL AND m.state = 'ended'
      RETURNING m.*`,
      [opts.lapseMs ?? SOFTPHONE_OUTCOME_LAPSE_MS, opts.limit ?? 500, opts.unansweredGraceMs ?? MANUAL_UNANSWERED_SETTLE_GRACE_MS],
    );
    return rows;
  }

  /**
   * The orphan sweep (§4.1 step 10): end every non-terminal call that is NOT in
   * `liveIds` as `orphaned` (outcome and end reason). At startup the caller passes
   * the empty set (nothing can be live in a process that has just started); the
   * periodic sweep passes this process's live manual calls and a `createdBefore`
   * cutoff, so a call that is being placed right now is never reaped.
   *
   * A reaped call that never bridged is settled in the same statement (no outcome
   * owed, so nothing else would ever close it). One that BRIDGED is ended and left
   * awaiting its outcome: the agent talked to the customer, can still write it up
   * after reconnecting, and the lapse sweep closes it otherwise — so its contact
   * claim must be kept, not released.
   *
   * **Releases nothing.** For every returned row with `settled_at` set and
   * `contact_claimed`, the caller releases the claim (`releaseManualClaim`) and the
   * Redis `manual` field.
   */
  async reapOrphaned(input: {
    liveIds: readonly string[];
    createdBefore?: Date | null;
  }): Promise<AgencyManualCallRecord[]> {
    const { rows } = await getPool().query<AgencyManualCallRecord>(
      `UPDATE agency_manual_calls
          SET state = 'ended',
              outcome = 'orphaned',
              end_reason = 'orphaned',
              ended_at = now(),
              settled_at = CASE WHEN bridged_at IS NULL THEN now() ELSE NULL END,
              updated_at = now()
        WHERE state <> 'ended'
          AND NOT (id = ANY($1::uuid[]))
          AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
      RETURNING *`,
      [[...input.liveIds], input.createdBefore ?? null],
    );
    return rows;
  }

  /**
   * One call, scoped to the tenant and account (another tenant's or account's id is
   * a miss, i.e. a 404). A malformed id is a miss too, never a 22P02. The caller
   * checks the agent: an agent may read only their own calls.
   */
  async findById(
    id: string,
    scope: { tenantId: string; accountId: string },
    deps: { client?: Db } = {},
  ): Promise<AgencyManualCallRecord | null> {
    if (!isUuid(id)) return null;
    const { rows } = await (deps.client ?? getPool()).query<AgencyManualCallRecord>(
      'SELECT * FROM agency_manual_calls WHERE id = $1 AND tenant_id = $2 AND account_id = $3',
      [id, scope.tenantId, scope.accountId],
    );
    return rows[0] ?? null;
  }

  /**
   * One call as the wire row `AgencyManualCall` (`projectManualCallRow`): the tag's
   * name and the contact's current state joined; `agent_name` null (the public API
   * layer fills it). `withContext` adds the contact's `context`, for the live call
   * and the detail only; `prior_attempts` is the caller's to add.
   */
  async findWireById(
    id: string,
    scope: { tenantId: string; accountId: string },
    opts: { withContext?: boolean } = {},
  ): Promise<AgencyManualCall | null> {
    if (!isUuid(id)) return null;
    const { rows } = await getPool().query<AgencyManualCallJoinedRow>(
      `SELECT ${WIRE_SELECT_SQL}${opts.withContext ? ', ct.context AS contact_context' : ''}
         FROM ${WIRE_FROM_SQL}
        WHERE m.id = $1 AND m.tenant_id = $2 AND m.account_id = $3`,
      [id, scope.tenantId, scope.accountId],
    );
    const row = rows[0];
    return row ? projectManualCallRow(row, opts) : null;
  }

  /**
   * The session's one unsettled call — live, or ended and awaiting its outcome —
   * if any (`uq_agency_manual_call_unsettled` permits at most one). Bootstrap's
   * `call`, the reconnect's reattach, and the `manual_call_live` / `outcome_pending`
   * refusals read it.
   */
  async findUnsettledForSession(sessionId: string, deps: { client?: Db } = {}): Promise<AgencyManualCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyManualCallRecord>(
      'SELECT * FROM agency_manual_calls WHERE session_id = $1 AND settled_at IS NULL',
      [sessionId],
    );
    return rows[0] ?? null;
  }

  /**
   * One agent's calls ("My calls"), newest first, keyset on `(created_at DESC, id
   * DESC)` over `idx_agency_manual_calls_agent`. Scoped to the tenant and account
   * on the row itself; `filters.agentUserId` is ignored (the agent is the argument).
   */
  async listForAgent(input: {
    tenantId: string;
    accountId: string;
    agentUserId: string;
    filters: Omit<AgencyManualCallListFilters, 'agentUserId'>;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyManualCallListRow>> {
    return this.listPage({ ...input, filters: { ...input.filters, agentUserId: input.agentUserId } });
  }

  /**
   * The account's calls (`agency.supervise`), newest first, keyset on `(created_at
   * DESC, id DESC)` over `idx_agency_manual_calls_account`, with the
   * {@link AgencyManualCallListFilters}. Rows carry no contact `context`.
   */
  async listForAccount(input: {
    tenantId: string;
    accountId: string;
    filters: AgencyManualCallListFilters;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyManualCallListRow>> {
    return this.listPage(input);
  }

  private async listPage(input: {
    tenantId: string;
    accountId: string;
    filters: AgencyManualCallListFilters;
    after?: AgencyKeysetPosition | undefined;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyManualCallListRow>> {
    const bind = params();
    const f = input.filters;
    const conditions = [
      `m.tenant_id = ${bind.add(input.tenantId)}::uuid`,
      `m.account_id = ${bind.add(input.accountId)}::uuid`,
    ];
    if (f.agentUserId) conditions.push(`m.agent_user_id = ${bind.add(f.agentUserId)}::uuid`);
    if (f.campaign === 'untagged') conditions.push('m.campaign_id IS NULL');
    else if (f.campaign) conditions.push(`m.campaign_id = ${bind.add(f.campaign.campaignId)}::uuid`);
    if (f.status === 'live') conditions.push("m.state <> 'ended'");
    else if (f.status === 'awaiting_outcome') conditions.push("m.state = 'ended' AND m.settled_at IS NULL");
    else if (f.status === 'settled') conditions.push('m.settled_at IS NOT NULL');
    if (f.outcome) conditions.push(`m.outcome = ${bind.add(f.outcome)}::varchar`);
    if (f.dispositionCode) conditions.push(`m.disposition_code = ${bind.add(f.dispositionCode)}::varchar`);
    if (f.phoneDigits !== undefined) {
      // Re-stripped here, as `phoneCondition` does: the only place a `%` or `_`
      // could become a LIKE wildcard. A digit-less term matches nothing.
      const digits = f.phoneDigits.replace(/\D/g, '');
      conditions.push(digits.length === 0
        ? 'FALSE'
        : `m.destination_e164 LIKE '%' || ${bind.add(digits)}::text`);
    }
    if (f.from) conditions.push(`m.created_at >= ${bind.add(f.from)}::timestamptz`);
    if (f.to) conditions.push(`m.created_at < ${bind.add(f.to)}::timestamptz`);
    if (input.after) conditions.push(keysetCondition(input.after, 'm', bind));

    // The media leg's summary status rides on each row (the list's Summary column): a
    // LEFT JOIN on the row's own `webrtc_call_id`, bound to the same tenant and account,
    // so a purged leg (no FK, independent retention) reads as NULL and never drops the row.
    const { rows } = await getPool().query<
      AgencyManualCallJoinedRow & { cursor_at: string; analysis_status: string | null }
    >(
      `SELECT ${WIRE_SELECT_SQL}, ac.analysis_status AS analysis_status,
              ${keysetAtSql('m.created_at')} AS cursor_at
         FROM ${WIRE_FROM_SQL}
         LEFT JOIN agency_calls ac
           ON ac.id = m.webrtc_call_id AND ac.tenant_id = m.tenant_id AND ac.account_id = m.account_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${bind.add(input.limit + 1)}`,
      bind.values,
    );
    return toKeysetPage(rows, input.limit, (row) => ({
      ...projectManualCallRow(row),
      analysis_status: row.analysis_status ?? null,
    }));
  }
}

export const agencyManualCallRepository = new AgencyManualCallRepository();
