import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { getAgencyCampaignStats, transitionAgencyCampaign } from '../../../api/agencyCampaigns';
import { ApiError } from '../../../api/client';
import { withCarrierRefusalCopy } from '../../../utils/agencyCarriers';
import {
  isKnownCampaignStatus,
  isLifecycleActionEnabled,
  LIFECYCLE_REFUSAL_FALLBACK,
  type AgencyCampaignAction as Action,
} from '../../../utils/agencyCampaignControls';
import type { CampaignTabId } from '../../../utils/agencyCampaignTabs';
import {
  trackAgencyCampaignLifecycleAction,
  trackAgencyCampaignLifecycleFailed,
  trackAgencyCampaignResumeWarningCancelled,
} from '../../../analytics/events';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { agencyCampaignStatusLabel } from '../AgencyCampaignStatusBadge';
import { useUnknownCallerRoutes } from '../../../hooks/useUnknownCallerRoutes';
import { unknownCallersWarning } from '../../../utils/callSettingsCopy';
import {
  resumeWarning,
  type ResumeWarning,
  type ResumeWarningCampaign,
  type ResumeWarningStats,
} from '../../../utils/agency/resumeWarning';

/**
 * Only `stop` is irreversible, so only `stop` always interrupts with a confirm. Resume asks first
 * only when it would undo the abandonment guardrail (`resumeWarning`, decisions AW1–AW3).
 */
const CONFIRM_COPY: Partial<Record<Action, { title: string; message: string }>> = {
  stop: {
    title: 'Stop this campaign?',
    message:
      'No new calls will be placed. Calls already in progress will finish normally, and the '
      + 'campaign moves to “Stopping” until they do. A stopped campaign cannot be restarted.',
  },
};

/** Where a lifecycle action can be taken: a campaign tab's header, or a card on Live floor. */
export type CampaignLifecycleOrigin = CampaignTabId | 'live_floor';

export interface CampaignLifecycleSource {
  id: string | undefined;
  tenantId: string | null;
  accountId: string | null;
  /**
   * The campaign as of the latest write or read — current at click time, not at the last paint.
   * Only its status is read, so Live floor's cards pass the board's.
   */
  campaignRef: { readonly current: Pick<AgencyCampaign, 'status' | 'archived_at'> | null };
  /**
   * Re-read the campaign row alone (the Start / Resume preflight and the 409 repair). Its
   * `archived_at`, when carried, keeps Start from being sent for a draft archived elsewhere (AR2),
   * and its pause fields decide whether Resume warns first (`resumeWarning`).
   */
  refreshCampaign: () => Promise<(Pick<AgencyCampaign, 'status' | 'archived_at'> & Partial<ResumeWarningCampaign>) | null>;
  /** Paint a campaign the server just answered with, and fence off every older read. */
  commitCampaign: (campaign: AgencyCampaign) => void;
  /** Re-read whatever the page shows after a transition. */
  reload: () => void;
  /** The tab the action was taken from (or Live floor's campaign card), for `agency_campaign_lifecycle_action`. */
  fromTab: CampaignLifecycleOrigin;
}

export interface CampaignLifecycle {
  /** The lifecycle action in flight, which disables every button. */
  busy: Action | null;
  /** A header button was pressed: confirm `stop`, run the rest (Resume may warn first). */
  onAction: (action: Action) => void;
  /** The Stop confirmation or the Resume warning, while open; render it anywhere on the page. */
  confirmDialog: ReactNode;
}

/**
 * Start, pause, resume and stop from the campaign header, on whichever campaign page shows
 * it (the Monitor tabs and Settings), and Pause and Resume from Live floor's campaign cards. The page supplies how it reads and paints the campaign;
 * this owns the click lock, the Stop confirmation, the Resume warning, the refusals and the analytics.
 *
 * Resume's preflight reads the campaign row and its `/stats` together. When the abandonment
 * guardrail paused it, or the rolling 24-hour rate is over its ceiling now, Resume asks first
 * (`resumeWarning`) and sends nothing until the supervisor confirms; confirming always resumes.
 * A failed stats read never holds Resume: the warning is then said from the row alone.
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
  /*
    With the campaign it was asked for: the routes have no `key`, so a confirmation left open
    while the URL moves to another campaign must not stay up and, confirmed, stop that one.
  */
  const [confirmingFor, setConfirmingFor] = useState<{ action: Action; id: string | undefined } | null>(null);
  const confirming = confirmingFor && confirmingFor.id === id ? confirmingFor.action : null;
  /* The Resume warning, for the campaign it was raised on (same reason as above). */
  const [warningFor, setWarningFor] = useState<{ warning: ResumeWarning; id: string | undefined } | null>(null);
  const warning = warningFor && warningFor.id === id ? warningFor.warning : null;

  /**
   * Synchronous with the click. `setBusy` is a render, so two Start clicks in
   * the same frame both see `busy === null` and both POST — the 7× `/start`
   * 409 seen in real use is that click, repeated, against a button that never
   * disabled. The ref is the lock the state cannot be.
   */
  const busyRef = useRef(false);

  /**
   * Say why a lifecycle action was refused, by the rule `lifecycleRefusalMessage` states (New
   * campaign's Start says it the same way): a carrier refusal in the console's own sentence,
   * which says who can fix it; anything else in the API's message.
   */
  const reportRefusal = useCallback(
    (err: unknown) => showErrorToast(withCarrierRefusalCopy(err), LIFECYCLE_REFUSAL_FALLBACK),
    [showErrorToast],
  );

  /**
   * The rolling 24-hour pair for the Resume warning. Never throws: a stats outage must not hold
   * Resume, so it answers null and the warning is said from the campaign row alone.
   */
  const readAbandonmentNow = useCallback(async (): Promise<ResumeWarningStats | null> => {
    if (!id || !tenantId || !accountId) return null;
    try {
      return await getAgencyCampaignStats(id, tenantId, accountId);
    } catch {
      return null;
    }
  }, [id, tenantId, accountId]);

  const runAction = useCallback(
    /**
     * `warned` is the Resume warning the supervisor has just confirmed: the action goes through
     * without asking again, and the analytics say which warning it was.
     */
    async (action: Action, warned: ResumeWarning | null = null) => {
      if (!id || !tenantId || !accountId) return;
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(action);
      // Captured before the request fires — `updated.status` below is the
      // TO side, and neither may be read off `campaign` state directly (see
      // the comment on `campaignRef`).
      let from: (Pick<AgencyCampaign, 'status' | 'archived_at'> & Partial<ResumeWarningCampaign>) | null = campaignRef.current;
      try {
        /**
         * Start / Resume from a stale view is a known bug: the button would
         * have been hidden if we held `running`. Re-read before
         * POSTing so the click does not become the API's 409. Pause / Stop
         * are still guarded against the status we hold — those buttons
         * are not the ones that stayed enabled across a transition.
         */
        let abandonmentNow: ResumeWarningStats | null = null;
        if (action === 'start' || action === 'resume') {
          const asks = action === 'resume' && warned === null;
          const [latest, now] = await Promise.all([refreshCampaign(), asks ? readAbandonmentNow() : null]);
          from = latest ?? from;
          abandonmentNow = now;
        }
        if (from && !isLifecycleActionEnabled(from.status, action, { archived: Boolean(from.archived_at) })) {
          return;
        }
        /*
          Asked on the campaign as just re-read, so a pause the guardrail made after the page last
          painted is still caught. A warning, not a block: the dialog's confirm sends Resume.
        */
        if (action === 'resume' && warned === null && from) {
          const ask = resumeWarning(from, abandonmentNow);
          if (ask) {
            setWarningFor({ warning: ask, id });
            return;
          }
        }
        const updated = await transitionAgencyCampaign(id, action, tenantId, accountId);
        // Invalidate any GET that started before this write so it cannot
        // paint the previous status over the one we just committed.
        commitCampaign(updated);
        // Report what came back, not what was asked for. `stop` answers with
        // `stopping`, and a toast saying "Stopped" while calls are still up
        // would contradict the badge rendered directly beneath it. In the badge's words, never
        // the wire code.
        showToast(`Campaign status: ${agencyCampaignStatusLabel(updated.status)}.`, 'success');
        const fromStatus = from?.status;
        if (fromStatus && isKnownCampaignStatus(fromStatus) && isKnownCampaignStatus(updated.status)) {
          trackAgencyCampaignLifecycleAction({
            campaign_id: id,
            action,
            from_status: fromStatus,
            to_status: updated.status,
            // `stop` always interrupts with a confirm dialog (`CONFIRM_COPY`); Resume when it warned.
            confirmed: Boolean(CONFIRM_COPY[action]) || warned !== null,
            from_tab: fromTab,
            resume_warning: warned?.kind ?? null,
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
          const stillOffered = latest
            ? isLifecycleActionEnabled(latest.status, action, { archived: Boolean(latest.archived_at) })
            : true;
          if (stillOffered) {
            reportRefusal(err);
          } else {
            reportFailure = false;
          }
        } else {
          reportRefusal(err);
        }
        const fromStatus = from?.status;
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
    [id, tenantId, accountId, reload, refreshCampaign, readAbandonmentNow, commitCampaign, campaignRef, showToast, reportRefusal, fromTab],
  );

  const onAction = useCallback(
    (action: Action) => {
      if (CONFIRM_COPY[action]) setConfirmingFor({ action, id });
      else void runAction(action);
    },
    [runAction, id],
  );

  const confirmCopy = confirming ? CONFIRM_COPY[confirming] : undefined;
  // A campaign an inbound number files its unknown callers under (docs/call-log.md §5): Stop
  // asks first, and says which number. It does not hold Stop back.
  const routeWarning = unknownCallersWarning(useUnknownCallerRoutes(id, tenantId, accountId, confirming === 'stop'));
  const stopDialog = confirming && confirmCopy ? (
    <ConfirmDialog
      open
      title={confirmCopy.title}
      message={routeWarning ? `${confirmCopy.message} ${routeWarning}` : confirmCopy.message}
      confirmLabel="Stop campaign"
      danger
      disabled={busy !== null}
      onConfirm={() => {
        const action = confirming;
        setConfirmingFor(null);
        void runAction(action);
      }}
      onCancel={() => setConfirmingFor(null)}
    />
  ) : null;
  const warningDialog = warning ? (
    <ConfirmDialog
      open
      title={warning.title}
      message={warning.message}
      confirmLabel={warning.confirmLabel}
      danger
      disabled={busy !== null}
      onConfirm={() => {
        setWarningFor(null);
        void runAction('resume', warning);
      }}
      onCancel={() => {
        setWarningFor(null);
        if (id) trackAgencyCampaignResumeWarningCancelled({ campaign_id: id, resume_warning: warning.kind, from_tab: fromTab });
      }}
    />
  ) : null;
  const confirmDialog = stopDialog ?? warningDialog;

  return { busy, onAction, confirmDialog };
}
