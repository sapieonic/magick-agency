import type { Permission } from './permissions';
import { hasPermission } from './permissions';
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
 * colleague, and answers the browser's back button. Two of them (`insights`,
 * `agents`) are panels of the detail page itself; the others are the
 * standalone screens that already existed at their own routes and are
 * unchanged apart from growing this bar.
 *
 * ── Insights replaced Overview and Performance (decision IN1) ──────────────
 * One analytic surface, so two screens can no longer disagree about the same
 * campaign. Its reads are floored at `agency.supervise`, so the tab is too:
 * the old Overview and Performance were ungated and their chart 403'd for a
 * viewer or operator. Their URLs (`/agency/campaigns/:id` and `…/performance`)
 * redirect to Insights for a supervisor and to Agents, the one panel every
 * campaign reader can open, for everyone else (`campaignLandingPath`).
 *
 * ── The permission on each tab is the one the API enforces ───────────────────
 * Not a looser proxy for it. A tab that renders and then 403s on arrival is a
 * worse answer than no tab, which is the same rule the lifecycle controls
 * follow.
 */
export type CampaignTabId =
  | 'insights'
  | 'agents'
  | 'contacts'
  | 'attempts'
  | 'manual'
  | 'activity'
  | 'settings';

/** The two tabs the detail page renders itself, in tab order. */
export const CAMPAIGN_PANEL_IDS = ['insights', 'agents'] as const;
export type CampaignPanelId = (typeof CAMPAIGN_PANEL_IDS)[number];

export interface CampaignTabDefinition {
  id: CampaignTabId;
  label: string;
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
    id: 'insights',
    label: 'Insights',
    hint: 'The whole campaign in one place: progress, allocation, calls, agents, trends and health',
    // Every `…/insights/*` read is floored at `agency.supervise`.
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/insights`,
  },
  {
    id: 'agents',
    label: 'Agents',
    hint: 'Who is on the floor right now, and who is assigned to this campaign',
    permission: null,
    path: (id) => `/agency/campaigns/${id}/agents`,
  },
  {
    id: 'contacts',
    label: 'Contacts',
    hint: 'Every contact on this campaign and where each one got to',
    // The API floors the roster read on `agency.supervise`.
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/contacts`,
  },
  {
    id: 'attempts',
    label: 'Call attempts',
    hint: 'Every dial this campaign placed, including the ones that never reached an agent',
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/attempts`,
  },
  {
    id: 'manual',
    label: 'Soft-phone calls',
    hint: 'Calls agents placed from the soft phone and logged to this campaign',
    // The account's soft-phone list, tag-filtered: the server scopes it to the
    // whole account for `agency.supervise`, the same floor as Call attempts.
    permission: 'agency.supervise',
    path: (id) => `/agency/campaigns/${id}/manual-calls`,
    flag: 'agency_softphone_enabled',
  },
  {
    id: 'activity',
    label: 'Activity',
    hint: 'Who did what on this campaign, and when',
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
    label: 'Settings',
    hint: 'Caller IDs, recording and retry behaviour for this campaign',
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

/** The tabs a given role may actually reach, in tab order. */
export function visibleCampaignTabs(
  role: Role | undefined,
  isFlagEnabled: (flag: string) => boolean = () => false,
): CampaignTabDefinition[] {
  return CAMPAIGN_TABS.filter(
    (tab) =>
      (tab.permission === null || hasPermission(role, tab.permission))
      && (!tab.flag || isFlagEnabled(tab.flag)),
  );
}

/**
 * Where `/agency/campaigns/:id` (and the retired `…/performance`) lands a role:
 * Insights when its reads would answer, else the Agents panel, which every role
 * that can open a campaign can read. Never a tab that would 403 on arrival.
 */
export function campaignLandingPath(campaignId: string, role: Role | undefined): string {
  const insights = CAMPAIGN_TABS.find((tab) => tab.id === 'insights');
  const canInsights = insights?.permission ? hasPermission(role, insights.permission) : true;
  return canInsights ? `/agency/campaigns/${campaignId}/insights` : `/agency/campaigns/${campaignId}/agents`;
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
  return CAMPAIGN_PANEL_IDS.find((id) => id === panel) ?? 'agents';
}
