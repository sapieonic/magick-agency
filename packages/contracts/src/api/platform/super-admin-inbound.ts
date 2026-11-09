/**
 * **NEW.** Inbound calls in the super-admin console (`docs/inbound.md` §8.1, IB6): a tenant
 * credential's inbound state (one Plivo Application on the tenant's account) and each synced
 * number's link to it. Only super-admins enable inbound and link numbers: both write to the
 * tenant's carrier account, which tenant admins cannot see (PL15).
 *
 * These are the shapes the credential and number screens read; which routes serve them (and
 * whether they ride on `TelephonyCredential` / `PhoneNumber` or come on their own) is the
 * super-admin slice's to decide. Every write is audited in `super_admin_audit_log` with one of
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
}

/** One health check of the Application (not stored: asked of the carrier when shown). */
export interface TelephonyCredentialInboundHealthCheck {
  health: TelephonyCredentialInboundHealth;
  /** Only with `url_mismatch`: the URLs that differ from the stored ones. */
  mismatched: TelephonyCredentialInboundUrl[];
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
