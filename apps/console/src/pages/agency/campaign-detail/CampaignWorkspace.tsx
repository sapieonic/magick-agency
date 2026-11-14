import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { useTenant } from '../../../contexts/TenantContext';
import { hasPermission } from '../../../utils/permissions';
import { CampaignHealthStrip } from '../../../components/agency/CampaignHealthStrip';
import { CampaignTabs } from '../../../components/agency/CampaignTabs';
import { AgencyRetryDialog } from '../../../components/agency/AgencyRetryDialog';
import { DEFAULT_RETRY_SELECTOR, retryCreatedToast } from '../../../utils/agencyRetrySelector';
import { agentsOnShift } from '../../../utils/agencyAgentFloor';
import type { CampaignTabId } from '../../../utils/agencyCampaignTabs';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { CampaignDetailHeader } from './CampaignDetailHeader';
import { useAgencyCampaignDetail } from './useAgencyCampaignDetail';
import { useCampaignLifecycle } from './useCampaignLifecycle';
import styles from './CampaignWorkspace.module.css';

/**
 * The layout every campaign screen shares, in one order: the campaign's header,
 * the health strip, the section bar, an optional switch between a section's
 * views (Call log's Dialler | Soft-phone calls), then the section itself. One
 * width for all of them (see the stylesheet), so moving between tabs moves
 * nothing but the section.
 *
 * Layout only. A screen that already owns the campaign's reads and lifecycle
 * (the Monitor tabs, Settings) fills the slots itself; the others use
 * `CampaignWorkspace`, which owns them.
 */
export function CampaignWorkspaceFrame({
  header,
  strip,
  tabs,
  subnav,
  children,
}: {
  header?: ReactNode;
  strip?: ReactNode;
  tabs: ReactNode;
  subnav?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.frame} data-testid="campaign-workspace">
      {header}
      {strip}
      {tabs}
      {subnav}
      <div className={styles.body}>{children}</div>
    </div>
  );
}

/**
 * The frame with the campaign's own reads behind it, for a section that has no
 * reason to own them (Contacts, Call log, History): the header with its
 * lifecycle controls, Retry contacts and History, the health strip, and the bar
 * with its on-shift count, exactly as on the Monitor tabs. The section gets the
 * campaign as read (`null` until the first answer, or when the read fails: the
 * section is still shown, because a header that will not load is no reason to
 * withhold a list).
 *
 * The campaign is re-read on the header's 10-second poll while it dials, so a
 * section must not key a list read on the campaign object it is handed.
 */
export function CampaignWorkspace({
  campaignId,
  active,
  subnav,
  children,
}: {
  campaignId: string;
  /** The section on screen; `activity` (History) marks no tab. */
  active: CampaignTabId;
  subnav?: ReactNode;
  children: ReactNode | ((campaign: AgencyCampaign | null) => ReactNode);
}) {
  const { tenantId, accountId, role } = useTenant();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { campaign, stats, lastUpdatedAt, shouldPoll, campaignRef, load, refreshCampaign, commitCampaign } =
    useAgencyCampaignDetail(campaignId, tenantId, accountId);
  const [retryOpen, setRetryOpen] = useState(false);

  // The same gates as the Monitor tabs (`AgencyCampaignDetailPage`), for the same server routes.
  const canControl = hasPermission(role, 'agency.supervise');
  const canJoinStation = hasPermission(role, 'agency.station.connect');
  const canRetry = canControl && hasPermission(role, 'agency.campaigns.write');

  const lifecycle = useCampaignLifecycle({
    id: campaignId,
    tenantId,
    accountId,
    campaignRef,
    refreshCampaign,
    commitCampaign,
    reload: () => void load(),
    fromTab: active,
  });

  // `undefined` until the stats answer, so the bar falls back to the count another screen shared.
  const onShift = stats ? agentsOnShift(stats.agents) : undefined;

  return (
    <CampaignWorkspaceFrame
      header={
        campaign ? (
          <CampaignDetailHeader
            campaign={campaign}
            lastUpdatedAt={lastUpdatedAt}
            autoRefreshing={shouldPoll}
            concurrency={stats?.concurrency}
            tenantId={tenantId}
            accountId={accountId}
            canControl={canControl}
            busy={lifecycle.busy}
            onAction={lifecycle.onAction}
            onRetry={canRetry ? () => setRetryOpen(true) : undefined}
            canJoinStation={canJoinStation}
            role={role}
            onRefresh={() => void load()}
          />
        ) : null
      }
      strip={
        campaign ? (
          <CampaignHealthStrip stats={stats} campaignId={campaignId} campaignStatus={campaign.status} role={role} />
        ) : null
      }
      tabs={
        <CampaignTabs
          campaignId={campaignId}
          active={active}
          role={role}
          agentsOnShift={onShift}
          campaignStatus={campaign?.status}
        />
      }
      subnav={subnav}
    >
      {typeof children === 'function' ? children(campaign) : children}
      {lifecycle.confirmDialog}
      {retryOpen && campaign ? (
        <AgencyRetryDialog
          open
          campaign={campaign}
          selector={DEFAULT_RETRY_SELECTOR}
          origin="campaign"
          onClose={() => setRetryOpen(false)}
          onCreated={(result) => {
            setRetryOpen(false);
            showToast(retryCreatedToast(result), 'success');
            navigate(`/agency/campaigns/${result.campaign.id}`);
          }}
        />
      ) : null}
    </CampaignWorkspaceFrame>
  );
}
