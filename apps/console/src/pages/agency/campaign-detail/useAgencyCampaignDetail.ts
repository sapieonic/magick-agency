import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgencyCampaign, getAgencyCampaignStats } from '../../../api/agencyCampaigns';
import { useRefetchOnReturn } from '../../../hooks/useRefetchOnReturn';
import { useVisibleInterval } from '../../../hooks/useVisibleInterval';
import { needsPolling } from '../../../utils/agencyCampaignsHome';
import type { AgencyCampaign, AgencyCampaignStats } from '../../../types/agency-campaign';

const REFRESH_MS = 10_000;

/**
 * The campaign detail page's data: the campaign row and its stats, read
 * together, refetched on return to the tab and polled while anything is moving.
 *
 * Out of `AgencyCampaignDetailPage` so the page is its controls and its panels.
 * The lifecycle actions stay on the page, and write what the server answered
 * through {@link AgencyCampaignDetail.commitCampaign}, which also fences off any
 * read that started before the write.
 */
export interface AgencyCampaignDetail {
  campaign: AgencyCampaign | null;
  stats: AgencyCampaignStats | null;
  error: string | null;
  loading: boolean;
  lastUpdatedAt: Date | null;
  /** Whether the poll is running — the header says "Auto-refreshing". */
  shouldPoll: boolean;
  /** The campaign as of the latest write or read — current at click time, not at the last paint. */
  campaignRef: { readonly current: AgencyCampaign | null };
  /** Read the campaign and its stats together. Resolves to the campaign this read observed. */
  load: () => Promise<AgencyCampaign | null>;
  /** Re-read the campaign row alone (the Start / Resume preflight and the 409 repair). */
  refreshCampaign: () => Promise<AgencyCampaign | null>;
  /** Paint a campaign the server just answered with, and fence off every older read. */
  commitCampaign: (campaign: AgencyCampaign) => void;
}

export function useAgencyCampaignDetail(
  id: string | undefined,
  tenantId: string | null,
  accountId: string | null,
): AgencyCampaignDetail {
  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  const [stats, setStats] = useState<AgencyCampaignStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  /*
    The page's `runAction` is a memoized callback whose dependency array does
    not include `campaign` — reading the `campaign` state variable directly inside
    it would close over whatever `campaign` was at the callback's last
    recreation, not the value at click time. A ref (the same pattern `loadRef`
    uses below) is what lets it read the status the request is actually
    leaving FROM.
  */
  const campaignRef = useRef<AgencyCampaign | null>(campaign);
  campaignRef.current = campaign;
  /**
   * Monotonic token fencing in-flight GETs. A draft does not poll, so the
   * refresh that hides Start is `visibilitychange` / `focus` — and those can
   * overlap a Start that already succeeded. Without this, the late GET paints
   * `draft` back over `running` and the button that just 409'd is enabled
   * again: the 7× loop this page exists to close.
   */
  const loadTokenRef = useRef(0);

  const load = useCallback(async (): Promise<AgencyCampaign | null> => {
    if (!id || !tenantId || !accountId) return null;
    const token = ++loadTokenRef.current;
    setError(null);
    try {
      // Both together: the status drives which controls render, and stale
      // counters beside a fresh status is the combination that misleads.
      const [nextCampaign, nextStats] = await Promise.all([
        getAgencyCampaign(id, tenantId, accountId),
        getAgencyCampaignStats(id, tenantId, accountId),
      ]);
      if (token !== loadTokenRef.current) {
        // A newer load (or a Start preflight) owns the paint. This body is
        // still what THIS request observed — returning `campaignRef` here
        // would report a stale `draft` to an awaiting Start click after a
        // focus refresh had already superseded the token.
        return nextCampaign;
      }
      // Written here as well as during render: a 409 handler awaits this
      // function and must see the status it just fetched, not the one the
      // last paint closed over.
      campaignRef.current = nextCampaign;
      setCampaign(nextCampaign);
      setStats(nextStats);
      setLastUpdatedAt(new Date());
      return nextCampaign;
    } catch (err: unknown) {
      if (token !== loadTokenRef.current) return campaignRef.current;
      setError(err instanceof Error ? err.message : 'Could not load this campaign.');
      return null;
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }, [id, tenantId, accountId]);

  /**
   * Campaign row only — the Start / Resume preflight and the 409 repair.
   * `load()` waits on stats as well (the page paints them together), and a
   * stats outage must not turn a fresh `running` into `null` and fall back
   * to the stale `draft` whose Start button would otherwise be hidden.
   */
  const refreshCampaign = useCallback(async (): Promise<AgencyCampaign | null> => {
    if (!id || !tenantId || !accountId) return null;
    try {
      const nextCampaign = await getAgencyCampaign(id, tenantId, accountId);
      loadTokenRef.current += 1;
      campaignRef.current = nextCampaign;
      setCampaign(nextCampaign);
      return nextCampaign;
    } catch {
      return campaignRef.current;
    }
  }, [id, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const commitCampaign = useCallback((next: AgencyCampaign) => {
    loadTokenRef.current += 1;
    campaignRef.current = next;
    setCampaign(next);
  }, []);

  /**
   * Poll only while something is actually moving — but "moving" is not the same
   * as "running".
   *
   * Status alone is the wrong predicate. A **paused** campaign places no new
   * calls and its in-flight ones keep going to their natural end, so its
   * counters continue to change for as long as the longest live call. Keying
   * the poll on status meant "Live now", "Done" and "Connected" froze the
   * instant a supervisor pressed Pause — exactly when they are watching to see
   * the calls drain, and exactly when a frozen number reads as a finished
   * drain.
   *
   * So: poll while the status implies movement OR while the server says
   * attempts are still live. `attempts_live` comes from the API's own count, not
   * from anything derived here.
   *
   * **Anyone on the floor is also movement**. Agent state changes
   * without any attempt being live — a break ends, a wrap-up is submitted, a
   * station drops — and is a live view of exactly those. The durations tick
   * client-side from `state_since`, so an unpolled floor does not *look* frozen;
   * it looks current and reports states the agents left minutes ago, which is
   * worse. This is not the same predicate as `attempts_live`: a paused campaign
   * draining its last call still has its whole floor sitting in `available`.
   */
  const loadRef = useRef(load);
  loadRef.current = load;

  /**
   * A draft (or a drained pause) does not poll — nothing is moving. That is
   * also the view that still shows Start / Resume after another tab, or this
   * tab's own first click, has already moved the campaign. Coming back to the
   * window is the moment to learn that, so the button can be hidden instead
   * of letting the click become the API's 409.
   */
  useRefetchOnReturn(() => loadRef.current());

  // The campaigns home's cards use the same predicate: running or stopping, OR
  // calls still in flight, OR anyone on the floor. Visible tabs only, and one
  // load at a time — the home has always polled that way.
  const shouldPoll = needsPolling(campaign?.status ?? '', stats);
  useVisibleInterval(() => loadRef.current(), REFRESH_MS, shouldPoll);

  return {
    campaign,
    stats,
    error,
    loading,
    lastUpdatedAt,
    shouldPoll,
    campaignRef,
    load,
    refreshCampaign,
    commitCampaign,
  };
}
