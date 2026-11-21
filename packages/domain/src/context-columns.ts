/**
 * The small readings every roster-column rule shares (AS19 S13): a column name folded for
 * comparison, a JSON object or nothing, the display's hidden columns, a context value as text and
 * whether it is blank, and a row's own key for a configured column name. The hero rule
 * (`./context-hero`), the name and place guess (`./customer-name`), the card's tiles
 * (`./fact-tiles`), the facts' keys (`./fact-fields`) and the server's campaign-config write all
 * read them from here, so none keeps its own copy. A LEAF: no I/O, no imports.
 *
 * Column names compare ignoring case and surrounding space ({@link fold}): `Loan No` and
 * ` loan no ` are one column. The display is `AgencyContextDisplay`, possibly hand-edited JSON, so
 * every reader here is lenient.
 */

/** A value that is present but carries no information. */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(['-', '--', 'n/a', 'na', 'null', 'none', '']);

/** A column name as compared: trimmed, lower case. */
export const fold = (name: string): string => name.trim().toLowerCase();

/** `value` when it is a JSON object (not an array, not null), else null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A string with something in it besides space. */
export const isNonBlankString = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;

/** The display configuration {@link hiddenSet} reads. */
export interface HiddenDisplay {
  hidden?: unknown;
}

/** The display's hidden columns, folded; an entry that is not a string is skipped. */
export function hiddenSet(display: HiddenDisplay | null | undefined): Set<string> {
  const hidden = Array.isArray(display?.hidden) ? display.hidden : [];
  return new Set(hidden.filter((h): h is string => typeof h === 'string').map(fold));
}

/** A context value as display text (`null` for none): strings as they are, scalars stringified, the rest as JSON. */
export function contextValueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Empty, or a placeholder such as `-` or `N/A`. */
export function isBlankContextValue(value: unknown): boolean {
  const text = contextValueText(value);
  return text === null || PLACEHOLDER_VALUES.has(text.trim().toLowerCase());
}

/**
 * The row's own key for a configured column name: the exact spelling first, then the first key
 * equal to it ignoring case; never a hidden one. Undefined when `name` is not a non-blank string,
 * is hidden, or the row has no such column.
 *
 * @param hidden the display's hidden columns, folded ({@link hiddenSet})
 */
export function rowKey(context: Record<string, unknown>, name: unknown, hidden: ReadonlySet<string>): string | undefined {
  if (!isNonBlankString(name) || hidden.has(fold(name))) return undefined;
  if (Object.hasOwn(context, name)) return name;
  return Object.keys(context).find((k) => fold(k) === fold(name) && !hidden.has(fold(k)));
}
