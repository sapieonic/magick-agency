import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { Breadcrumbs } from '@magick-agency/web-ui/components/Breadcrumbs';
import { useTenant } from '../../contexts/TenantContext';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { SoftphoneCallsList } from '../../components/softphone/SoftphoneCallsList';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import type { AgencyCampaign } from '../../types/agency-campaign';
import spine from '../../components/agency/SpineListLayout.module.css';
import styles from './AgencyCampaignAttemptsPage.module.css';

/**
 * `/agency/campaigns/:id/manual-calls` — the soft-phone calls agents logged to
 * this campaign, kept apart from its paced Call attempts (`docs/softphone.md` §2:
 * manual calls never become attempts). The account list with the tag filter
 * fixed.
 */
export default function AgencyCampaignManualCallsPage() {
  const { id } = useParams<{ id: string }>();
  const { tenantId, accountId, role } = useTenant();
  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);

  useEffect(() => {
    if (!id || !tenantId || !accountId) return;
    getAgencyCampaign(id, tenantId, accountId)
      .then(setCampaign)
      // The calls are the point; a header that will not load is no reason to withhold them.
      .catch(() => setCampaign(null));
  }, [id, tenantId, accountId]);

  if (!id) return null;

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Campaigns', href: '/agency/campaigns' },
          ...(campaign ? [{ label: campaign.name, href: `/agency/campaigns/${campaign.id}` }] : []),
          { label: 'Manual calls' },
        ]}
      />
      <CampaignTabs campaignId={id} active="manual" role={role} campaignStatus={campaign?.status} />
      <header className={spine.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true">
            <Phone size={20} />
          </span>
          <h1 className={spine.title}>Manual calls</h1>
          {campaign ? <AgencyCampaignStatusBadge status={campaign.status} /> : null}
        </div>
      </header>
      <p className={styles.privacyNote}>
        Calls agents placed from the soft phone and logged to this campaign. They use its outcomes, caller IDs and
        summary profile, and are not part of its paced call attempts.
      </p>
      <SoftphoneCallsList
        scope="account"
        campaignId={id}
        detailPath={(call) => `/agency/softphone/calls/${call.id}`}
        caption={`Soft-phone calls logged to ${campaign?.name ?? 'this campaign'}, newest first`}
      />
    </div>
  );
}
