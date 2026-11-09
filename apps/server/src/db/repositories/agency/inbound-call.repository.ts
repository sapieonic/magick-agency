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
 * **an `ended` row never moves again**: {@link AgencyInboundCallRepository.transition} cannot
 * leave `ended` and {@link AgencyInboundCallRepository.end} and the sweep only end a row that is
 * not. `bridged_at` and `answered_by_user_id` are stamped by the move to `connected`, never
 * overwritten.
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
  AgencyInboundFollowUpStatus,
  AgencyInboundMissedReason,
  AgencyInboundStickyReason,
  AgencyKeysetPage,
} from '@magick-agency/contracts/agency';
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import { keysetCondition, params, toKeysetPage } from './query-builders.js';

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
  endedAt?: Date;
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
}

const CALL_COLUMNS = `c.id, c.tenant_id, c.account_id, c.route_id, c.phone_number_id, c.provider, c.telephony_credential_id,
  c.provider_call_id, c.from_e164, c.to_e164, c.matched_contact_id, c.matched_campaign_id, c.caller_dnc,
  c.sticky_user_id, c.sticky_reason, c.state, c.outcome, c.arrived_at, c.answered_at, c.bridged_at,
  c.answered_by_user_id, c.ended_at, c.talk_seconds, c.webrtc_call_id, c.voicemail_key, c.callback_due_at,
  c.follow_up_status, c.follow_up_reason, c.follow_up_assignee_user_id, c.handled_by_user_id, c.handled_at,
  c.created_at, c.updated_at`;

/** A row's Missed-list joins: the route's name and the matched campaign's. Both LEFT, no FK. */
const MISSED_FROM_SQL = `agency_inbound_calls c
        LEFT JOIN agency_inbound_routes r ON r.id = c.route_id
        LEFT JOIN agency_campaigns cam ON cam.id = c.matched_campaign_id`;
const MISSED_SELECT_SQL = `${CALL_COLUMNS}, r.name AS route_name, cam.name AS matched_campaign_name`;

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
            answered_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::varchar, $6::uuid, $7::varchar,
                 $8::varchar, $9::varchar, $10::uuid, $11::uuid, $12::boolean, $13::uuid, $14::varchar,
                 CASE WHEN $15::boolean THEN now() END)
         ON CONFLICT (provider, provider_call_id) DO NOTHING
         RETURNING ${CALL_COLUMNS}`,
        [
          input.tenantId, input.accountId, input.routeId, input.phoneNumberId, input.provider, input.telephonyCredentialId,
          input.providerCallId, input.fromE164, input.toE164, id.match?.contactId ?? null, id.match?.campaignId ?? null,
          id.callerDnc, id.sticky?.userId ?? null, id.sticky?.reason ?? null, input.answered,
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
   * Move the call to `to` from one of the states {@link INBOUND_CALL_TRANSITIONS} allows. The move
   * to `connected` takes the agent and stamps `bridged_at` (first stamp wins). Null when the call
   * is missing or in a state the move does not leave (an ended call, or one already further on);
   * the caller re-reads to tell which.
   */
  async transition(
    id: string,
    to: AgencyInboundTransitionTarget,
    opts: { answeredByUserId?: string; at?: Date } = {},
    deps: { client?: Db } = {},
  ): Promise<AgencyInboundCallRecord | null> {
    if (to === 'connected' && !opts.answeredByUserId) throw new Error('a connected inbound call needs the agent who took it');
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundCallRecord>(
      `UPDATE agency_inbound_calls c
          SET state = $2::varchar,
              bridged_at = CASE WHEN $2::varchar = 'connected' THEN COALESCE(c.bridged_at, $4::timestamptz) ELSE c.bridged_at END,
              answered_by_user_id = CASE WHEN $2::varchar = 'connected' THEN COALESCE(c.answered_by_user_id, $5::uuid)
                                         ELSE c.answered_by_user_id END
        WHERE c.id = $1::uuid AND c.state = ANY($3::varchar[])
        RETURNING ${CALL_COLUMNS}`,
      [id, to, INBOUND_CALL_TRANSITIONS[to], opts.at ?? new Date(), opts.answeredByUserId ?? null],
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
   */
  async refuseAdmission(id: string, deps: { client?: Db } = {}): Promise<AgencyInboundCallRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundCallRecord>(
      `UPDATE agency_inbound_calls c SET state = 'arrived'
        WHERE c.id = $1::uuid AND c.state = 'greeting'
        RETURNING ${CALL_COLUMNS}`,
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
              callback_due_at = $7::timestamptz, voicemail_key = $8::text
        WHERE c.id = $1::uuid AND c.state <> 'ended'
        RETURNING ${CALL_COLUMNS}`,
      [
        id, input.outcome, input.endedAt ?? new Date(), input.talkSeconds,
        input.followUp?.reason ?? null, input.followUp?.assigneeUserId ?? null,
        input.callbackDueAt, input.voicemailKey,
      ],
    );
    if (rows[0]) return { ended: true, call: rows[0] };
    return { ended: false, call: await this.findByIdAnyTenant(id, db) };
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
   * Mark a Missed row handled, by `userId`, now. **Idempotent:** a row already handled is
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
            SET follow_up_status = 'handled', handled_by_user_id = $4::uuid, handled_at = now()
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
   * The startup and periodic sweep (§10): end every call still not ended that arrived before
   * `olderThan`, at most `limit` of them, oldest first. A call bridged to an agent ends
   * `answered` (it was answered; the process that held it is gone) with no follow-up; every other
   * one ends `abandoned_in_queue` with an open Missed row (reason `abandoned_in_queue`) assigned
   * to its sticky agent, else the account. Claimed with `MATERIALIZED … FOR UPDATE SKIP LOCKED`,
   * so two sweeps, or a sweep and a hangup webhook, never end one call twice. Returns the rows it
   * ended: the caller books each one's callback, emits metrics and audits.
   */
  async sweepStale(olderThan: Date, limit: number): Promise<AgencyInboundCallRecord[]> {
    const { rows } = await getPool().query<AgencyInboundCallRecord>(
      `WITH picked AS MATERIALIZED (
         SELECT id FROM agency_inbound_calls
          WHERE state <> 'ended' AND arrived_at < $1::timestamptz
          ORDER BY arrived_at
          LIMIT $2::int
          FOR UPDATE SKIP LOCKED
       )
       UPDATE agency_inbound_calls c
          SET state = 'ended',
              ended_at = now(),
              outcome = CASE WHEN c.bridged_at IS NOT NULL THEN 'answered' ELSE 'abandoned_in_queue' END,
              follow_up_status = CASE WHEN c.bridged_at IS NOT NULL THEN NULL ELSE 'open' END,
              follow_up_reason = CASE WHEN c.bridged_at IS NOT NULL THEN NULL ELSE 'abandoned_in_queue' END,
              follow_up_assignee_user_id = CASE WHEN c.bridged_at IS NOT NULL THEN NULL ELSE c.sticky_user_id END
         FROM picked
        WHERE c.id = picked.id AND c.state <> 'ended'
        RETURNING ${CALL_COLUMNS}`,
      [olderThan, limit],
    );
    return rows.sort((a, b) => a.arrived_at.getTime() - b.arrived_at.getTime());
  }
}

export const agencyInboundCallRepository = new AgencyInboundCallRepository();
