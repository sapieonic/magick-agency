import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { markMissedInboundCallHandled } from '../api/inbound';
import { useTenant } from '../contexts/TenantContext';
import { inboundRefusalCopy } from '../utils/inbound/inboundCopy';
import { refreshMissedCallsCount } from './useMissedCallsCount';

/** A refusal said on one row of a list of calls. */
export interface MissedRowError {
  id: string;
  message: string;
}

/**
 * Mark handled on a missed call in a list of calls (the Call log, All calls, My calls): the
 * Missed list's own action (`POST /inbound/missed/:id/handled`, idempotent). One at a time; a
 * refusal is said on its row; on success the Missed calls badge is read again and `reload` runs,
 * so the row leaves To follow up and every count agrees.
 */
export function useMarkMissedHandled(reload: () => void): {
  /** The id of the Missed row being marked, or null. */
  marking: string | null;
  rowError: MissedRowError | null;
  /** For the list's other row action (Call back), which says its refusal in the same place. */
  setRowError: Dispatch<SetStateAction<MissedRowError | null>>;
  markHandled: (row: { id: string }) => Promise<void>;
} {
  const { tenantId, accountId } = useTenant();
  const [marking, setMarking] = useState<string | null>(null);
  const [rowError, setRowError] = useState<MissedRowError | null>(null);

  const markHandled = useCallback(async (row: { id: string }) => {
    if (marking) return;
    setMarking(row.id);
    setRowError(null);
    const result = await markMissedInboundCallHandled(row.id, tenantId ?? undefined, accountId ?? undefined);
    setMarking(null);
    if (!result.ok) {
      setRowError({ id: row.id, message: inboundRefusalCopy(result.refusal) });
      return;
    }
    refreshMissedCallsCount();
    reload();
  }, [marking, tenantId, accountId, reload]);

  return { marking, rowError, setRowError, markHandled };
}
