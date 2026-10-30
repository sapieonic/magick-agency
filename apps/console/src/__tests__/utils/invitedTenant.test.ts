import { describe, it, expect } from 'vitest';
import { invitedTenantId } from '../../utils/invitedTenant';
import type { Membership, Tenant } from '../../types/auth';

/**
 * Which tenant a just-claimed invitation belongs to.
 *
 * The page tests drive this through a claim; these pin the edges of the rule
 * itself — in particular the two ways it must DECLINE rather than guess, because
 * a wrong answer here silently opens somebody's other workspace and calls it the
 * one they were invited to.
 */

const tenant = (id: string, name: string): Tenant => ({
  id,
  name,
  slug: id,
  settings: {},
  status: 'active',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
});

const membership = (
  tenant_id: string,
  role: Membership['role'],
  status: Membership['status'] = 'active',
): Membership => ({
  id: `m-${tenant_id}-${role}`,
  user_id: 'u1',
  tenant_id,
  account_id: null,
  role,
  status,
  invited_by: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
});

const INVITE = { role: 'operator' as const, tenant_name: 'Acme' };

describe('invitedTenantId', () => {
  it('answers a one-tenant session with that tenant, without inferring anything', () => {
    // A first-time invitee: the claim activated the only membership they have.
    expect(
      invitedTenantId({ tenants: [tenant('t-acme', 'Acme')], memberships: [] }, INVITE),
    ).toBe('t-acme');
  });

  it('picks the invited workspace out of several by role and name', () => {
    expect(
      invitedTenantId(
        {
          tenants: [tenant('t-home', 'Home'), tenant('t-acme', 'Acme')],
          memberships: [membership('t-home', 'tenant_owner'), membership('t-acme', 'operator')],
        },
        INVITE,
      ),
    ).toBe('t-acme');
  });

  it('uses the role alone when the invitation could not name its workspace', () => {
    // `tenant_name` is nullable on the wire; the role still narrows to one.
    expect(
      invitedTenantId(
        {
          tenants: [tenant('t-home', 'Home'), tenant('t-acme', 'Acme')],
          memberships: [membership('t-home', 'viewer'), membership('t-acme', 'operator')],
        },
        { ...INVITE, tenant_name: null },
      ),
    ).toBe('t-acme');
  });

  it('declines when two workspaces fit equally', () => {
    expect(
      invitedTenantId(
        {
          tenants: [tenant('t-a', 'Acme'), tenant('t-b', 'Acme')],
          memberships: [membership('t-a', 'operator'), membership('t-b', 'operator')],
        },
        INVITE,
      ),
    ).toBeNull();
  });

  it('declines a nameless invitation into a second workspace with the same role', () => {
    expect(
      invitedTenantId(
        {
          tenants: [tenant('t-a', 'Alpha'), tenant('t-b', 'Beta')],
          memberships: [membership('t-a', 'operator'), membership('t-b', 'operator')],
        },
        { ...INVITE, tenant_name: null },
      ),
    ).toBeNull();
  });

  it('ignores a membership that is not active', () => {
    // A revoked membership in a same-named tenant is not where a claim landed.
    expect(
      invitedTenantId(
        {
          tenants: [tenant('t-old', 'Acme'), tenant('t-acme', 'Acme')],
          memberships: [membership('t-old', 'operator', 'revoked'), membership('t-acme', 'operator')],
        },
        INVITE,
      ),
    ).toBe('t-acme');
  });

  it('declines rather than throws on a session with no lists at all', () => {
    expect(
      invitedTenantId({ tenants: undefined, memberships: undefined } as never, INVITE),
    ).toBeNull();
  });
});
