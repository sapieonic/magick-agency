// Per-tenant carrier credentials (BYOC, decisions B18–B22; 0002_telephony_credentials.sql).
//
// `TelephonyCredentialRecord` carries no secret material and is what every listing and
// API path reads. The sealed secrets are separate rows (`TelephonyCredentialSecretRecord`,
// one per version) read only by the server's credential resolver.

export type TelephonyCredentialStatus = 'active' | 'disabled' | 'invalid' | 'revoked';

export interface TelephonyCredentialRecord {
  id: string;
  tenant_id: string;
  provider: string;
  label: string;
  status: TelephonyCredentialStatus;
  /** The carrier's public account id (Plivo: auth_id). Not secret. */
  account_ref: string;
  public_config: Record<string, unknown>;
  /** The current secret version. */
  secret_version: number;
  /** Last four characters of the current secret; null once shredded. */
  secret_hint: string | null;
  verified_at: Date | null;
  last_error: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
  shredded_at: Date | null;
}

/** One sealed secret version. Each blob is nonce ‖ ciphertext ‖ tag. */
export interface TelephonyCredentialSecretRecord {
  credential_id: string;
  secret_version: number;
  secret_ciphertext: Buffer;
  wrapped_dek: Buffer;
  /** Scheme-prefixed master key id, e.g. `env:v1`. */
  kek_id: string;
  created_at: Date;
  /** Null for the current version; set when a rotation superseded it. */
  retired_at: Date | null;
}

/** A sealed secret as the server hands it over to be stored. */
export interface SealedSecretInput {
  secret_ciphertext: Buffer;
  wrapped_dek: Buffer;
  kek_id: string;
  /** Last four characters of the plaintext, for the console. */
  secret_hint: string;
}

export interface CreateTelephonyCredentialInput {
  /** Chosen by the caller: the seal binds the row id, so it exists before the INSERT. */
  id: string;
  tenant_id: string;
  provider: string;
  label: string;
  account_ref: string;
  public_config: Record<string, unknown>;
  /** Sealed for `secret_version = 1`. */
  sealed: SealedSecretInput;
  created_by: string;
  /** Set when the carrier accepted the credential before it was stored. */
  verified_at: Date | null;
}
