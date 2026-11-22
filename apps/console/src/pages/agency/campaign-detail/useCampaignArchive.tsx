import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { setAgencyCampaignArchived } from '../../../api/agencyCampaigns';
import { ApiError } from '../../../api/client';
import { ARCHIVE_CONFIRM, ARCHIVE_TOASTS, trackArchiveAction } from '../../../utils/agencyCampaignArchive';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { useUnknownCallerRoutes } from '../../../hooks/useUnknownCallerRoutes';
import { unknownCallersWarning } from '../../../utils/callSettingsCopy';

export type CampaignArchiveAction = 'archive' | 'unarchive';

export interface CampaignArchive {
  /** The archive or restore in flight, which disables both buttons. */
  busy: CampaignArchiveAction | null;
  /** Archive was pressed: confirm first. */
  onArchive: () => void;
  /** Restore was pressed: nothing is lost by it, so no confirm. */
  onRestore: () => void;
  /** The Archive confirmation, while open. */
  confirmDialog: ReactNode;
}

/**
 * Archive and restore from the campaign header (decisions AR1–AR7). The page supplies how it
 * paints the campaign; this owns the click lock, the confirmation and the refusals. A 409 (the
 * campaign moved, say it was started from another window) re-reads the campaign so the header
 * shows what it really is, and says why.
 */
export function useCampaignArchive({
  id,
  tenantId,
  accountId,
  campaignStatus,
  refreshCampaign,
  commitCampaign,
}: {
  id: string | undefined;
  tenantId: string | null;
  accountId: string | null;
  /** The status shown, for the confirm's note on a draft. */
  campaignStatus: string | undefined;
  refreshCampaign: () => Promise<unknown>;
  commitCampaign: (campaign: AgencyCampaign) => void;
}): CampaignArchive {
  const { showToast, showErrorToast } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<CampaignArchiveAction | null>(null);
  // For the campaign it was opened on, never the next one a screen without a `key` moves to.
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  const confirming = confirmingFor !== null && confirmingFor === id;
  const busyRef = useRef(false);

  const run = useCallback(
    async (action: CampaignArchiveAction) => {
      if (!id || !tenantId || !accountId || busyRef.current) return;
      busyRef.current = true;
      setBusy(action);
      try {
        const updated = await setAgencyCampaignArchived(id, action, tenantId, accountId);
        commitCampaign(updated);
        if (action === 'archive') {
          showToast(ARCHIVE_TOASTS.archived, 'success', undefined, {
            label: 'View archived',
            onClick: () => navigate('/agency/campaigns/archived'),
          });
        } else {
          showToast(ARCHIVE_TOASTS.restored, 'success');
        }
        trackArchiveAction({ id, status: updated.status }, action, 'campaign_header');
      } catch (err: unknown) {
        if (err instanceof ApiError && err.statusCode === 409) void refreshCampaign();
        showErrorToast(err, action === 'archive' ? ARCHIVE_TOASTS.archiveFailed : ARCHIVE_TOASTS.restoreFailed);
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [id, tenantId, accountId, commitCampaign, refreshCampaign, showToast, showErrorToast, navigate],
  );

  const onArchive = useCallback(() => setConfirmingFor(id ?? null), [id]);
  const onRestore = useCallback(() => void run('unarchive'), [run]);

  // A campaign an inbound number files its unknown callers under (docs/call-log.md §5): Archive
  // asks first, and says which number.
  const routeWarning = unknownCallersWarning(useUnknownCallerRoutes(id, tenantId, accountId, confirming));
  const archiveMessage = campaignStatus === 'draft' ? `${ARCHIVE_CONFIRM.message} ${ARCHIVE_CONFIRM.draftNote}` : ARCHIVE_CONFIRM.message;
  const confirmDialog = confirming ? (
    <ConfirmDialog
      open
      title={ARCHIVE_CONFIRM.title}
      message={routeWarning ? `${archiveMessage} ${routeWarning}` : archiveMessage}
      confirmLabel="Archive campaign"
      disabled={busy !== null}
      onConfirm={() => {
        setConfirmingFor(null);
        void run('archive');
      }}
      onCancel={() => setConfirmingFor(null)}
    />
  ) : null;

  return { busy, onArchive, onRestore, confirmDialog };
}
