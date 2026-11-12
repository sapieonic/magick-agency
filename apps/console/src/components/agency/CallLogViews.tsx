import { Link } from 'react-router-dom';
import { campaignTabHref, visibleCallLogViews, type CallLogViewId } from '../../utils/agencyCampaignTabs';
import { useGateReaders } from '../../hooks/useGateReaders';
import type { Role } from '../../types/auth';
import styles from './CallLogViews.module.css';

interface CallLogViewsProps {
  campaignId: string;
  /** The view showing: `/attempts` (Dialler calls) or `/manual-calls` (Soft-phone calls). */
  active: CallLogViewId;
  role: Role | undefined;
}

/**
 * Call log's two views (decision IN14): "Dialler calls" (`…/attempts`) and "Soft-phone
 * calls" (`…/manual-calls`), each still its own page and URL. Links with
 * `aria-current`, not a radio group: picking one is a navigation.
 *
 * Each view is gated as its screen (`CAMPAIGN_TABS`); Soft-phone calls also needs the soft
 * phone's flag. With one view left there is nothing to choose, so nothing renders.
 */
export function CallLogViews({ campaignId, active, role }: CallLogViewsProps) {
  const views = visibleCallLogViews(role, useGateReaders().isFlagEnabled);
  if (views.length < 2) return null;

  return (
    <nav className={styles.views} aria-label="Call log views" data-testid="call-log-views">
      {views.map((view) => {
        const isActive = view.id === active;
        return (
          <Link
            key={view.id}
            to={campaignTabHref(view.id, campaignId)}
            className={`${styles.view} ${isActive ? styles.viewActive : ''}`}
            aria-current={isActive ? 'page' : undefined}
            data-testid={`call-log-view-${view.id}`}
          >
            {view.label}
          </Link>
        );
      })}
    </nav>
  );
}
