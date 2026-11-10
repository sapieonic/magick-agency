import {
  AGENCY_INBOUND_ROUTE_DEFAULTS as D,
  AGENCY_INBOUND_ROUTE_LIMITS as L,
  AGENCY_INBOUND_UNCONNECTED_ACTIONS,
  AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS,
  type AgencyInboundClips,
  type AgencyInboundNumberOption,
  type AgencyInboundRoute,
  type AgencyInboundRouteConfig,
  type AgencyInboundRouteCreateRequest,
  type AgencyInboundRouteUpdateRequest,
  type AgencyInboundStickyMode,
  type AgencyInboundUnconnectedAction,
} from '../../types/inbound';
import type { AgencyDisposition } from '../../types/agency';
import { EMPTY_CAMPAIGN_CONFIG, isUsableTimezone, validateConfig } from '../agencyCampaignConfigForm';
import { ISO_WEEKDAY_SHORT } from '../format/weekdays';
import { readerZone } from '../format/date';

/**
 * The inbound route editor's form (`docs/inbound.md` §8.1): the draft the page edits, the route
 * it becomes, the console's own checks before a save, and the server's `inbound_route_invalid`
 * details mapped back onto the same fields (both keyed by the body's paths:
 * `weekly_hours[2].end`, `holidays[0].to`, `clips.greeting`).
 *
 * ── Midnight ────────────────────────────────────────────────────────────────
 * A time input cannot show `24:00`, the wire's "to midnight". An END of `00:00` in the form is
 * sent as `24:00`, and a stored `24:00` shows as `00:00`, so `09:00`–`00:00` reads as "to
 * midnight" and `00:00`–`00:00` is the whole day. Any other end earlier than its start runs
 * overnight and belongs to the day it opens on (the server's rule).
 *
 * Numbers in the form are strings (what an input holds), checked against
 * `AGENCY_INBOUND_ROUTE_LIMITS` here and again by the server.
 */

export interface HoursRow {
  day: number;
  start: string;
  end: string;
}

export interface HolidayRow {
  from: string;
  to: string;
  label: string;
}

export interface InboundRouteDraft {
  name: string;
  timezone: string;
  hours: HoursRow[];
  holidays: HolidayRow[];
  clips: AgencyInboundClips;
  stickyMode: AgencyInboundStickyMode;
  stickyWait: string;
  stickyLookback: string;
  queueMaxWait: string;
  maxWaiting: string;
  maxConcurrent: string;
  afterHoursAction: AgencyInboundUnconnectedAction;
  overflowAction: AgencyInboundUnconnectedAction;
  recordCalls: boolean;
  recordingNotice: boolean;
  profileId: string | null;
  poolCampaignIds: string[];
  /** `[]`: the built-in outcomes. */
  catalog: AgencyDisposition[];
  numberIds: string[];
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The form's end for a stored one (`24:00` → `00:00`). */
function formEnd(end: string): string {
  return end === '24:00' ? '00:00' : end;
}

/** The wire's end for the form's (`00:00` → `24:00`, "to midnight"). */
function wireEnd(end: string): string {
  return end === '00:00' ? '24:00' : end;
}

function cloneDisposition(entry: AgencyDisposition): AgencyDisposition {
  return { ...entry, ...(entry.retry ? { retry: { ...entry.retry } } : {}) };
}

/**
 * The actions the editor offers for a call nobody answers (IB3): those this build's server
 * accepts (`AGENCY_INBOUND_AVAILABLE_ACTIONS`, passed in), in the contract's order, plus the
 * route's own when it is one the server no longer offers, so a stored choice is shown rather than
 * silently replaced. Voicemail appears the moment the server's list includes it.
 */
export function offeredUnconnectedActions(
  available: readonly AgencyInboundUnconnectedAction[],
  current: readonly AgencyInboundUnconnectedAction[] = [],
): AgencyInboundUnconnectedAction[] {
  return AGENCY_INBOUND_UNCONNECTED_ACTIONS.filter((action) => available.includes(action) || current.includes(action));
}

/** Each action, said as what the caller gets. */
export const UNCONNECTED_ACTION_LABELS: Record<AgencyInboundUnconnectedAction, { label: string; hint: string }> = {
  callback: {
    label: 'Play the message and call them back',
    hint: 'The call ends after the message and appears under Missed calls for someone to call back.',
  },
  voicemail: {
    label: 'Take a voicemail',
    hint: `After the message the caller can leave a voicemail of up to ${AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS / 60} minutes, played back from Missed calls.`,
  },
};

/**
 * A new route's draft: every IB2 / §5.1 default, open Monday to Friday 09:00–17:30
 * ({@link weekdayHours}, editable: a route saved with no hours would be closed at all times), in
 * the browser's zone when it is usable (the account has no zone of its own).
 */
export function newRouteDraft(browserZone: string | undefined = readerZone() ?? undefined): InboundRouteDraft {
  return {
    name: '',
    timezone: browserZone && isUsableTimezone(browserZone) ? browserZone : 'UTC',
    hours: weekdayHours(),
    holidays: [],
    clips: { ...D.clips },
    stickyMode: D.sticky_mode,
    stickyWait: String(D.sticky_wait_seconds),
    stickyLookback: String(D.sticky_lookback_days),
    queueMaxWait: String(D.queue_max_wait_seconds),
    maxWaiting: String(D.max_waiting),
    maxConcurrent: String(D.max_concurrent),
    afterHoursAction: D.after_hours_action,
    overflowAction: D.overflow_action,
    recordCalls: D.record_calls,
    recordingNotice: D.recording_notice,
    profileId: D.analysis_profile_id,
    poolCampaignIds: [],
    catalog: [],
    numberIds: [],
  };
}

export function draftFromRoute(route: AgencyInboundRoute): InboundRouteDraft {
  return {
    name: route.name,
    timezone: route.timezone,
    hours: route.weekly_hours.map((h) => ({ day: h.day, start: h.start, end: formEnd(h.end) })),
    holidays: route.holidays.map((h) => ({ from: h.from, to: h.to, label: h.label ?? '' })),
    clips: { ...route.clips },
    stickyMode: route.sticky_mode,
    stickyWait: String(route.sticky_wait_seconds),
    stickyLookback: String(route.sticky_lookback_days),
    queueMaxWait: String(route.queue_max_wait_seconds),
    maxWaiting: String(route.max_waiting),
    maxConcurrent: String(route.max_concurrent),
    afterHoursAction: route.after_hours_action,
    overflowAction: route.overflow_action,
    recordCalls: route.record_calls,
    recordingNotice: route.recording_notice,
    profileId: route.analysis_profile_id,
    poolCampaignIds: [...route.pool_campaign_ids],
    catalog: route.disposition_catalog.map(cloneDisposition),
    numberIds: route.numbers.map((n) => n.phone_number_id),
  };
}

/** The whole configuration the draft describes (numbers aside). */
export function configFromDraft(draft: InboundRouteDraft): AgencyInboundRouteConfig {
  return {
    name: draft.name.trim(),
    timezone: draft.timezone.trim(),
    weekly_hours: draft.hours.map((h) => ({ day: h.day, start: h.start, end: wireEnd(h.end) })),
    holidays: draft.holidays.map((h) => ({ from: h.from, to: h.to, label: h.label.trim() || null })),
    clips: { ...draft.clips },
    sticky_mode: draft.stickyMode,
    sticky_wait_seconds: Number(draft.stickyWait),
    sticky_lookback_days: Number(draft.stickyLookback),
    pool_campaign_ids: [...draft.poolCampaignIds],
    queue_max_wait_seconds: Number(draft.queueMaxWait),
    max_waiting: Number(draft.maxWaiting),
    max_concurrent: Number(draft.maxConcurrent),
    after_hours_action: draft.afterHoursAction,
    overflow_action: draft.overflowAction,
    record_calls: draft.recordCalls,
    recording_notice: draft.recordingNotice,
    analysis_profile_id: draft.profileId,
    disposition_catalog: draft.catalog,
  };
}

export function createRequestFromDraft(draft: InboundRouteDraft): AgencyInboundRouteCreateRequest {
  return { ...configFromDraft(draft), phone_number_ids: [...draft.numberIds] };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * The PATCH a save sends: only the fields that differ from the saved route (`clips` per slot),
 * and `phone_number_ids` only when the set changed. `{}` when nothing did.
 */
export function patchFromDraft(saved: AgencyInboundRoute, draft: InboundRouteDraft): AgencyInboundRouteUpdateRequest {
  const next = configFromDraft(draft);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof AgencyInboundRouteConfig>) {
    if (key === 'clips') continue;
    if (JSON.stringify(next[key]) !== JSON.stringify(saved[key])) patch[key] = next[key];
  }
  const clips: Partial<AgencyInboundClips> = {};
  for (const slot of Object.keys(next.clips) as Array<keyof AgencyInboundClips>) {
    if (next.clips[slot] !== saved.clips[slot]) clips[slot] = next.clips[slot];
  }
  if (Object.keys(clips).length > 0) patch['clips'] = clips;
  const savedNumbers = saved.numbers.map((n) => n.phone_number_id);
  if (!sameSet(savedNumbers, draft.numberIds)) patch['phone_number_ids'] = [...draft.numberIds];
  return patch as AgencyInboundRouteUpdateRequest;
}

export function draftChanged(saved: AgencyInboundRoute | null, draft: InboundRouteDraft): boolean {
  if (!saved) return true;
  return Object.keys(patchFromDraft(saved, draft)).length > 0;
}

function intIssue(raw: string, min: number, max: number, what: string): string | null {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n)) return `${what} must be a whole number.`;
  if (n < min || n > max) return `${what} must be between ${min} and ${max}.`;
  return null;
}

/** What the console can tell before a save, keyed by body path. Empty: nothing found. */
export function validateRouteDraft(draft: InboundRouteDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (!name) errors['name'] = 'Give the route a name.';
  else if (name.length > L.NAME_MAX) errors['name'] = `Keep the name to ${L.NAME_MAX} characters.`;
  const zone = draft.timezone.trim();
  if (!zone || !isUsableTimezone(zone) || !(zone === 'UTC' || zone.includes('/'))) {
    errors['timezone'] = 'Choose a time zone such as Europe/London (not an abbreviation such as GMT).';
  }
  if (draft.hours.length > L.WEEKLY_HOURS_MAX) errors['weekly_hours'] = `At most ${L.WEEKLY_HOURS_MAX} stretches of hours.`;
  draft.hours.forEach((h, i) => {
    if (!TIME.test(h.start)) errors[`weekly_hours[${i}].start`] = 'Enter an opening time.';
    if (!TIME.test(h.end)) errors[`weekly_hours[${i}].end`] = 'Enter a closing time.';
    else if (h.start === h.end && h.start !== '00:00') {
      errors[`weekly_hours[${i}].end`] = 'Opening and closing at the same time would never be open.';
    }
  });
  if (draft.holidays.length > L.HOLIDAYS_MAX) errors['holidays'] = `At most ${L.HOLIDAYS_MAX} holidays.`;
  draft.holidays.forEach((h, i) => {
    if (!DATE.test(h.from)) errors[`holidays[${i}].from`] = 'Choose the first day.';
    if (!DATE.test(h.to)) errors[`holidays[${i}].to`] = 'Choose the last day.';
    else if (DATE.test(h.from) && h.to < h.from) errors[`holidays[${i}].to`] = 'The last day must be on or after the first.';
    else if (DATE.test(h.from) && spanDays(h.from, h.to) > L.HOLIDAY_SPAN_DAYS_MAX) {
      errors[`holidays[${i}].to`] = `A holiday spans at most ${L.HOLIDAY_SPAN_DAYS_MAX} days; add another for a longer closure.`;
    }
    if (h.label.trim().length > L.HOLIDAY_LABEL_MAX) errors[`holidays[${i}].label`] = `Keep the label to ${L.HOLIDAY_LABEL_MAX} characters.`;
  });
  const ints: Array<[string, string, { min: number; max: number }, string]> = [
    ['sticky_wait_seconds', draft.stickyWait, L.STICKY_WAIT_SECONDS, 'The wait for their agent'],
    ['sticky_lookback_days', draft.stickyLookback, L.STICKY_LOOKBACK_DAYS, 'How far back to look'],
    ['queue_max_wait_seconds', draft.queueMaxWait, L.QUEUE_MAX_WAIT_SECONDS, 'The longest wait'],
    ['max_waiting', draft.maxWaiting, L.MAX_WAITING, 'Callers waiting at once'],
    ['max_concurrent', draft.maxConcurrent, L.MAX_CONCURRENT, 'Calls at once'],
  ];
  for (const [path, raw, bounds, what] of ints) {
    const issue = intIssue(raw, bounds.min, bounds.max, what);
    if (issue) errors[path] = issue;
  }
  if (!errors['sticky_wait_seconds'] && !errors['queue_max_wait_seconds'] && Number(draft.stickyWait) > Number(draft.queueMaxWait)) {
    errors['sticky_wait_seconds'] = 'The wait for their agent cannot be longer than the longest wait.';
  }
  if (!errors['max_waiting'] && !errors['max_concurrent'] && Number(draft.maxWaiting) > Number(draft.maxConcurrent)) {
    errors['max_waiting'] = 'Callers waiting count towards calls at once, so this cannot be more than that.';
  }
  if (draft.poolCampaignIds.length > L.POOL_CAMPAIGNS_MAX) errors['pool_campaign_ids'] = `At most ${L.POOL_CAMPAIGNS_MAX} campaigns.`;
  if (draft.numberIds.length > L.NUMBERS_MAX) errors['phone_number_ids'] = `At most ${L.NUMBERS_MAX} numbers on one route.`;
  if (draft.catalog.length > 0) {
    for (const [path, message] of Object.entries(validateConfig({ ...EMPTY_CAMPAIGN_CONFIG, dispositions: draft.catalog }))) {
      if (path.startsWith('disposition_catalog')) errors[path] = message;
    }
  }
  return errors;
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The server's `inbound_route_invalid` details, as field errors. */
export function routeErrorsFromDetails(details: ReadonlyArray<{ path: string; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of details) out[d.path || 'form'] = d.message;
  return out;
}

// ─── Hours, in words ────────────────────────────────────────────────────────

/** `true` when the stretch runs past midnight into the next day (not one that ends at midnight). */
export function isOvernight(row: HoursRow): boolean {
  return row.end !== '00:00' && row.end < row.start;
}

/** One stretch in words: `Mon 09:00–17:30`, `Fri 22:00–02:00 (next day)`, `Sat 00:00–midnight`. */
export function hoursRowLabel(row: { day: number; start: string; end: string }): string {
  const day = ISO_WEEKDAY_SHORT[row.day - 1] ?? `Day ${row.day}`;
  const end = row.end === '00:00' || row.end === '24:00' ? 'midnight' : row.end;
  const overnight = isOvernight({ ...row, end: formEnd(row.end) });
  return `${day} ${row.start}–${end}${overnight ? ' (next day)' : ''}`;
}

/** The route list's line for a route's hours. */
export function weeklyHoursSummary(route: Pick<AgencyInboundRouteConfig, 'weekly_hours'>): string {
  if (route.weekly_hours.length === 0) return 'No opening hours: closed at all times';
  return [...route.weekly_hours].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)).map(hoursRowLabel).join(', ');
}

/** The opening and closing time of {@link weekdayHours}. */
export const WEEKDAY_OPENS = '09:00';
export const WEEKDAY_CLOSES = '17:30';

/** Monday to Friday, 09:00–17:30: a new route's hours, and the editor's quick start. */
export function weekdayHours(): HoursRow[] {
  return [1, 2, 3, 4, 5].map((day) => ({ day, start: WEEKDAY_OPENS, end: WEEKDAY_CLOSES }));
}

// ─── Numbers ────────────────────────────────────────────────────────────────

/** Whether a number can be put on the route being edited (`routeId`, null for a new one), and why not. */
export function numberAvailability(
  option: AgencyInboundNumberOption,
  routeId: string | null,
): { available: true } | { available: false; reason: string } {
  if (!option.linked) {
    return { available: false, reason: 'Not linked to inbound calls yet. Contact support to have it linked.' };
  }
  if (option.held_elsewhere) return { available: false, reason: 'Answers another account’s inbound calls.' };
  if (option.route_id && option.route_id !== routeId) {
    return { available: false, reason: `Already answers ${option.route_name ? `“${option.route_name}”` : 'another route'}.` };
  }
  return { available: true };
}
