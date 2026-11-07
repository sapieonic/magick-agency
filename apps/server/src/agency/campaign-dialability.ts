/*
 * Whether a campaign can place a call on its carrier account right now, beyond its own
 * row: its carrier can dial from this server at all (PL12), the caller IDs that are still
 * dialable (PL13) and the carrier's concurrency allocation (PL14). Read at the dial
 * (pacing, the agent's own dials, the soft phone), at start and resume (a refusal a
 * supervisor can act on, {@link campaignDialBlockers}), and by the health strip.
 *
 * ── PL12: a tenant-account carrier that cannot dial from this server ─────────────────
 *
 * A campaign pinned to a tenant carrier account whose carrier cannot place calls from this
 * server (`carrierDialReady`: its webhook base is not configured) would have every dial
 * refused before the carrier, so it is not started. The service's own account is not
 * judged here: its base is required at load.
 *
 * ── PL13: a stored caller ID is dialled only while the carrier account still has it ──
 *
 * A campaign pinned to a tenant's own carrier account (`telephony_credential_id`) stores
 * its caller IDs when they are chosen. A number sync can later retire one (the carrier
 * no longer lists it), a super-admin can retire or unassign it, or untag it from the
 * account. Such a number stays in `caller_ids` (a save leaves it there, `campaign-carrier.ts`)
 * but is never dialled: the carrier refuses the call (each one charged to a contact) or
 * presents a number the tenant no longer owns. So the dial rotates only the stored numbers
 * that are still `active` on that credential and available to the campaign's account
 * (`findCredentialNumbersForAccount`, the rule the write itself applies).
 *
 * A campaign on the service's own account (no credential) is untouched: its pool is
 * `usableCallerIds`, with no read at all, exactly as before.
 *
 * The read is cached per campaign, credential and pool for {@link DIALABLE_CACHE_TTL_MS},
 * so a pacing tick costs nothing between reads; a sync, retire or unassign clears the
 * cache ({@link invalidateDialableCallerIds}) so the very next dial sees it. The cache is a
 * {@link GenerationTtlCache}: a read that started before a clear does not store what it
 * read when it returns (it would put a retired number back for a whole TTL). A lookup that
 * finds an entry expired deletes it, and a full cache drops its expired entries before
 * its oldest.
 *
 * ── PL14: a carrier with no allocation on a per-carrier breakdown cannot dial ─────────
 *
 * An account on a per-carrier concurrency breakdown (`provider_breakdown`) admits a call
 * only against its carrier's allocation, and a carrier with no allocation row (or zero)
 * has none: every dial is refused at admission, which pacing reads as back-pressure, so
 * the campaign runs and places nothing. {@link carrierCapacityMissing} names that state:
 * start and resume are refused for it, and the health strip says it of a running one.
 * It applies to every carrier, the service's own included.
 *
 * Messages are British English and name no carrier brand (they reach the console).
 */
import { providerConcurrencyRepository } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';
import { carrierDialReady } from '../telephony/carrier-dial-readiness.js';
import { DEFAULT_CAMPAIGN_PROVIDER } from './campaign-carrier.js';
import { usableCallerIds } from './pacing/caller-id-pool.js';
import { GenerationTtlCache, MAX_TRACKED_GENERATIONS } from './pacing/read-cache.js';

/** How long one read of a campaign's dialable caller IDs is reused. */
export const DIALABLE_CACHE_TTL_MS = 15_000;
const DIALABLE_CACHE_MAX_ENTRIES = 5_000;

export type DialabilityCampaign = Pick<AgencyCampaignRecord, 'id' | 'tenant_id' | 'account_id' | 'caller_ids' | 'telephony_credential_id'>;

const cache = new GenerationTtlCache<string[]>(
  DIALABLE_CACHE_TTL_MS, () => Date.now(), MAX_TRACKED_GENERATIONS, DIALABLE_CACHE_MAX_ENTRIES,
);

/**
 * Forget every cached read: a number was synced, retired, unassigned or re-tagged. A read in
 * flight across it stores nothing (the cache's generation moved).
 */
export function invalidateDialableCallerIds(): void {
  cache.clear();
}

/**
 * The caller IDs a campaign's dials may use now, in its stored order (PL13). Never throws
 * for a service-account campaign; a failed read for a pinned one rejects (the caller
 * treats it as it treats any other failed read on its path).
 */
export async function dialableCallerIds(campaign: DialabilityCampaign): Promise<string[]> {
  const pool = usableCallerIds(campaign as AgencyCampaignRecord);
  const credentialId = campaign.telephony_credential_id;
  if (!credentialId || pool.length === 0) return pool;
  const key = dialableCacheKey(campaign.id, credentialId, pool);
  const hit = cache.get(key);
  if (hit) return hit;
  // Read before the read starts: a clear while it runs moves it, and the store is skipped.
  const generation = cache.generation(key);
  const allowed = new Set(await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(
    campaign.tenant_id, campaign.account_id, credentialId, pool,
  ));
  const numbers = pool.filter((n) => allowed.has(n));
  cache.setIf(key, generation, numbers);
  return numbers;
}

function dialableCacheKey(campaignId: string, credentialId: string, pool: readonly string[]): string {
  return `${campaignId}|${credentialId}|${pool.join(',')}`;
}

/** The campaign with its caller IDs narrowed to the dialable ones, for a path that reads the row. */
export async function withDialableCallerIds<T extends DialabilityCampaign>(campaign: T): Promise<T> {
  if (!campaign.telephony_credential_id) return campaign;
  return { ...campaign, caller_ids: await dialableCallerIds(campaign) };
}

/**
 * {@link withDialableCallerIds} for many campaigns at once (the soft phone's list of
 * campaigns to tag a call with), in their order: each answer the cache holds, then one read
 * per carrier account for the rest, over the union of their pools, each campaign's numbers
 * filtered from it. The same numbers as one read per campaign: the rule is per number.
 */
export async function withDialableCallerIdsAll<T extends DialabilityCampaign>(
  campaigns: readonly T[],
): Promise<T[]> {
  const out = [...campaigns];
  const reads = new Map<string, {
    tenantId: string; accountId: string; credentialId: string; numbers: Set<string>;
    campaigns: Array<{ index: number; pool: string[]; key: string; generation: number }>;
  }>();
  campaigns.forEach((campaign, index) => {
    const credentialId = campaign.telephony_credential_id;
    if (!credentialId) return;
    const pool = usableCallerIds(campaign as DialabilityCampaign as AgencyCampaignRecord);
    const key = dialableCacheKey(campaign.id, credentialId, pool);
    const known = pool.length === 0 ? pool : cache.get(key);
    if (known) {
      out[index] = { ...campaign, caller_ids: known };
      return;
    }
    const readKey = `${campaign.tenant_id}|${campaign.account_id}|${credentialId}`;
    let read = reads.get(readKey);
    if (!read) {
      read = { tenantId: campaign.tenant_id, accountId: campaign.account_id, credentialId, numbers: new Set(), campaigns: [] };
      reads.set(readKey, read);
    }
    for (const n of pool) read.numbers.add(n);
    // Each key's generation before any read starts, as in `dialableCallerIds`.
    read.campaigns.push({ index, pool, key, generation: cache.generation(key) });
  });
  await Promise.all([...reads.values()].map(async (read) => {
    const allowed = new Set(await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(
      read.tenantId, read.accountId, read.credentialId, [...read.numbers],
    ));
    for (const { index, pool, key, generation } of read.campaigns) {
      const numbers = pool.filter((n) => allowed.has(n));
      cache.setIf(key, generation, numbers);
      out[index] = { ...campaigns[index]!, caller_ids: numbers };
    }
  }));
  return out;
}

/**
 * Whether the campaign's account is on a per-carrier concurrency breakdown that gives the
 * campaign's carrier no lines (PL14): every dial would be refused at admission. False on
 * the single-total mode, where every carrier shares the account's total.
 */
export async function carrierCapacityMissing(
  campaign: Pick<AgencyCampaignRecord, 'tenant_id' | 'account_id' | 'telephony_provider'>,
): Promise<boolean> {
  const allocation = await providerConcurrencyRepository.getProviderLimit(
    campaign.tenant_id, campaign.account_id, (campaign.telephony_provider || DEFAULT_CAMPAIGN_PROVIDER).toLowerCase(),
  );
  return allocation.mode === 'provider_breakdown' && (allocation.limit ?? 0) <= 0;
}

export type CampaignDialBlockerCode = 'carrier_not_ready' | 'campaign_caller_ids_unavailable' | 'carrier_capacity_unallocated';

/** A reason the campaign's carrier account cannot place a call now: its start or resume refusal. */
export interface CampaignDialBlocker {
  status: 409;
  code: CampaignDialBlockerCode;
  message: string;
}

const CARRIER_NOT_READY: CampaignDialBlocker = {
  status: 409,
  code: 'carrier_not_ready',
  message: 'This campaign’s carrier account cannot place calls yet: the platform is not set up to receive its call updates. Contact support to finish setting it up, or move the campaign to another carrier account.',
};

const CALLER_IDS_UNAVAILABLE: CampaignDialBlocker = {
  status: 409,
  code: 'campaign_caller_ids_unavailable',
  message: 'None of this campaign’s caller IDs is available on its carrier account any more, so it cannot place calls. '
    + 'Choose numbers that are still available in the campaign’s settings, or contact support if numbers are missing.',
};

const CARRIER_CAPACITY_UNALLOCATED: CampaignDialBlocker = {
  status: 409,
  code: 'carrier_capacity_unallocated',
  message: 'This account has no call capacity on this campaign’s carrier, so it cannot place calls. '
    + 'Contact support to add capacity for this carrier, or move the campaign to another carrier.',
};

/**
 * The PL12 check alone: a campaign pinned to a tenant carrier account whose carrier cannot
 * dial from this server, or null (never for the service's own account). No read.
 */
export function carrierNotReadyBlocker(
  campaign: Pick<AgencyCampaignRecord, 'telephony_provider' | 'telephony_credential_id'>,
): CampaignDialBlocker | null {
  return campaign.telephony_credential_id && !carrierDialReady(campaign.telephony_provider) ? CARRIER_NOT_READY : null;
}

/**
 * What blocks the campaign from placing a call now, in the order start and resume answer
 * them (PL12, PL13, PL14), or `[]`. Checked after `campaignCredentialStartRefusal` (an
 * inactive account is the first thing to fix). Vendor-free: it reaches the console.
 *
 * The reads run in parallel; the list is read in order. A read that fails rejects, unless an
 * earlier check already blocks: then the list ends there, so the first blocker is the answer
 * the checks run one after another would give.
 */
export async function campaignDialBlockers(
  campaign: DialabilityCampaign & Pick<AgencyCampaignRecord, 'telephony_provider'>,
): Promise<CampaignDialBlocker[]> {
  const checks: Array<[CampaignDialBlocker, Promise<boolean>]> = [
    [CARRIER_NOT_READY, Promise.resolve(carrierNotReadyBlocker(campaign) !== null)],
    [CALLER_IDS_UNAVAILABLE, campaign.telephony_credential_id && usableCallerIds(campaign as AgencyCampaignRecord).length > 0
      ? dialableCallerIds(campaign).then((numbers) => numbers.length === 0)
      : Promise.resolve(false)],
    [CARRIER_CAPACITY_UNALLOCATED, carrierCapacityMissing(campaign)],
  ];
  // Each read is awaited below, or its failure is moot once an earlier check blocks.
  for (const [, blocked] of checks) blocked.catch(() => undefined);
  const blockers: CampaignDialBlocker[] = [];
  for (const [blocker, blocked] of checks) {
    try {
      if (await blocked) blockers.push(blocker);
    } catch (err) {
      if (blockers.length === 0) throw err;
      break;
    }
  }
  return blockers;
}
