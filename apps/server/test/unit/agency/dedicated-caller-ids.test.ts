import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `DedicatedCallerIdCache` (`agency/pacing/dedicated-caller-ids.ts`): the dial paths' read of a
// campaign's dedicated caller IDs, and `callerIdForContact`, the one-contact helper the agent's
// own call and the wrap-up redial use. Unarmed it reads through (a media worker, whose bus
// delivers nothing); armed it caches per campaign until `invalidate` or the TTL, and a load an
// invalidation overtook is never stored. The engine's arming and `dedications_changed` handling
// are `pacing-skip.test.ts`; the writes that publish the event, on real Postgres, are
// `test/integration/api/agency-agent-caller-ids.test.ts`.
// ---------------------------------------------------------------------------

const { repo } = vi.hoisted(() => ({ repo: { mapForCampaign: vi.fn() } }));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({ agencyAgentCallerIdRepository: repo }));
// PL13: which of a pinned campaign's stored caller IDs are still active on its carrier account.
const { phoneAssignments } = vi.hoisted(() => ({ phoneAssignments: { findCredentialNumbersForAccount: vi.fn() } }));
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: phoneAssignments,
}));

import { DedicatedCallerIdCache } from '../../../src/agency/pacing/dedicated-caller-ids.js';
import { PACING_CACHE_TTL_MS } from '../../../src/agency/pacing/read-cache.js';
import { invalidateDialableCallerIds } from '../../../src/agency/campaign-dialability.js';

const POOL = ['+14155550100', '+14155550101', '+14155550102'];
const CAMPAIGN = { id: 'camp-1', tenant_id: 't1', account_id: 'a1', telephony_credential_id: null, caller_ids: POOL };

beforeEach(() => {
  vi.clearAllMocks();
  invalidateDialableCallerIds();
  repo.mapForCampaign.mockResolvedValue(new Map());
});

describe('DedicatedCallerIdCache.read', () => {
  it('unarmed (no listener for the events), every read goes to the repository', async () => {
    const cache = new DedicatedCallerIdCache();
    expect(cache.isArmed).toBe(false);
    await cache.read('camp-1');
    await cache.read('camp-1');
    expect(repo.mapForCampaign).toHaveBeenCalledTimes(2);
    expect(repo.mapForCampaign).toHaveBeenCalledWith('camp-1');
  });

  it('armed, a campaign is read once until invalidated or past the TTL; campaigns are cached apart', async () => {
    const clock = { t: 0 };
    const cache = new DedicatedCallerIdCache(PACING_CACHE_TTL_MS, () => clock.t);
    cache.arm();
    repo.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101']]));
    expect(await cache.read('camp-1')).toEqual(new Map([['u1', '+14155550101']]));
    await cache.read('camp-1');
    await cache.read('camp-2');
    expect(repo.mapForCampaign).toHaveBeenCalledTimes(2);

    cache.invalidate('camp-1');
    await cache.read('camp-1');
    await cache.read('camp-2');
    expect(repo.mapForCampaign).toHaveBeenCalledTimes(3);

    clock.t += PACING_CACHE_TTL_MS;
    await cache.read('camp-2');
    expect(repo.mapForCampaign).toHaveBeenCalledTimes(4);
  });

  it('`fresh` reads through (and stores what it read)', async () => {
    const cache = new DedicatedCallerIdCache();
    cache.arm();
    await cache.read('camp-1');
    await cache.read('camp-1', { fresh: true });
    await cache.read('camp-1');
    expect(repo.mapForCampaign).toHaveBeenCalledTimes(2);
  });

  it('a read an invalidation overtook is returned but not stored: a released number is not cached', async () => {
    const cache = new DedicatedCallerIdCache();
    cache.arm();
    let resolve!: (m: Map<string, string>) => void;
    repo.mapForCampaign.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const inFlight = cache.read('camp-1');
    // The DELETE commits and publishes while the read (from before it) is in flight.
    cache.invalidate('camp-1');
    resolve(new Map([['u1', '+14155550101']]));
    expect(await inFlight).toEqual(new Map([['u1', '+14155550101']]));
    expect(await cache.read('camp-1')).toEqual(new Map());
    expect(repo.mapForCampaign).toHaveBeenCalledTimes(2);
  });

  it('a failed read rejects and stores nothing', async () => {
    const cache = new DedicatedCallerIdCache();
    cache.arm();
    repo.mapForCampaign.mockRejectedValueOnce(new Error('connection reset'));
    await expect(cache.read('camp-1')).rejects.toThrow('connection reset');
    await cache.read('camp-1');
    expect(repo.mapForCampaign).toHaveBeenCalledTimes(2);
  });

  it('disarm drops every entry and reads through; arm starts empty', async () => {
    const cache = new DedicatedCallerIdCache();
    cache.arm();
    await cache.read('camp-1');
    cache.disarm();
    await cache.read('camp-1');
    await cache.read('camp-1');
    expect(repo.mapForCampaign).toHaveBeenCalledTimes(3);
    cache.arm();
    await cache.read('camp-1');
    expect(repo.mapForCampaign).toHaveBeenCalledTimes(4);
  });
});

describe('DedicatedCallerIdCache.callerIdForContact (DN2)', () => {
  const cache = new DedicatedCallerIdCache();

  it('the contact owner\'s dedicated number, whatever the sticky', async () => {
    repo.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101']]));
    expect(await cache.callerIdForContact(CAMPAIGN, 'u1')).toBe('+14155550101');
    expect(await cache.callerIdForContact(CAMPAIGN, 'u1', { sticky: '+14155550100' })).toBe('+14155550101');
    expect(repo.mapForCampaign).toHaveBeenCalledWith('camp-1');
  });

  it('no owner, or an owner without one: the sticky while in the rotation, else the rotation', async () => {
    repo.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101']]));
    expect(await cache.callerIdForContact(CAMPAIGN, null, { sticky: '+14155550102' })).toBe('+14155550102');
    // Since dedicated to u1: not reused for a contact that is not theirs.
    expect(['+14155550100', '+14155550102']).toContain(await cache.callerIdForContact(CAMPAIGN, 'u2', { sticky: '+14155550101' }));
    expect(['+14155550100', '+14155550102']).toContain(await cache.callerIdForContact(CAMPAIGN, undefined));
  });

  it('a number the campaign no longer has is ignored; no usable caller ID at all is null', async () => {
    repo.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550999']]));
    expect(POOL).toContain(await cache.callerIdForContact(CAMPAIGN, 'u1'));
    expect(await cache.callerIdForContact({ ...CAMPAIGN, caller_ids: [' '] }, 'u1')).toBeNull();
  });

  it('a failed read rejects (the caller answers an error, never a rotation number)', async () => {
    repo.mapForCampaign.mockRejectedValueOnce(new Error('connection reset'));
    await expect(cache.callerIdForContact(CAMPAIGN, 'u1')).rejects.toThrow('connection reset');
  });
});

/**
 * The agent's own call and the wrap-up redial (`callerIdForContact`) decide over the campaign's
 * DIALABLE caller IDs (PL13): on a campaign pinned to a tenant's carrier account, a dedicated or
 * sticky number the account no longer has is not used, and the rotation is the dialable pool
 * minus the dedicated numbers.
 */
describe('DedicatedCallerIdCache.callerIdForContact over the dialable pool (DN2 with PL13)', () => {
  const cache = new DedicatedCallerIdCache();
  const CRED = '11111111-1111-4111-8111-111111111111';
  const PINNED = { ...CAMPAIGN, telephony_credential_id: CRED };

  it('a pinned campaign whose dedicated number was retired: the owner\'s contact dials from the rotation', async () => {
    repo.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101']]));
    phoneAssignments.findCredentialNumbersForAccount.mockResolvedValue(['+14155550100', '+14155550102']);
    expect(['+14155550100', '+14155550102']).toContain(await cache.callerIdForContact(PINNED, 'u1'));
    // The wrap-up redial's sticky number, retired too, is not reused.
    invalidateDialableCallerIds();
    phoneAssignments.findCredentialNumbersForAccount.mockResolvedValue(['+14155550102']);
    expect(await cache.callerIdForContact(PINNED, 'u2', { sticky: '+14155550100' })).toBe('+14155550102');
    expect(phoneAssignments.findCredentialNumbersForAccount).toHaveBeenCalledWith('t1', 'a1', CRED, POOL);
  });

  it('a pinned campaign whose dedicated number is live: the owner\'s contact dials from it, others never do', async () => {
    repo.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101']]));
    phoneAssignments.findCredentialNumbersForAccount.mockResolvedValue(['+14155550101', '+14155550102']);
    expect(await cache.callerIdForContact(PINNED, 'u1')).toBe('+14155550101');
    expect(await cache.callerIdForContact(PINNED, 'u2')).toBe('+14155550102');
  });

  it('a pinned campaign with nothing dialable left: null (the path refuses `no_caller_id`)', async () => {
    repo.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101']]));
    phoneAssignments.findCredentialNumbersForAccount.mockResolvedValue([]);
    expect(await cache.callerIdForContact(PINNED, 'u1')).toBeNull();
  });

  it('a service-account campaign is unchanged: the dedicated number while stored, no carrier-account read', async () => {
    repo.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101']]));
    expect(await cache.callerIdForContact(CAMPAIGN, 'u1')).toBe('+14155550101');
    expect(phoneAssignments.findCredentialNumbersForAccount).not.toHaveBeenCalled();
  });
});
