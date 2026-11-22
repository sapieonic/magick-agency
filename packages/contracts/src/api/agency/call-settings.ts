/**
 * The account's call settings (docs/call-log.md §5), served under `/proxy/agency/call-settings`:
 * the setting "Every call must belong to a campaign" (wire `require_campaign`), what stands in the
 * way of switching it on, and how many calls were not filed under a campaign lately.
 *
 *  - `GET /call-settings`   `agency.calls.manage` → {@link AgencyCallSettingsResponse}
 *  - `PUT /call-settings`   `agency.calls.manage`, {@link AgencyCallSettingsUpdateRequest} →
 *    {@link AgencyCallSettingsResponse}; `422 default_campaign_required` (the inbound family's
 *    code, `routes` naming them) when it is switched on while a live inbound route of the account
 *    has no campaign for unknown callers.
 *  - `GET /campaigns/:id/inbound-default-routes`   `agency.supervise` →
 *    {@link AgencyCampaignInboundDefaultRoutesResponse}: the live routes that file unknown callers
 *    under the campaign, asked before it is stopped or archived.
 *
 * None is behind the soft phone's or inbound's flag: the rule is the account's, over both.
 */

/** The account's call settings. An account that never saved them reads as the defaults (off). */
export interface AgencyCallSettings {
  /** Every call must belong to a campaign. */
  require_campaign: boolean;
  /**
   * ISO-8601: when it was last switched on; NULL while it is off. A call that began before it
   * may finish as it is.
   */
  require_campaign_since: string | null;
  /** ISO-8601; NULL when the account has no row yet. */
  updated_at: string | null;
}

/** An inbound route, by id and name. */
export interface AgencyCallSettingsRouteRef {
  route_id: string;
  name: string;
}

/** A person, by id and display name (NULL when the user row is gone). */
export interface AgencyCallSettingsAgentRef {
  user_id: string;
  name: string | null;
}

/** How many of the agents on no running campaign are named (`agents_without_campaign`). */
export const AGENCY_CALL_SETTINGS_AGENTS_MAX = 20;

/** How far back `unfiled_calls` counts, in days. */
export const AGENCY_CALL_SETTINGS_UNFILED_DAYS = 30;

/** What the Settings › Calls page shows beside the switch. */
export interface AgencyCallSettingsReadiness {
  /**
   * The account's live inbound routes with no campaign for unknown callers. While there is one
   * the setting cannot be switched on. Empty with no route at all.
   */
  routes_missing_default: AgencyCallSettingsRouteRef[];
  /**
   * The account's agents (active members whose role cannot log a call to any campaign, as a
   * supervisor's can) who are on no running or paused campaign: with the setting on they cannot
   * dial from the soft phone. Information only; it blocks nothing. At most
   * {@link AGENCY_CALL_SETTINGS_AGENTS_MAX} named, by name; `agents_without_campaign_total` counts
   * them all.
   */
  agents_without_campaign: AgencyCallSettingsAgentRef[];
  agents_without_campaign_total: number;
  /**
   * Calls of the last {@link AGENCY_CALL_SETTINGS_UNFILED_DAYS} days in this account filed under
   * no campaign: soft-phone calls that were dialled with none, and inbound calls we served with
   * none (a call turned away unserved is not counted).
   */
  unfiled_calls: number;
}

/** `GET /call-settings` and `PUT /call-settings`. */
export interface AgencyCallSettingsResponse {
  settings: AgencyCallSettings;
  readiness: AgencyCallSettingsReadiness;
}

/** `PUT /call-settings`. */
export interface AgencyCallSettingsUpdateRequest {
  require_campaign: boolean;
}

/** `GET /campaigns/:id/inbound-default-routes`. */
export interface AgencyCampaignInboundDefaultRoutesResponse {
  /** The account's live inbound routes whose campaign for unknown callers is this campaign, by name. */
  routes: AgencyCallSettingsRouteRef[];
}
