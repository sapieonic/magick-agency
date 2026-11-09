/**
 * **NEW.** Inbound calls in the super-admin console (`docs/inbound.md` §8.1, IB6): a tenant
 * credential's inbound state (one Plivo Application on the tenant's account) and each synced
 * number's link to it. Only super-admins enable inbound and link numbers: both write to the
 * tenant's carrier account, which tenant admins cannot see (PL15).
 *
 * Routes (all under `/super-admin`, super-admin JWT; served beside the credential routes, through
 * the same carrier credential service, docs/seams.md §3.4):
 *  - `GET  /telephony-credentials/:id/inbound`           → `TelephonyCredentialInboundResponse`
 *  - `POST /telephony-credentials/:id/inbound/enable`    → `TelephonyCredentialInboundResponse`
 *  - `POST /telephony-credentials/:id/inbound/disable`   → `TelephonyCredentialInboundResponse`
 *  - `POST /telephony-credentials/:id/inbound/repoint`   → `TelephonyCredentialInboundResponse`
 *  - `GET  /telephony-credentials/:id/inbound/health`    → `TelephonyCredentialInboundHealthResponse`
 *  - `GET  /phone-numbers/:id/inbound`                   → `PhoneNumberInboundResponse`
 *  - `POST /phone-numbers/:id/inbound/link`              → `PhoneNumberInboundResponse`
 *  - `POST /phone-numbers/:id/inbound/unlink`            → `PhoneNumberInboundResponse`
 * Refusals are the credential routes' (`TelephonyCredentialErrorCode`, its inbound codes).
 *
 * Every write is audited in `super_admin_audit_log` with one of
 * {@link INBOUND_SUPER_ADMIN_AUDIT_ACTIONS}: ids, the app id and numbers only, never a token or
 * a URL's query.
 */

/**
 * The credential's Application compared with what we stored (§3.1, "health check"): `ok`, the
 * Application exists and its answer, hangup and fallback answer URLs are the stored ones;
 * `url_mismatch`, it exists but someone changed a URL in the carrier's console (Re-point fixes
 * it); `app_missing`, the carrier has no such Application any more; `unreachable`, the carrier
 * could not be asked (network, timeout, 5xx), which says nothing about the Application.
 */
export const TELEPHONY_CREDENTIAL_INBOUND_HEALTH = ['ok', 'url_mismatch', 'app_missing', 'unreachable'] as const;
export type TelephonyCredentialInboundHealth = (typeof TELEPHONY_CREDENTIAL_INBOUND_HEALTH)[number];

/** Which stored URL a `url_mismatch` is about. */
export const TELEPHONY_CREDENTIAL_INBOUND_URLS = ['answer_url', 'hangup_url', 'fallback_answer_url'] as const;
export type TelephonyCredentialInboundUrl = (typeof TELEPHONY_CREDENTIAL_INBOUND_URLS)[number];

/** A credential's inbound state, as stored. */
export interface TelephonyCredentialInbound {
  enabled: boolean;
  /** The carrier's Application id. NULL when not enabled. */
  app_id: string | null;
  enabled_at: string | null;
  /** The credential's numbers linked to the Application now. */
  linked_numbers: number;
  /** Until when the token a Re-point replaced is still accepted (calls answered before it). NULL: none is. */
  previous_token_expires_at: string | null;
}

/** One health check of the Application (not stored: asked of the carrier when shown). */
export interface TelephonyCredentialInboundHealthCheck {
  health: TelephonyCredentialInboundHealth;
  /** Only with `url_mismatch`: the URLs that differ from the stored ones. */
  mismatched: TelephonyCredentialInboundUrl[];
  /**
   * Whether the stored URLs are the ones this server would give the carrier now. False after the
   * deployment's public callback base or the fallback answer URL setting changed: the carrier
   * still calls the old ones until a Re-point.
   */
  stored_urls_current: boolean;
  checked_at: string;
}

/** A synced number's link to its credential's inbound Application. */
export interface PhoneNumberInboundLink {
  linked: boolean;
  linked_at: string | null;
  /** The carrier app the number pointed at before linking, restored by Unlink. NULL: none. */
  previous_app_id: string | null;
  /** The account route answering the number, when one does (the account's to set). */
  route: { id: string; name: string; account_id: string } | null;
}

/**
 * What inbound writes to `super_admin_audit_log` (§9). The credential's: enabled (Application
 * created), disabled (Application deleted, every number unlinked first), re-pointed (its URLs
 * and token replaced). The number's: linked, unlinked (by hand or by the §8.2 cascade, with
 * `details.cause`).
 */
export const INBOUND_SUPER_ADMIN_AUDIT_ACTIONS = [
  'telephony_credential.inbound_enabled',
  'telephony_credential.inbound_disabled',
  'telephony_credential.inbound_repointed',
  'phone_number.inbound_linked',
  'phone_number.inbound_unlinked',
] as const;
export type InboundSuperAdminAuditAction = (typeof INBOUND_SUPER_ADMIN_AUDIT_ACTIONS)[number];

/** Why a number cannot be linked now (`PhoneNumberInboundResponse.link_blocker`). */
export const PHONE_NUMBER_INBOUND_BLOCKERS = [
  /** On the service's own carrier account: only a number synced from a tenant credential can be. */
  'not_synced',
  /** Retired or deleted. */
  'not_active',
  /** Not assigned to its credential's tenant (unassigned since the sync). */
  'not_assigned',
  /** Its credential is disabled, invalid or revoked. */
  'credential_not_active',
  /** Its credential has no inbound Application yet (Enable inbound on the credential first). */
  'inbound_not_enabled',
] as const;
export type PhoneNumberInboundBlocker = (typeof PHONE_NUMBER_INBOUND_BLOCKERS)[number];

/** One of a credential's synced numbers, with its inbound link (the credential page's list). */
export interface TelephonyCredentialInboundNumber {
  phone_number_id: string;
  /** E.164. */
  phone_number: string;
  status: 'active' | 'retired' | 'deleted';
  /** Assigned to the credential's tenant. */
  assigned: boolean;
  link: PhoneNumberInboundLink;
}

/** A credential's inbound state and its numbers. Every inbound credential route answers it. */
export interface TelephonyCredentialInboundResponse {
  inbound: TelephonyCredentialInbound;
  /**
   * Whether this server can give the carrier inbound URLs (`PLIVO_WEBHOOK_BASE_URL` is set).
   * False: Enable and Re-point are refused (`inbound_unconfigured`).
   */
  webhook_base_configured: boolean;
  /**
   * Whether this deployment puts inbound callers through to agents. False with media workers on
   * (`MEDIA_WORKERS > 0`, IB8): calls are still answered, but every open route's caller hears the
   * call-back message and nobody is connected (docs/inbound.md §3.2).
   */
  connects_agents: boolean;
  /** The credential's numbers that are not deleted, by number. */
  numbers: TelephonyCredentialInboundNumber[];
}

export interface TelephonyCredentialInboundHealthResponse {
  inbound: TelephonyCredentialInbound;
  health: TelephonyCredentialInboundHealthCheck;
}

/** A number's inbound link, and whether it can be linked now (the numbers page). */
export interface PhoneNumberInboundResponse {
  phone_number_id: string;
  phone_number: string;
  link: PhoneNumberInboundLink;
  /** The credential the number was synced from; null for a number on the service's own account. */
  credential: { id: string; label: string; status: string; inbound_enabled: boolean } | null;
  /** Why Link is refused now; null when it would be accepted (or the number is linked already). */
  link_blocker: PhoneNumberInboundBlocker | null;
  /**
   * The number's open Missed rows that reached no account (docs/inbound.md §8.3: no route answers
   * the number and the caller matched no contact). No console screen lists them, so the operator
   * sees them here. Null for a number on the service's own account (never answered here).
   */
  unrouted_missed: PhoneNumberUnroutedMissed | null;
}

/** A number's tenant-default Missed rows still open: how many, and the latest. */
export interface PhoneNumberUnroutedMissed {
  open: number;
  /** ISO time of the latest; null when there is none. */
  latest_at: string | null;
  /** The latest caller's number (+E.164); null when withheld, or when there is none. */
  latest_from: string | null;
}
