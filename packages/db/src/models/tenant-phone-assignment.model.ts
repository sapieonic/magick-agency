export interface TenantPhoneAssignmentRecord {
  id: string;
  tenant_id: string;
  phone_number_id: string;
  is_default: boolean;
  assigned_by: string | null;
  assigned_at: Date;
  // Joined fields
  phone_number?: string;
  provider_name?: string;
  provider_display_name?: string;
  label?: string;
  max_concurrent_calls?: number;
  capabilities?: string[];
  region?: string;
  /**
   * The tenant carrier credential the number was synced from (0018); null = the
   * service's own account. It decides the carrier account a call from this number
   * dials on.
   */
  telephony_credential_id?: string | null;
}

export interface PhoneAccountTagRecord {
  id: string;
  assignment_id: string;
  account_id: string;
  is_default: boolean;
  tagged_by: string | null;
  tagged_at: Date;
  // Joined fields
  account_name?: string;
}
