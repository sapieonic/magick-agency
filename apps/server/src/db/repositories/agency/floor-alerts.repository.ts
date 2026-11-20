/**
 * `AgencyFloorAlertsRepository`: the rows behind the supervisors' alerts read (agent station AS16:
 * BE-10, BE-11, AS12; `GET /proxy/agency/floor/alerts`, the wire in
 * `packages/contracts/src/api/agency/floor.ts`). Polled every 5 s by every supervisor tab, so two
 * small statements, both tenant and account scoped, run together:
 *
 *  - {@link FLOOR_ALERTS_HELP_SQL}: the account's open Need help requests on open sessions, by the
 *    rule every read applies (`helpOpenSql`: raised, not answered, fresh on the database's clock),
 *    on `idx_agency_agent_sessions_help_open` (0052), whose predicate `HELP_OPEN_SQL` (inside
 *    `helpOpenSql`) repeats byte for byte.
 *  - {@link FLOOR_ALERTS_SESSIONS_SQL}: the account's open sessions that could be a break or a
 *    disconnect alert: every one on a break (with its campaign's catalog, so the caller judges the
 *    limit as the floor does), and the ones whose station the caller knows went (`$3`, the station
 *    detach times held in memory: `agency/station-detach-times.ts`), each with the state it left for
 *    `offline` when its row says `offline` (the station's close writes `offline` for an agent who
 *    was not on a call: the transition log's last `→ offline` event says what they were doing). On
 *    `uq_agency_agent_live_tenant` (by tenant, the account filtered), as the floor's open sessions;
 *    the last event on `idx_agency_session_events_agent` (the agent's events, newest first), only
 *    for those rows.
 *
 * The judging (the limit, the 20 seconds, the ids) is the caller's (`agency/floor-alerts.ts`).
 */
import { getPool } from '@magick-agency/db';
import type {
  AgencyAgentLiveState,
  AgencyAgentState,
  AgencyBreakReason,
  AgencyClientKind,
} from '@magick-agency/contracts/agency';
import { helpOpenSql } from './sql-fragments.js';

/** An open Need help request, as the alerts read takes it. */
export interface FloorAlertHelpRow {
  session_id: string;
  agent_user_id: string;
  /** Null for a soft-phone session. */
  campaign_id: string | null;
  campaign_name: string | null;
  raised_at: Date;
  call_id: string | null;
  /** The agent's state at the raise (0059); null on a request raised before it was recorded. */
  state: AgencyAgentState | null;
}

/** An open session that may be on a break past its limit, or whose station went. */
export interface FloorAlertSessionRow {
  session_id: string;
  agent_user_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  /** The campaign's catalog as stored (`[]`: the built-ins); null without a campaign. */
  break_reasons: AgencyBreakReason[] | null;
  state: AgencyAgentLiveState;
  state_since: Date;
  /** Only while `state = 'break'`. */
  break_reason: string | null;
  client_kind: AgencyClientKind;
  /**
   * When the row is `offline` and the session is one of `$3`: the state its last `→ offline`
   * transition left (what the agent was doing when the station went); otherwise null.
   */
  left_state: AgencyAgentState | null;
}

/** $1 tenant, $2 account, $3 the Need help expiry in ms. Exported for its plan test. */
export const FLOOR_ALERTS_HELP_SQL = `
  SELECT s.id AS session_id, s.agent_user_id, s.campaign_id, cam.name AS campaign_name,
         s.help_raised_at AS raised_at, s.help_call_id AS call_id, s.help_state AS state
    FROM agency_agent_sessions s
    LEFT JOIN agency_campaigns cam ON cam.id = s.campaign_id AND cam.tenant_id = $1::uuid
   WHERE s.tenant_id = $1::uuid AND s.account_id = $2::uuid AND s.left_at IS NULL
     AND ${helpOpenSql('$3')}`;

/** $1 tenant, $2 account, $3 the sessions whose station went (uuid[]). Exported for its plan test. */
export const FLOOR_ALERTS_SESSIONS_SQL = `
  SELECT s.id AS session_id, s.agent_user_id, s.campaign_id, cam.name AS campaign_name, cam.break_reasons,
         s.state, s.state_since,
         CASE WHEN s.state = 'break' THEN s.break_reason END AS break_reason,
         s.client_kind,
         went.from_state AS left_state
    FROM agency_agent_sessions s
    LEFT JOIN agency_campaigns cam ON cam.id = s.campaign_id AND cam.tenant_id = $1::uuid
    LEFT JOIN LATERAL (
      SELECT e.from_state
        FROM agency_agent_session_events e
       WHERE s.state = 'offline' AND s.id = ANY($3::uuid[])
         AND e.agent_user_id = s.agent_user_id AND e.session_id = s.id AND e.to_state = 'offline'
       ORDER BY e.at DESC
       LIMIT 1
    ) went ON true
   WHERE s.tenant_id = $1::uuid AND s.account_id = $2::uuid AND s.left_at IS NULL
     AND (s.state = 'break' OR s.id = ANY($3::uuid[]))`;

export class AgencyFloorAlertsRepository {
  /** The account's open Need help requests on open sessions (`expiryMs`: `AGENCY_HELP_EXPIRY_MS`). */
  async openHelp(tenantId: string, accountId: string, expiryMs: number): Promise<FloorAlertHelpRow[]> {
    const { rows } = await getPool().query<FloorAlertHelpRow>(FLOOR_ALERTS_HELP_SQL, [tenantId, accountId, expiryMs]);
    return rows;
  }

  /** The account's open sessions on a break, and those of `goneSessionIds` (their station went). */
  async breakOrGoneSessions(tenantId: string, accountId: string, goneSessionIds: readonly string[]): Promise<FloorAlertSessionRow[]> {
    const { rows } = await getPool().query<FloorAlertSessionRow>(
      FLOOR_ALERTS_SESSIONS_SQL, [tenantId, accountId, [...goneSessionIds]],
    );
    return rows.map((r) => ({ ...r, client_kind: r.client_kind === 'mobile' ? 'mobile' : 'web' }));
  }
}

export const agencyFloorAlertsRepository = new AgencyFloorAlertsRepository();
