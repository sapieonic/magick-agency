/** `YYYY-MM-DD` from a date input, or null if the shape is wrong. */
function parseYmd(day: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/**
 * Inclusive local-calendar-day bounds as UTC ISO instants.
 *
 * Anchored from local noon so a DST fallback that lands on midnight cannot
 * skip or double-count the last hour of the selected day. The end is one
 * millisecond before the next local midnight.
 */
export function localDayStartIso(day: string): string | null {
  const parsed = parseYmd(day);
  if (!parsed) return null;
  const noon = new Date(parsed.y, parsed.m - 1, parsed.d, 12, 0, 0);
  if (Number.isNaN(noon.getTime())) return null;
  return new Date(noon.getFullYear(), noon.getMonth(), noon.getDate()).toISOString();
}

export function localDayEndIso(day: string): string | null {
  const parsed = parseYmd(day);
  if (!parsed) return null;
  const noon = new Date(parsed.y, parsed.m - 1, parsed.d, 12, 0, 0);
  if (Number.isNaN(noon.getTime())) return null;
  const nextMidnight = new Date(noon.getFullYear(), noon.getMonth(), noon.getDate() + 1);
  return new Date(nextMidnight.getTime() - 1).toISOString();
}
