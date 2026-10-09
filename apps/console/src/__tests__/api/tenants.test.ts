import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `listTenantMembers` — the reshape, and the one seam `invite_state` has to
 * survive.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * `GET /tenants/:id/members` answers flat rows with a nested `user`, and this
 * function turns each one into `{ membership, user }` with a rest-spread and an
 * `as` cast. The cast is the problem: it asserts the spread's result is a
 * `TenantMember['membership']`, so a field dropped, renamed or mis-nested in
 * that reshape is not a type error — it is a `undefined` at the render site.
 *
 * Nothing else in the suite covers it. Every TeamPage test mocks `useTeam` and
 * injects a fully-formed `TenantMember`, so all of them would stay green if
 * `invite_state` never made the crossing at all. These are the assertions that
 * would go red.
 *
 * ── What is pinned ─────────────────────────────────────────────────────────
 *  1. `invite_state` lands on `membership`, both `'pending'` and `'active'`.
 *  2. It lands there in the `user: null` branch too — that branch fabricates a
 *     user rather than spreading one, and is the arm most likely to be edited
 *     without the other.
 *  3. An absent field is carried through as ABSENT, not defaulted here. The two
 *     consumers treat absence differently (the badge shows neither state;
 *     `inviteNotKnownJoined` keeps Resend offered), so a default applied in the
 *     reshape would silently decide for both and break one.
 *  4. `user` does not leak into `membership` — the rest-spread's whole job, and
 *     the thing that would quietly put `firebase_uid` on the half this ticket
 *     forbids exposing.
 */

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  apiFetch: mocks.apiFetch,
}));

import { listTenantMembers } from '../../api/tenants';

/** One wire row, as master sends it: flat, with `user` nested and everything else top-level. */
function rawMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    user_id: 'user-1',
    tenant_id: 'tenant-1',
    account_id: null,
    role: 'agent',
    status: 'active',
    invited_by: null,
    created_at: '2026-06-07T00:00:00.000Z',
    updated_at: '2026-06-07T00:00:00.000Z',
    user: {
      id: 'user-1',
      email: 'priya@acme.com',
      display_name: null,
      avatar_url: null,
    },
    ...overrides,
  };
}

function respondWith(members: unknown[]): void {
  mocks.apiFetch.mockResolvedValue({ members });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listTenantMembers', () => {
  it('is tenant-scoped, and reads the members route', async () => {
    respondWith([]);

    await listTenantMembers('tenant-1');

    const [url, , tenantId] = mocks.apiFetch.mock.calls[0]!;
    expect(url).toMatch(/\/tenants\/tenant-1\/members$/);
    expect(tenantId).toBe('tenant-1');
  });

  it.each(['pending', 'active'] as const)(
    'carries invite_state=%s onto membership',
    async (state) => {
      respondWith([rawMember({ invite_state: state })]);

      const [member] = await listTenantMembers('tenant-1');

      expect(member!.membership.invite_state).toBe(state);
      // Beside its wire siblings, not instead of them.
      expect(member!.membership.role).toBe('agent');
      expect(member!.membership.status).toBe('active');
    },
  );

  it('carries invite_state even when the row has no user (the fabricated-user branch)', async () => {
    // Master answers `user: null` for a membership whose user row it could not
    // join. That arm builds a user from scratch instead of spreading one, so it
    // is the half of the reshape that can be edited on its own.
    respondWith([rawMember({ user: null, invite_state: 'pending' })]);

    const [member] = await listTenantMembers('tenant-1');

    expect(member!.membership.invite_state).toBe('pending');
    expect(member!.user.id).toBe('user-1');
    expect(member!.user.email).toBe('');
  });

  it('leaves an absent invite_state absent rather than defaulting it', async () => {
    // An older master sends no such key. `'invite_state' in membership` rather
    // than a `toBeUndefined()`, because a defaulted `undefined` written into
    // the object would pass the latter and is a different thing from the field
    // never having arrived.
    respondWith([rawMember()]);

    const [member] = await listTenantMembers('tenant-1');

    expect('invite_state' in member!.membership).toBe(false);
    expect(member!.membership.invite_state).toBeUndefined();
  });

  it('does not leave `user` on the membership half', async () => {
    // The rest-spread's job. `user` carries `firebase_uid` on the type, and the
    // ticket's one prohibition is that the browser never renders the stub uid —
    // leaking the nested object onto `membership` would put it one property
    // access away on the half nothing guards.
    respondWith([rawMember({ invite_state: 'active' })]);

    const [member] = await listTenantMembers('tenant-1');

    expect('user' in member!.membership).toBe(false);
    expect(member!.user.email).toBe('priya@acme.com');
  });
});
