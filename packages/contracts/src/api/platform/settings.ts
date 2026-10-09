/**
 * Per-account settings — one row per account holding four facts:
 *
 * | Field | Meaning |
 * |---|---|
 * | `allow_recording` | whether campaigns on the account may record calls |
 * | `analyze_calls` | whether campaign calls may be analysed |
 * | `max_concurrent_calls` | the account's concurrency ceiling, written by the super-admin concurrency route |
 * | `webrtc_max_duration_seconds` | hard cap on a bridged human call (default 1800, range 60..14400) |
 *
 * Values are EFFECTIVE values, so on the wire every field is non-null: a stored
 * `null` meaning "inherit the env default" is resolved before it reaches a client.
 *
 * The section-level `agency` capability has no field: it is always on, because
 * the app *is* agency. Recording and analysis stay checked **per field** on
 * campaign writes — a campaign asking for `record_calls: true` on an
 * account whose `allow_recording` is false is refused, not silently downgraded.
 */
export interface AgencyAccountSettings {
  tenant_id: string;
  account_id: string;
  /**
   * Whether campaigns on this account may record human↔human calls. Successor
   *: default `false`, and that default is the
   * safe direction but is NOT a consent mechanism).
   */
  allow_recording: boolean;
  /** Whether campaign calls may be analysed. */
  analyze_calls: boolean;
  // There is no `analyze_dialer_calls` setting: its only reader was the bridge's
  // softphone-only gate, which agency calls already skip (docs/decisions.md Q3b).
  /**
   * The account's concurrency ceiling — a read-out on the supervisor surface
   * (`AgencyCampaignStats.concurrency_limit`), set by super-admins only.
   * The range for the legacy total is 1..1000.
   */
  max_concurrent_calls: number;
  /**
   * Hard cap on a bridged human call before auto-hangup, in whole seconds.
   * Default 1800; valid range 60..14400 (`WEBRTC_MAX_DURATION_SECONDS = 14_400`).
   */
  webrtc_max_duration_seconds: number;
  /** ISO-8601. */
  updated_at: string;
}

/**
 * The settings map the session payload carries, **keyed by `account_id`**, one
 * entry per account the caller's active memberships reach (every account in the
 * tenant for a tenant-wide membership). Replaces `SessionResponse.governance`,
 * which was a single `Record<string, boolean>` resolved for `memberships[0]`
 * only (the public API layer `src/auth/session-payload.ts`).
 */
export type AgencyAccountSettingsMap = Record<string, AgencyAccountSettings>;

/**
 * `PUT /super-admin/tenants/:tenantId/accounts/:accountId/settings` — NEW.
 * A PATCH: an omitted field keeps its value. `max_concurrent_calls` is set
 * through the concurrency route (`super-admin.ts`), not here, so the guard's
 * cache invalidation has exactly one writer.
 */
export interface UpdateAgencyAccountSettingsBody {
  allow_recording?: boolean;
  analyze_calls?: boolean;
  /** 60..14400. */
  webrtc_max_duration_seconds?: number;
  /** Recorded on the super-admin audit row. */
  reason?: string;
}

export interface AgencyAccountSettingsResponse {
  settings: AgencyAccountSettings;
}
