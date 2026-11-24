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
import { fold } from '@magick-agency/domain/context-columns';
import { parseContextFact } from '@magick-agency/domain/context-facts';
import { guessNameColumn, guessPlaceColumn } from '@magick-agency/domain/customer-name';
import { moreDetailTypeOf } from '@magick-agency/domain/more-details';
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
import { factDisplay } from './stationCustomer';

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
 * writes `facts` and drops `roles.amount_due` / `roles.due_date`. The old card drew the amount due
 * and the due date first, so `legacyFactFields` opens the list in that order (AS19 S9). The name and the line under
 * it are guessed by the domain's one guess (`@magick-agency/domain/customer-name`, S1); a save of
 * the card writes each guess as its role (R1, S2), so "None" under the name is none.
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
  /**
   * `roles.place`, the line under the name: `''` guesses it from the column names (a save writes
   * the guess), null is none. A card on the new model with no `place` role opens as none (the
   * station shows none there, S2); one on the old model opens as the guess, as its agents see it.
   */
  place: string | null;
  /** The facts on the card, in order (at most {@link AGENCY_FACT_FIELDS_MAX}). */
  list: AgencyFactField[];
  /** Each column's type; absent is text (on More details, a phone-looking value reads as a phone, AS20). */
  types: Record<string, AgencyContextFieldType>;
  /**
   * AS20: the columns agents do not see under More details (`context_display.more_hidden`), as
   * stored or ticked off. Every other column of the latest upload is shown there.
   */
  moreHidden: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const TYPES: ReadonlySet<string> = new Set(AGENCY_CONTEXT_FIELD_TYPES);

/** The line under the name as chosen: its column, or `''` when it is guessed or none. */
function placeChosen(facts: FactsForm): string {
  return facts.place?.trim() ?? '';
}

/**
 * The name column the card shows: the chosen one, else the domain's guess over `columns` (S1),
 * never a hidden column, a fact's, a phone-typed one or the chosen line under the name (a save
 * writes the guess).
 */
export function nameColumnOf(facts: FactsForm, columns: readonly string[], hidden: readonly string[]): string | undefined {
  if (facts.name.trim() !== '') return facts.name;
  return guessNameColumn(columns, {
    hidden,
    exclude: [...facts.list.map((f) => f.column), placeChosen(facts)],
    types: facts.types,
  });
}

/**
 * The line-under-the-name column the card shows: the chosen one; none when it is set to none;
 * else the domain's guess over `columns`, never a hidden column, a fact's, a phone-typed one or
 * the name's.
 */
export function placeColumnOf(facts: FactsForm, columns: readonly string[], hidden: readonly string[]): string | undefined {
  if (facts.place === null) return undefined;
  if (facts.place.trim() !== '') return facts.place;
  const name = nameColumnOf(facts, columns, hidden);
  return guessPlaceColumn(columns, {
    hidden,
    exclude: [...facts.list.map((f) => f.column), ...(name ? [name] : [])],
    types: facts.types,
  });
}

/** The old tile roles and the type each read its column as, whatever `types` said. */
const LEGACY_ROLE_TYPES: ReadonlyArray<readonly ['amount_due' | 'due_date', AgencyContextFieldType]> = [
  ['amount_due', 'money'],
  ['due_date', 'date'],
];

/**
 * The card as a stored display has it. A display with `facts` gives them back; one without opens
 * with what agents see today (`legacyFactFields` over `columns`, the guessed name and line under it
 * left out), and the old amount-due and due-date role columns are read as money and a date as
 * their roles read them, whatever `types` stored (on the new model a fact is read by `types` alone).
 *
 * @param columns the roster's columns, or null while they are not known (the hero list as written)
 */
export function factsFormOf(display: AgencyContextDisplay | null | undefined, columns: readonly string[] | null): FactsForm {
  const shown = isRecord(display) ? display : {};
  const roles = isRecord(shown.roles) ? shown.roles : {};
  const chosen = Array.isArray(shown.facts);
  const name = typeof roles.name === 'string' ? roles.name : '';
  // On the new model no `place` role is none (S2); on the old one the server guessed it.
  const placeRole = typeof roles.place === 'string' && roles.place.trim() !== '' ? roles.place : null;
  const place = placeRole ?? (chosen ? null : '');
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
      ...(name === '' ? [guessNameColumn(columns, { hidden, types })] : []),
      ...(place === '' ? [guessPlaceColumn(columns, { hidden, types })] : []),
    ].filter((c): c is string => c !== undefined);
  // On the old model, in the old card's order (S9: the amount due, the due date, then the other heroes).
  const list = legacyFactFields(shown, columns, { exclude });
  const moreHidden = Array.isArray(shown.more_hidden)
    ? shown.more_hidden.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    : [];
  let form: FactsForm = { name, place, list, types, moreHidden };
  if (!chosen) {
    // AS19 R10: the old role overrode `types`, so the role's column is read as money or a date
    // whatever `types` stored; the first save then changes nothing agents see.
    for (const [role, fixed] of LEGACY_ROLE_TYPES) {
      const column = roles[role];
      if (typeof column !== 'string' || column.trim() === '') continue;
      const fact = list.find((f) => sameColumn(f.column, column));
      if (fact) form = withColumnType(form, fact.column, fixed);
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
function scriptTokens(script: ScriptForm): string[] {
  return placeholdersIn(scriptTexts(script).join('\n'));
}

/** The `{word}`s of a script that are not one of `allowed`, as written, each once, in order. */
function scriptUnknowns(script: ScriptForm, allowed: Iterable<string>): string[] {
  return unknownPlaceholdersIn(scriptTexts(script).join('\n'), allowed);
}

/** `a`, `a and b`, `a, b and c`. */
export function listed(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The server's refusal of a script `{word}` the card has no fact for, for one or several. */
function unknownKeysMessage(tokens: readonly string[]): string {
  return tokens.length === 1
    ? `The script uses ${tokens[0]}, which is not a fact on the card. Add it as a fact or take it out.`
    : `The script uses ${listed(tokens)}, which are not facts on the card. Add them as facts or take them out.`;
}

/** What a script says of the `{word}`s it may not use, given those words. */
export type UnknownKeysMessage = (tokens: readonly string[]) => string;

function textError(
  text: string,
  max: number,
  what: string,
  required: boolean,
  allowed: readonly string[],
  unknownMessage: UnknownKeysMessage,
): string | null {
  const length = scriptLength(text);
  if (length === 0) return required ? `Write ${what.toLowerCase()}, or remove it.` : null;
  if (length > max) return `${what} is ${formatCount(length)} characters. Keep it to ${formatCount(max)}.`;
  const unknown = unknownPlaceholdersIn(text, allowed);
  return unknown.length > 0 ? unknownMessage(unknown) : null;
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
 * @param unknownMessage what a key outside `allowed` is told: by default the card's words (add it as
 *        a fact); a script with no card (a campaign template's) says its own
 */
export function scriptErrors(
  script: ScriptForm,
  allowed: readonly string[],
  unknownMessage: UnknownKeysMessage = unknownKeysMessage,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const opening = textError(script.opening, AGENCY_SCRIPT_OPENING_MAX_CHARS, 'The opening line', false, allowed, unknownMessage);
  if (opening) errors[SCRIPT_OPENING_FIELD] = opening;
  script.steps.forEach((step, i) => {
    const error = textError(step, AGENCY_SCRIPT_STEP_MAX_CHARS, `Step ${i + 1}`, true, allowed, unknownMessage);
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

/** Whether two lists hold their facts in a different order (or different facts): a reorder, an add, a removal. */
export function factsReordered(before: readonly AgencyFactField[], after: readonly AgencyFactField[]): boolean {
  return before.length !== after.length || before.some((f, i) => f.key !== after[i]?.key);
}

/**
 * `errors` without the ones keyed by a fact's place (`context_display.facts.<i>.<part>`): after a
 * reorder the place names another fact, so the server's answer to the last save no longer fits
 * (S9). The list's own (`context_display.facts`) stays.
 */
export function withoutPlacedFactErrors(errors: Record<string, string>): Record<string, string> {
  const placed = new RegExp(`^${FACTS_FIELD.replace(/\./g, '\\.')}\\.\\d+\\.`);
  return Object.fromEntries(Object.entries(errors).filter(([field]) => !placed.test(field)));
}

/** A column's type field path (the server's `details` key). */
export function typeField(column: string): string {
  return `context_display.types.${column}`;
}

/** The message when a fifth fact is asked for. */
export const FACTS_LIMIT_MESSAGE = `You can show ${AGENCY_FACT_FIELDS_MAX} facts at most. Remove one to add another.`;
/** The message on a fact whose column the latest upload does not have. */
export const FACT_COLUMN_MISSING_MESSAGE = 'This column is not in the latest upload. Choose another or remove the fact.';
/** While the customer list's columns are read: an old-model card is not opened without them (S9). */
export const COLUMNS_LOADING_MESSAGE = 'Loading the customer list’s columns…';
/** When that read failed: the card cannot be saved until it is read again. */
export const COLUMNS_FAILED_MESSAGE = 'Could not read the customer list’s columns. Try again.';

/** The server's refusal of a phone number as the customer's name (AS19 S3(e)), in its words. */
export const NAME_PHONE_MESSAGE = "A phone number cannot be the customer's name. Add it as a fact instead.";
/** The server's refusal of a phone number as the line under the name (AS19 S3(e)), in its words. */
export const PLACE_PHONE_MESSAGE = "A phone number cannot be the line under the name. Add it as a fact instead.";

/** What the facts are judged against besides themselves. */
export interface FactsContext {
  /** The columns hidden from agents. */
  hidden: readonly string[];
  /**
   * The latest upload's columns (the newest import's only, S9); empty while unknown (then no
   * column is said to be missing).
   */
  uploaded: readonly string[];
  /**
   * The columns the name and line-under-name selects offer, for the guesses a save writes: a
   * guessed column read as a phone number is refused as a chosen one is. Absent: only a chosen
   * column is judged.
   */
  columns?: readonly string[];
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
  const place = placeChosen(facts);
  if (name !== '' && hiddenSet.has(fold(name))) errors[NAME_FIELD] = `‘${name}’ is hidden from agents, so it cannot be the customer’s name.`;
  if (place !== '' && hiddenSet.has(fold(place))) {
    errors[PLACE_FIELD] = `‘${place}’ is hidden from agents, so it cannot be the line under the name.`;
  } else if (place !== '' && name !== '' && fold(place) === fold(name)) {
    errors[PLACE_FIELD] = `‘${place}’ is already the customer’s name. Choose another column.`;
  }
  // S3(e): a column read as a phone number is never the name or the line under it: a chosen one is
  // refused here, and the guess never picks one (the domain skips it).
  const shownName = context.columns ? nameColumnOf(facts, context.columns, context.hidden) : name || undefined;
  const shownPlace = context.columns ? placeColumnOf(facts, context.columns, context.hidden) : place || undefined;
  if (errors[NAME_FIELD] === undefined && shownName !== undefined && columnType(facts, shownName) === 'phone') {
    errors[NAME_FIELD] = NAME_PHONE_MESSAGE;
  }
  if (errors[PLACE_FIELD] === undefined && shownPlace !== undefined && columnType(facts, shownPlace) === 'phone') {
    errors[PLACE_FIELD] = PLACE_PHONE_MESSAGE;
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

/**
 * A new fact for `column`: its name and key by the default rule, each unlike `list`'s (S9: a name
 * that would repeat one gets ` 2`, cut to fit: `Outstanding Bala`, then `Outstanding Ba 2`).
 */
export function newFact(column: string, list: readonly AgencyFactField[]): AgencyFactField {
  return {
    column,
    label: defaultFactLabel(column, list.map((f) => f.label.trim())),
    key: factKeyFromColumn(column, list.map((f) => f.key)),
  };
}

/** The key the Full and Half amounts on What happened? read: the amount-due tile's. */
export const AMOUNT_DUE_KEY = 'amount_due';

/**
 * The list with fact `index` used for Full and Half (AS19 S9), or not. On: its key becomes
 * `amount_due`, and the fact that had it gets its default key back. Off: it gets its default key.
 * One at most; no other key is ever edited.
 */
export function withAmountDue(list: readonly AgencyFactField[], index: number, on: boolean): AgencyFactField[] {
  if (index < 0 || index >= list.length) return [...list];
  // A default key never `amount_due` again: that is what "off" means.
  const defaultKey = (i: number) => factKeyFromColumn(list[i]!.column, [...list.filter((_, j) => j !== i).map((f) => f.key), AMOUNT_DUE_KEY]);
  return list.map((fact, i) => {
    if (i === index) {
      if (on) return { ...fact, key: AMOUNT_DUE_KEY };
      return fact.key === AMOUNT_DUE_KEY ? { ...fact, key: defaultKey(i) } : fact;
    }
    return on && fact.key === AMOUNT_DUE_KEY ? { ...fact, key: defaultKey(i) } : fact;
  });
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
  const place = placeChosen(facts);
  return { ...(name !== '' ? { name } : {}), ...(place !== '' ? { place } : {}) };
}

/** How the line under the name is set: a column, the guess, or none. */
function placeMode(facts: FactsForm): 'none' | 'guess' | 'set' {
  if (facts.place === null) return 'none';
  return facts.place.trim() === '' ? 'guess' : 'set';
}

/**
 * The name and line-under-name roles a save of the card writes (AS19 R1, S2): each chosen column;
 * else, on "Guess from the column names", the column the select names as the guess over
 * `columns` ({@link nameColumnOf}, {@link placeColumnOf}: never hidden, never a fact's), so the
 * name stays a hero on every surface once the card has facts and the line under it stays shown
 * (with facts the station guesses no place). None writes no place. Nothing is guessed when
 * `columns` is not given. Each in the roster's spelling when `columns` has it.
 */
function rolesToWrite(facts: FactsForm, columns: readonly string[] | null, hidden: readonly string[]): AgencyContextRoles {
  const spelt = (column: string) => (columns ? columnNamed(columns, column) ?? column : column);
  const name = facts.name.trim() !== '' ? spelt(facts.name.trim()) : columns ? nameColumnOf(facts, columns, hidden) ?? '' : '';
  const mode = placeMode(facts);
  const place = mode === 'set'
    ? spelt(placeChosen(facts))
    : mode === 'guess' && columns ? placeColumnOf({ ...facts, name }, columns, hidden) ?? '' : '';
  return rolesPayload({ ...facts, name, place });
}

/**
 * The facts a save sends: each name trimmed, `highlight` only when on, and each column in the
 * roster's spelling when `columns` has it (S9: the own-contacts list matches a column exactly).
 */
function factsPayload(facts: FactsForm, columns: readonly string[] | null = null): AgencyFactField[] {
  return facts.list.map((f) => ({
    column: (columns ? columnNamed(columns, f.column) : undefined) ?? f.column,
    label: f.label.trim(),
    key: f.key,
    ...(f.highlight ? { highlight: true } : {}),
  }));
}

/**
 * The `context_display` a save sends: the stored one (the hero, order and hidden columns are set
 * where the roster is imported, and a PATCH replaces the whole object) with this card: the name
 * and line-under-name roles (the old amount-due and due-date roles dropped), the types, and the
 * facts, always written (AS19: the campaign is on the new model from its first save of the card).
 * An empty roles or types map is left out. With `columns` (the columns the card's selects offer,
 * the roster's first), a name or line under it left on "Guess from the column names" is written as
 * the column guessed (AS19 R1, S2), and every column in the roster's spelling. AS20: the columns
 * ticked off More details are written as `more_hidden` (left out when none), and `order` gains
 * the latest upload's columns it does not name yet ({@link orderPayload}).
 */
export function contextDisplayPayload(
  stored: AgencyContextDisplay | null | undefined,
  facts: FactsForm,
  columns: readonly string[] | null = null,
  uploaded: readonly string[] | null = null,
): AgencyContextDisplay {
  const { roles: _roles, types: _types, facts: _facts, more_hidden: _moreHidden, ...rest } = isRecord(stored) ? stored : {};
  void _roles;
  void _types;
  void _facts;
  void _moreHidden;
  const roles = rolesToWrite(facts, columns, hiddenColumns(stored));
  const moreHidden = moreHiddenPayload(facts, columns);
  const order = orderPayload(rest.order, uploaded);
  return {
    ...rest,
    ...(order ? { order } : {}),
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
    ...(Object.keys(facts.types).length > 0 ? { types: { ...facts.types } } : {}),
    facts: factsPayload(facts, columns),
    ...(moreHidden.length > 0 ? { more_hidden: moreHidden } : {}),
  };
}

/**
 * AS20: the `context_display` a save sends when only More details changed: the stored one with the
 * form's `more_hidden` (and `order`, {@link orderPayload}), nothing else. The card is left exactly
 * as stored, so a campaign that has not chosen its facts stays on the old card (AS19's model is
 * taken only by a save of the card itself).
 */
export function moreDetailsDisplayPayload(
  stored: AgencyContextDisplay | null | undefined,
  facts: FactsForm,
  columns: readonly string[] | null = null,
  uploaded: readonly string[] | null = null,
): AgencyContextDisplay {
  const { more_hidden: _moreHidden, ...rest } = isRecord(stored) ? stored : {};
  void _moreHidden;
  const moreHidden = moreHiddenPayload(facts, columns);
  const order = orderPayload(rest.order, uploaded);
  return { ...rest, ...(order ? { order } : {}), ...(moreHidden.length > 0 ? { more_hidden: moreHidden } : {}) };
}

/**
 * AS20: the `order` a save writes. More details follows `order`, then the row's own order, which
 * the database does not keep, so a save writes the stored order followed by each of the latest
 * upload's columns it does not name yet (ignoring case), in the file's order: a column a later
 * upload added reads as the file does. Undefined (the stored one is kept as it is) when there is
 * no upload to read.
 */
function orderPayload(stored: unknown, uploaded: readonly string[] | null): string[] | undefined {
  if (!uploaded || uploaded.length === 0) return undefined;
  const out = Array.isArray(stored) ? stored.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : [];
  for (const column of uploaded) if (!out.some((c) => sameColumn(c, column))) out.push(column);
  return out;
}

/** AS20: `more_hidden` as a save sends it: each column once (ignoring case), in the roster's spelling when known. */
function moreHiddenPayload(facts: FactsForm, columns: readonly string[] | null): string[] {
  const out: string[] = [];
  for (const column of facts.moreHidden) {
    const name = (columns ? columnNamed(columns, column) : undefined) ?? column.trim();
    if (name !== '' && !out.some((c) => sameColumn(c, name))) out.push(name);
  }
  return out;
}

// ─── More details (AS20) ────────────────────────────────────────────────────

/** Whether agents see `column` under More details: not in {@link FactsForm.moreHidden} (ignoring case). */
export function moreShown(facts: FactsForm, column: string): boolean {
  return !facts.moreHidden.some((c) => sameColumn(c, column));
}

/** A copy of `facts` with `column` shown or not under More details. */
export function withMoreShown(facts: FactsForm, column: string, shown: boolean): FactsForm {
  const rest = facts.moreHidden.filter((c) => !sameColumn(c, column));
  return { ...facts, moreHidden: shown ? rest : [...rest, column] };
}

/** A copy of `facts` with every one of `columns` shown, or none of them, under More details. */
export function withMoreAll(facts: FactsForm, columns: readonly string[], shown: boolean): FactsForm {
  const rest = facts.moreHidden.filter((c) => !columns.some((col) => sameColumn(col, c)));
  return { ...facts, moreHidden: shown ? rest : [...rest, ...columns] };
}

/**
 * How More details reads `column`, as the server will (`moreDetailTypeOf`, the domain's, which reads
 * each customer's value): its type when the form sets one (Text included), else a phone number when
 * any of `samples` (the column's sample values) reads as one, so the supervisor sees what some agents
 * will, else text.
 */
export function moreTypeOf(facts: FactsForm, column: string, samples: readonly string[]): AgencyContextFieldType {
  const declared = moreDetailTypeOf(column, '', facts.types);
  if (declared !== 'text' || columnNamed(Object.keys(facts.types), column) !== undefined) return declared;
  return samples.some((raw) => moreDetailTypeOf(column, raw, facts.types) === 'phone') ? 'phone' : 'text';
}

/**
 * A copy of `facts` with `column` read as `type` on More details. Unlike {@link withColumnType},
 * Text is written too: on a More details column a column with no type is read as a phone number
 * wherever its value looks like one, so choosing Text is the supervisor saying "this is not a phone
 * number", and it is kept.
 */
export function withMoreType(facts: FactsForm, column: string, type: AgencyContextFieldType): FactsForm {
  const next = withColumnType(facts, column, type);
  if (type !== 'text') return next;
  const key = columnNamed(Object.keys(facts.types), column) ?? column;
  return { ...next, types: { ...next.types, [key]: 'text' } };
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

/**
 * A raw value as the station's card writes it (AS19 R12): read as `type` by the server's one parse
 * rule, as the server does at dial time, then drawn by the station's own formatter
 * (`factDisplay`, `stationCustomer.ts`), so Settings and the station cannot disagree (money,
 * number, date, phone under the campaign's number display, yes / no; the raw text when the rule
 * cannot read it). `''` when blank. For the editor's samples and its preview.
 */
export function sampleText(raw: string, type: AgencyContextFieldType, phoneDisplay: AgencyPhoneDisplay = 'full'): string {
  const text = raw.trim();
  if (text === '') return '';
  return factDisplay({ column: '', type, raw: text, value: parseContextFact(text, type) }, { phoneDisplay }).text;
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

/** Whether the card or More details differ between two forms (spaces round a name ignored). */
export function factsChanged(saved: FactsForm, now: FactsForm): boolean {
  return cardChanged(saved, now) || !same(foldedSorted(saved.moreHidden), foldedSorted(now.moreHidden));
}

/** Whether the card itself (the name, the line under it, the facts, the types) differs; not More details' ticks. */
export function cardChanged(saved: FactsForm, now: FactsForm): boolean {
  return !same(rolesPayload(saved), rolesPayload(now))
    || placeMode(saved) !== placeMode(now)
    || !same(factsPayload(saved), factsPayload(now))
    || !same(sortedTypes(saved.types), sortedTypes(now.types));
}

/** Column names folded and sorted, each once: two lists that name the same columns compare equal. */
function foldedSorted(columns: readonly string[]): string[] {
  return [...new Set(columns.map(fold))].sort();
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
   * The card itself is written ({@link contextDisplayPayload}). False when only More details'
   * ticks changed: then only `more_hidden` and `order` are merged into the stored display
   * ({@link moreDetailsDisplayPayload}).
   */
  cardSent: boolean;
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
  const scriptNeedsCard = scriptSent && scriptUnknowns(now.script, stored).length > 0;
  const displaySent = changes.includes('customerFacts') || scriptNeedsCard;
  const cardSent = scriptNeedsCard || cardChanged(saved.facts, now.facts);
  const allowed = cardSent ? offered : [...stored, ...offered.filter((k) => !stored.includes(k))];
  return { changes, scriptSent, displaySent, cardSent, allowed, offered };
}

/**
 * What a save sends for these settings: only those that changed since the form was loaded or
 * saved, so an untouched one is never sent back over someone else's newer edit, and the card with
 * a script that needs it ({@link stationPlan}). `storedDisplay` is the campaign's `context_display`
 * as last read, which the card is merged into; `columns`, the columns the card's selects offer,
 * name the guessed name column the card writes ({@link contextDisplayPayload}); `uploaded`, the
 * latest upload's columns, are its `order` when it has none (AS20).
 */
export function stationPayload(
  saved: StationSettingsForm,
  now: StationSettingsForm,
  storedDisplay: AgencyContextDisplay | null | undefined,
  columns: readonly string[] | null = null,
  uploaded: readonly string[] | null = null,
): Partial<AgencyCampaign> {
  const plan = stationPlan(saved, now, storedDisplay);
  const changed = new Set(plan.changes);
  return {
    ...(changed.has('dailyTarget') ? { daily_target_calls: dailyTargetPayload(now.dailyTarget) } : {}),
    ...(changed.has('phoneDisplay') ? { phone_display: now.phoneDisplay } : {}),
    ...(plan.scriptSent ? { agent_script: scriptPayload(now.script) } : {}),
    ...(plan.displaySent
      ? {
          context_display: plan.cardSent
            ? contextDisplayPayload(storedDisplay, now.facts, columns, uploaded)
            : moreDetailsDisplayPayload(storedDisplay, now.facts, columns, uploaded),
        }
      : {}),
  };
}

/** A saved fact taken off the card that the script still uses, and why it cannot go back (null: it can). */
export interface RemovedFact {
  fact: AgencyFactField;
  blocked: string | null;
}

/** The saved facts a script still uses that the form has taken off the card: what "Put it back" restores. */
export function removedFactsInUse(saved: FactsForm, now: FactsForm, script: ScriptForm): RemovedFact[] {
  const used = new Set(scriptTokens(script).map((t) => t.slice(1, -1)));
  return saved.list
    .filter((f) => used.has(f.key) && !now.list.some((n) => n.key === f.key))
    .map((fact) => ({ fact, blocked: putBackBlocked(saved, now, fact.key) }));
}

/**
 * Why a removed saved fact cannot be put back, said beside its disabled "Put it back" (S9), or
 * null when it can: the card is full, or its column or its key is on the card again.
 */
function putBackBlocked(saved: FactsForm, now: FactsForm, key: string): string | null {
  const fact = saved.list.find((f) => f.key === key);
  if (!fact) return 'This fact is not on the saved card.';
  if (now.list.length >= AGENCY_FACT_FIELDS_MAX) {
    return `The card is full (${AGENCY_FACT_FIELDS_MAX} of ${AGENCY_FACT_FIELDS_MAX}). Remove a fact first.`;
  }
  if (now.list.some((f) => sameColumn(f.column, fact.column))) return `‘${fact.column}’ is on the card again.`;
  if (now.list.some((f) => f.key === key)) return `Another fact uses {${key}} now.`;
  return null;
}

/**
 * The list with a removed saved fact put back where it was (or last), when the card has room and
 * its column and key are not on the card again; null when it cannot go back ({@link putBackBlocked}).
 */
export function putBack(saved: FactsForm, now: FactsForm, key: string): AgencyFactField[] | null {
  const at = saved.list.findIndex((f) => f.key === key);
  const fact = saved.list[at];
  if (!fact || putBackBlocked(saved, now, key) !== null) return null;
  // Highlighted again only when no other fact has taken the highlight meanwhile.
  if (fact.highlight && !now.list.some((f) => f.highlight)) return [{ ...plainFact(fact), highlight: true }, ...now.list];
  const floor = now.list[0]?.highlight ? 1 : 0;
  const index = Math.max(floor, Math.min(at, now.list.length));
  return [...now.list.slice(0, index), plainFact(fact), ...now.list.slice(index)];
}

/**
 * The server's refusal of a card that takes away a key the stored script uses (`lostKeyIssues` in
 * `apps/server/src/agency/agent-script.ts`), exactly: each `{key}` of the script, as written and
 * each once, that the stored display allowed and the sent card does not; null for none. One
 * message for one key or several, in the server's words.
 */
function lostKeysMessage(
  script: ScriptForm,
  storedDisplay: AgencyContextDisplay | null | undefined,
  sent: FactsForm,
): string | null {
  const before = new Set(scriptPlaceholdersFor(isRecord(storedDisplay) ? storedDisplay : {}));
  const after = new Set(cardKeys(sent));
  const lost = scriptTokens(script).filter((token) => before.has(token.slice(1, -1)) && !after.has(token.slice(1, -1)));
  if (lost.length === 0) return null;
  return lost.length === 1
    ? `The script uses ${lost[0]}. Take it out of the script first, or keep the fact.`
    : `The script uses ${listed(lost)}. Take them out of the script first, or keep the facts.`;
}

/** What {@link stationErrors} judges the card against. */
export interface StationContext extends FactsContext {
  /**
   * Why the card cannot be sent yet, or null: an old-model card waits for the customer list's
   * columns (S9), so a save that would send it is held with this, said on the facts.
   */
  cardWaiting?: string | null;
}

/**
 * Every finding here that holds Save, keyed by field path; empty when it may be saved. Only what is
 * sent is judged: one stored before a rule existed (or written another way) is not sent back, so
 * it does not hold a save of something else. A card that is sent while the stored script (not sent)
 * loses a key it uses is said on the facts list, as the server says it ({@link lostKeysMessage}).
 */
export function stationErrors(
  saved: StationSettingsForm,
  now: StationSettingsForm,
  storedDisplay: AgencyContextDisplay | null | undefined,
  context: StationContext,
): Record<string, string> {
  const plan = stationPlan(saved, now, storedDisplay);
  const target = plan.changes.includes('dailyTarget') ? dailyTargetError(now.dailyTarget) : null;
  const errors: Record<string, string> = {
    ...(target ? { daily_target_calls: target } : {}),
    ...(plan.scriptSent ? scriptErrors(now.script, plan.allowed) : {}),
    ...(plan.displaySent ? factsErrors(now.facts, context) : {}),
  };
  if (plan.displaySent && context.cardWaiting) {
    errors[FACTS_FIELD] = context.cardWaiting;
  } else if (plan.displaySent && !plan.scriptSent && errors[FACTS_FIELD] === undefined) {
    // The server's refusal of a card that takes a key from the stored script, in its words, on its field.
    const lost = lostKeysMessage(now.script, storedDisplay, now.facts);
    if (lost !== null) errors[FACTS_FIELD] = lost;
  }
  return errors;
}
