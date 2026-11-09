/**
 * `AgencyInboundCallRepository`: the inbound spine, `agency_inbound_calls` (`0024_inbound.sql`;
 * docs/inbound.md §3, §7, §9, §10), and its media leg's insert. A row is one call that reached
 * the answer webhook; a row with `follow_up_status` is also its Missed inbound row.
 *
 * ── The lifecycle ──────────────────────────────────────────────────────────────
 * `arrived → greeting → queued ⇄ offered → connected → ended` ({@link INBOUND_CALL_TRANSITIONS}).
 * `offered → queued` is a move back: a station lost before audio binds puts the caller at the
 * head of the queue again (§5.1). `greeting → arrived` is the other ({@link
 * AgencyInboundCallRepository.refuseAdmission}): an admission taken back, so `arrived` reads
 * "not admitted" and a refused call ends straight from it. Every transition is one guarded UPDATE whose `WHERE`
 * names the states it may leave, so two writers racing on one call cannot both move it, and
 * **an `ended` row never moves again**: no move leaves `ended`, and
 * {@link AgencyInboundCallRepository.end} and the sweep only end a row that is not.
 * `bridged_at` and `answered_by_user_id` are stamped by the move to `connected`, never
 * overwritten.
 *
 * ── The agent side (P2, `0027_inbound_connect.sql`, docs/inbound.md §2, §6) ──────
 * {@link AgencyInboundCallRepository.transition} makes the arrival-side moves (`greeting`,
 * `queued`); the agent-side ones carry the session and are guarded on it:
 * {@link AgencyInboundCallRepository.offer} (`session_id`, `offered_at`, `offer_count`),
 * {@link AgencyInboundCallRepository.requeue} (back to `queued`, the session cleared, `queued_at`
 * kept) and {@link AgencyInboundCallRepository.connect} (`bridged_at`, the agent). A session holds
 * one unsettled call (`uq_agency_inbound_calls_session_unsettled`). `settled_at` says nothing more
 * is owed: an unbridged call settles in the UPDATE that ends it; a bridged one when its outcome is
 * saved ({@link AgencyInboundCallRepository.saveDisposition}) or lapses
 * ({@link AgencyInboundCallRepository.lapseUnsettled}), never on the end itself or by the sweep.
 *
 * ── Who owns what ──────────────────────────────────────────────────────────────
 * This file writes the spine row and, at arrival, its `agency_calls` leg. The contact's inbound
 * callback (`agency_contacts.callback_source`) is the contact path's write, composed with
 * {@link AgencyInboundCallRepository.end} on one transaction client (`deps.client`); the bridge
 * session, Plivo XML, metrics and audit are the caller's.
 *
 * Every id is bound as a parameter and cast once; callers validate ids at the edge (`22P02`).
 */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type {
  AgencyInboundCallOutcome,
  AgencyInboundCallState,
  AgencyInboundClosedCause,
  AgencyInboundFollowUpStatus,
  AgencyInboundHandledReason,
  AgencyInboundMissedReason,
  AgencyInboundStickyReason,
  AgencyKeysetPage,
} from '@magick-agency/contracts/agency';
import {
  AGENCY_INBOUND_OUTCOME_LAPSE_MS,
  type AgencyInboundDispositionSource,
} from '@magick-agency/contracts/agency';
import { AGENCY_INBOUND_MISSED_COUNT_CAP } from '@magick-agency/contracts/api/agency/inbound';
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import { AUTO_DISPOSITION_CODE } from '../../../agency/disposition.js';
import { INBOUND_DEFAULT_WRAPUP, type InboundWrapupRule } from '../../../agency/inbound/inbound-wrapup.js';
import { keysetCondition, params, toKeysetPage } from './query-builders.js';
import { inboundFromDigitsSql, inboundNumberBusySql } from './sql-fragments.js';

type Db = Pick<PoolClient, 'query'>;

/**
 * The moves {@link AgencyInboundCallRepository.transition} makes, by target state: the states
 * each may be reached from. `ended` is not here: it is {@link AgencyInboundCallRepository.end}'s.
 * `arrived` means "not admitted": never yet, or refused. It is re-entered only by
 * {@link AgencyInboundCallRepository.refuseAdmission} (`greeting → arrived`, a call the bridge's
 * shared scopes turned away), and a refused call ends straight from `arrived` (the route's cap
 * and that refusal both): `arrived` is not "about to be admitted".
 */
export const INBOUND_CALL_TRANSITIONS = Object.freeze({
  greeting: ['arrived'],
  queued: ['arrived', 'greeting', 'offered'],
  offered: ['arrived', 'greeting', 'queued'],
  connected: ['offered'],
} as const satisfies Record<Exclude<AgencyInboundCallState, 'arrived' | 'ended'>, readonly AgencyInboundCallState[]>);

export type AgencyInboundTransitionTarget = keyof typeof INBOUND_CALL_TRANSITIONS;

/**
 * The moves {@link AgencyInboundCallRepository.transition} makes: the arrival side's. `offered`,
 * the move back to `queued` from it, and `connected` carry the agent's session and are
 * {@link AgencyInboundCallRepository.offer}, {@link AgencyInboundCallRepository.requeue} and
 * {@link AgencyInboundCallRepository.connect}.
 */
export type AgencyInboundArrivalTransition = Extract<AgencyInboundTransitionTarget, 'greeting' | 'queued'>;

/** Why {@link AgencyInboundCallRepository.offer} refused. */
export type AgencyInboundOfferRefusal =
  /** No such call, or not in a state an offer leaves (it ended, or is offered or connected already). */
  | 'not_offerable'
  /** The session already holds an unsettled inbound call (`uq_agency_inbound_calls_session_unsettled`). */
  | 'session_busy';

/** Why {@link AgencyInboundCallRepository.saveDisposition} refused (the soft phone's reasons). */
export type AgencyInboundDispositionRefusal =
  /** No such call. */
  | 'not_found'
  /** The call has not ended. */
  | 'live'
  /** The call ended without reaching an agent: no conversation, no outcome. */
  | 'not_bridged'
  /** Another code is already saved. */
  | 'different_code'
  /** The lapse sweep closed it `no_disposition`. */
  | 'lapsed';

/** An `agency_inbound_calls` row. */
export interface AgencyInboundCallRecord {
  id: string;
  tenant_id: string;
  account_id: string | null;
  route_id: string | null;
  phone_number_id: string | null;
  provider: string;
  telephony_credential_id: string | null;
  provider_call_id: string;
  from_e164: string | null;
  to_e164: string;
  matched_contact_id: string | null;
  matched_campaign_id: string | null;
  caller_dnc: boolean;
  sticky_user_id: string | null;
  sticky_reason: AgencyInboundStickyReason | null;
  state: AgencyInboundCallState;
  outcome: AgencyInboundCallOutcome | null;
  arrived_at: Date;
  answered_at: Date | null;
  bridged_at: Date | null;
  answered_by_user_id: string | null;
  ended_at: Date | null;
  talk_seconds: number | null;
  webrtc_call_id: string | null;
  voicemail_key: string | null;
  callback_due_at: Date | null;
  follow_up_status: AgencyInboundFollowUpStatus | null;
  follow_up_reason: AgencyInboundMissedReason | null;
  follow_up_assignee_user_id: string | null;
  handled_by_user_id: string | null;
  handled_at: Date | null;
  // P2 (0027): the agent side.
  /** The agent session it is offered to or connected with; null while not with one (cleared by a requeue). */
  session_id: string | null;
  /** The first time it queued (the queue's maximum wait counts from it). */
  queued_at: Date | null;
  /** The latest offer. */
  offered_at: Date | null;
  offer_count: number;
  /** The leg's `recording_requested`, mirrored at arrival. */
  recording_requested: boolean;
  disposition_code: string | null;
  disposition_source: AgencyInboundDispositionSource | null;
  notes: string | null;
  callback_at: Date | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: Date | null;
  dispositioned_on_behalf: boolean;
  /** Nothing more is owed: set as an unbridged call ends, or when a bridged one's outcome is saved or lapses. */
  settled_at: Date | null;
  voicemail_seconds: number | null;
  /** The ringing outbound attempt this call cancelled (§5.4). */
  clash_attempt_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Who the caller is, as far as the ANI lookup got (§4.1). Every field optional on a later update. */
export interface AgencyInboundIdentification {
  /** The roster contact and its campaign, together (CHECKed); null: unmatched. */
  match: { contactId: string; campaignId: string } | null;
  callerDnc: boolean;
  /** The sticky agent and the signal that named them, together (CHECKed); null: none. */
  sticky: { userId: string; reason: AgencyInboundStickyReason } | null;
}

/** Everything the answer webhook fixes on the row at arrival (§3). Every field is required, deliberately. */
export interface AgencyInboundArrivalInput {
  tenantId: string;
  /** §8.3: the matched contact's account, else the route's; null: the tenant default (no leg). */
  accountId: string | null;
  routeId: string | null;
  phoneNumberId: string | null;
  provider: string;
  telephonyCredentialId: string | null;
  providerCallId: string;
  /** Normalised E.164 (`plivoNumberToE164`); null: withheld. */
  fromE164: string | null;
  toE164: string;
  identification: AgencyInboundIdentification;
  /** True when our answer XML answers the call (the leg is created live); false for a call refused with a hangup. */
  answered: boolean;
  /** Fixed at intake on the leg, as on every leg (the route's `record_calls` and profile). */
  recordingRequested: boolean;
  analysisProfileId: string | null;
  /**
   * Why the answer treats the caller as closed (`closed_cause`, 0030): the inbound summary counts
   * the causes apart. Absent or null: the route is open for them. Optional only so the many test
   * callers that write an open call need not name it; the router always says.
   */
  closedCause?: AgencyInboundClosedCause | null;
}

/** How a call ends ({@link AgencyInboundCallRepository.end}). */
export interface AgencyInboundEndInput {
  outcome: AgencyInboundCallOutcome;
  /** Talk time from the bridge; null when nobody was bridged. */
  talkSeconds: number | null;
  /**
   * The Missed inbound row, for a call that reached nobody (§7): its reason and assignee (the
   * sticky agent, else null for the account). Null for an answered or rejected call.
   */
  followUp: { reason: AgencyInboundMissedReason; assigneeUserId: string | null } | null;
  /** The due time of the callback the caller booked on the matched contact in the same transaction, if any. */
  callbackDueAt: Date | null;
  voicemailKey: string | null;
  /** The voicemail's length (P2); only with `voicemailKey` (CHECKed). Absent: none. */
  voicemailSeconds?: number | null;
  endedAt?: Date;
}

/** An outcome to save ({@link AgencyInboundCallRepository.saveDisposition}), already validated against its catalog. */
export interface AgencyInboundDispositionInput {
  id: string;
  code: string;
  /** `campaign` exactly when the call matched a campaign (CHECKed). */
  source: AgencyInboundDispositionSource;
  /** Null keeps the stored notes. */
  notes: string | null;
  callbackAt: Date | null;
  actorUserId: string;
  onBehalf: boolean;
}

/** The filters of the Missed list, already parsed and validated by the API layer. */
export interface AgencyInboundMissedListInput {
  tenantId: string;
  /** null: the tenant default's rows (no account), never every account's. */
  accountId: string | null;
  status: AgencyInboundFollowUpStatus;
  /** One assignee's rows, or the unassigned ones; absent: everyone's. */
  assignee?: { userId: string } | 'unassigned';
  /** One reason's rows (`follow_up_reason`); absent: every reason. */
  reason?: AgencyInboundMissedReason;
  /** Bounds on `arrived_at`: inclusive start, exclusive end. */
  from?: Date;
  to?: Date;
  after?: AgencyKeysetPosition;
  limit: number;
}

/** A Missed list row: the spine row and the names the read joins in (route, matched campaign). */
export interface AgencyInboundMissedRow extends AgencyInboundCallRecord {
  route_name: string | null;
  matched_campaign_name: string | null;
  /**
   * How it was handled (0028): `marked` by a person, or `reached` (the customer was put through to
   * an agent afterwards: `agency_inbound_close_reached_missed`). NULL while open, and on a row
   * handled before 0028, which a person marked.
   */
  handled_reason: AgencyInboundHandledReason | null;
  /** Why the answer treated the caller as closed (0030); NULL when the route was open for them. */
  closed_cause: AgencyInboundClosedCause | null;
}

/** {@link AgencyInboundCallRepository.reassignMissed}'s answer. */
export type AgencyInboundReassignResult =
  /** The row is open and now assigned as asked (`changed: false`: it already was). */
  | { outcome: 'assigned'; changed: boolean; previousAssigneeUserId: string | null; call: AgencyInboundMissedRow }
  /** The row is handled: a follow-up that is done is not handed to anyone. */
  | { outcome: 'handled'; call: AgencyInboundMissedRow };


const CALL_COLUMNS = `c.id, c.tenant_id, c.account_id, c.route_id, c.phone_number_id, c.provider, c.telephony_credential_id,
  c.provider_call_id, c.from_e164, c.to_e164, c.matched_contact_id, c.matched_campaign_id, c.caller_dnc,
  c.sticky_user_id, c.sticky_reason, c.state, c.outcome, c.arrived_at, c.answered_at, c.bridged_at,
  c.answered_by_user_id, c.ended_at, c.talk_seconds, c.webrtc_call_id, c.voicemail_key, c.callback_due_at,
  c.follow_up_status, c.follow_up_reason, c.follow_up_assignee_user_id, c.handled_by_user_id, c.handled_at,
  c.session_id, c.queued_at, c.offered_at, c.offer_count, c.recording_requested, c.disposition_code,
  c.disposition_source, c.notes, c.callback_at, c.dispositioned_by_user_id, c.dispositioned_at,
  c.dispositioned_on_behalf, c.settled_at, c.voicemail_seconds, c.clash_attempt_id,
  c.created_at, c.updated_at`;

/** A row's Missed-list joins: the route's name and the matched campaign's. Both LEFT, no FK. */
const MISSED_FROM_SQL = `agency_inbound_calls c
        LEFT JOIN agency_inbound_routes r ON r.id = c.route_id
        LEFT JOIN agency_campaigns cam ON cam.id = c.matched_campaign_id`;
const MISSED_SELECT_SQL = `${CALL_COLUMNS}, c.handled_reason, c.closed_cause, r.name AS route_name, cam.name AS matched_campaign_name`;

export class AgencyInboundCallRepository {
  /**
   * Record an arrival: the spine row, and (with an account) its `agency_calls` leg
   * (`origin = 'inbound'`, `inbound_call_id` the spine row, `caller_id` the number rung,
   * `destination_phone` the caller's or `''` when withheld, `provider_call_id` the carrier's call
   * id so the status webhook finds it), linked both ways, in one transaction (or the caller's).
   * The leg is written here rather than through `WebRtcCallRepository.create`, which refuses a
   * credential that is not `active`: a call that has already arrived is answered regardless
   * (§10, "a disabled or invalid credential that still verifies").
   *
   * **Idempotent on the carrier's call id.** A retried answer webhook (`uq_agency_inbound_calls_
   * provider_call`, `ON CONFLICT DO NOTHING`) writes nothing and answers the row it wrote the
   * first time, with `created: false`, so the caller answers the retry the same way.
   *
   * **Only the caller's own row.** The carrier's call id is unique per provider, not per
   * credential, and the conflicting row is answered only when it is this tenant's AND arrived on
   * this credential: one belonging to another tenant or credential is `foreign` (nothing written,
   * nothing of the other row returned). A real `CallUUID` names one call on one carrier account,
   * so a foreign conflict is a forged or replayed id on a credential that verified it, and the
   * caller refuses it: no call on tenant X's credential ever reads or ends tenant Y's row.
   */
  async insertArrival(
    input: AgencyInboundArrivalInput,
    deps: { client?: PoolClient } = {},
  ): Promise<{ created: boolean; call: AgencyInboundCallRecord } | { created: false; call: null; foreign: true }> {
    return withTransaction(async (client) => {
      const id = input.identification;
      const { rows } = await client.query<AgencyInboundCallRecord>(
        `INSERT INTO agency_inbound_calls AS c
           (tenant_id, account_id, route_id, phone_number_id, provider, telephony_credential_id, provider_call_id,
            from_e164, to_e164, matched_contact_id, matched_campaign_id, caller_dnc, sticky_user_id, sticky_reason,
            answered_at, recording_requested, closed_cause)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::varchar, $6::uuid, $7::varchar,
                 $8::varchar, $9::varchar, $10::uuid, $11::uuid, $12::boolean, $13::uuid, $14::varchar,
                 CASE WHEN $15::boolean THEN now() END, $16::boolean, $17::varchar)
         ON CONFLICT (provider, provider_call_id) DO NOTHING
         RETURNING ${CALL_COLUMNS}`,
        [
          input.tenantId, input.accountId, input.routeId, input.phoneNumberId, input.provider, input.telephonyCredentialId,
          input.providerCallId, input.fromE164, input.toE164, id.match?.contactId ?? null, id.match?.campaignId ?? null,
          id.callerDnc, id.sticky?.userId ?? null, id.sticky?.reason ?? null, input.answered,
          input.recordingRequested, input.closedCause ?? null,
        ],
      );
      const inserted = rows[0];
      if (!inserted) {
        const existing = await this.findByProviderCallId(input.provider, input.providerCallId, client);
        if (!existing || existing.tenant_id !== input.tenantId || existing.telephony_credential_id !== input.telephonyCredentialId) {
          return { created: false, call: null, foreign: true } as const;
        }
        return { created: false, call: existing };
      }
      if (input.accountId === null) return { created: true, call: inserted };
      const leg = await client.query<{ id: string }>(
        `INSERT INTO agency_calls
           (tenant_id, account_id, caller_id, destination_phone, provider, provider_call_id, telephony_credential_id,
            status, answered_at, recording_requested, analysis_profile_id, origin, inbound_call_id)
         VALUES ($1::uuid, $2::uuid, $3::varchar, $4::varchar, $5::varchar, $6::varchar, $7::uuid,
                 CASE WHEN $8::boolean THEN 'in_progress' ELSE 'initiating' END, $9::timestamptz,
                 $10::boolean, $11::uuid, 'inbound', $12::uuid)
         RETURNING id`,
        [
          input.tenantId, input.accountId, input.toE164, input.fromE164 ?? '', input.provider, input.providerCallId,
          input.telephonyCredentialId, input.answered, inserted.answered_at, input.recordingRequested,
          input.analysisProfileId, inserted.id,
        ],
      );
      const { rows: linked } = await client.query<AgencyInboundCallRecord>(
        `UPDATE agency_inbound_calls c SET webrtc_call_id = $2::uuid WHERE c.id = $1::uuid RETURNING ${CALL_COLUMNS}`,
        [inserted.id, leg.rows[0]!.id],
      );
      return { created: true, call: linked[0]! };
    }, { pool: getPool(), client: deps.client });
  }

  /**
   * Record who the caller is (§4.1), on a call that has not ended. Fields left out are kept.
   * Null when the call is ended or missing: the identification arrived too late to matter.
   */
  async setIdentification(
    id: string,
    identification: Partial<AgencyInboundIdentification>,
    deps: { client?: Db } = {},
  ): Promise<AgencyInboundCallRecord | null> {
    const has = (k: keyof AgencyInboundIdentification) => identification[k] !== undefined;
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundCallRecord>(
      `UPDATE agency_inbound_calls c
          SET matched_contact_id = CASE WHEN $2::boolean THEN $3::uuid ELSE c.matched_contact_id END,
              matched_campaign_id = CASE WHEN $2::boolean THEN $4::uuid ELSE c.matched_campaign_id END,
              caller_dnc = CASE WHEN $5::boolean THEN $6::boolean ELSE c.caller_dnc END,
              sticky_user_id = CASE WHEN $7::boolean THEN $8::uuid ELSE c.sticky_user_id END,
              sticky_reason = CASE WHEN $7::boolean THEN $9::varchar ELSE c.sticky_reason END
        WHERE c.id = $1::uuid AND c.state <> 'ended'
        RETURNING ${CALL_COLUMNS}`,
      [
        id,
        has('match'), identification.match?.contactId ?? null, identification.match?.campaignId ?? null,
        has('callerDnc'), identification.callerDnc ?? false,
        has('sticky'), identification.sticky?.userId ?? null, identification.sticky?.reason ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * An arrival-side move: to `greeting` (from `arrived`), or to `queued` from `arrived` or
   * `greeting`, stamping `queued_at` the first time. The move back to `queued` from `offered` is
   * {@link requeue} (it carries the session). Null when the call is missing or in a state the move
   * does not leave (an ended call, or one already further on); the caller re-reads to tell which.
   */
  async transition(
    id: string,
    to: AgencyInboundArrivalTransition,
    opts: { at?: Date } = {},
    deps: { client?: Db } = {},
  ): Promise<AgencyInboundCallRecord | null> {
    const from = INBOUND_CALL_TRANSITIONS[to].filter((state) => state !== 'offered');
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundCallRecord>(
      `UPDATE agency_inbound_calls c
          SET state = $2::varchar,
              queued_at = CASE WHEN $2::varchar = 'queued' THEN COALESCE(c.queued_at, $4::timestamptz) ELSE c.queued_at END
        WHERE c.id = $1::uuid AND c.state = ANY($3::varchar[])
        RETURNING ${CALL_COLUMNS}`,
      [id, to, from, opts.at ?? new Date()],
    );
    return rows[0] ?? null;
  }

  /**
   * Offer the call to agent session `sessionId` (§2 step 5): `queued` → `offered` (also from
   * `arrived` / `greeting`, a connect with nobody waiting ahead), with `session_id`, `offered_at`
   * and `offer_count + 1`. Run it AFTER the agent's Redis reservation
   * (`AgentStateMachine.reserveForInbound`) and release that reservation when this refuses:
   *  - `not_offerable`: the call ended (the caller hung up), is gone, or is with an agent already;
   *  - `session_busy`: the session holds another unsettled inbound call
   *    (`uq_agency_inbound_calls_session_unsettled`). Checked in the same statement; a concurrent
   *    offer to the same session that slips past the check meets the unique index, whose 23505 is
   *    answered the same way. Outside a caller's transaction only: inside one, that error aborts
   *    the caller's transaction, so pass `client` only where the Redis reservation already makes
   *    the race impossible.
   */
  async offer(
    id: string,
    sessionId: string,
    opts: { at?: Date } = {},
    deps: { client?: Db } = {},
  ): Promise<{ ok: true; call: AgencyInboundCallRecord } | { ok: false; reason: AgencyInboundOfferRefusal }> {
    const db = deps.client ?? getPool();
    let rows: AgencyInboundCallRecord[];
    try {
      ({ rows } = await db.query<AgencyInboundCallRecord>(
        `UPDATE agency_inbound_calls c
            SET state = 'offered', session_id = $2::uuid, offered_at = $4::timestamptz, offer_count = c.offer_count + 1
          WHERE c.id = $1::uuid AND c.state = ANY($3::varchar[])
            AND NOT EXISTS (
              SELECT 1 FROM agency_inbound_calls o
               WHERE o.session_id = $2::uuid AND o.settled_at IS NULL AND o.id <> $1::uuid)
          RETURNING ${CALL_COLUMNS}`,
        [id, sessionId, INBOUND_CALL_TRANSITIONS.offered, opts.at ?? new Date()],
      ));
    } catch (err) {
      if (isUniqueViolation(err, SESSION_UNSETTLED_INDEX)) return { ok: false, reason: 'session_busy' };
      throw err;
    }
    if (rows[0]) return { ok: true, call: rows[0] };
    const { rows: busy } = await db.query<{ busy: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agency_inbound_calls o
          WHERE o.session_id = $2::uuid AND o.settled_at IS NULL AND o.id <> $1::uuid) AS busy`,
      [id, sessionId],
    );
    return { ok: false, reason: busy[0]?.busy ? 'session_busy' : 'not_offerable' };
  }

  /**
   * The station was lost before audio bound (§5.1, §2 "The agent's station drops"): `offered` →
   * `queued`, the session cleared, `queued_at` kept (stamped now if it was offered straight from
   * the greeting), so the queue's maximum wait still counts from the first queueing. Only while it
   * is offered to `sessionId`: a stale requeue for a session the call has since left does nothing.
   * Null when nothing moved.
   */
  async requeue(
    id: string,
    sessionId: string,
    opts: { at?: Date } = {},
    deps: { client?: Db } = {},
  ): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundCallRecord>(
      `UPDATE agency_inbound_calls c
          SET state = 'queued', session_id = NULL, queued_at = COALESCE(c.queued_at, $3::timestamptz)
        WHERE c.id = $1::uuid AND c.state = 'offered' AND c.session_id = $2::uuid
        RETURNING ${CALL_COLUMNS}`,
      [id, sessionId, opts.at ?? new Date()],
    );
    return rows[0] ?? null;
  }

  /**
   * Audio bound (§2 step 6): `offered` → `connected`, stamping `bridged_at` and the agent who took
   * it (first stamp wins). Only while it is offered to `sessionId`. Null when nothing moved (it
   * ended, was requeued, or is another session's).
   */
  async connect(
    id: string,
    input: { sessionId: string; answeredByUserId: string; at?: Date },
    deps: { client?: Db } = {},
  ): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundCallRecord>(
      `UPDATE agency_inbound_calls c
          SET state = 'connected',
              bridged_at = COALESCE(c.bridged_at, $3::timestamptz),
              answered_by_user_id = COALESCE(c.answered_by_user_id, $4::uuid)
        WHERE c.id = $1::uuid AND c.state = ANY($5::varchar[]) AND c.session_id = $2::uuid
        RETURNING ${CALL_COLUMNS}`,
      [id, input.sessionId, input.at ?? new Date(), input.answeredByUserId, INBOUND_CALL_TRANSITIONS.connected],
    );
    return rows[0] ?? null;
  }

  /**
   * Take back an admission (`greeting → arrived`): a call its route admitted that the bridge's
   * shared scopes then turned away (the global or carrier scope full, IB5's `no_capacity`) holds
   * no line of ours, so it leaves the route's admitted count and the account's live total, which
   * both read `arrived` as "not admitted". The one move back to `arrived`, and only from
   * `greeting` (the state admission leaves it in), so it never undoes a call further on. Null when
   * the call is missing or not in `greeting`.
   *
   * The recording the arrival asked for is taken back with it, on the spine and its media leg
   * (`recording_requested = false`): the caller hears "busy" and nobody is connected, so nothing
   * records the call, and a flag left set would read as a recording asked for and missing.
   */
  async refuseAdmission(id: string, deps: { client?: Db } = {}): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundCallRecord>(
      `WITH refused AS (
         UPDATE agency_inbound_calls c SET state = 'arrived', recording_requested = false
          WHERE c.id = $1::uuid AND c.state = 'greeting'
          RETURNING ${CALL_COLUMNS}
       ), leg AS (
         UPDATE agency_calls l SET recording_requested = false
           FROM refused r
          WHERE l.id = r.webrtc_call_id AND l.recording_requested
       )
       SELECT * FROM refused`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * End the call: `ended`, its outcome and `ended_at`, talk time, the voicemail, and for a call
   * that reached nobody its Missed row (`open`) and the callback it booked. Only a call that has
   * not ended: **a terminal row never moves**, so a hangup webhook racing the sweep, or a retried
   * one, ends it once (`ended: false` with the row as the first writer left it; null when
   * missing). The CHECKs refuse a contradiction (`answered` without a bridge, a follow-up on an
   * answered call) rather than this method coercing it.
   *
   * A call that was never bridged is settled as it ends (`settled_at = ended_at`: nobody spoke to
   * the caller, so no outcome is owed, and the session it was offered to is free again). A bridged
   * one stays unsettled: its outcome is owed ({@link saveDisposition}, {@link lapseUnsettled}).
   */
  async end(
    id: string,
    input: AgencyInboundEndInput,
    deps: { client?: Db } = {},
  ): Promise<{ ended: true; call: AgencyInboundCallRecord } | { ended: false; call: AgencyInboundCallRecord | null }> {
    const db = deps.client ?? getPool();
    const { rows } = await db.query<AgencyInboundCallRecord>(
      `UPDATE agency_inbound_calls c
          SET state = 'ended', outcome = $2::varchar, ended_at = $3::timestamptz, talk_seconds = $4::int,
              follow_up_status = CASE WHEN $5::varchar IS NULL THEN NULL ELSE 'open' END,
              follow_up_reason = $5::varchar, follow_up_assignee_user_id = $6::uuid,
              callback_due_at = $7::timestamptz, voicemail_key = $8::text, voicemail_seconds = $9::int,
              settled_at = CASE WHEN c.bridged_at IS NULL THEN $3::timestamptz END
        WHERE c.id = $1::uuid AND c.state <> 'ended'
        RETURNING ${CALL_COLUMNS}`,
      [
        id, input.outcome, input.endedAt ?? new Date(), input.talkSeconds,
        input.followUp?.reason ?? null, input.followUp?.assigneeUserId ?? null,
        input.callbackDueAt, input.voicemailKey, input.voicemailSeconds ?? null,
      ],
    );
    if (rows[0]) return { ended: true, call: rows[0] };
    return { ended: false, call: await this.findByIdAnyTenant(id, db) };
  }

  /**
   * Record the ringing outbound attempt this call superseded (the in-flight clash, §5.4), once
   * the attempt was cancelled for it: first write wins. False when the call is missing or already
   * names one.
   */
  async setClashAttempt(id: string, attemptId: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      `UPDATE agency_inbound_calls SET clash_attempt_id = $2::uuid
        WHERE id = $1::uuid AND clash_attempt_id IS NULL`,
      [id, attemptId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Whether a call on `credentialId` that arrived before `before` has not ended (a Re-point's
   * check that the token it would drop is no longer needed). Over `idx_agency_inbound_calls_open`
   * (0024: `arrived_at`, live rows only).
   */
  async anyLiveArrivedBefore(credentialId: string, before: Date, db: Db = getPool()): Promise<boolean> {
    const { rows } = await db.query<{ live: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agency_inbound_calls c
          WHERE c.state <> 'ended' AND c.arrived_at < $2::timestamptz AND c.telephony_credential_id = $1::uuid
       ) AS live`,
      [credentialId, before],
    );
    return rows[0]?.live === true;
  }

  /** The call with the carrier's call id (the status webhook's `CallUUID`), or null. */
  async findByProviderCallId(provider: string, providerCallId: string, db: Db = getPool()): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await db.query<AgencyInboundCallRecord>(
      `SELECT ${CALL_COLUMNS} FROM agency_inbound_calls c WHERE c.provider = $1::varchar AND c.provider_call_id = $2::varchar`,
      [provider, providerCallId],
    );
    return rows[0] ?? null;
  }

  /** One call of the tenant, or null. */
  async findById(tenantId: string, id: string): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await getPool().query<AgencyInboundCallRecord>(
      `SELECT ${CALL_COLUMNS} FROM agency_inbound_calls c WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid`,
      [id, tenantId],
    );
    return rows[0] ?? null;
  }

  /** One call by id alone, for the paths that hold no tenant (the webhooks, the sweep). Never for a console route. */
  async findByIdAnyTenant(id: string, db: Db = getPool()): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await db.query<AgencyInboundCallRecord>(
      `SELECT ${CALL_COLUMNS} FROM agency_inbound_calls c WHERE c.id = $1::uuid`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * The session's unsettled inbound call (offered, connected, or ended with its outcome owed), or
   * null: at most one (`uq_agency_inbound_calls_session_unsettled`, which serves the read). The
   * authority on whether the session owes one: the `available` guard reads it before the Redis
   * write, and a restart rehydrates the agent from it.
   */
  async findUnsettledForSession(sessionId: string, deps: { client?: Db } = {}): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundCallRecord>(
      `SELECT ${CALL_COLUMNS} FROM agency_inbound_calls c
        WHERE c.session_id = $1::uuid AND c.settled_at IS NULL`,
      [sessionId],
    );
    return rows[0] ?? null;
  }

  /**
   * The oldest inbound call of the account from `phoneE164` that keeps the number busy (live, or
   * bridged and owing its outcome: `inboundNumberBusySql`), or null: the soft phone's pre-dial
   * (docs/inbound.md §5.4, Q19). One probe of `idx_agency_inbound_calls_live_from_digits`. An
   * unusable number (no digits) matches nothing.
   */
  async findBusyForNumber(tenantId: string, accountId: string, phoneE164: string): Promise<AgencyInboundCallRecord | null> {
    const digits = phoneE164.replace(/[^0-9]/g, '');
    if (!digits) return null;
    const { rows } = await getPool().query<AgencyInboundCallRecord>(
      `SELECT ${CALL_COLUMNS} FROM agency_inbound_calls c
        WHERE c.tenant_id = $1::uuid AND c.account_id = $2::uuid
          AND ${inboundFromDigitsSql('c')} = $3::text
          AND ${inboundNumberBusySql('c')}
        ORDER BY c.arrived_at, c.id
        LIMIT 1`,
      [tenantId, accountId, digits],
    );
    return rows[0] ?? null;
  }

  /**
   * Replace the notes (`PATCH /inbound/calls/:id`) while the call is unsettled; `''` clears them.
   * Last write wins, so an autosave needs no merge. Null when there is no such call or it is
   * settled.
   */
  async updateNotes(id: string, notes: string, deps: { client?: Db } = {}): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundCallRecord>(
      `UPDATE agency_inbound_calls c SET notes = NULLIF($2::text, '')
        WHERE c.id = $1::uuid AND c.settled_at IS NULL
        RETURNING ${CALL_COLUMNS}`,
      [id, notes],
    );
    return rows[0] ?? null;
  }

  /**
   * Save the outcome AND settle the call, in one guarded statement (§2 step 8), with the soft
   * phone's discipline (`AgencyManualCallRepository.recordDisposition`): `disposition_code IS NULL
   * OR disposition_code = $code` makes the first write and a same-code replay one successful path
   * (notes and callback last-write-wins; `notes: null` keeps the stored notes) and a different
   * code a no-op, atomically; the call must have ENDED after it BRIDGED; a lapsed `no_disposition`
   * call is never overwritten. `settled_at` is stamped by the first write and kept by a replay.
   *
   * Run it on the transaction that then writes DNC (suppress codes, B8) and settles the matched
   * contact (`settleFromInbound`) — only when `replay` is false. Release the session's Redis
   * `inbound` field and return the agent after it commits.
   */
  async saveDisposition(
    input: AgencyInboundDispositionInput,
    deps: { client?: Db } = {},
  ): Promise<
    | { ok: true; call: AgencyInboundCallRecord; replay: boolean }
    | { ok: false; reason: AgencyInboundDispositionRefusal; call: AgencyInboundCallRecord | null }
  > {
    const db = deps.client ?? getPool();
    const { rows } = await db.query<AgencyInboundCallRecord & { prev_code: string | null }>(
      `WITH prev AS (
         SELECT id, disposition_code FROM agency_inbound_calls WHERE id = $1::uuid FOR UPDATE
       )
       UPDATE agency_inbound_calls c
          SET disposition_code = $2::varchar,
              disposition_source = $3::varchar,
              notes = COALESCE($4::text, c.notes),
              callback_at = $5::timestamptz,
              dispositioned_by_user_id = $6::uuid,
              dispositioned_on_behalf = $7::boolean,
              dispositioned_at = now(),
              settled_at = COALESCE(c.settled_at, now())
         FROM prev
        WHERE c.id = prev.id
          AND c.state = 'ended'
          AND c.bridged_at IS NOT NULL
          AND c.disposition_code IS DISTINCT FROM '${AUTO_DISPOSITION_CODE}'
          AND ((c.disposition_code IS NULL AND c.settled_at IS NULL) OR c.disposition_code = $2::varchar)
        RETURNING ${CALL_COLUMNS}, prev.disposition_code AS prev_code`,
      [input.id, input.code, input.source, input.notes, input.callbackAt, input.actorUserId, input.onBehalf],
    );
    const row = rows[0];
    if (row) {
      const { prev_code, ...call } = row;
      return { ok: true, call, replay: prev_code === input.code };
    }
    const call = await this.findByIdAnyTenant(input.id, db);
    if (!call) return { ok: false, reason: 'not_found', call: null };
    if (call.state !== 'ended') return { ok: false, reason: 'live', call };
    if (call.disposition_code === AUTO_DISPOSITION_CODE) return { ok: false, reason: 'lapsed', call };
    if (call.bridged_at === null) return { ok: false, reason: 'not_bridged', call };
    return { ok: false, reason: 'different_code', call };
  }

  /**
   * The outcome-lapse sweep (§2 step 8, §6): close every bridged call whose outcome did not come
   * within its window of `ended_at`, or whose session has LEFT: `no_disposition`, the source its
   * match implies, no `dispositioned_by_user_id` (nobody recorded it), settled. The window is the
   * matched campaign's wrap-up auto-return (`inbound-wrapup.ts`: `wrapup_seconds` when
   * `wrapup_auto_return` is on and it is above 0), else `defaultWrapup` (unmatched, or the
   * campaign row gone), never past `lapseMs`, the backstop ({@link AGENCY_INBOUND_OUTCOME_LAPSE_MS}).
   * At most `limit`, oldest end first, over `idx_agency_inbound_calls_unsettled_lapse`.
   *
   * **Releases nothing.** It returns the rows it closed; the caller clears each session's Redis
   * `inbound` field (by this id) and returns the agent. The pick is a MATERIALIZED `FOR UPDATE
   * SKIP LOCKED` CTE, so two overlapping sweeps never close one call twice, and an agent saving
   * the outcome concurrently either wins (the UPDATE's `settled_at IS NULL` re-check) or waits.
   */
  async lapseUnsettled(opts: { lapseMs?: number; defaultWrapup?: InboundWrapupRule; limit?: number } = {}): Promise<AgencyInboundCallRecord[]> {
    const fallback = opts.defaultWrapup ?? INBOUND_DEFAULT_WRAPUP;
    const { rows } = await getPool().query<AgencyInboundCallRecord>(
      `WITH picked AS MATERIALIZED (
         SELECT c.id
           FROM agency_inbound_calls c
           LEFT JOIN agency_agent_sessions s ON s.id = c.session_id
           LEFT JOIN agency_campaigns k ON k.id = c.matched_campaign_id AND k.tenant_id = c.tenant_id
          WHERE c.bridged_at IS NOT NULL AND c.settled_at IS NULL AND c.state = 'ended'
            AND (c.ended_at < now() - make_interval(secs => ${OUTCOME_WINDOW_SECONDS_SQL}) OR s.left_at IS NOT NULL)
          ORDER BY c.ended_at
          LIMIT $2::int
            FOR UPDATE OF c SKIP LOCKED
       )
       UPDATE agency_inbound_calls c
          SET ${LAPSE_SET_SQL}
         FROM picked
        WHERE c.id = picked.id AND c.settled_at IS NULL AND c.state = 'ended'
        RETURNING ${CALL_COLUMNS}`,
      [opts.lapseMs ?? AGENCY_INBOUND_OUTCOME_LAPSE_MS, opts.limit ?? 500, fallback.wrapupSeconds, fallback.autoReturn],
    );
    return rows;
  }

  /**
   * Close ONE call's owed outcome now, as the lapse does (`no_disposition`, nobody recorded it,
   * settled): a supervisor's force-available on its agent (docs/inbound.md §6). Only a call that
   * ended after it bridged and is still unsettled; null otherwise (the outcome was saved, or the
   * sweep closed it, first: the row lock orders this against both).
   */
  async lapseOne(id: string): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await getPool().query<AgencyInboundCallRecord>(
      `UPDATE agency_inbound_calls c
          SET ${LAPSE_SET_SQL}
        WHERE c.id = $1::uuid AND c.bridged_at IS NOT NULL AND c.settled_at IS NULL AND c.state = 'ended'
        RETURNING ${CALL_COLUMNS}`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * The Missed inbound list (§7): newest first, keyset on (`arrived_at DESC`, `id DESC`), over
   * `idx_agency_inbound_calls_missed` or, with `assignee`, `idx_agency_inbound_calls_missed_assignee`.
   */
  async listMissed(input: AgencyInboundMissedListInput): Promise<AgencyKeysetPage<AgencyInboundMissedRow>> {
    const bind = params();
    const conditions = [
      `c.tenant_id = ${bind.add(input.tenantId)}::uuid`,
      input.accountId === null ? 'c.account_id IS NULL' : `c.account_id = ${bind.add(input.accountId)}::uuid`,
      `c.follow_up_status = ${bind.add(input.status)}::varchar`,
    ];
    if (input.assignee === 'unassigned') conditions.push('c.follow_up_assignee_user_id IS NULL');
    else if (input.assignee) conditions.push(`c.follow_up_assignee_user_id = ${bind.add(input.assignee.userId)}::uuid`);
    if (input.reason) conditions.push(`c.follow_up_reason = ${bind.add(input.reason)}::varchar`);
    if (input.from) conditions.push(`c.arrived_at >= ${bind.add(input.from)}::timestamptz`);
    if (input.to) conditions.push(`c.arrived_at < ${bind.add(input.to)}::timestamptz`);
    if (input.after) conditions.push(keysetCondition(input.after, 'c', bind, 'arrived_at'));
    const { rows } = await getPool().query<AgencyInboundMissedRow & { cursor_at: string }>(
      `SELECT ${MISSED_SELECT_SQL}, ${keysetAtSql('c.arrived_at')} AS cursor_at
         FROM ${MISSED_FROM_SQL}
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.arrived_at DESC, c.id DESC
        LIMIT ${bind.add(input.limit + 1)}`,
      bind.values,
    );
    return toKeysetPage(rows, input.limit, ({ cursor_at: _cursor, ...row }) => row);
  }

  /** One Missed row of the account (or of the tenant default, `accountId` null), with its joins; null when it is not one. */
  async findMissed(tenantId: string, accountId: string | null, id: string): Promise<AgencyInboundMissedRow | null> {
    const { rows } = await getPool().query<AgencyInboundMissedRow>(
      `SELECT ${MISSED_SELECT_SQL} FROM ${MISSED_FROM_SQL}
        WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid AND c.account_id IS NOT DISTINCT FROM $3::uuid
          AND c.follow_up_status IS NOT NULL`,
      [id, tenantId, accountId],
    );
    return rows[0] ?? null;
  }

  /**
   * Mark a Missed row handled, by `userId`, now (`handled_reason = 'marked'`). **Idempotent:** a row already handled is
   * answered as it is (`changed: false`, its first handler and time kept), so a double click or a
   * retry never rewrites who handled it. `onlyAssignee`: an agent marks only the rows assigned to
   * them (the route sets it without `agency.supervise`); another's row answers as missing.
   * Null: no such Missed row in the account (or not the caller's).
   */
  async markHandled(
    input: { tenantId: string; accountId: string | null; id: string; userId: string; onlyAssignee?: string },
    deps: { client?: Db } = {},
  ): Promise<{ changed: boolean; call: AgencyInboundMissedRow } | null> {
    const db = deps.client ?? getPool();
    const { rows } = await db.query<{ id: string; changed: boolean }>(
      `WITH target AS (
         SELECT c.id, c.follow_up_status FROM agency_inbound_calls c
          WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid AND c.account_id IS NOT DISTINCT FROM $3::uuid
            AND c.follow_up_status IS NOT NULL
            AND ($5::uuid IS NULL OR c.follow_up_assignee_user_id = $5::uuid)
          FOR UPDATE
       ), handled AS (
         UPDATE agency_inbound_calls c
            SET follow_up_status = 'handled', handled_reason = 'marked', handled_by_user_id = $4::uuid, handled_at = now()
           FROM target t
          WHERE c.id = t.id AND t.follow_up_status = 'open'
          RETURNING c.id
       )
       SELECT t.id, EXISTS (SELECT 1 FROM handled) AS changed FROM target t`,
      [input.id, input.tenantId, input.accountId, input.userId, input.onlyAssignee ?? null],
    );
    const row = rows[0];
    if (!row) return null;
    const { rows: read } = await db.query<AgencyInboundMissedRow>(
      `SELECT ${MISSED_SELECT_SQL} FROM ${MISSED_FROM_SQL} WHERE c.id = $1::uuid`,
      [row.id],
    );
    return { changed: row.changed, call: read[0]! };
  }

  /**
   * Put a HANDLED Missed row back on the list (docs/inbound.md §7): `open`, its `handled_reason`,
   * handler and time cleared, the assignee kept. For a row marked by mistake, or closed as reached
   * when the customer was not. Mark handled's rules: `onlyAssignee` (an agent's own rows; another's
   * answers as missing). **Idempotent:** an open row is answered as it is (`changed: false`). One
   * statement, the row locked: a concurrent Mark handled or reassign waits for it and re-reads the
   * row. A reached close at the same instant leaves it open in either order (0030's close matches
   * the rows that were open when it started, so it passes over one still handled; a reopen after
   * a close reopens it): the person's reopen stands, and the customer's next conversation closes
   * it. `previous`: how it had been handled, for the audit row. Null: no such Missed row in the
   * account (or not the caller's).
   */
  async reopenMissed(
    input: { tenantId: string; accountId: string | null; id: string; onlyAssignee?: string },
    deps: { client?: Db } = {},
  ): Promise<{
    changed: boolean;
    previous: { reason: AgencyInboundHandledReason | null; handledByUserId: string | null; handledAt: Date | null } | null;
    call: AgencyInboundMissedRow;
  } | null> {
    const db = deps.client ?? getPool();
    const { rows } = await db.query<{
      id: string; changed: boolean; reason: AgencyInboundHandledReason | null; handled_by: string | null; handled_at: Date | null;
    }>(
      `WITH target AS (
         SELECT c.id, c.follow_up_status, c.handled_reason, c.handled_by_user_id, c.handled_at FROM agency_inbound_calls c
          WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid AND c.account_id IS NOT DISTINCT FROM $3::uuid
            AND c.follow_up_status IS NOT NULL
            AND ($4::uuid IS NULL OR c.follow_up_assignee_user_id = $4::uuid)
          FOR UPDATE
       ), reopened AS (
         UPDATE agency_inbound_calls c
            SET follow_up_status = 'open', handled_reason = NULL, handled_by_user_id = NULL, handled_at = NULL
           FROM target t
          WHERE c.id = t.id AND t.follow_up_status = 'handled'
          RETURNING c.id
       )
       SELECT t.id, EXISTS (SELECT 1 FROM reopened) AS changed,
              t.handled_reason AS reason, t.handled_by_user_id AS handled_by, t.handled_at
         FROM target t`,
      [input.id, input.tenantId, input.accountId, input.onlyAssignee ?? null],
    );
    const row = rows[0];
    if (!row) return null;
    const { rows: read } = await db.query<AgencyInboundMissedRow>(
      `SELECT ${MISSED_SELECT_SQL} FROM ${MISSED_FROM_SQL} WHERE c.id = $1::uuid`,
      [row.id],
    );
    return {
      changed: row.changed,
      previous: row.changed ? { reason: row.reason, handledByUserId: row.handled_by, handledAt: row.handled_at } : null,
      call: read[0]!,
    };
  }

  /**
   * Give an OPEN Missed row of the account to `assigneeUserId`, or to the account (null): a
   * supervisor's reassign (docs/inbound.md §7). The caller has checked that the assignee can work
   * the account's rows (`filterAccountMembers`). One statement, the row locked: the previous
   * assignee read and the write cannot be split by a concurrent reassign or Mark handled. A row
   * already handled (by a person, or closed as reached) is answered `handled` and left as it is.
   * Null: no such Missed row in the account.
   */
  async reassignMissed(
    input: { tenantId: string; accountId: string; id: string; assigneeUserId: string | null },
    deps: { client?: Db } = {},
  ): Promise<AgencyInboundReassignResult | null> {
    const db = deps.client ?? getPool();
    const { rows } = await db.query<{ id: string; follow_up_status: AgencyInboundFollowUpStatus; previous: string | null; changed: boolean }>(
      `WITH target AS (
         SELECT c.id, c.follow_up_status, c.follow_up_assignee_user_id AS previous FROM agency_inbound_calls c
          WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid AND c.account_id = $3::uuid
            AND c.follow_up_status IS NOT NULL
          FOR UPDATE
       ), assigned AS (
         UPDATE agency_inbound_calls c
            SET follow_up_assignee_user_id = $4::uuid
           FROM target t
          WHERE c.id = t.id AND t.follow_up_status = 'open'
            AND c.follow_up_assignee_user_id IS DISTINCT FROM $4::uuid
          RETURNING c.id
       )
       SELECT t.id, t.follow_up_status, t.previous, EXISTS (SELECT 1 FROM assigned) AS changed FROM target t`,
      [input.id, input.tenantId, input.accountId, input.assigneeUserId],
    );
    const row = rows[0];
    if (!row) return null;
    const { rows: read } = await db.query<AgencyInboundMissedRow>(
      `SELECT ${MISSED_SELECT_SQL} FROM ${MISSED_FROM_SQL} WHERE c.id = $1::uuid`,
      [row.id],
    );
    const call = read[0]!;
    return row.follow_up_status === 'open'
      ? { outcome: 'assigned', changed: row.changed, previousAssigneeUserId: row.previous, call }
      : { outcome: 'handled', call };
  }

  /**
   * The open Missed rows of the account (`assigneeUserId`: only theirs, an agent's scope), for the
   * nav badge: counted up to {@link AGENCY_INBOUND_MISSED_COUNT_CAP} (`capped`: there are more),
   * over `idx_agency_inbound_calls_missed` / `_missed_assignee`; and whether the scope has any
   * Missed row at all, open or handled (`hasRows`: the console keeps the list reachable with the
   * flag off while there is something to read).
   */
  async countMissed(input: { tenantId: string; accountId: string; assigneeUserId?: string }): Promise<{ open: number; capped: boolean; hasRows: boolean }> {
    const assignee = input.assigneeUserId ? 'AND c.follow_up_assignee_user_id = $3::uuid' : '';
    const { rows } = await getPool().query<{ open: number; has_rows: boolean }>(
      `SELECT (SELECT COUNT(*)::int FROM (
                 SELECT 1 FROM agency_inbound_calls c
                  WHERE c.tenant_id = $1::uuid AND c.account_id = $2::uuid AND c.follow_up_status = 'open' ${assignee}
                  LIMIT ${AGENCY_INBOUND_MISSED_COUNT_CAP + 1}
               ) open_rows) AS open,
              EXISTS (
                SELECT 1 FROM agency_inbound_calls c
                 WHERE c.tenant_id = $1::uuid AND c.account_id = $2::uuid AND c.follow_up_status IS NOT NULL ${assignee}
              ) AS has_rows`,
      input.assigneeUserId ? [input.tenantId, input.accountId, input.assigneeUserId] : [input.tenantId, input.accountId],
    );
    const open = rows[0]?.open ?? 0;
    return {
      open: Math.min(open, AGENCY_INBOUND_MISSED_COUNT_CAP),
      capped: open > AGENCY_INBOUND_MISSED_COUNT_CAP,
      hasRows: rows[0]?.has_rows ?? false,
    };
  }

  /**
   * The startup and periodic sweep (§10): end every call still not ended whose latest start
   * (`COALESCE(bridged_at, arrived_at)`: the bind re-arms the call's whole max duration) is before
   * `olderThan`, at most `limit` of them, oldest arrival first. A call bridged to an agent ends
   * `answered` (it was answered; the process that held it is gone) with no follow-up, and stays
   * UNSETTLED: its agent still owes the outcome, writes it after reconnecting (the session is
   * rehydrated with the call re-claimed), or the lapse sweep closes it. Every other one ends
   * `failed` (QA-F9: we lost the caller, a crash or a call this process no longer held; nobody
   * knows they hung up) with an open Missed row (reason `failed`) assigned to its sticky agent,
   * else the account, and is settled (nobody spoke to the caller). Claimed with `MATERIALIZED …
   * FOR UPDATE SKIP LOCKED`, so two sweeps, or a sweep and a hangup webhook, never end one call
   * twice. Returns the rows it ended: the caller books each one's callback, emits metrics and audits.
   */
  async sweepStale(olderThan: Date, limit: number): Promise<AgencyInboundCallRecord[]> {
    const { rows } = await getPool().query<AgencyInboundCallRecord>(
      `WITH picked AS MATERIALIZED (
         SELECT id FROM agency_inbound_calls
          WHERE state <> 'ended' AND arrived_at < $1::timestamptz
            AND COALESCE(bridged_at, arrived_at) < $1::timestamptz
          ORDER BY arrived_at
          LIMIT $2::int
          FOR UPDATE SKIP LOCKED
       )
       UPDATE agency_inbound_calls c
          SET state = 'ended',
              ended_at = now(),
              outcome = CASE WHEN c.bridged_at IS NOT NULL THEN 'answered' ELSE 'failed' END,
              follow_up_status = CASE WHEN c.bridged_at IS NOT NULL THEN NULL ELSE 'open' END,
              follow_up_reason = CASE WHEN c.bridged_at IS NOT NULL THEN NULL ELSE 'failed' END,
              follow_up_assignee_user_id = CASE WHEN c.bridged_at IS NOT NULL THEN NULL ELSE c.sticky_user_id END,
              settled_at = CASE WHEN c.bridged_at IS NOT NULL THEN NULL ELSE now() END
         FROM picked
        WHERE c.id = picked.id AND c.state <> 'ended'
        RETURNING ${CALL_COLUMNS}`,
      [olderThan, limit],
    );
    return rows.sort((a, b) => a.arrived_at.getTime() - b.arrived_at.getTime());
  }
}

/** What closing an owed outcome writes (the lapse sweep, a supervisor's close): `no_disposition`, by nobody, settled. */
const LAPSE_SET_SQL = `settled_at = now(),
              disposition_code = '${AUTO_DISPOSITION_CODE}',
              disposition_source = CASE WHEN c.matched_campaign_id IS NULL THEN 'route' ELSE 'campaign' END,
              dispositioned_at = now()`;

/**
 * The lapse window in seconds (`inbound-wrapup.ts`'s `inboundOutcomeWindowMs`, in SQL): the
 * matched campaign `k`'s auto-return window, else the default (`$3` seconds, `$4` auto-return),
 * never past the backstop (`$1` ms). Auto-return off, or no window: the backstop.
 */
const OUTCOME_WINDOW_SECONDS_SQL = `CASE
                 WHEN COALESCE(k.wrapup_auto_return, $4::boolean) AND COALESCE(k.wrapup_seconds, $3::int) > 0
                   THEN LEAST(COALESCE(k.wrapup_seconds, $3::int)::double precision, $1::double precision / 1000)
                 ELSE $1::double precision / 1000
               END`;

/** The one-unsettled-call-per-session index (`0027_inbound_connect.sql`). */
const SESSION_UNSETTLED_INDEX = 'uq_agency_inbound_calls_session_unsettled';

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return !!e && e.code === '23505' && e.constraint === constraint;
}

export const agencyInboundCallRepository = new AgencyInboundCallRepository();
