export type FlagScopeType = 'global' | 'tenant' | 'account';

/** A sparse override row — exists solely to deviate from the registry default. */
export interface FeatureFlagOverrideRecord {
  id: string;
  flag_key: string;
  scope_type: FlagScopeType;
  /** NULL for global scope. */
  tenant_id: string | null;
  /** Non-NULL only for account scope. */
  account_id: string | null;
  /** Typed JSONB value: boolean | number | string | object. */
  value: unknown;
  reason: string | null;
  expires_at: Date | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertFeatureFlagOverrideInput {
  flag_key: string;
  scope_type: FlagScopeType;
  /** Required for tenant + account scope; omit/null for global. */
  tenant_id?: string | null;
  /** Required (and only) for account scope. */
  account_id?: string | null;
  value: unknown;
  reason?: string | null;
  expires_at?: Date | null;
  updated_by?: string | null;
}

export interface DeleteFeatureFlagOverrideInput {
  flag_key: string;
  scope_type: FlagScopeType;
  tenant_id?: string | null;
  account_id?: string | null;
}
