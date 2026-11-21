import {
  AGENCY_CONTEXT_FIELD_TYPES,
  AGENCY_FACT_FIELDS_MAX,
  AGENCY_FACT_KEY_MAX_CHARS,
  AGENCY_FACT_KEY_PATTERN,
  AGENCY_FACT_LABEL_MAX_CHARS,
  AGENCY_PHONE_DISPLAY_DEFAULT,
  AGENCY_SCRIPT_FIXED_PLACEHOLDERS,
  AGENCY_SCRIPT_OPENING_MAX_CHARS,
  AGENCY_SCRIPT_STEPS_MAX,
  AGENCY_SCRIPT_STEP_MAX_CHARS,
  type AgencyAgentScript,
  type AgencyContextDisplay,
  type AgencyContextFieldType,
  type AgencyContextRoles,
  type AgencyFactField,
  type AgencyPhoneDisplay,
} from '@magick-agency/contracts/agency';
import { parseContextFact } from '@magick-agency/domain/context-facts';
import {
  defaultFactLabel,
  factKeyFromColumn,
  legacyFactFields,
  placeholdersIn,
  scriptPlaceholdersFor,
  unknownPlaceholdersIn,
} from '@magick-agency/domain/fact-fields';
import {
  AGENCY_DAILY_TARGET_CALLS_MAX,
  AGENCY_DAILY_TARGET_CALLS_MIN,
  type AgencyCampaign,
} from '../../types/agency-campaign';
import { formatCount } from '../format/number';
import { calendarDay, phoneForDisplay, rupees } from './stationFormat';

/**
 * The agent station's campaign settings (agent station redesign: AS6, AS9, AS19, BE-6, BE-8), as
 * the campaign Settings page edits them: the daily target, how the station shows the customer's
 * number, the script, and the customer card (the name and the line under it, up to 4 facts each
 * with its name, script key and an optional highlight, and how each column is read). Pure, so each
 * rule is tested where it is made. The pictures on outcomes and break reasons (BE-13) are edited
 * with the outcomes and the break limits, not here.
 *
 * Every rule mirrors the server's write (`agency/agent-script.ts`, `agency/customer-facts.ts`,
 * the `daily_target_calls` bounds) and the domain's one reading of facts and keys
 * (`@magick-agency/domain/fact-fields`): the page says what the server would refuse as it is
 * typed, and holds Save, as the break limits do. The server still has the last word, and its
 * refusal is shown on the field it names (`agent_script.opening`, `agent_script.steps[<i>].text`,
 * `context_display.roles.<role>`, `context_display.facts.<i>.<part>`,
 * `context_display.types.<column>`, `daily_target_calls`, `phone_display`).
 *
 * ── The card's facts (AS19) ──────────────────────────────────────────────────
 * The form always holds a list of facts. A campaign saved with `facts` opens with them; one saved
 * before AS19 opens with what its agents see today (`legacyFactFields`, the guessed name and line
 * under it left out, the old amount-due and due-date columns read as money and a date as they
 * were), and nothing is written until the supervisor saves a change to the card. Then the save
 * writes `facts` and drops `roles.amount_due` / `roles.due_date`.
 *
 * ── The script's keys and the save order ────────────────────────────────────
 * The server checks the script against the campaign's RESULTING display both ways: a script with a
 * `{word}` the card has no fact for is refused, and so is a card that drops a fact the stored script
 * uses. One PATCH carries both when both change, so the pair is checked together. So that a script
 * may use a fact of a campaign still on the old model, a script that names a key the stored display
 * does not allow sends the card with it ({@link stationPlan}).
 */

/** The form's model of these settings. */
export interface StationSettingsForm {
  /** The daily target as typed: `''` for none. */
  dailyTarget: string;
  phoneDisplay: AgencyPhoneDisplay;
  script: ScriptForm;
  facts: FactsForm;
}

/** The script as typed: the opening line and each step, untrimmed. */
export interface ScriptForm {
  opening: string;
  steps: string[];
}

/** The customer card: the name and line-under-name columns, the facts, and each column's type. */
export interface FactsForm {
  /** `roles.name`: `''` guesses it from the column names. */
  name: string;
  /** `roles.place`, the line under the name: `''` guesses it (or shows none). */
  place: string;
  /** The facts on the card, in order (at most {@link AGENCY_FACT_FIELDS_MAX}). */
  list: AgencyFactField[];
  /** Each column's type; absent is text. */
  types: Record<string, AgencyContextFieldType>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const TYPES: ReadonlySet<string> = new Set(AGENCY_CONTEXT_FIELD_TYPES);

/** Column names compare as the server compares them: ignoring case. */
function fold(column: string): string {
  return column.trim().toLowerCase();
}

/** Spaces, underscores, dashes and dots ignored too: how the server's name and place guess compares. */
function squash(column: string): string {
  return column.toLowerCase().replace(/[\s_\-.]+/g, '');
}

/**
 * The columns the server reads as the customer's name when no column is chosen, in its order
 * (`NAME_GUESS_COLUMNS` in `apps/server/src/agency/customer-facts.ts`, the inbound match's list).
 */
export const NAME_GUESS_COLUMNS: readonly string[] = ['name', 'full_name', 'customer_name', 'first_name'];
/** The columns the server reads as the line under the name when none is chosen (`PLACE_GUESS_COLUMNS`). */
export const PLACE_GUESS_COLUMNS: readonly string[] = ['city', 'town', 'place', 'location', 'district', 'village'];

/**
 * The column the server would guess from the column names (its order of guesses, each compared
 * ignoring case, spaces, underscores, dashes and dots), never a hidden one; undefined for none.
 */
export function guessedColumn(columns: readonly string[], guesses: readonly string[], hidden: readonly string[]): string | undefined {
  const hiddenSet = new Set(hidden.map(fold));
  const visible = columns.filter((c) => !hiddenSet.has(fold(c)));
  for (const guess of guesses) {
    const match = visible.find((c) => squash(c) === squash(guess));
    if (match !== undefined) return match;
  }
  return undefined;
}

/** The name column the card shows: the chosen one, else the guess. */
export function nameColumnOf(facts: FactsForm, columns: readonly string[], hidden: readonly string[]): string | undefined {
  return facts.name.trim() !== '' ? facts.name : guessedColumn(columns, NAME_GUESS_COLUMNS, hidden);
}

/** The line-under-the-name column the card shows: the chosen one, else the guess. */
export function placeColumnOf(facts: FactsForm, columns: readonly string[], hidden: readonly string[]): string | undefined {
  return facts.place.trim() !== '' ? facts.place : guessedColumn(columns, PLACE_GUESS_COLUMNS, hidden);
}

/**
 * The card as a stored display has it. A display with `facts` gives them back; one without opens
 * with what agents see today (`legacyFactFields` over `columns`, the guessed name and line under it
 * left out), and the old amount-due and due-date columns are read as money and a date as their roles
 * read them (on the new model a fact is read by `types` alone), unless a type is already set.
 *
 * @param columns the roster's columns, or null while they are not known (the hero list as written)
 */
export function factsFormOf(display: AgencyContextDisplay | null | undefined, columns: readonly string[] | null): FactsForm {
  const shown = isRecord(display) ? display : {};
  const roles = isRecord(shown.roles) ? shown.roles : {};
  const name = typeof roles.name === 'string' ? roles.name : '';
  const place = typeof roles.place === 'string' ? roles.place : '';
  const types: Record<string, AgencyContextFieldType> = {};
  if (isRecord(shown.types)) {
    for (const [column, type] of Object.entries(shown.types)) {
      if (typeof type === 'string' && TYPES.has(type)) types[column] = type as AgencyContextFieldType;
    }
  }
  const hidden = hiddenColumns(shown);
  const exclude = columns === null
    ? []
    : [
      ...(name === '' ? [guessedColumn(columns, NAME_GUESS_COLUMNS, hidden)] : []),
      ...(place === '' ? [guessedColumn(columns, PLACE_GUESS_COLUMNS, hidden)] : []),
    ].filter((c): c is string => c !== undefined);
  const list = legacyFactFields(shown, columns, { exclude });
  let form: FactsForm = { name, place, list, types };
  if (!Array.isArray(shown.facts)) {
    for (const fact of list) {
      const fixed: AgencyContextFieldType | null = fact.key === 'amount_due' ? 'money' : fact.key === 'due_date' ? 'date' : null;
      if (fixed && columnNamed(Object.keys(form.types), fact.column) === undefined) form = withColumnType(form, fact.column, fixed);
    }
  }
  return form;
}

/** Whether a display is on the old model (no `facts`): its card is opened from what agents see today. */
export function isLegacyDisplay(display: AgencyContextDisplay | null | undefined): boolean {
  return !(isRecord(display) && Array.isArray(display.facts));
}

/**
 * The form as a stored campaign has it. Anything malformed in what is stored reads as unset.
 *
 * @param columns the roster's columns when known: a campaign on the old model opens its card from them
 */
export function stationSettingsOf(campaign: AgencyCampaign, columns: readonly string[] | null = null): StationSettingsForm {
  const target = campaign.daily_target_calls;
  const script = isRecord(campaign.agent_script) ? campaign.agent_script : {};
  const steps = Array.isArray(script.steps) ? script.steps : [];
  return {
    dailyTarget: typeof target === 'number' ? String(target) : '',
    phoneDisplay: campaign.phone_display === 'masked' ? 'masked' : AGENCY_PHONE_DISPLAY_DEFAULT,
    script: {
      opening: typeof script.opening === 'string' ? script.opening : '',
      steps: steps.map((step) => (isRecord(step) && typeof step.text === 'string' ? step.text : '')),
    },
    facts: factsFormOf(isRecord(campaign.context_display) ? campaign.context_display : undefined, columns),
  };
}

// ─── Daily target (AS6) ─────────────────────────────────────────────────────

/** The daily target's message as typed, or null when it may be saved (`''` clears it). */
export function dailyTargetError(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (Number.isInteger(value) && value >= AGENCY_DAILY_TARGET_CALLS_MIN && value <= AGENCY_DAILY_TARGET_CALLS_MAX) return null;
  return `Enter a whole number of calls from ${formatCount(AGENCY_DAILY_TARGET_CALLS_MIN)} to ${formatCount(AGENCY_DAILY_TARGET_CALLS_MAX)}, or leave it empty for no target.`;
}

/** What a save sends for the target: the number, or `null` to clear it. */
export function dailyTargetPayload(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : Number(trimmed);
}

// ─── Number display (AS9) ───────────────────────────────────────────────────

/**
 * The number the setting's preview shows, a ten-digit Indian mobile, drawn by the station's own
 * `phoneForDisplay` (`stationFormat.ts`) so the preview is what agents see.
 */
export const PHONE_DISPLAY_SAMPLE = '+919876543321';

// ─── Script (BE-8, AS19) ────────────────────────────────────────────────────

/** Length as the server counts it: Unicode code points, after trimming. */
export function scriptLength(text: string): number {
  return [...text.trim()].length;
}

/** Every text of a script, the opening line first. */
function scriptTexts(script: ScriptForm): string[] {
  return [script.opening, ...script.steps];
}

/** The `{word}`s a script uses anywhere, as written, each once (`{name}`, `{ Name }`). */
export function scriptTokens(script: ScriptForm): string[] {
  return placeholdersIn(scriptTexts(script).join('\n'));
}

/** The `{word}`s of a script that are not one of `allowed`, as written, each once, in order. */
export function scriptUnknowns(script: ScriptForm, allowed: Iterable<string>): string[] {
  return unknownPlaceholdersIn(scriptTexts(script).join('\n'), allowed);
}

/** `a`, `a and b`, `a, b and c`. */
function listed(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The server's refusal of a script `{word}` the card has no fact for, for one or several. */
export function unknownKeysMessage(tokens: readonly string[]): string {
  return tokens.length === 1
    ? `The script uses ${tokens[0]}, which is not a fact on the card. Add it as a fact or take it out.`
    : `The script uses ${listed(tokens)}, which are not facts on the card. Add them as facts or take them out.`;
}

function textError(text: string, max: number, what: string, required: boolean, allowed: readonly string[]): string | null {
  const length = scriptLength(text);
  if (length === 0) return required ? `Write ${what.toLowerCase()}, or remove it.` : null;
  if (length > max) return `${what} is ${formatCount(length)} characters. Keep it to ${formatCount(max)}.`;
  const unknown = unknownPlaceholdersIn(text, allowed);
  return unknown.length > 0 ? unknownKeysMessage(unknown) : null;
}

/** The script's field path for the opening line (the server's `details` key). */
export const SCRIPT_OPENING_FIELD = 'agent_script.opening';
/** The script's field path for step `index` (0-based; the server's `details` key). */
export function scriptStepField(index: number): string {
  return `agent_script.steps[${index}].text`;
}

/**
 * What the server would refuse in the script, keyed by its field path; empty when it may be saved.
 * An empty opening is no opening; an empty step must be written or removed (the server refuses it).
 *
 * @param allowed the keys the script may use (the card's: {@link stationPlan}'s `allowed`)
 */
export function scriptErrors(script: ScriptForm, allowed: readonly string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const opening = textError(script.opening, AGENCY_SCRIPT_OPENING_MAX_CHARS, 'The opening line', false, allowed);
  if (opening) errors[SCRIPT_OPENING_FIELD] = opening;
  script.steps.forEach((step, i) => {
    const error = textError(step, AGENCY_SCRIPT_STEP_MAX_CHARS, `Step ${i + 1}`, true, allowed);
    if (error) errors[scriptStepField(i)] = error;
  });
  if (script.steps.length > AGENCY_SCRIPT_STEPS_MAX) {
    errors['agent_script.steps'] = `A script can have at most ${AGENCY_SCRIPT_STEPS_MAX} steps.`;
  }
  return errors;
}

/** The `agent_script` a save sends: each text trimmed, an empty part left out; `{}` for no script. */
export function scriptPayload(script: ScriptForm): AgencyAgentScript {
  const opening = script.opening.trim();
  const steps = script.steps.map((text) => ({ text: text.trim() }));
  return {
    ...(opening !== '' ? { opening } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  };
}

/**
 * `text` with `insert` put in place of the selection `[start, end)`, and where the caret goes
 * after it. A placeholder is put with a space either side where it would otherwise touch a word.
 */
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const trail = after !== '' && !/^\s/.test(after) ? ' ' : '';
  const put = `${lead}${insert}${trail}`;
  return { text: `${before}${put}${after}`, caret: before.length + lead.length + insert.length };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The script with every `token` (a `{word}` as written) put as `replacement` in every text. An
 * empty replacement takes it out, with one space before it, so no double space is left.
 */
export function replaceToken(script: ScriptForm, token: string, replacement: string): ScriptForm {
  const swap = (text: string): string => (replacement === ''
    ? text.replace(new RegExp(`[ \\t]?${escapeRegExp(token)}`, 'g'), '')
    : text.split(token).join(replacement));
  return { opening: swap(script.opening), steps: script.steps.map(swap) };
}

// ─── The card (BE-6, AS19) ──────────────────────────────────────────────────

/**
 * The number display's two choices in a supervisor's words (AS9): campaign Settings' options and the
 * activity log's before and after. One word for each, whatever the wire calls it (`full`, `masked`).
 */
export const PHONE_DISPLAY_LABELS: Readonly<Record<AgencyPhoneDisplay, string>> = {
  full: 'Full number',
  masked: 'Hidden number',
};

/** Each type's words on the page. */
export const CONTEXT_TYPE_LABELS: Readonly<Record<AgencyContextFieldType, string>> = {
  text: 'Text',
  money: 'Money',
  date: 'Date',
  number: 'Number',
  phone: 'Phone number',
  yes_no: 'Yes / No',
};

/** The name and line-under-the-name roles' field paths (the server's `details` keys). */
export const NAME_FIELD = 'context_display.roles.name';
export const PLACE_FIELD = 'context_display.roles.place';
/** The facts list's own field path: the count, the highlight, the script's use of a key. */
export const FACTS_FIELD = 'context_display.facts';

/** A part of fact `index`'s field path (the server's `details` key): `context_display.facts.2.label`. */
export function factField(index: number, part: 'column' | 'label' | 'key'): string {
  return `${FACTS_FIELD}.${index}.${part}`;
}

/** A column's type field path (the server's `details` key). */
export function typeField(column: string): string {
  return `context_display.types.${column}`;
}

/** The message when a fifth fact is asked for. */
export const FACTS_LIMIT_MESSAGE = `You can show ${AGENCY_FACT_FIELDS_MAX} facts at most. Remove one to add another.`;
/** The message on a fact whose column the latest upload does not have. */
export const FACT_COLUMN_MISSING_MESSAGE = 'This column is not in the latest upload. Choose another or remove the fact.';

/** What the facts are judged against besides themselves. */
export interface FactsContext {
  /** The columns hidden from agents. */
  hidden: readonly string[];
  /** The latest upload's columns; empty while unknown (then no column is said to be missing). */
  uploaded: readonly string[];
}

/** A fact's name's length as the server counts it: code points, after trimming. */
export function labelLength(label: string): number {
  return [...label.trim()].length;
}

/**
 * What the server would refuse in the card, keyed by field path: the name and line-under-name
 * columns (hidden, or one column in both), and each fact (its column hidden, already the name or
 * the line under it, on the card twice, or not in the latest upload; its name empty, longer than
 * 16 letters, or the same as another's; a key the server would not take), more than 4 facts or
 * more than one highlight. A repeat is said on the second.
 */
export function factsErrors(facts: FactsForm, context: FactsContext): Record<string, string> {
  const errors: Record<string, string> = {};
  const hiddenSet = new Set(context.hidden.map(fold));
  const name = facts.name.trim();
  const place = facts.place.trim();
  if (name !== '' && hiddenSet.has(fold(name))) errors[NAME_FIELD] = `‘${name}’ is hidden from agents, so it cannot be the customer’s name.`;
  if (place !== '' && hiddenSet.has(fold(place))) {
    errors[PLACE_FIELD] = `‘${place}’ is hidden from agents, so it cannot be the line under the name.`;
  } else if (place !== '' && name !== '' && fold(place) === fold(name)) {
    errors[PLACE_FIELD] = `‘${place}’ is already the customer’s name. Choose another column.`;
  }

  if (facts.list.length > AGENCY_FACT_FIELDS_MAX) errors[FACTS_FIELD] = FACTS_LIMIT_MESSAGE;
  else if (facts.list.filter((f) => f.highlight === true).length > 1) errors[FACTS_FIELD] = 'Only one fact can be highlighted.';

  const uploaded = new Set(context.uploaded.map(fold));
  const columnsSeen = new Set<string>();
  const labelsSeen = new Set<string>();
  const keysSeen = new Set<string>();
  const fixed: ReadonlySet<string> = new Set(AGENCY_SCRIPT_FIXED_PLACEHOLDERS);
  facts.list.forEach((fact, i) => {
    const column = fact.column.trim();
    let columnError: string | null = null;
    if (column === '') columnError = 'Choose a column for this fact, or remove it.';
    else if (hiddenSet.has(fold(column))) columnError = `‘${column}’ is hidden from agents. Choose another column or remove the fact.`;
    else if (name !== '' && fold(column) === fold(name)) columnError = `‘${column}’ is already the customer’s name. Choose another column or remove the fact.`;
    else if (place !== '' && fold(column) === fold(place)) columnError = `‘${column}’ is already the line under the name. Choose another column or remove the fact.`;
    else if (columnsSeen.has(fold(column))) columnError = `‘${column}’ is already on the card.`;
    else if (uploaded.size > 0 && !uploaded.has(fold(column))) columnError = FACT_COLUMN_MISSING_MESSAGE;
    if (columnError) errors[factField(i, 'column')] = columnError;
    if (column !== '') columnsSeen.add(fold(column));

    const length = labelLength(fact.label);
    let labelError: string | null = null;
    if (length === 0) labelError = 'Give this fact a name.';
    else if (length > AGENCY_FACT_LABEL_MAX_CHARS) labelError = `A fact’s name can be ${AGENCY_FACT_LABEL_MAX_CHARS} letters at most.`;
    else if (labelsSeen.has(fold(fact.label))) labelError = 'Two facts cannot have the same name.';
    if (labelError) errors[factField(i, 'label')] = labelError;
    if (length > 0) labelsSeen.add(fold(fact.label));

    const key = fact.key;
    if (!AGENCY_FACT_KEY_PATTERN.test(key) || key.length > AGENCY_FACT_KEY_MAX_CHARS || fixed.has(key) || keysSeen.has(key)) {
      errors[factField(i, 'key')] = `{${key}} cannot be this fact’s key. Remove the fact and add it again.`;
    }
    keysSeen.add(key);
  });
  return errors;
}

/** A new fact for `column`: its name and key by the default rule, its key unlike `list`'s. */
export function newFact(column: string, list: readonly AgencyFactField[]): AgencyFactField {
  return { column, label: defaultFactLabel(column), key: factKeyFromColumn(column, list.map((f) => f.key)) };
}

/**
 * The list with `index` highlighted (or not). One at most: turning one on turns any other off, and
 * moves it first, where the card draws it.
 */
export function withHighlight(list: readonly AgencyFactField[], index: number, on: boolean): AgencyFactField[] {
  if (index < 0 || index >= list.length) return [...list];
  if (!on) return list.map((f, i) => (i === index ? plainFact(f) : f));
  const plain = list.map(plainFact);
  return [{ ...plain[index]!, highlight: true }, ...plain.filter((_, i) => i !== index)];
}

/** A fact without its highlight. */
function plainFact(fact: AgencyFactField): AgencyFactField {
  return { column: fact.column, label: fact.label, key: fact.key };
}

/** Where fact `index` may move to by one step `delta`: never above the highlighted first fact. */
export function canMoveFact(list: readonly AgencyFactField[], index: number, delta: -1 | 1): boolean {
  const to = index + delta;
  if (to < 0 || to >= list.length) return false;
  if (list[index]?.highlight || list[to]?.highlight) return false;
  return true;
}

/** The list with fact `from` moved to `to` (both clamped); the highlighted fact stays first. */
export function moveFact(list: readonly AgencyFactField[], from: number, to: number): AgencyFactField[] {
  if (from < 0 || from >= list.length) return [...list];
  const floor = list[0]?.highlight ? 1 : 0;
  if (list[from]?.highlight) return [...list];
  const target = Math.max(floor, Math.min(to, list.length - 1));
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved!);
  return next;
}

/** The name and line-under-name roles a save sends: only those set. */
function rolesPayload(facts: FactsForm): AgencyContextRoles {
  const name = facts.name.trim();
  const place = facts.place.trim();
  return { ...(name !== '' ? { name } : {}), ...(place !== '' ? { place } : {}) };
}

/** The facts a save sends: each name trimmed, `highlight` only when on. */
function factsPayload(facts: FactsForm): AgencyFactField[] {
  return facts.list.map((f) => ({ column: f.column, label: f.label.trim(), key: f.key, ...(f.highlight ? { highlight: true } : {}) }));
}

/**
 * The `context_display` a save sends: the stored one (the hero, order and hidden columns are set
 * where the roster is imported, and a PATCH replaces the whole object) with this card: the name
 * and line-under-name roles (the old amount-due and due-date roles dropped), the types, and the
 * facts, always written (AS19: the campaign is on the new model from its first save of the card).
 * An empty roles or types map is left out.
 */
export function contextDisplayPayload(stored: AgencyContextDisplay | null | undefined, facts: FactsForm): AgencyContextDisplay {
  const { roles: _roles, types: _types, facts: _facts, ...rest } = isRecord(stored) ? stored : {};
  void _roles;
  void _types;
  void _facts;
  const roles = rolesPayload(facts);
  return {
    ...rest,
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
    ...(Object.keys(facts.types).length > 0 ? { types: { ...facts.types } } : {}),
    facts: factsPayload(facts),
  };
}

/** The keys the card's facts make: the fixed four, then each fact's key (`scriptPlaceholdersFor`). */
export function cardKeys(facts: FactsForm): string[] {
  return scriptPlaceholdersFor({ facts: facts.list });
}

/** Whether two column names are the same column, as the server compares them (ignoring case). */
export function sameColumn(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/** The column of `columns` that is `name` (ignoring case), or undefined. */
export function columnNamed(columns: readonly string[], name: string): string | undefined {
  return columns.find((column) => sameColumn(column, name));
}

/** How `column` is read (ignoring case, as the server matches it): absent is text. */
export function columnType(facts: FactsForm, column: string): AgencyContextFieldType {
  const key = columnNamed(Object.keys(facts.types), column);
  return key === undefined ? 'text' : facts.types[key]!;
}

/**
 * The columns the pickers offer: the roster's columns as imported (the newest imports'), then any
 * column the campaign names in its display (hero, order, roles, types, facts) or the form names,
 * each once (ignoring case), in that order. A stored column is offered like any other: the server
 * took it when it was saved (the lineage's every import counts there, not only the newest the
 * console reads).
 */
export function campaignColumns(imported: readonly string[], display: AgencyContextDisplay | null | undefined, facts: FactsForm): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (column: unknown) => {
    if (typeof column !== 'string' || column.trim() === '') return;
    if (seen.has(fold(column))) return;
    seen.add(fold(column));
    out.push(column);
  };
  imported.forEach(add);
  const shown = isRecord(display) ? display : {};
  for (const list of [shown.hero, shown.order]) if (Array.isArray(list)) list.forEach(add);
  if (isRecord(shown.roles)) Object.values(shown.roles).forEach(add);
  if (isRecord(shown.types)) Object.keys(shown.types).forEach(add);
  if (Array.isArray(shown.facts)) shown.facts.forEach((f) => add(isRecord(f) ? f.column : undefined));
  add(facts.name);
  add(facts.place);
  facts.list.forEach((f) => add(f.column));
  Object.keys(facts.types).forEach(add);
  return out;
}

/** The columns hidden from agents (`context_display.hidden`). */
export function hiddenColumns(display: AgencyContextDisplay | null | undefined): string[] {
  const hidden = isRecord(display) ? display.hidden : undefined;
  return Array.isArray(hidden) ? hidden.filter((c): c is string => typeof c === 'string') : [];
}

/**
 * A copy of `facts` with `column` read as `type` (`text` takes it off the map: absent is text). One
 * key per column: a key that is the same column in another case is replaced, and its spelling kept
 * (the stored one), so the map never names one column twice.
 */
export function withColumnType(facts: FactsForm, column: string, type: AgencyContextFieldType): FactsForm {
  const keys = Object.keys(facts.types);
  const key = columnNamed(keys, column) ?? column;
  const rest = Object.fromEntries(Object.entries(facts.types).filter(([name]) => !sameColumn(name, column)));
  return { ...facts, types: type === 'text' ? rest : { ...rest, [key]: type } };
}

// ─── Sample values (the add-fact picker and the script's preview) ───────────

/** One customer's uploaded columns, as the contact read gives them. */
export type SampleRow = Record<string, unknown>;

/** A row's raw text for `column` (exact spelling, else ignoring case); `''` when blank or absent. */
export function sampleRaw(row: SampleRow | undefined, column: string | undefined): string {
  if (!row || !column) return '';
  const key = Object.hasOwn(row, column) ? column : Object.keys(row).find((k) => sameColumn(k, column));
  const value = key === undefined ? undefined : row[key];
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  return text.trim();
}

const INDIAN_NUMBER = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 20 });

/**
 * A raw value as the card writes it, read as `type` by the server's one parse rule: `₹1,25,000`,
 * `20 Nov`, `1,25,000`, a phone number by the campaign's number display, `Yes` / `No`; the raw
 * text when the rule cannot read it, `''` when blank. For the editor's samples and its preview;
 * the station draws the card itself.
 */
export function sampleText(raw: string, type: AgencyContextFieldType, phoneDisplay: AgencyPhoneDisplay = 'full'): string {
  if (raw.trim() === '') return '';
  const value = parseContextFact(raw, type);
  if (value === null) return raw;
  switch (type) {
    case 'money': return rupees(value) ?? raw;
    case 'date': return calendarDay(value);
    case 'number': {
      const [whole, frac] = value.split('.');
      return `${INDIAN_NUMBER.format(whole as unknown as number)}${frac ? `.${frac}` : ''}`;
    }
    case 'phone': return phoneForDisplay(value, phoneDisplay);
    case 'yes_no': return value === 'yes' ? 'Yes' : 'No';
    default: return raw;
  }
}

/** The first non-blank raw value of `column` among `rows`, or `''`. */
export function firstSample(rows: readonly SampleRow[], column: string): string {
  for (const row of rows) {
    const raw = sampleRaw(row, column);
    if (raw !== '') return raw;
  }
  return '';
}

/** What the agent is told is missing for a key: the fact's name, "Name", "Place", … */
export function keyLabel(key: string, facts: FactsForm): string {
  const fact = facts.list.find((f) => f.key === key);
  if (fact) return fact.label.trim() || key;
  const fixed: Record<string, string> = {
    name: 'Name', place: 'Place', agent_name: 'Agent’s name', campaign_name: 'Campaign name',
    amount_due: 'Amount due', due_date: 'Due date',
  };
  return fixed[key] ?? key;
}

// ─── The unsaved-changes bar and the save ───────────────────────────────────

/** The stable form of a value, for comparing. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortedTypes(types: Record<string, AgencyContextFieldType>): Array<[string, AgencyContextFieldType]> {
  return Object.entries(types).sort(([a], [b]) => a.localeCompare(b));
}

/** Whether the card differs between two forms (spaces round a name ignored). */
export function factsChanged(saved: FactsForm, now: FactsForm): boolean {
  return !same(rolesPayload(saved), rolesPayload(now))
    || !same(factsPayload(saved), factsPayload(now))
    || !same(sortedTypes(saved.types), sortedTypes(now.types));
}

/** Each setting here that differs between the saved form and the one on screen. */
export function stationChanges(saved: StationSettingsForm, now: StationSettingsForm): string[] {
  const changed: string[] = [];
  if (saved.dailyTarget.trim() !== now.dailyTarget.trim()) changed.push('dailyTarget');
  if (saved.phoneDisplay !== now.phoneDisplay) changed.push('phoneDisplay');
  if (!same(scriptPayload(saved.script), scriptPayload(now.script))) changed.push('script');
  if (factsChanged(saved.facts, now.facts)) changed.push('customerFacts');
  return changed;
}

/** What a save of the station's settings does with the script and the card (see the file's header). */
export interface StationPlan {
  /** Each setting that changed ({@link stationChanges}). */
  changes: string[];
  /** The script is sent. */
  scriptSent: boolean;
  /** The card (`context_display`) is sent: it changed, or the script names a key only the form's card has. */
  displaySent: boolean;
  /**
   * The keys the script may use as things stand: the form's card's when the card is sent; else the
   * stored display's (with the form's, which then equal them or are not yet written).
   */
  allowed: string[];
  /** The keys the editor offers: the form's card's, fixed ones first. */
  offered: string[];
}

/** {@link StationPlan} for this form against what is saved and the stored display. */
export function stationPlan(
  saved: StationSettingsForm,
  now: StationSettingsForm,
  storedDisplay: AgencyContextDisplay | null | undefined,
): StationPlan {
  const changes = stationChanges(saved, now);
  const scriptSent = changes.includes('script');
  const stored = scriptPlaceholdersFor(isRecord(storedDisplay) ? storedDisplay : {});
  const offered = cardKeys(now.facts);
  const displaySent = changes.includes('customerFacts') || (scriptSent && scriptUnknowns(now.script, stored).length > 0);
  const allowed = displaySent ? offered : [...stored, ...offered.filter((k) => !stored.includes(k))];
  return { changes, scriptSent, displaySent, allowed, offered };
}

/**
 * What a save sends for these settings: only those that changed since the form was loaded or
 * saved, so an untouched one is never sent back over someone else's newer edit, and the card with
 * a script that needs it ({@link stationPlan}). `storedDisplay` is the campaign's `context_display`
 * as last read, which the card is merged into.
 */
export function stationPayload(
  saved: StationSettingsForm,
  now: StationSettingsForm,
  storedDisplay: AgencyContextDisplay | null | undefined,
): Partial<AgencyCampaign> {
  const plan = stationPlan(saved, now, storedDisplay);
  const changed = new Set(plan.changes);
  return {
    ...(changed.has('dailyTarget') ? { daily_target_calls: dailyTargetPayload(now.dailyTarget) } : {}),
    ...(changed.has('phoneDisplay') ? { phone_display: now.phoneDisplay } : {}),
    ...(plan.scriptSent ? { agent_script: scriptPayload(now.script) } : {}),
    ...(plan.displaySent ? { context_display: contextDisplayPayload(storedDisplay, now.facts) } : {}),
  };
}

/** The saved facts a script still uses that the form has taken off the card: what "Put it back" restores. */
export function removedFactsInUse(saved: FactsForm, now: FactsForm, script: ScriptForm): AgencyFactField[] {
  const used = new Set(scriptTokens(script).map((t) => t.slice(1, -1)));
  return saved.list.filter((f) => used.has(f.key) && !now.list.some((n) => n.key === f.key));
}

/**
 * The list with a removed saved fact put back where it was (or last), when the card has room and
 * its column is not on the card again; null when it cannot go back.
 */
export function putBack(saved: FactsForm, now: FactsForm, key: string): AgencyFactField[] | null {
  const at = saved.list.findIndex((f) => f.key === key);
  const fact = saved.list[at];
  if (!fact || now.list.length >= AGENCY_FACT_FIELDS_MAX) return null;
  if (now.list.some((f) => f.key === key || sameColumn(f.column, fact.column))) return null;
  // Highlighted again only when no other fact has taken the highlight meanwhile.
  if (fact.highlight && !now.list.some((f) => f.highlight)) return [{ ...plainFact(fact), highlight: true }, ...now.list];
  const floor = now.list[0]?.highlight ? 1 : 0;
  const index = Math.max(floor, Math.min(at, now.list.length));
  return [...now.list.slice(0, index), plainFact(fact), ...now.list.slice(index)];
}

/**
 * Every finding here that holds Save, keyed by field path; empty when it may be saved. Only what is
 * sent is judged: one stored before a rule existed (or written another way) is not sent back, so
 * it does not hold a save of something else. A card that is sent while the stored script (not sent)
 * uses a key it no longer has is said on the facts list, as the server says it.
 */
export function stationErrors(
  saved: StationSettingsForm,
  now: StationSettingsForm,
  storedDisplay: AgencyContextDisplay | null | undefined,
  context: FactsContext,
): Record<string, string> {
  const plan = stationPlan(saved, now, storedDisplay);
  const target = plan.changes.includes('dailyTarget') ? dailyTargetError(now.dailyTarget) : null;
  const errors: Record<string, string> = {
    ...(target ? { daily_target_calls: target } : {}),
    ...(plan.scriptSent ? scriptErrors(now.script, plan.allowed) : {}),
    ...(plan.displaySent ? factsErrors(now.facts, context) : {}),
  };
  if (plan.displaySent && !plan.scriptSent && errors[FACTS_FIELD] === undefined) {
    const unknown = scriptUnknowns(now.script, plan.allowed);
    // The server's refusal of a card that leaves the stored script a key, in its words, on its field.
    if (unknown.length > 0) {
      errors[FACTS_FIELD] = `The script uses ${listed(unknown)}. Take ${unknown.length === 1 ? 'it' : 'them'} out of the script first, or keep the fact.`;
    }
  }
  return errors;
}
