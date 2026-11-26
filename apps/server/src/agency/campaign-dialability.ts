/*
 * Whether a campaign can place a call on its carrier account right now, beyond its own
 * row: its carrier can dial from this server at all (PL12), the caller IDs that are still
 * dialable (PL13 on a tenant's account, CR9 on the service's) and the carrier's concurrency
 * allocation (PL14). Read at the dial
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
 * ── CR9: a campaign on the service's own account never dials a number pinned to a credential ─
 *
 * A campaign on the service's own account (no credential) dials its stored numbers
 * (`usableCallerIds`) except every one that is a number pinned to ANY credential, whatever its
 * status or tenant (`phoneNumberRepository.findPinnedAmong`, the rule the write applies): that is
 * a tenant's own number, and dialling it on the service's account bills and presents it on the
 * wrong carrier account. The write refuses such a number (`campaign-carrier.ts`), but a campaign
 * can still hold one: written before CR9, inherited by a retry, or holding a number that a move
 * (CR6), a hand-added number or a sync pinned after the campaign was written. A number not in the
 * inventory at all is dialled, as before (the service's caller IDs are shape-checked only).
 *
 * The read is cached per campaign, carrier account and pool for {@link DIALABLE_CACHE_TTL_MS},
 * so a pacing tick costs nothing between reads; a sync, retire, unassign, a number added by hand
 * or moved onto a tenant's account clears the WHOLE cache ({@link invalidateDialableCallerIds}),
 * service-account campaigns' entries included, so the very next dial sees it. The cache is a
 * {@link GenerationTtlCache}: a read that started before a clear does not store what it
 * read when it returns (it would put a retired number back for a whole TTL). A lookup that
 * finds an entry expired deletes it, and a full cache drops its expired entries before
 * its oldest.
 *
 * With media workers (`MEDIA_WORKERS`) every worker keeps its own cache: the dials that run
 * there (the agent's own call, the wrap-up redial, the tagged soft phone) read it. The
 * clear runs where the change is made (the super-admin routes, in the primary), and the
 * primary sends it to every worker (`dialable.invalidate`, {@link onDialableCallerIdsInvalidated},
 * `cluster/primary.ts`), which clears its own ({@link clearDialableCallerIdCache}). A lost
 * message costs at most the TTL.
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
import { phoneNumberRepository } from '@magick-agency/db/repositories/phone-number.repository';
import { providerConcurrencyRepository } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';
import { carrierDialReady } from '../telephony/carrier-dial-readiness.js';
import { createChildLogger } from '@magick-agency/observability';
import { DEFAULT_CAMPAIGN_PROVIDER } from './campaign-carrier.js';
import { usableCallerIds } from './pacing/caller-id-pool.js';
import { GenerationTtlCache, MAX_TRACKED_GENERATIONS } from './pacing/read-cache.js';

const log = createChildLogger({ component: 'agency-campaign-dialability' });

/** How long one read of a campaign's dialable caller IDs is reused. */
export const DIALABLE_CACHE_TTL_MS = 15_000;
const DIALABLE_CACHE_MAX_ENTRIES = 5_000;

export type DialabilityCampaign = Pick<AgencyCampaignRecord, 'id' | 'tenant_id' | 'account_id' | 'caller_ids' | 'telephony_credential_id'>;

const cache = new GenerationTtlCache<string[]>(
  DIALABLE_CACHE_TTL_MS, () => Date.now(), MAX_TRACKED_GENERATIONS, DIALABLE_CACHE_MAX_ENTRIES,
);

/** Who else must hear of a clear: the primary's relay to its media workers. */
const invalidationListeners = new Set<() => void>();

/**
 * Forget every cached read, here and (through {@link onDialableCallerIdsInvalidated}) in
 * every media worker: a number was synced, retired, unassigned, re-tagged, added by hand or
 * moved onto a tenant's account (which takes it out of every service-account campaign's pool).
 */
export function invalidateDialableCallerIds(): void {
  clearDialableCallerIdCache();
  for (const listener of invalidationListeners) {
    try {
      listener();
    } catch (err) {
      log.warn({ err }, 'Could not relay a dialable caller-ID invalidation — the other processes see it within the cache TTL');
    }
  }
}

/**
 * Forget every cached read in THIS process only: what a media worker runs when the primary
 * relays a clear. A read in flight across it stores nothing (the cache's generation moved).
 */
export function clearDialableCallerIdCache(): void {
  cache.clear();
}

/** Hear every {@link invalidateDialableCallerIds} of this process. Returns the unsubscribe. */
export function onDialableCallerIdsInvalidated(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

/** The cache's name for the service's own carrier account (a credential is a UUID). */
const SERVICE_ACCOUNT = 'service';

/**
 * The caller IDs a campaign's dials may use now, in its stored order: on a tenant's own carrier
 * account those still active on its credential and available to the account (PL13); on the
 * service's own account all of them but the numbers pinned to a credential (CR9). A failed read
 * rejects (the caller treats it as it treats any other failed read on its path).
 */
export async function dialableCallerIds(campaign: DialabilityCampaign): Promise<string[]> {
  const pool = usableCallerIds(campaign as AgencyCampaignRecord);
  if (pool.length === 0) return pool;
  const account = campaign.telephony_credential_id || SERVICE_ACCOUNT;
  const key = dialableCacheKey(campaign.id, account, pool);
  const hit = cache.get(key);
  if (hit) return hit;
  // Read before the read starts: a clear while it runs moves it, and the store is skipped.
  const generation = cache.generation(key);
  const numbers = account === SERVICE_ACCOUNT
    ? withoutPinned(pool, await phoneNumberRepository.findPinnedAmong(pool))
    : keepOnly(pool, await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(
      campaign.tenant_id, campaign.account_id, account, pool,
    ));
  cache.setIf(key, generation, numbers);
  return numbers;
}

function keepOnly(pool: readonly string[], allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  return pool.filter((n) => set.has(n));
}

function withoutPinned(pool: readonly string[], pinned: readonly string[]): string[] {
  const set = new Set(pinned);
  return pool.filter((n) => !set.has(n));
}

function dialableCacheKey(campaignId: string, account: string, pool: readonly string[]): string {
  return `${campaignId}|${account}|${pool.join(',')}`;
}

/** The campaign with its caller IDs narrowed to the dialable ones, for a path that reads the row. */
export async function withDialableCallerIds<T extends DialabilityCampaign>(campaign: T): Promise<T> {
  return { ...campaign, caller_ids: await dialableCallerIds(campaign) };
}

/**
 * {@link withDialableCallerIds} for many campaigns at once (the soft phone's list of
 * campaigns to tag a call with), in their order: each answer the cache holds, then one read
 * per carrier account for the rest, over the union of their pools, each campaign's numbers
 * filtered from it (the service's own account is one read for all its campaigns, of the pinned
 * numbers, CR9). The same numbers as one read per campaign: the rule is per number.
 */
export async function withDialableCallerIdsAll<T extends DialabilityCampaign>(
  campaigns: readonly T[],
): Promise<T[]> {
  const out = [...campaigns];
  const reads = new Map<string, {
    tenantId: string; accountId: string; account: string; numbers: Set<string>;
    campaigns: Array<{ index: number; pool: string[]; key: string; generation: number }>;
  }>();
  campaigns.forEach((campaign, index) => {
    const account = campaign.telephony_credential_id || SERVICE_ACCOUNT;
    const pool = usableCallerIds(campaign as DialabilityCampaign as AgencyCampaignRecord);
    const key = dialableCacheKey(campaign.id, account, pool);
    const known = pool.length === 0 ? pool : cache.get(key);
    if (known) {
      out[index] = { ...campaign, caller_ids: known };
      return;
    }
    // Pinned is pinned whoever's campaign it is: one read for every service-account campaign.
    const readKey = account === SERVICE_ACCOUNT ? SERVICE_ACCOUNT : `${campaign.tenant_id}|${campaign.account_id}|${account}`;
    let read = reads.get(readKey);
    if (!read) {
      read = { tenantId: campaign.tenant_id, accountId: campaign.account_id, account, numbers: new Set(), campaigns: [] };
      reads.set(readKey, read);
    }
    for (const n of pool) read.numbers.add(n);
    // Each key's generation before any read starts, as in `dialableCallerIds`.
    read.campaigns.push({ index, pool, key, generation: cache.generation(key) });
  });
  await Promise.all([...reads.values()].map(async (read) => {
    const numbers = [...read.numbers];
    let narrow: (pool: readonly string[]) => string[];
    if (read.account === SERVICE_ACCOUNT) {
      const pinned = await phoneNumberRepository.findPinnedAmong(numbers);
      narrow = (pool) => withoutPinned(pool, pinned);
    } else {
      const allowed = await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(
        read.tenantId, read.accountId, read.account, numbers,
      );
      narrow = (pool) => keepOnly(pool, allowed);
    }
    for (const { index, pool, key, generation } of read.campaigns) {
      const dialable = narrow(pool);
      cache.setIf(key, generation, dialable);
      out[index] = { ...campaigns[index]!, caller_ids: dialable };
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
  return campaign.telephony_credential_id && !carrierDialReady(campaign.telephony_provider, 'tenant') ? CARRIER_NOT_READY : null;
}

/**
 * What blocks the campaign from placing a call now, in the order start and resume answer
 * them (PL12, PL13 or CR9, PL14), or `[]`. Checked after `campaignCredentialStartRefusal` (an
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
    // An empty stored pool is not this one (the write refuses it; pacing names it apart).
    [CALLER_IDS_UNAVAILABLE, usableCallerIds(campaign as AgencyCampaignRecord).length > 0
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
