// `withDialableCallerIdsAll` (`agency/campaign-dialability.ts`): the soft phone's list of
// campaigns narrowed to their dialable caller IDs (PL13 on a tenant's account, CR9 on the
// service's) with one read per carrier account, giving exactly what one `withDialableCallerIds`
// per campaign gives.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** Per credential, the numbers still active on it and available to the account. */
  active: new Map<string, Set<string>>(),
  findCredentialNumbersForAccount: vi.fn(),
  /** The numbers pinned to some credential (CR9: never dialled on the service's account). */
  pinned: new Set<string>(),
  findPinnedAmong: vi.fn(),
}));
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: { findCredentialNumbersForAccount: mocks.findCredentialNumbersForAccount },
}));
vi.mock('@magick-agency/db/repositories/phone-number.repository', () => ({
  phoneNumberRepository: { findPinnedAmong: mocks.findPinnedAmong },
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
  campaign('c6', null, ['+999', '+931']),
];

beforeEach(() => {
  invalidateDialableCallerIds();
  mocks.active = new Map([['cred-A', new Set(['+912', '+913'])], ['cred-B', new Set(['+922'])]]);
  mocks.findCredentialNumbersForAccount.mockReset().mockImplementation(
    async (_t: string, _a: string, credentialId: string, numbers: string[]) =>
      numbers.filter((n) => mocks.active.get(credentialId)?.has(n)),
  );
  mocks.pinned = new Set(['+931']);
  mocks.findPinnedAmong.mockReset().mockImplementation(async (numbers: string[]) => numbers.filter((n) => mocks.pinned.has(n)));
});

describe('withDialableCallerIdsAll', () => {
  it('gives each campaign, in order, what one read per campaign gives', async () => {
    const one = await Promise.all(CAMPAIGNS.map((c) => withDialableCallerIds(c)));
    invalidateDialableCallerIds();
    const all = await withDialableCallerIdsAll(CAMPAIGNS);
    expect(all).toEqual(one);
    // A service-account campaign keeps every number but the pinned one (CR9).
    expect(all.map((c) => c.caller_ids)).toEqual([['+912', '+913'], ['+999'], ['+913'], ['+922'], [], ['+999']]);
  });

  it('reads once per carrier account, over the union of its campaigns’ pools', async () => {
    await withDialableCallerIdsAll(CAMPAIGNS);
    expect(mocks.findCredentialNumbersForAccount).toHaveBeenCalledTimes(2);
    const byCredential = Object.fromEntries(
      mocks.findCredentialNumbersForAccount.mock.calls.map((a) => [a[2], [...(a[3] as string[])].sort()]),
    );
    expect(byCredential).toEqual({ 'cred-A': ['+911', '+912', '+913', '+914'], 'cred-B': ['+921', '+922'] });
    // The service's own account: one read of the pinned numbers for all its campaigns.
    expect(mocks.findPinnedAmong).toHaveBeenCalledTimes(1);
    expect([...(mocks.findPinnedAmong.mock.calls[0]![0] as string[])].sort()).toEqual(['+931', '+999']);
  });

  it('a read that started before a clear does not put its stale answer back in the cache (single and batch)', async () => {
    // The read of c1's numbers starts, then a sync retires +913 and clears the cache, then
    // the read (taken before the retire) returns.
    let release!: (numbers: string[]) => void;
    mocks.findCredentialNumbersForAccount.mockImplementationOnce(() => new Promise<string[]>((r) => { release = r; }));
    const reading = withDialableCallerIds(CAMPAIGNS[0]!);
    await vi.waitFor(() => expect(mocks.findCredentialNumbersForAccount).toHaveBeenCalledTimes(1));
    mocks.active.get('cred-A')!.delete('+913');
    invalidateDialableCallerIds();
    release(['+912', '+913']);
    // That one dial reads what it read (it would have without any cache) ...
    expect((await reading).caller_ids).toEqual(['+912', '+913']);
    // ... but the next lookup reads again and never sees the retired number.
    expect((await withDialableCallerIds(CAMPAIGNS[0]!)).caller_ids).toEqual(['+912']);
    expect(mocks.findCredentialNumbersForAccount).toHaveBeenCalledTimes(2);

    // The batch read, the same way.
    invalidateDialableCallerIds();
    mocks.findCredentialNumbersForAccount.mockClear();
    let releaseBatch!: (numbers: string[]) => void;
    mocks.findCredentialNumbersForAccount.mockImplementationOnce(() => new Promise<string[]>((r) => { releaseBatch = r; }));
    const batch = withDialableCallerIdsAll([CAMPAIGNS[0]!]);
    await vi.waitFor(() => expect(mocks.findCredentialNumbersForAccount).toHaveBeenCalledTimes(1));
    mocks.active.get('cred-A')!.delete('+912');
    invalidateDialableCallerIds();
    releaseBatch(['+912']);
    await batch;
    expect((await withDialableCallerIds(CAMPAIGNS[0]!)).caller_ids).toEqual([]);
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

  it('a service-account campaign`s pool is cached, and any clear drops it: a number moved onto a tenant`s account leaves it at once (CR9)', async () => {
    const service = CAMPAIGNS[5]!;
    mocks.pinned = new Set();
    expect((await withDialableCallerIds(service)).caller_ids).toEqual(['+999', '+931']);
    // Cached: a move with no clear is not seen yet ...
    mocks.pinned.add('+999');
    expect((await withDialableCallerIds(service)).caller_ids).toEqual(['+999', '+931']);
    expect(mocks.findPinnedAmong).toHaveBeenCalledTimes(1);
    // ... the move's clear (`invalidateDialableCallerIds`, the pin route) drops it from the next dial,
    // the batch read included.
    invalidateDialableCallerIds();
    expect((await withDialableCallerIdsAll([service]))[0]!.caller_ids).toEqual(['+931']);
    expect((await withDialableCallerIds(service)).caller_ids).toEqual(['+931']);
    expect(mocks.findPinnedAmong).toHaveBeenCalledTimes(2);
  });
});
