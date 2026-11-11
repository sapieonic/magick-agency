import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { transitionAgencyCampaign } from '../../../api/agencyCampaigns';
import { ApiError } from '../../../api/client';
import { withCarrierRefusalCopy } from '../../../utils/agencyCarriers';
import {
  isKnownCampaignStatus,
  isLifecycleActionEnabled,
  type AgencyCampaignAction as Action,
} from '../../../utils/agencyCampaignControls';
import type { CampaignTabId } from '../../../utils/agencyCampaignTabs';
import {
  trackAgencyCampaignLifecycleAction,
  trackAgencyCampaignLifecycleFailed,
} from '../../../analytics/events';
import type { AgencyCampaign } from '../../../types/agency-campaign';

/** Only `stop` is irreversible, so only `stop` interrupts with a confirm. */
const CONFIRM_COPY: Partial<Record<Action, { title: string; message: string }>> = {
  stop: {
    title: 'Stop this campaign?',
    message:
      'No new calls will be placed. Calls already in progress will finish normally, and the '
      + 'campaign moves to “Stopping” until they do. A stopped campaign cannot be restarted.',
  },
};

export interface CampaignLifecycleSource {
  id: string | undefined;
  tenantId: string | null;
  accountId: string | null;
  /** The campaign as of the latest write or read — current at click time, not at the last paint. */
  campaignRef: { readonly current: AgencyCampaign | null };
  /** Re-read the campaign row alone (the Start / Resume preflight and the 409 repair). */
  refreshCampaign: () => Promise<AgencyCampaign | null>;
  /** Paint a campaign the server just answered with, and fence off every older read. */
  commitCampaign: (campaign: AgencyCampaign) => void;
  /** Re-read whatever the page shows after a transition. */
  reload: () => void;
  /** The tab the action was taken from, for `agency_campaign_lifecycle_action`. */
  fromTab: CampaignTabId;
}

export interface CampaignLifecycle {
  /** The lifecycle action in flight, which disables every button. */
  busy: Action | null;
  /** A header button was pressed: confirm `stop`, run the rest. */
  onAction: (action: Action) => void;
  /** The Stop confirmation, while open; render it anywhere on the page. */
  confirmDialog: ReactNode;
}

/**
 * Start, pause, resume and stop from the campaign header, on whichever campaign page shows
 * it (the Monitor tabs and Settings). The page supplies how it reads and paints the campaign;
 * this owns the click lock, the Stop confirmation, the refusals and the analytics.
 */
export function useCampaignLifecycle({
  id,
  tenantId,
  accountId,
  campaignRef,
  refreshCampaign,
  commitCampaign,
  reload,
  fromTab,
}: CampaignLifecycleSource): CampaignLifecycle {
  const { showToast, showErrorToast } = useToast();
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState<Action | null>(null);

  /**
   * Synchronous with the click. `setBusy` is a render, so two Start clicks in
   * the same frame both see `busy === null` and both POST — the 7× `/start`
   * 409 seen in real use is that click, repeated, against a button that never
   * disabled. The ref is the lock the state cannot be.
   */
  const busyRef = useRef(false);

  /**
   * Say why a lifecycle action was refused. A carrier refusal (start or resume on a
   * carrier account that is no longer active, or gone) gets the console's own sentence,
   * which says who can fix it; anything else shows the API's message.
   */
  const reportRefusal = useCallback(
    (err: unknown) => showErrorToast(withCarrierRefusalCopy(err), 'Could not change the campaign state.'),
    [showErrorToast],
  );

  const runAction = useCallback(
    async (action: Action) => {
      if (!id || !tenantId || !accountId) return;
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(action);
      // Captured before the request fires — `updated.status` below is the
      // TO side, and neither may be read off `campaign` state directly (see
      // the comment on `campaignRef`).
      let fromStatus = campaignRef.current?.status;
      try {
        /**
         * Start / Resume from a stale view is a known bug: the button would
         * have been hidden if we held `running`. Re-read before
         * POSTing so the click does not become the API's 409. Pause / Stop
         * are still guarded against the status we hold — those buttons
         * are not the ones that stayed enabled across a transition.
         */
        if (action === 'start' || action === 'resume') {
          const latest = await refreshCampaign();
          fromStatus = latest?.status ?? fromStatus;
        }
        if (fromStatus && !isLifecycleActionEnabled(fromStatus, action)) {
          return;
        }
        const updated = await transitionAgencyCampaign(id, action, tenantId, accountId);
        // Invalidate any GET that started before this write so it cannot
        // paint the previous status over the one we just committed.
        commitCampaign(updated);
        // Report what came back, not what was asked for. `stop` answers with
        // `stopping`, and a toast saying "Stopped" while calls are still up
        // would contradict the badge rendered directly beneath it.
        showToast(`Campaign is now ${updated.status}.`, 'success');
        if (fromStatus && isKnownCampaignStatus(fromStatus) && isKnownCampaignStatus(updated.status)) {
          trackAgencyCampaignLifecycleAction({
            campaign_id: id,
            action,
            from_status: fromStatus,
            to_status: updated.status,
            // Only `stop` interrupts with a confirm dialog (`CONFIRM_COPY`).
            confirmed: Boolean(CONFIRM_COPY[action]),
            from_tab: fromTab,
          });
        }
        reload();
      } catch (err: unknown) {
        const statusCode = err instanceof ApiError ? err.statusCode : 0;
        /**
         * A 409 is an answer, not a transport failure. Two kinds:
         * the campaign moved underneath us (stale Start / Resume), or the
         * transition is refused where the campaign stands. The first is repaired
         * by refetching — the refreshed view then replaces the button, and a
         * conflict toast on a control that has just disappeared is friction. The
         * second is a real refusal (the roster gate, say) and still has to be
         * said. Another running campaign on the account is not a refusal: several
         * run at once and share the account's lines (decisions MC6).
         */
        let reportFailure = true;
        if (statusCode === 409) {
          const latest = await refreshCampaign();
          const stillOffered = latest ? isLifecycleActionEnabled(latest.status, action) : true;
          if (stillOffered) {
            reportRefusal(err);
          } else {
            reportFailure = false;
          }
        } else {
          reportRefusal(err);
        }
        if (reportFailure && fromStatus && isKnownCampaignStatus(fromStatus)) {
          trackAgencyCampaignLifecycleFailed({
            campaign_id: id,
            action,
            from_status: fromStatus,
            // `0` is a non-`ApiError` failure (e.g. a network error) — there is
            // no HTTP status to report, and `0` cannot collide with a real one.
            status_code: statusCode,
          });
        }
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [id, tenantId, accountId, reload, refreshCampaign, commitCampaign, campaignRef, showToast, reportRefusal, fromTab],
  );

  const onAction = useCallback(
    (action: Action) => {
      if (CONFIRM_COPY[action]) setConfirming(action);
      else void runAction(action);
    },
    [runAction],
  );

  const confirmCopy = confirming ? CONFIRM_COPY[confirming] : undefined;
  const confirmDialog = confirming && confirmCopy ? (
    <ConfirmDialog
      open
      title={confirmCopy.title}
      message={confirmCopy.message}
      confirmLabel="Stop campaign"
      danger
      disabled={busy !== null}
      onConfirm={() => {
        const action = confirming;
        setConfirming(null);
        void runAction(action);
      }}
      onCancel={() => setConfirming(null)}
    />
  ) : null;

  return { busy, onAction, confirmDialog };
}
