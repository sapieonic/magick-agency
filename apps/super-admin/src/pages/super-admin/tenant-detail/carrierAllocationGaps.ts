import type { TenantAccountWithConcurrency } from '@magick-agency/contracts/api/platform/super-admin';

/** An account on a per-carrier breakdown that gives a carrier the tenant dials on no lines. */
export interface CarrierAllocationGap {
  accountId: string;
  accountName: string;
  /** The carrier identifier, lower case; shown through `telephonyProviderAlias`. */
  provider: string;
}

/**
 * The accounts whose per-carrier concurrency breakdown has no allocation (or zero) for a
 * carrier on which the tenant has an active carrier account (decision PL14). Such an
 * account's campaigns on that carrier would run and place no calls: the server refuses
 * to start them, and this is the warning that tells a super-admin to add the allocation.
 * An account on a legacy total shares it across every carrier, so it never has a gap.
 */
export function carrierAllocationGaps(
  accounts: readonly TenantAccountWithConcurrency[],
  activeCredentialProviders: readonly string[],
): CarrierAllocationGap[] {
  const carriers = [...new Set(activeCredentialProviders.map((p) => p.toLowerCase()))].sort();
  const gaps: CarrierAllocationGap[] = [];
  for (const account of accounts) {
    const allocation = account.concurrency;
    if (allocation?.mode !== 'provider_breakdown') continue;
    for (const provider of carriers) {
      const row = allocation.providers.find((p) => p.provider.toLowerCase() === provider);
      if (!row || row.max_concurrent_calls <= 0) {
        gaps.push({ accountId: account.id, accountName: account.name, provider });
      }
    }
  }
  return gaps;
}
