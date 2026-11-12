import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
import type { AgencyHomeBoard } from '@magick-agency/contracts/api/agency/home';
import { board, onBoard, stats } from '../helpers/home';

/**
 * Home's reads (B28a), with fake timers: what each reader asks for and when, that Home and the
 * badge share one board and never add requests to each other, that no refresh is lost to another,
 * that a failed read keeps the last good numbers, and that a scope change discards a read still
 * in flight. One request per read (`GET /proxy/agency/home`).
 */

const api = vi.hoisted(() => ({ getAgencyHomeBoard: vi.fn() }));
// Home's acknowledgements are the signed-in reader's (`useHomeAcks`).
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));
vi.mock('../../api/agencyHome', () => api);

import {
  HOME_BOARD_ERROR,
  HOME_BOARD_REFUSED,
  HOME_FAST_MS,
  HOME_SLOW_MS,
  useHomeBadgeCount,
  useHomeBoard,
  type HomeBoardOptions,
} from '../../hooks/useHomeBoard';
import { ApiError } from '../../api/client';

/** The Home page's reader, and the sidebar badge's. */
const live: HomeBoardOptions = { tenantId: 't-1', accountId: 'a-1', enabled: true, intervalMs: HOME_FAST_MS };
const background: HomeBoardOptions = { tenantId: 't-1', accountId: 'a-1', enabled: true, intervalMs: HOME_SLOW_MS };

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

/** A read that answers only when told to. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const overdueOf = (result: { current: ReturnType<typeof useHomeBoard> }) => result.current.reads[0]?.allocation?.callbacks_overdue;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setVisibility('visible');
  api.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('live (the Home page)', () => {
  it('reads once at mount, then one request every 10 s: 31 in five minutes', async () => {
    renderHook(() => useHomeBoard(live));
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledWith('t-1', 'a-1');
    await advance(HOME_FAST_MS);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    await advance(300_000 - HOME_FAST_MS);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(31);
  });

  it('keeps the overdue count moving while Home stays open (the slow numbers are never dropped)', async () => {
    let n = 0;
    api.getAgencyHomeBoard.mockImplementation(async () => {
      n += 1;
      return board([onBoard('c1', { overdue: n })]);
    });
    const { result } = renderHook(() => useHomeBoard(live));
    await flush();
    expect(overdueOf(result)).toBe(1);
    for (let minute = 1; minute <= 5; minute += 1) {
      await advance(HOME_SLOW_MS);
      // Six reads a minute, each carrying the overdue count.
      expect(overdueOf(result)).toBe(1 + minute * 6);
    }
  });

  it('answers a tick that falls due while a read is in flight with that read: nothing is lost or stacked', async () => {
    // Every read takes 12 s, longer than the 10 s tick.
    let n = 0;
    api.getAgencyHomeBoard.mockImplementation(() => {
      n += 1;
      const value = board([onBoard('c1', { overdue: n })]);
      return new Promise<AgencyHomeBoard>((resolve) => setTimeout(() => resolve(value), 12_000));
    });
    const { result } = renderHook(() => useHomeBoard(live));
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    // The 10 s tick arrives while the first read is still out: no second request.
    await advance(HOME_FAST_MS);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    // A return to the tab mid-read is answered by the same read too.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(result.current.status).toBe('ready');
    expect(overdueOf(result)).toBe(1);
    // The next tick starts the next complete read, and it lands.
    await advance(HOME_FAST_MS);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    await advance(12_000);
    expect(overdueOf(result)).toBe(2);
  });
});

describe('background (the sidebar badge on its own)', () => {
  it('reads at mount and then one request a minute: 6 in five minutes, none on the 10 s beat', async () => {
    renderHook(() => useHomeBoard(background));
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    await advance(HOME_SLOW_MS - 1);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    await advance(300_000 - HOME_SLOW_MS);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(6);
  });

  it('reads nothing while the tab is hidden, and catches up once on return', async () => {
    setVisibility('hidden');
    renderHook(() => useHomeBoard(background));
    await flush();
    await advance(300_000);
    expect(api.getAgencyHomeBoard).not.toHaveBeenCalled();
    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
  });
});

describe('one board for Home and the badge', () => {
  it('reads once per 10 s with both mounted: 31 in five minutes, as Home alone', async () => {
    const { result } = renderHook(() => ({ home: useHomeBoard(live), badge: useHomeBoard(background) }));
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    expect(result.current.badge.reads).toBe(result.current.home.reads);
    await advance(300_000);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(31);
  });

  it('adds no read for a badge that mounts beside a fresh board, and goes back to a minute when Home closes', async () => {
    const home = renderHook(() => useHomeBoard(live));
    await flush();
    await advance(3_000);
    const badge = renderHook(() => useHomeBoard(background));
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    expect(badge.result.current.status).toBe('ready');
    home.unmount();
    await advance(HOME_SLOW_MS - 1);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    await advance(240_000);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(6);
  });

  it('reads at once when Home opens beside a board the badge read a while ago, then every 10 s', async () => {
    renderHook(() => useHomeBoard(background));
    await flush();
    await advance(30_000);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    renderHook(() => useHomeBoard(live));
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    await advance(HOME_FAST_MS);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(3);
  });

  it('answers a return with the board when the badge read it under 55 s ago, and a tick just after a return’s read too', async () => {
    renderHook(() => useHomeBoard(background));
    await flush();
    await advance(20_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    await advance(36_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    // The minute's tick, 4 s after that read: skipped.
    await advance(4_000);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
  });
});

describe('when it cannot refresh (it says so, and never an all-clear from old numbers)', () => {
  it('stays fresh for up to two periods of failed reads, then is stale with the last good time; one answer clears it', async () => {
    const { result } = renderHook(() => useHomeBoard(live));
    await flush();
    const answeredAt = result.current.lastUpdatedAt;
    expect(answeredAt).not.toBeNull();
    api.getAgencyHomeBoard.mockRejectedValue(new Error('network'));
    await advance(HOME_FAST_MS);
    await advance(HOME_FAST_MS);
    expect(result.current.failures).toBe(2);
    expect(result.current.stale).toBe(false);
    await advance(HOME_FAST_MS);
    expect(result.current.failures).toBe(3);
    expect(result.current.stale).toBe(true);
    expect(result.current.status).toBe('ready');
    expect(result.current.lastUpdatedAt).toBe(answeredAt);
    api.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    await advance(HOME_FAST_MS);
    expect(result.current.stale).toBe(false);
    expect(result.current.failures).toBe(0);
    expect(result.current.lastUpdatedAt).toBeGreaterThan(answeredAt!);
  });

  it('the badge keeps its last count while stale, marked not fresh (on its own minute)', async () => {
    api.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { overdue: 2 })]));
    const { result } = renderHook(() => useHomeBadgeCount('t-1', 'a-1', 'account_admin', { available: false, count: null }));
    await flush();
    expect(result.current).toEqual({ count: 1, stale: false });
    api.getAgencyHomeBoard.mockRejectedValue(new Error('network'));
    await advance(HOME_SLOW_MS * 2);
    expect(result.current).toEqual({ count: 1, stale: false });
    await advance(HOME_SLOW_MS);
    expect(result.current).toEqual({ count: 1, stale: true });
  });
});

describe('a 403 (the role or the dialer changed mid-session)', () => {
  const refused = () => new ApiError(403, { code: 'feature_disabled', message: 'Forbidden' });

  it('stops asking: no request for five minutes, nothing shown, the refusal in its own words', async () => {
    const { result } = renderHook(() => useHomeBoard(live));
    await flush();
    expect(result.current.reads).toHaveLength(1);
    api.getAgencyHomeBoard.mockRejectedValue(refused());
    await advance(HOME_FAST_MS);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: 'error', error: HOME_BOARD_REFUSED, refused: true, reads: [] });
    await advance(300_000);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
  });

  it('asks again on Retry, and again every period once it answers', async () => {
    api.getAgencyHomeBoard.mockRejectedValueOnce(refused());
    const { result } = renderHook(() => useHomeBoard(live));
    await flush();
    expect(result.current.refused).toBe(true);
    act(() => result.current.reload());
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: 'ready', refused: false });
    await advance(HOME_FAST_MS);
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(3);
  });

  it('a new role is a new board, asked at once', async () => {
    api.getAgencyHomeBoard.mockRejectedValueOnce(refused());
    const { result, rerender } = renderHook((opts: HomeBoardOptions) => useHomeBoard(opts), {
      initialProps: { ...live, role: 'operator' },
    });
    await flush();
    expect(result.current.refused).toBe(true);
    rerender({ ...live, role: 'account_admin' });
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('ready');
  });
});

describe('what a read keeps', () => {
  it('keeps the last good numbers when a read fails', async () => {
    api.getAgencyHomeBoard.mockResolvedValueOnce(board([onBoard('c1', { overdue: 3 })]));
    const { result } = renderHook(() => useHomeBoard(live));
    await flush();
    api.getAgencyHomeBoard.mockRejectedValueOnce(new Error('network'));
    await advance(HOME_FAST_MS);
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
    expect(overdueOf(result)).toBe(3);
  });

  it('keeps a campaign’s stats and overdue count when the server could not read them this time', async () => {
    const before = stats({ agents_live: 4 });
    api.getAgencyHomeBoard.mockResolvedValueOnce(board([onBoard('c1', { stats: before, overdue: 5 })]));
    const { result } = renderHook(() => useHomeBoard(live));
    await flush();
    api.getAgencyHomeBoard.mockResolvedValueOnce(board([onBoard('c1', { stats: null, overdue: null })]));
    await advance(HOME_FAST_MS);
    expect(result.current.reads[0]!.stats).toEqual(before);
    expect(overdueOf(result)).toBe(5);
    // Served from the last read, and marked so.
    expect(result.current.reads[0]!.stale).toBe(true);
    api.getAgencyHomeBoard.mockResolvedValueOnce(board([onBoard('c1', { stats: before, overdue: 5 })]));
    await advance(HOME_FAST_MS);
    expect(result.current.reads[0]!.stale).toBe(false);
  });

  it('shows the error when the first read fails, in its own words, and the board once a later one answers', async () => {
    api.getAgencyHomeBoard.mockRejectedValueOnce(new Error('Route GET:/proxy/agency/home not found'));
    const { result } = renderHook(() => useHomeBoard(live));
    await flush();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(HOME_BOARD_ERROR);
    await advance(HOME_FAST_MS);
    expect(result.current.status).toBe('ready');
  });

  it('starts clean on a scope change, and a read still in flight for the old account never lands', async () => {
    const old = deferred<AgencyHomeBoard>();
    api.getAgencyHomeBoard.mockImplementation((_t: string, accountId: string) =>
      accountId === 'a-1' ? old.promise : Promise.resolve(board([onBoard('fresh')])));
    const { result, rerender } = renderHook((opts: HomeBoardOptions) => useHomeBoard(opts), { initialProps: live });
    await flush();
    rerender({ ...live, accountId: 'a-2' });
    await flush();
    expect(result.current.reads.map((r) => r.campaign.id)).toEqual(['fresh']);
    await act(async () => {
      old.resolve(board([onBoard('stale')]));
    });
    await flush();
    expect(result.current.reads.map((r) => r.campaign.id)).toEqual(['fresh']);
  });

  it('drops a read still in flight when the board is switched off (the badge as the reader opens Home)', async () => {
    const pending = deferred<AgencyHomeBoard>();
    api.getAgencyHomeBoard.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook((opts: HomeBoardOptions) => useHomeBoard(opts), { initialProps: background });
    await flush();
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    rerender({ ...background, enabled: false });
    await flush();
    await act(async () => {
      pending.resolve(board([onBoard('late')]));
    });
    await flush();
    expect(result.current.status).toBe('idle');
    expect(result.current.reads).toEqual([]);
  });

  it('reads nothing when not enabled', async () => {
    renderHook(() => useHomeBoard({ ...live, enabled: false }));
    await flush();
    await advance(300_000);
    expect(api.getAgencyHomeBoard).not.toHaveBeenCalled();
  });
});
