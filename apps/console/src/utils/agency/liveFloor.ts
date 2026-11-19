import { AGENCY_CAMPAIGN_MIN_RATE_DENOMINATOR } from '../../types/agency-stats';
import type { AgencyHomeCampaignStats } from '@magick-agency/contracts/api/agency/home';
import { agencyCampaignControls, type AgencyCampaignAction } from '../agencyCampaignControls';
import { campaignTabHref } from '../agencyCampaignTabs';
import { stallCopy } from '../agencyHealthStrip';
import { dateFormatter, formatClockTime, formatDayMonth } from '../format/date';
import { formatCount, plural } from '../format/number';
import { badgeText } from '../badgeText';
import { listWorkedRing } from './overview/pulse';
import { insightsRate, rateText } from './insights/rates';
import {
  HOME_CAMPAIGN_CAP,
  NO_DIALS_TODAY,
  type HomeAttentionItem,
  type HomeCampaignRead,
  type HomeCampaignRef,
  type HomeReviewCampaign,
  type TodayTotals,
} from './home';
import { splitAcknowledged, type HomeAck } from './homeAcks';
import { CHOOSING_OUTCOME_LABEL, FLOOR_CARD_LABELS } from './liveFloorAgents';

export { CHOOSING_OUTCOME_LABEL };

/**
 * Live floor (decision LF1): the supervisor's landing page, `/agency/home`, which used to be called
 * Home. The rules the page shows by, pure so each is tested where it is made. The list itself
 * (Needs you now) is still `homeAttention` in `home.ts`, which the sidebar badge counts; this module
 * shapes it and the page's other parts from the same reads:
 *
 *  - the campaign filter (client side, over the board's campaigns, kept in `?campaign=`);
 *  - the five tiles (agents working, calls, customers reached, successes, late callbacks);
 *  - one row for every campaign still on the default calling hours, in place of one each;
 *  - a card per active campaign (calls live, how much of the list is done, Pause or Resume);
 *  - the agents' state chips, counted from each campaign's floor.
 *
 * Phase 2's account-wide floor read (one row per agent) and the promises summary have their rules
 * in `liveFloorAgents.ts`: the agent cards and their chips, breaks over the limit in Needs you now,
 * Agents working from the floor and the Will pay tile.
 */

/** The page's name, in the sidebar, the breadcrumb and its heading. */
export const LIVE_FLOOR_TITLE = 'Live floor';

// ── The header's clock ──────────────────────────────────────────────────────

const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: 'short' };

/** "Wed 18 Nov" and "02:15 pm", on the reader's calendar and clock, in the console's locale. */
export function liveFloorClock(now: Date): { date: string; time: string } {
  return {
    date: `${dateFormatter(WEEKDAY).format(now)} ${formatDayMonth(now)}`,
    time: formatClockTime(now),
  };
}

/** How long until the clock's next minute, so the header ticks on the minute, not a minute late. */
export function msToNextMinute(now: Date): number {
  return 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
}

// ── The campaign filter ─────────────────────────────────────────────────────

/** The query parameter that keeps the filter across reloads (the URL is already the account's). */
export const CAMPAIGN_FILTER_PARAM = 'campaign';

/**
 * The campaign the filter names, when the board carries it. A campaign that has left the active
 * set (stopped elsewhere) is not on the board, so the page shows every campaign rather than none.
 */
export function selectedCampaign(param: string | null, reads: readonly HomeCampaignRead[]): HomeCampaignRef | null {
  if (!param) return null;
  return reads.find((r) => r.campaign.id === param)?.campaign ?? null;
}

/** The reads the page shows: one campaign's, or all of them (the same list, never copied). */
export function readsFor(reads: readonly HomeCampaignRead[], campaignId: string | null): readonly HomeCampaignRead[] {
  return campaignId === null ? reads : reads.filter((r) => r.campaign.id === campaignId);
}

// ── Needs you now ───────────────────────────────────────────────────────────

/** Where a campaign's calling hours are set: its Settings, on the section's anchor. */
function callingHoursHref(campaignId: string): string {
  return `${campaignTabHref('settings', campaignId)}#calling-hours`;
}

/**
 * Needs you now's rows for one campaign, or for all: the rows still to show (`open`) and the ones
 * the reader put aside with "Got it" (`acknowledged`, still holding), each in the list's order, with
 * the campaigns on the default calling hours grouped into one row ({@link groupCallingHours}); and
 * how many rows that need the reader (not information) the filter leaves out, so a filter never
 * hides a problem without saying so. The account's own rows (missed calls) are about no campaign,
 * so a filter leaves them out too. A row put aside is not one the filter hides from the reader, so
 * it is not counted. Every row is split once, the shown and the left out alike.
 *
 * Rows are split before they are grouped: a calling-hours "Got it" is held per campaign (LF9), so
 * the open group stands for the campaigns not put aside and a second group, under Acknowledged, for
 * those that are. A filter changes which campaigns a group covers, never what was put aside.
 */
export function attentionFor(
  items: readonly HomeAttentionItem[],
  campaignId: string | null,
  acks: Readonly<Record<string, HomeAck>> = {},
): { open: HomeAttentionItem[]; acknowledged: HomeAttentionItem[]; elsewhere: number } {
  const split = splitAcknowledged(items, acks);
  const isPicked = (item: HomeAttentionItem) => campaignId === null || item.campaign?.id === campaignId;
  return {
    open: groupCallingHours(split.open.filter(isPicked)),
    acknowledged: groupCallingHours(split.acknowledged.filter(isPicked)),
    elsewhere: split.open.filter((item) => !isPicked(item) && item.tone !== 'info').length,
  };
}

/**
 * One row for every campaign still on the default calling hours, where the Overview's rule makes
 * one per campaign: "3 campaigns still use the default calling hours", whose Review opens the list
 * of them, each to its Settings' calling hours. Information, so the badge never counted these.
 * The row takes the place of the first it replaces; every other row is left as it was. It carries
 * the rows it replaces (`parts`): its "Got it" puts each campaign aside under the campaign's own
 * id ({@link attentionFor} splits before it groups), so a campaign newly on the default hours
 * brings the row back, for that campaign.
 */
export function groupCallingHours(items: readonly HomeAttentionItem[]): HomeAttentionItem[] {
  const rows = items.filter((item) => item.kind === 'calling-hours-default' && item.campaign);
  if (rows.length === 0) return [...items];
  const review: HomeReviewCampaign[] = rows.map((row) => ({
    id: row.campaign!.id,
    name: row.campaign!.name,
    to: callingHoursHref(row.campaign!.id),
  }));
  const details = new Set(rows.map((row) => row.detail));
  const grouped: HomeAttentionItem = {
    id: 'calling-hours-default',
    tone: 'info',
    campaign: null,
    title: rows.length === 1
      ? '1 campaign still uses the default calling hours'
      : `${formatCount(rows.length)} campaigns still use the default calling hours`,
    // The rule's own words when every row says the same (the default is one window).
    detail: details.size === 1 ? rows[0]!.detail : 'Each is still on its default window. Open one to set its hours.',
    at: null,
    action: 'Review',
    to: rows.length === 1 ? review[0]!.to : '/agency/campaigns',
    stale: rows.some((row) => row.stale),
    kind: 'calling-hours-default',
    count: rows.length,
    ackable: true,
    review,
    parts: rows,
  };
  const out: HomeAttentionItem[] = [];
  let placed = false;
  for (const item of items) {
    if (item.kind !== 'calling-hours-default' || !item.campaign) {
      out.push(item);
    } else if (!placed) {
      out.push(grouped);
      placed = true;
    }
  }
  return out;
}

// ── The tiles ───────────────────────────────────────────────────────────────

/**
 * Agents working. Phase 1 sums each campaign's `agents_live` (its floor's rows that are not
 * offline). That is a count of people, not of seats, because an agent holds one station at a time
 * (OS1): nobody is live on two campaigns at once. `assigned` is Phase 2's denominator (the floor
 * read's agents assigned to active campaigns, counted once per person); null until then, since
 * summing each campaign's `staffing.staffed` would count an agent on two campaigns twice.
 */
export interface AgentsWorking {
  working: number;
  assigned: number | null;
}

export function agentsWorking(reads: readonly HomeCampaignRead[]): AgentsWorking {
  return { working: reads.reduce((n, r) => n + (r.stats?.agents_live ?? 0), 0), assigned: null };
}

/** The Agents working tile's line: "on the floor now", or Phase 2's "of 10 assigned". */
export function agentsWorkingSub(figure: AgentsWorking): string {
  return figure.assigned === null ? 'on the floor now' : `of ${formatCount(figure.assigned)} assigned`;
}

/**
 * Late callbacks: each campaign's overdue callbacks (the allocation's `callbacks_overdue`, the
 * Callbacks tab badge's figure), summed. Null when no campaign's allocation is known, so the tile
 * shows a dash rather than a reassuring zero it never read. Screens read it through
 * {@link lateCallbacksFigure}.
 */
export function lateCallbacks(reads: readonly HomeCampaignRead[]): number | null {
  const known = reads.filter((r) => r.allocation !== null);
  if (known.length === 0) return null;
  return known.reduce((n, r) => n + r.allocation!.callbacks_overdue, 0);
}

/**
 * How many campaigns' late callbacks are not known (their allocation was not read). With any, a sum
 * over the rest is a lower bound, never the account's figure, and never an all-clear.
 */
export function lateCallbacksUnknown(reads: readonly HomeCampaignRead[]): number {
  return reads.filter((r) => r.allocation === null).length;
}

/** Whether the board's campaigns are only some of the active ones (the cap). */
export function boardIsPartial(board: { activeTotal: number; reads: readonly unknown[] }): boolean {
  return board.activeTotal > board.reads.length;
}

/** The late-callbacks figure every screen shows: the tile, the Callbacks page, the badge and the menu dot. */
export interface LateCallbacksFigure {
  /** Overdue callbacks over the campaigns whose allocation is known; null when none is ({@link lateCallbacks}). */
  count: number | null;
  /** How many campaigns' callbacks are not known ({@link lateCallbacksUnknown}). */
  unknown: number;
  /** The board left active campaigns out (its cap): only the account's figure, never one campaign's. */
  capped: boolean;
  /**
   * The count is a lower bound ("4+", "at least 4"): capped, or a campaign's callbacks are not
   * known. Never with no count: a dash bounds nothing.
   */
  lowerBound: boolean;
}

/**
 * Late callbacks over the board's campaigns, or one campaign picked (`campaignId`). One campaign
 * picked is that campaign's whole figure, so the board's cap does not apply to it; the account's
 * past the cap is a lower bound, and so is a sum that leaves out a campaign whose callbacks are not
 * known: never a plain 0 it did not read (B28a).
 */
export function lateCallbacksFigure(
  board: { activeTotal: number; reads: readonly HomeCampaignRead[] },
  campaignId: string | null = null,
): LateCallbacksFigure {
  const reads = readsFor(board.reads, campaignId);
  const count = lateCallbacks(reads);
  const unknown = lateCallbacksUnknown(reads);
  const capped = campaignId === null && boardIsPartial(board);
  return { count, unknown, capped, lowerBound: count !== null && (capped || unknown > 0) };
}

/** "1 campaign's callbacks aren't known", "2 campaigns' …". */
function unknownCallbacksText(unknown: number): string {
  return unknown === 1 ? '1 campaign’s callbacks aren’t known' : `${formatCount(unknown)} campaigns’ callbacks aren’t known`;
}

/**
 * The Callbacks page's summary line, from the account's {@link lateCallbacksFigure}. "No callback
 * is late right now" only when every active campaign was read (not past the board's cap,
 * `capped`) and every one's allocation is known (`unknown` 0): B28a's never-an-all-clear rule.
 * Otherwise a lower bound in words, never "at least 0". Null with no campaign at all (the list says
 * so).
 */
export function callbacksSummary({ count: total, capped: partial, unknown }: Pick<LateCallbacksFigure, 'count' | 'capped' | 'unknown'>): string | null {
  if (total === null) return unknown > 0 ? 'Late callbacks couldn’t be read for any campaign.' : null;
  if (!partial && unknown === 0) {
    return total === 0 ? 'No callback is late right now.' : `${plural(total, 'callback')} late across the active campaigns.`;
  }
  const where = partial ? ` in the first ${HOME_CAMPAIGN_CAP} active campaigns` : '';
  if (total === 0) return `No late callbacks found${where}${unknown > 0 ? `, but ${unknownCallbacksText(unknown)}` : ''}.`;
  return `At least ${plural(total, 'callback')} late${partial ? `,${where}` : ''}.${unknown > 0 ? ` ${unknownCallbacksText(unknown)}.` : ''}`;
}

/** The Callbacks page's own words when the board does not load (never Live floor's "what needs your attention"). */
export const CALLBACKS_ERROR = 'We couldn’t load the late callbacks. Try again in a moment.';

/** The Callbacks page's own words when the server refuses the board (403). */
export const CALLBACKS_REFUSED = 'Callbacks aren’t available to you in this account right now.';

/** One campaign on the Callbacks page: its overdue callbacks and how many belong to an agent who is away. */
export interface CallbackRow {
  campaign: HomeCampaignRef;
  /** Null when its allocation is not known. */
  overdue: number | null;
  ownerAway: number;
  stale: boolean;
}

/**
 * The Callbacks page's rows: every active campaign on the board, the most overdue first (one
 * not known yet last), the board's own order otherwise.
 */
export function callbackRows(reads: readonly HomeCampaignRead[]): CallbackRow[] {
  return reads
    .map((read, index) => ({
      row: {
        campaign: read.campaign,
        overdue: read.allocation?.callbacks_overdue ?? null,
        ownerAway: read.allocation?.callbacks_overdue_absent_owner ?? 0,
        stale: read.stale,
      },
      index,
    }))
    .sort((a, b) => (b.row.overdue ?? -1) - (a.row.overdue ?? -1) || a.index - b.index)
    .map(({ row }) => row);
}

/**
 * A late-callbacks figure as shown: the count, or "4+" when it is a lower bound (the board left
 * campaigns out: it reads the first `HOME_CAMPAIGN_CAP` active ones, `activeTotal` past them; or a campaign's
 * callbacks are not known), so a sum over some campaigns is never read as the account's. "99+"
 * past 99 either way.
 */
export function lateCallbacksText(count: number, partial: boolean): string {
  const text = badgeText(count) ?? '0';
  return partial && text !== '99+' ? `${text}+` : text;
}

/** What a screen reader hears beside the Callbacks entry: "4 callbacks overdue"; null at zero. */
export function callbacksBadgeLabel(count: number | null, stale = false, partial = false): string | null {
  const text = badgeText(count);
  if (!text) return null;
  const said = text === '99+'
    ? 'more than 99 callbacks overdue'
    : partial ? `at least ${plural(count!, 'callback')} overdue` : `${plural(count!, 'callback')} overdue`;
  return stale ? `${said} (not up to date)` : said;
}

/**
 * The tiles' today figures: the account's, or one campaign's row of the same grouped read. A
 * campaign with no row placed no dial today, so its figures are zeros.
 */
export function todayFor(
  totals: TodayTotals,
  byCampaign: Readonly<Record<string, TodayTotals>>,
  campaignId: string | null,
): TodayTotals {
  if (campaignId === null) return totals;
  return byCampaign[campaignId] ?? NO_DIALS_TODAY;
}

/**
 * The Customers reached tile's line: conversations as a share of today's dials, "28.1% of dials
 * answered". It is NOT the connect rate, which the product defines once as human connects over
 * placed first dials (`connectRate`); the grouped rows carry neither, and Home left that rate out
 * on purpose (B28a) rather than print a second number under its name. This line divides every
 * dial, redials included, so its words say exactly that. Withheld under the campaign rate floor
 * (`AGENCY_CAMPAIGN_MIN_RATE_DENOMINATOR`, 25 dials), as every rate on a campaign page is.
 */
export function answeredLine(totals: Pick<TodayTotals, 'conversations' | 'dials'>): string {
  const rate = insightsRate(totals.conversations, totals.dials, AGENCY_CAMPAIGN_MIN_RATE_DENOMINATOR);
  if (rate.kind === 'none') return 'No dials yet today';
  if (rate.kind === 'withheld') return 'Too few dials yet for a share';
  return `${rateText(rate)} of dials answered`;
}

// ── The campaign cards ──────────────────────────────────────────────────────

/** How much of a campaign's list is done, by the Active cards' list-worked rule (`listWorkedRing`). */
interface ListDone {
  known: boolean;
  /** 0–100, null when not known. */
  percent: number | null;
  /** "45%", or a dash. */
  label: string;
  /** "560 of 1,240 customers", or why there is no figure. */
  caption: string;
}

export function listDone(
  stats: Pick<AgencyHomeCampaignStats, 'contacts_total' | 'contacts_completed' | 'contacts_suppressed' | 'contacts_exhausted'> | null,
): ListDone {
  const ring = listWorkedRing(stats);
  if (!ring.known || !stats) return { known: false, percent: null, label: ring.label, caption: ring.caption };
  // Known, so every count is a number (the ring's own check).
  const worked = (stats.contacts_completed ?? 0) + (stats.contacts_suppressed ?? 0) + (stats.contacts_exhausted ?? 0);
  return {
    known: true,
    percent: ring.percent,
    label: ring.label,
    caption: `${formatCount(worked)} of ${formatCount(stats.contacts_total ?? 0)} customers`,
  };
}

/** "4 calls live" (the board's `attempts_live`); never "of N lines": a campaign has no line limit of its own (MC1). */
export function callsLiveText(stats: Pick<AgencyHomeCampaignStats, 'attempts_live'> | null): string | null {
  if (!stats || typeof stats.attempts_live !== 'number') return null;
  return `${plural(stats.attempts_live, 'call')} live`;
}

/** Pause or Resume, when the campaign header would offer it live (`agencyCampaignControls`); never Stop here. */
export function floorLifecycleAction(status: string): Extract<AgencyCampaignAction, 'pause' | 'resume'> | null {
  const live = agencyCampaignControls(status).find(
    (c) => (c.action === 'pause' || c.action === 'resume') && c.disabledReason === null,
  );
  return live ? (live.action as 'pause' | 'resume') : null;
}

/**
 * Who paused or is stopping a campaign, and when, from the board's `status_changed`: "Paused by
 * Anitha at 11:03 am", "Paused automatically at 11:03 am" (the guardrail or the carrier account),
 * "Stopping, by Anitha at …". Each part is left out when the board does not know it; null while
 * running, or when nothing is known at all.
 */
export function statusChangeLine(
  read: Pick<HomeCampaignRead, 'campaign' | 'statusChanged'>,
  formatInstant: (iso: string) => string,
): string | null {
  const change = read.statusChanged;
  const { status } = read.campaign;
  if (!change || (status !== 'paused' && status !== 'stopping')) return null;
  const at = change.at ? ` at ${formatInstant(change.at)}` : '';
  const by = change.by_name?.trim();
  if (status === 'paused') {
    if (change.automatic) return `Paused automatically${at}`;
    if (by) return `Paused by ${by}${at}`;
    return at ? `Paused${at}` : null;
  }
  if (by) return `Stopping, by ${by}${at}`;
  return change.at ? `Stopping since ${formatInstant(change.at)}` : null;
}

export interface LiveFloorCampaignCard {
  campaign: HomeCampaignRef;
  /** "Paused by Anitha at 11:03 am" ({@link statusChangeLine}), or null. */
  statusLine: string | null;
  /** "4 calls live", null before the stats answer. */
  callsLive: string | null;
  list: ListDone;
  /** The health strip's headline for its top stall, or null. */
  stall: string | null;
  action: 'pause' | 'resume' | null;
  /** The campaign's own page. */
  to: string;
  stale: boolean;
}

export function campaignCards(
  reads: readonly HomeCampaignRead[],
  formatInstant: (iso: string) => string,
): LiveFloorCampaignCard[] {
  return reads.map((read) => ({
    campaign: read.campaign,
    statusLine: statusChangeLine(read, formatInstant),
    callsLive: callsLiveText(read.stats),
    list: listDone(read.stats),
    stall: read.stats?.stall ? stallCopy(read.stats.stall, formatInstant).headline : null,
    action: floorLifecycleAction(read.campaign.status),
    to: `/agency/campaigns/${read.campaign.id}`,
    stale: read.stale,
  }));
}

// ── The agents ──────────────────────────────────────────────────────────────

type AgentChipId = 'on_call' | 'available' | 'wrapup' | 'break';

/** The chips, in the mock's order, in the floor cards' words; colours by state are the page's (CSS). */
export const AGENT_CHIPS: ReadonlyArray<{ id: AgentChipId; label: string }> = (['on_call', 'available', 'wrapup', 'break'] as const)
  .map((id) => ({ id, label: FLOOR_CARD_LABELS[id] }));

interface AgentChipCounts {
  /** Everyone on the floor (`agents_live` summed). */
  total: number;
  counts: Record<AgentChipId, number>;
  /**
   * Some campaign's stats carried no per-state counts (or none yet): the chips then add up to less
   * than the total, and the page says the figures are partial.
   */
  partial: boolean;
}

/**
 * The state chips over the shown campaigns, from each one's `agents_by_state`. A call being
 * connected to an agent (`reserved`) counts as on a call, as on the campaign floor.
 */
export function agentChips(reads: readonly HomeCampaignRead[]): AgentChipCounts {
  const counts: Record<AgentChipId, number> = { on_call: 0, available: 0, wrapup: 0, break: 0 };
  let total = 0;
  let partial = false;
  for (const { stats } of reads) {
    if (!stats) {
      partial = true;
      continue;
    }
    const live = stats.agents_live ?? 0;
    total += live;
    const by = stats.agents_by_state;
    if (!by) {
      if (live > 0) partial = true;
      continue;
    }
    counts.on_call += (by.on_call ?? 0) + (by.reserved ?? 0);
    counts.available += by.available ?? 0;
    counts.wrapup += by.wrapup ?? 0;
    counts.break += by.break ?? 0;
  }
  return { total, counts, partial };
}

/** A campaign's floor in a few words, for the per-campaign links under the chips: "4 on the floor". */
export function floorWords(agentsLive: number): string {
  return agentsLive === 0 ? 'nobody on the floor' : `${plural(agentsLive, 'agent')} on the floor`;
}
