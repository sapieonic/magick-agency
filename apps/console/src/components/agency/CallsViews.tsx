import { Link, useLocation } from 'react-router-dom';
import { campaignTabHref, visibleCallsViews, type CallsViewId } from '../../utils/agencyCampaignTabs';
import { useGateReaders } from '../../hooks/useGateReaders';
import type { Role } from '../../types/auth';
import styles from './CallLogViews.module.css';

interface CallsViewsProps {
  campaignId: string;
  /** The view showing: `…/calls` (Summary) or `…/calls/live` (Live). */
  active: CallsViewId;
  role: Role | undefined;
  /** The calls in progress, when the Live view has read them; null or absent says nothing. */
  liveCount?: number | null;
}

/**
 * The Calls tab's two views (`docs/listening.md` §9): "Summary" (`…/calls`, the analytic panel)
 * and "Live" (`…/calls/live`, the campaign's calls in progress). The same segmented control as
 * Call log's (`CallLogViews`): links with `aria-current`, each view its own URL, the bar marking
 * Calls for both. Live is offered only with the listening flag on (LS1); with one view left there
 * is nothing to choose, so nothing renders.
 */
export function CallsViews({ campaignId, active, role, liveCount = null }: CallsViewsProps) {
  const views = visibleCallsViews(role, useGateReaders().isFlagEnabled);
  // The Summary link keeps the panels' range (`?range=…`); Live owns no query.
  const { search } = useLocation();
  if (views.length < 2) return null;

  return (
    <nav className={styles.views} aria-label="Calls views" data-testid="calls-views">
      {views.map((view) => {
        const isActive = view.id === active;
        return (
          <Link
            key={view.id}
            to={campaignTabHref(view.id, campaignId, active === 'calls' ? search : '')}
            className={`${styles.view} ${isActive ? styles.viewActive : ''}`}
            aria-current={isActive ? 'page' : undefined}
            data-testid={`calls-view-${view.id}`}
          >
            {view.label}
            {view.id === 'live' && liveCount !== null ? <span className={styles.count}>&nbsp;{liveCount}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
