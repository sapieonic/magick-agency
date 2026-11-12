import { useEffect, useMemo, useRef } from 'react';
import { AGENCY_HOME_CAMPAIGN_CAP, type AgencyHomeCampaignStats } from '@magick-agency/contracts/api/agency/home';
import { HOME_FAST_MS, useHomeBoard } from '../../../hooks/useHomeBoard';
import { useVisibleInterval } from '../../../hooks/useVisibleInterval';
import { REFRESH_MS, needsPolling } from '../../../utils/agencyCampaignsHome';
import type { AgencyCampaign } from '../../../types/agency-campaign';

/** What an Active card shows: its numbers, still loading, or why it has none. */
export type CardState =
  | { status: 'loading' }
  | { status: 'ready'; stats: AgencyHomeCampaignStats }
  | { status: 'error' };

export function readyStats(state: CardState | undefined): AgencyHomeCampaignStats | null {
  return state?.status === 'ready' ? state.stats : null;
}

export interface ActiveCards {
  /** The campaigns with a card: the first {@link AGENCY_HOME_CAMPAIGN_CAP} active ones, in the list's order. */
  shown: AgencyCampaign[];
  /** Each shown campaign's numbers, by id. */
  states: Record<string, CardState>;
  /** Active campaigns past the cap, which have no card (the page links to the Active tab). */
  more: number;
}

/**
 * The Active cards' numbers: ONE request per refresh, Home's board (`GET /proxy/agency/home`,
 * `hooks/useHomeBoard`, B28a), in place of a `/stats` read per active campaign. The board answers
 * the first 25 active campaigns in this page's own order (running, stopping, paused; newest first
 * within each) with their stall, floor, 24-hour abandonment, calls, dials, contact counts and line
 * share; the campaigns past it get no card.
 * Read every 10 s and on return while any campaign is active, and not at all otherwise. One board
 * per tenant, account and role, so for a supervisor it is the sidebar's Home badge's and the page
 * adds no request to it. Below `agency.supervise` the board carries no insights parts (null:
 * staffing, allocation, today, settings), which the cards never read; the route is
 * `agency.campaigns.read`, the page's own floor, so a viewer or operator is never refused it.
 *
 * It also keeps the list current while a campaign moves (`needsPolling`, the campaign detail
 * page's rule, over the board's floor): a campaign that finishes leaves the cards on the next tick.
 * A campaign entering the active set or changing status is read at once rather than at the tick.
 * A campaign the list still shows that a board read after it was shown no longer carries has left
 * the active set (stopped in another tab, say, while paused and still, so nothing polls the list):
 * the list is read again, once per such board read, so its card goes rather than loading forever.
 */
export function useActiveCards(
  tenantId: string | null,
  accountId: string | null,
  role: string | null | undefined,
  active: AgencyCampaign[],
  reloadList: () => Promise<void>,
): ActiveCards {
  const board = useHomeBoard({ tenantId, accountId, role, enabled: active.length > 0, intervalMs: HOME_FAST_MS });
  const shown = useMemo(() => active.slice(0, AGENCY_HOME_CAMPAIGN_CAP), [active]);

  const states = useMemo(() => {
    const byId = new Map(board.reads.map((r) => [r.campaign.id, r]));
    const out: Record<string, CardState> = {};
    for (const c of shown) {
      const read = byId.get(c.id);
      if (read?.stats) out[c.id] = { status: 'ready', stats: read.stats };
      // On the board with nothing ever read for it, or no board at all: there are no numbers.
      else if ((read && board.status === 'ready') || board.status === 'error') out[c.id] = { status: 'error' };
      // Not read yet, or started since the board was read: the next read brings it.
      else out[c.id] = { status: 'loading' };
    }
    return out;
  }, [board.reads, board.status, shown]);

  // A campaign entering the active set, or changing status within it, is read at once. Not on the
  // first set: the board reads as it is joined.
  const { reload } = board;
  const activeKey = shown.map((c) => `${c.id}:${c.status}`).join(',');
  const seenKey = useRef<string | null>(null);
  useEffect(() => {
    if (activeKey === '') return;
    if (seenKey.current !== null && seenKey.current !== activeKey) reload();
    seenKey.current = activeKey;
  }, [activeKey, reload]);

  // A shown campaign a ready board has dropped: read the list again, once per board read.
  const seenAt = useRef(new Map<string, number>());
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    const now = Date.now();
    const ids = new Set(shown.map((c) => c.id));
    for (const id of seenAt.current.keys()) if (!ids.has(id)) seenAt.current.delete(id);
    for (const id of ids) if (!seenAt.current.has(id)) seenAt.current.set(id, now);
    const answeredAt = board.lastUpdatedAt;
    if (board.status !== 'ready' || answeredAt === null) return;
    const onBoard = new Set(board.reads.map((r) => r.campaign.id));
    // Only a board read that answered after the campaign was shown can say it has gone.
    const dropped = shown.filter((c) => !onBoard.has(c.id) && (seenAt.current.get(c.id) ?? Infinity) <= answeredAt);
    if (dropped.length === 0) return;
    const ask = `${answeredAt}:${dropped.map((c) => c.id).join(',')}`;
    if (askedFor.current === ask) return;
    askedFor.current = ask;
    void reloadList().catch(() => undefined);
  }, [shown, board.status, board.reads, board.lastUpdatedAt, reloadList]);

  const moving = shown.some((c) => needsPolling(c.status, readyStats(states[c.id])));
  const busy = useRef(false);
  useVisibleInterval(async () => {
    // One list read at a time: a slow backend must not stack ticks on top of each other.
    if (busy.current) return;
    busy.current = true;
    try {
      await reloadList();
    } finally {
      busy.current = false;
    }
  }, REFRESH_MS, moving);

  return { shown, states, more: active.length - shown.length };
}
