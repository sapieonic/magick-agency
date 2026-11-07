import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The customer-history routes' viewer (`proxy-agency-customers/shared.ts`): the visible accounts
 * narrowed to those where `agency_dialer_enabled` is on, each resolved for its own account
 * (`docs/customer-history.md` CH2: the flag is a data boundary, not only the request's gate).
 */
const mocks = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  resolveViewer: vi.fn(),
}));
vi.mock('../../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ isEnabled: mocks.isEnabled }),
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));
vi.mock('../../../../src/agency/customer-history/service.js', () => ({ resolveViewer: mocks.resolveViewer }));

import { dialerAccountIds, resolveDialerViewer } from '../../../../src/api/routes/proxy-agency-customers/shared.js';
import { buildViewer } from '../../../../src/agency/customer-history/visibility.js';

const TENANT = '00000000-0000-4000-8000-0000000000ee';
const ME = '00000000-0000-4000-8000-000000000001';
const ACC_A = '00000000-0000-4000-8000-0000000000aa';
const ACC_B = '00000000-0000-4000-8000-0000000000bb';
const ACC_C = '00000000-0000-4000-8000-0000000000cc';

/** The dialer on in the accounts named. */
const dialerOnIn = (...on: string[]) =>
  mocks.isEnabled.mockImplementation(async (_flag: unknown, ctx: { accountId?: string }) => on.includes(ctx.accountId ?? ''));

beforeEach(() => {
  mocks.isEnabled.mockReset();
  mocks.resolveViewer.mockReset();
});

describe('dialerAccountIds', () => {
  it('resolves the flag once per account, for that account, and keeps those where it is on', async () => {
    dialerOnIn(ACC_A, ACC_C);
    const on = await dialerAccountIds(TENANT, [ACC_A, ACC_B, ACC_C]);
    expect([...on].sort()).toEqual([ACC_A, ACC_C]);
    expect(mocks.isEnabled).toHaveBeenCalledTimes(3);
    for (const accountId of [ACC_A, ACC_B, ACC_C]) {
      expect(mocks.isEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'agency_dialer_enabled' }), { tenantId: TENANT, accountId });
    }
  });

  it('no accounts, no reads', async () => {
    expect((await dialerAccountIds(TENANT, [])).size).toBe(0);
    expect(mocks.isEnabled).not.toHaveBeenCalled();
  });
});

describe('resolveDialerViewer', () => {
  it('a tenant-level owner sees only the accounts where the dialer is on', async () => {
    mocks.resolveViewer.mockResolvedValue(buildViewer(ME, [{ account_id: null, role: 'tenant_owner' }],
      [{ id: ACC_A, name: 'North' }, { id: ACC_B, name: 'South' }]));
    dialerOnIn(ACC_A);
    const viewer = await resolveDialerViewer(ME, TENANT);
    expect(mocks.resolveViewer).toHaveBeenCalledWith(ME, TENANT);
    expect([...viewer.accounts.keys()]).toEqual([ACC_A]);
    expect(viewer.highestRole).toBe('tenant_owner');

    dialerOnIn(ACC_A, ACC_B);
    expect([...(await resolveDialerViewer(ME, TENANT)).accounts.keys()].sort()).toEqual([ACC_A, ACC_B]);
  });

  it('a role held only in an account with the dialer off is not the highest role', async () => {
    mocks.resolveViewer.mockResolvedValue(buildViewer(ME,
      [{ account_id: ACC_A, role: 'agent' }, { account_id: ACC_B, role: 'account_admin' }],
      [{ id: ACC_A, name: 'North' }, { id: ACC_B, name: 'South' }]));
    dialerOnIn(ACC_A);
    const viewer = await resolveDialerViewer(ME, TENANT);
    expect([...viewer.accounts.keys()]).toEqual([ACC_A]);
    expect(viewer.highestRole).toBe('agent');
  });
});
