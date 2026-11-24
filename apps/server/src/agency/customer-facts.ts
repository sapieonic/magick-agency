/**
 * Typed customer facts (agent station redesign, BE-6): the campaign setting that says which roster
 * column plays which role and how to read a column (`context_display.roles` / `.types`, in the
 * existing JSONB, no migration), its validation at the campaign-config write, and the facts the
 * station is sent on the panel (`AgencyReservedAttempt.facts`, built by {@link customerFacts} in
 * `buildPanel` at dial time). Pure; the one read (the roster's known columns) is the caller's.
 *
 * ── The facts ───────────────────────────────────────────────────────────────
 *  - `name`, `place`: the domain's one reading (`customerNameFrom` / `customerPlaceFrom`,
 *    `@magick-agency/domain/customer-name`, AS19 S1, S2), which every other surface that names a
 *    customer reads too: the role's column when set (its value, or none when blank: no guess
 *    then); else a guess from the column names that never reads anything but a name or a place
 *    column (the domain's `NAME_GUESS_COLUMNS`, `PLACE_GUESS_COLUMNS`, matched ignoring case,
 *    spaces, `_`, `-` and `.`), never a fact's column nor one `types` reads as a phone number;
 *    with `facts`, the place is the role's or none (no guess). Trimmed, at most the domain's
 *    `CUSTOMER_TEXT_MAX` characters; absent when blank or a placeholder (`-`, `N/A`).
 *  - `tiles`: the hero columns (`heroColumnsFor`: `context_display.hero`, else its guess over the
 *    row's own key order, never the import's; never the first columns nobody chose, as the contact
 *    panel reads it), minus the columns already shown as the name and the place, then the
 *    `amount_due` and `due_date` role columns when the heroes did not include them; at most
 *    `MAX_HERO_FIELDS`, the role tiles kept when the cap bites (the "Full / Half" amount chips need
 *    the `amount_due` tile).
 *  - A tile's type: its role's (`amount_due` money, `due_date` date) whatever `types` says, else
 *    `types[column]`, else text. `value` is the domain's parse (`@magick-agency/domain/context-facts`):
 *    null for text and for anything it cannot read for certain; `raw` always.
 *  - `hidden` wins over everything, at every step: a hidden column is never a role, a guess or a
 *    tile. Column names match the row's keys ignoring case, as the hero rule matches them.
 *
 * With no `roles` or `types` set every tile is text, so a campaign set up before BE-6 reads as
 * before.
 *
 * ── The card's chosen facts (AS19, `context_display.facts`) ──────────────────
 * When `facts` is an array (even `[]`) the tiles are exactly its entries: the domain's one builder,
 * `chosenFactTiles` (`@magick-agency/domain/fact-tiles`, AS19 S6), which the console's side views
 * and the agent app share: each fact whose column the row has and is not hidden, in order, the
 * first highlighted one first, at most `AGENCY_FACT_FIELDS_MAX`, each with the fact's `label` and
 * `key`; `hero` and the `amount_due` / `due_date` roles are not read for tiles on this path, and the
 * tile keyed `amount_due` (or `due_date`) carries that `role`. The name never comes from a fact's
 * column and the place is never guessed (S2, above). The write's rules for `facts` are
 * {@link contextDisplayIssues}'; {@link canonicalContextColumns} spells the columns as the roster
 * does once the write knows it (S9).
 *
 * ── More details (AS20) ──────────────────────────────────────────────────────
 * On both paths `more` carries the row's other columns, which the agent opens under the card: the
 * domain's one rule (`moreDetailTiles`, `@magick-agency/domain/more-details`), always sent (`[]`
 * when there is nothing more), in the imports' column order when the caller knows it (only More
 * details reads that order: the tiles above never do). `context_display.more_hidden` leaves a
 * column out of More details only; the write checks its shape ({@link contextDisplayIssues}),
 * never the roster (a column may come back with the next upload).
 */
import {
  AGENCY_CONTEXT_FIELD_TYPES,
  AGENCY_CONTEXT_ROLES,
  AGENCY_FACT_FIELDS_MAX,
  AGENCY_FACT_KEY_MAX_CHARS,
  AGENCY_FACT_KEY_PATTERN,
  AGENCY_FACT_LABEL_MAX_CHARS,
  AGENCY_SCRIPT_FIXED_PLACEHOLDERS,
  type AgencyContextDisplay,
  type AgencyContextFieldType,
  type AgencyContextRole,
  type AgencyCustomerFacts,
  type AgencyFactTile,
  type AgencyFactTileRole,
} from '@magick-agency/contracts/agency';
import { asRecord, contextValueText, fold, hiddenSet, rowKey } from '@magick-agency/domain/context-columns';
import { heroColumnsFor, MAX_HERO_FIELDS } from '@magick-agency/domain/context-hero';
import { parseContextFact } from '@magick-agency/domain/context-facts';
import { customerNameColumn, customerPlaceColumn, customerText } from '@magick-agency/domain/customer-name';
import { chosenFactTiles, FACT_TILE_ROLE_TYPE, FACT_TILE_ROLES, factTypeOf } from '@magick-agency/domain/fact-tiles';
import { moreDetailTiles } from '@magick-agency/domain/more-details';

/** The longest column name a role or a type may name (the roster's header names are shorter). */
export const CONTEXT_COLUMN_NAME_MAX = 200;

/** A role's column, the row's own spelling, or undefined. */
function roleKey(
  context: Record<string, unknown>,
  roles: Record<string, unknown> | null,
  role: AgencyContextRole,
  hidden: ReadonlySet<string>,
): string | undefined {
  return roles ? rowKey(context, roles[role], hidden) : undefined;
}

/** The type a column is read as: its tile role's, else `types`, else text. */
function columnType(
  column: string,
  role: AgencyFactTileRole | undefined,
  types: Record<string, unknown> | null,
): AgencyContextFieldType {
  return role ? FACT_TILE_ROLE_TYPE[role] : factTypeOf(column, types);
}

/**
 * The customer's facts for the panel (`AgencyReservedAttempt.facts`). See the module header.
 *
 * @param context     the contact's roster row (`agency_contacts.context`)
 * @param display     the campaign's `context_display` (possibly hand-edited JSON)
 * @param columnOrder the campaign's imports' column order, when known: More details follows it
 *                    (AS20). The legacy card's hero guess never reads it, so its tiles stay as the
 *                    contact page (`heroColumnsFor` with no order) picks them.
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

  const nameKey = customerNameColumn(row, shown);
  const placeKey = customerPlaceColumn(row, shown);
  const name = nameKey !== undefined ? customerText(row[nameKey]) : undefined;
  const place = placeKey !== undefined ? customerText(row[placeKey]) : undefined;
  const person = { ...(name !== undefined ? { name } : {}), ...(place !== undefined ? { place } : {}) };

  // AS20: More details, the row's other columns (the domain's one rule). Always sent, even `[]`, so
  // a client can tell "nothing more for agents" from an older server that sends none.
  const more = moreDetailTiles(row, shown, columnOrder, undefined, { nameKey, placeKey });

  if (Array.isArray(shown.facts)) return { ...person, tiles: chosenFactTiles(row, shown), more };

  const tileRoleOf = new Map<string, AgencyFactTileRole>();
  for (const role of FACT_TILE_ROLES) {
    const key = roleKey(row, roles, role, hidden);
    if (key !== undefined && !tileRoleOf.has(key)) tileRoleOf.set(key, role);
  }

  // Two extra heroes, so dropping the name and place columns can still leave a full set. No column
  // order: the guess goes through the row's own keys, as the contact page's does, so the two agree.
  const heroes = heroColumnsFor(row, shown, null, { max: MAX_HERO_FIELDS + 2, fallbackToFirstColumns: false });
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

  return { ...person, tiles, more };
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

/**
 * AS19 S3(e): the roles shown unmasked under the customer's name, and the refusal when one names a
 * `phone`-typed column.
 */
const PHONE_ROLE_REFUSALS: Readonly<Partial<Record<string, string>>> = {
  name: 'A phone number cannot be the customer\'s name. Add it as a fact instead.',
  place: 'A phone number cannot be the line under the name. Add it as a fact instead.',
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
 * How a refusal lists the column types: all six of `AGENCY_CONTEXT_FIELD_TYPES`, but in the order a
 * sentence reads them (a number beside money), not the list's (`text`, `money`, `date`, `number`,
 * `phone`, `yes_no`).
 */
const TYPE_WORDS = 'as text, money, a number, a date, a phone number or yes / no';

/** The keys a fact may carry (`AgencyFactField`). */
const FACT_FIELD_KEYS: ReadonlySet<string> = new Set(['column', 'label', 'key', 'highlight']);

const FIXED_PLACEHOLDERS: ReadonlySet<string> = new Set(AGENCY_SCRIPT_FIXED_PLACEHOLDERS);

/** Length in Unicode code points, as the contract counts a fact's name. */
const codePoints = (text: string): number => [...text].length;

/**
 * `context_display.roles`, `.types` and `.facts` at the campaign-config write, or nothing when
 * the body does not carry `context_display` (or carries one that is not an object: the older keys
 * keep their own rules). Every issue, not the first.
 *
 *  - `roles`: an object keyed by `AGENCY_CONTEXT_ROLES` only, each a column name (1 to
 *    {@link CONTEXT_COLUMN_NAME_MAX} characters); one column plays one role; a column in
 *    `hidden` is never a role; the `name` and `place` roles never name a column `types` reads as
 *    a phone number (AS19 S3(e): they are shown unmasked).
 *  - `types`: an object of column name to one of `AGENCY_CONTEXT_FIELD_TYPES` (the six).
 *  - `facts` (AS19): a list of at most `AGENCY_FACT_FIELDS_MAX` objects `{ column, label, key,
 *    highlight? }` and nothing else. Column: 1 to {@link CONTEXT_COLUMN_NAME_MAX} characters, not
 *    hidden, not the `name` or `place` role's column, each once (ignoring case). Label: 1 to
 *    `AGENCY_FACT_LABEL_MAX_CHARS` code points after trimming, each once (ignoring case). Key:
 *    `AGENCY_FACT_KEY_PATTERN`, at most `AGENCY_FACT_KEY_MAX_CHARS`, each once, never one of
 *    `AGENCY_SCRIPT_FIXED_PLACEHOLDERS`. `highlight` a boolean, `true` on one fact at most. Each
 *    refusal is keyed by its path, `context_display.facts.2.label`.
 *  - `more_hidden` (AS20): a list of at most {@link MORE_HIDDEN_MAX} column names, each 1 to
 *    {@link CONTEXT_COLUMN_NAME_MAX} characters. Not checked against the roster: a column the
 *    latest upload left out may come back with the next one, still left out of More details.
 *  - With `knownColumns` (the roster's columns, `agency_ingest_jobs.context_columns`, when the
 *    campaign has an import), every role, type and fact must name one of them, matched ignoring
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
  const hidden = hiddenSet(display);
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
      issues.push({ field: 'context_display.roles', message: 'Choose a column for each customer fact: the name, place, amount due and due date.' });
    } else {
      const used = new Map<string, AgencyContextRole>();
      for (const [role, column] of Object.entries(roles)) {
        const field = `context_display.roles.${role}`;
        if (!(AGENCY_CONTEXT_ROLES as readonly string[]).includes(role)) {
          const facts = AGENCY_CONTEXT_ROLES.map((r) => ROLE_WORDS[r]);
          issues.push({ field, message: `That is not a customer fact the station shows. They are ${facts.slice(0, -1).join(', ')} and ${facts.at(-1)}.` });
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
        // AS19 S3(e): the name and the line under it are never masked, so a phone number there
        // would escape the campaign's hidden-number setting. Typed by the same body's `types`.
        const phoneRefusal = PHONE_ROLE_REFUSALS[role];
        if (phoneRefusal !== undefined && factTypeOf(column, display['types']) === 'phone') {
          issues.push({ field, message: phoneRefusal });
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
      issues.push({ field: 'context_display.types', message: `Choose how to read each column: ${TYPE_WORDS}.` });
    } else {
      for (const [column, type] of Object.entries(types)) {
        const field = `context_display.types.${column}`;
        if (!isColumnName(column)) {
          issues.push({ field, message: `A column name must be 1 to ${CONTEXT_COLUMN_NAME_MAX} characters.` });
          continue;
        }
        if (!(AGENCY_CONTEXT_FIELD_TYPES as readonly unknown[]).includes(type)) {
          issues.push({ field, message: `Choose how to read '${column}': ${TYPE_WORDS}.` });
          continue;
        }
        notOnRoster(column, field, 'given a type');
      }
    }
  }

  if (display['facts'] !== undefined) factFieldIssues(display, hidden, notOnRoster, issues);
  if (display['more_hidden'] !== undefined) moreHiddenIssues(display['more_hidden'], issues);
  return issues;
}

/** The most columns `context_display.more_hidden` may name (AS20): far above a real roster's columns. */
export const MORE_HIDDEN_MAX = 500;

/** `context_display.more_hidden` (AS20), each issue added to `issues`. See {@link contextDisplayIssues}. */
function moreHiddenIssues(value: unknown, issues: ContextDisplayIssue[]): void {
  const field = 'context_display.more_hidden';
  if (!Array.isArray(value)) {
    issues.push({ field, message: 'Choose which columns agents do not see under More details: a list of column names.' });
    return;
  }
  if (value.length > MORE_HIDDEN_MAX) {
    issues.push({ field, message: `More details can leave out at most ${MORE_HIDDEN_MAX} columns.` });
    return;
  }
  value.forEach((column, i) => {
    if (!isColumnName(column)) {
      issues.push({ field: `${field}.${i}`, message: `A column name must be 1 to ${CONTEXT_COLUMN_NAME_MAX} characters.` });
    }
  });
}

/** `context_display.facts` (AS19), each issue added to `issues` in order. See {@link contextDisplayIssues}. */
function factFieldIssues(
  display: Record<string, unknown>,
  hidden: ReadonlySet<string>,
  notOnRoster: (column: string, field: string, what: string) => void,
  issues: ContextDisplayIssue[],
): void {
  const facts = display['facts'];
  if (!Array.isArray(facts)) {
    issues.push({ field: 'context_display.facts', message: 'The facts on the card must be a list, one fact after another.' });
    return;
  }
  if (facts.length > AGENCY_FACT_FIELDS_MAX) {
    issues.push({
      field: 'context_display.facts',
      message: `You can show ${AGENCY_FACT_FIELDS_MAX} facts at most. Remove one to add another.`,
    });
  }
  const roles = asRecord(display['roles']);
  const roleColumns = new Map<string, AgencyContextRole>();
  for (const role of ['name', 'place'] as const) {
    const column = roles?.[role];
    if (typeof column === 'string' && column.trim().length > 0) roleColumns.set(fold(column), role);
  }
  const columns = new Set<string>();
  const labels = new Set<string>();
  const keys = new Set<string>();
  let highlighted = false;

  facts.forEach((entry, i) => {
    const at = `context_display.facts.${i}`;
    const fact = asRecord(entry);
    if (!fact) {
      issues.push({ field: at, message: 'Each fact needs a column, a name and a key.' });
      return;
    }
    for (const extra of Object.keys(fact).filter((k) => !FACT_FIELD_KEYS.has(k))) {
      issues.push({ field: `${at}.${extra}`, message: 'A fact has only a column, a name, a key and a highlight.' });
    }

    const column = fact['column'];
    const columnField = `${at}.column`;
    if (!isColumnName(column)) {
      issues.push({ field: columnField, message: `Choose the column for this fact: a column name of 1 to ${CONTEXT_COLUMN_NAME_MAX} characters.` });
    } else if (hidden.has(fold(column))) {
      issues.push({ field: columnField, message: `'${column}' is hidden from agents, so it cannot be a fact. Show the column first.` });
    } else if (roleColumns.has(fold(column))) {
      issues.push({ field: columnField, message: `'${column}' is already ${ROLE_WORDS[roleColumns.get(fold(column))!]}, so it cannot be a fact too.` });
    } else if (columns.has(fold(column))) {
      issues.push({ field: columnField, message: 'Two facts cannot show the same column.' });
    } else {
      columns.add(fold(column));
      notOnRoster(column, columnField, 'a fact');
    }

    const label = fact['label'];
    const labelField = `${at}.label`;
    const trimmed = typeof label === 'string' ? label.trim() : '';
    if (trimmed.length === 0) {
      issues.push({ field: labelField, message: 'Give each fact a name.' });
    } else if (codePoints(trimmed) > AGENCY_FACT_LABEL_MAX_CHARS) {
      issues.push({ field: labelField, message: `A fact's name can be ${AGENCY_FACT_LABEL_MAX_CHARS} letters at most.` });
    } else if (labels.has(fold(trimmed))) {
      issues.push({ field: labelField, message: 'Two facts cannot have the same name.' });
    } else {
      labels.add(fold(trimmed));
    }

    const key = fact['key'];
    const keyField = `${at}.key`;
    if (typeof key !== 'string' || !AGENCY_FACT_KEY_PATTERN.test(key)) {
      issues.push({ field: keyField, message: 'A fact\'s key must start with a small letter and have only small letters, numbers and underscores.' });
    } else if (key.length > AGENCY_FACT_KEY_MAX_CHARS) {
      issues.push({ field: keyField, message: `A fact's key can be ${AGENCY_FACT_KEY_MAX_CHARS} characters at most.` });
    } else if (FIXED_PLACEHOLDERS.has(key)) {
      issues.push({ field: keyField, message: `The script always has {${key}}, so a fact cannot use it as its key. Choose another key.` });
    } else if (keys.has(key)) {
      issues.push({ field: keyField, message: 'Two facts cannot have the same key.' });
    } else {
      keys.add(key);
    }

    const highlight = fact['highlight'];
    if (highlight !== undefined && typeof highlight !== 'boolean') {
      issues.push({ field: `${at}.highlight`, message: 'A fact is either highlighted or not.' });
    } else if (highlight === true) {
      if (highlighted) issues.push({ field: `${at}.highlight`, message: 'Only one fact can be highlighted.' });
      highlighted = true;
    }
  });
}

/**
 * Whether the body sets roles, types or facts, so the write needs the roster's columns to check
 * them.
 */
export function namesContextColumns(record: Record<string, unknown>): boolean {
  const display = asRecord(record['context_display']);
  return !!display && (display['roles'] !== undefined || display['types'] !== undefined || display['facts'] !== undefined);
}

/**
 * The body's `context_display` with every role's column and every fact's column spelled as the
 * roster spells it (AS19 S9), or the display unchanged when nothing needs it. The own-contacts list
 * matches its hero columns to each row in SQL by exact key (`heroColumns`), so a fact written
 * `amount due` for the roster's `Amount Due` would show nothing there. A name matches the roster's
 * exact spelling first, else the first column equal to it ignoring case (the order `knownColumns`
 * gives: oldest import first); a name the roster does not have is left as written (the write has
 * refused it already, or there is no roster yet). `hero`, `hidden` and `types` are read ignoring
 * case everywhere, so they are left as written.
 *
 * @param display      the body's `context_display`, after {@link contextDisplayIssues} accepted it
 * @param knownColumns the roster's columns (`agency_ingest_jobs.context_columns`), or null
 */
export function canonicalContextColumns(display: unknown, knownColumns: readonly string[] | null): unknown {
  const shown = asRecord(display);
  if (!shown || !knownColumns || knownColumns.length === 0) return display;
  const spelled = (name: unknown): unknown => {
    if (typeof name !== 'string' || knownColumns.includes(name)) return name;
    return knownColumns.find((c) => fold(c) === fold(name)) ?? name;
  };
  let changed = false;
  const out: Record<string, unknown> = { ...shown };
  const roles = asRecord(shown['roles']);
  if (roles) {
    const next = Object.fromEntries(Object.entries(roles).map(([role, column]) => [role, spelled(column)]));
    if (Object.entries(next).some(([role, column]) => column !== roles[role])) {
      out['roles'] = next;
      changed = true;
    }
  }
  const facts = shown['facts'];
  if (Array.isArray(facts)) {
    const next = facts.map((entry: unknown) => {
      const fact = asRecord(entry);
      if (!fact) return entry;
      const column = spelled(fact['column']);
      return column === fact['column'] ? entry : { ...fact, column };
    });
    if (next.some((f, i) => f !== facts[i])) {
      out['facts'] = next;
      changed = true;
    }
  }
  return changed ? out : display;
}
