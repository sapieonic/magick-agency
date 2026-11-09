export interface PhoneNumberRecord {
  id: string;
  phone_number: string;
  provider_id: string;
  label: string | null;
  capabilities: string[];
  region: string | null;
  max_concurrent_calls: number;
  status: 'active' | 'retired' | 'deleted';
  // When true, this number is part of the signup pool and may be auto-assigned
  // to brand-new tenants by `findLeastAssigned()`. When false (the default) the
  // number is "dedicated": it can only ever be assigned manually by a super
  // admin and is never handed to an unverified signup.
  pool_eligible: boolean;
  /**
   * The tenant carrier credential this number was synced from (BYOC, B18; 0019).
   * NULL = a number on the service's own account, added by a super-admin. Written only
   * by `syncForCredential`.
   */
  telephony_credential_id: string | null;
  /**
   * When a super-admin linked the number to its credential's inbound Application (IB6; 0024).
   * NULL: not linked. Only a synced number (`telephony_credential_id` set) can be linked.
   */
  inbound_linked_at: Date | null;
  /** The carrier app the number pointed at before linking, restored by Unlink. NULL: none, or not linked. */
  inbound_previous_app_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  // Joined fields (optional, from provider join)
  provider_name?: string;
  provider_display_name?: string;
}

export interface CreatePhoneNumberInput {
  phone_number: string;
  provider_id: string;
  label?: string;
  capabilities?: string[];
  region?: string;
  max_concurrent_calls: number;
  notes?: string;
  created_by?: string;
  pool_eligible?: boolean;
}

export interface UpdatePhoneNumberInput {
  label?: string;
  notes?: string;
  status?: 'active' | 'retired' | 'deleted';
  max_concurrent_calls?: number;
  pool_eligible?: boolean;
}

/** One number the carrier lists on a credential's account, normalised to E.164. */
export interface SyncedNumberInput {
  phone_number: string;
  /** The carrier's alias for it, used as the label of a NEW row only. */
  label: string | null;
}

/** Why a listed number was not taken into the credential's inventory. */
export type NumberSyncConflictReason =
  /**
   * Already in the inventory on another credential (other than a revoked registration of
   * the same carrier account, which a sync takes over), or on the service's own account.
   */
  | 'registered_elsewhere'
  /**
   * This credential's (or a revoked registration's of the same account), but a super-admin
   * deleted it: a sync does not bring it back.
   */
  | 'deleted';

/**
 * A live campaign on a tenant credential that still names one of the credential's numbers
 * that is no longer `active` (retired or deleted) as a caller ID. Such a number is never
 * dialled (PL13); the campaign is listed so the operator can tell the tenant.
 */
export interface CampaignHoldingInactiveNumbers {
  campaign_id: string;
  campaign_name: string;
  account_id: string;
  account_name: string;
  status: string;
  /** The campaign's caller IDs that are this credential's numbers and not active, sorted. */
  caller_ids: string[];
}

export interface NumberSyncResult {
  /** Numbers inserted into the inventory. */
  added: string[];
  /** This credential's numbers that were retired and are on the account again. */
  reactivated: string[];
  /**
   * Numbers that were pinned to a revoked credential of the same tenant and carrier account
   * (the account registered again), now pinned to this one and `active`.
   */
  taken_over: string[];
  /** This credential's numbers already active. */
  unchanged: string[];
  /** This credential's numbers no longer on the account, now `retired` (never deleted). */
  retired: string[];
  conflicts: Array<{ phone_number: string; reason: NumberSyncConflictReason }>;
  /** The credential's active numbers after the sync. */
  active: number;
}
