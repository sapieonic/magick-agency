import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

const mocks = vi.hoisted(() => ({ proxyToCore: vi.fn() }));
vi.mock('../../../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));

import { fetchOwnedCoreCampaign, stringField } from '../../../../../src/api/routes/helpers/core-campaign.js';

const request = { tenantId: 't1', accountId: 'a1' } as unknown as FastifyRequest;

beforeEach(() => mocks.proxyToCore.mockReset());

describe('stringField', () => {
  it('reads a string field and nothing else', () => {
    expect(stringField({ name: 'Q3' }, 'name')).toBe('Q3');
    expect(stringField({ name: 42 }, 'name')).toBeNull();
    expect(stringField({}, 'name')).toBeNull();
    expect(stringField(null, 'name')).toBeNull();
    expect(stringField('name', 'name')).toBeNull();
  });
});

describe('fetchOwnedCoreCampaign', () => {
  it('probes GET /agency-campaigns/:id under the request\'s tenant and account', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { id: 'c1' } });
    await expect(fetchOwnedCoreCampaign(request, 'c1')).resolves.toEqual({ ok: true, body: { id: 'c1' } });
    expect(mocks.proxyToCore).toHaveBeenCalledWith({
      method: 'GET', path: '/agency-campaigns/c1', tenantId: 't1', accountId: 'a1',
    });
  });

  it('uses the account the caller names instead, when it names one', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: {} });
    await fetchOwnedCoreCampaign(request, 'c1', 'membership-account');
    expect(mocks.proxyToCore.mock.calls[0]![0].accountId).toBe('membership-account');
  });

  it('returns the handler\'s refusal with its status and body', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 404, body: { code: 'campaign_not_found' } });
    await expect(fetchOwnedCoreCampaign(request, 'c1')).resolves.toEqual({
      ok: false, status: 404, body: { code: 'campaign_not_found' },
    });
  });
});
