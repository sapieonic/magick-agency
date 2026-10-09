import { describe, it, expect } from 'vitest';
import { hasPermission, getRoleLevel, PERMISSION_MIN_ROLE } from '../../utils/permissions';
import type { Permission } from '../../utils/permissions';
import type { Role } from '../../types/auth';

/*
 * PORT NOTE (magick-agency): cusui pinned its hand mirror of master's matrix. The
 * console's `hasPermission` is now the contract's (`@magick-agency/contracts/rbac`,
 * the matrix the server enforces). The structure and every assertion are kept;
 * the permission LISTS are cut to the permissions agency keeps, under agency
 * names (`proxy.prompts.*` → `agency.analysis_profiles.*`). DELETED with their
 * permissions: every per-permission row for credits, API keys, tenant/account
 * administration and the AI product's `proxy.*` keys, and the eleven boundary
 * cases about them (calls, static calls, IVR, announcements, audio files,
 * account update/create/delete, credits, API keys, tenant update). The
 * agency-specific floors are pinned in `agencyPermissionMirror.test.ts` and
 * `agentPermissions.test.ts`.
 */

// All permissions defined in the system
const ALL_PERMISSIONS: Permission[] = [
  'tenant.read',
  'account.read',
  'user.invite',
  'user.update_role',
  'user.remove',
  'agency.analysis_profiles.write',
  'agency.analysis_profiles.read',
  'audit.read',
];

// ─── getRoleLevel ─────────────────────────────────────────────────────────────

describe('getRoleLevel', () => {
  it('viewer has level 10', () => expect(getRoleLevel('viewer')).toBe(10));
  it('operator has level 20', () => expect(getRoleLevel('operator')).toBe(20));
  it('account_admin has level 30', () => expect(getRoleLevel('account_admin')).toBe(30));
  it('tenant_admin has level 40', () => expect(getRoleLevel('tenant_admin')).toBe(40));
  it('tenant_owner has level 50', () => expect(getRoleLevel('tenant_owner')).toBe(50));

  it('levels increase strictly with rank', () => {
    expect(getRoleLevel('viewer')).toBeLessThan(getRoleLevel('operator'));
    expect(getRoleLevel('operator')).toBeLessThan(getRoleLevel('account_admin'));
    expect(getRoleLevel('account_admin')).toBeLessThan(getRoleLevel('tenant_admin'));
    expect(getRoleLevel('tenant_admin')).toBeLessThan(getRoleLevel('tenant_owner'));
  });

  it('returns a number for every valid role', () => {
    const roles: Role[] = ['viewer', 'operator', 'account_admin', 'tenant_admin', 'tenant_owner'];
    roles.forEach((role) => expect(typeof getRoleLevel(role)).toBe('number'));
  });
});

// ─── hasPermission — return type ─────────────────────────────────────────────

describe('hasPermission return type', () => {
  it('always returns a boolean', () => {
    expect(typeof hasPermission('viewer', 'tenant.read')).toBe('boolean');
    expect(typeof hasPermission(undefined, 'tenant.read')).toBe('boolean');
  });
});

// ─── hasPermission — no role ──────────────────────────────────────────────────

describe('hasPermission — undefined role', () => {
  it('denies every permission', () => {
    ALL_PERMISSIONS.forEach((perm) => {
      expect(hasPermission(undefined, perm), perm).toBe(false);
    });
  });
});

// ─── hasPermission — unknown role (defensive) ─────────────────────────────────

describe('hasPermission — unknown role (defensive)', () => {
  it('denies all permissions for an unrecognised role string', () => {
    // Cast to Role to simulate a value that bypasses TypeScript at runtime
    ALL_PERMISSIONS.forEach((perm) => {
      expect(hasPermission('superuser' as Role, perm), perm).toBe(false);
    });
  });
});

// ─── hasPermission — viewer (level 10) ───────────────────────────────────────

// Permissions accessible to viewer
const VIEWER_PERMISSIONS: Permission[] = [
  'tenant.read',
  'account.read',
  'agency.analysis_profiles.read',
];

// Permissions NOT accessible to viewer
const VIEWER_DENIED_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter(
  (p) => !VIEWER_PERMISSIONS.includes(p),
);

describe('hasPermission — viewer', () => {
  VIEWER_PERMISSIONS.forEach((perm) => {
    it(`grants ${perm}`, () => expect(hasPermission('viewer', perm)).toBe(true));
  });

  VIEWER_DENIED_PERMISSIONS.forEach((perm) => {
    it(`denies ${perm}`, () => expect(hasPermission('viewer', perm)).toBe(false));
  });
});

// ─── hasPermission — operator (level 20) ─────────────────────────────────────

const OPERATOR_NEW_PERMISSIONS: Permission[] = [
];

const OPERATOR_DENIED_PERMISSIONS: Permission[] = [
  'user.invite',
  'user.update_role',
  'user.remove',
  'agency.analysis_profiles.write',
  'audit.read',
];

describe('hasPermission — operator', () => {
  it('inherits all viewer permissions', () => {
    VIEWER_PERMISSIONS.forEach((perm) => {
      expect(hasPermission('operator', perm), perm).toBe(true);
    });
  });

  OPERATOR_NEW_PERMISSIONS.forEach((perm) => {
    it(`grants ${perm}`, () => expect(hasPermission('operator', perm)).toBe(true));
  });

  OPERATOR_DENIED_PERMISSIONS.forEach((perm) => {
    it(`denies ${perm}`, () => expect(hasPermission('operator', perm)).toBe(false));
  });
});

// ─── hasPermission — account_admin (level 30) ────────────────────────────────

const ACCOUNT_ADMIN_NEW_PERMISSIONS: Permission[] = [
  'user.invite',
  'agency.analysis_profiles.write',
  'audit.read',
];

const ACCOUNT_ADMIN_DENIED_PERMISSIONS: Permission[] = [
  'user.update_role',
  'user.remove',
];

describe('hasPermission — account_admin', () => {
  it('inherits all operator permissions', () => {
    [...VIEWER_PERMISSIONS, ...OPERATOR_NEW_PERMISSIONS].forEach((perm) => {
      expect(hasPermission('account_admin', perm), perm).toBe(true);
    });
  });

  ACCOUNT_ADMIN_NEW_PERMISSIONS.forEach((perm) => {
    it(`grants ${perm}`, () => expect(hasPermission('account_admin', perm)).toBe(true));
  });

  ACCOUNT_ADMIN_DENIED_PERMISSIONS.forEach((perm) => {
    it(`denies ${perm}`, () => expect(hasPermission('account_admin', perm)).toBe(false));
  });
});

// ─── hasPermission — tenant_admin (level 40) ─────────────────────────────────

const TENANT_ADMIN_NEW_PERMISSIONS: Permission[] = [
  'user.update_role',
  'user.remove',
];

describe('hasPermission — tenant_admin', () => {
  it('inherits all account_admin permissions', () => {
    [...VIEWER_PERMISSIONS, ...OPERATOR_NEW_PERMISSIONS, ...ACCOUNT_ADMIN_NEW_PERMISSIONS].forEach(
      (perm) => {
        expect(hasPermission('tenant_admin', perm), perm).toBe(true);
      },
    );
  });

  TENANT_ADMIN_NEW_PERMISSIONS.forEach((perm) => {
    it(`grants ${perm}`, () => expect(hasPermission('tenant_admin', perm)).toBe(true));
  });

  it('has no permissions denied — tenant_admin is the highest required role', () => {
    // No permission in the system requires tenant_owner, so tenant_admin gets everything
    ALL_PERMISSIONS.forEach((perm) => {
      expect(hasPermission('tenant_admin', perm), perm).toBe(true);
    });
  });
});

// ─── hasPermission — tenant_owner (level 50) ─────────────────────────────────

describe('hasPermission — tenant_owner', () => {
  it('grants every permission in the system', () => {
    ALL_PERMISSIONS.forEach((perm) => {
      expect(hasPermission('tenant_owner', perm), perm).toBe(true);
    });
  });
});

// ─── permission boundaries — exact role thresholds ───────────────────────────

describe('permission boundaries — exact thresholds', () => {
  // viewer → operator boundary

  // operator → account_admin boundary
  it('operator cannot write prompts; account_admin can', () => {
    expect(hasPermission('operator', 'agency.analysis_profiles.write')).toBe(false);
    expect(hasPermission('account_admin', 'agency.analysis_profiles.write')).toBe(true);
  });
  it('operator cannot invite users; account_admin can', () => {
    expect(hasPermission('operator', 'user.invite')).toBe(false);
    expect(hasPermission('account_admin', 'user.invite')).toBe(true);
  });

  it('operator cannot read audit log; account_admin can', () => {
    expect(hasPermission('operator', 'audit.read')).toBe(false);
    expect(hasPermission('account_admin', 'audit.read')).toBe(true);
  });
  it('pins audit.read at account_admin — the same floor as magick-master', () => {
    expect(PERMISSION_MIN_ROLE['audit.read']).toBe('account_admin');
  });

  // account_admin → tenant_admin boundary
  it('account_admin cannot update roles; tenant_admin can', () => {
    expect(hasPermission('account_admin', 'user.update_role')).toBe(false);
    expect(hasPermission('tenant_admin', 'user.update_role')).toBe(true);
  });
  it('account_admin cannot remove users; tenant_admin can', () => {
    expect(hasPermission('account_admin', 'user.remove')).toBe(false);
    expect(hasPermission('tenant_admin', 'user.remove')).toBe(true);
  });
});
