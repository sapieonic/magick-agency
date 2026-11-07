// `campaignDialBlockers` (`agency/campaign-dialability.ts`): what blocks a campaign from
// placing a call, in the order start and resume answer them (PL12, PL13, PL14). The reads
// run together; a read that fails only matters when no earlier check blocks.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  carrierDialReady: vi.fn<(provider: string) => boolean>(),
  findCredentialNumbersForAccount: vi.fn<(...args: unknown[]) => Promise<string[]>>(),
  getProviderLimit: vi.fn<(...args: unknown[]) => Promise<{ mode: string; limit: number | null }>>(),
}));
vi.mock('../../../src/telephony/carrier-dial-readiness.js', () => ({ carrierDialReady: mocks.carrierDialReady }));
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: { findCredentialNumbersForAccount: mocks.findCredentialNumbersForAccount },
}));
vi.mock('@magick-agency/db/repositories/provider-concurrency.repository', () => ({
  providerConcurrencyRepository: { getProviderLimit: mocks.getProviderLimit },
}));

import { campaignDialBlockers, invalidateDialableCallerIds } from '../../../src/agency/campaign-dialability.js';

const pinned = {
  id: 'camp-1', tenant_id: 't', account_id: 'a', caller_ids: ['+911', '+912'],
  telephony_credential_id: 'cred-1', telephony_provider: 'plivo',
};
const codes = async (campaign: object) => (await campaignDialBlockers(campaign as never)).map((b) => b.code);

beforeEach(() => {
  invalidateDialableCallerIds();
  mocks.carrierDialReady.mockReset().mockReturnValue(true);
  mocks.findCredentialNumbersForAccount.mockReset().mockResolvedValue(['+911']);
  mocks.getProviderLimit.mockReset().mockResolvedValue({ mode: 'legacy_total', limit: null });
});

describe('campaignDialBlockers', () => {
  it('is empty for a campaign that can dial', async () => {
    expect(await codes(pinned)).toEqual([]);
  });

  it('lists every blocker in the order start and resume answer them, each a 409', async () => {
    mocks.carrierDialReady.mockReturnValue(false);
    mocks.findCredentialNumbersForAccount.mockResolvedValue([]);
    mocks.getProviderLimit.mockResolvedValue({ mode: 'provider_breakdown', limit: 0 });
    const blockers = await campaignDialBlockers(pinned as never);
    expect(blockers.map((b) => b.code)).toEqual(['carrier_not_ready', 'campaign_caller_ids_unavailable', 'carrier_capacity_unallocated']);
    for (const b of blockers) {
      expect(b.status).toBe(409);
      expect(b.message).not.toMatch(/plivo|voicelink/i);
    }
  });

  it('does not judge a service-account campaign on readiness or caller IDs, only on capacity', async () => {
    mocks.carrierDialReady.mockReturnValue(false);
    mocks.getProviderLimit.mockResolvedValue({ mode: 'provider_breakdown', limit: 0 });
    expect(await codes({ ...pinned, telephony_credential_id: null })).toEqual(['carrier_capacity_unallocated']);
    expect(mocks.findCredentialNumbersForAccount).not.toHaveBeenCalled();
  });

  it('a failed read rejects when nothing before it blocks', async () => {
    mocks.getProviderLimit.mockRejectedValue(new Error('db down'));
    await expect(campaignDialBlockers(pinned as never)).rejects.toThrow('db down');
  });

  it('a failed read after a blocker is moot: the list ends at the blockers before it', async () => {
    mocks.findCredentialNumbersForAccount.mockResolvedValue([]);
    mocks.getProviderLimit.mockRejectedValue(new Error('db down'));
    expect(await codes(pinned)).toEqual(['campaign_caller_ids_unavailable']);
  });
});
