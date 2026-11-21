/**
 * The card's chosen facts and the script keys they make (AS19, `docs/agent-station.md`): the
 * rules the server's campaign-config write and the console's Settings editor both need, so the
 * two cannot disagree. A LEAF: it imports only the contract, `./context-columns`, `./context-hero`
 * and `./fact-tiles`.
 *
 *  - {@link scriptPlaceholdersFor}: the `{key}`s a campaign's script may use. With
 *    `context_display.facts` (an array, even empty): `AGENCY_SCRIPT_FIXED_PLACEHOLDERS` then each
 *    fact's key. Without: the legacy `AGENCY_SCRIPT_PLACEHOLDERS`, exactly as before.
 *  - {@link factKeyFromColumn} and {@link defaultFactLabel}: a new fact's key and name from its
 *    column's header. The key never follows a later rename of the name. {@link uniqueFactLabels}:
 *    several new names at once, none repeated (S9).
 *  - {@link legacyFactFields}: the list a campaign without `facts` opens with in the editor, what
 *    its agents see today.
 *  - {@link placeholdersIn}, {@link unknownPlaceholdersIn}, {@link scriptPieces}: the `{word}`s
 *    of a script text, by the server's one reading of braces ({@link SCRIPT_BRACED_SOURCE}).
 */
import {
  AGENCY_FACT_FIELDS_MAX,
  AGENCY_FACT_KEY_MAX_CHARS,
  AGENCY_FACT_LABEL_MAX_CHARS,
  AGENCY_SCRIPT_FIXED_PLACEHOLDERS,
  AGENCY_SCRIPT_PLACEHOLDERS,
  type AgencyFactField,
} from '@magick-agency/contracts/agency';
import { asRecord, fold, hiddenSet, isNonBlankString as nonBlank } from './context-columns';
import { configuredHeroNames, heroColumnsFor } from './context-hero';
import { FACT_TILE_ROLES } from './fact-tiles';

/** The display configuration these read (`AgencyContextDisplay`, possibly hand-edited JSON). */
export interface FactFieldsDisplay {
  hero?: unknown;
  hidden?: unknown;
  roles?: unknown;
  facts?: unknown;
}

const FIXED: ReadonlySet<string> = new Set(AGENCY_SCRIPT_FIXED_PLACEHOLDERS);

// ── The script's keys ────────────────────────────────────────────────────────

/**
 * The `{key}`s a campaign's script may use, in the order a picker offers them. With
 * `display.facts` an array (AS19): the fixed four (`name`, `place`, `agent_name`,
 * `campaign_name`), then each fact's `key` in the list's order (an entry with no string key, a
 * repeat or a fixed one is skipped). Otherwise: the legacy six, `AGENCY_SCRIPT_PLACEHOLDERS`.
 */
export function scriptPlaceholdersFor(display: FactFieldsDisplay | null | undefined): string[] {
  const facts = display?.facts;
  if (!Array.isArray(facts)) return [...AGENCY_SCRIPT_PLACEHOLDERS];
  const out: string[] = [...AGENCY_SCRIPT_FIXED_PLACEHOLDERS];
  for (const fact of facts) {
    const key = asRecord(fact)?.key;
    if (typeof key === 'string' && key.length > 0 && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Cut to `max` characters, then drop the underscores the cut left at the end. */
function cutKey(key: string, max: number): string {
  return key.length <= max ? key : key.slice(0, max).replace(/_+$/, '');
}

/**
 * A new fact's default key from its column's header: lower-case; every run of characters other
 * than `a-z` and `0-9` becomes one `_`; `_` trimmed from both ends; `f_` put first when it starts
 * with a digit or is empty; cut to `AGENCY_FACT_KEY_MAX_CHARS` (32). When that key is in `taken`
 * or is one of the fixed placeholders, `_2`, `_3`, … is added (the whole still at most 32). The
 * answer always matches `AGENCY_FACT_KEY_PATTERN`. `Amount Due` is `amount_due`, `EMI (₹)` is
 * `emi`, `2nd EMI` is `f_2nd_emi`, `नाम` is `f_`.
 *
 * @param header the column's header, as uploaded
 * @param taken  the keys already used on this campaign (the other facts')
 */
export function factKeyFromColumn(header: string, taken: Iterable<string> = []): string {
  let key = String(header).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (key === '' || /^[0-9]/.test(key)) key = `f_${key}`;
  key = cutKey(key, AGENCY_FACT_KEY_MAX_CHARS);
  const used = new Set(taken);
  if (!used.has(key) && !FIXED.has(key)) return key;
  const stem = key.replace(/_+$/, '');
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${cutKey(stem, AGENCY_FACT_KEY_MAX_CHARS - suffix.length)}${suffix}`;
    if (!used.has(candidate) && !FIXED.has(candidate)) return candidate;
  }
}

/** `text` cut to `max` code points, then trimmed. */
function cutLabel(text: string, max: number): string {
  return [...text].slice(0, max).join('').trim();
}

/**
 * A new fact's default name: the column's header trimmed and cut to
 * `AGENCY_FACT_LABEL_MAX_CHARS` (16) code points, then trimmed again. Empty for a blank header
 * (the editor then asks for a name). With `taken` (the other facts' names), a name equal to one of
 * them ignoring case gets ` 2`, ` 3`, … with the base cut so the whole still fits in 16
 * (`Outstanding Bala`, then `Outstanding Ba 2`), as the write refuses two facts with one name.
 *
 * @param header the column's header, as uploaded
 * @param taken  the names already used on this card
 */
export function defaultFactLabel(header: string, taken: Iterable<string> = []): string {
  const base = cutLabel(String(header).trim(), AGENCY_FACT_LABEL_MAX_CHARS);
  const used = new Set([...taken].filter((t) => typeof t === 'string').map(fold));
  if (base === '' || !used.has(fold(base))) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${cutLabel(base, AGENCY_FACT_LABEL_MAX_CHARS - suffix.length)}${suffix}`;
    if (!used.has(fold(candidate))) return candidate;
  }
}

/**
 * Each header's {@link defaultFactLabel}, in order, unique ignoring case among themselves and
 * against `taken` (AS19 S9): what New campaign, the Settings pre-fill and "Add a fact" name new
 * facts. A blank header stays `''` (the editor asks for a name).
 *
 * @param headers the columns' headers, in the card's order
 * @param taken   names already used on the card that these must not repeat
 */
export function uniqueFactLabels(headers: readonly string[], taken: Iterable<string> = []): string[] {
  const used = [...taken];
  return headers.map((header) => {
    const label = defaultFactLabel(header, used);
    if (label !== '') used.push(label);
    return label;
  });
}

/** How {@link legacyFactFields} reads a campaign. */
export interface LegacyFactFieldsOptions {
  /**
   * Columns shown as the name or the line under it besides `roles.name` / `roles.place` (the
   * editor's own choice when it guessed them): never a fact.
   */
  exclude?: readonly string[];
}

/**
 * The facts a campaign without `facts` opens with in the Settings editor (AS19): what its agents
 * see on the card today, so saving without a change changes nothing they see.
 *
 *  1. The hero columns: `hero` (matched to `columns` ignoring case, in the roster's spelling),
 *     or, with no hero on the roster, the hero rule's guess over `columns` (`heroColumnsFor`, as
 *     the server builds today's tiles), minus the `name` and `place` role columns and
 *     `options.exclude`; and the `amount_due` and `due_date` role columns, when not among them;
 *  2. hidden columns never, each column once (ignoring case), a column missing from `columns`
 *     never (when `columns` is null, the names as written are taken);
 *  3. at most `AGENCY_FACT_FIELDS_MAX` (4), dropping the last column that plays no role until it
 *     fits, as today's tiles keep the role columns when the cap bites;
 *  4. in the old card's order (S9): the `amount_due` role's column, then the `due_date` role's,
 *     then the other heroes in their order.
 *
 * Each fact's name is {@link defaultFactLabel}, unique on the card (S9); its key is `amount_due` / `due_date` for the role
 * columns (so a script's `{amount_due}` keeps working) and {@link factKeyFromColumn} for the
 * rest. Nothing highlighted. A campaign that already has `facts` gets them back unchanged
 * (entries that are not objects with string `column`, `label` and `key` dropped).
 *
 * @param display the campaign's `context_display`
 * @param columns the roster's columns in the import's order, or null when there is no upload yet
 */
export function legacyFactFields(
  display: FactFieldsDisplay | null | undefined,
  columns: readonly string[] | null,
  options: LegacyFactFieldsOptions = {},
): AgencyFactField[] {
  if (Array.isArray(display?.facts)) {
    return display.facts.flatMap((f: unknown): AgencyFactField[] => {
      const r = asRecord(f);
      if (!r || typeof r.column !== 'string' || typeof r.label !== 'string' || typeof r.key !== 'string') return [];
      return [{ column: r.column, label: r.label, key: r.key, ...(r.highlight === true ? { highlight: true } : {}) }];
    });
  }
  const hidden = hiddenSet(display);
  const roles = asRecord(display?.roles) ?? {};
  const onRoster = (name: unknown): string | undefined => {
    if (!nonBlank(name) || hidden.has(fold(name))) return undefined;
    if (columns === null) return name;
    return columns.includes(name) ? name : columns.find((c) => fold(c) === fold(name) && !hidden.has(fold(c)));
  };
  const excluded = new Set(
    [roles.name, roles.place, ...(options.exclude ?? [])].filter(nonBlank).map(fold),
  );

  const legacy = { hero: display?.hero, hidden: display?.hidden };
  const heroes =
    columns === null
      ? configuredHeroNames(legacy)
      : heroColumnsFor(Object.fromEntries(columns.map((c) => [c, c])), legacy, columns, {
        max: Number.POSITIVE_INFINITY,
        fallbackToFirstColumns: false,
      });

  const listed: string[] = [];
  const add = (name: unknown): void => {
    const column = onRoster(name);
    if (column !== undefined && !excluded.has(fold(column)) && !listed.some((c) => fold(c) === fold(column))) listed.push(column);
  };
  for (const hero of heroes) add(hero);
  const roleOf = new Map<string, (typeof FACT_TILE_ROLES)[number]>();
  for (const role of FACT_TILE_ROLES) {
    const column = onRoster(roles[role]);
    if (column === undefined || excluded.has(fold(column))) continue;
    add(column);
    const at = listed.find((c) => fold(c) === fold(column));
    if (at !== undefined && !roleOf.has(at)) roleOf.set(at, role);
  }
  while (listed.length > AGENCY_FACT_FIELDS_MAX) {
    let last = listed.length - 1;
    while (last > 0 && roleOf.has(listed[last]!)) last--;
    listed.splice(last, 1);
  }
  // The old card's order (S9): the amount due, then the due date, then the other heroes.
  const ordered = [
    ...FACT_TILE_ROLES.flatMap((role) => listed.filter((c) => roleOf.get(c) === role)),
    ...listed.filter((c) => !roleOf.has(c)),
  ];

  const taken = new Set<string>(ordered.flatMap((c) => (roleOf.has(c) ? [roleOf.get(c)!] : [])));
  const labels = uniqueFactLabels(ordered);
  return ordered.map((column, i): AgencyFactField => {
    const role = roleOf.get(column);
    const key = role ?? factKeyFromColumn(column, taken);
    taken.add(key);
    return { column, label: labels[i]!, key };
  });
}

// ── The script's text ────────────────────────────────────────────────────────

/**
 * The one reading of braces in a script text (the server's write refuses by it): one word of
 * letters, digits and underscores in braces, spaces allowed inside them. `{name}` is a
 * placeholder; `{Name}` and `{ name }` are `{word}`s too, and unknown, since the clients fill only
 * the exact `{key}` and would show anything else with its braces. Braces round anything that is
 * not one word are plain text. A source string, so each caller builds its own `g` RegExp.
 */
export const SCRIPT_BRACED_SOURCE = String.raw`\{\s*([A-Za-z0-9_]+)\s*\}`;

/**
 * Every `{word}` a text uses, braces included and as written (`{name}`, `{ Name }`), each once,
 * in order of first use.
 */
export function placeholdersIn(text: string): string[] {
  const out: string[] = [];
  for (const match of String(text).matchAll(new RegExp(SCRIPT_BRACED_SOURCE, 'g'))) {
    if (!out.includes(match[0])) out.push(match[0]);
  }
  return out;
}

/**
 * The `{word}`s of a text that are not exactly `{key}` for one of `allowed` (as written, each
 * once, in order): what the write refuses, and what the editor underlines.
 *
 * @param allowed the campaign's keys ({@link scriptPlaceholdersFor})
 */
export function unknownPlaceholdersIn(text: string, allowed: Iterable<string>): string[] {
  const keys = new Set(allowed);
  return placeholdersIn(text).filter((token) => !keys.has(token.slice(1, -1)));
}

/** A run of a script text: plain text, a known `{key}`, or a `{word}` the campaign does not have. */
export type ScriptPiece =
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'unknown'; token: string };

/**
 * A script text cut into its runs, for a client that fills it (a `key` piece is the value, or
 * "<label> not given" in the muted style when the customer has none; an `unknown` piece is shown
 * as written) or tints it (the editor). Adjacent text is one piece; no piece is empty.
 *
 * @param allowed the campaign's keys ({@link scriptPlaceholdersFor})
 */
export function scriptPieces(text: string, allowed: Iterable<string>): ScriptPiece[] {
  const keys = new Set(allowed);
  const source = String(text);
  const pieces: ScriptPiece[] = [];
  const pushText = (t: string): void => {
    if (t === '') return;
    const prev = pieces[pieces.length - 1];
    if (prev?.kind === 'text') prev.text += t;
    else pieces.push({ kind: 'text', text: t });
  };
  let at = 0;
  for (const match of source.matchAll(new RegExp(SCRIPT_BRACED_SOURCE, 'g'))) {
    pushText(source.slice(at, match.index));
    const token = match[0];
    const word = token.slice(1, -1);
    pieces.push(keys.has(word) ? { kind: 'key', key: word } : { kind: 'unknown', token });
    at = match.index + token.length;
  }
  pushText(source.slice(at));
  return pieces;
}
