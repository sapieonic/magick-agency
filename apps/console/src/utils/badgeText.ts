/**
 * A sidebar badge's text: the count, "99+" past 99 (or when the server capped the count), nothing
 * for none or not yet known. The Home and the missed-calls badges both use it.
 */
export function badgeText(count: number | null | undefined, capped = false): string | null {
  if (count === null || count === undefined || count <= 0) return null;
  return capped || count > 99 ? '99+' : String(count);
}
