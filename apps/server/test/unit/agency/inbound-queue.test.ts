import { describe, expect, it, vi } from 'vitest';
import { InboundQueue, type InboundQueueEntry, type InboundQueueTimers } from '../../../src/agency/inbound/inbound-queue.js';

/**
 * The inbound queue (docs/inbound.md §2 step 3, §5.1): FIFO per route, a requeued caller back at
 * the head, `max_waiting`, the maximum wait and the sticky wait, and what `inbound_waiting` says.
 */

/** Timers on a hand-driven clock. */
function clock() {
  let now = 1_000_000;
  const due: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const timers: InboundQueueTimers = {
    set(fn, ms) {
      const t = { at: now + ms, fn, id: ++seq };
      due.push(t);
      return t.id;
    },
    clear(handle) {
      const i = due.findIndex((t) => t.id === handle);
      if (i >= 0) due.splice(i, 1);
    },
  };
  return {
    timers,
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const t of [...due].sort((a, b) => a.at - b.at)) {
        if (t.at <= now && due.includes(t)) {
          due.splice(due.indexOf(t), 1);
          t.fn();
        }
      }
    },
    pending: () => due.length,
  };
}

function entry(id: string, at: number, over: Partial<InboundQueueEntry> = {}): InboundQueueEntry {
  return {
    callId: id, tenantId: 't', accountId: 'a', routeAccountId: 'a', routeId: 'r1', poolCampaignIds: [],
    stickyMode: 'loose', stickyUserId: null, stickyWaitMs: 30_000, queuedAt: at, maxWaitAt: at + 120_000, ...over,
  };
}

describe('InboundQueue', () => {
  it('serves FIFO by first queueing, a requeued caller back at the head (the latest requeue first)', () => {
    const c = clock();
    const q = new InboundQueue({ now: c.now, timers: c.timers });
    q.admit(entry('a', c.now()), 10);
    q.admit(entry('b', c.now() + 1), 10);
    q.admit(entry('c', c.now() + 2), 10);
    expect(q.waiting().map((e) => e.callId)).toEqual(['a', 'b', 'c']);
    q.markOffered('c', 's1');
    q.markOffered('b', 's2');
    expect(q.waiting().map((e) => e.callId)).toEqual(['a']);
    expect(q.waitingOnRoute('r1')).toBe(1);
    expect(q.requeueHead('c')).toBe(true);
    expect(q.requeueHead('b')).toBe(true);
    expect(q.waiting().map((e) => e.callId)).toEqual(['b', 'c', 'a']);
    expect(q.offeredTo('b')).toBeNull();
    expect(q.requeueHead('nobody')).toBe(false);
  });

  it('max_waiting: the caller over it is admitted over_cap (an agent free now still takes them); offered callers do not count', () => {
    const c = clock();
    const q = new InboundQueue({ now: c.now, timers: c.timers });
    expect(q.admit(entry('a', c.now()), 2)).toBe('queued');
    expect(q.admit(entry('b', c.now()), 2)).toBe('queued');
    expect(q.admit(entry('c', c.now()), 2)).toBe('over_cap');
    expect(q.admit(entry('x', c.now(), { routeId: 'r2' }), 2)).toBe('queued'); // per route
    q.remove('c');
    q.markOffered('a', 's1');
    expect(q.admit(entry('d', c.now()), 2)).toBe('queued');
    expect(q.admit(entry('d', c.now()), 2)).toBe('queued'); // already here: unchanged
    expect(q.admit(entry('e', c.now()), 0)).toBe('over_cap'); // max_waiting 0: no queue
  });

  it('the maximum wait fires once per entry, from queued_at; the entry stays and reads lapsed', () => {
    const c = clock();
    const onMaxWait = vi.fn();
    const q = new InboundQueue({ now: c.now, timers: c.timers, onMaxWait });
    q.admit(entry('a', c.now(), { maxWaitAt: c.now() + 120_000 }), 10);
    c.advance(119_999);
    expect(onMaxWait).not.toHaveBeenCalled();
    expect(q.maxWaitLapsed('a')).toBe(false);
    c.advance(1);
    expect(onMaxWait).toHaveBeenCalledWith('a');
    expect(q.maxWaitLapsed('a')).toBe(true);
    // A requeue keeps the first queueing: nothing re-armed.
    q.markOffered('a', 's');
    q.requeueHead('a');
    c.advance(200_000);
    expect(onMaxWait).toHaveBeenCalledTimes(1);
  });

  it('the sticky wait fires for a loose caller with a sticky agent only; remove clears every timer', () => {
    const c = clock();
    const onStickyLapse = vi.fn();
    const q = new InboundQueue({ now: c.now, timers: c.timers, onStickyLapse });
    q.admit(entry('loose', c.now(), { stickyUserId: 'u1' }), 10);
    q.admit(entry('strict', c.now(), { stickyUserId: 'u1', stickyMode: 'strict' }), 10);
    q.admit(entry('none', c.now()), 10);
    q.admit(entry('gone', c.now(), { stickyUserId: 'u1' }), 10);
    q.remove('gone');
    c.advance(30_000);
    expect(onStickyLapse.mock.calls).toEqual([['loose']]);
    q.clear();
    expect(c.pending()).toBe(0);
    expect(q.size()).toBe(0);
  });

  it('waitingSummary: n waiting, their sticky agents, the union of the pools (null when any is the whole account)', () => {
    const c = clock();
    const q = new InboundQueue({ now: c.now, timers: c.timers });
    expect(q.waitingSummary('t:a')).toEqual({ n: 0, stickyUserIds: [], poolCampaignIds: [] });
    q.admit(entry('a', c.now(), { stickyUserId: 'u1', poolCampaignIds: ['p1'] }), 10);
    q.admit(entry('b', c.now(), { stickyUserId: 'u2', stickyMode: 'off', poolCampaignIds: ['p2'] }), 10);
    q.admit(entry('c', c.now(), { accountId: 'other', routeAccountId: 'other' }), 10);
    expect(q.waitingSummary('t:a')).toEqual({ n: 2, stickyUserIds: ['u1'], poolCampaignIds: ['p1', 'p2'] });
    q.admit(entry('d', c.now()), 10);
    expect(q.waitingSummary('t:a').poolCampaignIds).toBeNull();
    q.remove('d');
    // A caller matched into another account than the route's: the route's pool does not bound it.
    q.admit(entry('e', c.now(), { routeAccountId: 'route-acct', poolCampaignIds: ['p9'] }), 10);
    expect(q.waitingSummary('t:a').poolCampaignIds).toBeNull();
    q.markOffered('a', 's');
    expect(q.waitingSummary('t:a').n).toBe(2);
  });

  it('snapshot per route: waiting, on offer, the longest wait in whole seconds', () => {
    const c = clock();
    const q = new InboundQueue({ now: c.now, timers: c.timers });
    q.admit(entry('a', c.now()), 10);
    q.admit(entry('b', c.now() + 5_000), 10);
    q.admit(entry('c', c.now(), { routeId: 'r2' }), 10);
    q.markOffered('c', 's');
    c.advance(12_500);
    expect(q.snapshot().sort((x, y) => x.routeId.localeCompare(y.routeId))).toEqual([
      { routeId: 'r1', tenantId: 't', accountId: 'a', waiting: 2, offered: 0, longestWaitSeconds: 12 },
      { routeId: 'r2', tenantId: 't', accountId: 'a', waiting: 0, offered: 1, longestWaitSeconds: 0 },
    ]);
    expect(q.accounts()).toEqual(['t:a']);
  });
});
