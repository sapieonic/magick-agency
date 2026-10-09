import { ENDPOINTS } from '../config';
import type { InviteUserInput, InviteUserResult, UpdateRoleInput } from '../types/team';
import { apiFetch } from './client';

/**
 * Create a membership (and, for a new address, a `pending_` stub user).
 *
 * The 201 body is TYPED AND RETURNED rather than discarded. The server reports
 * whether it managed to email the invitee (`invite_email`) and the link it would
 * have sent (`sign_in_url`); throwing that away is what would leave the hand-off
 * panel insisting nobody was emailed after a transport is wired up. See
 * {@link InviteUserResult}.
 */
export function inviteUser(tenantId: string, data: InviteUserInput): Promise<InviteUserResult> {
  return apiFetch(ENDPOINTS.users.invite, {
    method: 'POST',
    body: JSON.stringify(data),
  }, tenantId);
}

export function updateUserRole(tenantId: string, userId: string, data: UpdateRoleInput): Promise<void> {
  return apiFetch(ENDPOINTS.users.role(userId), {
    method: 'PUT',
    body: JSON.stringify(data),
  }, tenantId);
}

export function removeUserMembership(tenantId: string, userId: string): Promise<void> {
  return apiFetch(ENDPOINTS.users.membership(userId), {
    method: 'DELETE',
  }, tenantId);
}
