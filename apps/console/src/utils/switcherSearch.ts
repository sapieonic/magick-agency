/**
 * Naive substring filter for the top-bar tenant/account switcher lists.
 *
 * Deliberately simpler than `filterTenants` (super-admin combobox): one
 * case-insensitive needle, matched against name, optional subtitle (slug),
 * and id. No ranking, no multi-term AND. An empty/whitespace query returns
 * the original list in its original order.
 */

export interface SwitcherSearchItem {
  id: string;
  name: string;
  subtitle?: string;
}

export function filterSwitcherItems<T extends SwitcherSearchItem>(
  items: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => {
    if (item.name.toLowerCase().includes(needle)) return true;
    if (item.subtitle?.toLowerCase().includes(needle)) return true;
    return item.id.toLowerCase().includes(needle);
  });
}
