import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { useTenant } from '../../../contexts/TenantContext';
import { hasPermission } from '../../../utils/permissions';
import { CampaignHealthStrip } from '../../../components/agency/CampaignHealthStrip';
import { AgencyRetryDialog } from '../../../components/agency/AgencyRetryDialog';
import { DEFAULT_RETRY_SELECTOR, retryCreatedToast } from '../../../utils/agencyRetrySelector';
import type { CampaignTabId } from '../../../utils/agencyCampaignTabs';
import { CampaignDetailHeader } from './CampaignDetailHeader';
import type { AgencyCampaignDetail } from './useAgencyCampaignDetail';
import { useCampaignLifecycle } from './useCampaignLifecycle';

export interface CampaignChrome {
  /** The campaign's header, or `null` until it has been read. */
  header: ReactNode;
  /** The health strip, or `null` until the campaign has been read. */
  strip: ReactNode;
  /** The Stop confirmation and the retry dialog, mounted at the end of the page. */
  dialogs: ReactNode;
  canControl: boolean;
  canRetry: boolean;
  openRetry: () => void;
}

/**
 * What every campaign screen that owns the campaign's reads puts above and below its section:
 * the header with its lifecycle controls, the health strip, and the dialogs those controls open.
 * One place for the gates, so the Monitor tabs and the other sections (`CampaignWorkspace`)
 * cannot disagree on who sees which button.
 */
export function useCampaignChrome({
  campaignId,
  active,
  detail,
  onRefresh,
}: {
  /** The route's id: what the lifecycle actions are sent for. */
  campaignId: string | undefined;
  active: CampaignTabId;
  detail: AgencyCampaignDetail;
  /** The header's Refresh; re-reads the campaign when not given. */
  onRefresh?: () => void;
}): CampaignChrome {
  const { tenantId, accountId, role } = useTenant();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [retryOpen, setRetryOpen] = useState(false);
  const { campaign, stats, lastUpdatedAt, shouldPoll, campaignRef, load, refreshCampaign, commitCampaign } = detail;

  /**
   * `agency.supervise`, floored at `account_admin`.
   *
   * These controls used to check `proxy.schedules.write` — an `operator`-level
   * permission borrowed because that was what the server's lifecycle routes happened
   * to gate on. It is now a recorded decision that starting, pausing and stopping
   * a dialing campaign is a supervisory act, and the server's four lifecycle proxies
   * gate on `agency.supervise` to match. The UI gate has to be the API gate:
   * checking the looser one here would show an `operator` four buttons that 403.
   */
  const canControl = hasPermission(role, 'agency.supervise');
  // Floors at `agent`, so everyone above holds it too — a supervisor covering a
  // shift is the case this exists for.
  const canJoinStation = hasPermission(role, 'agency.station.connect');
  /*
    The server names BOTH permissions on `POST .../retry`: creating a campaign
    (`agency.campaigns.write`) and acting on another campaign's call results
    (`agency.supervise`). Same `account_admin` floor today; naming both keeps
    this affordance correct if either moves.
  */
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

  const openRetry = () => setRetryOpen(true);

  const header = campaign ? (
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
      onRetry={canRetry ? openRetry : undefined}
      canJoinStation={canJoinStation}
      role={role}
      onRefresh={onRefresh ?? (() => void load())}
      historyCurrent={active === 'activity'}
    />
  ) : null;

  /*
    A blocker stays above every metric AND above the tab bar. It is the one
    thing on a campaign screen that is worth reading before choosing what to
    read: a diagnosis that only appeared on the section you happened to be on
    would be invisible to the supervisor who opened another one first.
  */
  const strip = campaign ? (
    <CampaignHealthStrip stats={stats} campaignId={campaign.id} campaignStatus={campaign.status} role={role} />
  ) : null;

  const dialogs = (
    <>
      {lifecycle.confirmDialog}
      {/* Mounted only while open: the preview is a count over the whole
          campaign and has no business running on every page view. */}
      {retryOpen && campaign ? (
        <AgencyRetryDialog
          open
          campaign={campaign}
          /*
            The default, used because this entry point has no filtered
            list behind it: ONE dimension, `last_outcome ∈ {no_answer, busy,
            __none__}`.

            ⚠️ NOT `last_outcome` plus `never_attempted`, which is what this
            comment used to describe. Those are two dimensions, the selector
            algebra ANDs across dimensions, and a contact with no attempts has a
            NULL outcome — so that pair matched zero rows on every campaign and
            this button was dead. "We did not reach them" is a UNION, and
            `__none__` is how it is spelled inside a single dimension. See
            `DEFAULT_RETRY_SELECTOR` for the measurement.

            Everything else — machine, failed, a suppressed state, a disposition
            — is opt-in and reached by narrowing the Contacts tab first, which
            the dialog says.
          */
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
    </>
  );

  return { header, strip, dialogs, canControl, canRetry, openRetry };
}
