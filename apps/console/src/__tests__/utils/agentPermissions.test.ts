import { describe, it, expect } from 'vitest';
import { hasPermission, getRoleLevel } from '../../utils/permissions';
import type { Permission } from '../../utils/permissions';
import type { Role } from '../../types/auth';

/**
 * The `agent` role (Agency Dialer) mirrors the API's `ROLE_HIERARCHY` and sits
 * BELOW `viewer`, so it resolves to the four `agency.*` ACTION permissions,
 * plus `agency.flags.read`, and to nothing else. The fifth is
 * not an agency action: it floors at `agent` because the flag map is what the
 * SPA reads to render at all, and while it was gated on the `viewer`-floored
 * `proxy.stats.read` every agent 403'd on it and the fail-safe-closed flag
 * context refused all four dialer routes. These assertions are the client-side half of the same
 * invariant the API pins in `test/unit/rbac/roles.agent.test.ts` — if the two
 * hand-maintained tables drift, the UI starts showing controls the backend
 * 403s (or hiding ones it would allow).
 */

const AGENCY_PERMISSIONS: Permission[] = [
  'agency.station.connect',
  'agency.attempts.handle',
  'agency.attempts.dispose',
  'agency.dnc.write',
];

// Every permission that predates the Agency Dialer.
// Cut to the pre-dialer permissions Magick Agency's
// contract keeps (`@magick-agency/contracts/rbac`), under their agency names
// (`proxy.contact_lists.*` → `agency.campaigns.*`, `proxy.prompts.*` →
// `agency.analysis_profiles.*`, `proxy.phone_numbers.read` →
// `agency.phone_numbers.read`). Permissions for AI, credits,
// API keys, tenant/account administration and number management do not
// exist here, so they have no `it.each` rows.
const PRE_EXISTING_PERMISSIONS: Permission[] = [
  'tenant.read',
  'account.read',
  'user.invite', 'user.update_role', 'user.remove',
  'agency.analysis_profiles.write', 'agency.analysis_profiles.read',
  'agency.campaigns.read', 'agency.campaigns.write',
  'agency.phone_numbers.read',
  'audit.read',
];

const HIGHER_ROLES: Role[] = [
  'viewer',
  'operator',
  'account_admin',
  'tenant_admin',
  'tenant_owner',
];

describe('agent role level', () => {
  it('is 5 — below viewer, matching the API ROLE_HIERARCHY', () => {
    expect(getRoleLevel('agent')).toBe(5);
    expect(getRoleLevel('agent')).toBeLessThan(getRoleLevel('viewer'));
  });
});

describe('agent grants nothing that predates the Agency Dialer', () => {
  it.each(PRE_EXISTING_PERMISSIONS)('denies %s', (permission) => {
    expect(hasPermission('agent', permission)).toBe(false);
  });

  it('denies every pre-existing permission at once', () => {
    const granted = PRE_EXISTING_PERMISSIONS.filter((p) => hasPermission('agent', p));
    expect(granted).toEqual([]);
  });
});

describe('agent can resolve the feature-flag map', () => {
  /**
   * The one non-`agency.*` permission an agent holds, and the reason the header
   * above says "four plus one" rather than "four".
   *
   * Asserted POSITIVELY on purpose. Every other assertion in this file is about
   * what an agent must NOT reach, which is exactly why a total lockout read as
   * compliance for as long as it did: the dialer was unreachable and nothing was
   * red. The API pins the same pair in `test/unit/rbac/roles.agent.test.ts`.
   */
  it('holds agency.flags.read', () => {
    expect(hasPermission('agent', 'agency.flags.read')).toBe(true);
  });

  it('does NOT come with the viewer-floored stats lane it used to borrow', () => {
    // The split is the fix. Lowering `proxy.stats.read` instead would have
    // handed every agent tenant-wide call statistics.
    // The viewer-floored read that carries campaign statistics here is
    // `agency.campaigns.read`, and it must stay out of an agent's reach.
    expect(hasPermission('agent', 'agency.campaigns.read')).toBe(false);
  });

  it('is inherited by every higher role', () => {
    for (const role of ['viewer', 'operator', 'account_admin', 'tenant_admin', 'tenant_owner'] as Role[]) {
      expect(hasPermission(role, 'agency.flags.read'), role).toBe(true);
    }
  });
});

describe('agency permissions', () => {
  it.each(AGENCY_PERMISSIONS)('is granted to an agent: %s', (permission) => {
    expect(hasPermission('agent', permission)).toBe(true);
  });

  it('is inherited by every higher role, so a supervisor can take calls', () => {
    for (const role of HIGHER_ROLES) {
      for (const permission of AGENCY_PERMISSIONS) {
        expect(hasPermission(role, permission)).toBe(true);
      }
    }
  });

  it('an undefined role is still denied', () => {
    for (const permission of AGENCY_PERMISSIONS) {
      expect(hasPermission(undefined, permission)).toBe(false);
    }
  });
});
