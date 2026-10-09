import { describe, it, expect } from 'vitest';
import {
  ROLE_HIERARCHY,
  PERMISSION_MATRIX,
  hasPermission,
  canManageRole,
  type Permission,
} from '@magick-agency/contracts/rbac';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';

describe('ROLE_HIERARCHY', () => {
  it('should assign numeric levels to all roles', () => {
    expect(ROLE_HIERARCHY.viewer).toBe(10);
    expect(ROLE_HIERARCHY.operator).toBe(20);
    expect(ROLE_HIERARCHY.account_admin).toBe(30);
    expect(ROLE_HIERARCHY.tenant_admin).toBe(40);
    expect(ROLE_HIERARCHY.tenant_owner).toBe(50);
  });

  it('should have strictly ascending values', () => {
    expect(ROLE_HIERARCHY.viewer).toBeLessThan(ROLE_HIERARCHY.operator);
    expect(ROLE_HIERARCHY.operator).toBeLessThan(ROLE_HIERARCHY.account_admin);
    expect(ROLE_HIERARCHY.account_admin).toBeLessThan(ROLE_HIERARCHY.tenant_admin);
    expect(ROLE_HIERARCHY.tenant_admin).toBeLessThan(ROLE_HIERARCHY.tenant_owner);
  });
});

describe('PERMISSION_MATRIX', () => {
  it('should define minimum roles for all permissions', () => {
    const readOnlyPerms: Permission[] = [
      'tenant.read', 'account.read', 'agency.analysis_profiles.read',
    ];
    for (const perm of readOnlyPerms) {
      expect(PERMISSION_MATRIX[perm]).toBe('viewer');
    }
  });

  it('should require account_admin for write operations', () => {
    expect(PERMISSION_MATRIX['user.invite']).toBe('account_admin');
    expect(PERMISSION_MATRIX['agency.analysis_profiles.write']).toBe('account_admin');
  });

  it('should require tenant_admin for privileged operations', () => {
    expect(PERMISSION_MATRIX['user.update_role']).toBe('tenant_admin');
    expect(PERMISSION_MATRIX['user.remove']).toBe('tenant_admin');
  });

  it('should require account_admin for audit.read — floor mirrored in the console', () => {
    expect(PERMISSION_MATRIX['audit.read']).toBe('account_admin');
  });
});

describe('hasPermission', () => {
  describe('viewer role', () => {
    const role: MembershipRole = 'viewer';

    it('should allow viewer-level permissions', () => {
      expect(hasPermission(role, 'tenant.read')).toBe(true);
      expect(hasPermission(role, 'account.read')).toBe(true);
      expect(hasPermission(role, 'agency.analysis_profiles.read')).toBe(true);
    });

    it('should deny account_admin-and-above permissions', () => {
      expect(hasPermission(role, 'user.invite')).toBe(false);
      expect(hasPermission(role, 'agency.analysis_profiles.write')).toBe(false);
    });

    it('should deny audit.read (floor is account_admin)', () => {
      expect(hasPermission(role, 'audit.read')).toBe(false);
    });
  });

  describe('operator role', () => {
    const role: MembershipRole = 'operator';

    it('should allow viewer and operator permissions', () => {
      expect(hasPermission(role, 'tenant.read')).toBe(true);
    });

    it('should deny account_admin-and-above permissions', () => {
      expect(hasPermission(role, 'user.invite')).toBe(false);
      expect(hasPermission(role, 'agency.analysis_profiles.write')).toBe(false);
      expect(hasPermission(role, 'audit.read')).toBe(false);
    });
  });

  describe('account_admin role', () => {
    const role: MembershipRole = 'account_admin';

    it('should allow viewer, operator, and account_admin permissions', () => {
      expect(hasPermission(role, 'tenant.read')).toBe(true);
      expect(hasPermission(role, 'user.invite')).toBe(true);
      expect(hasPermission(role, 'agency.analysis_profiles.write')).toBe(true);
      expect(hasPermission(role, 'audit.read')).toBe(true);
    });
  });

  describe('tenant_admin role', () => {
    const role: MembershipRole = 'tenant_admin';

    it('should allow all permissions up to tenant_admin', () => {
      expect(hasPermission(role, 'tenant.read')).toBe(true);
      expect(hasPermission(role, 'audit.read')).toBe(true);
    });
  });

  describe('tenant_owner role', () => {
    const role: MembershipRole = 'tenant_owner';

    it('should allow all permissions', () => {
      const allPermissions = Object.keys(PERMISSION_MATRIX) as Permission[];
      for (const perm of allPermissions) {
        expect(hasPermission(role, perm)).toBe(true);
      }
    });
  });
});

describe('canManageRole', () => {
  it('tenant_owner can manage all lower roles', () => {
    expect(canManageRole('tenant_owner', 'tenant_admin')).toBe(true);
    expect(canManageRole('tenant_owner', 'account_admin')).toBe(true);
    expect(canManageRole('tenant_owner', 'operator')).toBe(true);
    expect(canManageRole('tenant_owner', 'viewer')).toBe(true);
  });

  it('tenant_admin can manage account_admin and below', () => {
    expect(canManageRole('tenant_admin', 'account_admin')).toBe(true);
    expect(canManageRole('tenant_admin', 'operator')).toBe(true);
    expect(canManageRole('tenant_admin', 'viewer')).toBe(true);
    expect(canManageRole('tenant_admin', 'tenant_owner')).toBe(false);
    expect(canManageRole('tenant_admin', 'tenant_admin')).toBe(false);
  });

  it('cannot manage role of equal level', () => {
    expect(canManageRole('viewer', 'viewer')).toBe(false);
    expect(canManageRole('operator', 'operator')).toBe(false);
    expect(canManageRole('account_admin', 'account_admin')).toBe(false);
    expect(canManageRole('tenant_admin', 'tenant_admin')).toBe(false);
    expect(canManageRole('tenant_owner', 'tenant_owner')).toBe(false);
  });

  it('cannot manage a higher role', () => {
    expect(canManageRole('viewer', 'operator')).toBe(false);
    expect(canManageRole('operator', 'account_admin')).toBe(false);
    expect(canManageRole('account_admin', 'tenant_admin')).toBe(false);
    expect(canManageRole('account_admin', 'tenant_owner')).toBe(false);
  });

  it('viewer cannot manage any role', () => {
    expect(canManageRole('viewer', 'operator')).toBe(false);
    expect(canManageRole('viewer', 'account_admin')).toBe(false);
    expect(canManageRole('viewer', 'tenant_admin')).toBe(false);
    expect(canManageRole('viewer', 'tenant_owner')).toBe(false);
  });
});
