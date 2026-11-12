import { Link, useLocation } from 'react-router-dom';
import { useCampaignTabBadge } from '../../hooks/useCampaignTabBadges';
import { hasPermission } from '../../utils/permissions';
import {
  barTabFor,
  campaignTabHref,
  isCampaignPanel,
  visibleCampaignTabGroups,
  type CampaignTabId,
} from '../../utils/agencyCampaignTabs';
import { isKnownCampaignStatus } from '../../utils/agencyCampaignControls';
import { trackAgencyCampaignTabViewed } from '../../analytics/events';
import type { Role } from '../../types/auth';
import styles from './CampaignTabs.module.css';

/**
 * The campaign workspace's section bar.
 *
 * ── Links, not `role="tab"` ─────────────────────────────────────────────────
 * Five of these sections are separate routes with their own data, their own
 * filters and their own deep links; the other five are panels of the detail
 * page. Under the ARIA tabs pattern all ten would have to be panels of one
 * mounted widget, and a screen-reader user pressing the arrow keys would be
 * told a page navigation was a panel swap. So this is what it actually is:
 * navigation, with `aria-current="page"` marking where you are. The visual
 * language is still a tab strip, because that is what it behaves like.
 *
 * ── Three labelled groups, one level (decision IN14) ───────────────────────
 * Monitor, Data and Set up are labels with a divider between them, not menus:
 * each group is a `role="group"` named by its label, and every tab is still a
 * direct link. On a phone the bar scrolls sideways and the labels hide; the
 * dividers keep the grouping.
 *
 * ── Where it sits ──────────────────────────────────────────────────────────
 * Directly below whatever identifies the PAGE, and above the section's own
 * content — which is not the same pixel offset on every screen, and the
 * comment here used to claim it was. On the detail page the campaign's name
 * and its lifecycle controls are that identity, so the bar follows them (and
 * follows a stall diagnosis, which is worth reading before choosing a
 * section). On the four standalone screens the breadcrumb is the only campaign
 * identity, so the bar follows that and their own `<h1>` belongs to the
 * section below it. Switching between the two groups therefore moves the bar
 * vertically; making it truly fixed would mean giving those four a
 * campaign-level header of their own, which is a larger change than this one.
 */
export interface CampaignTabsProps {
  campaignId: string;
  /**
   * The screen currently showing. Soft-phone calls marks Call log (its second
   * view) and Activity marks no tab (it is the header's History), via
   * `barTabFor`; the analytics event still names the screen itself.
   */
  active: CampaignTabId;
  /** Drives which tabs render at all; see `CAMPAIGN_TABS` for each gate. */
  role: Role | undefined;
  /**
   * Agents on shift now (`agentsOnShift`: the floor's rows that are not offline),
   * from a host that already polls the stats (the detail page; null until it
   * knows). Left out, the bar takes the campaign's shared count, reading it
   * itself when none is fresh, so the Agents badge is on every campaign screen,
   * not only on the five the detail page draws.
   *
   * The badge is a "someone is there" signal rather than a read-out, so it
   * renders only for a positive count. `null` ("not known here", which is NOT
   * zero) and a known `0` both render nothing; `AgentFloor` itself tells those
   * two apart for the supervisor who opens it.
   */
  agentsOnShift?: number | null;
  /**
   * For `trackAgencyCampaignTabViewed`, fired on click. `string`, matching
   * `AgencyCampaign.status` itself (the API's CHECK constraint is the authority,
   * not this build's `AgencyCampaignStatus` enum) — narrowed to the enum via
   * `isKnownCampaignStatus` right before the event fires, and simply skipped
   * for anything else. Optional for a second reason: three of the six host
   * pages render this bar as soon as they have a campaign `id`, before their
   * own campaign fetch resolves — `campaign?.status` is `undefined` for that
   * first render, and the click event is not fired with a guessed status
   * (no hardcoded `'running'` fallback).
   */
  campaignStatus?: string;
  /**
   * The callbacks overdue now, for the Callbacks tab's badge, from a host that
   * already polls it (the detail page; null until it knows). Left out, the bar
   * takes the shared count as above, so the badge is on every campaign screen
   * and leaving the detail page never makes the warning look resolved.
   */
  callbacksOverdue?: number | null;
}

export function CampaignTabs({
  campaignId,
  active,
  role,
  agentsOnShift: knownOnShift,
  campaignStatus,
  callbacksOverdue,
}: CampaignTabsProps) {
  const overdue = useCallbacksOverdue(campaignId, role, callbacksOverdue);
  const onShift = useAgentsOnShift(campaignId, knownOnShift);
  // The range rides between panels (`campaignTabHref`); a standalone screen's
  // query string is its own filters, never a range, so it rides nowhere.
  const { search } = useLocation();
  const carrySearch = isCampaignPanel(active) ? search : '';
  // Never empty: Agents is ungated, so every role that can open a campaign gets
  // at least that. A viewer or operator gets ONLY that (the analytic tabs and the spine
  // tabs floor at `agency.supervise`), and the bar still says where they are.
  // No bar tab carries a flag since Soft-phone calls moved into Call log
  // (`CallLogViews` reads that flag), so none is passed.
  const groups = visibleCampaignTabGroups(role);
  const current = barTabFor(active);

  return (
    <nav className={styles.tabs} aria-label="Campaign sections" data-testid="campaign-tabs">
      {groups.map((group) => {
        const labelId = `campaign-tab-group-${group.id}-${campaignId}`;
        return (
          <div
            key={group.id}
            className={styles.group}
            role="group"
            aria-labelledby={labelId}
            data-testid={`campaign-tab-group-${group.id}`}
          >
            <span id={labelId} className={styles.groupLabel}>
              {group.label}
            </span>
            {group.tabs.map((tab) => {
              const isActive = tab.id === current;
              const badge = tabBadge(tab.id, onShift, overdue);
              return (
                /*
                  A plain `Link`, deliberately not a `NavLink`. NavLink derives
                  "active" from a prefix match, which makes `…/campaigns/:id` active
                  on every section beneath it — two tabs marked `aria-current="page"`
                  at once — and it writes that attribute itself, over anything passed
                  in. The section that is rendering is the only thing that knows which
                  tab it is (`…/contacts/add` is Contacts), so it says so via `active`.
                */
                <Link
                  key={tab.id}
                  to={campaignTabHref(tab.id, campaignId, carrySearch)}
                  className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  title={tab.hint}
                  /*
                    One name for the link, said once: "Callbacks, 14 overdue". The
                    badge's numeral is hidden from assistive tech, so the count is
                    never read twice (it was: "Callbacks 14 , 14 overdue").
                  */
                  aria-label={badge ? `${tab.label}, ${badge.label}` : undefined}
                  data-testid={`campaign-tab-${tab.id}`}
                  onClick={() => {
                    // Undefined or unrecognised ⇒ skip rather than guess (prop doc).
                    if (campaignStatus && isKnownCampaignStatus(campaignStatus)) {
                      trackAgencyCampaignTabViewed({
                        campaign_id: campaignId,
                        tab: tab.id,
                        from_tab: active,
                        campaign_status: campaignStatus,
                      });
                    }
                  }}
                >
                  {tab.label}
                  {badge && (
                    <span
                      className={`${styles.badge} ${badge.alert ? styles.badgeAlert : ''}`}
                      aria-hidden="true"
                      data-testid={badge.testId}
                    >
                      {badge.count}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

export default CampaignTabs;

interface TabBadge {
  count: number;
  /** What the count is, for the link's accessible name. */
  label: string;
  /** A warning (overdue callbacks) rather than a head count. */
  alert: boolean;
  testId: string;
}

/** A tab's badge, or null: only Agents (on shift) and Callbacks (overdue), only for a positive count. */
export function tabBadge(tab: CampaignTabId, onShift: number | null, overdue: number | null): TabBadge | null {
  if (tab === 'agents' && onShift !== null && onShift > 0) {
    return { count: onShift, label: `${onShift} on shift`, alert: false, testId: 'campaign-tab-agents-count' };
  }
  // In the danger tone: unlike the floor count this one is a warning.
  if (tab === 'callbacks' && overdue !== null && overdue > 0) {
    return { count: overdue, label: `${overdue} overdue`, alert: true, testId: 'campaign-tab-callbacks-alert' };
  }
  return null;
}

/**
 * Agents on shift for the badge: the host's count when it has one, else the
 * campaign's shared count (`useCampaignTabBadge`: read once here unless another
 * screen read it in the last 30 s). The stats read is gated as the campaign
 * itself, so every role that sees the bar may make it.
 */
function useAgentsOnShift(campaignId: string, known: number | null | undefined): number | null {
  const shared = useCampaignTabBadge('onShift', campaignId, known === undefined);
  return known !== undefined ? known : shared;
}

/**
 * The overdue callbacks for the badge: the host's count when it has one, else
 * the campaign's shared count (the detail page publishes its own). Supervisors
 * only — the Callbacks tab is theirs, and the read 403s below them.
 */
function useCallbacksOverdue(campaignId: string, role: Role | undefined, known: number | null | undefined): number | null {
  const shared = useCampaignTabBadge('overdue', campaignId, known === undefined && hasPermission(role, 'agency.supervise'));
  return known !== undefined ? known : shared;
}
