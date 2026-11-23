/*
 * What the call-log integration suites share (`docs/call-log.md`): one seeder for an
 * `agency_inbound_calls` row and one walk of a keyset list. Each suite keeps its own thin
 * `inbound(label, …)` over the seeder, with its defaults (its floor, its campaign, its labels).
 */
import { randomUUID } from 'node:crypto';
import { getTestPool } from '../../../../packages/db/test/helpers/test-db.js';

/** An `agency_inbound_calls` row to seed: every column a call-log rule reads is named. */
export interface InboundCallSeed {
  tenantId: string;
  accountId: string;
  /** The campaign the call is filed under; null: none. */
  campaign: string | null;
  /** `campaign_source` when filed; default `contact` for a matched caller, else `route`. */
  source?: string;
  /** The roster contact the caller matched (then `matched_campaign_id` is the campaign). */
  matched?: string;
  /** The caller's number; null: withheld. */
  from: string | null;
  /** The number rung. */
  to: string;
  arrived: Date;
  /** Default `ended`. */
  state?: string;
  /** An ended call's outcome; default `answered`. */
  outcome?: string | null;
  /** Seconds after arrival. `endedAfter` defaults to 5 on an ended call. */
  queuedAfter?: number;
  bridgedAfter?: number;
  endedAfter?: number;
  /** Who answered: written only on a bridged call. */
  answeredBy?: string;
  sticky?: string;
  talk?: number;
  /** The outcome saved (by `answeredBy`, at the end); the call is then settled. */
  code?: string;
  followUp?: { status: 'open' | 'handled'; reason: string; assignee?: string; handledBy?: string; handledReason?: string };
  closedCause?: string;
  voicemailSeconds?: number;
  webrtcCallId?: string;
}

/** Insert the row straight into the table; answers its id. `label` names its voicemail file. */
export async function insertInboundCall(label: string, o: InboundCallSeed): Promise<string> {
  const state = o.state ?? 'ended';
  const after = (s: number | undefined) => (s === undefined ? null : new Date(o.arrived.getTime() + s * 1000));
  const ended = state === 'ended' ? after(o.endedAfter ?? 5) : null;
  const bridged = after(o.bridgedAfter);
  const { rows: [row] } = await getTestPool().query(
    `INSERT INTO agency_inbound_calls
       (tenant_id, account_id, provider, provider_call_id, from_e164, to_e164,
        matched_contact_id, matched_campaign_id, campaign_id, campaign_source,
        sticky_user_id, sticky_reason, state, outcome, arrived_at, answered_at, queued_at, bridged_at, answered_by_user_id,
        ended_at, talk_seconds, disposition_code, disposition_source, dispositioned_at, dispositioned_by_user_id, settled_at,
        follow_up_status, follow_up_reason, follow_up_assignee_user_id, handled_at, handled_by_user_id, handled_reason,
        closed_cause, voicemail_key, voicemail_seconds, webrtc_call_id)
     VALUES ($1, $2, 'plivo', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $15, $16, $17,
             $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)
     RETURNING id`,
    [
      o.tenantId, o.accountId, `CA-${randomUUID()}`, o.from, o.to,
      // A caller on the campaign's list is matched AND filed (`contact`); any other is filed by
      // its route and matched to nothing: only `campaign_id` puts it under the campaign.
      o.matched ?? null, o.matched ? o.campaign : null, o.campaign, o.campaign ? (o.source ?? (o.matched ? 'contact' : 'route')) : null,
      o.sticky ?? null, o.sticky ? 'last_connected' : null, state, state === 'ended' ? (o.outcome ?? 'answered') : null,
      o.arrived, after(o.queuedAfter), bridged, bridged ? o.answeredBy ?? null : null,
      ended, o.talk ?? null, o.code ?? null, o.code ? (o.matched ? 'campaign' : 'route') : null, o.code ? ended : null,
      o.code ? o.answeredBy ?? null : null, state === 'ended' && (o.code || !bridged) ? ended : null,
      o.followUp?.status ?? null, o.followUp?.reason ?? null, o.followUp?.assignee ?? null,
      o.followUp?.status === 'handled' ? ended : null, o.followUp?.handledBy ?? null, o.followUp?.handledReason ?? null,
      o.closedCause ?? null, o.voicemailSeconds === undefined ? null : `inbound-voicemail/${label}.wav`, o.voicemailSeconds ?? null,
      o.webrtcCallId ?? null,
    ],
  );
  return row.id as string;
}

/**
 * Every row of a keyset list, walked by its cursor: `page` reads one page given the paging
 * query (`limit=N`, then `limit=N&cursor=…`). Throws when the list has not ended in 60 pages.
 */
export async function walkKeyset<R>(
  page: (paging: string) => Promise<{ rows: R[]; next_cursor: string | null }>,
  limit: number,
): Promise<R[]> {
  const rows: R[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 60; i++) {
    const read: { rows: R[]; next_cursor: string | null } = await page(`limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    rows.push(...read.rows);
    cursor = read.next_cursor;
    if (!cursor) return rows;
  }
  throw new Error('the list never ended');
}
