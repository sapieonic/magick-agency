/**
 * The agent's own day on one campaign (agent station BE-1, BE-2, BE-3; rulings AS6, AS7, AS8;
 * contracts `api/agency/my-day.ts`): the query, the day, and the rules that turn the campaign and
 * the read's rows into `AgencyMyDay`. Pure. The reads are `db/repositories/agency/my-day.repository.ts`;
 * the route `api/routes/proxy-agency-my-day.routes.ts`.
 */
import {
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  type AgencyContextDisplay,
  type AgencyDisposition,
} from '@magick-agency/contracts/agency';
import {
  AGENCY_DAILY_TARGET_CALLS_MAX,
  AGENCY_DAILY_TARGET_CALLS_MIN,
} from '@magick-agency/contracts/api/agency/agency-campaign';
import type {
  AgencyMyCallLater,
  AgencyMyCallLaterLeftGoesTo,
  AgencyMyCallLaterRow,
  AgencyMyDay,
  AgencyMyDayTarget,
} from '@magick-agency/contracts/api/agency/my-day';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';
import { isUuid } from '../utils/uuid.js';
import { localDayEnd, localDayStart } from './calling-hours.js';
import { matchName, INBOUND_MATCH_NAME_MAX } from './inbound/match-name.js';
import { ownerModeOf } from './pacing/agent-queue.js';

/**
 * `GET /my-day`'s query: `campaign_id` (a UUID, given once) and nothing else. Lower-cased. An
 * unknown key is refused rather than ignored, so a client cannot believe it asked for something
 * the read does not do (another agent's day: the subject is always the caller).
 */
export function parseMyDayQuery(
  query: Record<string, unknown> | undefined,
): { ok: true; campaignId: string } | { ok: false; message: string } {
  const q = query ?? {};
  const unknown = Object.keys(q).filter((k) => k !== 'campaign_id');
  if (unknown.length > 0) return { ok: false, message: `Only campaign_id may be given (not ${unknown.join(', ')}).` };
  const raw = q['campaign_id'];
  if (typeof raw !== 'string' || !isUuid(raw)) return { ok: false, message: '`campaign_id` must be a campaign id, given once.' };
  return { ok: true, campaignId: raw.toLowerCase() };
}

/** The day served: the campaign's local midnight to the next, in its zone. */
export interface MyDayWindow {
  /** The zone the day was cut in: the campaign's, or `UTC` when its zone cannot be read. */
  timezone: string;
  start: Date;
  end: Date;
}

/**
 * The campaign's day holding `now`: `[local midnight, next local midnight)` in its
 * `default_timezone`, by the server's clock. An unreadable zone (validated at write, so only a
 * row written past the validator) cuts the day at UTC midnight, as Insights and the callbacks list do.
 */
export function myDayWindow(timezone: string, now: Date): MyDayWindow {
  const start = localDayStart(timezone, now);
  const end = localDayEnd(timezone, now);
  if (start && end) return { timezone, start, end };
  return { timezone: 'UTC', start: localDayStart('UTC', now)!, end: localDayEnd('UTC', now)! };
}

/**
 * The catalog a campaign's outcomes are drawn from: its own, or the default when it stores none.
 * Compare agents reads a campaign's outcome codes through it too (`api/routes/proxy-agency-compare/`).
 */
export function effectiveCatalog(catalog: readonly AgencyDisposition[] | null | undefined): readonly AgencyDisposition[] {
  return Array.isArray(catalog) && catalog.length > 0 ? catalog : AGENCY_DEFAULT_DISPOSITION_CATALOG;
}

/**
 * AS7: whether the campaign's outcomes can record a pay date (an entry with
 * `requires_promise: true`). When not, My day's `will_pay` is null and the tile is not shown.
 */
export function campaignRecordsPromises(catalog: readonly AgencyDisposition[] | null | undefined): boolean {
  return effectiveCatalog(catalog).some((d) => !!d && typeof d === 'object' && d.requires_promise === true);
}

/** BE-2: the campaign's daily target, or null without one (null is no bar, not zero). */
export function myDayTarget(dailyTargetCalls: number | null | undefined): AgencyMyDayTarget | null {
  if (typeof dailyTargetCalls !== 'number' || !Number.isInteger(dailyTargetCalls)) return null;
  if (dailyTargetCalls < AGENCY_DAILY_TARGET_CALLS_MIN || dailyTargetCalls > AGENCY_DAILY_TARGET_CALLS_MAX) return null;
  return { metric: 'calls', value: dailyTargetCalls };
}

/**
 * AS8: where the agent's call-laters go, by the campaign's routing, which this read never changes.
 *
 *  - `comes_to_me`: the campaign pairs a call-later with its owner (`strict` / `preferred`, CA4),
 *    so the agent's own call-laters come back to them. `pool`: whoever is free takes it.
 *  - `left_today_goes_to`: what happens to one the agent leaves when they finish: on `pool`, or with
 *    `callback_fallback = 'pool'` (CA5: past the grace an absent owner's call-later returns to the
 *    pool), another agent may make it; with `wait` it waits for them.
 */
export function callLaterRouting(
  campaign: Pick<AgencyCampaignRecord, 'assignment_mode' | 'callback_fallback'>,
): { comes_to_me: boolean; left_today_goes_to: AgencyMyCallLaterLeftGoesTo } {
  const owner = ownerModeOf(campaign) !== null;
  return {
    comes_to_me: owner,
    left_today_goes_to: owner && campaign.callback_fallback === 'wait' ? 'waits_for_me' : 'pool',
  };
}

/**
 * The customer's name on a call-later row: the column the campaign names as the `name` role
 * (`context_display.roles.name`, BE-6) when it holds text, else the floor's guess (`matchName`).
 * Never the number, and never a column the campaign hides from agents (`context_display.hidden`,
 * matched ignoring case as the station's facts match it): a hidden column is neither the role's
 * nor the guess's. Trimmed, at most {@link INBOUND_MATCH_NAME_MAX} characters.
 */
export function callLaterCustomerName(
  context: Record<string, unknown> | null | undefined,
  contextDisplay: Pick<AgencyContextDisplay, 'roles' | 'hidden'> | null | undefined,
): string | null {
  if (!context) return null;
  const hiddenList = Array.isArray(contextDisplay?.hidden) ? contextDisplay.hidden : [];
  const hidden = new Set(hiddenList.filter((h): h is string => typeof h === 'string').map((h) => h.trim().toLowerCase()));
  const visible = hidden.size === 0
    ? context
    : Object.fromEntries(Object.entries(context).filter(([k]) => !hidden.has(k.trim().toLowerCase())));
  const column = contextDisplay?.roles?.name;
  if (typeof column === 'string' && !hidden.has(column.trim().toLowerCase())) {
    const v = visible[column];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, INBOUND_MATCH_NAME_MAX);
  }
  return matchName(visible) ?? null;
}

/** One call-later as the read gives it. */
export interface MyCallLaterSourceRow {
  contact_id: string;
  context: Record<string, unknown> | null;
  due_at: Date;
}

/** The read's counts and the agent's own numbers, as `buildMyDay` takes them. */
export interface MyDayCounts {
  dialed: number;
  calls: number;
  talk_seconds: number;
  successes: number;
  /** Outcomes written in the day that recorded a pay date (counted whatever the catalog says). */
  promises: number;
}

/** The call-later half of the read. */
export interface MyCallLaterRead {
  rows: MyCallLaterSourceRow[];
  today: number;
  overdue: number;
}

/** `AgencyMyCallLater` from the read, the campaign's routing and `now`. */
export function myCallLater(
  campaign: Pick<AgencyCampaignRecord, 'assignment_mode' | 'callback_fallback' | 'context_display'>,
  read: MyCallLaterRead,
  now: Date,
): AgencyMyCallLater {
  const rows: AgencyMyCallLaterRow[] = read.rows.map((r) => ({
    contact_id: r.contact_id,
    customer_name: callLaterCustomerName(r.context, campaign.context_display),
    due_at: r.due_at.toISOString(),
    overdue: r.due_at.getTime() < now.getTime(),
  }));
  return { rows, today: read.today, overdue: read.overdue, ...callLaterRouting(campaign) };
}

/** The whole `AgencyMyDay`. */
export function buildMyDay(
  campaign: Pick<AgencyCampaignRecord, 'id' | 'assignment_mode' | 'callback_fallback' | 'context_display'
    | 'disposition_catalog' | 'daily_target_calls'>,
  window: MyDayWindow,
  counts: MyDayCounts,
  callLater: MyCallLaterRead,
  now: Date,
): AgencyMyDay {
  return {
    campaign_id: campaign.id,
    timezone: window.timezone,
    day_start: window.start.toISOString(),
    day_end: window.end.toISOString(),
    calls: counts.calls,
    dialed: counts.dialed,
    talk_seconds: Math.round(counts.talk_seconds),
    will_pay: campaignRecordsPromises(campaign.disposition_catalog) ? counts.promises : null,
    successes: counts.successes,
    target: myDayTarget(campaign.daily_target_calls),
    call_later: myCallLater(campaign, callLater, now),
    as_of: now.toISOString(),
  };
}
