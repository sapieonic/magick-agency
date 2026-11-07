import { useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { getInsightsAllocation } from '../../api/agencyInsights';
import { useTenant } from '../../contexts/TenantContext';
import { hasPermission } from '../../utils/permissions';
import { campaignTabHref, isCampaignPanel, visibleCampaignTabs, type CampaignTabId } from '../../utils/agencyCampaignTabs';
import { isKnownCampaignStatus } from '../../utils/agencyCampaignControls';
import { trackAgencyCampaignTabViewed } from '../../analytics/events';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
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
  /** The section currently on screen. */
  active: CampaignTabId;
  /** Drives which tabs render at all; see `CAMPAIGN_TABS` for each gate. */
  role: Role | undefined;
  /**
   * Live agents on the floor right now, when the caller happens to know.
   *
   * The badge is a "someone is there" signal rather than a read-out, so it
   * renders only for a positive count. `null`/`undefined` — "not known here",
   * which is NOT zero — and a known `0` both render nothing: an empty floor
   * and an unread one are equally not worth a numeral on a tab, and the tab is
   * not where either gets diagnosed. `AgentFloor` itself tells those two apart
   * (`floor-empty` vs `floor-unavailable`) for the supervisor who opens it.
   */
  liveAgentCount?: number | null;
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
   * reads it once itself, so the badge is on every campaign screen and leaving
   * the detail page never makes the warning look resolved.
   */
  callbacksOverdue?: number | null;
}

export function CampaignTabs({
  campaignId,
  active,
  role,
  liveAgentCount,
  campaignStatus,
  callbacksOverdue,
}: CampaignTabsProps) {
  const overdue = useCallbacksOverdue(campaignId, role, callbacksOverdue);
  // The range rides between panels (`campaignTabHref`); a standalone screen's
  // query string is its own filters, never a range, so it rides nowhere.
  const { search } = useLocation();
  const carrySearch = isCampaignPanel(active) ? search : '';
  // Never empty: Agents is ungated, so every role that can open a campaign gets
  // at least that. A viewer or operator gets ONLY that (the analytic tabs and the spine
  // tabs floor at `agency.supervise`), and the bar still says where they are.
  const softphone = useFeatureFlagEnabled(SOFTPHONE_FLAG);
  const tabs = visibleCampaignTabs(role, (flag) => flag === SOFTPHONE_FLAG && softphone);

  return (
    <nav className={styles.tabs} aria-label="Campaign sections" data-testid="campaign-tabs">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        const showCount = tab.id === 'agents' && typeof liveAgentCount === 'number' && liveAgentCount > 0;
        // Rendered only for a positive count, in the danger tone: unlike the
        // floor count this one is a warning, not a "someone is there".
        const alert = tab.id === 'callbacks' && overdue !== null && overdue > 0
          ? { count: overdue, label: `${overdue} overdue` }
          : null;
        const showAlert = alert !== null;
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
            {showCount && (
              <span className={styles.badge} data-testid="campaign-tab-agents-count">
                {liveAgentCount}
              </span>
            )}
            {showAlert && (
              <span className={`${styles.badge} ${styles.badgeAlert}`} data-testid={`campaign-tab-${tab.id}-alert`}>
                <span aria-hidden="true">{alert.count}</span>
                <span className="sr-only">{`, ${alert.label}`}</span>
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

export default CampaignTabs;

/**
 * The overdue callbacks for the badge: the host's count when it has one, else
 * one read of the allocation here (not polled: a standalone screen is a short
 * visit, and the detail page polls it). Supervisors only — the Callbacks tab is
 * theirs, and the read 403s below them.
 */
function useCallbacksOverdue(campaignId: string, role: Role | undefined, known: number | null | undefined): number | null {
  const { tenantId, accountId } = useTenant();
  const read = known === undefined && hasPermission(role, 'agency.supervise') && Boolean(tenantId && accountId);
  const fetchAllocation = useCallback(
    () => getInsightsAllocation(campaignId, tenantId ?? undefined, accountId ?? undefined),
    [campaignId, tenantId, accountId],
  );
  const allocation = useAsyncResource(fetchAllocation, { initialData: null, enabled: read });
  if (known !== undefined) return known;
  return read ? allocation.data?.totals.callbacks_overdue ?? null : null;
}
