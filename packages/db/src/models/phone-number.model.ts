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
