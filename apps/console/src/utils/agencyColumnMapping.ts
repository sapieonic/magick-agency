import {
  AGENCY_MAX_DEDUPE_COLUMNS,
  type AgencyColumnAnalysis,
  type AgencyIngestRequest,
} from '../types/agency-campaign';
import type { AgencyContextDisplay } from '../types/agency';

/**
 * Column mapping — the roles, their arity rules, and the request they
 * build (requirement: *the operator can map any column as the
 * phone number*).
 *
 * Pure, per the house pattern. The rules here are worth a module rather than a
 * component's `useState` because two of them are load-bearing in ways a reviewer
 * would not guess:
 *
 *  - **`ignore` is a real choice, not an omission.** An `Internal Risk Score`
 *    left as `detail` is a value on an agent's screen in front of a customer, so
 *    the mapper offers it explicitly and the ingest request carries it in
 *    `ignore_columns` — which excludes it from `context` entirely, not merely
 *    from the display.
 *  - **The phone suggestion is a suggestion.** The API withholds it when two
 *    columns are too close to call (`phone_column_ambiguous`), and this module
 *    preselects **nothing** in that case rather than picking the higher score.
 *    Guessing wrong here dials the wrong people.
 *  - **The country code is a mapping decision too.** A bare 10-digit number in
 *    the file has no country in it; the API supplies one, and until now nothing
 *    let the operator say which. See {@link countryCodeError}.
 *  - **So is what counts as a duplicate.** One borrower with two loans is two
 *    rows on one number; deduping on the phone drops a loan nobody then calls.
 *    And one loan number can repeat across branches, so the key can combine up
 *    to three columns. See {@link DedupeChoice}.
 */

export type ColumnRole = 'phone' | 'timezone' | 'hero' | 'detail' | 'ignore';

/** Up to four fields get the agent's big-type treatment. */
export const MAX_HERO_FIELDS = 4;

export const ROLE_LABELS: Record<ColumnRole, string> = {
  phone: 'Phone number',
  timezone: 'Timezone',
  hero: 'Show first',
  detail: 'Detail',
  ignore: 'Ignore',
};

/** `column name → role`. Every analysed column has an entry. */
export type ColumnMapping = Record<string, ColumnRole>;

export interface MappingState {
  roles: ColumnMapping;
  /**
   * Hero columns in the order the operator picked them — this is the agent's
   * reading order, so it is a real decision and cannot be recovered from
   * `roles` alone (object key order is not a contract).
   */
  heroOrder: string[];
  /**
   * The country code the API applies to a number that carries none.
   *
   * **Empty means "send nothing", which is not the same as "send the default".**
   * The API falls back to `DEFAULT_PHONE_COUNTRY_CODE` (env, `91` unset) inside
   * `phone-normalizer.ts`, and only the server knows what that env holds — so
   * seeding this with a literal `'91'` would turn today's inherited default into
   * a value this console asserts, and would change what is dialed anywhere the env
   * differs. Empty is the only value that is provably a no-op.
   */
  defaultCountryCode: string;
  /** Which rows the ingest drops as duplicates. Starts at the phone, the old behaviour. */
  dedupe: DedupeChoice;
}

/** Most columns one duplicate key combines; the server refuses more. */
export const MAX_DEDUPE_KEYS = AGENCY_MAX_DEDUPE_COLUMNS;

/**
 * One part of the duplicate key: the phone number, or another column such as a
 * loan number. `phone` names no column: it follows whichever column holds the
 * phone, so remapping the phone cannot leave the key on a stale column.
 */
export type DedupeKey = { kind: 'phone' } | { kind: 'column'; column: string };

/**
 * "Check duplicates on": up to {@link MAX_DEDUPE_KEYS} keys, in the operator's
 * order, or nothing. One key is what this control always offered: the phone
 * number (the default, and what every upload did before it existed) or one
 * column. Several are a combination: a row is a duplicate only when EVERY key
 * matches an earlier row, so each key added can only drop fewer rows.
 */
export type DedupeChoice =
  | { mode: 'keys'; keys: DedupeKey[] }
  | { mode: 'none' };

/** The default: the phone number alone. */
export const PHONE_DEDUPE: DedupeChoice = { mode: 'keys', keys: [{ kind: 'phone' }] };

function sameKey(a: DedupeKey, b: DedupeKey): boolean {
  return a.kind === 'phone' ? b.kind === 'phone' : b.kind === 'column' && a.column === b.column;
}

/** The keys the choice holds; empty for none. */
export function dedupeKeys(choice: DedupeChoice): DedupeKey[] {
  return choice.mode === 'keys' ? choice.keys : [];
}

/**
 * The keys as the mapping can honour them: a column now holding the phone becomes
 * the phone key (the phone dedupe compares normalised numbers), a key named twice
 * counts once, and at most {@link MAX_DEDUPE_KEYS} are kept.
 */
function normaliseKeys(roles: ColumnMapping, keys: DedupeKey[]): DedupeKey[] {
  const out: DedupeKey[] = [];
  for (const key of keys) {
    const next: DedupeKey = key.kind === 'column' && roles[key.column] === 'phone' ? { kind: 'phone' } : key;
    if (!out.some((k) => sameKey(k, next))) out.push(next);
  }
  return out.slice(0, MAX_DEDUPE_KEYS);
}

/**
 * Seed a mapping from the API's analysis.
 *
 * Everything defaults to `detail`; the suggested phone column is preselected
 * **only** when the API offered one. A timezone column is never auto-detected —
 * The design says an unmapped contact uses the campaign default, and silently mapping a
 * column named `TZ` that holds something else is worse than asking. The country
 * code is likewise never inferred from the file: `analysis` carries no signal
 * for it, and guessing it wrong dials a different country.
 */
export function initialMapping(analysis: AgencyColumnAnalysis): MappingState {
  const roles: ColumnMapping = {};
  for (const column of analysis.columns) {
    roles[column.name] = 'detail';
  }
  const suggested = analysis.phone_column_ambiguous ? null : analysis.suggested_phone_column;
  if (suggested !== null && suggested in roles) {
    roles[suggested] = 'phone';
  }
  return { roles, heroOrder: [], defaultCountryCode: '', dedupe: PHONE_DEDUPE };
}

/**
 * Apply a role change, enforcing the arity rules.
 *
 * `phone` and `timezone` are exclusive: assigning one demotes the previous
 * holder to `detail` rather than refusing the change. A picker that refuses is a
 * picker where the operator has to work out which other row to clear first.
 */
export function setRole(state: MappingState, column: string, role: ColumnRole): MappingState {
  if (!(column in state.roles)) return state;

  const roles: ColumnMapping = { ...state.roles };
  let heroOrder = state.heroOrder.filter((name) => name !== column);

  if (role === 'phone' || role === 'timezone') {
    for (const [name, existing] of Object.entries(roles)) {
      if (existing === role && name !== column) roles[name] = 'detail';
    }
  }

  if (role === 'hero') {
    if (heroOrder.length >= MAX_HERO_FIELDS) {
      // Silently dropping the choice would read as a broken control, so the
      // caller is told by the unchanged state plus `heroLimitReached`.
      return state;
    }
    heroOrder = [...heroOrder, column];
  }

  const previousPhone = phoneColumn(state);
  roles[column] = role;
  let dedupe: DedupeChoice = state.dedupe;
  if (dedupe.mode === 'keys') {
    let keys = dedupe.keys;
    // The phone moved onto a column that is already a key, while the phone is a
    // key too: the two swap places, so the key still compares the same columns.
    // Merging them would drop the old phone column from the key, and a key with
    // fewer columns drops MORE rows (the false removal the combination exists
    // to prevent).
    const movedOntoKey = keys.some((key) => key.kind === 'column' && key.column === column);
    if (role === 'phone' && movedOntoKey && previousPhone !== null && previousPhone !== column
      && keys.some((key) => key.kind === 'phone')) {
      keys = keys.map((key): DedupeKey => {
        if (key.kind === 'phone') return { kind: 'column', column: previousPhone };
        return key.column === column ? { kind: 'phone' } : key;
      });
    }
    // A duplicate column made the phone column is the phone key; saying so keeps
    // the control and the request in step.
    dedupe = { mode: 'keys', keys: normaliseKeys(roles, keys) };
  }
  return { ...state, roles, heroOrder, dedupe };
}

/**
 * Set what the ingest treats as a duplicate row. A choice naming an unknown
 * column, or no key at all, is ignored; a column holding the phone becomes the
 * phone key, a repeated key counts once, and keys past the maximum are dropped.
 */
export function setDedupe(state: MappingState, choice: DedupeChoice): MappingState {
  if (choice.mode === 'none') return { ...state, dedupe: choice };
  if (choice.keys.some((key) => key.kind === 'column' && !(key.column in state.roles))) return state;
  const keys = normaliseKeys(state.roles, choice.keys);
  if (keys.length === 0) return state;
  return { ...state, dedupe: { mode: 'keys', keys } };
}

/**
 * Put `key` at position `index` of the duplicate key (0 is the first select). A
 * key already elsewhere in the list moves here rather than appearing twice.
 */
export function setDedupeKey(state: MappingState, index: number, key: DedupeKey): MappingState {
  const keys = [...dedupeKeys(state.dedupe)];
  if (index < 0 || index > keys.length) return state;
  const others = keys.filter((k, i) => i !== index && !sameKey(k, key));
  others.splice(Math.min(index, others.length), 0, key);
  return setDedupe(state, { mode: 'keys', keys: others });
}

/** Drop the key at `index`. The last key cannot be removed: "Don't remove duplicates" is how to say none. */
export function removeDedupeKey(state: MappingState, index: number): MappingState {
  const keys = dedupeKeys(state.dedupe);
  if (keys.length <= 1 || index < 0 || index >= keys.length) return state;
  return setDedupe(state, { mode: 'keys', keys: keys.filter((_, i) => i !== index) });
}

/**
 * Every key the operator could pick for the select at `index`: the phone number,
 * then {@link dedupeColumnOptions}, less the keys the OTHER selects hold.
 */
export function dedupeKeyOptions(analysis: AgencyColumnAnalysis, state: MappingState, index: number): DedupeKey[] {
  const taken = dedupeKeys(state.dedupe).filter((_, i) => i !== index);
  const all: DedupeKey[] = [
    { kind: 'phone' },
    ...dedupeColumnOptions(analysis, state).map((column): DedupeKey => ({ kind: 'column', column })),
  ];
  return all.filter((key) => !taken.some((k) => sameKey(k, key)));
}

/**
 * Add a key to the combination: the first one not already in it, in the order
 * {@link dedupeKeyOptions} lists them. Unchanged when none is left, at the
 * maximum, or when the choice is "Don't remove duplicates".
 */
export function addDedupeKey(analysis: AgencyColumnAnalysis, state: MappingState): MappingState {
  if (!canAddDedupeKey(analysis, state)) return state;
  const keys = dedupeKeys(state.dedupe);
  const next = dedupeKeyOptions(analysis, state, keys.length)[0]!;
  return setDedupe(state, { mode: 'keys', keys: [...keys, next] });
}

export function canAddDedupeKey(analysis: AgencyColumnAnalysis, state: MappingState): boolean {
  if (state.dedupe.mode !== 'keys' || state.dedupe.keys.length >= MAX_DEDUPE_KEYS) return false;
  return dedupeKeyOptions(analysis, state, state.dedupe.keys.length).length > 0;
}

/** How the note and the summary name a key: the phone key by its column. */
export function dedupeKeyLabel(key: DedupeKey, phone: string | null): string {
  return key.kind === 'phone' ? phone ?? 'Phone number' : key.column;
}

/**
 * The columns offered under "Check duplicates on", besides the phone number and
 * "don't": every column that is neither the phone nor ignored, in file order.
 *
 * Not an ignored one: the roster refuses an exact repeat at insert by a row
 * fingerprint built from the phone and the kept columns, so two rows that differ
 * only in an ignored loan number would pass the duplicate check and still collapse
 * into one contact. A chosen column stays listed if it is later set to Ignore, so
 * its select still shows it; {@link mappingBlockReason} then blocks.
 */
export function dedupeColumnOptions(analysis: AgencyColumnAnalysis, state: MappingState): string[] {
  const chosen = dedupeKeys(state.dedupe).flatMap((key) => (key.kind === 'column' ? [key.column] : []));
  return analysis.columns
    .map((c) => c.name)
    .filter((name) => state.roles[name] !== 'phone' && (state.roles[name] !== 'ignore' || chosen.includes(name)));
}

function scopeOf(analysis: AgencyColumnAnalysis): string {
  return analysis.truncated ? 'in the rows we sampled' : 'in this file';
}

function percentUnique(distinct: number, total: number): number {
  return Math.floor((distinct / total) * 100);
}

/**
 * How unique a column is in the sampled rows, as the duplicate check compares
 * values (trimmed, case-insensitive): "Loan No: 100% unique in this file". Helps
 * the operator pick the right key before the import rather than learn it from the
 * rejected count. `null` when there is nothing to say (no column, no values, or an
 * analysis served without the count).
 */
export function uniquenessLine(analysis: AgencyColumnAnalysis, column: string | null): string | null {
  if (column === null) return null;
  const stat = analysis.columns.find((c) => c.name === column);
  if (!stat || stat.non_empty === 0 || typeof stat.distinct !== 'number') return null;
  const repeats = stat.non_empty - stat.distinct;
  const blank = stat.non_empty < analysis.rows_sampled
    ? ` ${(analysis.rows_sampled - stat.non_empty).toLocaleString()} blank, and a blank value is never a duplicate.`
    : '';
  return repeats === 0
    ? `${column}: 100% unique ${scopeOf(analysis)}.${blank}`
    : `${column}: ${percentUnique(stat.distinct, stat.non_empty)}% unique ${scopeOf(analysis)}; ${repeats.toLocaleString()} ${repeats === 1 ? 'row repeats' : 'rows repeat'} an earlier value and will be dropped.${blank}`;
}

/**
 * {@link uniquenessLine} for the phone dedupe, which compares normalised numbers
 * (`distinct_phones`), so `9876543210` and `+91 98765 43210` count once. Counted
 * over the values that are valid numbers: a blank or invalid one is rejected for
 * that reason, never as a duplicate.
 */
export function phoneUniquenessLine(analysis: AgencyColumnAnalysis, column: string | null): string | null {
  if (column === null) return null;
  const stat = analysis.columns.find((c) => c.name === column);
  if (!stat || typeof stat.distinct_phones !== 'number') return null;
  const valid = Math.round(stat.phone_score * stat.non_empty);
  if (valid === 0) return null;
  const repeats = valid - stat.distinct_phones;
  return repeats <= 0
    ? `${column}: every valid number is unique ${scopeOf(analysis)}.`
    : `${column}: ${percentUnique(stat.distinct_phones, valid)}% of valid numbers are unique ${scopeOf(analysis)}; ${repeats.toLocaleString()} ${repeats === 1 ? 'row repeats' : 'rows repeat'} an earlier number and will be dropped.`;
}

function listOf(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What a combined key does, for the note under the selects. The analysis counts
 * each column on its own, so how unique the combination is cannot be read off it,
 * with one exception said plainly: a key column with no repeat of its own means no
 * row can match an earlier one on every key, so nothing is dropped. `null` for a
 * single key (the per-column lines above say it).
 */
export function combinationLine(analysis: AgencyColumnAnalysis, state: MappingState): string | null {
  const keys = dedupeKeys(state.dedupe);
  if (keys.length < 2) return null;
  const phone = phoneColumn(state);
  const names = keys.map((key) => dedupeKeyLabel(key, phone));
  const rule = `A row is dropped only when its ${listOf(names)} ${keys.length === 2 ? 'both' : 'all'} match an earlier row; a row with any of them blank is not checked.`;
  const statOf = (key: DedupeKey) => analysis.columns.find((c) => c.name === (key.kind === 'phone' ? phone : key.column));
  // A key column blank in every sampled row: every row has a blank part, so none is checked.
  const blank = keys.find((key) => key.kind === 'column' && statOf(key)?.non_empty === 0);
  if (blank) {
    return `${rule} ${dedupeKeyLabel(blank, phone)} is blank in every row ${analysis.truncated ? 'we sampled, so none of those rows would be' : 'of this file, so no row will be'} dropped as a duplicate.`;
  }
  const unique = keys.find((key) => {
    const stat = statOf(key);
    if (!stat) return false;
    if (key.kind === 'phone') {
      const valid = Math.round(stat.phone_score * stat.non_empty);
      return typeof stat.distinct_phones === 'number' && valid > 0 && stat.distinct_phones >= valid;
    }
    return typeof stat.distinct === 'number' && stat.non_empty > 0 && stat.distinct >= stat.non_empty;
  });
  // Said of the sample when the analysis read only part of the file: a repeat
  // further down is still a repeat.
  const none = unique
    ? analysis.truncated
      ? ` ${dedupeKeyLabel(unique, phone)} has no repeats in the rows we sampled, so none of those rows would be dropped as a duplicate.`
      : ` ${dedupeKeyLabel(unique, phone)} has no repeats in this file, so no row will be dropped as a duplicate.`
    : '';
  return `${rule}${none}`;
}

/**
 * Set the country code applied to numbers that carry none.
 *
 * Trimmed here rather than at the call site so the value that reaches
 * {@link countryCodeError} and the value that reaches the request are the same
 * string — a trailing space is a validation failure the operator cannot see.
 */
export function setDefaultCountryCode(state: MappingState, value: string): MappingState {
  return { ...state, defaultCountryCode: value.trim() };
}

/**
 * The API's own rule (`/^\+?\d{1,3}$/` on both the analyze and ingest schemas),
 * mirrored so a typo is caught in front of the field rather than as a 400 after
 * the file has been uploaded.
 *
 * `null` for empty — empty is the legitimate "leave it to the platform default"
 * choice, not an omission to nag about.
 */
const COUNTRY_CODE_RE = /^\+?\d{1,3}$/;

export function countryCodeError(value: string): string | null {
  if (value.length === 0) return null;
  if (!COUNTRY_CODE_RE.test(value)) {
    return 'Use a dialling code of 1 to 3 digits, like 91 for India or 1 for the US. Leave it blank to keep the platform default.';
  }
  return null;
}

export function heroLimitReached(state: MappingState): boolean {
  return state.heroOrder.length >= MAX_HERO_FIELDS;
}

/** Why the mapping cannot be submitted. `null` ⇒ ready. */
export type MappingBlockReason = 'no_phone_column' | 'no_columns' | 'dedupe_column_ignored' | 'bad_country_code';

export const MAPPING_BLOCK_COPY: Record<MappingBlockReason, string> = {
  no_phone_column: 'Pick which column holds the phone number.',
  no_columns: 'This file has no columns we can read.',
  dedupe_column_ignored:
    'A column used to find duplicates cannot be set to Ignore. Set it to Detail, or take it out of the duplicate check.',
  bad_country_code: 'Fix the country code before importing.',
};

export function mappingBlockReason(state: MappingState): MappingBlockReason | null {
  const names = Object.keys(state.roles);
  if (names.length === 0) return 'no_columns';
  if (!names.some((name) => state.roles[name] === 'phone')) return 'no_phone_column';
  // The server refuses it too (an ignored key cannot keep two loans apart at the
  // roster insert); caught here so the operator fixes it on this screen.
  if (dedupeKeys(state.dedupe).some((key) => key.kind === 'column' && state.roles[key.column] === 'ignore')) {
    return 'dedupe_column_ignored';
  }
  // Last, because it is the only one an operator has to have typed something to
  // hit — reporting it ahead of a missing phone column would name the field they
  // touched rather than the one that is actually unset.
  if (countryCodeError(state.defaultCountryCode) !== null) return 'bad_country_code';
  return null;
}

export function phoneColumn(state: MappingState): string | null {
  return Object.keys(state.roles).find((name) => state.roles[name] === 'phone') ?? null;
}

export function timezoneColumn(state: MappingState): string | null {
  return Object.keys(state.roles).find((name) => state.roles[name] === 'timezone') ?? null;
}

export function ignoredColumns(state: MappingState): string[] {
  return Object.keys(state.roles).filter((name) => state.roles[name] === 'ignore');
}

/**
 * The share of sampled rows whose value in this column normalises to E.164,
 * rendered under the phone select so the operator learns the rejection rate
 * **before** ingest rather than after.
 */
export function phoneValidityLine(
  analysis: AgencyColumnAnalysis,
  column: string | null,
): string | null {
  if (column === null) return null;
  const stat = analysis.columns.find((c) => c.name === column);
  if (!stat) return null;

  const sampled = analysis.rows_sampled;
  if (sampled === 0) return 'This file has no data rows to check.';

  // Scored over NON-EMPTY values, so an empty cell is a rejection the score
  // cannot see. Reporting valid-of-sampled rather than valid-of-non-empty keeps
  // the number honest against the file rather than against the column.
  const valid = Math.round(stat.phone_score * stat.non_empty);
  const pct = Math.round((valid / sampled) * 100);
  const suffix = analysis.truncated ? ' (of the rows we sampled)' : '';
  return `${valid.toLocaleString()} of ${sampled.toLocaleString()} rows produce a valid number — ${pct}%${suffix}. The rest will be rejected.`;
}

export interface BuildIngestOptions {
  s3Key: string;
  fileName: string;
  campaignId?: string;
  dryRun?: boolean;
}

/**
 * Build the `POST /ingest/jobs` body. Returns null when the mapping is not
 * submittable, so a caller cannot construct a request the guard would refuse.
 */
export function buildIngestRequest(
  state: MappingState,
  options: BuildIngestOptions,
): AgencyIngestRequest | null {
  if (mappingBlockReason(state) !== null) return null;

  const phone = phoneColumn(state);
  if (phone === null) return null;

  const request: AgencyIngestRequest = {
    s3_key: options.s3Key,
    file_name: options.fileName,
    phone_column: phone,
  };

  const timezone = timezoneColumn(state);
  if (timezone !== null) request.timezone_column = timezone;

  const ignored = ignoredColumns(state);
  if (ignored.length > 0) request.ignore_columns = ignored;

  // Read off the mapping state, not the options: it is the operator's choice on
  // the mapping screen, and having two ways to supply it is how one caller ends
  // up silently not supplying it — which is exactly the history of this field.
  // The key is OMITTED when empty, so an untouched control produces a request
  // byte-for-byte identical to the one before this control existed.
  if (state.defaultCountryCode) request.default_country_code = state.defaultCountryCode;
  // The same rule for the duplicate check: the phone alone sends nothing, which is
  // the request every upload made before the control existed. A combination that
  // includes the phone names its column; the server compares that part as the
  // normalised number.
  if (state.dedupe.mode === 'none') request.dedupe_phones = false;
  const keys = dedupeKeys(state.dedupe);
  if (!(keys.length === 1 && keys[0]!.kind === 'phone') && keys.length > 0) {
    request.dedupe_columns = keys.map((key) => dedupeKeyLabel(key, phone));
  }
  if (options.campaignId) request.campaign_id = options.campaignId;
  if (options.dryRun) request.dry_run = true;

  return request;
}

/**
 * The `context_display` the campaign is saved with — this is the `hero_fields`
 * config the Agent Console reads.
 *
 * Order is the operator's pick order, not file order: the console renders heroes
 * top-down and the first one is what an agent reads while the phone is ringing.
 */
export function buildContextDisplay(state: MappingState): AgencyContextDisplay {
  const display: AgencyContextDisplay = {};
  if (state.heroOrder.length > 0) display.hero = [...state.heroOrder];
  return display;
}
