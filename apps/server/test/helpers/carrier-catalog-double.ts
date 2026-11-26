// A carrier catalogue with some carriers' account modes (and inbound) set by the test, for the
// rules that read the account mode (docs/carriers.md CR1, CR6–CR11). Every helper of
// `src/telephony/carrier-catalog.ts` is re-derived from the doubled descriptors, so a rule that
// reads any of them sees the same carriers.
//
//   const carriers = vi.hoisted(() => ({ voicelink: { accounts: { service: true, tenant: true } } }));
//   vi.mock('../../src/telephony/carrier-catalog.js', async (importOriginal) =>
//     (await import('../helpers/carrier-catalog-double.js')).catalogDouble(await importOriginal(), carriers));
//
// The overrides are read at every call, so a test may change them (`carriers.voicelink = …`) for
// the cases it needs. A test names the modes it needs explicitly, so it stays right whatever the
// real entry declares (VoiceLink takes tenant accounts once docs/carriers.md step 2 lands; a
// double that pins it service-only or hybrid keeps meaning the same).
import type * as Catalog from '../../src/telephony/carrier-catalog.js';

type CatalogModule = typeof Catalog;
export type CarrierOverride = Partial<Pick<Catalog.CarrierDescriptor, 'accounts' | 'inbound' | 'cancelsRinging'>>;

/** Service account only. */
export const SERVICE_ONLY: CarrierOverride = { accounts: { service: true, tenant: false } };
/** Both modes (VoiceLink once it takes tenant accounts). */
export const HYBRID: CarrierOverride = { accounts: { service: true, tenant: true } };
/** Tenant accounts only (Plivo). */
export const TENANT_ONLY: CarrierOverride = { accounts: { service: false, tenant: true } };

export function catalogDouble(actual: CatalogModule, overrides: Record<string, CarrierOverride | undefined>): CatalogModule {
  const findCarrier = (provider: string | null | undefined): Catalog.CarrierDescriptor | undefined => {
    if (!provider) return undefined;
    const real = actual.findCarrier(provider);
    const over = overrides[provider];
    if (!over) return real;
    return {
      ...(real ?? {
        name: provider,
        cancelsRinging: false,
        accounts: { service: false, tenant: false },
        inbound: false,
        recordingsArePublic: false,
        webhookBaseUrl: () => '',
      }),
      ...over,
    };
  };
  const carrierHasServiceAccount = (p: string | null | undefined) => findCarrier(p)?.accounts.service === true;
  const carrierTakesTenantAccounts = (p: string | null | undefined) => findCarrier(p)?.accounts.tenant === true;
  return {
    ...actual,
    findCarrier,
    carrierNames: () => [...new Set([...actual.carrierNames(), ...Object.keys(overrides).filter((k) => overrides[k])])],
    carrierHasServiceAccount,
    carrierTakesTenantAccounts,
    carrierSupportsInbound: (p) => findCarrier(p)?.inbound === true,
    carrierAccountModeAllowed: (p, credentialId) => (credentialId === null ? carrierHasServiceAccount(p) : carrierTakesTenantAccounts(p)),
    carrierCancelsRinging: (p) => findCarrier(p)?.cancelsRinging === true,
  };
}
