import { useCallback, useSyncExternalStore } from 'react';
import { getAgencyHomeBoard } from '../api/agencyHome';
import { REFRESH_MS } from '../pages/agency/campaigns-home/useCampaignsHome';
import { homeAttention, homeBadgeCount, type HomeCampaignRead, type HomeMissed } from '../utils/agency/home';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { MISSED_COUNT_POLL_MS } from './useMissedCallsCount';

/** Home's refresh while it is open: the campaigns home's own (and the campaign detail page's). */
export const HOME_FAST_MS = REFRESH_MS;
/**
 * The sidebar badge's refresh, and today's totals': the missed-calls badge's period (a follow-up
 * count, not a live queue).
 */
export const HOME_SLOW_MS = MISSED_COUNT_POLL_MS;
/**
 * A tick or a return skips its read when the board was read less than its period minus this
 * ago: a read the timer itself made is never skipped for being a few milliseconds early.
 */
const SLACK_MS = 5_000;

export interface HomeBoardOptions {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  enabled: boolean;
  /** How often this reader wants the board read: {@link HOME_FAST_MS} or {@link HOME_SLOW_MS}. */
  intervalMs: number;
}

/**
 * What Home says when its board could not be read: product copy, never the server's text (a
 * route-not-found or a stack's message means nothing to a supervisor). Retry reads again.
 */
export const HOME_BOARD_ERROR = 'We couldn’t load what needs your attention. Try again in a moment.';

export interface HomeBoard {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** The capped active campaigns, in Campaigns-page order, with what was read for each. */
  reads: HomeCampaignRead[];
  /** Active campaigns before the cap. */
  activeTotal: number;
  /** Whether the account has any campaign at all; null until the first read answers. */
  anyCampaign: boolean | null;
  reload: () => void;
}

type Kind = 'full' | 'tick';
type BoardState = Omit<HomeBoard, 'reload'>;

const IDLE: BoardState = {
  status: 'idle',
  error: null,
  reads: [],
  activeTotal: 0,
  anyCampaign: null,
};

/** One tenant and account's board, shared by every mounted reader of it. */
interface Board {
  tenantId: string;
  accountId: string;
  state: BoardState;
  /** Each campaign's last read, for a campaign the server could not read this time. */
  last: Map<string, HomeCampaignRead>;
  inFlight: Promise<void> | null;
  /** Bumped by every read and when the board is dropped: a read that is no longer current never lands. */
  generation: number;
  /** `Date.now()` when the last read started; 0 before the first. */
  readAt: number;
  /** Each mounted reader's period; the board is read at the fastest. */
  periods: Map<symbol, number>;
  timer: ReturnType<typeof setInterval> | null;
  timerMs: number;
  listeners: Set<() => void>;
}

const boards = new Map<string, Board>();

function setState(board: Board, state: BoardState): void {
  board.state = state;
  for (const listener of board.listeners) listener();
}

function fastest(board: Board): number {
  return Math.min(...board.periods.values());
}

function read(board: Board, kind: Kind): Promise<void> {
  if (kind === 'tick' && board.inFlight) return board.inFlight;
  const mine = (board.generation += 1);
  board.readAt = Date.now();
  if (board.state.status === 'idle' || (kind === 'full' && board.state.status !== 'ready')) {
    setState(board, { ...board.state, status: 'loading', error: null });
  }
  const run = (async () => {
    try {
      const answer = await getAgencyHomeBoard(board.tenantId, board.accountId);
      if (board.generation !== mine) return;
      const reads = answer.campaigns.map((c): HomeCampaignRead => {
        const before = board.last.get(c.id);
        return {
          campaign: { id: c.id, name: c.name, status: c.status },
          stats: c.stats ?? before?.stats ?? null,
          overdue: c.callbacks_overdue ?? before?.overdue ?? null,
        };
      });
      board.last = new Map(reads.map((r) => [r.campaign.id, r]));
      setState(board, {
        status: 'ready',
        error: null,
        reads,
        activeTotal: answer.active_total,
        anyCampaign: answer.any_campaign,
      });
    } catch {
      // A failed read keeps what is on screen; only a board never read has nothing to show.
      if (board.generation !== mine || board.state.status === 'ready') return;
      setState(board, { ...board.state, status: 'error', error: HOME_BOARD_ERROR });
    }
  })();
  board.inFlight = run;
  void run.finally(() => {
    if (board.inFlight === run) board.inFlight = null;
  });
  return run;
}

/**
 * Read unless the tab is hidden or the board is fresh for its fastest reader; a read already in
 * flight answers instead. Mounting, the timer and a return to the tab all come through here. Only
 * a board that has answered is fresh: one never read, or whose reads failed, reads every time.
 */
function readIfDue(board: Board): Promise<void> | undefined {
  if (document.visibilityState !== 'visible') return undefined;
  if (board.inFlight) return board.inFlight;
  const fresh = board.state.status === 'ready' && Date.now() - board.readAt < fastest(board) - SLACK_MS;
  if (fresh) return undefined;
  return read(board, 'tick');
}

/** One timer per board, at its fastest reader's period. */
function schedule(board: Board): void {
  const ms = fastest(board);
  if (board.timer !== null && board.timerMs === ms) return;
  if (board.timer !== null) clearInterval(board.timer);
  board.timerMs = ms;
  board.timer = setInterval(() => void readIfDue(board), ms);
}

function join(key: string, tenantId: string, accountId: string, intervalMs: number, listener: () => void): () => void {
  let board = boards.get(key);
  if (!board) {
    board = {
      tenantId,
      accountId,
      state: IDLE,
      last: new Map(),
      inFlight: null,
      generation: 0,
      readAt: 0,
      periods: new Map(),
      timer: null,
      timerMs: 0,
      listeners: new Set(),
    };
    boards.set(key, board);
  }
  const me = Symbol('reader');
  board.periods.set(me, intervalMs);
  board.listeners.add(listener);
  schedule(board);
  void readIfDue(board);
  const joined = board;
  return () => {
    joined.periods.delete(me);
    joined.listeners.delete(listener);
    if (joined.periods.size > 0) {
      schedule(joined);
      return;
    }
    // The last reader left: the board goes, and a read still in flight for it never lands.
    if (joined.timer !== null) clearInterval(joined.timer);
    joined.generation += 1;
    boards.delete(key);
  };
}

function boardKey(tenantId: string | null | undefined, accountId: string | null | undefined, enabled: boolean): string | null {
  return enabled && tenantId && accountId ? `${tenantId}/${accountId}` : null;
}

/**
 * Home's reads: ONE request per refresh, `GET /proxy/agency/home` (`api/agencyHome.ts`), which
 * answers the active campaigns (at most `HOME_CAMPAIGN_CAP`, 25, running first), each with the
 * fields of `/stats` Home reads and its overdue callbacks. The server reuses a still campaign's
 * stats and every overdue count for a minute, so asking every 10 s costs what the campaigns
 * home's own poll does.
 *
 * One board per tenant and account, shared by every mounted reader (the Home page and the
 * sidebar's badge): one read at a time, on one timer at the fastest period any reader asks for
 * (Home's 10 s while it is open, the badge's minute elsewhere). A reader that mounts, the timer
 * and a return to the tab read only when the tab is visible and the board is older than that
 * period (less {@link SLACK_MS}), so a second reader never adds a request.
 *
 *  - **Every read is complete**, so a tick that falls due while a read is in flight is answered by
 *    that read rather than dropped: no kind of refresh can be lost to another.
 *  - **A failed read keeps the last good numbers**, and so does a campaign whose stats or overdue
 *    count the server could not read this time (`null` on the board): it keeps what it had.
 *  - **A new scope starts clean**: the board goes with its last reader, and a read still in flight
 *    for it is discarded.
 */
export function useHomeBoard({ tenantId, accountId, enabled, intervalMs }: HomeBoardOptions): HomeBoard {
  const key = boardKey(tenantId, accountId, enabled);
  const subscribe = useCallback(
    (listener: () => void) => (key ? join(key, tenantId!, accountId!, intervalMs, listener) : () => {}),
    // `tenantId` and `accountId` are in `key`.
    [key, intervalMs],
  );
  const state = useSyncExternalStore(subscribe, () => (key ? boards.get(key)?.state ?? IDLE : IDLE));

  useRefetchOnReturn(() => {
    const board = key ? boards.get(key) : undefined;
    return board ? readIfDue(board) : undefined;
  });

  const reload = useCallback(() => {
    const board = key ? boards.get(key) : undefined;
    if (board) void read(board, 'full');
  }, [key]);
  return { ...state, reload };
}

/**
 * The sidebar badge's count: the dangers and warnings on Home's list (`homeAttention`,
 * `homeBadgeCount`), read from the shared board at the badge's own period. Null until the board
 * has answered.
 */
export function useHomeBadgeCount(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  missed: HomeMissed,
): number | null {
  const board = useHomeBoard({ tenantId, accountId, enabled: true, intervalMs: HOME_SLOW_MS });
  return board.status === 'ready' ? homeBadgeCount(homeAttention(board.reads, missed, () => '')) : null;
}
