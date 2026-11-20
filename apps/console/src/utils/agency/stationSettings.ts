import {
  AGENCY_CONTEXT_ROLES,
  AGENCY_PHONE_DISPLAY_DEFAULT,
  AGENCY_SCRIPT_OPENING_MAX_CHARS,
  AGENCY_SCRIPT_PLACEHOLDERS,
  AGENCY_SCRIPT_STEPS_MAX,
  AGENCY_SCRIPT_STEP_MAX_CHARS,
  type AgencyAgentScript,
  type AgencyContextDisplay,
  type AgencyContextFieldType,
  type AgencyContextRole,
  type AgencyContextRoles,
  type AgencyPhoneDisplay,
  type AgencyScriptPlaceholder,
} from '@magick-agency/contracts/agency';
import {
  AGENCY_DAILY_TARGET_CALLS_MAX,
  AGENCY_DAILY_TARGET_CALLS_MIN,
  type AgencyCampaign,
} from '../../types/agency-campaign';
import { formatCount } from '../format/number';

/**
 * The agent station's campaign settings (agent station redesign: AS6, AS9, BE-6, BE-8), as the
 * campaign Settings page edits them: the daily target, how the station shows the customer's
 * number, the script, and the customer facts (which column plays which role, and how each column
 * is read). Pure, so each rule is tested where it is made. The pictures on outcomes and break
 * reasons (BE-13) are edited with the outcomes and the break limits, not here.
 *
 * Every rule mirrors the server's write (`agency/agent-script.ts`, `agency/customer-facts.ts`,
 * `agency/station-tiles.ts`, the `daily_target_calls` bounds): the page says what the server would
 * refuse as it is typed, and holds Save, as the break limits do. The server still has the last
 * word, and its refusal is shown on the field it names (`agent_script.opening`,
 * `agent_script.steps[<i>].text`, `context_display.roles.<role>`, `context_display.types.<column>`,
 * `daily_target_calls`, `phone_display`).
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

/** The customer facts: each role's column (`''`: not set), and each column's type (absent: text). */
export interface FactsForm {
  roles: Record<AgencyContextRole, string>;
  types: Record<string, AgencyContextFieldType>;
}

const EMPTY_ROLES: Record<AgencyContextRole, string> = { name: '', place: '', amount_due: '', due_date: '' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The form as a stored campaign has it. Anything malformed in what is stored reads as unset. */
export function stationSettingsOf(campaign: AgencyCampaign): StationSettingsForm {
  const target = campaign.daily_target_calls;
  const script = isRecord(campaign.agent_script) ? campaign.agent_script : {};
  const steps = Array.isArray(script.steps) ? script.steps : [];
  const display = isRecord(campaign.context_display) ? campaign.context_display : {};
  const roles = { ...EMPTY_ROLES };
  if (isRecord(display.roles)) {
    for (const role of AGENCY_CONTEXT_ROLES) {
      const column = (display.roles as Record<string, unknown>)[role];
      if (typeof column === 'string') roles[role] = column;
    }
  }
  const types: Record<string, AgencyContextFieldType> = {};
  if (isRecord(display.types)) {
    for (const [column, type] of Object.entries(display.types)) {
      if (type === 'text' || type === 'money' || type === 'date') types[column] = type;
    }
  }
  return {
    dailyTarget: typeof target === 'number' ? String(target) : '',
    phoneDisplay: campaign.phone_display === 'masked' ? 'masked' : AGENCY_PHONE_DISPLAY_DEFAULT,
    script: {
      opening: typeof script.opening === 'string' ? script.opening : '',
      steps: steps.map((step) => (isRecord(step) && typeof step.text === 'string' ? step.text : '')),
    },
    facts: { roles, types },
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

/** The number the setting's preview shows, as the station would show a ten-digit Indian mobile. */
export const PHONE_DISPLAY_SAMPLE = '+919876543321';

/**
 * A number as the station shows it under `display`: in full, or masked to the first two and the
 * last three of its ten digits (`98••• ••321`, AS9). A number too short to mask is shown as it is.
 */
export function phoneAsShown(phoneE164: string, display: AgencyPhoneDisplay): string {
  const digits = phoneE164.replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (display === 'full') return local.length === 10 ? `${local.slice(0, 5)} ${local.slice(5)}` : phoneE164;
  if (local.length < 6) return phoneE164;
  return `${local.slice(0, 2)}••• ••${local.slice(-3)}`;
}

// ─── Script (BE-8) ──────────────────────────────────────────────────────────

/** Length as the server counts it: Unicode code points, after trimming. */
export function scriptLength(text: string): number {
  return [...text.trim()].length;
}

/** The server's placeholder pattern: one word of letters, digits and underscores in braces. */
const BRACED = /\{\s*([A-Za-z0-9_]+)\s*\}/g;
const PLACEHOLDERS: ReadonlySet<string> = new Set(AGENCY_SCRIPT_PLACEHOLDERS);

/** The unknown `{word}`s a text names, braces included, each once, in order (the server's rule). */
export function unknownPlaceholders(text: string): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(BRACED)) {
    const word = match[0];
    if (!PLACEHOLDERS.has(word.slice(1, -1)) && !unknown.includes(word)) unknown.push(word);
  }
  return unknown;
}

/** The placeholder chips, in the order the editor offers them, each with its words. */
export const SCRIPT_PLACEHOLDER_CHIPS: ReadonlyArray<{ key: AgencyScriptPlaceholder; label: string }> = [
  { key: 'name', label: 'Customer name' },
  { key: 'place', label: 'Place' },
  { key: 'amount_due', label: 'Amount due' },
  { key: 'due_date', label: 'Due date' },
  { key: 'agent_name', label: 'Agent’s name' },
  { key: 'campaign_name', label: 'Campaign name' },
];

function textError(text: string, max: number, what: string, required: boolean): string | null {
  const length = scriptLength(text);
  if (length === 0) return required ? `Write ${what.toLowerCase()}, or remove it.` : null;
  if (length > max) return `${what} is ${formatCount(length)} characters. Keep it to ${formatCount(max)}.`;
  const unknown = unknownPlaceholders(text);
  if (unknown.length > 0) {
    return `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a word' : 'are not words'} the script can fill in. `
      + `Use the buttons above to add one: ${AGENCY_SCRIPT_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`;
  }
  return null;
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
 */
export function scriptErrors(script: ScriptForm): Record<string, string> {
  const errors: Record<string, string> = {};
  const opening = textError(script.opening, AGENCY_SCRIPT_OPENING_MAX_CHARS, 'The opening line', false);
  if (opening) errors[SCRIPT_OPENING_FIELD] = opening;
  script.steps.forEach((step, i) => {
    const error = textError(step, AGENCY_SCRIPT_STEP_MAX_CHARS, `Step ${i + 1}`, true);
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

// ─── Customer facts (BE-6) ──────────────────────────────────────────────────

/** Each role's words on the page. */
export const CONTEXT_ROLE_LABELS: Readonly<Record<AgencyContextRole, string>> = {
  name: 'Customer name',
  place: 'Place',
  amount_due: 'Amount due',
  due_date: 'Due date',
};

/** Each type's words on the page. */
export const CONTEXT_TYPE_LABELS: Readonly<Record<AgencyContextFieldType, string>> = {
  text: 'Text',
  money: 'Money',
  date: 'Date',
};

/** A role's field path (the server's `details` key). */
export function roleField(role: AgencyContextRole): string {
  return `context_display.roles.${role}`;
}

/** A column's type field path (the server's `details` key). */
export function typeField(column: string): string {
  return `context_display.types.${column}`;
}

/** The type a role reads its column as, whatever `types` says (the contract's rule); null for none. */
export function roleFixedType(role: AgencyContextRole): AgencyContextFieldType | null {
  if (role === 'amount_due') return 'money';
  if (role === 'due_date') return 'date';
  return null;
}

/** Column names compare as the server compares them: ignoring case. */
function fold(column: string): string {
  return column.trim().toLowerCase();
}

/**
 * What the server would refuse in the roles, keyed by field path: a column in two roles (said on
 * the second), and a hidden column as a role.
 */
export function factsErrors(facts: FactsForm, hidden: readonly string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const hiddenSet = new Set(hidden.map(fold));
  const used = new Map<string, AgencyContextRole>();
  for (const role of AGENCY_CONTEXT_ROLES) {
    const column = facts.roles[role].trim();
    if (column === '') continue;
    if (hiddenSet.has(fold(column))) {
      errors[roleField(role)] = `‘${column}’ is hidden from agents, so it cannot be the ${CONTEXT_ROLE_LABELS[role].toLowerCase()}.`;
      continue;
    }
    const other = used.get(fold(column));
    if (other !== undefined) {
      errors[roleField(role)] = `‘${column}’ is already the ${CONTEXT_ROLE_LABELS[other].toLowerCase()}. One column can play one role only.`;
      continue;
    }
    used.set(fold(column), role);
  }
  return errors;
}

/** The roles a save sends: only those set. */
function rolesPayload(facts: FactsForm): AgencyContextRoles {
  const roles: AgencyContextRoles = {};
  for (const role of AGENCY_CONTEXT_ROLES) {
    const column = facts.roles[role].trim();
    if (column !== '') roles[role] = column;
  }
  return roles;
}

/**
 * The `context_display` a save sends: the stored one (the hero, order and hidden columns are set
 * where the roster is imported, and a PATCH replaces the whole object) with these roles and types.
 * An empty roles or types map is left out.
 */
export function contextDisplayPayload(stored: AgencyContextDisplay | null | undefined, facts: FactsForm): AgencyContextDisplay {
  const { roles: _roles, types: _types, ...rest } = isRecord(stored) ? stored : {};
  void _roles;
  void _types;
  const roles = rolesPayload(facts);
  return {
    ...rest,
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
    ...(Object.keys(facts.types).length > 0 ? { types: { ...facts.types } } : {}),
  };
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
 * The columns the role and type pickers offer: the roster's columns as imported (the newest
 * imports'), then any column the campaign names in its display, its stored roles and types, or
 * the facts on the form that they leave out, each once (ignoring case), in that order. A stored
 * role or type is offered as a column like any other: the server took it when it was saved, and it
 * still takes it (the lineage's every import counts there, not only the newest the console reads).
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
  Object.values(facts.roles).forEach(add);
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

// ─── The unsaved-changes bar and the save ───────────────────────────────────

/** The stable form of a value, for comparing. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortedTypes(types: Record<string, AgencyContextFieldType>): Array<[string, AgencyContextFieldType]> {
  return Object.entries(types).sort(([a], [b]) => a.localeCompare(b));
}

/** Each setting here that differs between the saved form and the one on screen. */
export function stationChanges(saved: StationSettingsForm, now: StationSettingsForm): string[] {
  const changed: string[] = [];
  if (saved.dailyTarget.trim() !== now.dailyTarget.trim()) changed.push('dailyTarget');
  if (saved.phoneDisplay !== now.phoneDisplay) changed.push('phoneDisplay');
  if (!same(scriptPayload(saved.script), scriptPayload(now.script))) changed.push('script');
  if (!same(rolesPayload(saved.facts), rolesPayload(now.facts)) || !same(sortedTypes(saved.facts.types), sortedTypes(now.facts.types))) {
    changed.push('customerFacts');
  }
  return changed;
}

/**
 * What a save sends for these settings: only those that changed since the form was loaded or
 * saved, so an untouched one is never sent back over someone else's newer edit. `storedDisplay`
 * is the campaign's `context_display` as last read, which the facts are merged into.
 */
export function stationPayload(
  saved: StationSettingsForm,
  now: StationSettingsForm,
  storedDisplay: AgencyContextDisplay | null | undefined,
): Partial<AgencyCampaign> {
  const changed = new Set(stationChanges(saved, now));
  return {
    ...(changed.has('dailyTarget') ? { daily_target_calls: dailyTargetPayload(now.dailyTarget) } : {}),
    ...(changed.has('phoneDisplay') ? { phone_display: now.phoneDisplay } : {}),
    ...(changed.has('script') ? { agent_script: scriptPayload(now.script) } : {}),
    ...(changed.has('customerFacts') ? { context_display: contextDisplayPayload(storedDisplay, now.facts) } : {}),
  };
}

/**
 * Every finding here that holds Save, keyed by field path; empty when it may be saved. Only the
 * settings that changed are judged: one stored before a rule existed (or written another way) is
 * not sent back, so it does not hold a save of something else.
 */
export function stationErrors(saved: StationSettingsForm, now: StationSettingsForm, hidden: readonly string[]): Record<string, string> {
  const changed = new Set(stationChanges(saved, now));
  const target = changed.has('dailyTarget') ? dailyTargetError(now.dailyTarget) : null;
  return {
    ...(target ? { daily_target_calls: target } : {}),
    ...(changed.has('script') ? scriptErrors(now.script) : {}),
    ...(changed.has('customerFacts') ? factsErrors(now.facts, hidden) : {}),
  };
}
