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
import type { AgencyCampaignStats } from '../../../types/agency-campaign';

/**
 * What the chrome reads off the screen's campaign: `useAgencyCampaignDetail` as it is (the
 * Monitor tabs, `CampaignWorkspace`), or a screen's own read of the campaign row (Settings).
 */
export type CampaignChromeSource = Pick<
  AgencyCampaignDetail,
  'campaign' | 'lastUpdatedAt' | 'campaignRef' | 'refreshCampaign' | 'commitCampaign'
> & {
  /** Re-read what the screen shows: after a lifecycle action, and the header's Refresh by default. */
  load: () => unknown;
  /**
   * The campaign's stats, `null` until read or when the read failed. Left out by a screen that
   * reads none (Settings): no health strip and no lines in use, the header alone.
   */
  stats?: AgencyCampaignStats | null;
  /** The screen polls the campaign: said beside the header's "Updated" stamp. */
  shouldPoll?: boolean;
};

export interface CampaignChrome {
  /** The campaign's header, or `null` until it has been read. */
  header: ReactNode;
  /** The health strip, or `null` until the campaign has been read. */
  strip: ReactNode;
  /** The Stop confirmation and the retry dialog, mounted at the end of the page. */
  dialogs: ReactNode;
  canControl: boolean;
  /** `agency.campaigns.write`: Add contacts (or New campaign once it has ended). */
  canAddContacts: boolean;
  canRetry: boolean;
  openRetry: () => void;
}

/**
 * What every campaign screen puts above and below its section: the header with its lifecycle
 * controls, the health strip, and the dialogs those controls open. One place for the gates, so
 * the Monitor tabs, the other sections (`CampaignWorkspace`) and Settings cannot disagree on who
 * sees which button.
 *
 * Only ever for the campaign the route names: a source still holding another campaign (an
 * answer for the previous one, before a screen without a `key` has caught up with the move)
 * renders no header, strip or retry dialog, rather than one campaign's name and controls over
 * the next one's id.
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
  detail: CampaignChromeSource;
  /** The header's Refresh; re-reads the campaign when not given. */
  onRefresh?: () => void;
}): CampaignChrome {
  const { tenantId, accountId, role } = useTenant();
  const navigate = useNavigate();
  const { showToast } = useToast();
  // Open for the campaign it was opened on, never for the next one a screen without a `key` moves to.
  const [retryOpenFor, setRetryOpenFor] = useState<string | null>(null);
  const { lastUpdatedAt, shouldPoll = false, campaignRef, load, refreshCampaign, commitCampaign } = detail;
  const campaign = detail.campaign && detail.campaign.id === campaignId ? detail.campaign : null;
  const stats = detail.stats ?? null;
  const readsStats = detail.stats !== undefined;

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
  /*
    Add contacts uploads a roster into the campaign (the ingest routes gate on
    `agency.campaigns.write`), and New campaign in its place creates one: the same permission,
    not `agency.supervise`, so a split between the two cannot take the only entry away.
  */
  const canAddContacts = hasPermission(role, 'agency.campaigns.write');
  // Floors at `agent`, so everyone above holds it too — a supervisor covering a
  // shift is the case this exists for.
  const canJoinStation = hasPermission(role, 'agency.station.connect');
  /*
    The server names BOTH permissions on `POST .../retry`: creating a campaign
    (`agency.campaigns.write`) and acting on another campaign's call results
    (`agency.supervise`). Same `account_admin` floor today; naming both keeps
    this affordance correct if either moves.
  */
  const canRetry = canControl && canAddContacts;

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

  const openRetry = () => setRetryOpenFor(campaignId ?? null);
  const retryOpen = retryOpenFor !== null && retryOpenFor === campaignId;

  const header = campaign ? (
    <CampaignDetailHeader
      campaign={campaign}
      lastUpdatedAt={lastUpdatedAt}
      autoRefreshing={shouldPoll}
      concurrency={stats?.concurrency}
      tenantId={tenantId}
      accountId={accountId}
      canControl={canControl}
      canAddContacts={canAddContacts}
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
  const strip = campaign && readsStats ? (
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
          onClose={() => setRetryOpenFor(null)}
          onCreated={(result) => {
            setRetryOpenFor(null);
            showToast(retryCreatedToast(result), 'success');
            navigate(`/agency/campaigns/${result.campaign.id}`);
          }}
        />
      ) : null}
    </>
  );

  return { header, strip, dialogs, canControl, canAddContacts, canRetry, openRetry };
}
