import {
  normalizeTelephonyProviderKey,
  telephonyProviderAlias,
} from '@magick-agency/web-ui/telephonyProviders';

/**
 * How the super-admin console names a carrier (decision PL16): the customer-facing alias
 * first, then the vendor in parentheses, "Pravah (Plivo)". Operators sign in to the
 * vendor's own console to find an account's Auth ID or a number, so they need the real
 * name; the alias comes first so the two consoles read the same. Every super-admin screen
 * that names a carrier goes through this (`__tests__/branding/carrierNames.test.ts`).
 * The tenant console never names a vendor (`telephonyProviderAlias` alone).
 */

/** The vendors' own names, for an API row that carries only the slug. */
const VENDOR_NAMES: Record<string, string> = {
  twilio: 'Twilio',
  plivo: 'Plivo',
  exotel: 'Exotel',
  vobiz: 'VoBiz',
  telnyx: 'Telnyx',
  voicelink: 'VoiceLink',
  z99: 'Z99',
  generic_sip: 'Generic SIP',
};

/**
 * "Alias (Vendor)" for `provider` (the API slug). `vendorName` is the API's display
 * name when the row has one; otherwise the vendor's name comes from the slug. A carrier
 * with no alias reads as its vendor name alone.
 */
export function operatorCarrierName(provider: string | null | undefined, vendorName?: string | null): string {
  const key = provider == null ? '' : normalizeTelephonyProviderKey(provider);
  const vendor = vendorName?.trim()
    || (key && Object.hasOwn(VENDOR_NAMES, key) ? VENDOR_NAMES[key]! : (provider ?? '').trim());
  const alias = telephonyProviderAlias(provider, vendor);
  if (!vendor || alias.toLowerCase() === vendor.toLowerCase()) return alias || vendor;
  return `${alias} (${vendor})`;
}
