import { describe, expect, it } from 'vitest';
import { buildViewer, canSeeDncDetail, narrowViewer } from '../../../../src/agency/customer-history/visibility.js';

/**
 * `narrowViewer`: the dialer flag as a data boundary (`docs/customer-history.md` CH2). The routes
 * narrow the viewer to the accounts where `agency_dialer_enabled` is on; an account left out is
 * as if it were not visible, and a role held only there grants nothing.
 */
const ME = '00000000-0000-4000-8000-000000000001';
const ACC_A = '00000000-0000-4000-8000-0000000000aa';
const ACC_B = '00000000-0000-4000-8000-0000000000bb';
const BOTH = [{ id: ACC_A, name: 'North' }, { id: ACC_B, name: 'South' }];

describe('narrowViewer (CH2: the dialer flag is a data boundary)', () => {
  it('keeps only the accounts named, with their roles', () => {
    const v = narrowViewer(buildViewer(ME, [{ account_id: null, role: 'tenant_owner' }], BOTH), new Set([ACC_A]));
    expect([...v.accounts.keys()]).toEqual([ACC_A]);
    expect(v.accounts.get(ACC_A)).toEqual({ id: ACC_A, name: 'North', role: 'tenant_owner' });
    expect(v.userId).toBe(ME);
  });

  it('works the highest role out again: a role held only in a dropped account grants nothing', () => {
    const full = buildViewer(ME, [
      { account_id: ACC_A, role: 'agent' },
      { account_id: ACC_B, role: 'account_admin' },
    ], BOTH);
    expect(full.highestRole).toBe('account_admin');
    expect(canSeeDncDetail(full, null)).toBe(true);
    const narrowed = narrowViewer(full, new Set([ACC_A]));
    expect(narrowed.highestRole).toBe('agent');
    // A tenant-wide DNC entry's detail follows the highest role.
    expect(canSeeDncDetail(narrowed, null)).toBe(false);
  });

  it('a tenant-level role still counts with every account dropped', () => {
    const v = narrowViewer(buildViewer(ME, [{ account_id: null, role: 'tenant_admin' }], BOTH), new Set());
    expect(v.accounts.size).toBe(0);
    expect(v.highestRole).toBe('tenant_admin');
    expect(v.tenantRole).toBe('tenant_admin');
  });

  it('an account-scoped caller with every account dropped falls back to agent, as buildViewer does', () => {
    const v = narrowViewer(buildViewer(ME, [{ account_id: ACC_B, role: 'operator' }], [BOTH[1]!]), new Set([ACC_A]));
    expect(v.accounts.size).toBe(0);
    expect(v.highestRole).toBe('agent');
    expect(v.tenantRole).toBeNull();
  });

  it('keeping every account changes nothing', () => {
    const full = buildViewer(ME, [{ account_id: null, role: 'viewer' }, { account_id: ACC_B, role: 'account_admin' }], BOTH);
    expect(narrowViewer(full, new Set([ACC_A, ACC_B]))).toEqual(full);
  });
});
