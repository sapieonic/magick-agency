/**
 * The soft phone's figures on a campaign: ONE definition of a soft-phone call that was placed,
 * connected and reached a person, shared by every campaign surface that COUNTS one (Insights'
 * `calls.softphone`, which the campaign report embeds, and `/stats` `softphone`) and by the agent
 * report's soft-phone count (decisions SR1–SR3, docs/softphone.md §2). The campaign call export
 * counts nothing: its `soft_phone` rows are every call tagged to the campaign in its tenant,
 * placed or not, as its dialler rows are every attempt (`listCallLogForCampaign`), and its
 * `placed` filter spells the same `dialed_at` rule through `placedDialSql`.
 *
 * A soft-phone call is never an attempt (0005): it has no redials, no pacing and no roster
 * claim of its own, and agents choose whom to ring, so its figures sit BESIDE the dialler's and
 * never inside its connect rate (SR1). Spelled on the manual call as `m`:
 *
 *  - {@link SOFTPHONE_PLACED_SQL}: the dial left the building (`dialed_at` set). A row whose
 *    dial failed before it was sent (`dial_failed`, the station gone) is not a call. A DNC or
 *    calling-hours refusal writes no row at all; an override that went ahead is a call.
 *  - {@link SOFTPHONE_CONNECTED_SQL}: outcome `connected`, the dialler's Connected figure's
 *    rule (`/stats` `attempts_connected`); and what the Soft-phone calls list's own `outcome`
 *    filter selects. Set when a bridged call ends, so a call still in conversation is placed and
 *    not yet connected, as a dialler attempt is.
 *  - {@link SOFTPHONE_HUMAN_CONNECT_SQL}: the connect rate's numerator, the dialler's
 *    `HUMAN_CONNECT_ATTEMPT_SQL` on a soft-phone call: bridged, and written up with a code that
 *    is neither voicemail nor the lapse sweep's auto-stamp. The soft phone has no wrap-up
 *    redials, so every placed call is a first dial and the rate is human connects over placed.
 *
 * Campaign scope: tagged to the campaign (`campaign_id`, the tag chosen before Call and fixed
 * for the call) and in its tenant (the tag carries no foreign key). An untagged call belongs to
 * no campaign and is in none of these figures (SR4). The range is half-open `[from, to)` on
 * `created_at`, the column `idx_agency_manual_calls_campaign (campaign_id, created_at DESC)`
 * orders; a call is placed seconds after it is created.
 *
 * A leaf beside `sql-fragments.ts`, whose two codes it reads so the dialler's rule and this one
 * cannot spell them apart.
 */
import type { AgencyCallLogStatus } from '@magick-agency/contracts/api/agency/call-log';
import { AUTO_DISPOSITION_CODE } from '../../../agency/disposition.js';
import { VOICEMAIL_DISPOSITION_CODE } from './sql-fragments.js';

/** Placed: the dial was sent. Names the manual call `m`. */
export const SOFTPHONE_PLACED_SQL = 'm.dialed_at IS NOT NULL';

/** Connected: outcome `connected` (the dialler's Connected figure's rule). Names the manual call `m`. */
export const SOFTPHONE_CONNECTED_SQL = "m.outcome = 'connected'";

/**
 * Reached a person: bridged and written up with a code that is neither voicemail nor the
 * lapse sweep's `no_disposition`. The connect rate's numerator. Names the manual call `m`.
 */
export const SOFTPHONE_HUMAN_CONNECT_SQL = `m.bridged_at IS NOT NULL
           AND m.disposition_code IS NOT NULL
           AND m.disposition_code <> '${VOICEMAIL_DISPOSITION_CODE}'
           AND m.disposition_code <> '${AUTO_DISPOSITION_CODE}'`;

/**
 * Where a soft-phone call stands: the Soft-phone calls list's and the campaign Call log's Status
 * filter (the contract's `status` values).
 */
export type SoftphoneCallStatus = AgencyCallLogStatus;

/**
 * A soft-phone call in one status. `live`: not ended; `awaiting_outcome`: ended and not
 * settled; `settled`: outcome saved, lapsed, or closed with none owed. One spelling for the
 * account's Soft-phone calls list and the campaign Call log. Names the manual call `m`.
 */
export function softphoneStatusSql(status: SoftphoneCallStatus): string {
  if (status === 'live') return "m.state <> 'ended'";
  if (status === 'awaiting_outcome') return "m.state = 'ended' AND m.settled_at IS NULL";
  return 'm.settled_at IS NOT NULL';
}

/** A soft-phone campaign count: placed, connected, reached a person, and the placed calls' talk time. */
export interface SoftphoneCampaignCounts {
  placed: number;
  connected: number;
  human_connects: number;
  talk_seconds: number;
}

/**
 * The three counts for one campaign, over `[from, to)` on `created_at`, or the campaign's whole
 * life when both are absent (`/stats`). One range of `idx_agency_manual_calls_campaign`; the
 * tenant and the three predicates are read from each matching row. `tenantId` null takes the
 * campaign row's own tenant (`/stats`' repository half is keyed on the campaign alone).
 */
export function softphoneCampaignCountsStatement(q: {
  campaignId: string;
  tenantId: string | null;
  from?: Date | null;
  to?: Date | null;
}): { text: string; values: unknown[] } {
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
    range.push(`AND m.created_at >= $${values.length}::timestamptz`);
  }
  if (q.to) {
    values.push(q.to);
    range.push(`AND m.created_at < $${values.length}::timestamptz`);
  }
  return {
    text: `
      SELECT count(*) FILTER (WHERE ${SOFTPHONE_PLACED_SQL})::int AS placed,
             count(*) FILTER (WHERE ${SOFTPHONE_CONNECTED_SQL})::int AS connected,
             count(*) FILTER (WHERE ${SOFTPHONE_HUMAN_CONNECT_SQL})::int AS human_connects,
             COALESCE(sum(m.talk_seconds) FILTER (WHERE ${SOFTPHONE_PLACED_SQL}), 0)::int AS talk_seconds
        FROM agency_manual_calls m
       WHERE m.campaign_id = $1::uuid
         ${range.join('\n         ')}
         AND m.tenant_id = ${tenant}`,
    values,
  };
}

/** One count of a row as `pg` returns it (`::int`), read defensively: anything that is not a number is 0. */
export function readCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0;
}

/** A count row as `pg` returns it (`::int`), read defensively. */
export function readSoftphoneCampaignCounts(row: Partial<Record<keyof SoftphoneCampaignCounts, unknown>> | undefined): SoftphoneCampaignCounts {
  const n = readCount;
  return {
    placed: n(row?.placed),
    connected: n(row?.connected),
    human_connects: n(row?.human_connects),
    talk_seconds: n(row?.talk_seconds),
  };
}
