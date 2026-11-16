import { useCallback, useEffect, useRef, useState } from 'react';
import { listLiveCalls } from '../../api/liveCalls';
import { errorCode, errorStatus } from '../../utils/agencyErrors';
import { offsetFromSample } from '../../utils/agencyClock';
import { mergeLiveCalls, pruneEndedLiveCalls, type ShownLiveCall } from '../../utils/listen/liveCallsTable';
import { useVisibleInterval } from '../useVisibleInterval';
import { useRefetchOnReturn } from '../useRefetchOnReturn';

/** How often the live list is read while the page is visible (`docs/listening.md` §4). */
export const LIVE_CALLS_POLL_MS = 5_000;

/**
 * What a failed read means: `forbidden` (no `agency.supervise`, or the flag went off:
 * `feature_disabled`) stops the poll and says so; anything else keeps the rows it had and retries
 * on the next tick ("Could not load live calls. Retrying…").
 */
export type LiveCallsFailure = 'forbidden' | 'feature_disabled' | 'transient';

export interface LiveCallsRead {
  /** The rows, the ones that just ended included (faded for 3 s). Null before the first answer. */
  rows: ShownLiveCall[] | null;
  /** Client ms of the last good answer: "Updated N s ago". */
  receivedAt: number | null;
  /** Server clock correction from the last answer's `as_of` (ms, subtracted from server instants). */
  clockOffsetMs: number;
  failure: LiveCallsFailure | null;
  reload: () => Promise<void>;
}

/**
 * The live list, read every 5 s while the page is visible (never stacked: `useVisibleInterval`),
 * again on returning to the tab, and kept honest about time: `as_of` sets the server clock the
 * timers count on. A call that leaves the list lingers 3 s as ended.
 */
export function useLiveCalls(params: {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  campaignId?: string;
  enabled: boolean;
}): LiveCallsRead {
  const { tenantId, accountId, campaignId, enabled } = params;
  const [rows, setRows] = useState<ShownLiveCall[] | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [failure, setFailure] = useState<LiveCallsFailure | null>(null);
  const scope = `${tenantId ?? ''}|${accountId ?? ''}|${campaignId ?? ''}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const stopped = failure === 'forbidden' || failure === 'feature_disabled';

  // Another account or campaign: start from nothing, never show the last one's calls.
  useEffect(() => {
    setRows(null);
    setReceivedAt(null);
    setFailure(null);
  }, [scope]);

  const reload = useCallback(async () => {
    if (!enabled || !tenantId || !accountId) return;
    const asked = scope;
    const sentAt = Date.now();
    try {
      const res = await listLiveCalls(campaignId ? { campaign_id: campaignId } : {}, tenantId, accountId);
      if (scopeRef.current !== asked) return;
      const now = Date.now();
      const serverTs = Date.parse(res.as_of);
      if (Number.isFinite(serverTs)) setClockOffsetMs(offsetFromSample({ ts: sentAt, server_ts: serverTs, receivedAt: now }));
      setRows((prev) => mergeLiveCalls(prev ?? [], res.calls, now));
      setReceivedAt(now);
      setFailure(null);
    } catch (err) {
      if (scopeRef.current !== asked) return;
      const status = errorStatus(err);
      if (status === 403 && errorCode(err) === 'feature_disabled') setFailure('feature_disabled');
      else if (status === 403) setFailure('forbidden');
      else setFailure('transient');
    }
  }, [enabled, tenantId, accountId, campaignId, scope]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useVisibleInterval(reload, LIVE_CALLS_POLL_MS, enabled && !stopped);
  useRefetchOnReturn(() => (enabled && !stopped ? reload() : undefined));

  // An ended row goes after its 3 s even when no read lands in between.
  const hasEnded = rows?.some((r) => r.endedAt !== null) ?? false;
  useEffect(() => {
    if (!hasEnded) return;
    const timer = setInterval(() => setRows((prev) => (prev ? pruneEndedLiveCalls(prev, Date.now()) : prev)), 500);
    return () => clearInterval(timer);
  }, [hasEnded]);

  return { rows, receivedAt, clockOffsetMs, failure, reload };
}
