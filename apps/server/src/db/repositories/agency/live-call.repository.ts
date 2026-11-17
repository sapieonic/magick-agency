/**
 * `AgencyLiveCallRepository`: the calls in progress in an account (live call listening,
 * docs/listening.md §4 "The live list"): an agent connected to a customer, on any of the three
 * spines, each on its live index:
 *  - a dialler call: `agency_call_attempts.state = 'bridged'` (`idx_agency_attempts_account_live`,
 *    the account's live attempts; not through the account's campaigns, which would read every
 *    campaign it has ever had on every poll: `test/integration/agency/live-call-plan.test.ts`);
 *  - a soft-phone call: `agency_manual_calls.state = 'bridged'` (`idx_agency_manual_calls_live`);
 *  - an inbound call: `agency_inbound_calls.state = 'connected'` with its audio bound
 *    (`bridged_at` set; `idx_agency_inbound_calls_account_live`). A caller parked on hold, answered
 *    but with no agent, is not live here.
 * Each joined to its `agency_calls` leg (the spine's `webrtc_call_id`, the bridge session's key),
 * the agent's session, the campaign, the inbound route and the roster contact. Tenant and account
 * scoped throughout; ids validated at the edge. Read on every poll of the live list (5 s), so it
 * reads what it shows and nothing else; the full number is in the row for the number reveal and the
 * public layer's mask, never in the list it answers.
 */
import { getPool } from '@magick-agency/db';
import type { AgencyCallOrigin, AgencyClientKind } from '@magick-agency/contracts/agency';
import { VOICEMAIL_DISPOSITION_CODE, ahtSecondsSql, contactNameContextSql } from './sql-fragments.js';

/** One live call, as the internal handler answers it (full number; no names but the contact's). */
export interface AgencyLiveCallRow {
  call_id: string;
  origin: AgencyCallOrigin;
  /** The spine row: the attempt, the manual call or the inbound call. */
  correlation_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  inbound_route_name: string | null;
  agent_session_id: string;
  agent_user_id: string;
  client_kind: AgencyClientKind;
  /** E.164; empty for an inbound caller who withheld their number. */
  customer_phone: string;
  /** The roster contact's name columns (`matchName` reads them), or null without a contact. */
  contact_context: Record<string, unknown> | null;
  connected_at: Date;
  /** `agency_calls.recording_requested` (RC1). */
  recording: boolean;
}

export interface AgencyLiveCallQuery {
  tenantId: string;
  accountId: string;
  /** One campaign's calls (a dialler call's, a tagged soft-phone call's, a matched inbound call's). */
  campaignId?: string | null;
  /** One call (`agency_calls.id`): the number reveal and the grant. */
  callId?: string | null;
}

/** The live list's statement (`listLive`); exported for its plan test. */
export const LIVE_CALLS_SQL = `
  WITH live AS (
    SELECT 'campaign'::varchar AS origin, a.id AS correlation_id, a.webrtc_call_id AS call_id, a.campaign_id,
           a.reserved_agent_id AS session_id, a.contact_id, a.bridged_at AS connected_at, NULL::uuid AS route_id
      FROM agency_call_attempts a
     WHERE a.tenant_id = $1::uuid AND a.account_id = $2::uuid
       AND ($3::uuid IS NULL OR a.campaign_id = $3::uuid)
       AND a.state <> 'ended' AND a.state = 'bridged' AND a.webrtc_call_id IS NOT NULL
       -- No "reserved_agent_id IS NOT NULL" here: the session join below needs one anyway, and the
       -- predicate would offer the planner idx_agency_attempts_agent (every tenant's live attempts).
    UNION ALL
    SELECT 'manual'::varchar, m.id, m.webrtc_call_id, m.campaign_id, m.session_id, m.contact_id, m.bridged_at, NULL::uuid
      FROM agency_manual_calls m
     WHERE m.account_id = $2::uuid AND m.tenant_id = $1::uuid
       AND m.state <> 'ended' AND m.state = 'bridged' AND m.webrtc_call_id IS NOT NULL
       AND ($3::uuid IS NULL OR m.campaign_id = $3::uuid)
    UNION ALL
    SELECT 'inbound'::varchar, i.id, i.webrtc_call_id, i.matched_campaign_id, i.session_id, i.matched_contact_id,
           i.bridged_at, i.route_id
      FROM agency_inbound_calls i
     WHERE i.tenant_id = $1::uuid AND i.account_id = $2::uuid
       AND i.state <> 'ended' AND i.state <> 'arrived' AND i.state = 'connected'
       AND i.bridged_at IS NOT NULL AND i.webrtc_call_id IS NOT NULL AND i.session_id IS NOT NULL
       AND ($3::uuid IS NULL OR i.matched_campaign_id = $3::uuid)
  )
  SELECT l.call_id, l.origin, l.correlation_id, l.campaign_id, cam.name AS campaign_name, r.name AS inbound_route_name,
         s.id AS agent_session_id, s.agent_user_id, s.client_kind, c.destination_phone AS customer_phone,
         ${contactNameContextSql('ct')} AS contact_context,
         COALESCE(l.connected_at, c.answered_at, c.created_at) AS connected_at,
         c.recording_requested AS recording
    FROM live l
    JOIN agency_calls c ON c.id = l.call_id AND c.tenant_id = $1::uuid AND c.account_id = $2::uuid
    JOIN agency_agent_sessions s ON s.id = l.session_id AND s.tenant_id = $1::uuid
    LEFT JOIN agency_campaigns cam ON cam.id = l.campaign_id AND cam.tenant_id = $1::uuid
    LEFT JOIN agency_inbound_routes r ON r.id = l.route_id AND r.tenant_id = $1::uuid
    LEFT JOIN agency_contacts ct ON ct.id = l.contact_id AND ct.tenant_id = $1::uuid
   WHERE ($4::uuid IS NULL OR l.call_id = $4::uuid)
   ORDER BY connected_at ASC, l.call_id`;

/** The campaign AHT read (`campaignAhtSeconds`): $1 tenant, $2 campaign ids, $3 the voicemail code. Exported for its plan test. */
export const CAMPAIGN_AHT_SQL = `
  SELECT a.campaign_id, ${ahtSecondsSql('$3')}::text AS aht_seconds
    FROM agency_call_attempts a
   WHERE a.campaign_id = ANY($2::uuid[]) AND a.tenant_id = $1::uuid
   GROUP BY a.campaign_id`;

export class AgencyLiveCallRepository {
  /** The account's live calls (or one campaign's, or one call), longest on call first. */
  async listLive(q: AgencyLiveCallQuery): Promise<AgencyLiveCallRow[]> {
    const { rows } = await getPool().query<AgencyLiveCallRow>(LIVE_CALLS_SQL, [
      q.tenantId, q.accountId, q.campaignId ?? null, q.callId ?? null,
    ]);
    return rows;
  }

  /**
   * Each campaign's average handle time in seconds (the campaign stats' `aht_seconds`,
   * `ahtSecondsSql`); a campaign with no ended, bridged attempt is absent. Tenant scoped.
   *
   * Its cost is each campaign's WHOLE history (every attempt it has made, by `campaign_id` on an
   * index: `live-call-plan.test.ts`), the same aggregate the campaign stats read computes. So the
   * internal handler caches it a minute per campaign per process (`LIVE_CALL_AHT_CACHE_MS`): the
   * live list is polled every 5 s by every supervisor, the AHT read at most once a minute (LS16 i, u).
   */
  async campaignAhtSeconds(tenantId: string, campaignIds: readonly string[]): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const { rows } = await getPool().query<{ campaign_id: string; aht_seconds: string | null }>(
      CAMPAIGN_AHT_SQL,
      [tenantId, campaignIds, VOICEMAIL_DISPOSITION_CODE],
    );
    const out = new Map<string, number>();
    for (const row of rows) {
      const v = row.aht_seconds === null ? NaN : Number(row.aht_seconds);
      if (Number.isFinite(v)) out.set(row.campaign_id, v);
    }
    return out;
  }
}

export const agencyLiveCallRepository = new AgencyLiveCallRepository();
