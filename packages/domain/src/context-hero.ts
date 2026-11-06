/**
 * Which of a roster row's columns are its "hero" fields: the few that say who the row is (Name,
 * Loan No., …). A LEAF: no I/O, no imports.
 *
 * The rule is the contact panel's (`apps/console/src/utils/agencyContext.ts`,
 * `resolveContextFields`), over the contract's `AgencyContextDisplay`:
 *  1. the campaign's `hero` columns, in array order, matched case-insensitively, at most
 *     {@link MAX_HERO_FIELDS};
 *  2. none configured (or none present on this row): one column per heuristic bucket (a name, an
 *     amount, an identifier, a place), in bucket order, skipping empty values;
 *  3. still none: the first {@link MAX_HERO_FIELDS} columns with a value, in the file's order;
 *  4. minus `hidden` (case-insensitive) at every stage: a hidden column is never a hero.
 *
 * "The file's order" is the roster import's column order (`agency_ingest_jobs.context_columns`)
 * when the caller has it, then any other key. A JSONB object does not keep it: Postgres returns
 * its keys sorted by length, then bytes.
 */

/** Hero fields are capped (the contract: "keep it to ~4; the console may cap it"). */
export const MAX_HERO_FIELDS = 4;

/** A value that is present but carries no information. */
const PLACEHOLDER_VALUES = new Set(['-', '--', 'n/a', 'na', 'null', 'none', '']);

const HERO_HEURISTICS: readonly RegExp[] = [
  /^(full[\s_-]?)?name$|customer|contact|first.?name|client/i,
  /amount|balance|due|outstanding|premium|emi|total/i,
  /policy|account|loan|invoice|order|ticket|ref/i,
  /city|branch|region|zone|state/i,
];

/** The display configuration this reads (`AgencyContextDisplay`, possibly hand-edited JSON). */
export interface HeroDisplay {
  hero?: unknown;
  hidden?: unknown;
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

const names = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];

/**
 * The row's hero columns (its own key spelling), in display order.
 *
 * @param context     the row's columns (`agency_contacts.context`)
 * @param display     the campaign's `context_display`
 * @param columnOrder the import's column order, when known
 */
export function heroColumnsFor(
  context: Record<string, unknown>,
  display: HeroDisplay | null | undefined,
  columnOrder: readonly string[] | null = null,
): string[] {
  const keys = Object.keys(context);
  const present = new Set(keys);
  const ordered = [...new Set([...(columnOrder ?? []).filter((k) => present.has(k)), ...keys])];
  const hidden = new Set(names(display?.hidden).map((k) => k.trim().toLowerCase()));
  const visible = ordered.filter((k) => !hidden.has(k.trim().toLowerCase()));

  const configured: string[] = [];
  for (const name of names(display?.hero)) {
    const match = visible.find((k) => k.trim().toLowerCase() === name.trim().toLowerCase());
    if (match !== undefined && !configured.includes(match)) configured.push(match);
  }
  if (configured.length > 0) return configured.slice(0, MAX_HERO_FIELDS);

  const guessed: string[] = [];
  for (const pattern of HERO_HEURISTICS) {
    const match = visible.find((k) => !guessed.includes(k) && pattern.test(k) && !isBlankContextValue(context[k]));
    if (match !== undefined) guessed.push(match);
  }
  if (guessed.length > 0) return guessed.slice(0, MAX_HERO_FIELDS);

  return visible.filter((k) => !isBlankContextValue(context[k])).slice(0, MAX_HERO_FIELDS);
}
