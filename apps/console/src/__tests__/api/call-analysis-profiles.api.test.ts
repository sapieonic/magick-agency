import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CallAnalysisProfile,
  CallAnalysisProfilesListResponse,
  CreateCallAnalysisProfileInput,
  UpdateCallAnalysisProfileInput,
} from '../../types/call-analysis-profile';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../../api/client', () => ({ apiFetch: mocks.apiFetch }));

import {
  listCallAnalysisProfiles,
  getCallAnalysisProfile,
  createCallAnalysisProfile,
  updateCallAnalysisProfile,
  deleteCallAnalysisProfile,
} from '../../api/call-analysis-profiles';
import { ENDPOINTS } from '../../config';

const profile: CallAnalysisProfile = {
  id: 'profile-1', tenant_id: 'tenant-1', account_id: 'account-1',
  name: 'Collections', description: null, context: null, custom_dimensions: [],
  language_hint: null, is_default: true, is_active: true, version: 1,
  created_at: '2026-07-28T00:00:00.000Z', updated_at: '2026-07-28T00:00:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

describe('call-analysis-profiles API client', () => {
  it('GETs the exact profiles path with pagination and tenant/account auth context', async () => {
    const response: CallAnalysisProfilesListResponse = { profiles: [profile], total: 1, limit: 25, offset: 10 };
    mocks.apiFetch.mockResolvedValue(response);

    await expect(listCallAnalysisProfiles('tenant-1', 25, 10, 'account-1')).resolves.toEqual(response);

    const [url, options, tenantId, accountId] = mocks.apiFetch.mock.calls[0]!;
    expect(url).toBe(`${ENDPOINTS.proxy.callAnalysisProfiles.base}?limit=25&offset=10`);
    expect(options).toEqual({});
    expect(tenantId).toBe('tenant-1');
    expect(accountId).toBe('account-1');
  });

  it('GETs a scoped profile detail and propagates a 404', async () => {
    const missing = new Error('404 Not Found');
    mocks.apiFetch.mockRejectedValue(missing);

    await expect(getCallAnalysisProfile('tenant-1', 'profile-404', 'account-1')).rejects.toBe(missing);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      ENDPOINTS.proxy.callAnalysisProfiles.get('profile-404'), {}, 'tenant-1', 'account-1',
    );
  });

  it('POSTs a serialized create payload and returns the created profile', async () => {
    const input: CreateCallAnalysisProfileInput = {
      name: 'Collections', context: 'Overdue payments', is_default: true,
      custom_dimensions: [{ key: 'payment_plan', description: 'Plan agreed', type: 'boolean' }],
    };
    mocks.apiFetch.mockResolvedValue(profile);

    await expect(createCallAnalysisProfile('tenant-1', input, 'account-1')).resolves.toEqual(profile);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      ENDPOINTS.proxy.callAnalysisProfiles.base,
      { method: 'POST', body: JSON.stringify(input) },
      'tenant-1', 'account-1',
    );
  });

  it('PUTs the exact profile path with a serialized copy-on-write payload and propagates 409', async () => {
    const input: UpdateCallAnalysisProfileInput = { context: 'Updated context', is_default: false };
    const conflict = new Error('409 stale profile');
    mocks.apiFetch.mockRejectedValue(conflict);

    await expect(updateCallAnalysisProfile('tenant-1', 'profile-1', input, 'account-1')).rejects.toBe(conflict);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      ENDPOINTS.proxy.callAnalysisProfiles.get('profile-1'),
      { method: 'PUT', body: JSON.stringify(input) },
      'tenant-1', 'account-1',
    );
  });

  it('DELETEs the exact profile path and propagates a 403 capability error', async () => {
    const forbidden = new Error('403 Feature Not Enabled');
    mocks.apiFetch.mockRejectedValue(forbidden);

    await expect(deleteCallAnalysisProfile('tenant-1', 'profile-1', 'account-1')).rejects.toBe(forbidden);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      ENDPOINTS.proxy.callAnalysisProfiles.get('profile-1'),
      { method: 'DELETE' }, 'tenant-1', 'account-1',
    );
  });
});
