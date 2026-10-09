export interface SuperAdminRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  status: 'active' | 'inactive';
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateSuperAdminInput {
  email: string;
  password_hash: string;
  name: string;
}

/** SuperAdminRecord without password_hash — safe to return from API */
export type SafeSuperAdminRecord = Omit<SuperAdminRecord, 'password_hash'>;
