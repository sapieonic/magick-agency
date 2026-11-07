/*
 * Whether a campaign can place a call on its carrier account right now, beyond its own
 * row: the caller IDs that are still dialable (PL13) and the carrier's concurrency
 * allocation (PL14). Read at the dial (pacing, the agent's own dials, the soft phone),
 * at start and resume (a refusal a supervisor can act on), and by the health strip.
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
 * cache ({@link invalidateDialableCallerIds}) so the very next dial sees it.
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
import { usableCallerIds } from './pacing/caller-id-pool.js';

/** How long one read of a campaign's dialable caller IDs is reused. */
export const DIALABLE_CACHE_TTL_MS = 15_000;
const DIALABLE_CACHE_MAX_ENTRIES = 5_000;

type DialabilityCampaign = Pick<AgencyCampaignRecord, 'id' | 'tenant_id' | 'account_id' | 'caller_ids' | 'telephony_credential_id'>;

const cache = new Map<string, { numbers: string[]; expiresAt: number }>();

/** Forget every cached read: a number was synced, retired, unassigned or re-tagged. */
export function invalidateDialableCallerIds(): void {
  cache.clear();
}

/**
 * The caller IDs a campaign's dials may use now, in its stored order (PL13). Never throws
 * for a service-account campaign; a failed read for a pinned one rejects (the caller
 * treats it as it treats any other failed read on its path).
 */
export async function dialableCallerIds(campaign: DialabilityCampaign, now = Date.now()): Promise<string[]> {
  const pool = usableCallerIds(campaign as AgencyCampaignRecord);
  const credentialId = campaign.telephony_credential_id;
  if (!credentialId || pool.length === 0) return pool;
  const key = `${campaign.id}|${credentialId}|${pool.join(',')}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.numbers;
  const allowed = new Set(await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(
    campaign.tenant_id, campaign.account_id, credentialId, pool,
  ));
  const numbers = pool.filter((n) => allowed.has(n));
  if (cache.size >= DIALABLE_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, { numbers, expiresAt: now + DIALABLE_CACHE_TTL_MS });
  return numbers;
}

/** The campaign with its caller IDs narrowed to the dialable ones, for a path that reads the row. */
export async function withDialableCallerIds<T extends DialabilityCampaign>(campaign: T): Promise<T> {
  if (!campaign.telephony_credential_id) return campaign;
  return { ...campaign, caller_ids: await dialableCallerIds(campaign) };
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
    campaign.tenant_id, campaign.account_id, (campaign.telephony_provider || 'voicelink').toLowerCase(),
  );
  return allocation.mode === 'provider_breakdown' && (allocation.limit ?? 0) <= 0;
}

export type DialabilityRefusalCode = 'campaign_caller_ids_unavailable' | 'carrier_capacity_unallocated';

/**
 * Why a campaign may not start or resume for what its carrier account can dial now, or
 * null. Checked after `campaignCredentialStartRefusal` (an inactive account is the first
 * thing to fix).
 */
export async function campaignDialabilityStartRefusal(
  campaign: DialabilityCampaign & Pick<AgencyCampaignRecord, 'telephony_provider'>,
): Promise<{ status: 409; code: DialabilityRefusalCode; message: string } | null> {
  if (campaign.telephony_credential_id && usableCallerIds(campaign as AgencyCampaignRecord).length > 0
    && (await dialableCallerIds(campaign)).length === 0) {
    return {
      status: 409,
      code: 'campaign_caller_ids_unavailable',
      message: 'None of this campaign’s caller IDs is available on its carrier account any more, so it cannot place calls. '
        + 'Choose numbers that are still available in the campaign’s settings, or contact support if numbers are missing.',
    };
  }
  if (await carrierCapacityMissing(campaign)) {
    return {
      status: 409,
      code: 'carrier_capacity_unallocated',
      message: 'This account has no call capacity on this campaign’s carrier, so it cannot place calls. '
        + 'Contact support to add capacity for this carrier, or move the campaign to another carrier.',
    };
  }
  return null;
}
