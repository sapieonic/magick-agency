/**
 * Which of a roster row's columns are its "hero" fields: the few that say who the row is (Name,
 * Loan No., …). A LEAF: no I/O, no imports. The ONE copy of the rule: the console's contact panel
 * (`apps/console/src/utils/agencyContext.ts`, `resolveContextFields`), customer history
 * (`apps/server/src/agency/customer-history/assemble.ts`) and the agent's own-contacts list
 * (`heroColumns`, `apps/server/src/db/repositories/agency/assignment-reads.repository.ts`) all
 * read it from here.
 *
 * Over the contract's `AgencyContextDisplay`:
 *  1. the campaign's `hero` columns, in array order, matched case-insensitively, at most
 *     {@link MAX_HERO_FIELDS} ({@link configuredHeroNames} is this stage without a row);
 *  2. none configured (or none present on this row): one column per heuristic bucket (a name, an
 *     amount, an identifier, a place), in bucket order, skipping empty values;
 *  3. still none: the first {@link MAX_HERO_FIELDS} columns with a value, in the file's order
 *     (customer history; the contact panel turns it off, since it lists every column anyway);
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

const fold = (name: string): string => name.trim().toLowerCase();

/**
 * The campaign's configured hero names, without a row: `hero` in array order, each name as
 * written, blank and repeated names dropped, minus `hidden` (case-insensitive). Not capped: a
 * caller that matches them against rows caps what matched ({@link heroColumnsFor}).
 */
export function configuredHeroNames(display: HeroDisplay | null | undefined): string[] {
  const hidden = new Set(names(display?.hidden).map(fold));
  return [...new Set(names(display?.hero).filter((name) => !hidden.has(fold(name))))];
}

/** How a surface applies the rule. */
export interface HeroColumnOptions {
  /** At most this many heroes (default {@link MAX_HERO_FIELDS}). */
  max?: number;
  /**
   * Stage 3: with nothing configured or guessed, the first columns with a value (default true).
   * The contact panel passes false: it lists every column under the heroes, so it pins nothing
   * rather than pin columns nobody chose.
   */
  fallbackToFirstColumns?: boolean;
}

/**
 * The row's hero columns (its own key spelling), in display order.
 *
 * @param context     the row's columns (`agency_contacts.context`)
 * @param display     the campaign's `context_display`
 * @param columnOrder the import's column order, when known
 * @param options     the surface's cap and whether stage 3 applies
 */
export function heroColumnsFor(
  context: Record<string, unknown>,
  display: HeroDisplay | null | undefined,
  columnOrder: readonly string[] | null = null,
  options: HeroColumnOptions = {},
): string[] {
  const max = options.max ?? MAX_HERO_FIELDS;
  const keys = Object.keys(context);
  const present = new Set(keys);
  const ordered = [...new Set([...(columnOrder ?? []).filter((k) => present.has(k)), ...keys])];
  const hidden = new Set(names(display?.hidden).map(fold));
  const visible = ordered.filter((k) => !hidden.has(fold(k)));

  const configured: string[] = [];
  for (const name of configuredHeroNames(display)) {
    const match = visible.find((k) => fold(k) === fold(name));
    if (match !== undefined && !configured.includes(match)) configured.push(match);
  }
  if (configured.length > 0) return configured.slice(0, max);

  const guessed: string[] = [];
  for (const pattern of HERO_HEURISTICS) {
    const match = visible.find((k) => !guessed.includes(k) && pattern.test(k) && !isBlankContextValue(context[k]));
    if (match !== undefined) guessed.push(match);
  }
  if (guessed.length > 0) return guessed.slice(0, max);

  if (options.fallbackToFirstColumns === false) return [];
  return visible.filter((k) => !isBlankContextValue(context[k])).slice(0, max);
}
