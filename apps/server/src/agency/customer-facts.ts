/**
 * Typed customer facts (agent station redesign, BE-6): the campaign setting that says which roster
 * column plays which role and how to read a column (`context_display.roles` / `.types`, in the
 * existing JSONB, no migration), its validation at the campaign-config write, and the facts the
 * station is sent on the panel (`AgencyReservedAttempt.facts`, built by {@link customerFacts} in
 * `buildPanel` at dial time). Pure; the one read (the roster's known columns) is the caller's.
 *
 * ── The facts ───────────────────────────────────────────────────────────────
 *  - `name`, `place`: the role's column when set, else a guess from the column names that never
 *    reads anything but a name or a place column ({@link NAME_GUESS_COLUMNS},
 *    {@link PLACE_GUESS_COLUMNS}, matched ignoring case, spaces and underscores). Trimmed, at most
 *    {@link FACT_TEXT_MAX} characters; absent when blank or a placeholder (`-`, `N/A`).
 *  - `tiles`: the hero columns (`heroColumnsFor`: `context_display.hero`, else its guess; never
 *    the first columns nobody chose, as the contact panel reads it), minus the columns already
 *    shown as the name and the place, then the `amount_due` and `due_date` role columns when the
 *    heroes did not include them; at most `MAX_HERO_FIELDS`, the role tiles kept when the cap
 *    bites (the "Full / Half" amount chips need the `amount_due` tile).
 *  - A tile's type: its role's (`amount_due` money, `due_date` date) whatever `types` says, else
 *    `types[column]`, else text. `value` is the domain's parse (`@magick-agency/domain/context-facts`):
 *    null for text and for anything it cannot read for certain; `raw` always.
 *  - `hidden` wins over everything, at every step: a hidden column is never a role, a guess or a
 *    tile. Column names match the row's keys ignoring case, as the hero rule matches them.
 *
 * With no `roles` or `types` set every tile is text, so a campaign set up before BE-6 reads as
 * before.
 */
import {
  AGENCY_CONTEXT_FIELD_TYPES,
  AGENCY_CONTEXT_ROLES,
  type AgencyContextDisplay,
  type AgencyContextFieldType,
  type AgencyContextRole,
  type AgencyCustomerFacts,
  type AgencyFactTile,
  type AgencyFactTileRole,
} from '@magick-agency/contracts/agency';
import { contextValueText, heroColumnsFor, isBlankContextValue, MAX_HERO_FIELDS } from '@magick-agency/domain/context-hero';
import { parseContextFact } from '@magick-agency/domain/context-facts';
import { INBOUND_MATCH_NAME_COLUMNS } from './inbound/match-name.js';

/** The longest name or place sent; a longer value is cut (the inbound name's bound). */
export const FACT_TEXT_MAX = 100;

/** Columns read as the customer's name when no role names one: the inbound match's list. */
export const NAME_GUESS_COLUMNS: readonly string[] = INBOUND_MATCH_NAME_COLUMNS;

/** Columns read as the customer's place when no role names one. Only names that mean a place. */
export const PLACE_GUESS_COLUMNS: readonly string[] = ['city', 'town', 'place', 'location', 'district', 'village'];

/** The longest column name a role or a type may name (the roster's header names are shorter). */
export const CONTEXT_COLUMN_NAME_MAX = 200;

/** The tile roles in the order they are appended. */
const TILE_ROLES: readonly AgencyFactTileRole[] = ['amount_due', 'due_date'];

const ROLE_TYPE: Readonly<Record<AgencyFactTileRole, AgencyContextFieldType>> = { amount_due: 'money', due_date: 'date' };

const fold = (name: string): string => name.trim().toLowerCase();
/** A column name with case, spaces, underscores and dashes ignored: `Customer Name` is `customer_name`. */
const squash = (name: string): string => name.toLowerCase().replace(/[\s_\-.]+/g, '');

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function hiddenSet(display: AgencyContextDisplay | null | undefined): Set<string> {
  const hidden = Array.isArray(display?.hidden) ? display.hidden : [];
  return new Set(hidden.filter((h): h is string => typeof h === 'string').map(fold));
}

/** The row's key a role or a type names (exact spelling first, then ignoring case), when visible. */
function rowKey(context: Record<string, unknown>, name: unknown, hidden: ReadonlySet<string>): string | undefined {
  if (typeof name !== 'string' || name.trim().length === 0 || hidden.has(fold(name))) return undefined;
  if (Object.hasOwn(context, name)) return name;
  return Object.keys(context).find((k) => fold(k) === fold(name) && !hidden.has(fold(k)));
}

/** A role's column, the row's own spelling, or undefined. */
function roleKey(
  context: Record<string, unknown>,
  roles: Record<string, unknown> | null,
  role: AgencyContextRole,
  hidden: ReadonlySet<string>,
): string | undefined {
  return roles ? rowKey(context, roles[role], hidden) : undefined;
}

/** The first visible column whose squashed name is on `guesses`, in the list's order. */
function guessKey(context: Record<string, unknown>, guesses: readonly string[], hidden: ReadonlySet<string>): string | undefined {
  const keys = Object.keys(context).filter((k) => !hidden.has(fold(k)));
  for (const guess of guesses) {
    const match = keys.find((k) => squash(k) === squash(guess) && !isBlankContextValue(context[k]));
    if (match !== undefined) return match;
  }
  return undefined;
}

/** A column's value as the name or place: trimmed, capped, absent when blank. */
function factText(value: unknown): string | undefined {
  if (isBlankContextValue(value)) return undefined;
  const text = contextValueText(value)?.trim();
  return text ? text.slice(0, FACT_TEXT_MAX) : undefined;
}

/** The type a column is read as: its tile role's, else `types`, else text. */
function columnType(
  column: string,
  role: AgencyFactTileRole | undefined,
  types: Record<string, unknown> | null,
): AgencyContextFieldType {
  if (role) return ROLE_TYPE[role];
  if (!types) return 'text';
  const declared = Object.hasOwn(types, column)
    ? types[column]
    : Object.entries(types).find(([k]) => fold(k) === fold(column))?.[1];
  return (AGENCY_CONTEXT_FIELD_TYPES as readonly unknown[]).includes(declared) ? (declared as AgencyContextFieldType) : 'text';
}

/**
 * The customer's facts for the panel (`AgencyReservedAttempt.facts`). See the module header.
 *
 * @param context     the contact's roster row (`agency_contacts.context`)
 * @param display     the campaign's `context_display` (possibly hand-edited JSON)
 * @param columnOrder the import's column order, when known (the hero guess reads it)
 */
export function customerFacts(
  context: Record<string, unknown> | null | undefined,
  display: AgencyContextDisplay | null | undefined,
  columnOrder: readonly string[] | null = null,
): AgencyCustomerFacts {
  const row = asRecord(context) ?? {};
  const shown = asRecord(display) ? display! : {};
  const hidden = hiddenSet(shown);
  const roles = asRecord(shown.roles);
  const types = asRecord(shown.types);

  const nameKey = roleKey(row, roles, 'name', hidden) ?? guessKey(row, NAME_GUESS_COLUMNS, hidden);
  const placeKey = roleKey(row, roles, 'place', hidden) ?? guessKey(row, PLACE_GUESS_COLUMNS, hidden);
  const name = nameKey !== undefined ? factText(row[nameKey]) : undefined;
  const place = placeKey !== undefined ? factText(row[placeKey]) : undefined;

  const tileRoleOf = new Map<string, AgencyFactTileRole>();
  for (const role of TILE_ROLES) {
    const key = roleKey(row, roles, role, hidden);
    if (key !== undefined && !tileRoleOf.has(key)) tileRoleOf.set(key, role);
  }

  // Two extra heroes, so dropping the name and place columns can still leave a full set.
  const heroes = heroColumnsFor(row, shown, columnOrder, { max: MAX_HERO_FIELDS + 2, fallbackToFirstColumns: false });
  const columns = heroes.filter((k) => k !== nameKey && k !== placeKey);
  for (const key of tileRoleOf.keys()) if (!columns.includes(key)) columns.push(key);
  // Over the cap: drop the last column that plays no tile role, until it fits.
  while (columns.length > MAX_HERO_FIELDS) {
    let last = columns.length - 1;
    while (last > 0 && tileRoleOf.has(columns[last]!)) last--;
    columns.splice(last, 1);
  }

  const tiles = columns.map((column): AgencyFactTile => {
    const role = tileRoleOf.get(column);
    const type = columnType(column, role, types);
    const raw = contextValueText(row[column]) ?? '';
    return { column, ...(role ? { role } : {}), type, raw, value: parseContextFact(raw, type) };
  });

  return { ...(name !== undefined ? { name } : {}), ...(place !== undefined ? { place } : {}), tiles };
}

// ── The write ────────────────────────────────────────────────────────────────

/** One refusal, keyed by the body's field path (the campaign-config validators' shape). */
export interface ContextDisplayIssue {
  field: string;
  message: string;
}

/** How each role reads in a refusal. */
const ROLE_WORDS: Readonly<Record<AgencyContextRole, string>> = {
  name: 'the customer\'s name',
  place: 'the customer\'s place',
  amount_due: 'the amount due',
  due_date: 'the due date',
};

/** The most column names a refusal lists. */
const KNOWN_COLUMNS_LISTED_MAX = 40;

function columnList(known: readonly string[]): string {
  const listed = known.slice(0, KNOWN_COLUMNS_LISTED_MAX).join(', ');
  return known.length > KNOWN_COLUMNS_LISTED_MAX ? `${listed}, and ${known.length - KNOWN_COLUMNS_LISTED_MAX} more` : listed;
}

function isColumnName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= CONTEXT_COLUMN_NAME_MAX;
}

/**
 * `context_display.roles` and `.types` at the campaign-config write, or nothing when the body
 * does not carry `context_display` (or carries one that is not an object: the older keys keep
 * their own rules). Every issue, not the first.
 *
 *  - `roles`: an object keyed by `AGENCY_CONTEXT_ROLES` only, each a column name (1 to
 *    {@link CONTEXT_COLUMN_NAME_MAX} characters); one column plays one role; a column in
 *    `hidden` is never a role.
 *  - `types`: an object of column name to one of `AGENCY_CONTEXT_FIELD_TYPES`.
 *  - With `knownColumns` (the roster's columns, `agency_ingest_jobs.context_columns`, when the
 *    campaign has an import), every role and type must name one of them, matched ignoring
 *    case; the refusal lists them. Without (no import yet, or the public layer, which holds
 *    no campaign) the names are not checked against a roster.
 */
export function contextDisplayIssues(
  record: Record<string, unknown>,
  knownColumns: readonly string[] | null = null,
): ContextDisplayIssue[] {
  const display = asRecord(record['context_display']);
  if (!display) return [];
  const issues: ContextDisplayIssue[] = [];
  const known = knownColumns && knownColumns.length > 0 ? knownColumns : null;
  const knownFolded = new Set((known ?? []).map(fold));
  const hidden = new Set((Array.isArray(display['hidden']) ? display['hidden'] : [])
    .filter((h): h is string => typeof h === 'string').map(fold));
  const notOnRoster = (column: string, field: string, what: string): void => {
    if (known && !knownFolded.has(fold(column))) {
      issues.push({
        field,
        message: `There is no column '${column}' in this campaign's customer list, so it cannot be ${what}. The columns are: ${columnList(known)}.`,
      });
    }
  };

  if (display['roles'] !== undefined) {
    const roles = asRecord(display['roles']);
    if (!roles) {
      issues.push({ field: 'context_display.roles', message: 'roles must be an object of role to column name.' });
    } else {
      const used = new Map<string, AgencyContextRole>();
      for (const [role, column] of Object.entries(roles)) {
        const field = `context_display.roles.${role}`;
        if (!(AGENCY_CONTEXT_ROLES as readonly string[]).includes(role)) {
          issues.push({ field, message: `'${role}' is not a role. The roles are: ${AGENCY_CONTEXT_ROLES.join(', ')}.` });
          continue;
        }
        const words = ROLE_WORDS[role as AgencyContextRole];
        if (!isColumnName(column)) {
          issues.push({ field, message: `Choose the column for ${words}: a column name of 1 to ${CONTEXT_COLUMN_NAME_MAX} characters.` });
          continue;
        }
        if (hidden.has(fold(column))) {
          issues.push({ field, message: `'${column}' is hidden from agents, so it cannot be ${words}. Show the column first.` });
          continue;
        }
        const other = used.get(fold(column));
        if (other !== undefined) {
          issues.push({ field, message: `'${column}' is already ${ROLE_WORDS[other]}. One column can play one role only.` });
          continue;
        }
        used.set(fold(column), role as AgencyContextRole);
        notOnRoster(column, field, words);
      }
    }
  }

  if (display['types'] !== undefined) {
    const types = asRecord(display['types']);
    if (!types) {
      issues.push({ field: 'context_display.types', message: 'types must be an object of column name to text, money or date.' });
    } else {
      for (const [column, type] of Object.entries(types)) {
        const field = `context_display.types.${column}`;
        if (!isColumnName(column)) {
          issues.push({ field, message: `A column name must be 1 to ${CONTEXT_COLUMN_NAME_MAX} characters.` });
          continue;
        }
        if (!(AGENCY_CONTEXT_FIELD_TYPES as readonly unknown[]).includes(type)) {
          issues.push({ field, message: `How to read '${column}' must be one of: ${AGENCY_CONTEXT_FIELD_TYPES.join(', ')}.` });
          continue;
        }
        notOnRoster(column, field, 'given a type');
      }
    }
  }
  return issues;
}

/** Whether the body sets roles or types, so the write needs the roster's columns to check them. */
export function namesContextColumns(record: Record<string, unknown>): boolean {
  const display = asRecord(record['context_display']);
  return !!display && (display['roles'] !== undefined || display['types'] !== undefined);
}
