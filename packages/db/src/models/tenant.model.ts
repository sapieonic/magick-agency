export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  status: 'active' | 'suspended' | 'deleted';
  created_at: Date;
  updated_at: Date;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  settings?: Record<string, unknown>;
}

export interface UpdateTenantInput {
  name?: string;
  settings?: Record<string, unknown>;
  status?: 'active' | 'suspended';
}
