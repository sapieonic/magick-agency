/**
 * The inbound route body (`docs/inbound.md` §8.1): what `POST /inbound/routes` and
 * `PATCH /inbound/routes/:id` accept, as zod schemas, and the full configuration they resolve to.
 * Pure: the account-scoped checks (clip ids naming the account's audio files, the analysis
 * profile and the pool campaigns being the account's, numbers the account may route) need the
 * database and are the API layer's, after this.
 *
 * ── One rule with the database and the schedule ─────────────────────────────
 *  - Every bound is `AGENCY_INBOUND_ROUTE_LIMITS`, which `0024_inbound.sql`'s CHECKs hold too, so a
 *    body this accepts is never refused by the table (`inbound-route-repository.test.ts` writes
 *    the extremes through the repository).
 *  - Times, dates and the zone are judged by the functions the schedule evaluates with
 *    (`@magick-agency/domain/inbound-schedule`, `zone-clock`), so a stored schedule is never
 *    `unresolvable`.
 *  - The outcome catalog is held to the campaign catalog's rules (`validateAgencyCampaignConfig`,
 *    without overrides: a caller matched to no campaign has no contact to carry a grant), as the
 *    soft phone's catalog is.
 *
 * ── A PATCH is validated as the route it makes ─────────────────────────────
 * Two rules cross fields (`sticky_wait_seconds ≤ queue_max_wait_seconds`, `max_waiting ≤
 * max_concurrent`), so a patch is merged onto the stored route first and the merged route is
 * judged ({@link parseInboundRouteUpdate}): lowering `max_concurrent` below the stored
 * `max_waiting` is refused here, not by the CHECK.
 *
 * Refusals are `{ path, message }` per problem (`inbound_route_invalid`'s `details`), paths in
 * the body's own terms (`weekly_hours[2].end`, `clips.greeting`, `disposition_catalog[0].code`).
 */
import { z } from 'zod';
import {
  AGENCY_INBOUND_CLIP_SLOTS,
  AGENCY_INBOUND_ROUTE_DEFAULTS,
  AGENCY_INBOUND_ROUTE_LIMITS as L,
  AGENCY_INBOUND_STICKY_MODES,
  AGENCY_INBOUND_UNCONNECTED_ACTIONS,
  type AgencyDisposition,
  type AgencyInboundClipSlot,
  type AgencyInboundRouteConfig,
} from '@magick-agency/contracts/agency';
import {
  inboundHolidaySpanDays,
  isInboundCalendarDate,
  parseInboundClock,
} from '@magick-agency/domain/inbound-schedule';
import { isUsableTimezone } from '@magick-agency/domain/zone-clock';
import { validateAgencyCampaignConfig } from '../campaign-config.js';

/** One problem with a route body. */
export interface InboundRouteIssue {
  path: string;
  message: string;
}

const uuid = z.string().uuid('Expected an id.');
const int = (min: number, max: number, what: string) =>
  z.number({ invalid_type_error: `${what} must be a number.` })
    .int(`${what} must be a whole number.`)
    .min(min, `${what} must be between ${min} and ${max}.`)
    .max(max, `${what} must be between ${min} and ${max}.`);

const hoursInterval = z.object({
  day: z.number().int().min(1, 'day must be 1 (Monday) to 7 (Sunday).').max(7, 'day must be 1 (Monday) to 7 (Sunday).'),
  start: z.string().refine((v) => { const s = parseInboundClock(v); return s !== null && s < 86_400; }, 'start must be a time from 00:00 to 23:59.'),
  end: z.string().refine((v) => parseInboundClock(v) !== null, 'end must be a time from 00:01 to 24:00.'),
}).strict().superRefine((v, ctx) => {
  // Dirty-safe: the field refinements above may have failed on this same object.
  const start = parseInboundClock(v.start);
  const end = parseInboundClock(v.end);
  if (start !== null && end !== null && start === end) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end'], message: 'end must differ from start (an empty stretch is never open).' });
  }
});

const holiday = z.object({
  from: z.string().refine(isInboundCalendarDate, 'from must be a date written YYYY-MM-DD.'),
  to: z.string().refine(isInboundCalendarDate, 'to must be a date written YYYY-MM-DD.'),
  label: z.string().trim().max(L.HOLIDAY_LABEL_MAX, `label must be at most ${L.HOLIDAY_LABEL_MAX} characters.`)
    .transform((v) => (v === '' ? null : v)).nullable().default(null),
}).strict().superRefine((v, ctx) => {
  if (!isInboundCalendarDate(v.from) || !isInboundCalendarDate(v.to)) return;
  if (v.to < v.from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to must be on or after from.' });
  } else if (inboundHolidaySpanDays(v.from, v.to) > L.HOLIDAY_SPAN_DAYS_MAX) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `A holiday spans at most ${L.HOLIDAY_SPAN_DAYS_MAX} days; add another for a longer closure.` });
  }
});

const clips = z.object(
  Object.fromEntries(AGENCY_INBOUND_CLIP_SLOTS.map((slot) => [slot, uuid.nullable().optional()])) as
    Record<AgencyInboundClipSlot, z.ZodOptional<z.ZodNullable<z.ZodString>>>,
).strict();

/** Every config field, each optional: the shape a PATCH carries and a create fills with defaults. */
const configFields = {
  name: z.string().trim().min(1, 'name is required.').max(L.NAME_MAX, `name must be at most ${L.NAME_MAX} characters.`),
  timezone: z.string().trim().refine(isUsableTimezone, 'timezone must be an IANA zone such as Europe/London (not an abbreviation such as GMT or EST).'),
  weekly_hours: z.array(hoursInterval).max(L.WEEKLY_HOURS_MAX, `At most ${L.WEEKLY_HOURS_MAX} stretches of hours.`),
  holidays: z.array(holiday).max(L.HOLIDAYS_MAX, `At most ${L.HOLIDAYS_MAX} holidays.`),
  clips,
  sticky_mode: z.enum(AGENCY_INBOUND_STICKY_MODES),
  sticky_wait_seconds: int(L.STICKY_WAIT_SECONDS.min, L.STICKY_WAIT_SECONDS.max, 'sticky_wait_seconds'),
  sticky_lookback_days: int(L.STICKY_LOOKBACK_DAYS.min, L.STICKY_LOOKBACK_DAYS.max, 'sticky_lookback_days'),
  pool_campaign_ids: z.array(uuid).max(L.POOL_CAMPAIGNS_MAX, `At most ${L.POOL_CAMPAIGNS_MAX} campaigns.`)
    .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
  queue_max_wait_seconds: int(L.QUEUE_MAX_WAIT_SECONDS.min, L.QUEUE_MAX_WAIT_SECONDS.max, 'queue_max_wait_seconds'),
  max_waiting: int(L.MAX_WAITING.min, L.MAX_WAITING.max, 'max_waiting'),
  max_concurrent: int(L.MAX_CONCURRENT.min, L.MAX_CONCURRENT.max, 'max_concurrent'),
  after_hours_action: z.enum(AGENCY_INBOUND_UNCONNECTED_ACTIONS),
  overflow_action: z.enum(AGENCY_INBOUND_UNCONNECTED_ACTIONS),
  record_calls: z.boolean(),
  recording_notice: z.boolean(),
  analysis_profile_id: uuid.nullable(),
  // Held to the campaign catalog's rules below (`catalogIssues`); here only "an array".
  disposition_catalog: z.array(z.unknown()),
  // IQ52: every inbound call on the route takes this window, with auto-return.
  wrapup_seconds: int(L.WRAPUP_SECONDS.min, L.WRAPUP_SECONDS.max, 'wrapup_seconds'),
};

const phoneNumberIds = z.array(uuid).max(L.NUMBERS_MAX, `At most ${L.NUMBERS_MAX} numbers on one route.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]);

/** `POST /inbound/routes`: `name` and `timezone` required, every other field optional. */
export const inboundRouteCreateSchema = z.object({
  ...Object.fromEntries(Object.entries(configFields).map(([k, v]) => [k, k === 'name' || k === 'timezone' ? v : v.optional()])) as {
    [K in keyof typeof configFields]: K extends 'name' | 'timezone' ? (typeof configFields)[K] : z.ZodOptional<(typeof configFields)[K]>;
  },
  phone_number_ids: phoneNumberIds.optional(),
}).strict();

/** `PATCH /inbound/routes/:id`: every field optional. */
export const inboundRouteUpdateSchema = z.object({
  ...Object.fromEntries(Object.entries(configFields).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof configFields]: z.ZodOptional<(typeof configFields)[K]>;
  },
  phone_number_ids: phoneNumberIds.optional(),
}).strict();

type CreateBody = z.infer<typeof inboundRouteCreateSchema>;

/** A zod path in the body's terms: `weekly_hours[2].end`. */
function pathOf(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : part), '');
}

function zodIssues(error: z.ZodError): InboundRouteIssue[] {
  return error.issues.map((i) => ({
    path: pathOf(i.path),
    message: i.code === z.ZodIssueCode.unrecognized_keys ? `Unknown field${i.keys.length > 1 ? 's' : ''}: ${i.keys.join(', ')}.` : i.message,
  }));
}

/** The campaign catalog's rules, without overrides, under `disposition_catalog`. */
function catalogIssues(catalog: unknown[]): InboundRouteIssue[] {
  return validateAgencyCampaignConfig({ disposition_catalog: catalog }, {}, { allowDispositionOverride: false })
    .map((issue) => ({ path: issue.field, message: issue.message }));
}

/** The two cross-field rules, on a whole config. */
function crossFieldIssues(config: AgencyInboundRouteConfig): InboundRouteIssue[] {
  const issues: InboundRouteIssue[] = [];
  if (config.sticky_wait_seconds > config.queue_max_wait_seconds) {
    issues.push({ path: 'sticky_wait_seconds', message: 'sticky_wait_seconds cannot be longer than queue_max_wait_seconds.' });
  }
  if (config.max_waiting > config.max_concurrent) {
    issues.push({ path: 'max_waiting', message: 'max_waiting cannot be more than max_concurrent (waiting callers count towards it).' });
  }
  return issues;
}

/** A route's stored config, in the request's shape (`AgencyInboundRoute` minus its ids, numbers and times). */
export type InboundRouteParse =
  | { ok: true; config: AgencyInboundRouteConfig; phoneNumberIds: string[] | undefined }
  | { ok: false; issues: InboundRouteIssue[] };

/**
 * A create body, with every field it leaves out taken from `AGENCY_INBOUND_ROUTE_DEFAULTS`
 * (clips per slot), and the numbers to attach (`undefined`: none named).
 */
export function parseInboundRouteCreate(body: unknown): InboundRouteParse {
  const parsed = inboundRouteCreateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const b: CreateBody = parsed.data;
  const d = AGENCY_INBOUND_ROUTE_DEFAULTS;
  const config: AgencyInboundRouteConfig = {
    name: b.name,
    timezone: b.timezone,
    weekly_hours: b.weekly_hours ?? [...d.weekly_hours],
    holidays: b.holidays ?? [...d.holidays],
    clips: { ...d.clips, ...stripUndefined(b.clips ?? {}) },
    sticky_mode: b.sticky_mode ?? d.sticky_mode,
    sticky_wait_seconds: b.sticky_wait_seconds ?? d.sticky_wait_seconds,
    sticky_lookback_days: b.sticky_lookback_days ?? d.sticky_lookback_days,
    pool_campaign_ids: b.pool_campaign_ids ?? [...d.pool_campaign_ids],
    queue_max_wait_seconds: b.queue_max_wait_seconds ?? d.queue_max_wait_seconds,
    max_waiting: b.max_waiting ?? d.max_waiting,
    max_concurrent: b.max_concurrent ?? d.max_concurrent,
    after_hours_action: b.after_hours_action ?? d.after_hours_action,
    overflow_action: b.overflow_action ?? d.overflow_action,
    record_calls: b.record_calls ?? d.record_calls,
    recording_notice: b.recording_notice ?? d.recording_notice,
    analysis_profile_id: b.analysis_profile_id ?? d.analysis_profile_id,
    disposition_catalog: (b.disposition_catalog ?? [...d.disposition_catalog]) as AgencyDisposition[],
    wrapup_seconds: b.wrapup_seconds ?? d.wrapup_seconds,
  };
  const issues = [...catalogIssues(config.disposition_catalog), ...crossFieldIssues(config)];
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config, phoneNumberIds: b.phone_number_ids };
}

/** The fields of a PATCH, each replacing the stored one (`clips` per slot). */
export type InboundRoutePatch = Partial<Omit<AgencyInboundRouteConfig, 'clips'>> & {
  clips?: Partial<AgencyInboundRouteConfig['clips']>;
};

/** A PATCH: the patch as given (what to write and audit), and the route it makes, judged whole. */
export type InboundRoutePatchParse =
  | {
      ok: true;
      /** The fields present, normalised: `AgencyInboundRouteRepository.update`'s patch. */
      patch: InboundRoutePatch;
      /** The stored route with the patch applied. */
      config: AgencyInboundRouteConfig;
      /** The fields whose value changes (the audit's `details.fields`), sorted. */
      changed: Array<keyof AgencyInboundRouteConfig>;
      phoneNumberIds: string[] | undefined;
    }
  | { ok: false; issues: InboundRouteIssue[] };

/** A PATCH body against the stored route `current` (see the module note: judged as the route it makes). */
export function parseInboundRouteUpdate(body: unknown, current: AgencyInboundRouteConfig): InboundRoutePatchParse {
  const parsed = inboundRouteUpdateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const { phone_number_ids, ...patch } = parsed.data;
  const clipsPatch = patch.clips ? stripUndefined(patch.clips) : undefined;
  const config: AgencyInboundRouteConfig = {
    ...current,
    ...(stripUndefined(patch) as Partial<AgencyInboundRouteConfig>),
    clips: { ...current.clips, ...(clipsPatch ?? {}) },
  };
  const issues = [
    ...(patch.disposition_catalog !== undefined ? catalogIssues(patch.disposition_catalog) : []),
    ...crossFieldIssues(config),
  ];
  if (issues.length > 0) return { ok: false, issues };
  const changed = (Object.keys(config) as Array<keyof AgencyInboundRouteConfig>)
    .filter((k) => JSON.stringify(config[k]) !== JSON.stringify(current[k]))
    .sort();
  return {
    ok: true,
    patch: { ...stripUndefined(patch), ...(clipsPatch ? { clips: clipsPatch } : {}) } as InboundRoutePatch,
    config,
    changed,
    phoneNumberIds: phone_number_ids,
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
