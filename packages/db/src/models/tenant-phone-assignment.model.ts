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
