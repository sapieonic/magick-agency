import type { AgencyAttemptFilters, AgencyListFlag } from '../types/agency-spine';
import { attemptOutcomeLabel, attemptStateLabel } from '../types/agency-spine';
import { formatSpineTimestamp } from './agencySpineCopy';

/**
 * The campaign Call attempts tab's filters, in the URL — the attempts twin of
 * `agencyRosterFilters.ts`, for the same reasons: a narrowed list survives a refresh, can be
 * sent to a colleague, answers the back button, and, since the Insights tab opens it with a
 * filter already applied (`utils/agency/insights/links.ts`), the number that was clicked and
 * the list it opened are one URL apart.
 *
 * A LEAF: pure functions over `URLSearchParams` and the wire filter type, no React.
 *
 * ── Reading is an allow-list ────────────────────────────────────────────────
 * An unrecognised key is ignored, and a flag that is not `1` or `0` is dropped, so a stale
 * or hand-edited link degrades to the filters this build knows rather than forwarding a
 * value the server would refuse with a 400 and failing the whole page.
 *
 * ── Two date ranges, and they are not the same range ────────────────────────
 * `from` / `to` are the page's own date pickers: INCLUSIVE, on when the attempt was
 * CREATED, so an attempt that never dialled still lists on the day it was queued
 * (`agencyAttemptFilters.ts` carries the argument). `dialed_from` / `dialed_to` come only from
 * an Insights link: HALF-OPEN `[from, to)` on when the dial was PLACED, placed dials only,
 * which is how every insights range count is cut. Both can be in the URL at once and they
 * AND together; each has its own chip, worded so the two are not mistaken for each other.
 */

/** Repeated params, in the order the query string is written. */
const LIST_KEYS = ['outcome', 'state', 'disposition_code'] as const;
/** Single-valued params. */
const SCALAR_KEYS = [
  'contact_id', 'agent_user_id', 'caller_id', 'phone', 'from', 'to', 'dialed_from', 'dialed_to',
] as const;
/** `1` / `0` flags. */
const FLAG_KEYS = ['redial', 'agent_manual', 'agent_reopened', 'override_applied', 'placed'] as const;

type ListKey = (typeof LIST_KEYS)[number];
type ScalarKey = (typeof SCALAR_KEYS)[number];
type FlagKey = (typeof FLAG_KEYS)[number];

/**
 * Every key of `AgencyAttemptFilters` is in exactly one list above: a key added to the wire
 * type and forgotten here is a type error, not a filter that never reaches the URL.
 */
type Unlisted = Exclude<keyof AgencyAttemptFilters, ListKey | ScalarKey | FlagKey>;
const _everyKeyListed: Unlisted extends never ? true : Unlisted = true;
void _everyKeyListed;

function isFlag(value: string | null): value is AgencyListFlag {
  return value === '1' || value === '0';
}

/** URL → filters. Blank values are dropped (what a cleared control writes). */
export function campaignAttemptFiltersFromParams(params: URLSearchParams): AgencyAttemptFilters {
  const filters: AgencyAttemptFilters = {};
  for (const key of LIST_KEYS) {
    const values = params.getAll(key).map((v) => v.trim()).filter((v) => v !== '');
    if (values.length > 0) filters[key] = values;
  }
  for (const key of SCALAR_KEYS) {
    const value = params.get(key)?.trim();
    if (value) filters[key] = value;
  }
  for (const key of FLAG_KEYS) {
    const value = params.get(key);
    if (isFlag(value)) filters[key] = value;
  }
  return filters;
}

/** Filters → URL, as a FRESH set: a filter that was cleared must leave the query string. */
export function campaignAttemptFiltersToParams(filters: AgencyAttemptFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of LIST_KEYS) for (const value of filters[key] ?? []) params.append(key, value);
  for (const key of SCALAR_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  for (const key of FLAG_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return params;
}

/** Whether anything narrows the list (so an empty result is about the filter, not the campaign). */
export function isCampaignAttemptFiltered(filters: AgencyAttemptFilters): boolean {
  return campaignAttemptFiltersToParams(filters).toString() !== '';
}

/** One removable chip: what it says, and the filters left when it is removed. */
export interface AppliedFilterChip {
  /** Stable, for React keys and test ids. */
  id: string;
  label: string;
  without: AgencyAttemptFilters;
}

/** How a flag reads, set and unset. Wording matches the Insights tab's numbers. */
const FLAG_COPY: Record<FlagKey, { on: string; off: string }> = {
  redial: { on: 'Wrap-up redials', off: 'Not wrap-up redials' },
  agent_manual: { on: 'Dialled by hand', off: 'Not dialled by hand' },
  agent_reopened: { on: 'Dials after a reopen', off: 'Not after a reopen' },
  override_applied: { on: 'Dials that used an override', off: 'No override used' },
  placed: { on: 'Dials placed', off: 'Never dialled' },
};

function omit(filters: AgencyAttemptFilters, ...keys: Array<keyof AgencyAttemptFilters>): AgencyAttemptFilters {
  const next = { ...filters };
  for (const key of keys) delete next[key];
  return next;
}

function withoutValue(filters: AgencyAttemptFilters, key: ListKey, value: string): AgencyAttemptFilters {
  const rest = (filters[key] ?? []).filter((v) => v !== value);
  const next = omit(filters, key);
  if (rest.length > 0) next[key] = rest;
  return next;
}

/** A date picker's instant as the day it was picked on, in the viewer's zone. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export interface AttemptChipContext {
  /** The write-up code's label from the campaign's catalog, when it has one. */
  dispositionLabel?: (code: string) => string | null;
  /** The agent's name, when a loaded row carries it. */
  agentName?: (userId: string) => string | null;
}

/**
 * The applied filters as removable chips, in a fixed order. A list filter gives one chip per
 * value; a date range gives one chip for both ends (one range, two inputs).
 */
export function campaignAttemptFilterChips(
  filters: AgencyAttemptFilters,
  context: AttemptChipContext = {},
): AppliedFilterChip[] {
  const chips: AppliedFilterChip[] = [];
  if (filters.contact_id) {
    chips.push({ id: 'contact_id', label: 'One contact', without: omit(filters, 'contact_id') });
  }
  for (const value of filters.outcome ?? []) {
    chips.push({ id: `outcome:${value}`, label: `Outcome: ${attemptOutcomeLabel(value)}`, without: withoutValue(filters, 'outcome', value) });
  }
  for (const value of filters.state ?? []) {
    chips.push({ id: `state:${value}`, label: `State: ${attemptStateLabel(value)}`, without: withoutValue(filters, 'state', value) });
  }
  for (const value of filters.disposition_code ?? []) {
    const label = context.dispositionLabel?.(value) ?? value;
    chips.push({ id: `disposition_code:${value}`, label: `Written up as: ${label}`, without: withoutValue(filters, 'disposition_code', value) });
  }
  if (filters.agent_user_id) {
    const name = context.agentName?.(filters.agent_user_id) ?? filters.agent_user_id;
    chips.push({ id: 'agent_user_id', label: `Agent: ${name}`, without: omit(filters, 'agent_user_id') });
  }
  if (filters.caller_id) {
    chips.push({ id: 'caller_id', label: `Caller ID: ${filters.caller_id}`, without: omit(filters, 'caller_id') });
  }
  if (filters.phone) {
    chips.push({ id: 'phone', label: `Phone: ${filters.phone}`, without: omit(filters, 'phone') });
  }
  for (const key of FLAG_KEYS) {
    const value = filters[key];
    if (value) chips.push({ id: key, label: value === '1' ? FLAG_COPY[key].on : FLAG_COPY[key].off, without: omit(filters, key) });
  }
  if (filters.dialed_from || filters.dialed_to) {
    const from = filters.dialed_from ? formatSpineTimestamp(filters.dialed_from) : null;
    const to = filters.dialed_to ? formatSpineTimestamp(filters.dialed_to) : null;
    const label = from && to
      ? `Dialled from ${from}, up to ${to}`
      : from ? `Dialled from ${from}` : `Dialled before ${to}`;
    chips.push({ id: 'dialed', label, without: omit(filters, 'dialed_from', 'dialed_to') });
  }
  if (filters.from || filters.to) {
    const from = filters.from ? dayLabel(filters.from) : null;
    const to = filters.to ? dayLabel(filters.to) : null;
    const label = from && to
      ? `Created ${from} to ${to}`
      : from ? `Created on or after ${from}` : `Created on or before ${to}`;
    chips.push({ id: 'created', label, without: omit(filters, 'from', 'to') });
  }
  return chips;
}

/** One choice in the call log's Agent filter: the id is sent, the name is shown. */
export interface AttemptAgentOption {
  id: string;
  name: string;
}

/**
 * The call log's Agent filter choices: the campaign's assigned agents, plus anyone named on
 * the rows on screen (an agent since moved off the campaign still has calls here), by name.
 *
 * The filter used to be a text box for an internal user id a supervisor never sees, so a
 * name typed into it was refused by the server. The id is still what is sent; this is what
 * lets it be picked by name. An applied id that neither list knows (an old or hand-edited
 * link) is kept as a choice under its own value, so the control still shows what the URL
 * applies rather than silently reading "All agents".
 */
export function campaignAttemptAgentOptions(
  assigned: ReadonlyArray<{ user_id: string; name: string | null; email: string | null }>,
  rows: ReadonlyArray<{ agent_user_id: string | null; agent_name?: string | null }>,
  appliedId?: string,
): AttemptAgentOption[] {
  const byId = new Map<string, string>();
  for (const agent of assigned) {
    const name = agent.name || agent.email;
    if (name) byId.set(agent.user_id, name);
  }
  for (const row of rows) {
    if (row.agent_user_id && row.agent_name && !byId.has(row.agent_user_id)) {
      byId.set(row.agent_user_id, row.agent_name);
    }
  }
  const options = [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (appliedId && !byId.has(appliedId)) options.push({ id: appliedId, name: appliedId });
  return options;
}

/** Plain copy for each filter the server can refuse, by its query parameter. */
const FILTER_REFUSAL_COPY: Record<string, string> = {
  phone: 'The phone number filter needs at least one digit.',
  agent_user_id: 'The agent filter does not match an agent. Pick one from the list.',
  from: 'The date filter is not a date this list can use.',
  to: 'The date filter is not a date this list can use.',
  dialed_from: 'The dialled date filter is not a date this list can use.',
  dialed_to: 'The dialled date filter is not a date this list can use.',
  contact_id: 'This link points at a contact that does not exist.',
};

/**
 * What to say when the server refuses the call log's filters (a `400 Validation failed`
 * naming the parameters), or `null` for any other failure.
 *
 * The page used to print the server's own lowercase fragment ("must be an agent id") with
 * a Retry button. Retrying sends the same filters and gets the same refusal, so this copy
 * says which filter to change instead, and the page offers no Retry for it. A filter the
 * form catches itself (a phone with no digits) never gets here from the form; this is for
 * a link that carries one.
 */
export function campaignAttemptFilterRefusal(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  if ((err as { statusCode?: unknown }).statusCode !== 400) return null;
  const body = (err as { details?: unknown }).details;
  const issues = body && typeof body === 'object' ? (body as { details?: unknown }).details : null;
  if (!Array.isArray(issues)) return null;
  const params = issues
    .map((issue) => (issue && typeof issue === 'object' ? (issue as { param?: unknown }).param : null))
    .filter((param): param is string => typeof param === 'string');
  if (params.length === 0) return null;
  const sentences = [...new Set(params.map((p) => FILTER_REFUSAL_COPY[p] ?? 'One of the filters cannot be used.'))];
  return `${sentences.join(' ')} Change or remove it above to see the call log.`;
}

/** Whether a typed phone filter can match anything: it needs a digit (the server's rule). */
export function phoneFilterUsable(value: string): boolean {
  return value.trim() === '' || /\d/.test(value);
}
