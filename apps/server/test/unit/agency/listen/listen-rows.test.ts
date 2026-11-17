import { describe, expect, it, vi } from 'vitest';
import {
  ListenRowKeeper,
  LOST_ROW_MIN_AGE_MS,
  MAX_QUEUED_CLOSES,
  type ListenRowStore,
} from '../../../../src/agency/listen/listen-rows.js';
import type { ListenSessionCloseInput } from '../../../../src/db/repositories/agency.repository.js';

const { metrics } = vi.hoisted(() => ({ metrics: { ended: vi.fn() } }));
vi.mock('@magick-agency/observability/metrics/agency', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trackListenSessionEnded: metrics.ended,
}));

/*
 * The listen session rows' upkeep (`listen-rows.ts`, docs/listening.md §4, LS16 o): a close that
 * failed is retried with its own reason and counters until it lands; the sweep closes this
 * process's rows that nothing here holds, and never one the registry holds (a session, a
 * reservation in flight) or one whose close is in flight or queued.
 */

const REVOKED: ListenSessionCloseInput = { reason: 'permission_revoked', framesSent: 9, framesDropped: 2 };

function store(over: { closeOrphans?: ListenRowStore['closeOrphans']; closeOrphansExcept?: ListenRowStore['closeOrphansExcept'] } = {}) {
  return {
    open: vi.fn<ListenRowStore['open']>(async () => ({})),
    close: vi.fn<ListenRowStore['close']>(async () => ({ id: 'x' })),
    closeOrphans: vi.fn<ListenRowStore['closeOrphans']>(over.closeOrphans ?? (async () => [])),
    closeOrphansExcept: vi.fn<ListenRowStore['closeOrphansExcept']>(over.closeOrphansExcept ?? (async () => [])),
    markLive: vi.fn<ListenRowStore['markLive']>(async () => true),
  };
}

describe('ListenRowKeeper', () => {
  it('a failed close rejects to the socket, is queued, and is retried on the next upkeep with its own reason and counters', async () => {
    const s = store();
    s.close.mockRejectedValueOnce(new Error('pool exhausted'));
    const keeper = new ListenRowKeeper(s, 'me');
    await expect(keeper.close('l1', REVOKED)).rejects.toThrow('pool exhausted');
    expect(keeper.queued).toBe(1);
    expect(await keeper.maintain(() => new Set())).toMatchObject({ retried: 1 });
    expect(s.close).toHaveBeenLastCalledWith('l1', REVOKED);
    expect(keeper.queued).toBe(0);
    // Done: the next upkeep does not close it again.
    await keeper.maintain(() => new Set());
    expect(s.close).toHaveBeenCalledTimes(2);
  });

  it('a retry that fails again stays queued; one that finds the row already closed is done', async () => {
    const s = store();
    s.close.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('still down')).mockResolvedValueOnce(null);
    const keeper = new ListenRowKeeper(s, 'me');
    await keeper.close('l1', REVOKED).catch(() => {});
    expect(await keeper.maintain(() => new Set())).toMatchObject({ retried: 0 });
    expect(keeper.queued).toBe(1);
    expect(await keeper.maintain(() => new Set())).toMatchObject({ retried: 1 });
    expect(keeper.queued).toBe(0);
  });

  it('the sweep keeps what the registry holds and every close in flight or queued, past the age floor', async () => {
    let finishClose: () => void = () => {};
    const s = store();
    s.close
      .mockRejectedValueOnce(new Error('down')) // `queued`
      .mockImplementationOnce(() => new Promise((resolve) => { finishClose = () => resolve({}); })); // `inflight`
    const keeper = new ListenRowKeeper(s, 'me');
    await keeper.close('queued', REVOKED).catch(() => {});
    const inflight = keeper.close('inflight', REVOKED);
    s.close.mockRejectedValue(new Error('down')); // the retry of `queued` fails again: still queued
    await keeper.maintain(() => new Set(['session1', 'reservation1']));
    expect(s.closeOrphans).toHaveBeenCalledTimes(1);
    const [replica, opts] = s.closeOrphans.mock.calls[0]!;
    expect(replica).toBe('me');
    expect([...opts.keep].sort()).toEqual(['inflight', 'queued', 'reservation1', 'session1']);
    expect(opts.minAgeMs).toBe(LOST_ROW_MIN_AGE_MS);
    finishClose();
    await inflight;
  });

  it('LS22 k: the held ids are read right before the sweep, after the retries: a listen admitted during a slow retry is kept', async () => {
    let held = new Set(['session1']);
    let finishRetry: () => void = () => {};
    const s = store();
    s.close
      .mockRejectedValueOnce(new Error('down'))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = () => resolve({}); }));
    const keeper = new ListenRowKeeper(s, 'me');
    await keeper.close('queued', REVOKED).catch(() => {});
    const upkeep = keeper.maintain(() => held);
    // The retry is slow (past the age floor, on a struggling database); a listen is admitted meanwhile.
    held = new Set(['session1', 'admitted-during-retry']);
    finishRetry();
    await upkeep;
    expect([...s.closeOrphans.mock.calls[0]![1].keep].sort()).toEqual(['admitted-during-retry', 'session1']);
  });

  it('markLive stamps the row; a stamp that fails is logged, never thrown', async () => {
    const s = store();
    const keeper = new ListenRowKeeper(s, 'me');
    await keeper.markLive('l1');
    expect(s.markLive).toHaveBeenCalledWith('l1');
    s.markLive.mockRejectedValueOnce(new Error('down'));
    await expect(keeper.markLive('l2')).resolves.toBeUndefined();
  });

  it('answers what it swept; a sweep that fails is logged, never thrown', async () => {
    const s = store({ closeOrphans: async () => [{ id: 'lost1' }, { id: 'lost2' }] });
    expect(await new ListenRowKeeper(s, 'me').maintain(() => new Set())).toEqual({ retried: 0, swept: 2, reaped: 0 });
    const failing = store({ closeOrphans: async () => { throw new Error('down'); } });
    await expect(new ListenRowKeeper(failing, 'me').maintain(() => new Set())).resolves.toEqual({ retried: 0, swept: 0, reaped: 0 });
  });

  it('counts server_restarted only for the swept rows that went live (a row refused at its upgrade carried no audio)', async () => {
    metrics.ended.mockClear();
    const s = store({
      closeOrphans: async () => [{ id: 'live', live_at: new Date() }, { id: 'refused', live_at: null }],
      closeOrphansExcept: async () => [{ id: 'dead-live', live_at: '2026-11-16T10:00:00Z' }, { id: 'dead-refused', live_at: null }],
    });
    const keeper = new ListenRowKeeper(s, 'me');
    expect(await keeper.closeDeadProcesses()).toBe(2);
    expect(await keeper.maintain(() => new Set())).toMatchObject({ swept: 2 });
    expect(metrics.ended).toHaveBeenCalledTimes(2);
    expect(metrics.ended).toHaveBeenCalledWith('server_restarted');
  });

  it('LS22 r: the dead processes\' close is this process and the live others; one that fails is retried by the next upkeep, the live processes read afresh', async () => {
    let live = ['worker-a', 'worker-b'];
    const s = store();
    s.closeOrphansExcept.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce([{ id: 'orphan', live_at: new Date() }]);
    const keeper = new ListenRowKeeper(s, 'primary', () => live);
    // The reap of a dead worker (or the boot sweep) fails with the event that killed it.
    expect(await keeper.closeDeadProcesses()).toBeNull();
    expect(s.closeOrphansExcept).toHaveBeenLastCalledWith(['primary', 'worker-a', 'worker-b']);
    expect(keeper.deadSweepWaiting).toBe(true);
    // A worker re-forked under a new incarnation by the next tick: its rows are kept.
    live = ['worker-a', 'worker-b2'];
    expect(await keeper.maintain(() => new Set())).toMatchObject({ reaped: 1 });
    expect(s.closeOrphansExcept).toHaveBeenLastCalledWith(['primary', 'worker-a', 'worker-b2']);
    expect(keeper.deadSweepWaiting).toBe(false);
    // Done: the next upkeep does not run it again.
    await keeper.maintain(() => new Set());
    expect(s.closeOrphansExcept).toHaveBeenCalledTimes(2);
  });

  it('at most MAX_QUEUED_CLOSES wait; past that the oldest is let go to the sweep', async () => {
    const s = store();
    s.close.mockRejectedValue(new Error('down'));
    const keeper = new ListenRowKeeper(s, 'me');
    for (let i = 0; i <= MAX_QUEUED_CLOSES; i++) await keeper.close(`l${i}`, REVOKED).catch(() => {});
    expect(keeper.queued).toBe(MAX_QUEUED_CLOSES);
    s.close.mockClear();
    s.close.mockResolvedValue({});
    await keeper.maintain(() => new Set());
    expect(s.close).toHaveBeenCalledTimes(MAX_QUEUED_CLOSES);
    expect(s.close).not.toHaveBeenCalledWith('l0', REVOKED);
    expect(s.close).toHaveBeenCalledWith(`l${MAX_QUEUED_CLOSES}`, REVOKED);
  });
});
