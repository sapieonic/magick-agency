/**
 * Per-account settings — the ONE row that replaces governance (extraction plan
 * §3.2).
 *
 * NEW in Magick Agency (no single source to port). In MagickVoice the same four
 * facts lived in four places, each with its own gate and its own copy:
 *
 * | Field | MagickVoice source |
 * |---|---|
 * | `allow_recording` | master governance `agency.recording` (catalog `agency.recording`), pushed into core `account_settings.allow_recording` |
 * | `analyze_calls` | master governance `agency.analytics`, pushed into core `account_settings.analyze_calls` |
 *  * | `max_concurrent_calls` | core `account_settings.max_concurrent_calls`, written by master's super-admin concurrency route |
 * | `webrtc_max_duration_seconds` | core feature flag `webrtc_max_duration_seconds` (`registry.ts:235`, default 1800, 60..14400) |
 *
 * Column names are core's (`magic-voice-core/src/db/models/account-settings.model.ts`)
 * so the cutover copy is a rename-free projection. Values are EFFECTIVE values
 * (plan §3.2 "Cutover copies **effective** values"), so on the wire every field
 * is non-null: core's `null` = "inherit the env default" is resolved before it
 * reaches a client.
 *
 * The section-level `agency` capability has no field: it is always on, because
 * the app *is* agency. Recording and analysis stay checked **per field** on
 * campaign writes (MAG-138) — a campaign asking for `record_calls: true` on an
 * account whose `allow_recording` is false is refused, not silently downgraded.
 */
export interface AgencyAccountSettings {
  tenant_id: string;
  account_id: string;
  /**
   * Whether campaigns on this account may record human↔human calls. Successor
   * of governance `agency.recording` (default `false`, and that default is the
   * safe direction but is NOT a consent mechanism — `docs/reference/magickvoice-platform/agency.md` §7.2).
   */
  allow_recording: boolean;
  /** Whether campaign calls may be analysed. Successor of governance `agency.analytics`. */
  analyze_calls: boolean;
  // Core's `analyze_dialer_calls` (migration 059) is NOT carried: its only
  // reader was the bridge's softphone-only gate 3, which core already skipped
  // for agency calls (lead decision Q3b, docs/decisions.md).
  /**
   * The account's concurrency ceiling — a read-out on the supervisor surface
   * (`AgencyCampaignStats.concurrency_limit`, D10), set by super-admins only.
   * Core's range for the legacy total is 1..1000
   * (`magick-master/src/api/routes/super-admin.routes.ts:1332-1334`).
   */
  max_concurrent_calls: number;
  /**
   * Hard cap on a bridged human call before auto-hangup, in whole seconds.
   * Core's flag default 1800; valid range 60..14400 (`isWebrtcMaxDuration`,
   * `registry.ts:104`, `WEBRTC_MAX_DURATION_SECONDS = 14_400`).
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
 * only (master `src/auth/session-payload.ts`).
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
