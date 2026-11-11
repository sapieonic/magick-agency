import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Home's board composer (`src/agency/home-board.ts`, decision B28a): what it asks the repository
 * for, what it serves per campaign, how a failed read degrades, and the two memos that keep a
 * 10-second board as cheap as the reads it replaced.
 */

const repo = vi.hoisted(() => ({ listForHome: vi.fn() }));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({ agencyCampaignRepository: repo }));

import type { AgencyCampaignStats } from '@magick-agency/contracts/agency';
import {
  HOME_STILL_MS,
  campaignMoving,
  computeHomeBoard,
  homeStats,
  resetHomeBoardMemosForTests,
  type HomeBoardDeps,
} from '../../../src/agency/home-board.js';
import type { AgencyCampaignRecord } from '../../../src/db/models/agency.model.js';

const SCOPE = { tenantId: 't-1', accountId: 'a-1' };
const UPDATED = new Date('2026-11-12T08:00:00.000Z');

function row(id: string, status: string, over: Partial<AgencyCampaignRecord> = {}): AgencyCampaignRecord {
  return { id, name: `Campaign ${id}`, status, tenant_id: 't-1', account_id: 'a-1', updated_at: UPDATED, ...over } as AgencyCampaignRecord;
}

function payload(over: Partial<AgencyCampaignStats> = {}): Partial<AgencyCampaignStats> {
  return {
    campaign_id: 'x',
    stall: null,
    other_stalls: [],
    abandoned_24h: 1,
    answered_24h: 40,
    abandonment_ceiling_pct: 3,
    agents_live: 0,
    attempts_live: 0,
    agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 },
    agents: [],
    concurrency_limit: 10,
    ...over,
  } as Partial<AgencyCampaignStats>;
}

let now = 1_000_000;
let deps: HomeBoardDeps & { liveStats: ReturnType<typeof vi.fn>; callbacksOverdue: ReturnType<typeof vi.fn> };

function list(rows: AgencyCampaignRecord[], activeTotal = rows.length, anyCampaign = rows.length > 0) {
  repo.listForHome.mockResolvedValue({ rows, activeTotal, anyCampaign });
}

beforeEach(() => {
  vi.clearAllMocks();
  now = 1_000_000;
  vi.useFakeTimers();
  vi.setSystemTime(now);
  // After the fake clock: the overdue memo reads `Date.now` as it was when it was made.
  resetHomeBoardMemosForTests();
  deps = {
    liveStats: vi.fn(async () => payload()),
    callbacksOverdue: vi.fn(async () => 2),
    now: () => now,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the board', () => {
  it('asks for the active statuses in order, capped at 25, and serves each campaign’s reads', async () => {
    list([row('r1', 'running'), row('p1', 'paused')], 30, true);
    const board = await computeHomeBoard(SCOPE, deps);
    expect(repo.listForHome).toHaveBeenCalledWith('t-1', 'a-1', ['running', 'stopping', 'paused'], 25);
    expect(board.active_total).toBe(30);
    expect(board.any_campaign).toBe(true);
    expect(board.campaigns).toEqual([
      {
        id: 'r1', name: 'Campaign r1', status: 'running', callbacks_overdue: 2,
        stats: {
          stall: null, abandoned_24h: 1, answered_24h: 40, abandonment_ceiling_pct: 3, agents_live: 0,
          agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 },
        },
      },
      expect.objectContaining({ id: 'p1', status: 'paused', callbacks_overdue: 2 }),
    ]);
  });

  it('serves only the fields Home reads: no floor roster, no counters', async () => {
    list([row('r1', 'running')]);
    const board = await computeHomeBoard(SCOPE, deps);
    expect(Object.keys(board.campaigns[0]!.stats!).sort()).toEqual(
      ['abandoned_24h', 'abandonment_ceiling_pct', 'agents_by_state', 'agents_live', 'answered_24h', 'stall'],
    );
  });

  it('is empty, and says whether the account has any campaign, with none active', async () => {
    list([], 0, false);
    expect(await computeHomeBoard(SCOPE, deps)).toEqual({ campaigns: [], active_total: 0, any_campaign: false });
    list([], 0, true);
    expect((await computeHomeBoard(SCOPE, deps)).any_campaign).toBe(true);
  });

  it('fails as a whole only when the campaign list does', async () => {
    repo.listForHome.mockRejectedValue(new Error('db down'));
    await expect(computeHomeBoard(SCOPE, deps)).rejects.toThrow('db down');
  });
});

describe('a read that fails is null, never a failed board', () => {
  it('a stats read that throws or is refused', async () => {
    list([row('r1', 'running'), row('r2', 'running'), row('r3', 'running')]);
    deps.liveStats.mockImplementation(async (c: AgencyCampaignRecord) => {
      if (c.id === 'r1') throw new Error('boom');
      if (c.id === 'r2') return null;
      return payload();
    });
    const board = await computeHomeBoard(SCOPE, deps);
    expect(board.campaigns.map((c) => c.stats === null)).toEqual([true, true, false]);
    expect(board.campaigns.map((c) => c.callbacks_overdue)).toEqual([2, 2, 2]);
  });

  it('an allocation read that throws', async () => {
    list([row('r1', 'running'), row('r2', 'running')]);
    deps.callbacksOverdue.mockImplementation(async (c: AgencyCampaignRecord) => {
      if (c.id === 'r1') throw new Error('slow');
      return 5;
    });
    const board = await computeHomeBoard(SCOPE, deps);
    expect(board.campaigns.map((c) => c.callbacks_overdue)).toEqual([null, 5]);
    expect(board.campaigns.every((c) => c.stats !== null)).toBe(true);
  });

  it('a payload without the ceiling is not the stats handler’s, and is not trusted', () => {
    expect(homeStats(payload({ abandonment_ceiling_pct: undefined }))).toBeNull();
  });
});

describe('what is read again on the next board', () => {
  it('a moving campaign’s stats, every time', async () => {
    list([row('r1', 'running'), row('s1', 'stopping'), row('p-live', 'paused'), row('p-staffed', 'paused')]);
    deps.liveStats.mockImplementation(async (c: AgencyCampaignRecord) =>
      payload(c.id === 'p-live' ? { attempts_live: 1 } : c.id === 'p-staffed' ? { agents_live: 2 } : {}));
    await computeHomeBoard(SCOPE, deps);
    now += 10_000;
    await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(8);
  });

  it('a still campaign’s stats, once a minute', async () => {
    list([row('p1', 'paused')]);
    await computeHomeBoard(SCOPE, deps);
    for (let t = 10_000; t < HOME_STILL_MS; t += 10_000) {
      now += 10_000;
      await computeHomeBoard(SCOPE, deps);
    }
    expect(deps.liveStats).toHaveBeenCalledTimes(1);
    now += 10_000;
    await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(2);
  });

  it('a still campaign’s stats at once after a transition or a settings edit', async () => {
    list([row('p1', 'paused')]);
    await computeHomeBoard(SCOPE, deps);
    list([row('p1', 'paused', { updated_at: new Date('2026-11-12T08:05:00.000Z') })]);
    await computeHomeBoard(SCOPE, deps);
    list([row('p1', 'running', { updated_at: new Date('2026-11-12T08:05:00.000Z') })]);
    await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(3);
  });

  it('every campaign’s overdue count, once a minute (a follow-up count, not a live queue)', async () => {
    list([row('r1', 'running'), row('p1', 'paused')]);
    let n = 0;
    deps.callbacksOverdue.mockImplementation(async () => (n += 1));
    const first = await computeHomeBoard(SCOPE, deps);
    for (let t = 10_000; t < HOME_STILL_MS; t += 10_000) {
      now += 10_000;
      vi.setSystemTime(now);
      expect((await computeHomeBoard(SCOPE, deps)).campaigns.map((c) => c.callbacks_overdue))
        .toEqual(first.campaigns.map((c) => c.callbacks_overdue));
    }
    expect(deps.callbacksOverdue).toHaveBeenCalledTimes(2);
    now += 10_000;
    vi.setSystemTime(now);
    await computeHomeBoard(SCOPE, deps);
    expect(deps.callbacksOverdue).toHaveBeenCalledTimes(4);
  });
});

describe('campaignMoving (the campaigns home’s needsPolling rule)', () => {
  it.each([
    ['running', {}, true],
    ['stopping', {}, true],
    ['paused', {}, false],
    ['paused', { attempts_live: 1 }, true],
    ['paused', { agents_live: 1 }, true],
  ] as const)('%s with %o moves: %s', (status, over, moving) => {
    expect(campaignMoving(status, payload(over))).toBe(moving);
  });
});
