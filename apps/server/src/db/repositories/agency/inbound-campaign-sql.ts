/**
 * Inbound calls on a campaign, as figures: ONE definition shared by every campaign surface that
 * COUNTS them (Insights' `calls.inbound` and `outcomes_by_type`, which the campaign report
 * embeds, and `/stats` `inbound`), beside the dialler's and the soft phone's
 * (`softphone-campaign-sql.ts`) and never in them (`docs/call-log.md` §6, CL7, CL25–CL30).
 *
 * ── What is counted ────────────────────────────────────────────────────────────
 * Exactly the rows the campaign's Call log lists as Inbound (CL16): filed under the campaign
 * (`campaign_id`: the matched contact's, the route's for an unknown caller, or the one chosen at
 * the end of the call; never `matched_campaign_id`, never `disposition_source`) in its tenant,
 * ENDED and SERVED ({@link inboundCampaignRowConditions}, the list's own spelling). Spelled on
 * the inbound call as `i`:
 *
 *  - `received`: every such call. `answered`: an agent took it ({@link inboundAnsweredSql}, the
 *    Call log's "Connected" on an inbound row). `missed`: it left a Missed row, open or handled
 *    since ({@link inboundMissedSql}, the Call log's "Missed"). `talk_seconds`: the calls' talk
 *    time (only an answered call has any). `open_hours`: it arrived while the line was open
 *    ({@link inboundOpenHoursSql}, the inbound summary's answer-rate denominator).
 *  - `open_follow_ups`: the campaign's OPEN Missed rows ({@link inboundMissedOpenSql}), the Call
 *    log's To follow up, by its rule (CL14): NOT cut by the window. A caller owed a call back
 *    yesterday is still owed one today.
 *
 * One row is one call of one type. A missed call and the soft-phone call back to it are two
 * rows of two tables, so two calls; marking a Missed row handled writes a status on the row, not
 * a call; a dial the customer's own call stopped is a dialler attempt that connected to nobody,
 * and the conversation is the inbound call's alone.
 *
 * The range is half-open `[from, to)` on `arrived_at`, the column
 * `idx_agency_inbound_calls_campaign (campaign_id, arrived_at DESC, id DESC) WHERE campaign_id
 * IS NOT NULL` (0068) orders. Read live: the Insights rollup is a pure function of
 * `agency_call_attempts` and holds the dialler's figures alone (CL25).
 */
import { SOFTPHONE_PLACED_SQL } from './softphone-campaign-sql.js';
import {
  inboundAnsweredSql,
  inboundCampaignRowConditions,
  inboundMissedOpenSql,
  inboundMissedSql,
  inboundOpenHoursSql,
} from './sql-fragments.js';

/** A campaign's inbound counts (the wire's `AgencyInboundCampaignCounts`). */
export interface InboundCampaignCounts {
  received: number;
  answered: number;
  missed: number;
  open_follow_ups: number;
  talk_seconds: number;
  open_hours: number;
}

interface CampaignRange {
  campaignId: string;
  /** Null takes the campaign row's own tenant (`/stats`' repository half is keyed on the campaign alone). */
  tenantId: string | null;
  from?: Date | null;
  to?: Date | null;
}

/** Binds the campaign, its tenant and the range on `arrived_at`. */
function scope(q: CampaignRange): { values: unknown[]; tenant: string; range: string[] } {
  const values: unknown[] = [q.campaignId];
  let tenant: string;
  if (q.tenantId === null) {
    tenant = '(SELECT c.tenant_id FROM agency_campaigns c WHERE c.id = $1::uuid)';
  } else {
    values.push(q.tenantId);
    tenant = '$2::uuid';
  }
  const range: string[] = [];
  if (q.from) {
    values.push(q.from);
    range.push(`AND i.arrived_at >= $${values.length}::timestamptz`);
  }
  if (q.to) {
    values.push(q.to);
    range.push(`AND i.arrived_at < $${values.length}::timestamptz`);
  }
  return { values, tenant, range };
}

/**
 * The campaign's inbound counts over `[from, to)` on `arrived_at`, or its whole life when both
 * are absent (`/stats`). The windowed counts are one range of `idx_agency_inbound_calls_campaign`;
 * `open_follow_ups` is the campaign's whole range of it, as the Call log's To follow up count is.
 */
export function inboundCampaignCountsStatement(q: CampaignRange): { text: string; values: unknown[] } {
  const { values, tenant, range } = scope(q);
  const row = inboundCampaignRowConditions('i').join(' AND ');
  return {
    text: `
      SELECT w.received, w.answered, w.missed, w.talk_seconds, w.open_hours,
             (SELECT count(*)::int
                FROM agency_inbound_calls i
               WHERE i.campaign_id = $1::uuid
                 AND i.tenant_id = ${tenant}
                 AND ${row}
                 AND ${inboundMissedOpenSql('i')}) AS open_follow_ups
        FROM (SELECT count(*)::int AS received,
                     count(*) FILTER (WHERE ${inboundAnsweredSql('i')})::int AS answered,
                     count(*) FILTER (WHERE ${inboundMissedSql('i')})::int AS missed,
                     COALESCE(sum(i.talk_seconds), 0)::int AS talk_seconds,
                     count(*) FILTER (WHERE ${inboundOpenHoursSql('i')})::int AS open_hours
                FROM agency_inbound_calls i
               WHERE i.campaign_id = $1::uuid
                 ${range.join('\n                 ')}
                 AND i.tenant_id = ${tenant}
                 AND ${row}) w`,
    values,
  };
}

/** A count row as `pg` returns it (`::int`), read defensively. */
export function readInboundCampaignCounts(row: Partial<Record<keyof InboundCampaignCounts, unknown>> | undefined): InboundCampaignCounts {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
  return {
    received: n(row?.received),
    answered: n(row?.answered),
    missed: n(row?.missed),
    open_follow_ups: n(row?.open_follow_ups),
    talk_seconds: n(row?.talk_seconds),
    open_hours: n(row?.open_hours),
  };
}

/** One outcome's count on the soft phone or on inbound calls; `code` null is "no outcome written". */
export interface OutcomeByTypeCountRow {
  source: 'soft_phone' | 'inbound';
  code: string | null;
  count: number;
}

/**
 * The campaign's outcomes on its soft-phone and inbound calls over `[from, to)` (CL28), for the
 * outcomes-by-type table; the dialler's column is the rollup's conversations by code.
 *
 *  - soft phone: the placed calls logged to the campaign that were put through to the customer
 *    (`bridged_at` set: there was a conversation to write up, the dialler's rule for a first
 *    dial), `created_at` in range, by the outcome saved;
 *  - inbound: the campaign's inbound calls an agent answered, `arrived_at` in range, by the
 *    outcome saved. Whatever catalog the code came from (`disposition_source`), the call is
 *    counted under the campaign it is filed under.
 *
 * Each half is a range of its campaign index, grouped.
 */
export function outcomesByTypeStatement(q: { campaignId: string; tenantId: string; from: Date; to: Date }): { text: string; values: unknown[] } {
  return {
    text: `
      SELECT 'soft_phone'::text AS source, m.disposition_code AS code, count(*)::int AS count
        FROM agency_manual_calls m
       WHERE m.campaign_id = $1::uuid
         AND m.created_at >= $3::timestamptz AND m.created_at < $4::timestamptz
         AND m.tenant_id = $2::uuid
         AND ${SOFTPHONE_PLACED_SQL}
         AND m.bridged_at IS NOT NULL
       GROUP BY m.disposition_code
      UNION ALL
      SELECT 'inbound'::text AS source, i.disposition_code AS code, count(*)::int AS count
        FROM agency_inbound_calls i
       WHERE i.campaign_id = $1::uuid
         AND i.arrived_at >= $3::timestamptz AND i.arrived_at < $4::timestamptz
         AND i.tenant_id = $2::uuid
         AND ${inboundCampaignRowConditions('i').join(' AND ')}
         AND ${inboundAnsweredSql('i')}
       GROUP BY i.disposition_code`,
    values: [q.campaignId, q.tenantId, q.from, q.to],
  };
}
