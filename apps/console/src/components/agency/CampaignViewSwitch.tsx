import { Link } from 'react-router-dom';
import { campaignTabHref, type CampaignTabId } from '../../utils/agencyCampaignTabs';
import styles from './CallLogViews.module.css';

interface CampaignViewSwitchProps<Id extends CampaignTabId> {
  campaignId: string;
  /** The views the reader can open, in segment order (`visibleCallLogViews`, `visibleCallsViews`). */
  views: readonly { id: Id; label: string }[];
  /** The view showing. */
  active: Id;
  /** The control's accessible name ("Call log views"). */
  ariaLabel: string;
  /** The control's test id; each link's is `<linkTestIdPrefix>-<view id>`. */
  testId: string;
  linkTestIdPrefix: string;
  /** The panels' range (`?range=…`), carried to a view that is a panel; others own their query. */
  search?: string;
  /** A count beside a view's label ("Live 3"); null or absent says nothing. */
  counts?: Partial<Record<Id, number | null>>;
}

/**
 * A campaign screen's views as a segmented control (Call log's "Dialler calls | Soft-phone
 * calls", IN14; the Calls tab's "Summary | Live", `docs/listening.md` §9): links with
 * `aria-current`, not a radio group, because picking one is a navigation and each view is its
 * own page and URL. With one view left there is nothing to choose, so nothing renders.
 */
export function CampaignViewSwitch<Id extends CampaignTabId>({
  campaignId,
  views,
  active,
  ariaLabel,
  testId,
  linkTestIdPrefix,
  search = '',
  counts,
}: CampaignViewSwitchProps<Id>) {
  if (views.length < 2) return null;

  return (
    <nav className={styles.views} aria-label={ariaLabel} data-testid={testId}>
      {views.map((view) => {
        const isActive = view.id === active;
        const count = counts?.[view.id];
        return (
          <Link
            key={view.id}
            to={campaignTabHref(view.id, campaignId, search)}
            className={`${styles.view} ${isActive ? styles.viewActive : ''}`}
            aria-current={isActive ? 'page' : undefined}
            data-testid={`${linkTestIdPrefix}-${view.id}`}
          >
            {view.label}
            {count !== undefined && count !== null ? <span className={styles.count}>&nbsp;{count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
