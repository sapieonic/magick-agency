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
 *
 * Errors are `{ error: TelephonyCredentialErrorCode, message, details? }`; `details`
 * lists field paths and messages, never submitted values.
 */

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

export type TelephonyCredentialErrorCode =
  | 'credential_store_unavailable'
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
  | 'in_use';

export interface TelephonyCredentialError {
  error: TelephonyCredentialErrorCode;
  message: string;
  details?: Array<{ path: string; message: string }>;
}
