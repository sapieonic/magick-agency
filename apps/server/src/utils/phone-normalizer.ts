const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_PHONE_COUNTRY_CODE?.replace(/^\+/, '') || '91';

export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export interface NormalizeOptions {
  defaultCountryCode?: string;
}

/**
 * Normalize a raw phone string to E.164 (e.g. `+919876543210`).
 *
 * Rules:
 *   - Strip whitespace, dashes, parens, dots from the input.
 *   - If the input begins with `+`, the country code is honored as-is and only the final E.164 shape is validated.
 *   - Otherwise, the default country code (env `DEFAULT_PHONE_COUNTRY_CODE`, falling back to `91`) is applied:
 *       - Leading zeros (national trunk prefix) are stripped.
 *       - 10-digit local numbers get the default country code prepended.
 *       - Strings that already begin with the default country code get only a `+` prepended.
 *       - Anything else falls back to prepending the default country code.
 *
 * Returns `null` for input that cannot be coerced into valid E.164.
 */
export function normalizePhoneToE164(raw: string | null | undefined, options: NormalizeOptions = {}): string | null {
  if (!raw) return null;

  const defaultCC = (options.defaultCountryCode ?? DEFAULT_COUNTRY_CODE).replace(/^\+/, '');
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (cleaned.length === 0) return null;

  if (cleaned.startsWith('+')) {
    return E164_REGEX.test(cleaned) ? cleaned : null;
  }

  if (!/^\d+$/.test(cleaned)) return null;

  const digits = cleaned.replace(/^0+/, '');
  if (digits.length === 0) return null;

  let candidate: string;
  if (digits.length === 10) {
    candidate = `+${defaultCC}${digits}`;
  } else if (digits.startsWith(defaultCC)) {
    candidate = `+${digits}`;
  } else {
    return null;
  }

  return E164_REGEX.test(candidate) ? candidate : null;
}

export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}

/**
 * Normalize an array of phone numbers. Each entry is normalized via {@link normalizePhoneToE164};
 * entries that cannot be normalized are left unchanged so that downstream validation can produce
 * a meaningful error per-entry.
 */
export function normalizePhonesArray(phones: unknown, options: NormalizeOptions = {}): string[] {
  if (!Array.isArray(phones)) return [];
  return phones.map((p) => {
    if (typeof p !== 'string') return String(p);
    return normalizePhoneToE164(p, options) ?? p;
  });
}

/**
 * Normalize the keys of a `phone -> variables` map (used for per-phone TTS variable overrides).
 * Useful for routes that accept both `phones` and `phone_variables` keyed by phone string.
 */
export function normalizePhoneVariablesMap(
  phoneVariables: unknown,
  options: NormalizeOptions = {},
): Record<string, Record<string, string>> | undefined {
  if (!phoneVariables || typeof phoneVariables !== 'object' || Array.isArray(phoneVariables)) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(phoneVariables as Record<string, unknown>)) {
    const normalizedKey = normalizePhoneToE164(key, options) ?? key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[normalizedKey] = value as Record<string, string>;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
