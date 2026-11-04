import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The pacing history accumulator (`agency/pacing/pacing-history.ts`): counts per campaign per
// minute in memory, one additive batch per flush, best effort with bounded memory. The SQL the
// batch lands in is proven on real Postgres (`test/integration/agency/insights-pacing-repository.test.ts`);
// this file is the in-memory side, on fake timers.
// ---------------------------------------------------------------------------

const { childLog, repo } = vi.hoisted(() => ({
  childLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  repo: { addToMinute: vi.fn(), upsertMinutes: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({
  logger: childLog,
  createChildLogger: () => childLog,
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyInsightsPacingRepository: repo,
}));

import * as metrics from '@magick-agency/observability/metrics/agency';
import {
  PacingHistoryAccumulator,
  PACING_HISTORY_FLUSH_MS,
  recordPacingEvent,
} from '../../../src/agency/pacing/pacing-history.js';
import { PACING_HISTORY_FIELDS, type PacingHistoryField } from '../../../src/agency/pacing/pacing-history-fields.js';
import type { PacingMinuteRow } from '../../../src/db/repositories/agency.repository.js';

const T0 = Date.parse('2026-11-04T10:00:00Z');
const MIN = 60_000;

/** A sink that records each batch as {campaign|minute → {field: n}} and can be told to fail. */
function sink() {
  const batches: Array<Record<string, Partial<Record<PacingHistoryField, number>>>> = [];
  let failing = 0;
  let hang: Promise<void> | null = null;
  const upsertMinutes = vi.fn(async (rows: readonly PacingMinuteRow[]) => {
    if (hang) await hang;
    if (failing > 0) {
      failing--;
      throw new Error('database unavailable');
    }
    const out: Record<string, Partial<Record<PacingHistoryField, number>>> = {};
    for (const r of rows) {
      const key = `${r.campaignId}|${new Date(r.minuteStart).toISOString()}`;
      const entry = (out[key] ??= {});
      PACING_HISTORY_FIELDS.forEach((f, i) => { if (r.counts[i]) entry[f] = (entry[f] ?? 0) + r.counts[i]!; });
    }
    batches.push(out);
    return rows.length;
  });
  return {
    upsertMinutes,
    batches,
    failNext(n = 1) { failing = n; },
    hangUntil(p: Promise<void>) { hang = p; },
    /** Every batch summed: what the table would hold. */
    total() {
      const out: Record<string, Partial<Record<PacingHistoryField, number>>> = {};
      for (const b of batches) for (const [k, v] of Object.entries(b)) {
        const e = (out[k] ??= {});
        for (const [f, n] of Object.entries(v)) e[f as PacingHistoryField] = (e[f as PacingHistoryField] ?? 0) + n!;
      }
      return out;
    },
  };
}

const m = (minute: number) => new Date(T0 + minute * MIN).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('PacingHistoryAccumulator', () => {
  it('adds counts in memory and writes them in one batch per flush, then starts from zero', async () => {
    const s = sink();
    const acc = new PacingHistoryAccumulator({ sink: s });
    acc.count('c1', 't1', 'ticks');
    acc.count('c1', 't1', 'ticks');
    acc.count('c1', 't1', 'idle_no_agents');
    acc.count('c2', 't1', 'dials_placed', 3);
    expect(s.upsertMinutes).not.toHaveBeenCalled();

    await acc.flush();
    expect(s.upsertMinutes).toHaveBeenCalledTimes(1);
    expect(s.batches[0]).toEqual({
      [`c1|${m(0)}`]: { ticks: 2, idle_no_agents: 1 },
      [`c2|${m(0)}`]: { dials_placed: 3 },
    });

    // The same minute again: only what came after the flush (the upsert adds it).
    acc.count('c1', 't1', 'ticks');
    await acc.flush();
    expect(s.batches[1]).toEqual({ [`c1|${m(0)}`]: { ticks: 1 } });
    // Nothing new: no statement at all.
    await acc.flush();
    expect(s.upsertMinutes).toHaveBeenCalledTimes(2);
    expect(acc.pendingMinutes()).toBe(0);
  });

  it('rolls over at the minute: each minute is its own row, and the closed one waits for the flush', async () => {
    const s = sink();
    const acc = new PacingHistoryAccumulator({ sink: s });
    vi.setSystemTime(T0 + 59_999);
    acc.count('c1', 't1', 'ticks');
    vi.setSystemTime(T0 + MIN);
    acc.count('c1', 't1', 'ticks');
    acc.count('c1', 't1', 'ticks');
    expect(acc.peek('c1', T0)).toEqual({ ticks: 1 });
    expect(acc.peek('c1', T0 + MIN)).toEqual({ ticks: 2 });
    await acc.flush();
    expect(s.batches[0]).toEqual({ [`c1|${m(0)}`]: { ticks: 1 }, [`c1|${m(1)}`]: { ticks: 2 } });
  });

  it('flushes on its own every interval once started, and not before start()', async () => {
    const s = sink();
    const acc = new PacingHistoryAccumulator({ sink: s });
    acc.count('c1', 't1', 'ticks');
    await vi.advanceTimersByTimeAsync(PACING_HISTORY_FLUSH_MS * 2);
    expect(s.upsertMinutes).not.toHaveBeenCalled();
    acc.start();
    await vi.advanceTimersByTimeAsync(PACING_HISTORY_FLUSH_MS);
    expect(s.upsertMinutes).toHaveBeenCalledTimes(1);
    await acc.close();
  });

  it('a failed flush keeps the batch: the next flush writes it with what came since, and nothing is counted twice', async () => {
    const s = sink();
    const acc = new PacingHistoryAccumulator({ sink: s });
    const failures = vi.spyOn(metrics.agencyPacingHistoryWriteFailuresTotal, 'inc');
    acc.count('c1', 't1', 'ticks', 4);
    s.failNext();
    await expect(acc.flush()).resolves.toBeUndefined(); // never rejects
    expect(failures).toHaveBeenCalledWith({ path: 'batch' });
    expect(childLog.warn).toHaveBeenCalledWith(expect.objectContaining({ minutes: 1 }), expect.stringContaining('kept for the next flush'));
    expect(acc.pendingMinutes()).toBe(1);

    acc.count('c1', 't1', 'ticks', 2); // same minute, after the failure
    vi.setSystemTime(T0 + MIN);
    acc.count('c1', 't1', 'idle_no_slots');
    await acc.flush();
    expect(s.total()).toEqual({ [`c1|${m(0)}`]: { ticks: 6 }, [`c1|${m(1)}`]: { idle_no_slots: 1 } });
    expect(acc.pendingMinutes()).toBe(0);
    failures.mockRestore();
  });

  it('counts that land while a flush is in flight are kept for the next one, and a second flush call joins the first', async () => {
    const s = sink();
    const acc = new PacingHistoryAccumulator({ sink: s });
    let release!: () => void;
    s.hangUntil(new Promise<void>((r) => { release = r; }));
    acc.count('c1', 't1', 'ticks');
    const first = acc.flush();
    expect(acc.flush()).toBe(first);
    acc.count('c1', 't1', 'ticks', 5);
    release();
    await first;
    s.hangUntil(Promise.resolve());
    await acc.flush();
    expect(s.total()).toEqual({ [`c1|${m(0)}`]: { ticks: 6 } });
    expect(s.upsertMinutes).toHaveBeenCalledTimes(2);
  });

  it('holds at most the cap of unwritten minutes: the oldest go first, with a WARN and the dropped counter', async () => {
    const s = sink();
    const acc = new PacingHistoryAccumulator({ sink: s, maxPending: 3 });
    const dropped = vi.spyOn(metrics.agencyPacingHistoryDroppedTotal, 'inc');
    s.failNext(100);
    for (let minute = 0; minute < 6; minute++) {
      vi.setSystemTime(T0 + minute * MIN);
      acc.count('c1', 't1', 'ticks', minute + 1);
      await acc.flush();
    }
    // Minute 5 is in the pending map after its failed flush; minutes 0–2 were dropped.
    expect(acc.pendingMinutes()).toBe(3);
    expect(dropped.mock.calls.reduce((n, c) => n + (c[0] as number), 0)).toBe(3);
    expect(childLog.warn).toHaveBeenCalledWith(expect.objectContaining({ cap: 3 }), expect.stringContaining('dropped the oldest'));
    s.failNext(0);
    await acc.flush();
    expect(s.total()).toEqual({
      [`c1|${m(3)}`]: { ticks: 4 }, [`c1|${m(4)}`]: { ticks: 5 }, [`c1|${m(5)}`]: { ticks: 6 },
    });
    dropped.mockRestore();
  });

  it('forgets a campaign that stopped counting once its minute is written and over', async () => {
    const s = sink();
    const acc = new PacingHistoryAccumulator({ sink: s });
    acc.count('c1', 't1', 'ticks');
    await acc.flush();
    vi.setSystemTime(T0 + MIN);
    await acc.flush();
    expect((acc as unknown as { current: Map<string, unknown> }).current.size).toBe(0);
  });

  it('close(): no more timer, one last flush of everything, and bounded when the database never answers', async () => {
    const s = sink();
    const acc = new PacingHistoryAccumulator({ sink: s, closeTimeoutMs: 1_000 });
    acc.start();
    acc.count('c1', 't1', 'ticks');
    vi.setSystemTime(T0 + MIN);
    acc.count('c1', 't1', 'ticks');
    await acc.close();
    expect(s.total()).toEqual({ [`c1|${m(0)}`]: { ticks: 1 }, [`c1|${m(1)}`]: { ticks: 1 } });
    await vi.advanceTimersByTimeAsync(PACING_HISTORY_FLUSH_MS * 3);
    expect(s.upsertMinutes).toHaveBeenCalledTimes(1);

    // A database that never answers: close resolves at its bound, with a WARN.
    const stuck = sink();
    stuck.hangUntil(new Promise<void>(() => {}));
    const acc2 = new PacingHistoryAccumulator({ sink: stuck, closeTimeoutMs: 1_000 });
    acc2.count('c1', 't1', 'ticks');
    const closing = acc2.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(closing).resolves.toBeUndefined();
    expect(childLog.warn).toHaveBeenCalledWith(expect.objectContaining({ pendingMinutes: expect.any(Number) }), expect.stringContaining('before shutdown'));
  });
});

describe('recordPacingEvent (outside the tick)', () => {
  it('writes one single-row upsert for the minute', async () => {
    repo.addToMinute.mockResolvedValue(undefined);
    const at = new Date(T0 + 30_000);
    await recordPacingEvent('c1', 't1', 'redials_refused_at_limit', at);
    expect(repo.addToMinute).toHaveBeenCalledWith({ campaignId: 'c1', tenantId: 't1', field: 'redials_refused_at_limit', at });
  });

  it('never rejects: a failed write is logged, counted on path="direct" and lost', async () => {
    const failures = vi.spyOn(metrics.agencyPacingHistoryWriteFailuresTotal, 'inc');
    repo.addToMinute.mockRejectedValue(new Error('database unavailable'));
    await expect(recordPacingEvent('c1', 't1', 'our_fault_retired')).resolves.toBeUndefined();
    expect(failures).toHaveBeenCalledWith({ path: 'direct' });
    expect(childLog.warn).toHaveBeenCalled();
    failures.mockRestore();
  });
});
