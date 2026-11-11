import type { AgencyCampaign, AgencyCampaignStats, AgencyStallCode } from '../../types/agency-campaign';
import type { AgencyInboundMissedCountResponse } from '../../types/inbound';
import type { AgencyGroupPage } from '../../types/agency-stats';
import { AGENCY_STALL_LABELS, stallCopy } from '../agencyHealthStrip';
import { campaignTabHref, type CampaignTabId } from '../agencyCampaignTabs';
import { sortCampaigns } from '../agencyCampaignsHome';
import { plural } from '../format/number';
import { abandonmentTone, ceilingPctText } from './abandonmentCeiling';
import { abandonmentRate, rateText, type InsightsRate } from './insights/rates';

/**
 * The Home page's rules (decision B28, Home): what needs a supervisor now, the floor of each
 * live campaign, and today's totals. Pure, so every rule is tested where it is made, and the
 * page and the sidebar badge count the same list.
 *
 * ── Conditions, not notifications ──────────────────────────────────────────
 * Every item is derived from the latest reads. Nothing is stored and nothing is read or
 * unread: an item is there while its condition holds and gone on the next refresh after it
 * is fixed.
 *
 * ── Wording ────────────────────────────────────────────────────────────────
 * Every sentence is one the console already says somewhere: the stall labels and headlines
 * are the health strip's (`agencyHealthStrip`), the abandonment and callback lines are the
 * campaign Overview's "Needs your attention" (`insights/overview.ts`), the missed-calls line
 * the Missed list's subtitle.
 */

/** At most this many active campaigns get per-campaign reads (stats and the allocation). */
export const HOME_CAMPAIGN_CAP = 25;

export type HomeTone = 'danger' | 'warning' | 'info';

export interface HomeAttentionItem {
  /** Stable across refreshes: the condition and the campaign it is about. */
  id: string;
  tone: HomeTone;
  /** The campaign it is about, or null (missed calls are the account's). */
  campaign: { id: string; name: string } | null;
  title: string;
  /** One line of reason. */
  detail: string;
  /** When it started, where the payload says (an automatic pause's instant). */
  at: string | null;
  /** The button's words. */
  action: string;
  /** Where the fix is. */
  to: string;
}

/** One active campaign and what Home has read for it. */
export interface HomeCampaignRead {
  campaign: AgencyCampaign;
  /** Null until its `/stats` answers (or when it failed and nothing was read before). */
  stats: AgencyCampaignStats | null;
  /** The callbacks overdue now (the allocation's totals), null until known. */
  overdue: number | null;
}

export interface HomeMissed {
  /** `useMissedCallsAccess().available`. */
  available: boolean;
  count: AgencyInboundMissedCountResponse | null;
}

const TONE_ORDER: Record<HomeTone, number> = { danger: 0, warning: 1, info: 2 };

/**
 * Per stall code: how urgent it reads and the one place that fixes it. The automatic pauses
 * and the faults that stop every call are danger; nobody free and failing calls are warnings;
 * waiting for calling hours or a scheduled retry is information (nothing is wrong, nothing is
 * dialling). The tab is where the evidence and the fix are: the floor for staffing, Health for
 * the guardrail, the carrier, caller IDs, the DNC check and the lines, Overview otherwise.
 */
const STALL_ROUTE: Record<AgencyStallCode, { tone: HomeTone; tab: CampaignTabId; action: string }> = {
  auto_paused_abandonment: { tone: 'danger', tab: 'health', action: 'Review and resume' },
  auto_paused_carrier: { tone: 'danger', tab: 'health', action: 'Review and resume' },
  no_dialable_caller_ids: { tone: 'danger', tab: 'health', action: 'Check caller IDs' },
  no_carrier_capacity: { tone: 'danger', tab: 'health', action: 'Open Health' },
  dnc_unavailable: { tone: 'danger', tab: 'health', action: 'Open Health' },
  // The health strip's own link for this one.
  no_agents_available: { tone: 'warning', tab: 'agents', action: 'Open the floor' },
  concurrency_saturated: { tone: 'warning', tab: 'health', action: 'Open Health' },
  elevated_failure_rate: { tone: 'warning', tab: 'health', action: 'Open Health' },
  outside_calling_hours: { tone: 'info', tab: 'overview', action: 'Open campaign' },
  list_exhausted_retries_pending: { tone: 'info', tab: 'overview', action: 'Open campaign' },
};

/**
 * The guardrail's rolling 24-hour rate from `/stats`, with the Insights sample floor (IN5, 25
 * answered calls): under it the rate is withheld, so a campaign three calls in never reads as
 * "close to the ceiling".
 */
export function statsAbandonmentRate(stats: AgencyCampaignStats): InsightsRate {
  // Optional on the console's type: a payload without them has no rate to show.
  if (stats.abandoned_24h === undefined || stats.answered_24h === undefined) return { kind: 'none' };
  return abandonmentRate({ abandoned: stats.abandoned_24h, answered: stats.answered_24h });
}

/**
 * Whether abandonment needs attention: at or above the abandonment meter's warning band, which
 * starts at 80% of the ceiling (`abandonmentTone`: `warn` from 80% up to the ceiling, `bad`
 * above it). Null when it does not, or there are too few answered calls to say.
 */
export function abandonmentAttention(stats: AgencyCampaignStats): 'near' | 'over' | null {
  const rate = statsAbandonmentRate(stats);
  if (rate.kind !== 'value' || stats.abandonment_ceiling_pct === undefined) return null;
  const tone = abandonmentTone(rate.pct, stats.abandonment_ceiling_pct);
  return tone === 'bad' ? 'over' : tone === 'warn' ? 'near' : null;
}

/**
 * The "Needs your attention" list, most urgent first (danger, warning, information), campaigns
 * in their Campaigns-page order within a tone. One row per live condition:
 *
 *  - a campaign's stall: its top one, as the health strip shows it (one diagnosis, not five);
 *  - abandonment in the meter's warning band or over the ceiling, on a running campaign (a
 *    paused one dials nothing; an automatic abandonment pause is already its stall row);
 *  - a campaign's overdue callbacks;
 *  - the account's open missed inbound calls, when the reader gets the Missed list.
 */
export function homeAttention(
  reads: readonly HomeCampaignRead[],
  missed: HomeMissed,
  formatInstant: (iso: string) => string,
): HomeAttentionItem[] {
  const items: HomeAttentionItem[] = [];

  for (const { campaign, stats, overdue } of reads) {
    const about = { id: campaign.id, name: campaign.name };

    const stall = stats?.stall ?? null;
    const route = stall ? STALL_ROUTE[stall.code] : undefined;
    if (stall && route) {
      items.push({
        id: `stall:${campaign.id}`,
        tone: route.tone,
        campaign: about,
        title: AGENCY_STALL_LABELS[stall.code],
        detail: stallCopy(stall, formatInstant).headline,
        at: 'paused_at' in stall ? stall.paused_at : null,
        action: route.action,
        to: campaignTabHref(route.tab, campaign.id),
      });
    }

    if (stats && campaign.status === 'running' && stall?.code !== 'auto_paused_abandonment') {
      const level = abandonmentAttention(stats);
      if (level) {
        const rate = rateText(statsAbandonmentRate(stats));
        const ceiling = ceilingPctText(stats.abandonment_ceiling_pct ?? 0);
        items.push({
          id: `abandonment:${campaign.id}`,
          tone: level === 'over' ? 'danger' : 'warning',
          campaign: about,
          title: level === 'over'
            ? `Abandonment ${rate} is over the ${ceiling} ceiling`
            : `Abandonment ${rate} is close to the ${ceiling} ceiling`,
          detail: 'Over the last 24 hours. Above the ceiling the guardrail pauses the campaign.',
          at: null,
          action: 'Open Health',
          to: campaignTabHref('health', campaign.id),
        });
      }
    }

    if (overdue !== null && overdue > 0) {
      items.push({
        id: `callbacks:${campaign.id}`,
        tone: 'danger',
        campaign: about,
        title: `${plural(overdue, 'callback')} overdue`,
        detail: 'Customers were promised these calls.',
        at: null,
        action: 'Open callbacks',
        to: campaignTabHref('callbacks', campaign.id),
      });
    }
  }

  const open = missed.available ? missed.count : null;
  if (open && open.open > 0) {
    const many = open.open_capped || open.open > 99;
    items.push({
      id: 'missed',
      tone: 'info',
      campaign: null,
      title: many
        ? 'More than 99 missed inbound calls to follow up'
        : `${plural(open.open, 'missed inbound call')} to follow up`,
      detail: 'Inbound calls in this account that reached nobody.',
      at: null,
      action: 'Open missed calls',
      to: '/agency/inbound/missed',
    });
  }

  // Stable: the loop above is already in campaign order.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => TONE_ORDER[a.item.tone] - TONE_ORDER[b.item.tone] || a.index - b.index)
    .map(({ item }) => item);
}

/** The sidebar badge's text: the count, "99+" past it, nothing for none or not yet known. */
export function attentionBadgeText(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

/** What a screen reader hears beside the Home entry. */
export function attentionBadgeLabel(count: number | null): string | null {
  const text = attentionBadgeText(count);
  if (!text) return null;
  if (text === '99+') return 'more than 99 need your attention';
  return count === 1 ? '1 needs your attention' : `${text} need your attention`;
}

/**
 * The active campaigns Home reads, and how many there were before the cap: the Campaigns page's
 * order (running, then stopping, then paused), so the cap drops the paused ones first.
 */
export function homeCampaigns(active: readonly AgencyCampaign[]): { campaigns: AgencyCampaign[]; total: number } {
  const sorted = sortCampaigns(active);
  return { campaigns: sorted.slice(0, HOME_CAMPAIGN_CAP), total: sorted.length };
}

// ── The floor ─────────────────────────────────────────────────────────────────

export interface HomeFloorRow {
  campaign: AgencyCampaign;
  /** Null when the stats carried no per-state counts: the row then shows agents live alone. */
  onCall: number | null;
  available: number | null;
  wrapup: number | null;
  onBreak: number | null;
  agentsLive: number;
  /** The rolling 24-hour rate, or why there is none. */
  abandonment: { text: string; level: 'near' | 'over' | null };
  to: string;
}

/**
 * The floor: one row per running campaign, and per paused or stopping one that still has
 * agents on it (they are on the floor whatever the campaign is doing). From `/stats`
 * `agents_by_state`; `reserved` (a call being connected to them) counts as on a call.
 */
export function homeFloor(reads: readonly HomeCampaignRead[]): HomeFloorRow[] {
  return reads.flatMap(({ campaign, stats }) => {
    if (!stats) return [];
    const agentsLive = stats.agents_live ?? 0;
    if (campaign.status !== 'running' && agentsLive <= 0) return [];
    const by = stats.agents_by_state;
    return [{
      campaign,
      onCall: by ? (by.on_call ?? 0) + (by.reserved ?? 0) : null,
      available: by ? (by.available ?? 0) : null,
      wrapup: by ? (by.wrapup ?? 0) : null,
      onBreak: by ? (by.break ?? 0) : null,
      agentsLive,
      abandonment: { text: rateText(statsAbandonmentRate(stats)), level: abandonmentAttention(stats) },
      to: campaignTabHref('agents', campaign.id),
    }];
  });
}

// ── Today so far ──────────────────────────────────────────────────────────────

/** The window "today so far" asks for: the viewer's local midnight up to now. */
export function todayWindow(now: Date): { from: string; to: string } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from: midnight.toISOString(), to: now.toISOString() };
}

export interface TodayTotals {
  dials: number;
  conversations: number;
  successes: number;
  talkSeconds: number;
  /** Campaigns that placed at least one dial today. */
  campaigns: number;
}

/**
 * The account's totals for today from one grouped read (one row per campaign that dialled).
 * Null when the server held rows back (`total_groups` past the rows served): a partial sum is
 * not a total, and this page does not print one.
 */
export function todayTotals(page: AgencyGroupPage): TodayTotals | null {
  if (page.total_groups > page.rows.length) return null;
  return page.rows.reduce<TodayTotals>(
    (sum, row) => ({
      dials: sum.dials + row.attempts,
      conversations: sum.conversations + row.connected,
      successes: sum.successes + row.successes,
      talkSeconds: sum.talkSeconds + row.talk_seconds,
      campaigns: sum.campaigns + 1,
    }),
    { dials: 0, conversations: 0, successes: 0, talkSeconds: 0, campaigns: 0 },
  );
}
