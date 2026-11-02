/**
 * RecordingByteBudget: the analysis worker's bound on recording bytes held in memory.
 * Pins: the total is never exceeded, waiters are served first in first out, a growing
 * lease holds nothing while it waits (so two growers cannot deadlock), a lease released
 * while it waits hands its grant straight back, and one reservation is clamped to the total.
 */
import { describe, it, expect, vi } from 'vitest';
import { RecordingByteBudget, UNBUDGETED_LEASE } from '../../../src/core/recording-byte-budget.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RecordingByteBudget', () => {
  it('grants while there is room and refuses tryAcquire past the total', () => {
    const b = new RecordingByteBudget(100);
    const a = b.tryAcquire(60)!;
    expect(a.bytes).toBe(60);
    expect(b.tryAcquire(50)).toBeNull();
    expect(b.tryAcquire(40)!.bytes).toBe(40);
    expect(b.reservedBytes).toBe(100);
  });

  it('a waiter is granted when bytes come back, in FIFO order, and tryAcquire does not jump the line', async () => {
    const onWait = vi.fn();
    const b = new RecordingByteBudget(100, { onWait });
    const a = b.tryAcquire(100)!;
    const order: string[] = [];
    const big = b.acquire(80).then((l) => { order.push('big'); return l; });
    const small = b.acquire(10).then((l) => { order.push('small'); return l; });
    expect(onWait).toHaveBeenCalledTimes(2);
    expect(b.tryAcquire(5)).toBeNull(); // someone is waiting

    a.shrinkTo(20); // 80 free: the head of the line (80) fits
    await tick();
    expect(order).toEqual(['big']);
    expect(b.reservedBytes).toBe(100);

    a.release();
    await tick();
    expect(order).toEqual(['big', 'small']);
    expect(b.reservedBytes).toBe(90);
    (await big).release();
    (await small).release();
    expect(b.reservedBytes).toBe(0);
  });

  it('growing releases what the lease holds first, so two growing leases cannot deadlock', async () => {
    const b = new RecordingByteBudget(100);
    const x = b.tryAcquire(50)!;
    const y = b.tryAcquire(50)!;
    x.shrinkTo(10);
    y.shrinkTo(10);
    // Each wants 100. Holding 10 while waiting for 90 more, both would wait forever.
    const gx = x.growTo(100);
    const gy = y.growTo(100);
    await gx;
    expect(x.bytes).toBe(100);
    x.release();
    await gy;
    expect(y.bytes).toBe(100);
    expect(b.reservedBytes).toBe(100);
  });

  it('a lease released while it waits hands the grant straight back', async () => {
    const b = new RecordingByteBudget(100);
    const a = b.tryAcquire(100)!;
    const waiting = b.tryAcquire(0)!;
    const grown = waiting.growTo(50);
    waiting.release();
    a.release();
    await grown;
    expect(waiting.bytes).toBe(0);
    expect(b.reservedBytes).toBe(0);
  });

  it('clamps a reservation to the total and never shrinks a lease upward', () => {
    const onReservedChange = vi.fn();
    const b = new RecordingByteBudget(100, { onReservedChange });
    const a = b.tryAcquire(1000)!;
    expect(a.bytes).toBe(100);
    a.shrinkTo(500);
    expect(a.bytes).toBe(100);
    a.shrinkTo(30);
    a.release();
    a.release(); // idempotent
    expect(b.reservedBytes).toBe(0);
    expect(onReservedChange.mock.calls.map((c) => c[0])).toEqual([100, 30, 0]);
  });

  it('refuses a non-positive total; the unbudgeted lease is a no-op', async () => {
    expect(() => new RecordingByteBudget(0)).toThrow(RangeError);
    UNBUDGETED_LEASE.shrinkTo(1);
    await UNBUDGETED_LEASE.growTo(1e12);
    UNBUDGETED_LEASE.release();
    expect(UNBUDGETED_LEASE.bytes).toBe(0);
  });
});
