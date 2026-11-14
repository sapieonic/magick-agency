import { useEffect, type ReactNode } from 'react';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { useTenant } from '../../../contexts/TenantContext';
import { CampaignTabs } from '../../../components/agency/CampaignTabs';
import { publishCampaignTabBadge } from '../../../hooks/useCampaignTabBadges';
import { agentsOnShift } from '../../../utils/agencyAgentFloor';
import type { CampaignTabId } from '../../../utils/agencyCampaignTabs';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { useAgencyCampaignDetail, WORKSPACE_REFRESH_MS, type AgencyCampaignDetail } from './useAgencyCampaignDetail';
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
 * What a section that acts on the campaign itself (Add contacts) is handed besides the campaign:
 * whether the first read is still on its way, and how to repaint the workspace with a campaign
 * it read or wrote, so the header and the section never hold two copies that disagree.
 */
export type CampaignWorkspaceSection = Pick<AgencyCampaignDetail, 'loading' | 'commitCampaign'>;

/**
 * The frame with the campaign's own reads behind it, for a section that has no
 * reason to own them (Contacts, Call log, History): the header with its
 * lifecycle controls, Retry contacts and History, the health strip, and the bar
 * with its on-shift count, as on the Monitor tabs (`useCampaignChrome`). The
 * section gets the campaign as read: `null` until the first answer, or when the
 * read fails, and the section is still shown, because a header that will not
 * load is no reason to withhold a list. A failed campaign read is said above the
 * section, with Retry; a failed stats read costs only the strip and the lines in
 * use, never the campaign (`useAgencyCampaignDetail`).
 *
 * Re-read every {@link WORKSPACE_REFRESH_MS} while the campaign is moving, not every 10
 * seconds as on the Monitor tabs: these sections are lists, not a view of the campaign moving,
 * but the strip's diagnosis and the bar's on-shift count must not be one read from minutes ago.
 * The header also re-reads on its Refresh and when the window comes back. A section must still
 * key its own reads on the id, not on the campaign object.
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
  children: ReactNode | ((campaign: AgencyCampaign | null, section: CampaignWorkspaceSection) => ReactNode);
}) {
  const { tenantId, accountId, role } = useTenant();
  const detail = useAgencyCampaignDetail(campaignId, tenantId, accountId, { pollMs: WORKSPACE_REFRESH_MS });
  const { campaign, stats, error, loading, load, commitCampaign } = detail;
  const chrome = useCampaignChrome({ campaignId, active, detail });

  /*
    The bar's on-shift count from this screen's own stats read. `null` (not known yet) rather
    than `undefined` until it answers, so the bar does not send a stats read of its own beside
    this one; once known it is shared, so the next campaign screen opened needs none either.
    Each publish is a read that has just landed (the effect runs on a new `stats`, not on a
    re-render), and the poll above keeps them no further apart than the store holds one. The
    Monitor tabs never take the shared count: they hand the bar their own polled one.
  */
  const onShift = stats ? agentsOnShift(stats.agents) : null;
  const shownId = campaign?.id;
  useEffect(() => {
    if (shownId && tenantId && accountId && onShift !== null) {
      publishCampaignTabBadge('onShift', tenantId, accountId, shownId, onShift);
    }
  }, [shownId, tenantId, accountId, stats, onShift]);

  /*
    The route has no `key`, so moving to another campaign keeps this mounted. The hook drops the
    previous campaign as the id changes; checked here as well, because the section is handed
    only the campaign the URL names: its name, catalog and status must never be another's.
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
      {error && <ErrorAlert message={error} onRetry={() => void load()} />}
      {typeof children === 'function'
        ? children(sectionCampaign, { loading, commitCampaign })
        : children}
      {chrome.dialogs}
    </CampaignWorkspaceFrame>
  );
}
