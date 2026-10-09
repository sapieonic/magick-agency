// `agent` is the Agency Dialer role. It sits BELOW `viewer` in
// ROLE_HIERARCHY, so it inherits nothing that existed before it — see the note
// on ROLE_HIERARCHY in `src/rbac/roles.ts`. Mirrored in the `membership_role`
// Postgres enum and in the console's `Role` union.
export type MembershipRole =
  | 'tenant_owner'
  | 'tenant_admin'
  | 'account_admin'
  | 'operator'
  | 'viewer'
  | 'agent';

export interface MembershipRecord {
  id: string;
  user_id: string;
  tenant_id: string;
  account_id: string | null;
  role: MembershipRole;
  status: 'active' | 'inactive' | 'revoked';
  invited_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMembershipInput {
  user_id: string;
  tenant_id: string;
  account_id?: string | null;
  role: MembershipRole;
  invited_by?: string;
}
