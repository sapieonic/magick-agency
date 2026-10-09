import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PERMISSION_MATRIX,
  ROLES,
  ROLE_HIERARCHY,
  canManageRole,
  hasPermission,
  type Permission,
  type Role,
} from '../src/rbac';

describe('role hierarchy', () => {
  it('is master’s, exactly (magick-master src/rbac/roles.ts:26-33 @ a1f0756a)', () => {
    expect(ROLE_HIERARCHY).toEqual({
      agent: 5,
      viewer: 10,
      operator: 20,
      account_admin: 30,
      tenant_admin: 40,
      tenant_owner: 50,
    });
  });

  it('puts agent BELOW viewer', () => {
    expect(ROLE_HIERARCHY.agent).toBeLessThan(ROLE_HIERARCHY.viewer);
    expect(ROLES[0]).toBe('agent');
  });

  it('lists roles lowest first', () => {
    const levels = ROLES.map((r) => ROLE_HIERARCHY[r]);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
  });
});

/**
 * Every permission's floor, against master's matrix at master v3.24.0
 * (a1f0756a58a63bf8a19baf74298a702f9fe7b430), `src/rbac/roles.ts`.
 * `masterName` is the permission's name in master where it was renamed.
 */
const FLOORS: ReadonlyArray<{ permission: Permission; floor: Role; masterName: string; masterLine: number }> = [
  { permission: 'tenant.read', floor: 'viewer', masterName: 'tenant.read', masterLine: 80 },
  { permission: 'account.read', floor: 'viewer', masterName: 'account.read', masterLine: 83 },
  { permission: 'user.invite', floor: 'account_admin', masterName: 'user.invite', masterLine: 86 },
  { permission: 'user.update_role', floor: 'tenant_admin', masterName: 'user.update_role', masterLine: 87 },
  { permission: 'user.remove', floor: 'tenant_admin', masterName: 'user.remove', masterLine: 88 },
  { permission: 'audit.read', floor: 'account_admin', masterName: 'audit.read', masterLine: 131 },
  { permission: 'agency.flags.read', floor: 'agent', masterName: 'proxy.feature_flags.read', masterLine: 164 },
  { permission: 'agency.campaigns.read', floor: 'viewer', masterName: 'proxy.contact_lists.read', masterLine: 118 },
  { permission: 'agency.campaigns.write', floor: 'account_admin', masterName: 'proxy.contact_lists.write', masterLine: 119 },
  { permission: 'agency.analysis_profiles.read', floor: 'viewer', masterName: 'proxy.prompts.read', masterLine: 94 },
  { permission: 'agency.analysis_profiles.write', floor: 'account_admin', masterName: 'proxy.prompts.write', masterLine: 93 },
  { permission: 'agency.phone_numbers.read', floor: 'viewer', masterName: 'proxy.phone_numbers.read', masterLine: 122 },
  { permission: 'agency.station.connect', floor: 'agent', masterName: 'agency.station.connect', masterLine: 175 },
  { permission: 'agency.attempts.handle', floor: 'agent', masterName: 'agency.attempts.handle', masterLine: 176 },
  { permission: 'agency.attempts.dispose', floor: 'agent', masterName: 'agency.attempts.dispose', masterLine: 177 },
  { permission: 'agency.dnc.write', floor: 'agent', masterName: 'agency.dnc.write', masterLine: 178 },
  { permission: 'agency.supervise', floor: 'account_admin', masterName: 'agency.supervise', masterLine: 192 },
  { permission: 'agency.dnc.read', floor: 'viewer', masterName: 'agency.dnc.read', masterLine: 207 },
  { permission: 'agency.dnc.manage', floor: 'account_admin', masterName: 'agency.dnc.manage', masterLine: 208 },
];

describe('permission floors', () => {
  it.each(FLOORS)('$permission floors at $floor (master $masterName, roles.ts:$masterLine)', ({ permission, floor }) => {
    expect(PERMISSION_MATRIX[permission]).toBe(floor);
  });

  it('the table covers every permission and nothing else', () => {
    expect(FLOORS.map((f) => f.permission).sort()).toEqual([...PERMISSIONS].sort());
  });

  it('has the seven agency.* keys master defines', () => {
    const masterAgency = FLOORS.filter((f) => f.masterName.startsWith('agency.')).map((f) => f.permission);
    expect(masterAgency).toHaveLength(7);
  });

  it('drops credit.read', () => {
    expect(PERMISSIONS as readonly string[]).not.toContain('credit.read');
  });

  it.each(FLOORS)('hasPermission agrees with the floor for $permission at every role', ({ permission, floor }) => {
    for (const role of ROLES) {
      expect(hasPermission(role, permission)).toBe(ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[floor]);
    }
  });
});

describe('the agent role', () => {
  it('reaches exactly the four action permissions plus the flag map', () => {
    expect(PERMISSIONS.filter((p) => hasPermission('agent', p)).sort()).toEqual([
      'agency.attempts.dispose',
      'agency.attempts.handle',
      'agency.dnc.write',
      'agency.flags.read',
      'agency.station.connect',
    ]);
  });

  it('cannot supervise, read campaigns or the DNC list', () => {
    expect(hasPermission('agent', 'agency.supervise')).toBe(false);
    expect(hasPermission('agent', 'agency.campaigns.read')).toBe(false);
    expect(hasPermission('agent', 'agency.dnc.read')).toBe(false);
  });
});

describe('hasPermission', () => {
  it('fails closed on a missing or unknown role', () => {
    expect(hasPermission(undefined, 'agency.flags.read')).toBe(false);
    expect(hasPermission(null, 'agency.flags.read')).toBe(false);
    expect(hasPermission('superuser' as Role, 'agency.flags.read')).toBe(false);
  });
});

describe('canManageRole', () => {
  it('requires strictly higher authority', () => {
    expect(canManageRole('account_admin', 'agent')).toBe(true);
    expect(canManageRole('account_admin', 'account_admin')).toBe(false);
    expect(canManageRole('agent', 'viewer')).toBe(false);
  });
});
