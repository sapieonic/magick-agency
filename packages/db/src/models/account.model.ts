export interface AccountRecord {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  status: 'active' | 'suspended' | 'deleted';
  created_at: Date;
  updated_at: Date;
}

export interface CreateAccountInput {
  tenant_id: string;
  name: string;
  slug: string;
  settings?: Record<string, unknown>;
}

export interface UpdateAccountInput {
  name?: string;
  settings?: Record<string, unknown>;
  status?: 'active' | 'suspended';
}
