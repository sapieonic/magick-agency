import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { setAgencyCampaignArchived } from '../../../api/agencyCampaigns';
import { ApiError } from '../../../api/client';
import { ARCHIVE_CONFIRM } from '../../../utils/agencyCampaignArchive';
import type { AgencyCampaign } from '../../../types/agency-campaign';

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
 * Archive and restore from the campaign header (decisions AR1–AR6). The page supplies how it
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
        showToast(
          action === 'archive'
            ? 'Campaign archived. It is now under Archived campaigns.'
            : 'Campaign restored to the Campaigns page.',
          'success',
        );
      } catch (err: unknown) {
        if (err instanceof ApiError && err.statusCode === 409) void refreshCampaign();
        showErrorToast(err, action === 'archive' ? 'Could not archive the campaign.' : 'Could not restore the campaign.');
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [id, tenantId, accountId, commitCampaign, refreshCampaign, showToast, showErrorToast],
  );

  const onArchive = useCallback(() => setConfirmingFor(id ?? null), [id]);
  const onRestore = useCallback(() => void run('unarchive'), [run]);

  const confirmDialog = confirming ? (
    <ConfirmDialog
      open
      title={ARCHIVE_CONFIRM.title}
      message={campaignStatus === 'draft' ? `${ARCHIVE_CONFIRM.message} ${ARCHIVE_CONFIRM.draftNote}` : ARCHIVE_CONFIRM.message}
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
