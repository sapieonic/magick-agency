/**
 * Normalize user input to E.164 format (e.g. +919876543210).
 *
 * The backend phone filter is an exact E.164 match, so the UI must send the
 * full number with country code. Formatting characters (spaces, dashes,
 * parentheses, dots) are stripped and a missing leading `+` is added; partial
 * or malformed inputs return null.
 */
export function normalizeE164(input: string): string | null {
  const cleaned = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?[1-9]\d{6,14}$/.test(cleaned)) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}
