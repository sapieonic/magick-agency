/**
 * **NEW.** Super-admin management of per-tenant carrier credentials (bring-your-own-
 * carrier; decisions B18–B22). Only super-admins manage them; tenants never see the
 * secret, and neither does the super-admin after saving it: the secret is write-only,
 * and every read carries a four-character hint instead.
 *
 * Routes (all under `/super-admin`, super-admin JWT):
 *  - `GET    /telephony-credential-providers`            → `TelephonyCredentialProvidersResponse`
 *  - `GET    /telephony-credentials?tenant_id&provider&include_revoked` → `TelephonyCredentialsResponse`
 *  - `GET    /telephony-credentials/:id`                 → `TelephonyCredentialDetailResponse`
 *  - `POST   /telephony-credentials`                     `CreateTelephonyCredentialBody` → 201 `TelephonyCredentialResponse`
 *  - `PATCH  /telephony-credentials/:id`                 `UpdateTelephonyCredentialBody` → `TelephonyCredentialResponse`
 *  - `PUT    /telephony-credentials/:id/secret`          `RotateTelephonyCredentialSecretBody` → `TelephonyCredentialResponse`
 *  - `POST   /telephony-credentials/:id/verify`          → `TelephonyCredentialResponse`
 *  - `POST   /telephony-credentials/:id/disable`         → `TelephonyCredentialResponse`
 *  - `POST   /telephony-credentials/:id/enable`          → `TelephonyCredentialResponse`
 *  - `POST   /telephony-credentials/:id/revoke`          → `TelephonyCredentialResponse`
 *  - `POST   /telephony-credentials/:id/sync-numbers`    → `TelephonyCredentialSyncNumbersResponse`
 *
 * Number sync: the carrier account's voice numbers become the tenant's numbers. Each is
 * added to the phone inventory pinned to the credential and assigned to the
 * credential's tenant with no account tag, so every account of the tenant may use it as
 * a caller ID (a credential serves every account of its tenant, B20); a super-admin may
 * still narrow one to some accounts with the existing account tags. A number already in
 * the inventory on another credential or on the service's own account is reported as a
 * conflict and left alone; the credential's numbers the account no longer lists are
 * retired, never deleted. Only an `active` credential syncs.
 *
 * Errors are `{ error: TelephonyCredentialErrorCode, message, details? }`; `details`
 * lists field paths and messages, never submitted values.
 */

import type { AllListed } from '../../primitives';

export type TelephonyCredentialStatus = 'active' | 'disabled' | 'invalid' | 'revoked';

/** A credential as every read returns it. No secret material. */
export interface TelephonyCredential {
  id: string;
  tenant_id: string;
  provider: string;
  label: string;
  status: TelephonyCredentialStatus;
  /** The carrier's public account id (Plivo: auth_id). */
  account_ref: string;
  public_config: Record<string, unknown>;
  secret_version: number;
  /** Last four characters of the current secret; null once shredded. */
  secret_hint: string | null;
  verified_at: string | null;
  last_error: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  shredded_at: string | null;
}

export interface TelephonyCredentialUsage {
  /** Live (draft, running, paused, stopping) campaigns pinned to the credential. While any exist it cannot be revoked. */
  campaigns: number;
  /** Calls still in flight on it. */
  in_flight_calls: number;
}

/** One field of a provider's credential form. */
export interface TelephonyCredentialField {
  key: string;
  label: string;
  /** True for the secret part: rendered as a password input, never echoed back. */
  secret: boolean;
  help?: string;
}

/** A carrier that accepts tenant credentials, and the fields its form needs. */
export interface TelephonyCredentialProvider {
  provider: string;
  display_name: string;
  fields: TelephonyCredentialField[];
}

export interface TelephonyCredentialProvidersResponse {
  providers: TelephonyCredentialProvider[];
  /** False when the server has no credential keyring: every write is refused. */
  store_available: boolean;
}

export interface TelephonyCredentialsResponse {
  credentials: TelephonyCredential[];
}

export interface TelephonyCredentialResponse {
  credential: TelephonyCredential;
}

export interface TelephonyCredentialDetailResponse {
  credential: TelephonyCredential;
  usage: TelephonyCredentialUsage;
}

export interface CreateTelephonyCredentialBody {
  tenant_id: string;
  provider: string;
  label: string;
  /** Every field of the provider's form, public and secret, keyed by `field.key`. */
  fields: Record<string, string>;
}

export interface UpdateTelephonyCredentialBody {
  label: string;
}

export interface RotateTelephonyCredentialSecretBody {
  /** The provider's secret fields only, keyed by `field.key`. */
  fields: Record<string, string>;
  /** The `secret_version` the form was opened at; a concurrent rotation answers 409. */
  expected_version: number;
}

/** Why a number the carrier listed was not taken into the inventory at all. */
export type TelephonyNumberSyncSkipReason =
  /** The carrier says the number cannot carry voice calls. */
  | 'not_voice'
  /** Not a phone number once normalised to E.164. */
  | 'invalid_number'
  /**
   * On the carrier's list, but another account's: a main account lists the numbers it
   * has transferred to its subaccounts. Never claimed by this credential.
   */
  | 'other_account';

/** Why a listed voice number was not taken into this credential's inventory. */
export type TelephonyNumberSyncConflictReason =
  /** Already in the inventory on another credential, or on the service's own account. Never taken over. */
  | 'registered_elsewhere'
  /** This credential's number, deleted by a super-admin: a sync does not bring it back. */
  | 'deleted';

/** What one sync did. Numbers are E.164 (`+…`); `skipped` echoes the carrier's spelling. */
export interface TelephonyCredentialNumberSync {
  /** Numbers the carrier listed on the account, voice or not. */
  listed: number;
  added: string[];
  /** The credential's numbers that had been retired and are on the account again. */
  reactivated: string[];
  unchanged: string[];
  /** The credential's numbers no longer on the account: retired, never deleted. */
  retired: string[];
  skipped: Array<{ number: string; reason: TelephonyNumberSyncSkipReason }>;
  conflicts: Array<{ phone_number: string; reason: TelephonyNumberSyncConflictReason }>;
  /** The credential's active numbers after the sync: what its campaigns may use as caller IDs. */
  active_numbers: number;
}

export interface TelephonyCredentialSyncNumbersResponse {
  credential: TelephonyCredential;
  sync: TelephonyCredentialNumberSync;
}

/**
 * Why a credential route refused.
 *
 * - `credential_store_unavailable` (503): the server has no credential keyring. Retry
 *   once it is configured.
 * - `secret_unavailable` (409): the store is configured, but this credential's stored
 *   secret cannot be used: shredded, missing, or sealed under a master key the keyring
 *   no longer holds. Retrying does not help; rotate the secret or restore the key.
 * - `version_conflict` (409): the credential changed (a rotation, or a status change)
 *   while the request was in flight. Re-read it and try again.
 * - `credential_not_active` (409): numbers are synced only from an `active` credential.
 * - `too_many_numbers` (422): the account lists more numbers than one sync reads, so the
 *   list is incomplete and nothing was changed (a partial list would retire numbers that
 *   are still on the account).
 */
export type TelephonyCredentialErrorCode =
  | 'credential_store_unavailable'
  | 'secret_unavailable'
  | 'unknown_provider'
  | 'invalid_input'
  | 'tenant_not_found'
  | 'not_found'
  | 'duplicate_account'
  | 'duplicate_label'
  | 'carrier_rejected'
  | 'carrier_unreachable'
  | 'version_conflict'
  | 'invalid_transition'
  | 'in_use'
  | 'credential_not_active'
  | 'too_many_numbers';

/** Runtime list of {@link TelephonyCredentialErrorCode}, in declaration order. */
export const TELEPHONY_CREDENTIAL_ERROR_CODES = [
  'credential_store_unavailable',
  'secret_unavailable',
  'unknown_provider',
  'invalid_input',
  'tenant_not_found',
  'not_found',
  'duplicate_account',
  'duplicate_label',
  'carrier_rejected',
  'carrier_unreachable',
  'version_conflict',
  'invalid_transition',
  'in_use',
  'credential_not_active',
  'too_many_numbers',
] as const satisfies readonly TelephonyCredentialErrorCode[];

const _allTelephonyCredentialErrorCodesListed: AllListed<
  TelephonyCredentialErrorCode,
  typeof TELEPHONY_CREDENTIAL_ERROR_CODES
> = true;
void _allTelephonyCredentialErrorCodesListed;

export interface TelephonyCredentialError {
  error: TelephonyCredentialErrorCode;
  message: string;
  details?: Array<{ path: string; message: string }>;
}
