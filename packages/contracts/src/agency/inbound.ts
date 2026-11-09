/**
 * Inbound calls on Plivo numbers (`docs/inbound.md`, decisions IB1–IB8): the vocabularies of
 * the inbound spine (`agency_inbound_calls`, `0024_inbound.sql`), an inbound route's configuration
 * and its defaults and limits. Types and `as const` lists only, like the rest of this barrel.
 *
 * The console's wire shapes (route DTOs, the Missed inbound list) are in
 * `../api/agency/inbound.ts`; the super-admin's (a credential's inbound status, a number's link)
 * in `../api/platform/super-admin-inbound.ts`.
 *
 * Every list here is held equal to the CHECK that stores it by
 * `packages/db/test/integration/db/inbound-migration.test.ts`, so a member added on one side
 * only fails a test rather than a write in production.
 */

import type { AllListed } from '../primitives';
import type { AgencyDisposition } from './session';

// ─── The spine ──────────────────────────────────────────────────────────────

/**
 * Where an inbound call is (`agency_inbound_calls.state`): `arrived` (the answer webhook wrote
 * it) → `greeting` (our stream plays the greeting and the recording notice) → `queued` (waiting
 * for an agent) → `offered` (an agent is being connected; back to `queued` when the station is
 * lost before audio binds, §5.1) → `connected` (bridged) → `ended`. P1 connects nobody, so its
 * calls go `arrived` → `greeting` → `ended`. `ended` is terminal: no write moves it again.
 */
export const AGENCY_INBOUND_CALL_STATES = [
  'arrived', 'greeting', 'queued', 'offered', 'connected', 'ended',
] as const;
export type AgencyInboundCallState = (typeof AGENCY_INBOUND_CALL_STATES)[number];

/**
 * How an inbound call ended (`agency_inbound_calls.outcome`, set exactly when `ended`):
 *
 *  - `answered`: an agent was bridged (`bridged_at`, `answered_by_user_id`);
 *  - `abandoned_in_queue`: the caller hung up while waiting, or the call was left non-terminal
 *    by a restart and swept (§10);
 *  - `overflow`: waited the route's `queue_max_wait_seconds`, or over its `max_waiting`;
 *  - `overflow_no_capacity`: over the route's `max_concurrent`, or the global / provider
 *    concurrency scope full (§5.3);
 *  - `closed`: outside the route's hours or on a holiday, or no route (the tenant default);
 *  - `voicemail`: the caller left a voicemail (P2; `voicemail_key`);
 *  - `rejected`: refused at the answer (hangup XML) after the row was written, with no follow-up;
 *  - `failed`: our side could not serve the call (the stream never opened, an error).
 */
export const AGENCY_INBOUND_CALL_OUTCOMES = [
  'answered', 'abandoned_in_queue', 'overflow', 'overflow_no_capacity', 'closed', 'voicemail', 'rejected', 'failed',
] as const;
export type AgencyInboundCallOutcome = (typeof AGENCY_INBOUND_CALL_OUTCOMES)[number];

/**
 * Why a call reached nobody, on its Missed inbound row (`follow_up_reason`, §7). The design's
 * four plus `failed`: a call our side could not serve is still a customer who rang and is owed a
 * follow-up. A voicemail keeps the reason it was taken for (`closed`, `overflow`, …); the
 * voicemail itself is `voicemail_key`.
 */
export const AGENCY_INBOUND_MISSED_REASONS = [
  'closed', 'abandoned_in_queue', 'overflow', 'overflow_no_capacity', 'failed',
] as const;
export type AgencyInboundMissedReason = (typeof AGENCY_INBOUND_MISSED_REASONS)[number];

/** A Missed inbound row's status (`follow_up_status`): `open` until someone marks it handled. */
export const AGENCY_INBOUND_FOLLOW_UP_STATUSES = ['open', 'handled'] as const;
export type AgencyInboundFollowUpStatus = (typeof AGENCY_INBOUND_FOLLOW_UP_STATUSES)[number];

/**
 * Which signal named the sticky agent (`sticky_reason`, §4.1, IB2): the contact's `owner`; the
 * agent whose latest call to the number went out from the number rung (`last_from_number`); the
 * last agent who spoke to the customer (`last_connected`); the last agent who dialled them,
 * unanswered (`last_dialled`, off by default).
 */
export const AGENCY_INBOUND_STICKY_REASONS = ['owner', 'last_from_number', 'last_connected', 'last_dialled'] as const;
export type AgencyInboundStickyReason = (typeof AGENCY_INBOUND_STICKY_REASONS)[number];

// ─── A route's configuration ────────────────────────────────────────────────

/**
 * Sticky routing (§4.2, IB2): `off`; `loose` (offer the sticky agent for `sticky_wait_seconds`,
 * then the team); `strict` (only that agent until the queue's max wait, then a follow-up
 * assigned to them).
 */
export const AGENCY_INBOUND_STICKY_MODES = ['off', 'loose', 'strict'] as const;
export type AgencyInboundStickyMode = (typeof AGENCY_INBOUND_STICKY_MODES)[number];

/**
 * What a call that reaches nobody gets after its message (IB3), out of hours
 * (`after_hours_action`) or past the queue's limits (`overflow_action`): `callback` plays the
 * "we'll call you back" clip and hangs up; `voicemail` records one from our stream (P2). Either
 * way the call gets a Missed inbound row and, on a matched open or exhausted contact, a callback.
 */
export const AGENCY_INBOUND_UNCONNECTED_ACTIONS = ['callback', 'voicemail'] as const;
export type AgencyInboundUnconnectedAction = (typeof AGENCY_INBOUND_UNCONNECTED_ACTIONS)[number];

/**
 * The route's clip slots, each an `audio_files` id of the route's account or null for the
 * built-in clip: `greeting`; `hold` (looped while queued, P2); `closed` (out of hours);
 * `busy` (all lines busy, §5.3); `recording_notice` (IB7, before any agent is bridged);
 * `callback` ("we'll call you back").
 */
export const AGENCY_INBOUND_CLIP_SLOTS = ['greeting', 'hold', 'closed', 'busy', 'recording_notice', 'callback'] as const;
export type AgencyInboundClipSlot = (typeof AGENCY_INBOUND_CLIP_SLOTS)[number];

const _allClipSlotsListed: AllListed<AgencyInboundClipSlot, typeof AGENCY_INBOUND_CLIP_SLOTS> = true;
void _allClipSlotsListed;

/** One clip id (or null, the built-in clip) per slot. */
export type AgencyInboundClips = Record<AgencyInboundClipSlot, string | null>;

/**
 * One stretch of opening hours, in the route's timezone. `day` is ISO-8601 (1=Mon … 7=Sun; `0`
 * is refused, as `calling_days` refuses it). `start` and `end` are `HH:MM`, 24-hour; `end` may be
 * `24:00` (to midnight). `end` earlier than `start` runs overnight into the next day
 * (`22:00`–`02:00`), and belongs to the day it opens on. `start` equal to `end` is refused (empty).
 * Several stretches may share a day (a lunch break is two stretches).
 */
export interface AgencyInboundHoursInterval {
  day: number;
  start: string;
  end: string;
}

/**
 * A holiday: local dates `from`..`to` (`YYYY-MM-DD`, both inclusive; one day is `from == to`) on
 * which the route is closed all day. A stretch of hours that OPENS on a holiday does not run at
 * all, and one that opened the day before stops at the holiday's midnight
 * (`@magick-agency/domain/inbound-schedule`).
 */
export interface AgencyInboundHoliday {
  from: string;
  to: string;
  /** Shown to the admin only ("Christmas Day"); never played. */
  label: string | null;
}

/** Everything an account admin sets on an inbound route (§8.1), as stored and served. */
export interface AgencyInboundRouteConfig {
  name: string;
  /** IANA `Area/Location` or `UTC` (the calling-hours rule: no bare abbreviations). */
  timezone: string;
  /** Empty: never open (every call is out of hours). */
  weekly_hours: AgencyInboundHoursInterval[];
  holidays: AgencyInboundHoliday[];
  clips: AgencyInboundClips;
  sticky_mode: AgencyInboundStickyMode;
  sticky_wait_seconds: number;
  sticky_lookback_days: number;
  /** Only agents staffed on these campaigns of the account take the route's calls; empty: every live campaign session in the account (§5.1). */
  pool_campaign_ids: string[];
  queue_max_wait_seconds: number;
  /** Callers waiting at once; past it, overflow. 0: no queue. */
  max_waiting: number;
  /** Waiting plus connected at once (IB5); past it, `overflow_no_capacity`. At least `max_waiting`. */
  max_concurrent: number;
  after_hours_action: AgencyInboundUnconnectedAction;
  overflow_action: AgencyInboundUnconnectedAction;
  record_calls: boolean;
  /** IB7: play the recording notice before an agent is bridged whenever the route records. */
  recording_notice: boolean;
  /** NULL: the account default profile. */
  analysis_profile_id: string | null;
  /** Outcomes for callers matched to no campaign. `[]`: the built-in catalog, never "no outcomes" (as the soft phone's). */
  disposition_catalog: AgencyDisposition[];
}

/**
 * A new route's values for everything the request leaves out (IB2: `loose`, 30 s, 30 days;
 * §5.1: 120 s, 10 waiting; IB3: a callback; IB7: the notice on). `max_concurrent` 20 is this
 * build's default, not a design decision. No hours: a route answers every call as closed until
 * its hours are set.
 */
export const AGENCY_INBOUND_ROUTE_DEFAULTS = Object.freeze({
  weekly_hours: [] as AgencyInboundHoursInterval[],
  holidays: [] as AgencyInboundHoliday[],
  clips: Object.freeze({
    greeting: null, hold: null, closed: null, busy: null, recording_notice: null, callback: null,
  }) as Readonly<AgencyInboundClips>,
  sticky_mode: 'loose' as AgencyInboundStickyMode,
  sticky_wait_seconds: 30,
  sticky_lookback_days: 30,
  pool_campaign_ids: [] as string[],
  queue_max_wait_seconds: 120,
  max_waiting: 10,
  max_concurrent: 20,
  after_hours_action: 'callback' as AgencyInboundUnconnectedAction,
  overflow_action: 'callback' as AgencyInboundUnconnectedAction,
  record_calls: false,
  recording_notice: true,
  analysis_profile_id: null as string | null,
  disposition_catalog: [] as AgencyDisposition[],
});

/**
 * The bounds of a route's numbers and lists, each CHECKed by `0024_inbound.sql` as well. Also the
 * console form's limits. `sticky_wait_seconds` is at most `queue_max_wait_seconds` and
 * `max_waiting` at most `max_concurrent` (cross-field, CHECKed too).
 */
export const AGENCY_INBOUND_ROUTE_LIMITS = Object.freeze({
  NAME_MAX: 100,
  STICKY_WAIT_SECONDS: { min: 5, max: 300 },
  STICKY_LOOKBACK_DAYS: { min: 1, max: 365 },
  QUEUE_MAX_WAIT_SECONDS: { min: 10, max: 1800 },
  MAX_WAITING: { min: 0, max: 100 },
  MAX_CONCURRENT: { min: 1, max: 500 },
  WEEKLY_HOURS_MAX: 50,
  HOLIDAYS_MAX: 100,
  /** Days one holiday entry may span (`from`..`to` inclusive). */
  HOLIDAY_SPAN_DAYS_MAX: 31,
  HOLIDAY_LABEL_MAX: 100,
  POOL_CAMPAIGNS_MAX: 50,
  /** Numbers one request may attach to a route (`phone_number_ids`); not a table bound. */
  NUMBERS_MAX: 100,
});

// ─── Contacts ───────────────────────────────────────────────────────────────

/**
 * A callback on a roster contact that no disposition booked (`agency_contacts.callback_source`,
 * with its due time in `callback_due_at`). `inbound`: the customer rang an inbound route and
 * reached nobody (§7, IB4); due at the route's next opening.
 */
export const AGENCY_CONTACT_CALLBACK_SOURCES = ['inbound'] as const;
export type AgencyContactCallbackSource = (typeof AGENCY_CONTACT_CALLBACK_SOURCES)[number];
