import { useParams } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { useGovernance } from '../../contexts/GovernanceContext';
import { AGENCY_ANALYTICS_CAPABILITY } from '../../utils/agencyCampaignRecording';
import { CallLogViews } from '../../components/agency/CallLogViews';
import { SoftphoneCallsList } from '../../components/softphone/SoftphoneCallsList';
import { CampaignWorkspace } from './campaign-detail/CampaignWorkspace';
import type { AgencyCampaign } from '../../types/agency-campaign';
import spine from '../../components/agency/SpineListLayout.module.css';
import styles from './AgencyCampaignAttemptsPage.module.css';

/**
 * `/agency/campaigns/:id/manual-calls` — the soft-phone calls agents logged to
 * this campaign, kept apart from its paced Call attempts (`docs/softphone.md` §2:
 * manual calls never become attempts). The account list with the tag filter
 * fixed, in the campaign's workspace (header, health strip, bar) like every
 * campaign screen.
 */
export default function AgencyCampaignManualCallsPage() {
  const { id } = useParams<{ id: string }>();
  const { role } = useTenant();
  if (!id) return null;

  return (
    <CampaignWorkspace
      campaignId={id}
      active="manual"
      // Call log's second view (decision IN14): the bar marks Call log, this marks the view.
      subnav={<CallLogViews campaignId={id} active="manual" role={role} />}
    >
      {(campaign) => <ManualCallsSection campaignId={id} campaign={campaign} />}
    </CampaignWorkspace>
  );
}

function ManualCallsSection({ campaignId, campaign }: { campaignId: string; campaign: AgencyCampaign | null }) {
  const { isEnabled } = useGovernance();
  // Call log's second view: the bar tab it sits under names it.
  useCampaignCrumbs(campaignId, campaign, 'attempts');

  return (
    <section aria-labelledby="manual-calls-title">
      <header className={spine.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true">
            <Phone size={20} />
          </span>
          <h2 id="manual-calls-title" className={spine.title}>Call log</h2>
        </div>
      </header>
      <p className={styles.privacyNote}>
        Calls agents placed from the soft phone and logged to this campaign. They use its outcomes, caller IDs and
        summary profile, and are not part of its paced call attempts.
      </p>
      <SoftphoneCallsList
        scope="account"
        campaignId={campaignId}
        detailPath={(call) => `/agency/softphone/calls/${call.id}`}
        showSummary={isEnabled(AGENCY_ANALYTICS_CAPABILITY)}
        caption={`Soft-phone calls logged to ${campaign?.name ?? 'this campaign'}, newest first`}
      />
    </section>
  );
}
