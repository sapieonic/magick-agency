import { useEffect, type ReactNode } from 'react';
import { useTenant } from '../../../contexts/TenantContext';
import { CampaignTabs } from '../../../components/agency/CampaignTabs';
import { publishCampaignTabBadge } from '../../../hooks/useCampaignTabBadges';
import { agentsOnShift } from '../../../utils/agencyAgentFloor';
import type { CampaignTabId } from '../../../utils/agencyCampaignTabs';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { useAgencyCampaignDetail } from './useAgencyCampaignDetail';
import { useCampaignChrome } from './useCampaignChrome';
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
 * with its on-shift count, as on the Monitor tabs (`useCampaignChrome`). The
 * section gets the campaign as read: `null` until the first answer, or when the
 * read fails, and the section is still shown, because a header that will not
 * load is no reason to withhold a list.
 *
 * Read once, not polled: these sections are lists, not a view of the campaign
 * moving. The header re-reads on its Refresh and when the window comes back.
 * A section must still key its own reads on the id, not on the campaign object.
 *
 * The header's h1 is the campaign's name, so a section titles itself with an h2, and names
 * its own Refresh for what it re-reads ("Refresh contacts") beside the header's.
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
  const detail = useAgencyCampaignDetail(campaignId, tenantId, accountId, { poll: false });
  const { campaign, stats } = detail;
  const chrome = useCampaignChrome({ campaignId, active, detail });

  /*
    The bar's on-shift count from this screen's own stats read. `null` (not known yet) rather
    than `undefined` until it answers, so the bar does not send a stats read of its own beside
    this one; once known it is shared, so the next campaign screen opened needs none either.
  */
  const onShift = stats ? agentsOnShift(stats.agents) : null;
  const shownId = campaign?.id;
  useEffect(() => {
    if (shownId && tenantId && accountId && onShift !== null) {
      publishCampaignTabBadge('onShift', tenantId, accountId, shownId, onShift);
    }
  }, [shownId, tenantId, accountId, stats, onShift]);

  /*
    The route has no `key`, so moving to another campaign keeps this mounted and, until the new
    read lands, `campaign` is still the previous one. The section is handed only the campaign
    the URL names: its name, catalog and status must never be another campaign's.
  */
  const sectionCampaign = campaign && campaign.id === campaignId ? campaign : null;

  return (
    <CampaignWorkspaceFrame
      header={chrome.header}
      strip={chrome.strip}
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
      {typeof children === 'function' ? children(sectionCampaign) : children}
      {chrome.dialogs}
    </CampaignWorkspaceFrame>
  );
}
