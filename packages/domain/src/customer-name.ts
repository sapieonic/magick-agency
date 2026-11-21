/**
 * The customer's name and the line under it, from a roster row (AS19 S1, S2): the ONE guess from
 * the column names and the ONE reading of the `name` and `place` roles. The server's panel facts,
 * the hero rule (`./context-hero`), the console's Settings and side views and the agent app (its
 * Dart port in `agency_wire`, held to `packages/contracts/fixtures/agent/fact-rules.json`) all
 * read it from here. A LEAF: it imports only `./context-columns`.
 *
 *  - The guess ({@link guessNameColumn}, {@link guessPlaceColumn}): the first column whose name
 *    is on the list ({@link NAME_GUESS_COLUMNS}, {@link PLACE_GUESS_COLUMNS}), in the LIST's order,
 *    compared ignoring case, spaces, `_`, `-` and `.` ({@link squashColumnName}: `Customer Name`
 *    is `customer_name`). Only names that mean a name or a place: `Customer ID` and
 *    `Contact Number` are never the name. Never a hidden column, never an excluded one (the facts'
 *    columns), and, guessing over a row, never a column whose value is blank.
 *  - The name ({@link customerNameFrom}): the `name` role's column when the role is set (its
 *    value, or none when blank or missing on this row: no guess then, S16); else the guess,
 *    never a fact's column when the display has `facts`.
 *  - The line under it ({@link customerPlaceFrom}): the `place` role's column when set; else,
 *    without `facts`, the guess; with `facts` (S2) none.
 *  - Either as text: trimmed, at most {@link CUSTOMER_TEXT_MAX} characters, absent when blank or a
 *    placeholder (`-`, `N/A`).
 */
import { asRecord, contextValueText, fold, hiddenSet, isBlankContextValue, isNonBlankString, rowKey } from './context-columns';

/** Column names read as the customer's name when no role names one, in order (the inbound match's list). */
export const NAME_GUESS_COLUMNS = ['name', 'full_name', 'customer_name', 'first_name'] as const;

/** Column names read as the customer's place when no role names one. Only names that mean a place. */
export const PLACE_GUESS_COLUMNS = ['city', 'town', 'place', 'location', 'district', 'village'] as const;

/** The longest name or place shown; a longer value is cut (the inbound name's bound). */
export const CUSTOMER_TEXT_MAX = 100;

/** A column name with case, spaces, underscores, dashes and dots ignored: `Customer Name` is `customer_name`. */
export const squashColumnName = (name: string): string => name.toLowerCase().replace(/[\s_\-.]+/g, '');

/** What a guess leaves out. */
export interface ColumnGuessOptions {
  /** Columns hidden from agents (compared ignoring case): never guessed. */
  hidden?: Iterable<string>;
  /** Other columns never guessed, compared ignoring case: the facts' columns, the other role's. */
  exclude?: Iterable<string>;
}

/**
 * The first column whose squashed name is on `guesses`, in the list's order. Over a row (an
 * object), its keys in their order, skipping blank values; over a list of column names, every one.
 */
function guessColumn(
  source: Readonly<Record<string, unknown>> | readonly string[],
  guesses: readonly string[],
  options: ColumnGuessOptions,
): string | undefined {
  const left = new Set([...(options.hidden ?? []), ...(options.exclude ?? [])].filter((c) => typeof c === 'string').map(fold));
  const row = Array.isArray(source) ? null : (source as Readonly<Record<string, unknown>>);
  const columns = (row ? Object.keys(row) : (source as readonly string[]))
    .filter((c) => typeof c === 'string' && !left.has(fold(c)) && (row === null || !isBlankContextValue(row[c])));
  for (const guess of guesses) {
    const match = columns.find((c) => squashColumnName(c) === squashColumnName(guess));
    if (match !== undefined) return match;
  }
  return undefined;
}

/**
 * The column the name is guessed from: see the module header.
 *
 * @param source a roster row (blank values skipped) or the roster's column names
 */
export function guessNameColumn(
  source: Readonly<Record<string, unknown>> | readonly string[],
  options: ColumnGuessOptions = {},
): string | undefined {
  return guessColumn(source, NAME_GUESS_COLUMNS, options);
}

/**
 * The column the line under the name is guessed from: see the module header.
 *
 * @param source a roster row (blank values skipped) or the roster's column names
 */
export function guessPlaceColumn(
  source: Readonly<Record<string, unknown>> | readonly string[],
  options: ColumnGuessOptions = {},
): string | undefined {
  return guessColumn(source, PLACE_GUESS_COLUMNS, options);
}

/** A column's value as the name or the place: trimmed, cut to {@link CUSTOMER_TEXT_MAX}, undefined when blank. */
export function customerText(value: unknown): string | undefined {
  if (isBlankContextValue(value)) return undefined;
  const text = contextValueText(value)?.trim();
  return text ? text.slice(0, CUSTOMER_TEXT_MAX) : undefined;
}

/** The display configuration these read (`AgencyContextDisplay`, possibly hand-edited JSON). */
export interface CustomerNameDisplay {
  hidden?: unknown;
  roles?: unknown;
  facts?: unknown;
}

/** Each fact's `column` as written (an entry that is not an object with a non-blank column is skipped). */
export function factColumnsOf(display: { facts?: unknown } | null | undefined): string[] {
  const facts = display?.facts;
  if (!Array.isArray(facts)) return [];
  return facts.map((f: unknown) => asRecord(f)?.['column']).filter(isNonBlankString);
}

/** The column a role names, when it is a non-blank string. */
function roleColumn(display: CustomerNameDisplay | null | undefined, role: 'name' | 'place'): string | undefined {
  const value = asRecord(display?.roles)?.[role];
  return isNonBlankString(value) ? value : undefined;
}

/**
 * The row's column the customer's name is read from (its own key spelling), or undefined: the
 * `name` role's when set (undefined when the row has no such visible column), else the guess over
 * the row, never a fact's column. See the module header.
 */
export function customerNameColumn(
  context: Record<string, unknown> | null | undefined,
  display: CustomerNameDisplay | null | undefined,
): string | undefined {
  const row = asRecord(context) ?? {};
  const hidden = hiddenSet(display);
  const role = roleColumn(display, 'name');
  if (role !== undefined) return rowKey(row, role, hidden);
  return guessNameColumn(row, { hidden, exclude: factColumnsOf(display) });
}

/**
 * The customer's name on this row, as text, or undefined. See the module header.
 *
 * @param context the contact's roster row (`agency_contacts.context`)
 * @param display the campaign's `context_display`
 */
export function customerNameFrom(
  context: Record<string, unknown> | null | undefined,
  display: CustomerNameDisplay | null | undefined,
): string | undefined {
  const key = customerNameColumn(context, display);
  return key === undefined ? undefined : customerText((context as Record<string, unknown>)[key]);
}

/**
 * The row's column the line under the name is read from, or undefined: the `place` role's when
 * set, else (without `facts` only) the guess. See the module header.
 */
export function customerPlaceColumn(
  context: Record<string, unknown> | null | undefined,
  display: CustomerNameDisplay | null | undefined,
): string | undefined {
  const row = asRecord(context) ?? {};
  const hidden = hiddenSet(display);
  const role = roleColumn(display, 'place');
  if (role !== undefined) return rowKey(row, role, hidden);
  if (Array.isArray(display?.facts)) return undefined;
  return guessPlaceColumn(row, { hidden });
}

/**
 * The line under the customer's name on this row, as text, or undefined. See the module header.
 *
 * @param context the contact's roster row (`agency_contacts.context`)
 * @param display the campaign's `context_display`
 */
export function customerPlaceFrom(
  context: Record<string, unknown> | null | undefined,
  display: CustomerNameDisplay | null | undefined,
): string | undefined {
  const key = customerPlaceColumn(context, display);
  return key === undefined ? undefined : customerText((context as Record<string, unknown>)[key]);
}
