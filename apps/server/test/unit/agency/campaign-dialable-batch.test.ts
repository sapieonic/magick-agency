// `withDialableCallerIdsAll` (`agency/campaign-dialability.ts`): the soft phone's list of
// campaigns narrowed to their dialable caller IDs (PL13) with one read per carrier account,
// giving exactly what one `withDialableCallerIds` per campaign gives.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** Per credential, the numbers still active on it and available to the account. */
  active: new Map<string, Set<string>>(),
  findCredentialNumbersForAccount: vi.fn(),
}));
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: { findCredentialNumbersForAccount: mocks.findCredentialNumbersForAccount },
}));

import {
  invalidateDialableCallerIds,
  withDialableCallerIds,
  withDialableCallerIdsAll,
} from '../../../src/agency/campaign-dialability.js';

const campaign = (id: string, credential: string | null, callerIds: string[]) => ({
  id, tenant_id: 't', account_id: 'a', caller_ids: callerIds, telephony_credential_id: credential,
});

const CAMPAIGNS = [
  campaign('c1', 'cred-A', ['+911', ' +912 ', '+913']),
  campaign('c2', null, ['+999']),
  campaign('c3', 'cred-A', ['+913', '+914']),
  campaign('c4', 'cred-B', ['+921', '+922']),
  campaign('c5', 'cred-B', []),
];

beforeEach(() => {
  invalidateDialableCallerIds();
  mocks.active = new Map([['cred-A', new Set(['+912', '+913'])], ['cred-B', new Set(['+922'])]]);
  mocks.findCredentialNumbersForAccount.mockReset().mockImplementation(
    async (_t: string, _a: string, credentialId: string, numbers: string[]) =>
      numbers.filter((n) => mocks.active.get(credentialId)?.has(n)),
  );
});

describe('withDialableCallerIdsAll', () => {
  it('gives each campaign, in order, what one read per campaign gives', async () => {
    const one = await Promise.all(CAMPAIGNS.map((c) => withDialableCallerIds(c)));
    invalidateDialableCallerIds();
    const all = await withDialableCallerIdsAll(CAMPAIGNS);
    expect(all).toEqual(one);
    expect(all.map((c) => c.caller_ids)).toEqual([['+912', '+913'], ['+999'], ['+913'], ['+922'], []]);
    expect(all[1]).toBe(CAMPAIGNS[1]); // a service-account campaign is passed through
  });

  it('reads once per carrier account, over the union of its campaigns’ pools', async () => {
    await withDialableCallerIdsAll(CAMPAIGNS);
    expect(mocks.findCredentialNumbersForAccount).toHaveBeenCalledTimes(2);
    const byCredential = Object.fromEntries(
      mocks.findCredentialNumbersForAccount.mock.calls.map((a) => [a[2], [...(a[3] as string[])].sort()]),
    );
    expect(byCredential).toEqual({ 'cred-A': ['+911', '+912', '+913', '+914'], 'cred-B': ['+921', '+922'] });
  });

  it('answers from the cache it shares with the single read, and fills it', async () => {
    await withDialableCallerIds(CAMPAIGNS[0]!);
    mocks.findCredentialNumbersForAccount.mockClear();
    await withDialableCallerIdsAll(CAMPAIGNS);
    expect(mocks.findCredentialNumbersForAccount.mock.calls.map((a) => [...(a[3] as string[])].sort()))
      .toEqual([['+913', '+914'], ['+921', '+922']]);
    mocks.findCredentialNumbersForAccount.mockClear();
    await withDialableCallerIds(CAMPAIGNS[3]!);
    expect(mocks.findCredentialNumbersForAccount).not.toHaveBeenCalled();
  });
});
