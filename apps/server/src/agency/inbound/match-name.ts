/**
 * A matched roster contact's display name, as inbound shows it (docs/inbound.md §6, §7): the
 * "Your customer is waiting" notice (`customer_waiting.match_name`) and the Missed row's
 * `match_name` (IQ54). The roster stores every non-phone CSV column in `context`, schemaless, so the
 * name is the first of these columns that holds text, trimmed, at most 100 characters. Pure.
 */

/** The `context` columns read for a name, in order. */
export const INBOUND_MATCH_NAME_COLUMNS = ['name', 'full_name', 'customer_name', 'first_name'] as const;

/** The longest name shown. */
export const INBOUND_MATCH_NAME_MAX = 100;

/** The contact's display name from its `context`, or undefined when it has none. */
export function matchName(context: Record<string, unknown> | null | undefined): string | undefined {
  if (!context) return undefined;
  for (const key of INBOUND_MATCH_NAME_COLUMNS) {
    const v = context[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, INBOUND_MATCH_NAME_MAX);
  }
  return undefined;
}
