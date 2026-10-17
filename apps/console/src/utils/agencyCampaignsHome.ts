import type { AgencyCampaign, AgencyCampaignStats } from '../types/agency-campaign';
import { describeIsoDays, hhmm } from './format/weekdays';

/**
 * Pure helpers for the campaigns home (`AgencyCampaignsPage`): which group a
 * campaign falls in, the order the list is read in, and the one-line schedule
 * shown on each row.
 *
 * Kept out of the page so the grouping rules can be tested without rendering,
 * and so the filter tabs and the list can't disagree about where a status belongs.
 */

/**
 * The three groups a supervisor scans for.
 *
 * `active` is every campaign that has started and not finished: `running`,
 * `stopping` and `paused`. A paused campaign is grouped here, not under finished:
 * it resumes where it left off, and its in-flight calls are still draining. Only
 * `running` is limited to one per account (the `uq_agency_campaign_running`
 * index); any number can be paused. `other` holds a status this build doesn't
 * know. It is listed under All, never placed in a guessed group.
 */
type CampaignGroup = 'active' | 'draft' | 'finished' | 'other';

const GROUP_BY_STATUS: Record<string, CampaignGroup> = {
  running: 'active',
  stopping: 'active',
  paused: 'active',
  draft: 'draft',
  completed: 'finished',
  stopped: 'finished',
};

export function campaignGroup(status: string): CampaignGroup {
  return GROUP_BY_STATUS[status] ?? 'other';
}

/**
 * Whether a campaign's live numbers should keep refreshing.
 *
 * Used by this page's cards and by the campaign detail page, so the two cannot
 * disagree. Status alone is wrong: a paused campaign still has calls draining
 * and agents whose state changes, and a card keyed on status froze the moment
 * Pause was pressed. So it is the status, OR live attempts, OR anyone on the
 * floor. A paused campaign with none of those is read once and left alone,
 * which is what keeps an account with many paused campaigns from polling all of
 * them.
 *
 * "Anyone on the floor" is the roster when the payload carries one, and
 * `agents_live` when it does not: `agents` is optional on the wire, and
 * `undefined` there means "no roster in this payload", not "nobody here".
 */
export function needsPolling(
  status: string,
  stats: Pick<AgencyCampaignStats, 'attempts_live' | 'agents' | 'agents_live'> | null,
): boolean {
  if (status === 'running' || status === 'stopping') return true;
  const onFloor = stats?.agents ? stats.agents.length : (stats?.agents_live ?? 0);
  return (stats?.attempts_live ?? 0) > 0 || onFloor > 0;
}

export type CampaignFilter = 'all' | 'active' | 'draft' | 'finished';

export type CampaignCounts = Record<CampaignFilter, number>;

export function countCampaigns(campaigns: readonly AgencyCampaign[]): CampaignCounts {
  const counts: CampaignCounts = { all: campaigns.length, active: 0, draft: 0, finished: 0 };
  for (const c of campaigns) {
    const group = campaignGroup(c.status);
    if (group !== 'other') counts[group] += 1;
  }
  return counts;
}

/*
  List order: active first (running, then stopping, then paused), then drafts,
  then finished campaigns with the most recently ended first. Anything else keeps
  the API's own order (newest first): the sort is stable, so a draft created a
  moment ago stays at the top of the drafts.
*/
const STATUS_RANK: Record<string, number> = {
  running: 0,
  stopping: 1,
  paused: 2,
  draft: 3,
  completed: 4,
  stopped: 4,
};

function time(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function sortCampaigns(campaigns: readonly AgencyCampaign[]): AgencyCampaign[] {
  return campaigns.slice().sort((a, b) => {
    const rank = (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5);
    if (rank !== 0) return rank;
    return time(b.ended_at) - time(a.ended_at);
  });
}

export function filterCampaigns(
  campaigns: readonly AgencyCampaign[],
  filter: CampaignFilter,
  query: string,
): AgencyCampaign[] {
  const needle = query.trim().toLowerCase();
  return campaigns.filter(
    (c) =>
      (filter === 'all' || campaignGroup(c.status) === filter)
      && (needle === '' || c.name.toLowerCase().includes(needle)),
  );
}

// ── The schedule line ───────────────────────────────────────────────────────

/**
 * ISO days (1 = Monday … 7 = Sunday) as the shortest honest phrase: "Every day",
 * "Mon–Fri", "Mon, Wed, Fri" — `describeIsoDays`, shared with the campaign
 * builder's echo. Out-of-range values are dropped rather than printed, and a list
 * with nothing valid left in it says nothing at all.
 */
export function callingDaysLabel(days: readonly number[] | undefined): string | null {
  return describeIsoDays(days);
}

/**
 * "09:00–18:00 · Mon–Fri", or `null` when the campaign carries no calling
 * window. The timezone is left to the detail page: on a row it is noise, and
 * cutting `Asia/Kolkata` short would be worse than leaving it out.
 */
export function scheduleLabel(campaign: AgencyCampaign): string | null {
  const { calling_window_start: start, calling_window_end: end } = campaign;
  const days = callingDaysLabel(campaign.calling_days);
  const window = start && end ? `${hhmm(start)}–${hhmm(end)}` : null;
  const parts = [window, days].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' · ') : null;
}
