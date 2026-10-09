import { ENDPOINTS } from '../config';
import type { TenantMember } from '../types/team';
import { apiFetch } from './client';

// PORT NOTE (magick-agency): cusui's `listTenants` (`GET /tenants`) and
// `updateTenant` (`PUT /tenants/:id`) are not ported — the session already
// carries the tenants, and tenant settings are the AI product's (lane A serves
// neither, PORTING.md A.1).

/** Backend returns flat membership objects with nested user. Reshape to { membership, user }. */
export async function listTenantMembers(tenantId: string): Promise<TenantMember[]> {
  interface RawMember {
    id: string;
    user_id: string;
    tenant_id: string;
    account_id: string | null;
    role: string;
    status: string;
    invited_by: string | null;
    created_at: string;
    updated_at: string;
    /**
     * Additive (ticket `14ygtkj7tbx`): has this PERSON completed Firebase
     * sign-in, or is their stored identity still the placeholder stub master
     * writes when it invites an address it has never seen. One rule for every
     * role, and a fact about the user rather than about this workspace's
     * invitation — see the docstring on `TenantMember` in `types/team.ts`,
     * which is where the consequences of that are written down.
     *
     * Absent against an older master. `listTenantMembers` below carries that
     * absence through unchanged rather than defaulting it, and that is load
     * bearing rather than tidiness: the two consumers resolve absence in
     * OPPOSITE directions (the badge claims neither state, while
     * `inviteNotKnownJoined` keeps Resend offered), so a default applied here
     * would silently pick one of them and break the other.
     *
     * Deliberately NOT `firebase_uid`: that is the field the stub check reads,
     * and the ticket forbids surfacing it (or the `pending_<uuid>` value
     * itself) in the browser. `invite_state` is master answering the question
     * server-side instead of handing this client the raw identity to inspect.
     */
    invite_state?: 'active' | 'pending';
    user: { id: string; email: string; display_name: string | null; avatar_url: string | null } | null;
  }
  const res = await apiFetch<{ members: RawMember[] }>(ENDPOINTS.tenants.members(tenantId), {}, tenantId);
  return res.members.map(m => {
    const { user, ...membership } = m;
    return {
      // `invite_state` is a top-level sibling of `role`/`status` on the wire,
      // so it rides into `membership` with the rest of the rest-spread. It is a
      // fact about the identity rather than about the membership row, but it
      // lands here because that is where the wire puts it and because `user`
      // is the half carrying `firebase_uid`, which is the thing this field
      // exists to answer without exposing. The `as` cast is what makes the
      // field's survival unprovable by the compiler — hence the direct test in
      // `src/__tests__/api/tenants.test.ts`.
      membership: membership as TenantMember['membership'],
      user: (user ?? { id: m.user_id, email: '', display_name: null, avatar_url: null, firebase_uid: '', status: 'active' as const, created_at: m.created_at, updated_at: m.updated_at }) as TenantMember['user'],
    };
  });
}
