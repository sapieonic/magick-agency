import type { Permission } from './permissions';
import { hasPermission } from './permissions';
import { SOFTPHONE_FLAG } from './softphone/softphoneFlag';
import type { Role } from '../types/auth';

/**
 * The campaign workspace's sections.
 *
 * ── Why this is a tab bar and not a page ────────────────────────────────────
 * The detail page used to be one scroll carrying eleven counters, four derived
 * performance read-outs, the account guardrails, the live agent floor and the
 * staffing roster — with the four *other* campaign screens hanging off it as
 * secondary buttons wedged into the same row as the lifecycle controls. Nine
 * affordances in one header, and the one that stops a live campaign sat beside
 * the one that opens an audit trail.
 *
 * Splitting it means a supervisor reads one question at a time, and the header
 * is left holding only the things that CHANGE the campaign.
 *
 * ── Sections are URLs, not component state ──────────────────────────────────
 * Every tab is a real path, so a section survives a refresh, can be sent to a
 * colleague, and answers the browser's back button. Five of them (`overview`,
 * `calls`, `agents`, `callbacks`, `health`) are panels of the detail page
 * itself; the others are the standalone screens that already existed at their
 * own routes and are unchanged apart from growing this bar.
 *
 * ── Overview first, one tab per question (decision IN13) ────────────────────
 * Insights (IN1) replaced Overview and Performance with one analytic surface,
 * which then grew to fourteen stacked sections a supervisor had to scroll to
 * learn what was on it. It is now split by the question each part answers:
 * Overview (what needs me, and where the list stands), Calls, Agents,
 * Callbacks and Health, each about one screen. They are still one surface —
 * one component and one set of reads behind all five, so they cannot disagree.
 * Settings carries the lifecycle and upload history.
 *
 * The analytic tabs are floored at `agency.supervise`, the floor of every
 * insights read. The old URLs (`/agency/campaigns/:id`, `…/performance`,
 * `…/insights`) redirect to Overview for a supervisor and to Agents, the one
 * panel every campaign reader can open, for everyone else
 * (`campaignLandingPath`).
 *
 * ── Grouped, still flat (decision IN14) ───────────────────────────────────────
 * The bar reads as three labelled groups: Monitor (Overview, Calls, Agents,
 * Callbacks, Health), Data (Contacts, Call log) and Set up (Settings). The
 * groups are labels and dividers, never menus: every tab is still one click
 * and one question. Two screens left the bar to make room for the grouping:
 * Soft-phone calls is the second view of Call log (`CALL_LOG_VIEWS`, a
 * segmented control on both list pages), and Activity is the campaign
 * header's History button. Both keep their URLs and their gates, and stay in
 * `CAMPAIGN_TABS` with `group: null`, so a link to either and the analytics
 * event still name them.
 *
 * ── The permission on each tab is the one the API enforces ───────────────────
 * Not a looser proxy for it. A tab that renders and then 403s on arrival is a
 * worse answer than no tab, which is the same rule the lifecycle controls
 * follow.
 */
export type CampaignTabId =
  | 'overview'
  | 'calls'
  | 'agents'
  | 'callbacks'
  | 'health'
  | 'contacts'
  | 'attempts'
  | 'manual'
  | 'activity'
  | 'settings';

/** The tabs the detail page renders itself, in tab order. */
export const CAMPAIGN_PANEL_IDS = ['overview', 'calls', 'agents', 'callbacks', 'health'] as const;
export type CampaignPanelId = (typeof CAMPAIGN_PANEL_IDS)[number];

export function isCampaignPanel(id: string): id is CampaignPanelId {
  return (CAMPAIGN_PANEL_IDS as readonly string[]).includes(id);
}

/** The labelled groups of the bar, in bar order (decision IN14). */
export type CampaignTabGroupId = 'monitor' | 'data' | 'setup';

export const CAMPAIGN_TAB_GROUPS: readonly { id: CampaignTabGroupId; label: string }[] = [
  { id: 'monitor', label: 'Monitor' },
  { id: 'data', label: 'Data' },
  { id: 'setup', label: 'Set up' },
];

export interface CampaignTabDefinition {
  id: CampaignTabId;
  label: string;
  /**
   * The bar group the tab sits in, or `null` for a campaign screen reached
   * another way: Soft-phone calls (Call log's second view) and Activity (the
   * header's History button).
   */
  group: CampaignTabGroupId | null;
  /** The question the section answers — surfaced as the link's tooltip. */
  hint: string;
  /**
   * What the API gates the reads behind this tab on, or `null` when the tab is
   * as readable as the campaign page itself.
   */
  permission: Permission | null;
  /** Path relative to the agency workspace root. */
  path: (campaignId: string) => string;
  /** A client-exposed flag that must also be on (the soft phone's tab). */
  flag?: string;
}

export const CAMPAIGN_TABS: CampaignTabDefinition[] = [
  {
    id: 'overview',
    group: 'monitor',
    label: 'Overview',
    hint: 'What needs your attention, the headline numbers and where the list stands',
    // Every `…/insights/*` read is floored at `agency.supervise`.
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/overview`,
  },
  {
    id: 'calls',
    group: 'monitor',
    label: 'Calls',
    hint: 'How dials ended, what agents marked them, and the trends over time',
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/calls`,
  },
  {
    id: 'agents',
    group: 'monitor',
    label: 'Agents',
    hint: 'Who is on the floor, who is assigned, and how each agent is doing',
    // The floor and staffing are ungated; the performance tables below them are
    // rendered only for `agency.supervise`, the floor of their reads.
    permission: null,
    path: (id) => `/agency/campaigns/${id}/agents`,
  },
  {
    id: 'callbacks',
    group: 'monitor',
    label: 'Callbacks',
    hint: 'The callbacks promised to customers: kept, late, missed and still open',
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/callbacks`,
  },
  {
    id: 'health',
    group: 'monitor',
    label: 'Health',
    hint: 'Abandonment, stalls, caller IDs, carrier failures and recording',
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/health`,
  },
  {
    id: 'contacts',
    group: 'data',
    label: 'Contacts',
    hint: 'Every contact on this campaign and where each one got to',
    // The API floors the roster read on `agency.supervise`.
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/contacts`,
  },
  {
    id: 'attempts',
    group: 'data',
    // "Call attempts" until IN14; the URL stays `/attempts`.
    label: 'Call log',
    hint: 'Every dial this campaign placed, including the ones that never reached an agent',
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/attempts`,
  },
  {
    id: 'manual',
    group: null,
    label: 'Soft-phone calls',
    hint: 'Calls agents placed from the soft phone and logged to this campaign',
    // The account's soft-phone list, tag-filtered: the server scopes it to the
    // whole account for `agency.supervise`, the same floor as the dialler's
    // calls. Not a tab since IN14: the second view of Call log.
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/manual-calls`,
    flag: SOFTPHONE_FLAG,
  },
  {
    id: 'activity',
    group: null,
    label: 'Activity',
    hint: 'Who did what on this campaign, and when',
    // Not a tab since IN14: the campaign header's History button opens it.
    /*
      `audit.read`, NOT `agency.supervise`. The two share a floor today
      (`account_admin`, since `audit.read` was lowered precisely so a
      supervisor could read the trail of a campaign they control), so in
      practice the same people see both — but they name different questions and
      each tab has to follow its own gate if either floor ever moves.
    */
    permission: 'audit.read',
    path: (id) => `/agency/campaigns/${id}/activity`,
  },
  {
    id: 'settings',
    group: 'setup',
    label: 'Settings',
    hint: 'Caller IDs, recording and retry behaviour, the lifecycle and the uploads',
    /*
      Deliberately the gate the old header button carried, not the looser
      `agency.campaigns.write` the form's own fields check. Moving a link
      into a tab bar should not change who can see it; if the settings screen
      should be readable further down the hierarchy that is its own decision.
    */
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/settings`,
  },
];

/**
 * A tab's link. The panels share one range (`?range=…`), so `search` rides along
 * to them: a supervisor reading Today's calls who opens Agents wants Today's
 * agents. The standalone screens own their own query strings and never get it.
 */
export function campaignTabHref(tab: CampaignTabId, campaignId: string, search = ''): string {
  const path = CAMPAIGN_TABS.find((t) => t.id === tab)!.path(campaignId);
  return isCampaignPanel(tab) ? `${path}${search}` : path;
}

/** Whether a role (and the flags) can open a campaign screen, tab or not. */
export function canOpenCampaignScreen(
  id: CampaignTabId,
  role: Role | undefined,
  isFlagEnabled: (flag: string) => boolean = () => false,
): boolean {
  const tab = CAMPAIGN_TABS.find((t) => t.id === id);
  if (!tab) return false;
  return (tab.permission === null || hasPermission(role, tab.permission))
    && (!tab.flag || isFlagEnabled(tab.flag));
}

/** The bar's tabs a given role may actually reach, in tab order. */
export function visibleCampaignTabs(
  role: Role | undefined,
  isFlagEnabled: (flag: string) => boolean = () => false,
): CampaignTabDefinition[] {
  return CAMPAIGN_TABS.filter(
    (tab) => tab.group !== null && canOpenCampaignScreen(tab.id, role, isFlagEnabled),
  );
}

export interface CampaignTabGroup {
  id: CampaignTabGroupId;
  label: string;
  tabs: CampaignTabDefinition[];
}

/**
 * The bar as it renders: each group with the tabs a role can reach, in bar
 * order, and a group left with none dropped (a viewer gets Monitor with Agents
 * alone, not two empty labels).
 */
export function visibleCampaignTabGroups(
  role: Role | undefined,
  isFlagEnabled: (flag: string) => boolean = () => false,
): CampaignTabGroup[] {
  const tabs = visibleCampaignTabs(role, isFlagEnabled);
  return CAMPAIGN_TAB_GROUPS
    .map((group) => ({ ...group, tabs: tabs.filter((tab) => tab.group === group.id) }))
    .filter((group) => group.tabs.length > 0);
}

/**
 * The bar tab marked current while a screen shows: Call log for both of its
 * views, and none for Activity, which is the header's History and not a tab.
 */
export function barTabFor(id: CampaignTabId): CampaignTabId | null {
  if (id === 'manual') return 'attempts';
  if (id === 'activity') return null;
  return id;
}

/** Call log's two views, in segment order (decision IN14). */
export type CallLogViewId = 'attempts' | 'manual';

export const CALL_LOG_VIEWS: readonly { id: CallLogViewId; label: string }[] = [
  { id: 'attempts', label: 'Dialler calls' },
  { id: 'manual', label: 'Soft-phone calls' },
];

/** The Call log views a role can open; each is gated as its screen (`CAMPAIGN_TABS`). */
export function visibleCallLogViews(
  role: Role | undefined,
  isFlagEnabled: (flag: string) => boolean = () => false,
): { id: CallLogViewId; label: string }[] {
  return CALL_LOG_VIEWS.filter((view) => canOpenCampaignScreen(view.id, role, isFlagEnabled));
}

/**
 * Where `/agency/campaigns/:id` (and the retired `…/performance` and `…/insights`)
 * lands a role: Overview when its reads would answer, else the Agents panel, which
 * every role that can open a campaign can read. Never a tab that would 403 on arrival.
 */
export function campaignLandingPath(campaignId: string, role: Role | undefined): string {
  const overview = CAMPAIGN_TABS.find((tab) => tab.id === 'overview');
  const canOverview = overview?.permission ? hasPermission(role, overview.permission) : true;
  return canOverview ? `/agency/campaigns/${campaignId}/overview` : `/agency/campaigns/${campaignId}/agents`;
}

/**
 * Which panel of the detail page a path is asking for.
 *
 * Derived from the URL rather than passed in as a route prop so that the two
 * panel routes share one source of truth.
 *
 * ── Read by POSITION, never by the last segment ─────────────────────────────
 * The panel is the segment that follows the campaign id — `agency/campaigns/
 * <id>/<panel>` — and nothing else. Matching the tail of the path instead
 * ("does it end in `agents`?") conflates a campaign id with a panel keyword:
 * a campaign whose id is literally `agents` would render the Agents panel on
 * the wrong URL, and highlight the wrong tab while doing it. The server owns
 * the id format and this repo cannot see it, so the id is treated as opaque.
 *
 * Anything unrecognised falls back to Agents, the one panel every campaign
 * reader can open, rather than rendering nothing. (The bare campaign path never
 * reaches the page: the router redirects it with `campaignLandingPath`.)
 */
export function campaignPanelFromPath(pathname: string): CampaignPanelId {
  const segments = pathname.split('/').filter(Boolean);
  // The first `agency/campaigns` pair anchors the depth. An id of `campaigns`
  // sits after it and so cannot be mistaken for the anchor itself.
  const anchor = segments.findIndex(
    (segment, i) => segment === 'campaigns' && segments[i - 1] === 'agency',
  );
  if (anchor === -1) return 'agents';
  const panel = segments[anchor + 2];
  return panel !== undefined && isCampaignPanel(panel) ? panel : 'agents';
}
