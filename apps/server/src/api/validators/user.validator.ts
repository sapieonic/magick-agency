import { z } from 'zod';

// `agent` (Agency Dialer) is accepted here so an account_admin can
// staff a dialing floor. It sits below `viewer` in ROLE_HIERARCHY, so granting
// it widens nothing — see `src/rbac/roles.ts`. `tenant_owner` remains
// un-assignable through the customer surface (it is set at signup only).
export const inviteUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(['account_admin', 'operator', 'viewer', 'agent']),
  account_id: z.string().uuid().optional(),
});

export const updateRoleSchema = z.object({
  role: z.enum(['tenant_admin', 'account_admin', 'operator', 'viewer', 'agent']),
});

export type InviteUserRequest = z.infer<typeof inviteUserSchema>;
export type UpdateRoleRequest = z.infer<typeof updateRoleSchema>;
