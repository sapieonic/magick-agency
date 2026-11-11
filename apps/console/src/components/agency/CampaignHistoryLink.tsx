import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import { CAMPAIGN_TABS, campaignTabHref, canOpenCampaignScreen } from '../../utils/agencyCampaignTabs';
import type { Role } from '../../types/auth';
import styles from './CampaignHistoryLink.module.css';

interface CampaignHistoryLinkProps {
  campaignId: string;
  role: Role | undefined;
  /** On the History page itself: marked as the current page. */
  current?: boolean;
}

const HINT = CAMPAIGN_TABS.find((tab) => tab.id === 'activity')!.hint;

/**
 * "History": the campaign's activity trail (`…/activity`), out of the tab bar and into the
 * header since decision IN14, because it answers "who changed what", not a question about how
 * the campaign is doing. Gated as the page (`audit.read`); renders nothing below it.
 */
export function CampaignHistoryLink({ campaignId, role, current = false }: CampaignHistoryLinkProps) {
  if (!canOpenCampaignScreen('activity', role)) return null;
  return (
    <Link
      to={campaignTabHref('activity', campaignId)}
      className={`${styles.link} ${current ? styles.current : ''}`}
      aria-current={current ? 'page' : undefined}
      title={HINT}
      data-testid="campaign-history-link"
    >
      <History size={16} aria-hidden="true" />
      History
    </Link>
  );
}
