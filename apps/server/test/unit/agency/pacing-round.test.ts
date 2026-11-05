import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PACING_SHARE_WAIT_MS,
  PacingRound,
  ShareRotation,
  splitHeadroom,
  type ShareClaim,
  type ShareGrant,
} from '../../../src/agency/pacing/round.js';

// ---------------------------------------------------------------------------
// The pacing round as the arbiter of an account's headroom between its running
// campaigns (decisions MC1, MC2): the pure split (`splitHeadroom`) and the barrier
// (`join` / `submit` / `withdraw`, the split's open and close, the wait for a slow participant, the late
// report). The engine's use of it is in `pacing-skip.test.ts`.
// ---------------------------------------------------------------------------

/** A scheduler the test fires by hand. */
function manualTimers() {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
    fire(): void {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
    get armed(): number {
      return timers.filter((t) => !t.cancelled).length;
    },
  };
}

/** A promise's value once the microtask queue has drained, or `undefined` while it is still pending. */
function watch<T>(p: Promise<T>): { readonly value: T | undefined } {
  const box: { value: T | undefined } = { value: undefined };
  void p.then((v) => { box.value = v; });
  return box;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

/** A small deterministic PRNG for the property cases. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (lo: number, hi: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return lo + (s % (hi - lo + 1));
  };
}

// ─── The split ─────────────────────────────────────────────────────────────

describe('splitHeadroom (MC1)', () => {
  it('with one claim it is exactly MAX(0, MIN(headroom, demand))', () => {
    for (const [h, d] of [[5, 2], [0, 3], [-2, 3], [2, 9], [0, 0], [7, 7]] as const) {
      expect(splitHeadroom(h, [{ id: 'a', demand: d, ownLive: 4 }]).get('a')).toBe(Math.max(0, Math.min(h, d)));
    }
  });

  it('equal campaigns split evenly, and the odd slot follows the rotation', () => {
    const claims: ShareClaim[] = [{ id: 'b', demand: 10, ownLive: 0 }, { id: 'a', demand: 10, ownLive: 0 }];
    expect(Object.fromEntries(splitHeadroom(6, claims, 0))).toEqual({ a: 3, b: 3 });
    // Sorted by id, so the order the claims arrive in does not matter.
    expect(Object.fromEntries(splitHeadroom(5, claims, 0))).toEqual({ a: 3, b: 2 });
    expect(Object.fromEntries(splitHeadroom(5, [...claims].reverse(), 0))).toEqual({ a: 3, b: 2 });
    expect(Object.fromEntries(splitHeadroom(5, claims, 1))).toEqual({ a: 2, b: 3 });
    expect(Object.fromEntries(splitHeadroom(5, claims, 2))).toEqual({ a: 3, b: 2 });
  });

  it('gives each slot to the campaign with the fewest live calls', () => {
    // b is idle and a has 4 calls up: b is brought level before a gets anything.
    const claims: ShareClaim[] = [{ id: 'a', demand: 10, ownLive: 4 }, { id: 'b', demand: 10, ownLive: 0 }];
    expect(Object.fromEntries(splitHeadroom(3, claims))).toEqual({ a: 0, b: 3 });
    expect(Object.fromEntries(splitHeadroom(4, claims))).toEqual({ a: 0, b: 4 });
    // Level at 4 each: then they alternate (a first, by rotation 0).
    expect(Object.fromEntries(splitHeadroom(6, claims))).toEqual({ a: 1, b: 5 });
  });

  it('a campaign above its share keeps its calls and gets nothing new until the other catches up', () => {
    const claims: ShareClaim[] = [{ id: 'a', demand: 5, ownLive: 8 }, { id: 'b', demand: 5, ownLive: 2 }];
    expect(Object.fromEntries(splitHeadroom(2, claims))).toEqual({ a: 0, b: 2 });
  });

  it('capacity one campaign cannot use flows to the other in the same split', () => {
    const claims: ShareClaim[] = [{ id: 'a', demand: 1, ownLive: 0 }, { id: 'b', demand: 10, ownLive: 0 }];
    expect(Object.fromEntries(splitHeadroom(6, claims))).toEqual({ a: 1, b: 5 });
    // Nobody can use it: the rest stays unused rather than over-granted.
    expect(Object.fromEntries(splitHeadroom(6, [{ id: 'a', demand: 1, ownLive: 0 }, { id: 'b', demand: 0, ownLive: 0 }])))
      .toEqual({ a: 1, b: 0 });
  });

  it('returns an entry per claim, and nothing for no claims', () => {
    expect(splitHeadroom(5, []).size).toBe(0);
    expect(Object.fromEntries(splitHeadroom(0, [{ id: 'a', demand: 3, ownLive: 0 }, { id: 'b', demand: 3, ownLive: 0 }])))
      .toEqual({ a: 0, b: 0 });
  });

  it('never grants more than the headroom or a demand, uses all it can, and is max-min fair (property)', () => {
    const r = rng(20261105);
    for (let run = 0; run < 2_000; run++) {
      const n = r(1, 5);
      const claims: ShareClaim[] = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, demand: r(0, 12), ownLive: r(0, 10) }));
      const headroom = r(-3, 30);
      const grants = splitHeadroom(headroom, claims, r(0, 7));
      const sumDemand = claims.reduce((a, c) => a + c.demand, 0);
      expect(total(grants)).toBe(Math.max(0, Math.min(headroom, sumDemand)));
      for (const c of claims) {
        const g = grants.get(c.id)!;
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(c.demand);
        // Fairness: one that got a slot was, before it, at or under every claim still wanting one.
        if (g === 0) continue;
        for (const o of claims) {
          const go = grants.get(o.id)!;
          if (o === c || go >= o.demand) continue;
          expect(c.ownLive + g - 1).toBeLessThanOrEqual(o.ownLive + go);
        }
      }
    }
  });
});

describe('ShareRotation', () => {
  it('advances per account, and forgets an account', () => {
    const r = new ShareRotation();
    expect([r.take('x'), r.take('x'), r.take('y'), r.take('x')]).toEqual([0, 1, 0, 2]);
    expect(r.size).toBe(2);
    r.forget('x');
    expect(r.take('x')).toBe(0);
  });
});

// ─── The barrier ───────────────────────────────────────────────────────────

describe('PacingRound: the account barrier (MC2)', () => {
  const report = (demand: number, ownLive: number | null = 0, limit = 10, live = 5) => ({ demand, ownLive, limit, live });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a lone participant is granted at once, by the per-tick law, with no timer', async () => {
    for (const [limit, live, idle] of [[5, 0, 2], [5, 5, 3], [5, 7, 3], [2, 0, 9], [0, 0, 1]] as const) {
      const t = manualTimers();
      const round = new PacingRound(false, { schedule: t.schedule });
      round.join('t:a', 'c1');
      expect(round.contended('t:a')).toBe(false);
      const g = watch(round.submit('t:a', 'c1', { demand: idle, ownLive: null, limit, live }));
      await drain();
      expect(g.value).toEqual({ grant: Math.max(0, Math.min(limit - live, idle)), closed: false });
      expect(t.timers).toHaveLength(0);
    }
  });

  it('a forced round (no join) is its account\'s only participant', async () => {
    const round = new PacingRound(true);
    expect(round.contended('t:a')).toBe(false);
    expect(await round.submit('t:a', 'c1', report(3))).toEqual({ grant: 3, closed: false });
  });

  it('waits for every participant, then splits the headroom between them', async () => {
    const t = manualTimers();
    const round = new PacingRound(false, { schedule: t.schedule });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    expect(round.contended('t:a')).toBe(true);
    expect(round.isOpen('t:a')).toBe(true);
    const a = watch(round.submit('t:a', 'c1', report(4)));
    await drain();
    expect(a.value).toBeUndefined();
    expect(t.armed).toBe(1);
    const b = watch(round.submit('t:a', 'c2', report(4)));
    await drain();
    // 5 slots, equal campaigns: 3 + 2, never 4 + 4.
    expect([a.value!.grant, b.value!.grant].sort()).toEqual([2, 3]);
    expect(t.armed).toBe(0); // the wait was cancelled
  });

  it('idle capacity flows: a participant that withdraws leaves the whole headroom to the other', async () => {
    const round = new PacingRound(false, { schedule: manualTimers().schedule });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    const a = watch(round.submit('t:a', 'c1', report(9)));
    await drain();
    expect(a.value).toBeUndefined();
    round.withdraw('c2'); // its tick returned early (no agents, an error, a revoked lead)
    await drain();
    expect(a.value).toEqual({ grant: 5, closed: false });
    expect(round.contended('t:a')).toBe(false);
  });

  it('withdraw is a no-op after a report, and for a campaign that never joined', async () => {
    const round = new PacingRound(false, { schedule: manualTimers().schedule });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    const a = watch(round.submit('t:a', 'c1', report(2)));
    round.withdraw('c1');
    round.withdraw('nobody');
    await drain();
    expect(a.value).toBeUndefined(); // still waiting for c2
    const b = watch(round.submit('t:a', 'c2', report(2)));
    await drain();
    expect([a.value!.grant, b.value!.grant]).toEqual([2, 2]);
  });

  it('every participant withdrawing resolves nothing, arms nothing, and closes the split', () => {
    const t = manualTimers();
    const round = new PacingRound(false, { schedule: t.schedule });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    expect(round.isOpen('t:a')).toBe(true);
    round.withdraw('c1');
    expect(round.isOpen('t:a')).toBe(true); // c2 still pending
    round.withdraw('c2');
    expect(t.timers).toHaveLength(0);
    expect(round.contended('t:a')).toBe(false);
    expect(round.isOpen('t:a')).toBe(false);
  });

  it('when the wait runs out the reporters are split, but the split stays open for the one still pending', async () => {
    const t = manualTimers();
    const round = new PacingRound(false, { schedule: t.schedule, shareWaitMs: 1_234 });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    const a = watch(round.submit('t:a', 'c1', report(3)));
    await drain();
    expect(t.timers[0]!.ms).toBe(1_234);
    t.fire();
    await drain();
    expect(a.value).toEqual({ grant: 3, closed: false });
    expect(round.isOpen('t:a')).toBe(true); // c2 has neither reported nor withdrawn
    // Late while open: MIN(demand, leftover) = MIN(4, 5 − 3). Its report closes the split.
    expect(await round.submit('t:a', 'c2', report(4))).toEqual({ grant: 2, closed: false });
    expect(round.isOpen('t:a')).toBe(false);
    // Withdrawing after the report is harmless.
    round.withdraw('c2');
  });

  it('late reports while open share the leftover first come first served, never past the headroom; after the close, 0', async () => {
    const t = manualTimers();
    const round = new PacingRound(false, { schedule: t.schedule });
    for (const c of ['c1', 'c2', 'c3']) round.join('t:a', c);
    const a = watch(round.submit('t:a', 'c1', report(1)));
    t.fire();
    await drain();
    expect(a.value!.grant).toBe(1); // 4 left
    // Not by fewest live calls: the first late report takes what it asks for.
    const b = await round.submit('t:a', 'c2', report(3, 9));
    expect(round.isOpen('t:a')).toBe(true); // c3 still pending
    const c = await round.submit('t:a', 'c3', report(3, 0));
    expect([b.grant, c.grant]).toEqual([3, 1]);
    expect(a.value!.grant + b.grant + c.grant).toBe(5);
    expect(round.isOpen('t:a')).toBe(false);
    // A report into the closed split (a forced tick joining at its report): 0, `closed`.
    expect(await round.submit('t:a', 'c4', report(3))).toEqual({ grant: 0, closed: true });
  });

  it('the last pending member withdrawing after the wait split closes it', async () => {
    const t = manualTimers();
    const round = new PacingRound(false, { schedule: t.schedule });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    void round.submit('t:a', 'c1', report(1));
    t.fire();
    expect(round.isOpen('t:a')).toBe(true);
    round.withdraw('c2');
    expect(round.isOpen('t:a')).toBe(false);
  });

  it('opens a split at the first join and closes it once, when it settles', async () => {
    const round = new PacingRound(false, { schedule: manualTimers().schedule });
    expect(round.isOpen('t:a')).toBe(false);
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    round.join('t:b', 'c3');
    expect([round.isOpen('t:a'), round.isOpen('t:b')]).toEqual([true, true]);
    const a = watch(round.submit('t:a', 'c1', report(2)));
    const b = watch(round.submit('t:a', 'c2', report(2)));
    await drain();
    expect([round.isOpen('t:a'), round.isOpen('t:b')]).toEqual([false, true]);
    expect([a.value!.grant, b.value!.grant]).toEqual([2, 2]);
    round.withdraw('c2'); // after its report: nothing
    round.close('t:a'); // already closed: nothing
    expect([round.isOpen('t:a'), round.isOpen('t:b')]).toEqual([false, true]);
    // A lone report opens and closes at once: a later report finds it closed.
    expect(round.isOpen('t:c')).toBe(false);
    await round.submit('t:c', 'c4', report(1));
    expect(round.isOpen('t:c')).toBe(false);
    expect(await round.submit('t:c', 'c5', report(1))).toEqual({ grant: 0, closed: true });
  });

  it('close() closes an open split now: who reported is split, who has not reported gets 0', async () => {
    const t = manualTimers();
    const round = new PacingRound(false, { schedule: t.schedule });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    round.close('t:a'); // nobody reported (the engine's deadline): closes with no grant
    expect(round.isOpen('t:a')).toBe(false);
    expect(await round.submit('t:a', 'c1', report(2))).toEqual({ grant: 0, closed: true });

    // Before the wait ran out: the reporters are split, and the rest are closed out.
    const r2 = new PacingRound(false, { schedule: manualTimers().schedule });
    r2.join('t:a', 'c1');
    r2.join('t:a', 'c2');
    const a = watch(r2.submit('t:a', 'c1', report(2)));
    r2.close('t:a');
    await drain();
    expect(a.value).toEqual({ grant: 2, closed: false });
    expect(await r2.submit('t:a', 'c2', report(2))).toEqual({ grant: 0, closed: true });

    // After the wait split, while open: the leftover is no longer on offer.
    const t3 = manualTimers();
    const r3 = new PacingRound(false, { schedule: t3.schedule });
    r3.join('t:a', 'c1');
    r3.join('t:a', 'c2');
    void r3.submit('t:a', 'c1', report(2));
    t3.fire();
    expect(r3.isOpen('t:a')).toBe(true);
    r3.close('t:a');
    expect(r3.isOpen('t:a')).toBe(false);
    expect(await r3.submit('t:a', 'c2', report(2))).toEqual({ grant: 0, closed: true });
  });

  it('a participant joined as not contending is waited for, but does not make the account contended', async () => {
    const round = new PacingRound(false, { schedule: manualTimers().schedule });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2', { contends: false });
    expect(round.contended('t:a')).toBe(false);
    expect(round.isOpen('t:a')).toBe(true);
    const a = watch(round.submit('t:a', 'c1', report(9)));
    await drain();
    expect(a.value).toBeUndefined(); // waits for c2's report or withdrawal
    round.withdraw('c2');
    await drain();
    expect(a.value).toEqual({ grant: 5, closed: false });
  });

  it('a not-contending participant that reports after all is split with the others', async () => {
    const round = new PacingRound(false, { schedule: manualTimers().schedule });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2', { contends: false });
    const b = watch(round.submit('t:a', 'c2', report(9)));
    expect(round.contended('t:a')).toBe(true); // it reported a demand
    const a = watch(round.submit('t:a', 'c1', report(9)));
    await drain();
    expect([a.value!.grant, b.value!.grant].sort()).toEqual([2, 3]);
  });

  it('never grants an account more than its headroom, whatever the order of reports and withdrawals (property)', async () => {
    const r = rng(7);
    for (let run = 0; run < 300; run++) {
      const t = manualTimers();
      const round = new PacingRound(false, { schedule: t.schedule });
      const n = r(1, 4);
      const ids = Array.from({ length: n }, (_, i) => `c${i}`);
      for (const id of ids) round.join('t:a', id);
      const limit = r(0, 12);
      const live = r(0, 12);
      const grants: Array<Promise<ShareGrant>> = [];
      for (const id of ids) {
        const action = r(0, 3);
        if (action === 0) round.withdraw(id);
        else if (action === 1 && run % 2 === 0) t.fire();
        else grants.push(round.submit('t:a', id, { demand: r(0, 8), ownLive: r(0, 5), limit, live }));
      }
      t.fire();
      const got = await Promise.all(grants);
      expect(got.reduce((a, g) => a + g.grant, 0)).toBeLessThanOrEqual(Math.max(0, limit - live));
    }
  });

  it('the wait is armed by the account\'s FIRST report, not by the joins', async () => {
    const t = manualTimers();
    const round = new PacingRound(false, { schedule: t.schedule, shareWaitMs: 500 });
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    round.join('t:a', 'c3');
    expect(t.timers).toHaveLength(0);
    void round.submit('t:a', 'c1', report(1));
    expect(t.timers.map((x) => x.ms)).toEqual([500]);
    void round.submit('t:a', 'c2', report(1));
    expect(t.timers).toHaveLength(1); // a second report does not re-arm it
  });

  // A campaign that never joined: a forced tick (its own round), the only one that reaches
  // `submit` without the engine having joined it first.
  describe('a campaign that never joined, reporting', () => {
    it('alone on its account: the per-tick law at once, not late, no timer', async () => {
      const t = manualTimers();
      const round = new PacingRound(false, { schedule: t.schedule });
      expect(round.contended('t:a')).toBe(false);
      expect(await round.submit('t:a', 'c9', report(3))).toEqual({ grant: 3, closed: false });
      expect(t.timers).toHaveLength(0);
    });

    it('while the account\'s split is open: it is split with the others', async () => {
      const round = new PacingRound(false, { schedule: manualTimers().schedule });
      round.join('t:a', 'c1');
      round.join('t:a', 'c2');
      const a = watch(round.submit('t:a', 'c1', report(9)));
      const c = watch(round.submit('t:a', 'c9', report(9))); // joins at its report
      await drain();
      expect(a.value).toBeUndefined(); // c2 has neither reported nor withdrawn
      expect(c.value).toBeUndefined(); // in the split, not served from a leftover
      const b = watch(round.submit('t:a', 'c2', report(9)));
      await drain();
      expect([a.value!.grant, b.value!.grant, c.value!.grant].sort()).toEqual([1, 2, 2]);
    });

    it('after the split closed: 0, `closed`', async () => {
      const round = new PacingRound(false, { schedule: manualTimers().schedule });
      round.join('t:a', 'c1');
      expect((await round.submit('t:a', 'c1', report(2))).grant).toBe(2); // lone: split and closed at once, 3 unused
      expect(await round.submit('t:a', 'c8', report(2, 9))).toEqual({ grant: 0, closed: true });
    });
  });

  it('accounts are split independently', async () => {
    const round = new PacingRound(false, { schedule: manualTimers().schedule });
    round.join('t:a', 'c1');
    round.join('t:b', 'c2');
    expect(round.contended('t:a')).toBe(false);
    expect((await round.submit('t:a', 'c1', report(9))).grant).toBe(5);
    expect((await round.submit('t:b', 'c2', report(9))).grant).toBe(5);
  });

  it('ties take turns across rounds through the engine\'s rotation', async () => {
    const rotation = new ShareRotation();
    const winners: string[] = [];
    for (let i = 0; i < 4; i++) {
      const round = new PacingRound(false, { rotation, schedule: manualTimers().schedule });
      round.join('t:a', 'c1');
      round.join('t:a', 'c2');
      const [a, b] = await Promise.all([
        round.submit('t:a', 'c1', { demand: 3, ownLive: 2, limit: 3, live: 2 }),
        round.submit('t:a', 'c2', { demand: 3, ownLive: 2, limit: 3, live: 2 }),
      ]);
      winners.push(a.grant === 1 ? 'c1' : b.grant === 1 ? 'c2' : 'none');
    }
    expect(winners).toEqual(['c1', 'c2', 'c1', 'c2']);
  });

  it('two campaigns of one account share one live-call read and one limit read', async () => {
    const round = new PacingRound(false);
    const load = vi.fn().mockResolvedValue(3);
    const [a, b] = await Promise.all([round.liveCalls('t:a', load), round.liveCalls('t:a', load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect([a, b]).toEqual([3, 3]);
    const limit = vi.fn().mockResolvedValue(10);
    await Promise.all([round.limit('t:a', limit), round.limit('t:a', limit)]);
    expect(limit).toHaveBeenCalledTimes(1);
    // Another account reads its own.
    await round.liveCalls('t:b', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('memoises the per-campaign live read per account', async () => {
    const round = new PacingRound(false);
    const load = vi.fn().mockResolvedValue(new Map([['c1', 2]]));
    const [x, y] = await Promise.all([round.liveByCampaign('t:a', load), round.liveByCampaign('t:a', load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(x).toBe(y);
    await round.liveByCampaign('t:b', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('by default waits PACING_SHARE_WAIT_MS on the timers (fake timers drive it)', async () => {
    vi.useFakeTimers();
    const round = new PacingRound(false);
    round.join('t:a', 'c1');
    round.join('t:a', 'c2');
    const a = watch(round.submit('t:a', 'c1', report(2)));
    await vi.advanceTimersByTimeAsync(PACING_SHARE_WAIT_MS - 1);
    await drain();
    expect(a.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect(a.value).toEqual({ grant: 2, closed: false });
    expect(PACING_SHARE_WAIT_MS).toBe(1_000);
  });

  it('the default wait never keeps the process alive (the timer is unref\'d)', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => ({ unref })) as never);
    try {
      const round = new PacingRound(false);
      round.join('t:a', 'c1');
      round.join('t:a', 'c2');
      void round.submit('t:a', 'c1', report(2));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
