/**
 * Which of a roster row's columns are its "hero" fields: the few that say who the row is (Name,
 * Loan No., …). A LEAF: no I/O; it imports only the contract, `./context-columns` and
 * `./customer-name`. The ONE copy of the rule: the console's contact panel
 * (`apps/console/src/utils/agencyContext.ts`, `resolveContextFields`), customer history
 * (`apps/server/src/agency/customer-history/assemble.ts`) and the agent's own-contacts list
 * (`heroColumns`, `apps/server/src/db/repositories/agency/assignment-reads.repository.ts`) all
 * read it from here; the agent app's Dart port is held to the same cases
 * (`packages/contracts/fixtures/agent/fact-rules.json`).
 *
 * Over the contract's `AgencyContextDisplay`:
 *  1. the campaign's configured heroes, in order, matched case-insensitively, at most
 *     {@link heroCapFor} ({@link configuredHeroNames} is this stage without a row): when `facts`
 *     is an array (AS19, the card's chosen facts), the customer's name then each fact's column,
 *     so every surface matches the card, at most the name and `AGENCY_FACT_FIELDS_MAX` facts;
 *     otherwise the `hero` columns, at most {@link MAX_HERO_FIELDS}. The customer's name is the
 *     `name` role's column; with no `name` role, the name guess (`guessNameColumn`,
 *     `./customer-name`: only columns named like `Name` or `Customer Name`, never a fact's or a phone
 *     column): with a row, over its visible columns with a value; without one, over the `hero`
 *     entries. So a campaign moved to facts while its name was guessed keeps the name a hero
 *     (AS19 R1, S1);
 *  2. with `facts` an array that is all (S2: `facts: []` and no name is no hero at all). Otherwise,
 *     none configured (or none present on this row): one column per heuristic bucket (a name, an
 *     amount, an identifier, a place), in bucket order, skipping empty values;
 *  3. still none: the first {@link MAX_HERO_FIELDS} columns with a value, in the file's order
 *     (customer history; the contact panel turns it off, since it lists every column anyway);
 *  4. minus `hidden` (case-insensitive) at every stage: a hidden column is never a hero.
 *
 * "The file's order" is the roster import's column order (`agency_ingest_jobs.context_columns`)
 * when the caller has it, then any other key. A JSONB object does not keep it: Postgres returns
 * its keys sorted by length, then bytes.
 */

import { AGENCY_FACT_FIELDS_MAX } from '@magick-agency/contracts/agency';
import { contextValueText, fold, isBlankContextValue, isNonBlankString } from './context-columns';
import { factColumnsOf, guessNameColumn } from './customer-name';

// Kept here for the callers that read them from the hero rule.
export { contextValueText, isBlankContextValue };

/** Hero fields are capped (the contract: "keep it to ~4; the console may cap it"). */
export const MAX_HERO_FIELDS = 4;

/** The heuristic's first bucket (the legacy rule only): a column that holds the customer's name. */
const NAME_HEURISTIC = /^(full[\s_-]?)?name$|customer|contact|first.?name|client/i;

const HERO_HEURISTICS: readonly RegExp[] = [
  NAME_HEURISTIC,
  /amount|balance|due|outstanding|premium|emi|total/i,
  /policy|account|loan|invoice|order|ticket|ref/i,
  /city|branch|region|zone|state/i,
];

/** The display configuration this reads (`AgencyContextDisplay`, possibly hand-edited JSON). */
export interface HeroDisplay {
  hero?: unknown;
  hidden?: unknown;
  /** Read for `roles.name` only, and only with `facts` (AS19). */
  roles?: unknown;
  /** AS19: an array means the new model; each entry's `column` is read. */
  facts?: unknown;
  /** Read by the name guess only: a column declared `phone` is never the name (`./customer-name`). */
  types?: unknown;
}

const names = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];

/** The `name` role's column, when `roles.name` is a column name. */
function nameRole(display: HeroDisplay | null | undefined): string | undefined {
  const roles = display?.roles;
  const name = roles !== null && typeof roles === 'object' ? (roles as { name?: unknown }).name : undefined;
  return isNonBlankString(name) ? name : undefined;
}

/**
 * The most heroes a surface shows by default: with `facts` an array (AS19), the customer's name and
 * `AGENCY_FACT_FIELDS_MAX` facts, so no surface drops the last fact; otherwise
 * {@link MAX_HERO_FIELDS}.
 */
export function heroCapFor(display: HeroDisplay | null | undefined): number {
  return Array.isArray(display?.facts) ? 1 + AGENCY_FACT_FIELDS_MAX : MAX_HERO_FIELDS;
}

/**
 * The configured hero names as written, before `hidden`: with `facts` an array (AS19), the
 * customer's name then each fact's `column`; otherwise `hero`. The name is the `name` role's
 * column, else `nameGuess` (the caller's pick by the name guess; none when undefined).
 */
function heroNamesAsConfigured(display: HeroDisplay | null | undefined, nameGuess?: string): string[] {
  const facts = display?.facts;
  if (!Array.isArray(facts)) return names(display?.hero);
  return [nameRole(display) ?? nameGuess, ...factColumnsOf(display)].filter(isNonBlankString);
}

/**
 * With `facts` an array and no `name` role, the name guess over the `hero` entries (neither hidden
 * nor a fact's column): the name a campaign showed before it moved to facts (AS19 R1, S1).
 */
function nameFromHero(display: HeroDisplay | null | undefined, hidden: ReadonlySet<string>): string | undefined {
  if (!Array.isArray(display?.facts) || nameRole(display) !== undefined) return undefined;
  return guessNameColumn(names(display?.hero), { hidden, exclude: factColumnsOf(display), types: display?.types });
}

/** Each name once, minus `hidden`. */
function withoutHidden(list: readonly string[], hidden: ReadonlySet<string>): string[] {
  return [...new Set(list.filter((name) => !hidden.has(fold(name))))];
}

/**
 * The campaign's configured hero names, without a row: with `facts` an array (AS19), the
 * customer's name (the `name` role's column, else the name guess over the `hero` entries, if
 * any) then each fact's column; otherwise `hero` in array order. Each name as written,
 * blank and repeated names dropped, minus `hidden` (case-insensitive). Not capped: a caller that
 * matches them against rows caps what matched ({@link heroColumnsFor}).
 */
export function configuredHeroNames(display: HeroDisplay | null | undefined): string[] {
  const hidden = new Set(names(display?.hidden).map(fold));
  return withoutHidden(heroNamesAsConfigured(display, nameFromHero(display, hidden)), hidden);
}

/** How a surface applies the rule. */
export interface HeroColumnOptions {
  /** At most this many heroes (default: {@link heroCapFor} the display). */
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
  const max = options.max ?? heroCapFor(display);
  const keys = Object.keys(context);
  const present = new Set(keys);
  const ordered = [...new Set([...(columnOrder ?? []).filter((k) => present.has(k)), ...keys])];
  const hidden = new Set(names(display?.hidden).map(fold));
  const visible = ordered.filter((k) => !hidden.has(fold(k)));

  // AS19 R1, S1: with facts and no `name` role, the name guess over the row (visible, with a
  // value, not a fact's column), so the name stays first wherever the card's facts are the heroes.
  const chosen = Array.isArray(display?.facts);
  const nameGuess = chosen && nameRole(display) === undefined
    ? guessNameColumn(Object.fromEntries(visible.map((k) => [k, context[k]])), {
      exclude: factColumnsOf(display),
      types: display?.types,
    })
    : undefined;
  const configured: string[] = [];
  for (const name of withoutHidden(heroNamesAsConfigured(display, nameGuess), hidden)) {
    const match = visible.find((k) => fold(k) === fold(name));
    if (match !== undefined && !configured.includes(match)) configured.push(match);
  }
  // AS19 S2: with facts the card's columns are all; no guess by bucket, no first columns.
  if (configured.length > 0 || chosen) return configured.slice(0, max);

  const guessed: string[] = [];
  for (const pattern of HERO_HEURISTICS) {
    const match = visible.find((k) => !guessed.includes(k) && pattern.test(k) && !isBlankContextValue(context[k]));
    if (match !== undefined) guessed.push(match);
  }
  if (guessed.length > 0) return guessed.slice(0, max);

  if (options.fallbackToFirstColumns === false) return [];
  return visible.filter((k) => !isBlankContextValue(context[k])).slice(0, max);
}
