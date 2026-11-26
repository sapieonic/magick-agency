import type { TelephonyProvider } from '../api/super-admin';

/**
 * What a carrier row says it supports (docs/carriers.md CR1, CR6, CR11), read once for every
 * screen that offers or hides something by it: the service's own account, tenants' own
 * accounts, where a tenant account's numbers come from, and inbound calls.
 *
 * The capability fields are optional on the wire type: an older server sends only
 * `takes_tenant_credentials`. Then a carrier that takes tenants' accounts reads as it did
 * before: tenant accounts only, numbers synced, inbound offered; any other as the service's
 * own account only.
 */
export interface CarrierModes {
  /** A number added with no credential is on the service's own account. */
  service: boolean;
  /** A number may be on a tenant's own account (a credential). */
  tenant: boolean;
  /** Where a tenant account's numbers come from; null when it takes no tenant accounts. */
  numberSource: 'sync' | 'manual' | null;
  /** A tenant account on it takes inbound calls. */
  inbound: boolean;
}

type ProviderCapabilities = Pick<
  TelephonyProvider,
  'takes_tenant_credentials' | 'service_account' | 'tenant_accounts' | 'number_source' | 'supports_inbound'
>;

export function carrierModes(provider: ProviderCapabilities): CarrierModes {
  const legacyTenant = provider.takes_tenant_credentials === true;
  const tenant = provider.tenant_accounts ?? legacyTenant;
  return {
    service: provider.service_account ?? !legacyTenant,
    tenant,
    numberSource: provider.number_source !== undefined ? provider.number_source : tenant ? 'sync' : null,
    inbound: provider.supports_inbound ?? legacyTenant,
  };
}

/**
 * Whether "Add number" offers the carrier (CR6): it has the service's own account, or its
 * tenant accounts' numbers are added by hand. A carrier whose numbers sync is never offered.
 */
export function numbersAddedByHand(provider: ProviderCapabilities): boolean {
  const modes = carrierModes(provider);
  return modes.service || (modes.tenant && modes.numberSource === 'manual');
}

/**
 * Whether a number on this carrier may be put on a tenant's own account by hand, so "Add
 * number" asks which account.
 */
export function takesTenantNumbersByHand(provider: ProviderCapabilities): boolean {
  const modes = carrierModes(provider);
  return modes.tenant && modes.numberSource === 'manual';
}

/** A tenant's carrier account as operator screens name it in a picker: "Acme · Acme main". */
export function credentialAccountName(
  credential: { tenant_id: string; label: string },
  tenantName: ReadonlyMap<string, string>,
): string {
  return `${tenantName.get(credential.tenant_id) ?? credential.tenant_id} · ${credential.label}`;
}

/**
 * The tenant accounts a number on `providerName` can be put on: that carrier's ACTIVE
 * credentials, named "Tenant · label", in name order (Add number and Move to a tenant's
 * account offer the same list).
 */
export function activeAccountChoices(
  credentials: readonly { id: string; tenant_id: string; label: string; provider: string; status: string }[] | null,
  providerName: string,
  tenantName: ReadonlyMap<string, string>,
): Array<{ id: string; name: string }> {
  return (credentials ?? [])
    .filter(c => c.status === 'active' && c.provider.toLowerCase() === providerName.toLowerCase())
    .map(c => ({ id: c.id, name: credentialAccountName(c, tenantName) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
