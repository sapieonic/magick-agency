import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Home's board composer (`src/agency/home-board.ts`, decision B28a): what it asks the repository
 * for, what it serves per campaign, how a failed read degrades, and the memos that keep a
 * 10-second board bounded (the account's board, a still campaign's stats and staffing, the
 * allocation and today's figures). The memos read `Date.now`, so the clock is faked.
 */

const repo = vi.hoisted(() => ({ listForHome: vi.fn(), floorSignatures: vi.fn() }));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({ agencyCampaignRepository: repo }));

import type { AgencyCampaignStats } from '@magick-agency/contracts/agency';
import {
  HOME_BOARD_MS,
  HOME_STILL_MS,
  campaignMoving,
  computeHomeBoard,
  homeStats,
  resetHomeBoardMemosForTests,
  type HomeBoardDeps,
  type HomeInsightsDeps,
} from '../../../src/agency/home-board.js';
import type { AgencyCampaignRecord } from '../../../src/db/models/agency.model.js';
import { todayRange } from '../../../src/agency/insights/health.js';

const SCOPE = { tenantId: 't-1', accountId: 'a-1' };
const UPDATED = new Date('2026-11-12T08:00:00.000Z');
/** The clock each test starts at: midday in Asia/Kolkata, the rows' zone. */
const START = Date.parse('2026-11-12T06:30:00.000Z');

function row(id: string, status: string, over: Partial<AgencyCampaignRecord> = {}): AgencyCampaignRecord {
  return {
    id, name: `Campaign ${id}`, status, tenant_id: 't-1', account_id: 'a-1', updated_at: UPDATED,
    created_at: new Date('2026-11-01T00:00:00.000Z'),
    record_calls: false, default_timezone: 'Asia/Kolkata',
    calling_window_start: '09:00:00', calling_window_end: '21:00:00', calling_days: [1, 2, 3, 4, 5],
    ...over,
  } as AgencyCampaignRecord;
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
    attempts_connected: 120,
    attempts_total: 300,
    contacts_total: 500,
    contacts_pending: 200,
    contacts_in_flight: 0,
    contacts_completed: 250,
    contacts_suppressed: 20,
    contacts_exhausted: 30,
    retries_pending: 4,
    human_connects: 90,
    agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 },
    agents: [],
    concurrency_limit: 10,
    concurrency: { campaign_live: 0, fair_share: null, account_limit: 10, account_live: 3, running_campaigns: 1 },
    ...over,
  } as Partial<AgencyCampaignStats>;
}

type Mocked<T> = { [K in keyof T]: ReturnType<typeof vi.fn> };
/** The insights reads of a supervisor's board. */
let reads: HomeInsightsDeps & Mocked<HomeInsightsDeps>;
/** A supervisor's board: the stats hop and the insights reads. */
let deps: HomeBoardDeps & { liveStats: ReturnType<typeof vi.fn>; insights: typeof reads };
/** A board below `agency.supervise`: the same stats hop, no insights reads. */
let viewer: HomeBoardDeps & { liveStats: ReturnType<typeof vi.fn> };

const ALLOCATION = {
  callbacks_overdue: 2, callbacks_overdue_unassigned: 0, callbacks_overdue_absent_owner: 0,
  held_by_absent: 0, absent_after_minutes: 15,
};
const TODAY = { carrier_failures: 0, recording: { connected: 0, recorded: 0 } };
const STAFFING = { staffed: 2, online: 1 };
const SETTINGS = {
  record_calls: false, calling_hours_default: false,
  calling_window_start: '09:00', calling_window_end: '21:00', calling_days: [1, 2, 3, 4, 5],
};

function list(rows: AgencyCampaignRecord[], activeTotal = rows.length, anyCampaign = rows.length > 0) {
  repo.listForHome.mockResolvedValue({ rows, activeTotal, anyCampaign });
}

/** Move the clock on (past the board memo's few seconds unless told otherwise). */
function advance(ms = 10_000) {
  vi.setSystemTime(Date.now() + ms);
}


beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(START);
  resetHomeBoardMemosForTests();
  repo.floorSignatures.mockImplementation(async () => new Map());
  reads = {
    staffing: vi.fn(async () => STAFFING),
    allocation: vi.fn(async () => ALLOCATION),
    today: vi.fn(async () => TODAY),
  };
  const liveStats = vi.fn(async () => payload());
  deps = { liveStats, insights: reads };
  viewer = { liveStats, insights: null };
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
        id: 'r1', name: 'Campaign r1', status: 'running',
        stats: {
          stall: null, abandoned_24h: 1, answered_24h: 40, abandonment_ceiling_pct: 3, agents_live: 0,
          agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 },
          attempts_live: 0, attempts_connected: 120, attempts_total: 300,
          contacts_total: 500, contacts_pending: 200, contacts_completed: 250, contacts_suppressed: 20, contacts_exhausted: 30,
          concurrency: { campaign_live: 0, fair_share: null, account_limit: 10, account_live: 3, running_campaigns: 1 },
        },
        staffing: STAFFING,
        allocation: ALLOCATION,
        today: TODAY,
        settings: SETTINGS,
      },
      expect.objectContaining({ id: 'p1', status: 'paused', allocation: ALLOCATION }),
    ]);
  });

  it('serves the campaign’s recording and calling-hours settings as the insights summary does', async () => {
    list([row('r1', 'running', {
      record_calls: true, calling_window_start: '09:00:00', calling_window_end: '20:00:00', calling_days: [1, 2, 3, 4, 5, 6],
    } as Partial<AgencyCampaignRecord>)]);
    const board = await computeHomeBoard(SCOPE, deps);
    expect(board.campaigns[0]!.settings).toMatchObject({ record_calls: true, calling_window_end: '20:00', calling_days: [1, 2, 3, 4, 5, 6] });
  });

  it('serves only the fields Home and the Active cards read: no floor roster, no other counters', async () => {
    list([row('r1', 'running')]);
    const board = await computeHomeBoard(SCOPE, deps);
    expect(Object.keys(board.campaigns[0]!.stats!).sort()).toEqual([
      'abandoned_24h', 'abandonment_ceiling_pct', 'agents_by_state', 'agents_live', 'answered_24h',
      'attempts_connected', 'attempts_live', 'attempts_total', 'concurrency', 'contacts_completed',
      'contacts_exhausted', 'contacts_pending', 'contacts_suppressed', 'contacts_total', 'stall',
    ]);
  });

  it('a viewer’s board carries the same stats, the Active cards’ figures included (all `/stats`’ own)', async () => {
    list([row('r1', 'running')]);
    const full = await computeHomeBoard(SCOPE, deps);
    advance();
    const theirs = await computeHomeBoard(SCOPE, viewer);
    expect(theirs.campaigns[0]!.stats).toEqual(full.campaigns[0]!.stats);
    expect(theirs.campaigns[0]!.stats).toMatchObject({ attempts_total: 300, contacts_pending: 200, concurrency: { account_live: 3 } });
  });

  it('is empty, and says whether the account has any campaign, with none active', async () => {
    list([], 0, false);
    expect(await computeHomeBoard(SCOPE, deps)).toEqual({ campaigns: [], active_total: 0, any_campaign: false });
    list([], 0, true);
    expect((await computeHomeBoard(SCOPE, deps)).any_campaign).toBe(true);
    expect(reads.allocation).not.toHaveBeenCalled();
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
    expect(board.campaigns.map((c) => c.allocation?.callbacks_overdue)).toEqual([2, 2, 2]);
  });

  it.each(['staffing', 'allocation', 'today'] as const)('a %s read that throws is null for that campaign, and read again next board', async (what) => {
    list([row('r1', 'running'), row('r2', 'running')]);
    reads[what].mockImplementationOnce(async () => { throw new Error('slow'); });
    const board = await computeHomeBoard(SCOPE, deps);
    expect(board.campaigns.map((c) => c[what] === null)).toEqual([true, false]);
    expect(board.campaigns.every((c) => c.stats !== null)).toBe(true);
    advance();
    expect((await computeHomeBoard(SCOPE, deps)).campaigns.every((c) => c[what] !== null)).toBe(true);
  });

  it('a payload without the ceiling is not the stats handler’s, and is not trusted', () => {
    expect(homeStats(payload({ abandonment_ceiling_pct: undefined }))).toBeNull();
  });
});

describe('the account’s board, for a few seconds', () => {
  it('a second board within HOME_BOARD_MS reads no campaign again, but the list each time', async () => {
    list([row('r1', 'running')], 1);
    await computeHomeBoard(SCOPE, deps);
    advance(HOME_BOARD_MS - 1);
    list([row('r1', 'running')], 7);
    const board = await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(1);
    expect(repo.listForHome).toHaveBeenCalledTimes(2);
    expect(board.active_total).toBe(7);
    advance(1);
    await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(2);
  });

  it('boards asked for at once share one computation', async () => {
    list([row('r1', 'running'), row('r2', 'running')]);
    const [a, b] = await Promise.all([computeHomeBoard(SCOPE, deps), computeHomeBoard(SCOPE, deps)]);
    expect(a.campaigns).toEqual(b.campaigns);
    expect(deps.liveStats).toHaveBeenCalledTimes(2);
    expect(reads.allocation).toHaveBeenCalledTimes(2);
  });

  it('is never another account’s', async () => {
    list([row('r1', 'running')]);
    await computeHomeBoard(SCOPE, deps);
    await computeHomeBoard({ tenantId: 't-1', accountId: 'a-2' }, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(2);
  });

  it('misses at once when a listed campaign’s status or updated_at changes, or the list does', async () => {
    list([row('r1', 'running')]);
    await computeHomeBoard(SCOPE, deps);
    list([row('r1', 'paused', { updated_at: new Date('2026-11-12T08:05:00.000Z') })]);
    expect((await computeHomeBoard(SCOPE, deps)).campaigns[0]!.status).toBe('paused');
    list([row('r1', 'paused', { updated_at: new Date('2026-11-12T08:05:00.000Z') }), row('r2', 'running')]);
    expect((await computeHomeBoard(SCOPE, deps)).campaigns.map((c) => c.id)).toEqual(['r1', 'r2']);
    expect(deps.liveStats).toHaveBeenCalledTimes(3);
  });
});

describe('what is read again on the next board', () => {
  it('a moving campaign’s stats, every time', async () => {
    list([row('r1', 'running'), row('s1', 'stopping'), row('p-live', 'paused'), row('p-staffed', 'paused')]);
    deps.liveStats.mockImplementation(async (c: AgencyCampaignRecord) =>
      payload(c.id === 'p-live' ? { attempts_live: 1 } : c.id === 'p-staffed' ? { agents_live: 2 } : {}));
    await computeHomeBoard(SCOPE, deps);
    advance();
    await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(8);
  });

  it('a moving campaign’s card figures are the latest read’s, never a kept one', async () => {
    list([row('r1', 'running'), row('p-live', 'paused')]);
    let dials = 300;
    deps.liveStats.mockImplementation(async (c: AgencyCampaignRecord) => payload({
      attempts_total: dials, contacts_pending: 500 - dials,
      ...(c.id === 'p-live' ? { attempts_live: 1 } : {}),
      concurrency: { campaign_live: 1, fair_share: null, account_limit: 10, account_live: dials / 100, running_campaigns: 1 },
    }));
    await computeHomeBoard(SCOPE, deps);
    dials = 400;
    advance();
    const board = await computeHomeBoard(SCOPE, deps);
    for (const c of board.campaigns) {
      expect(c.stats).toMatchObject({ attempts_total: 400, contacts_pending: 100, concurrency: { account_live: 4 } });
    }
  });

  it('a still campaign’s stats, once a minute', async () => {
    list([row('p1', 'paused')]);
    await computeHomeBoard(SCOPE, deps);
    for (let t = 10_000; t < HOME_STILL_MS; t += 10_000) {
      advance();
      await computeHomeBoard(SCOPE, deps);
    }
    expect(deps.liveStats).toHaveBeenCalledTimes(1);
    advance();
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

  it('a still campaign’s stats at once when its floor changes (an agent joins a paused campaign)', async () => {
    list([row('p1', 'paused')]);
    await computeHomeBoard(SCOPE, deps);
    expect(repo.floorSignatures).toHaveBeenCalledWith(['p1']);
    advance();
    await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(1);
    // A signed-out station is on the floor (still: nobody on shift), then it is reaped.
    repo.floorSignatures.mockImplementation(async () => new Map([['p1', '1/2026-11-12 08:01:00+00/2026-11-12 08:00:00+00']]));
    advance();
    await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(2);
    advance();
    await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(2);
    repo.floorSignatures.mockImplementation(async () => new Map());
    advance();
    await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(3);
  });

  it('every still campaign’s stats when the floor read fails (nothing reused on a guess)', async () => {
    list([row('p1', 'paused')]);
    repo.floorSignatures.mockRejectedValue(new Error('db down'));
    await computeHomeBoard(SCOPE, deps);
    advance();
    const board = await computeHomeBoard(SCOPE, deps);
    expect(deps.liveStats).toHaveBeenCalledTimes(2);
    expect(board.campaigns[0]!.stats).not.toBeNull();
  });

  it.each(['allocation', 'today'] as const)('every campaign’s %s figures, once a minute (follow-up counts, not a live queue)', async (what) => {
    list([row('r1', 'running'), row('p1', 'paused')]);
    let n = 0;
    reads[what].mockImplementation(async () => ({ ...(what === 'allocation' ? ALLOCATION : TODAY), n: (n += 1) }));
    const first = await computeHomeBoard(SCOPE, deps);
    for (let t = 10_000; t < HOME_STILL_MS; t += 10_000) {
      advance();
      expect((await computeHomeBoard(SCOPE, deps)).campaigns.map((c) => c[what])).toEqual(first.campaigns.map((c) => c[what]));
    }
    expect(reads[what]).toHaveBeenCalledTimes(2);
    advance();
    await computeHomeBoard(SCOPE, deps);
    expect(reads[what]).toHaveBeenCalledTimes(4);
  });

  it('today’s figures over the Health tab’s Today, and the new day’s at once after the zone’s midnight', async () => {
    // Kolkata's midnight is 18:30 UTC; a UTC campaign's day does not turn then.
    const kolkata = row('r1', 'running');
    const utc = row('r2', 'running', { default_timezone: 'UTC' });
    list([kolkata, utc]);
    vi.setSystemTime(Date.parse('2026-11-12T18:29:30.000Z'));
    const before = new Date();
    reads.today.mockImplementation(async (c: AgencyCampaignRecord, range: { from: Date }) => ({ ...TODAY, day: `${c.id}@${range.from.toISOString()}` }));
    const first = await computeHomeBoard(SCOPE, deps);
    expect(reads.today).toHaveBeenCalledWith(kolkata, todayRange(kolkata, before));
    expect(reads.today).toHaveBeenCalledWith(utc, todayRange(utc, before));
    expect(first.campaigns.map((c) => (c.today as unknown as { day: string }).day)).toEqual([
      'r1@2026-11-11T18:30:00.000Z', 'r2@2026-11-12T00:00:00.000Z',
    ]);

    advance(40_000); // 18:30:10: a new day in Kolkata, well inside HOME_STILL_MS
    reads.today.mockClear();
    const after = await computeHomeBoard(SCOPE, deps);
    expect(reads.today).toHaveBeenCalledTimes(1);
    expect(reads.today).toHaveBeenCalledWith(kolkata, todayRange(kolkata, new Date()));
    expect(after.campaigns.map((c) => (c.today as unknown as { day: string }).day)).toEqual([
      'r1@2026-11-12T18:30:00.000Z', 'r2@2026-11-12T00:00:00.000Z',
    ]);
  });

  it('only the campaign whose status or updated_at changed has its allocation read again', async () => {
    const r1 = row('r1', 'running');
    list([r1, row('p1', 'paused')]);
    await computeHomeBoard(SCOPE, deps);
    const edited = row('p1', 'paused', { updated_at: new Date('2026-11-12T08:05:00.000Z') });
    list([r1, edited]);
    await computeHomeBoard(SCOPE, deps);
    expect(reads.allocation).toHaveBeenCalledTimes(3);
    expect(reads.allocation).toHaveBeenLastCalledWith(edited);
  });

  it('a moving campaign’s staffing every board; a still one’s with its stats', async () => {
    list([row('r1', 'running'), row('p1', 'paused')]);
    await computeHomeBoard(SCOPE, deps);
    advance();
    await computeHomeBoard(SCOPE, deps);
    expect(reads.staffing.mock.calls.map(([c]) => (c as AgencyCampaignRecord).id)).toEqual(['r1', 'p1', 'r1']);
  });
});

describe('a board below agency.supervise (no insights reads)', () => {
  it('serves the stats and nulls for staffing, allocation, today and settings, and reads none of them', async () => {
    list([row('r1', 'running'), row('p1', 'paused')]);
    const board = await computeHomeBoard(SCOPE, viewer);
    expect(board.campaigns.map((c) => c.stats !== null)).toEqual([true, true]);
    for (const c of board.campaigns) {
      expect(c).toMatchObject({ staffing: null, allocation: null, today: null, settings: null });
    }
    expect(reads.staffing).not.toHaveBeenCalled();
    expect(reads.allocation).not.toHaveBeenCalled();
    expect(reads.today).not.toHaveBeenCalled();
  });

  it('is never a supervisor’s board, nor a supervisor’s theirs (cached apart)', async () => {
    list([row('r1', 'running')]);
    const full = await computeHomeBoard(SCOPE, deps);
    expect(full.campaigns[0]!.allocation).toEqual(ALLOCATION);
    const theirs = await computeHomeBoard(SCOPE, viewer);
    expect(theirs.campaigns[0]).toMatchObject({ staffing: null, allocation: null, today: null, settings: null });
    expect((await computeHomeBoard(SCOPE, deps)).campaigns[0]!.settings).toEqual(SETTINGS);
  });

  it('a still campaign’s stats are kept for either board; a supervisor’s still reads the staffing a viewer’s did not', async () => {
    list([row('p1', 'paused')]);
    await computeHomeBoard(SCOPE, viewer);
    advance();
    await computeHomeBoard(SCOPE, viewer);
    expect(deps.liveStats).toHaveBeenCalledTimes(1);
    advance();
    const full = await computeHomeBoard(SCOPE, deps);
    expect(full.campaigns[0]!.staffing).toEqual(STAFFING);
    expect(deps.liveStats).toHaveBeenCalledTimes(2);
    advance();
    await computeHomeBoard(SCOPE, deps);
    await computeHomeBoard(SCOPE, viewer);
    expect(deps.liveStats).toHaveBeenCalledTimes(2);
    expect(reads.staffing).toHaveBeenCalledTimes(1);
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
