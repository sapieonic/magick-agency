/**
 * Customer-facing aliases for telephony providers.
 *
 * SINGLE SOURCE OF TRUTH — edit this map to rename a carrier everywhere in the
 * UI (customer pages, super-admin telephony screens, charts, and copy).
 *
 * The tenant console shows the alias alone. The super-admin console shows the alias
 * with the vendor in parentheses, "Pravah (Plivo)", through its `operatorCarrierName`
 * (decision PL16): its operators sign in to the vendor's own console.
 *
 * Keys are the provider identifiers the API uses (`vobiz`, `twilio`, …).
 * Lookups are case-insensitive and tolerate spaces/hyphens, so `"VoBiz"` and
 * `"generic sip"` resolve the same as `"vobiz"` / `"generic_sip"`.
 *
 * Vendor names (Twilio, VoBiz, VoiceLink, Plivo, …) must not appear in the tenant
 * console for mapped providers. Unmapped providers fall back to the API display name
 * when one is supplied, then the trimmed slug.
 */

export const TELEPHONY_PROVIDER_ALIASES: Record<string, string> = {
  // तरंग — wave
  twilio: 'Tarang',
  // प्रवाह — flow
  plivo: 'Pravah',
  // एकवाणी — one voice
  exotel: 'Ekvani',
  // वाणी — speech
  vobiz: 'Vaani',
  // तेजस् — brilliance
  telnyx: 'Tejas',
  // स्वर — tone / voice
  voicelink: 'Swar',
  // नवतारा — new star
  z99: 'Navtara',
  // संचार — communication
  generic_sip: 'Sanchar',
};

/**
 * The vendors' own names, by the same keys, for the super-admin console's "Alias (Vendor)"
 * when an API row carries only the slug (its `operatorCarrierName`, PL16). The tenant console
 * never reads this: it shows the alias alone.
 */
export const TELEPHONY_PROVIDER_VENDOR_NAMES: Record<string, string> = {
  twilio: 'Twilio',
  plivo: 'Plivo',
  exotel: 'Exotel',
  vobiz: 'VoBiz',
  telnyx: 'Telnyx',
  voicelink: 'VoiceLink',
  z99: 'Z99',
  generic_sip: 'Generic SIP',
};

// There is no BYOC marker copy: BYOC is not supported.

/** Normalise an API slug or vendor display name into a map key. */
export function normalizeTelephonyProviderKey(provider: string): string {
  return provider.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** The vendor's own name for `provider` (slug or display name), or `null` when it is not mapped. */
export function telephonyProviderVendorName(provider: string | null | undefined): string | null {
  if (provider == null) return null;
  const key = normalizeTelephonyProviderKey(provider);
  return key !== '' && Object.hasOwn(TELEPHONY_PROVIDER_VENDOR_NAMES, key) ? TELEPHONY_PROVIDER_VENDOR_NAMES[key]! : null;
}

/** True when `provider` has a mapped customer alias (not a fallback). */
export function hasTelephonyProviderAlias(provider: string | null | undefined): boolean {
  if (provider == null) return false;
  const key = normalizeTelephonyProviderKey(provider);
  return key !== '' && Object.hasOwn(TELEPHONY_PROVIDER_ALIASES, key);
}

/**
 * Customer-facing name for a telephony provider.
 *
 * Lookup uses `Object.hasOwn` so prototype keys (`constructor`, `toString`, …)
 * never resolve to a function. Unknown providers prefer `fallbackDisplayName`
 * (the API's `provider_display_name` / `display_name`) over the raw slug.
 */
export function telephonyProviderAlias(
  provider: string | null | undefined,
  fallbackDisplayName?: string | null,
): string {
  const fallback = fallbackDisplayName?.trim() ?? '';
  if (provider == null) return fallback;
  const key = normalizeTelephonyProviderKey(provider);
  if (!key) return fallback;
  if (Object.hasOwn(TELEPHONY_PROVIDER_ALIASES, key)) {
    return TELEPHONY_PROVIDER_ALIASES[key]!;
  }
  return fallback || provider.trim();
}
