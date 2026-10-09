/**
 * Strict integer parse. `Number()` alone would accept `1e3`, `0x10`, `1.5`,
 * ` 2000 `, and values above `Number.MAX_SAFE_INTEGER` (with precision loss).
 * We accept only an optional sign followed by digits, then delegate range/step
 * checks to the caller. Returns `null` on any parse failure so the caller can
 * distinguish "empty" (no error yet) from "invalid" (show error).
 *
 * Lifted out of the super-admin `NumberFlagDialog` so the broadcast
 * "Simultaneous calls" field shares ONE definition of "a whole number" with it:
 * two hand-rolled parsers are how `1.5` ends up accepted on one surface and
 * rejected on the other.
 */
export function parseStrictInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return null; // rejects >MAX_SAFE_INTEGER too
  return n;
}
