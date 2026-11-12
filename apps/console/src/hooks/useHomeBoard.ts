import { useCallback, useSyncExternalStore } from 'react';
import { getAgencyHomeBoard } from '../api/agencyHome';
import { ApiError } from '../api/client';
import { REFRESH_MS } from '../utils/agencyCampaignsHome';
import { homeAttention, homeBadgeCount, type HomeCampaignRead, type HomeMissed } from '../utils/agency/home';
import { splitAcknowledged } from '../utils/agency/homeAcks';
import { useHomeAcks } from './useHomeAcks';
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
  /**
   * The reader's role, part of the board's identity: a board refused (403) stops asking until the
   * scope or the role changes, and a new role is a new board that asks at once.
   */
  role?: string | null;
  enabled: boolean;
  /** How often this reader wants the board read: {@link HOME_FAST_MS} or {@link HOME_SLOW_MS}. */
  intervalMs: number;
}

/**
 * What Home says when its board could not be read: product copy, never the server's text (a
 * route-not-found or a stack's message means nothing to a supervisor). Retry reads again.
 */
export const HOME_BOARD_ERROR = 'We couldn’t load what needs your attention. Try again in a moment.';

/** What Home says when the server refuses the board (403: the role or the dialer changed). */
export const HOME_BOARD_REFUSED = 'Home isn’t available to you in this account right now.';

/**
 * A board is stale once its reads have failed for more than this many of its periods since the
 * last one that answered: Home then says it couldn't refresh, and never gives an all-clear.
 */
export const HOME_STALE_PERIODS = 2;

export interface HomeBoard {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** The capped active campaigns, in Campaigns-page order, with what was read for each. */
  reads: HomeCampaignRead[];
  /** Active campaigns before the cap. */
  activeTotal: number;
  /** Whether the account has any campaign at all; null until the first read answers. */
  anyCampaign: boolean | null;
  /** `Date.now()` when a read last answered; null before the first. */
  lastUpdatedAt: number | null;
  /** Reads in a row that failed since the last that answered. */
  failures: number;
  /**
   * The reads have failed for more than {@link HOME_STALE_PERIODS} periods since the last that
   * answered: what is shown is that read's, and the page says so.
   */
  stale: boolean;
  /** The server refused the board (403): nothing is shown and nothing is asked until Retry or a new scope or role. */
  refused: boolean;
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
  lastUpdatedAt: null,
  failures: 0,
  stale: false,
  refused: false,
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
  /** The server answered 403: no timer and no read until {@link HomeBoard.reload}. */
  refused: boolean;
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
        // A part the server could not read this time (null) keeps the last good one, marked stale.
        const kept = <K extends 'stats' | 'staffing' | 'allocation' | 'today'>(key: K): HomeCampaignRead[K] =>
          (c[key] ?? before?.[key] ?? null) as HomeCampaignRead[K];
        const stale = (['stats', 'staffing', 'allocation', 'today'] as const)
          .some((key) => c[key] === null && before?.[key] != null);
        return {
          campaign: { id: c.id, name: c.name, status: c.status },
          stats: kept('stats'),
          staffing: kept('staffing'),
          allocation: kept('allocation'),
          today: kept('today'),
          settings: c.settings,
          stale,
        };
      });
      board.last = new Map(reads.map((r) => [r.campaign.id, r]));
      setState(board, {
        status: 'ready',
        error: null,
        reads,
        activeTotal: answer.active_total,
        anyCampaign: answer.any_campaign,
        lastUpdatedAt: Date.now(),
        failures: 0,
        stale: false,
        refused: false,
      });
    } catch (err) {
      if (board.generation !== mine) return;
      if (err instanceof ApiError && err.statusCode === 403) {
        // The role or the dialer changed under this reader: asking again every few seconds only
        // collects 403s. Stop until Retry, or a new scope or role (a new board).
        board.refused = true;
        stopTimer(board);
        board.last = new Map();
        setState(board, { ...IDLE, status: 'error', error: HOME_BOARD_REFUSED, refused: true });
        return;
      }
      const failures = board.state.failures + 1;
      const since = board.state.lastUpdatedAt;
      if (since === null) {
        // Never read: nothing to show but the error.
        setState(board, { ...board.state, status: 'error', error: HOME_BOARD_ERROR, failures });
        return;
      }
      // A failed read keeps what is on screen, and says so once it has failed long enough.
      const stale = Date.now() - since > HOME_STALE_PERIODS * fastest(board);
      setState(board, { ...board.state, failures, stale });
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
  if (board.refused || document.visibilityState !== 'visible') return undefined;
  if (board.inFlight) return board.inFlight;
  const fresh = board.state.status === 'ready' && Date.now() - board.readAt < fastest(board) - SLACK_MS;
  if (fresh) return undefined;
  return read(board, 'tick');
}

function stopTimer(board: Board): void {
  if (board.timer !== null) clearInterval(board.timer);
  board.timer = null;
}

/** One timer per board, at its fastest reader's period; none while the board is refused. */
function schedule(board: Board): void {
  if (board.refused) return;
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
      refused: false,
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

function boardKey(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  role: string | null | undefined,
  enabled: boolean,
): string | null {
  return enabled && tenantId && accountId ? `${tenantId}/${accountId}/${role ?? ''}` : null;
}

/**
 * The board's reads: ONE request per refresh, `GET /proxy/agency/home` (`api/agencyHome.ts`),
 * which answers the active campaigns (at most `HOME_CAMPAIGN_CAP`, 25, running first), each with
 * the fields of `/stats` its readers use and, for a supervisor, what the campaign Overview's
 * attention rules read (staffing, allocation, today's figures, settings; null below
 * `agency.supervise`). The server reuses a still campaign's stats while its floor holds, and the
 * insights figures, for a minute, so asking every 10 s costs what one `/stats` poll did.
 *
 * Its readers: the Home page, the sidebar's Home badge (and the phone's menu-button dot), and the
 * Campaigns page's Active cards (`campaigns-home/useActiveCards.ts`). One board per tenant,
 * account and role, shared by every mounted reader: one read at a time, on one timer at the
 * fastest period any reader asks for (Home's and the Active cards' 10 s while open, the badge's
 * minute elsewhere). A reader that mounts, the timer and a return to the tab read only when the
 * tab is visible and the board is older than that period (less {@link SLACK_MS}), so a second
 * reader never adds a request.
 *
 *  - **Every read is complete**, so a tick that falls due while a read is in flight is answered by
 *    that read rather than dropped: no kind of refresh can be lost to another.
 *  - **A failed read keeps the last good numbers**, and so does a campaign part the server could
 *    not read this time (`null` on the board), marked `stale` on its read. Once the reads have
 *    failed for more than {@link HOME_STALE_PERIODS} periods since the last that answered, the
 *    board is `stale` and Home says "Couldn't refresh" with the time of that read.
 *  - **A 403 stops the asking** (`refused`): the timer stops and nothing is shown, until Retry or
 *    a new scope or role, which is a new board.
 *  - **A new scope starts clean**: the board goes with its last reader, and a read still in flight
 *    for it is discarded.
 */
export function useHomeBoard({ tenantId, accountId, role, enabled, intervalMs }: HomeBoardOptions): HomeBoard {
  const key = boardKey(tenantId, accountId, role, enabled);
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
    if (!board) return;
    if (board.refused) {
      board.refused = false;
      schedule(board);
    }
    void read(board, 'full');
  }, [key]);
  return { ...state, reload };
}

/** The Home badge: its count, and whether it is the last good read's (the board is stale). */
export interface HomeBadge {
  /** Null until the board has answered, and while it is refused. */
  count: number | null;
  stale: boolean;
}

/**
 * The Home badge (the sidebar's, and the dot on the phone's menu button): the dangers and
 * warnings on Home's list (`homeAttention`, `homeBadgeCount`) the reader has not put aside ("Got
 * it", `useHomeAcks`), read from the shared board at the badge's own period. While the board is
 * stale it keeps the last count, marked not fresh, rather than dropping to nothing (which would
 * read as an all-clear).
 */
export function useHomeBadgeCount(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  role: string | null | undefined,
  missed: HomeMissed,
): HomeBadge {
  const board = useHomeBoard({ tenantId, accountId, role, enabled: true, intervalMs: HOME_SLOW_MS });
  const { acks } = useHomeAcks(tenantId, accountId);
  return {
    count: board.status === 'ready'
      ? homeBadgeCount(splitAcknowledged(homeAttention(board.reads, missed, () => ''), acks).open)
      : null,
    stale: board.status === 'ready' && board.stale,
  };
}
