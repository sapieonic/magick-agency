import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgencyCampaign, getAgencyCampaignStats } from '../../../api/agencyCampaigns';
import { useRefetchOnReturn } from '../../../hooks/useRefetchOnReturn';
import { useVisibleInterval } from '../../../hooks/useVisibleInterval';
import { needsPolling } from '../../../utils/agencyCampaignsHome';
import { TAB_BADGE_FRESH_MS } from '../../../hooks/useCampaignTabBadges';
import type { AgencyCampaign, AgencyCampaignStats } from '../../../types/agency-campaign';

const REFRESH_MS = 10_000;

/**
 * The campaign's other sections (Contacts, Call log, History: `CampaignWorkspace`) re-read the
 * header's campaign and stats this often while it is moving, against the Monitor tabs' 10
 * seconds. Not never: the health strip is a live diagnosis (`aria-live`) and the bar's on-shift
 * count is shared with the next campaign screen, so neither may sit on one read from minutes
 * ago. Not 10s either: nobody on a list is watching the header move. The same span as the
 * shared badge's freshness, so a count published from here is never older than one read from
 * the store would be.
 */
export const WORKSPACE_REFRESH_MS = TAB_BADGE_FRESH_MS;

/**
 * The campaign detail page's data: the campaign row and its stats, read
 * together, refetched on return to the tab and polled while anything is moving.
 *
 * Out of `AgencyCampaignDetailPage` so the page is its controls and its panels.
 * The lifecycle actions stay on the page, and write what the server answered
 * through {@link AgencyCampaignDetail.commitCampaign}, which also fences off any
 * read that started before the write.
 *
 * Only ever the campaign `id` names. The routes have no `key`, so moving from one campaign to
 * another keeps the screen mounted: the moment `id` changes, everything held for the previous
 * one is dropped (`loading` again until the new one is read), and an answer or a write for it
 * that lands afterwards is not painted. Otherwise its name, status and Stop button stayed on
 * screen over the next campaign's id, and a Stop clicked then stopped the next campaign.
 */
export interface AgencyCampaignDetail {
  campaign: AgencyCampaign | null;
  /** `null` until read, and after a stats read failed (`statsError`): never the previous read's. */
  stats: AgencyCampaignStats | null;
  /** The campaign row could not be read. Its previous read, if any, is still shown. */
  error: string | null;
  /** The campaign was read but its stats were not: the campaign is shown, `stats` is `null`. */
  statsError: string | null;
  loading: boolean;
  lastUpdatedAt: Date | null;
  /** Whether the poll is running — the header says "Auto-refreshing". */
  shouldPoll: boolean;
  /** The campaign as of the latest write or read — current at click time, not at the last paint. */
  campaignRef: { readonly current: AgencyCampaign | null };
  /**
   * Read the campaign and its stats together. Resolves to the campaign this read observed, or
   * `null` when the campaign could not be read (a stats failure alone still resolves to it).
   */
  load: () => Promise<AgencyCampaign | null>;
  /** Re-read the campaign row alone (the Start / Resume preflight and the 409 repair). */
  refreshCampaign: () => Promise<AgencyCampaign | null>;
  /** Paint a campaign the server just answered with, and fence off every older read. */
  commitCampaign: (campaign: AgencyCampaign) => void;
}

/**
 * `pollMs` is how often the campaign is re-read while it is moving: every 10 seconds on the
 * Monitor tabs (the default), {@link WORKSPACE_REFRESH_MS} on a screen that shows the campaign's
 * header but is not watching it (`CampaignWorkspace`).
 */
export function useAgencyCampaignDetail(
  id: string | undefined,
  tenantId: string | null,
  accountId: string | null,
  { pollMs = REFRESH_MS }: { pollMs?: number } = {},
): AgencyCampaignDetail {
  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  const [stats, setStats] = useState<AgencyCampaignStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  /*
    Another campaign: drop what is held for the previous one before anything paints (state set
    during render is applied before React commits, so the previous campaign's header is never on
    screen under the new id). `idRef` is the id as of this render, for the answers below that
    land after a move.
  */
  const [heldFor, setHeldFor] = useState(id);
  if (heldFor !== id) {
    setHeldFor(id);
    setCampaign(null);
    setStats(null);
    setError(null);
    setStatsError(null);
    setLastUpdatedAt(null);
    setLoading(true);
  }
  const idRef = useRef(id);
  idRef.current = id;

  /*
    The page's `runAction` is a memoized callback whose dependency array does
    not include `campaign` — reading the `campaign` state variable directly inside
    it would close over whatever `campaign` was at the callback's last
    recreation, not the value at click time. A ref (the same pattern `loadRef`
    uses below) is what lets it read the status the request is actually
    leaving FROM.
  */
  const campaignRef = useRef<AgencyCampaign | null>(campaign);
  campaignRef.current = heldFor === id ? campaign : null;
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
    /*
      Both at once, and painted together: the status drives which controls render, and stale
      counters beside a fresh status is the combination that misleads. But settled apart: a
      stats outage must not take the campaign with it. The campaign is painted and the stats
      are dropped (`null`, said by `statsError`), never kept from the previous read beside it.
    */
    const [campaignRead, statsRead] = await Promise.allSettled([
      getAgencyCampaign(id, tenantId, accountId),
      getAgencyCampaignStats(id, tenantId, accountId),
    ]);
    // A newer load, a Start preflight or a write owns the paint, or the URL names another
    // campaign now.
    const current = token === loadTokenRef.current && id === idRef.current;
    if (campaignRead.status === 'rejected') {
      if (!current) return campaignRef.current;
      const err: unknown = campaignRead.reason;
      setError(err instanceof Error ? err.message : 'Could not load this campaign.');
      setLoading(false);
      return null;
    }
    const nextCampaign = campaignRead.value;
    if (!current) {
      // This body is still what THIS request observed — returning `campaignRef` here
      // would report a stale `draft` to an awaiting Start click after a
      // focus refresh had already superseded the token.
      return nextCampaign;
    }
    // Written here as well as during render: a 409 handler awaits this
    // function and must see the status it just fetched, not the one the
    // last paint closed over.
    campaignRef.current = keepIfUnchanged(campaignRef.current, nextCampaign);
    setCampaign(campaignRef.current);
    setError(null);
    if (statsRead.status === 'fulfilled') {
      setStats(statsRead.value);
      setStatsError(null);
    } else {
      const err: unknown = statsRead.reason;
      setStats(null);
      setStatsError(err instanceof Error ? err.message : 'Could not load this campaign’s live figures.');
    }
    setLastUpdatedAt(new Date());
    setLoading(false);
    return nextCampaign;
  }, [id, tenantId, accountId]);

  /**
   * Campaign row only — the Start / Resume preflight and the 409 repair.
   * `load()` waits on stats as well (the page paints them together), and a
   * slow stats read must not hold up the status a Start click is decided on.
   */
  const refreshCampaign = useCallback(async (): Promise<AgencyCampaign | null> => {
    if (!id || !tenantId || !accountId) return null;
    try {
      const nextCampaign = await getAgencyCampaign(id, tenantId, accountId);
      // Read for a campaign the URL no longer names: what it observed, painted nowhere.
      if (id !== idRef.current) return nextCampaign;
      loadTokenRef.current += 1;
      campaignRef.current = keepIfUnchanged(campaignRef.current, nextCampaign);
      setCampaign(campaignRef.current);
      return nextCampaign;
    } catch {
      return id === idRef.current ? campaignRef.current : null;
    }
  }, [id, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const commitCampaign = useCallback((next: AgencyCampaign) => {
    // A write that answered after the move to another campaign: not this screen's campaign.
    if (next.id !== idRef.current) return;
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
  // load at a time — the home has always polled that way. A failed stats read
  // keeps the poll going as well: without the stats the predicate cannot see
  // the live calls of a paused campaign, and the next tick is the retry.
  const shouldPoll = needsPolling(campaign?.status ?? '', stats) || statsError !== null;
  useVisibleInterval(() => loadRef.current(), pollMs, shouldPoll);

  return {
    campaign,
    stats,
    error,
    statsError,
    loading,
    lastUpdatedAt,
    shouldPoll,
    campaignRef,
    load,
    refreshCampaign,
    commitCampaign,
  };
}

/**
 * The campaign as it was when a re-read returns the same row: a poll then changes nothing a
 * screen keyed on the campaign object would re-render or recompute for.
 */
function keepIfUnchanged(previous: AgencyCampaign | null, next: AgencyCampaign): AgencyCampaign {
  return previous !== null && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
