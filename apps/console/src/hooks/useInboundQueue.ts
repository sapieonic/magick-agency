import { useCallback, useEffect, useRef, useState } from 'react';
import { getInboundQueue } from '../api/inbound';
import { useVisibleInterval } from './useVisibleInterval';
import type { AgencyInboundQueueTile } from '../types/inbound';

/** The supervisor's queue tiles poll this often (Q23: no push over a socket). */
export const INBOUND_QUEUE_POLL_MS = 5_000;

export interface InboundQueueState {
  /** Null until the first answer. */
  tiles: AgencyInboundQueueTile[] | null;
  /** The last read failed; the tiles shown (if any) are the last good ones. */
  error: boolean;
  reload: () => void;
}

/**
 * The account's inbound queue (`GET /inbound/queue`), read on mount and every
 * {@link INBOUND_QUEUE_POLL_MS} while the page is visible, never two reads at once
 * (`useVisibleInterval`). A failed read keeps the last good tiles and says so: a supervisor
 * watching the floor needs to know the numbers stopped moving, not to lose them.
 */
export function useInboundQueue({
  tenantId,
  accountId,
  enabled,
}: {
  tenantId: string | undefined;
  accountId: string | undefined;
  enabled: boolean;
}): InboundQueueState {
  const [tiles, setTiles] = useState<AgencyInboundQueueTile[] | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!enabled || !tenantId || !accountId) return;
    const mine = ++seq.current;
    try {
      const body = await getInboundQueue(tenantId, accountId);
      if (mine !== seq.current) return;
      setTiles(body.tiles);
      setError(false);
    } catch {
      if (mine === seq.current) setError(true);
    }
  }, [enabled, tenantId, accountId]);

  useEffect(() => {
    // A new account (or the gate closing) starts from nothing: another account's tiles are not these.
    seq.current += 1;
    setTiles(null);
    setError(false);
    void load();
  }, [load]);

  useVisibleInterval(load, INBOUND_QUEUE_POLL_MS, enabled && Boolean(tenantId && accountId));

  return { tiles, error, reload: () => void load() };
}
