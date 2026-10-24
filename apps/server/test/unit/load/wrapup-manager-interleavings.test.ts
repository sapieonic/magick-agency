import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── WRAP-UP UNDER EVERY INTERLEAVING A FLOOR CAN PRODUCE ───────────────────
 *
 * `WrapupManager` returns an agent to the pool from four directions — its own
 * timer, a disposition (`noteDisposition`), a supervisor (`force`), and the
 * caller dropping it (`cancel`, or a second `enter` for the session) — and
 * `enter` itself awaits three writes before it arms the timer and announces the
 * wrap-up. `wrapup-manager.test.ts` pins each path and each named race one at a
 * time. This suite is model-based: a seeded scheduler drives many agents'
 * wrap-ups through random interleavings of all of them — holding each awaited
 * write open and releasing them in random order, firing the timers by advancing
 * fake time in random steps — and checks three properties after every step or at
 * quiescence:
 *
 *  P1 conservation: every wrap-up that `enter` opened is closed exactly once —
 *     by `onReturn`, by the caller's `cancel`, or by a replacing `enter`. Two
 *     closes is two releases of one agent (the second can land on an agent the
 *     tick has since reserved); none is an agent stranded out of the pool.
 *  P2 no early auto-return: an `auto_return` only ever ends the wrap-up it
 *     belongs to, at or after that wrap-up's own deadline.
 *  P3 no stale announcement: a `wrapup` / `agent_state: wrapup` frame is only
 *     ever sent for a wrap-up that is live in the manager at that instant. The
 *     console's disposition pad unlocks on that frame, so one sent after the
 *     agent has been returned shows them a wrap-up they are not in.
 *
 * Fake timers drive the clock, so the schedule is a pure function of the seed.
 */

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/**
 * Every awaited write `enter` makes is parked here until the scheduler releases
 * it — that is what lets a disposition, a force or a second `enter` land in the
 * middle of an `enter`. The wrap-up END record (`persistEnd`) is fire-and-forget
 * in the manager, so it resolves at once.
 */
const { parked, repos } = vi.hoisted(() => {
  const parked: Array<() => void> = [];
  const park = <T>(value: T): Promise<T> => new Promise<T>((resolve) => { parked.push(() => resolve(value)); });
  const state = { dispositionOnRow: new Set<string>() };
  return {
    parked,
    repos: {
      state,
      attempt: {
        setState: vi.fn((id: string, _s: string, patch: Record<string, unknown>) => {
          if ('wrapup_resolution' in patch) return Promise.resolve(null);
          return park(state.dispositionOnRow.has(id) ? { id, disposition_code: 'promise_to_pay' } : { id, disposition_code: null });
        }),
      },
      session: { setState: vi.fn(() => park(undefined)) },
      park,
    },
  };
});
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyAgentSessionRepository: repos.session,
  agencyContactRepository: {},
  agencyCampaignRepository: {},
}));

import { WrapupManager, type WrapupResolution } from '../../../src/agency/wrapup-manager.js';
import { createRng, scaled, type Rng } from '../../helpers/load-scale.js';

/** Flush the microtask queue far enough for any released chain to run on. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface Opened {
  attemptId: string;
  startedAt: number;
  wrapupSeconds: number;
  autoReturn: boolean;
}

interface SessionBook {
  opened: number;
  closedByReturn: number;
  closedByCancel: number;
  closedByReplace: number;
  /** The wrap-up the manager should be holding for this session right now. */
  current: Opened | null;
  violations: string[];
}

function harness(rng: Rng, sessions: number, opts: { parkReturns: boolean } = { parkReturns: true }) {
  const books = new Map<string, SessionBook>();
  for (let s = 0; s < sessions; s++) {
    books.set(`s${s}`, {
      opened: 0, closedByReturn: 0, closedByCancel: 0, closedByReplace: 0, current: null, violations: [],
    });
  }
  let manager: WrapupManager; // assigned below; `stations` reads it lazily
  const stations = {
    send: vi.fn((sessionId: string, frame: { event: string; state?: string; wrapup?: { attempt_id: string } }) => {
      const live = manager.stateFor(sessionId);
      const book = books.get(sessionId)!;
      if (frame.event === 'agent_state' && frame.state === 'wrapup' && !live) {
        book.violations.push(`P3: agent_state wrapup announced with no live wrap-up (t=${Date.now()})`);
      }
      if (frame.event === 'wrapup' && live?.attempt_id !== frame.wrapup!.attempt_id) {
        book.violations.push(`P3: wrapup frame for ${frame.wrapup!.attempt_id} while live is ${live?.attempt_id ?? 'none'}`);
      }
      return true;
    }),
  };
  const agents = { set: vi.fn(() => repos.park(undefined)) };
  const onReturn = vi.fn(async (sessionId: string, resolution: WrapupResolution) => {
    const book = books.get(sessionId)!;
    book.closedByReturn++;
    const cur = book.current;
    if (resolution === 'auto_return') {
      if (!cur) book.violations.push(`P2: auto_return with no wrap-up open (t=${Date.now()})`);
      else if (!cur.autoReturn) book.violations.push(`P2: auto_return ended ${cur.attemptId}, which has no timer`);
      else if (Date.now() - cur.startedAt < cur.wrapupSeconds * 1000) {
        book.violations.push(
          `P2: auto_return ended ${cur.attemptId} after ${Date.now() - cur.startedAt}ms of a ${cur.wrapupSeconds}s window`,
        );
      }
    }
    book.current = null;
    // The real return (`releaseAgent`) writes Redis and the DB, so it is parked
    // too, half the time: a force or a disposition can land while it is in flight.
    if (opts.parkReturns && rng.chance(0.5)) await repos.park(undefined);
  });
  manager = new WrapupManager(stations as never, agents as never, onReturn);
  return { manager, books, onReturn };
}

/** One seeded run: `steps` random actions over `sessions` agents, then a full drain. */
async function runSchedule(seed: number, sessions: number, steps: number) {
  const rng = createRng(seed);
  const { manager, books } = harness(rng, sessions);
  const latestAttempt = new Map<string, string>();
  let attemptSeq = 0;
  const enters: Array<Promise<void>> = [];

  const enter = (sessionId: string) => {
    const timed = rng.chance(0.75);
    const wrapupSeconds = timed ? rng.int(1, 4) : 0;
    const autoReturn = rng.chance(0.8);
    const requiresDisposition = rng.chance(0.4);
    const attemptId = `att-${attemptSeq++}`;
    // Sometimes the agent dispositioned BEFORE hanging up, so the row already has it.
    if (rng.chance(0.2)) repos.state.dispositionOnRow.add(attemptId);
    latestAttempt.set(sessionId, attemptId);
    const book = books.get(sessionId)!;
    const opens = timed || requiresDisposition;
    if (opens) {
      // `enter` cancels a live predecessor synchronously, before its first await.
      if (manager.stateFor(sessionId)) book.closedByReplace++;
      book.opened++;
      book.current = { attemptId, startedAt: Date.now(), wrapupSeconds, autoReturn: timed && autoReturn };
    }
    enters.push(manager.enter({
      sessionId, attemptId, campaignId: 'c', tenantId: 't',
      wrapupSeconds, autoReturn, requiresDisposition,
    }).then((ok) => {
      expect(ok, `enter(${attemptId}) answered ${ok} but ${opens ? 'opens' : 'does not open'} a wrap-up`).toBe(opens);
    }));
  };

  for (let step = 0; step < steps; step++) {
    const sessionId = `s${rng.int(0, sessions - 1)}`;
    const roll = rng.next();
    if (roll < 0.3 && parked.length > 0) {
      // Release one parked write, chosen at random: completions arrive out of order.
      parked.splice(rng.int(0, parked.length - 1), 1)[0]!();
    } else if (roll < 0.45) {
      enter(sessionId);
    } else if (roll < 0.6) {
      const attemptId = latestAttempt.get(sessionId);
      if (attemptId) {
        repos.state.dispositionOnRow.add(attemptId);
        void manager.noteDisposition(sessionId, attemptId);
      }
    } else if (roll < 0.68) {
      void manager.force(sessionId);
    } else if (roll < 0.74) {
      const book = books.get(sessionId)!;
      if (manager.stateFor(sessionId)) {
        book.closedByCancel++;
        book.current = null;
      }
      manager.cancel(sessionId, 'agent_returned');
    } else {
      await vi.advanceTimersByTimeAsync(rng.int(0, 1_500));
    }
    await settle();
  }

  // Drain: release every write, run every timer, force whatever is held, repeat.
  // Forces are not awaited: a return they start may itself be parked.
  for (let round = 0; round < 20 && (parked.length > 0 || manager.active() > 0); round++) {
    while (parked.length > 0) {
      parked.shift()!();
      await settle();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    for (const sessionId of books.keys()) void manager.force(sessionId);
    await settle();
  }
  await Promise.all(enters);
  return { manager, books };
}

beforeEach(() => {
  vi.useFakeTimers();
  parked.length = 0;
  repos.state.dispositionOnRow.clear();
});
afterEach(() => vi.useRealTimers());

describe('WrapupManager under seeded interleavings', () => {
  const SEEDS = scaled(150);

  it('closes every wrap-up exactly once, never auto-returns early, never announces a dead wrap-up', async () => {
    const base = createRng().seed;
    const failures: string[] = [];
    for (let i = 0; i < SEEDS; i++) {
      const seed = base + i;
      const { manager, books } = await runSchedule(seed, 6, 250);
      expect(manager.active(), `seed=${seed}: wrap-ups left open after the drain`).toBe(0);
      for (const [sessionId, b] of books) {
        const closed = b.closedByReturn + b.closedByCancel + b.closedByReplace;
        if (closed !== b.opened) {
          failures.push(`seed=${seed} ${sessionId}: P1 opened ${b.opened}, closed ${closed} ` +
            `(return ${b.closedByReturn}, cancel ${b.closedByCancel}, replace ${b.closedByReplace})`);
        }
        for (const v of b.violations) failures.push(`seed=${seed} ${sessionId}: ${v}`);
      }
    }
    expect(failures.slice(0, 10), `${failures.length} violation(s); first ten shown`).toEqual([]);
  });

  /**
   * The specific interleaving the model found, pinned as an example.
   *
   * A timed wrap-up is resolved (a disposition, a supervisor's force) while
   * `enter` is still awaiting its writes. `enter` then resumed and armed the timer
   * and announced the wrap-up on an entry that no longer existed — so the console
   * was shown `agent_state: wrapup` for an agent already back in the pool, and the
   * orphaned timer later fired `onExpiry` against the session's NEXT wrap-up,
   * ending it as `auto_return` before its own window had run.
   */
  it('a wrap-up resolved while enter is mid-write is neither announced nor timed afterwards', async () => {
    const { manager, books, onReturn } = harness(createRng(), 1, { parkReturns: false });
    const first = manager.enter({
      sessionId: 's0', attemptId: 'att-a', campaignId: 'c', tenantId: 't',
      wrapupSeconds: 3, autoReturn: true, requiresDisposition: false,
    });
    books.get('s0')!.current = { attemptId: 'att-a', startedAt: Date.now(), wrapupSeconds: 3, autoReturn: true };
    books.get('s0')!.opened++;
    // The supervisor forces it while the Redis/DB writes are still in flight.
    await manager.force('s0');
    expect(onReturn).toHaveBeenCalledTimes(1);
    while (parked.length > 0) { parked.shift()!(); await settle(); }
    expect(await first).toBe(true);

    // Two seconds later the agent finishes another call and enters a 3s wrap-up.
    await vi.advanceTimersByTimeAsync(2_000);
    const second = manager.enter({
      sessionId: 's0', attemptId: 'att-b', campaignId: 'c', tenantId: 't',
      wrapupSeconds: 3, autoReturn: true, requiresDisposition: false,
    });
    books.get('s0')!.current = { attemptId: 'att-b', startedAt: Date.now(), wrapupSeconds: 3, autoReturn: true };
    books.get('s0')!.opened++;
    while (parked.length > 0) { parked.shift()!(); await settle(); }
    await second;

    // One second on, the first wrap-up's deadline passes. Nothing may happen.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(manager.stateFor('s0')?.attempt_id).toBe('att-b');
    // Its own deadline returns it, once.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onReturn).toHaveBeenCalledTimes(2);
    expect(onReturn).toHaveBeenLastCalledWith('s0', 'auto_return');
    expect(books.get('s0')!.violations).toEqual([]);
  });
});
