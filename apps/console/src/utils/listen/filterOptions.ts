/**
 * The person and campaign filters' choices on the listening pages (the Live calls table, the
 * Listening history), built one way: the names known, plus the one chosen when nothing else
 * offers it, so a filter in force always reads as itself in its control. By name.
 */

/** One choice in a filter: an id and the name it is shown by. */
export interface FilterOption {
  id: string;
  name: string;
}

/** `names` (id → name) as choices by name, with `keep` added when `names` does not hold its id. */
export function sortedFilterOptions(names: ReadonlyMap<string, string>, keep?: FilterOption | null): FilterOption[] {
  const options = [...names].map(([id, name]) => ({ id, name }));
  if (keep && !names.has(keep.id)) options.push({ id: keep.id, name: keep.name });
  return options.sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
}
