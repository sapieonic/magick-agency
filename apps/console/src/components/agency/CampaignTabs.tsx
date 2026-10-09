import { Link } from 'react-router-dom';
import { visibleCampaignTabs, type CampaignTabId } from '../../utils/agencyCampaignTabs';
import { isKnownCampaignStatus } from '../../utils/agencyCampaignControls';
import { trackAgencyCampaignTabViewed } from '../../analytics/events';
import type { Role } from '../../types/auth';
import styles from './CampaignTabs.module.css';

/**
 * The campaign workspace's section bar (`MAG-166`).
 *
 * ── Links, not `role="tab"` ─────────────────────────────────────────────────
 * Four of these sections are separate routes with their own data, their own
 * filters and their own deep links; the other three are panels of the detail
 * page. Under the ARIA tabs pattern all seven would have to be panels of one
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
   * `AgencyCampaign.status` itself (core's CHECK constraint is the authority,
   * not this build's `AgencyCampaignStatus` enum) — narrowed to the enum via
   * `isKnownCampaignStatus` right before the event fires, and simply skipped
   * for anything else. Optional for a second reason: three of the six host
   * pages render this bar as soon as they have a campaign `id`, before their
   * own campaign fetch resolves — `campaign?.status` is `undefined` for that
   * first render, and the click event is not fired with a guessed status
   * (see `CLAUDE.md`'s note against a hardcoded `'running'` fallback here).
   */
  campaignStatus?: string;
}

export function CampaignTabs({
  campaignId,
  active,
  role,
  liveAgentCount,
  campaignStatus,
}: CampaignTabsProps) {
  // Never empty and never a single tab: the three panel sections are ungated,
  // so every role that can open a campaign at all gets a real choice here.
  const tabs = visibleCampaignTabs(role);

  return (
    <nav className={styles.tabs} aria-label="Campaign sections" data-testid="campaign-tabs">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        const showCount = tab.id === 'agents' && typeof liveAgentCount === 'number' && liveAgentCount > 0;
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
            to={tab.path(campaignId)}
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
          </Link>
        );
      })}
    </nav>
  );
}

export default CampaignTabs;
