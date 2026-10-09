import { createHmac } from 'node:crypto';

export function maskPhone(phone: string): string {
  if (phone.length <= 8) return '****';
  return phone.substring(0, 5) + '****' + phone.substring(phone.length - 3);
}

export function maskName(name: string): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return name;
  const firstName = parts[0]!;
  const masked = parts.slice(1).map(p => p.charAt(0) + '****').join(' ');
  return `${firstName} ${masked}`;
}

export function maskAccountNumber(account: string): string {
  if (account.length <= 4) return '****';
  return '****' + account.substring(account.length - 2);
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '****';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = local.length <= 2 ? '****' : local.slice(0, 2) + '****';
  return `${maskedLocal}@${domain}`;
}

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const PHONE_CHARS = /^\+?[\d\s().-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function looksLikeEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

function looksLikePhone(value: string): boolean {
  const t = value.trim();
  // Don't mistake ISO dates / timestamps (sometimes logged on `from`/`to`) for phones.
  if (ISO_DATE_PREFIX.test(t)) return false;
  if (!PHONE_CHARS.test(t)) return false;
  const digits = t.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15; // E.164 max is 15 digits
}

/**
 * Value-aware PII masker for log fields. Masks only values that *look* like a
 * phone number or email so non-PII strings on the same field name (e.g. a state
 * enum on `from`/`to`) pass through untouched. Recurses into nested
 * objects/arrays. Used by the app logger's redact censor so contact identifiers
 * are masked — not destroyed — keeping logs correlatable while DPDP/GDPR-safe.
 */
export function maskPiiValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (looksLikeEmail(value)) return maskEmail(value);
    if (looksLikePhone(value)) return maskPhone(value.trim());
    return value;
  }
  if (Array.isArray(value)) return value.map(maskPiiValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskPiiValue(v);
    }
    return out;
  }
  return value;
}

export function maskPiiInObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      if (key.toLowerCase().includes('phone')) {
        result[key] = maskPhone(value);
      } else if (key.toLowerCase().includes('name') && !key.toLowerCase().includes('lender')) {
        result[key] = maskName(value);
      } else if (key.toLowerCase().includes('account')) {
        result[key] = maskAccountNumber(value);
      } else {
        result[key] = value;
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = maskPiiInObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = signPayload(payload, secret);
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}
