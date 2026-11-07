import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type {
  CustomerTimelineCampaignCall,
  CustomerTimelineSoftphoneCall,
} from '@magick-agency/contracts/api/agency/customer-history';
import { useTenant } from '../../../contexts/TenantContext';
import { useUrlScope } from '../../../contexts/UrlScopeContext';
import styles from './CustomerHistory.module.css';

/** The app path of a call's existing page, or `null` when the caller cannot open it (CH8). */
export function customerCallPagePath(
  entry: CustomerTimelineCampaignCall | CustomerTimelineSoftphoneCall,
): { accountId: string; path: string } | null {
  if (entry.kind === 'campaign_call') {
    const page = entry.call_page;
    if (!page) return null;
    return { accountId: page.account_id, path: `/agency/campaigns/${page.campaign_id}/attempts/${page.attempt_id}` };
  }
  const page = entry.call_page;
  if (!page) return null;
  return { accountId: page.account_id, path: `/agency/softphone/calls/${page.manual_call_id}` };
}

/**
 * "Open call": the existing call page (recording, transcript, analysis). A call in
 * another account opens under that account's scope, through `useUrlScope().go`,
 * since react-router cannot leave the scope it was rendered in.
 */
export function CustomerCallLink({ entry }: { entry: CustomerTimelineCampaignCall | CustomerTimelineSoftphoneCall }) {
  const { tenantId, accountId } = useTenant();
  const { go } = useUrlScope();
  const target = customerCallPagePath(entry);
  if (!target) return null;

  if (target.accountId === accountId || !tenantId) {
    return (
      <Link to={target.path} className={styles.callLink} data-testid="customer-call-link">
        Open call <ExternalLink size={12} aria-hidden="true" />
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={styles.callLinkButton}
      data-testid="customer-call-link"
      onClick={() => go({ tenantId, accountId: target.accountId }, target.path)}
    >
      Open call (other account) <ExternalLink size={12} aria-hidden="true" />
    </button>
  );
}
