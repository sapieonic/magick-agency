import type {
  AgencyColumnAnalysis,
  AgencyIngestRequest,
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
  return { roles, heroOrder: [], defaultCountryCode: '' };
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

  roles[column] = role;
  return { ...state, roles, heroOrder };
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
export type MappingBlockReason = 'no_phone_column' | 'no_columns' | 'bad_country_code';

export const MAPPING_BLOCK_COPY: Record<MappingBlockReason, string> = {
  no_phone_column: 'Pick which column holds the phone number.',
  no_columns: 'This file has no columns we can read.',
  bad_country_code: 'Fix the country code before importing.',
};

export function mappingBlockReason(state: MappingState): MappingBlockReason | null {
  const names = Object.keys(state.roles);
  if (names.length === 0) return 'no_columns';
  if (!names.some((name) => state.roles[name] === 'phone')) return 'no_phone_column';
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
  dedupePhones?: boolean;
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
  if (options.dedupePhones !== undefined) request.dedupe_phones = options.dedupePhones;
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
