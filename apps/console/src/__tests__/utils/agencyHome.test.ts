import { describe, expect, it } from 'vitest';
import {
  HOME_CAMPAIGN_CAP,
  abandonmentAttention,
  attentionBadgeLabel,
  homeAttention,
  homeBadgeCount,
  homeFloor,
  homeNeeds,
  homeWaiting,
  todaySuccessLine,
  todayTotals,
  todayWindow,
  type HomeCampaignRead,
  type HomeMissed,
} from '../../utils/agency/home';
import { AGENCY_STALL_LABELS, AGENCY_STALL_PRIORITY } from '../../utils/agencyHealthStrip';
import type { AgencyStall, AgencyStallCode } from '../../types/agency-campaign';
import type { AgencyGroupPage, AgencyGroupRow } from '../../types/agency-stats';
import type { AgencyHomeActiveStatus } from '@magick-agency/contracts/api/agency/home';
import { allocationFacts, campaign, settingsFacts, stats, STAFFED, todayFacts } from '../helpers/home';
import { allocation, allocationRow, health, summary } from '../helpers/insights';
import { campaignAttention } from '../../utils/agency/insights/overview';
import {
  attentionAllocation,
  attentionRangeFigures,
  attentionSettings,
  attentionStaffing,
} from '@magick-agency/contracts/api/agency/home';

/**
 * Home's rules (B28): every attention rule, the "near the ceiling" band, the floor rows, the
 * request cap and today's totals. These are the guards for what the page and the sidebar badge
 * count, so each threshold is pinned at its edge.
 */

const NO_MISSED: HomeMissed = { available: false, count: null };
const fmt = (iso: string) => `at ${iso}`;

type ReadOver = Partial<HomeCampaignRead> & { status?: AgencyHomeActiveStatus; overdue?: number };

/** A campaign's read: idle stats, one agent on the floor, nothing overdue, unless given. */
function read(id: string, over: ReadOver = {}): HomeCampaignRead {
  return {
    campaign: campaign(id, over.status ?? 'running'),
    stats: 'stats' in over ? (over.stats ?? null) : stats(),
    staffing: 'staffing' in over ? (over.staffing ?? null) : STAFFED,
    allocation: 'allocation' in over ? (over.allocation ?? null) : allocationFacts({ callbacks_overdue: over.overdue ?? 0 }),
    today: 'today' in over ? (over.today ?? null) : todayFacts(),
    settings: 'settings' in over ? (over.settings ?? null) : settingsFacts(),
    stale: false,
  };
}

const STALLS: Record<AgencyStallCode, AgencyStall> = {
  auto_paused_abandonment: { code: 'auto_paused_abandonment', measured_pct: 3.4, ceiling_pct: 3, paused_at: '2026-11-11T09:12:00Z' },
  auto_paused_carrier: { code: 'auto_paused_carrier', reason: 'carrier_auth', paused_at: '2026-11-11T08:00:00Z' },
  no_dialable_caller_ids: { code: 'no_dialable_caller_ids', caller_ids_stored: 2 },
  no_carrier_capacity: { code: 'no_carrier_capacity' },
  dnc_unavailable: { code: 'dnc_unavailable', tenant_wide: true },
  no_agents_available: { code: 'no_agents_available', agents_on_shift: 0, on_break_by_reason: {}, on_call: 0, last_dial_at: null },
  concurrency_saturated: { code: 'concurrency_saturated', limit: 10, in_use: 10 },
  outside_calling_hours: { code: 'outside_calling_hours', contacts_waiting: 40, next_window_opens_at: null },
  list_exhausted_retries_pending: { code: 'list_exhausted_retries_pending', retries_pending: 3, next_retry_at: null },
  elevated_failure_rate: { code: 'elevated_failure_rate', failed_pct: 40, attempts: 50, window_minutes: 15 },
};

const EXPECTED: Record<AgencyStallCode, { tone: string; to: string }> = {
  auto_paused_abandonment: { tone: 'danger', to: '/agency/campaigns/c1/health' },
  auto_paused_carrier: { tone: 'danger', to: '/agency/campaigns/c1/health' },
  no_dialable_caller_ids: { tone: 'danger', to: '/agency/campaigns/c1/health' },
  no_carrier_capacity: { tone: 'danger', to: '/agency/campaigns/c1/health' },
  dnc_unavailable: { tone: 'danger', to: '/agency/campaigns/c1/health' },
  no_agents_available: { tone: 'warning', to: '/agency/campaigns/c1/agents' },
  concurrency_saturated: { tone: 'warning', to: '/agency/campaigns/c1/health' },
  elevated_failure_rate: { tone: 'warning', to: '/agency/campaigns/c1/health' },
  outside_calling_hours: { tone: 'info', to: '/agency/campaigns/c1/overview' },
  list_exhausted_retries_pending: { tone: 'info', to: '/agency/campaigns/c1/overview' },
};

describe('a stalled campaign', () => {
  it.each(AGENCY_STALL_PRIORITY)('%s is one row, in the health strip’s words, linking to its fix', (code) => {
    const items = homeAttention([read('c1', { stats: stats({ stall: STALLS[code] }) })], NO_MISSED, fmt);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.title).toBe(AGENCY_STALL_LABELS[code]);
    expect(item!.campaign).toEqual({ id: 'c1', name: 'Campaign c1' });
    expect(item!.tone).toBe(EXPECTED[code].tone);
    expect(item!.to).toBe(EXPECTED[code].to);
    expect(item!.detail.length).toBeGreaterThan(10);
  });

  it('carries the time of an automatic pause, and none otherwise', () => {
    const [paused] = homeAttention([read('c1', { stats: stats({ stall: STALLS.auto_paused_abandonment }) })], NO_MISSED, fmt);
    expect(paused!.at).toBe('2026-11-11T09:12:00Z');
    expect(paused!.action).toBe('Review and resume');
    const [floor] = homeAttention([read('c1', { stats: stats({ stall: STALLS.no_agents_available }) })], NO_MISSED, fmt);
    expect(floor!.at).toBeNull();
    expect(floor!.action).toBe('Open the floor');
  });

  it('shows the top stall only, as the strip does', () => {
    const items = homeAttention(
      [read('c1', { stats: stats({ stall: STALLS.no_agents_available, other_stalls: ['outside_calling_hours'] }) })],
      NO_MISSED,
      fmt,
    );
    expect(items.map((i) => i.id)).toEqual(['stall:c1']);
  });
});

describe('abandonment against the ceiling', () => {
  // Ceiling 3%: the meter's warning band starts at 80% of it, 2.4%.
  const rate = (abandoned: number, answered: number, ceiling = 3) =>
    stats({ abandoned_24h: abandoned, answered_24h: answered, abandonment_ceiling_pct: ceiling });

  it('is "near" from 80% of the ceiling, the abandonment meter’s warning band', () => {
    expect(abandonmentAttention(rate(3, 125))).toBe('near'); // exactly 2.4%
    expect(abandonmentAttention(rate(3, 126))).toBeNull(); // 2.38%
    expect(abandonmentAttention(rate(3, 100))).toBe('near'); // at the ceiling: it pauses only above
    expect(abandonmentAttention(rate(4, 100))).toBe('over');
  });

  it('says nothing under 25 answered calls (IN5), however high the rate', () => {
    expect(abandonmentAttention(rate(10, 24))).toBeNull();
    expect(abandonmentAttention(rate(10, 25))).toBe('over');
  });

  it('is a row on a running campaign, in the Overview’s words, linking to Health', () => {
    const near = homeAttention([read('c1', { stats: rate(3, 100) })], NO_MISSED, fmt);
    expect(near).toEqual([expect.objectContaining({
      id: 'abandonment:c1',
      tone: 'warning',
      title: 'Abandonment 3% is close to the 3% ceiling',
      detail: 'Over the last 24 hours. Above the ceiling the guardrail pauses the campaign.',
      to: '/agency/campaigns/c1/health',
    })]);
    const over = homeAttention([read('c1', { stats: rate(4, 100) })], NO_MISSED, fmt);
    expect(over[0]).toMatchObject({ tone: 'danger', title: 'Abandonment 4% is over the 3% ceiling' });
  });

  it('is a row on a paused campaign too, as on the Overview, but not beside an abandonment pause', () => {
    expect(homeAttention([read('c1', { status: 'paused', stats: rate(4, 100) })], NO_MISSED, fmt).map((i) => i.id)).toEqual(['abandonment:c1']);
    const paused = homeAttention(
      [read('c1', { stats: { ...rate(4, 100), stall: STALLS.auto_paused_abandonment } })],
      NO_MISSED,
      fmt,
    );
    expect(paused.map((i) => i.id)).toEqual(['stall:c1']);
  });
});

describe('overdue callbacks', () => {
  it('is one row per campaign with any, linking to its Callbacks tab', () => {
    const items = homeAttention(
      [read('c1', { overdue: 7 }), read('c2', { overdue: 0 }), read('c3', { overdue: 1 }), read('c4')],
      NO_MISSED,
      fmt,
    );
    expect(items.map((i) => [i.id, i.title, i.to])).toEqual([
      ['callbacks-overdue:c1', '7 callbacks overdue', '/agency/campaigns/c1/callbacks'],
      ['callbacks-overdue:c3', '1 callback overdue', '/agency/campaigns/c3/callbacks'],
    ]);
  });

  it('says, as the Overview does, how many have no owner or an owner who is away', () => {
    const [item] = homeAttention(
      [read('c1', { allocation: allocationFacts({ callbacks_overdue: 3, callbacks_overdue_unassigned: 1, callbacks_overdue_absent_owner: 2 }) })],
      NO_MISSED,
      fmt,
    );
    expect(item!.detail).toBe('1 has no owner. 2 belong to an agent who is away. Customers were promised these calls.');
    expect(item!.action).toBe('Open callbacks');
  });
});

describe('the Overview’s other rows (B28a: Home never disagrees with the page it links to)', () => {
  it('an unstaffed running campaign: "No agents online", a warning the badge counts, opening the floor', () => {
    const items = homeAttention([read('c1', { staffing: { staffed: 0, online: 0 } })], NO_MISSED, fmt);
    expect(items).toEqual([expect.objectContaining({
      id: 'no-agents:c1', tone: 'warning', title: 'No agents online', detail: 'Nobody is assigned to this campaign yet.',
      to: '/agency/campaigns/c1/agents', action: 'Open the floor', badge: true,
    })]);
    expect(homeBadgeCount(items)).toBe(1);
    // Assigned agents who are all signed out: the same row.
    expect(homeAttention([read('c1', { staffing: { staffed: 2, online: 0 } })], NO_MISSED, fmt)[0]!.detail)
      .toBe('None of the 2 assigned agents is on the floor. Nothing dials until one joins.');
    // Paused: nothing dials anyway, so an empty floor is not a problem.
    expect(homeAttention([read('c1', { status: 'paused', staffing: { staffed: 0, online: 0 } })], NO_MISSED, fmt)).toEqual([]);
  });

  it('contacts held by agents who are away', () => {
    const [item] = homeAttention([read('c1', { allocation: allocationFacts({ held_by_absent: 4 }) })], NO_MISSED, fmt);
    expect(item).toMatchObject({ id: 'held-by-absent:c1', tone: 'warning', title: '4 due contacts held by agents who are away', badge: true });
  });

  it('today’s carrier failures and missing recordings, opening Health on Today', () => {
    const items = homeAttention(
      [read('c1', {
        today: todayFacts({ carrier_failures: 3, recording: { connected: 5, recorded: 2 } }),
        settings: settingsFacts({ record_calls: true }),
      })],
      NO_MISSED,
      fmt,
    );
    expect(items.map((i) => [i.id, i.tone, i.title, i.to, i.badge])).toEqual([
      ['carrier-failures:c1', 'info', '3 dials failed at the carrier', '/agency/campaigns/c1/health?range=today', false],
      ['recordings-missing:c1', 'info', '3 connected calls with no recording', '/agency/campaigns/c1/health?range=today', false],
    ]);
    expect(items[0]!.detail).toBe('Today, in the campaign’s time zone. The error codes are on the Health tab.');
    expect(items[1]!.detail).toBe('Recording is on, and 2 of 5 connected calls today have one. The latest calls can take a few minutes to show theirs.');
  });

  it('calling hours left at the default, as information', () => {
    const items = homeAttention([read('c1', { settings: settingsFacts({ calling_hours_default: true }) })], NO_MISSED, fmt);
    expect(items).toEqual([expect.objectContaining({ id: 'calling-hours-default:c1', tone: 'info', to: '/agency/campaigns/c1/settings', badge: false })]);
  });

  it('a part not known yet says nothing (no guess)', () => {
    expect(homeAttention([read('c1', { staffing: null, allocation: null, today: null, settings: null })], NO_MISSED, fmt)).toEqual([]);
  });

  it('every row the Overview lists for a campaign is on Home, in its tone and words', () => {
    // The Overview's fixtures, through the projections the server's board serves.
    const a = allocation({ agents: [allocationRow({ state: 'offline' })] });
    const h = health();
    for (const status of ['running', 'paused'] as const) {
      const s = summary(status);
      const overview = campaignAttention({ summary: s, allocation: a, health: h }).items;
      const home = homeAttention([read('c1', {
        status,
        stats: stats({
          abandoned_24h: h.abandonment.rolling_24h.abandoned,
          answered_24h: h.abandonment.rolling_24h.answered,
          abandonment_ceiling_pct: h.abandonment.ceiling_pct,
        }),
        staffing: attentionStaffing(a.agents),
        allocation: attentionAllocation(a),
        today: attentionRangeFigures(h),
        settings: attentionSettings(s.settings),
      })], NO_MISSED, fmt);
      expect(overview.length).toBeGreaterThan(3);
      expect(home.map((i) => [i.id, i.tone, i.title])).toEqual(overview.map((i) => [`${i.id}:c1`, i.tone, i.title]));
    }
  });
});

describe('missed inbound calls', () => {
  const count = (open: number, capped = false) => ({ open, open_capped: capped, has_rows: true });

  it('is a row when the reader gets the Missed list and calls are open', () => {
    const [item] = homeAttention([], { available: true, count: count(3) }, fmt);
    expect(item).toMatchObject({
      id: 'missed', tone: 'warning', title: '3 missed inbound calls to follow up', to: '/agency/inbound/missed', campaign: null,
    });
    expect(homeAttention([], { available: true, count: count(150, true) }, fmt)[0]!.title).toBe(
      'More than 99 missed inbound calls to follow up',
    );
  });

  it('is no row without access, with none open, or before the count answers', () => {
    expect(homeAttention([], { available: false, count: count(3) }, fmt)).toEqual([]);
    expect(homeAttention([], { available: true, count: count(0) }, fmt)).toEqual([]);
    expect(homeAttention([], { available: true, count: null }, fmt)).toEqual([]);
  });
});

describe('the list', () => {
  it('is empty when nothing holds (the "Nothing needs you right now" state)', () => {
    expect(homeAttention([read('c1'), read('c2', { status: 'paused' })], NO_MISSED, fmt)).toEqual([]);
  });

  it('puts danger first, then warnings (missed calls last among them), then information, keeping campaign order within a tone', () => {
    const items = homeAttention(
      [
        read('a', { stats: stats({ stall: STALLS.outside_calling_hours }) }),
        read('b', { stats: stats({ stall: STALLS.no_agents_available }), overdue: 2 }),
        read('c', { stats: stats({ stall: STALLS.auto_paused_carrier }) }),
      ],
      { available: true, count: { open: 1, open_capped: false, has_rows: true } },
      fmt,
    );
    expect(items.map((i) => i.id)).toEqual(['callbacks-overdue:b', 'stall:c', 'stall:b', 'missed', 'stall:a']);
  });

  it('splits into what needs the reader and what is only waiting (nothing wrong)', () => {
    const items = homeAttention(
      [
        read('a', { stats: stats({ stall: STALLS.outside_calling_hours }) }),
        read('b', { stats: stats({ stall: STALLS.list_exhausted_retries_pending }) }),
        read('c', { stats: stats({ stall: STALLS.no_agents_available }) }),
      ],
      { available: true, count: { open: 2, open_capped: false, has_rows: true } },
      fmt,
    );
    expect(homeNeeds(items).map((i) => i.id)).toEqual(['stall:c', 'missed']);
    expect(homeWaiting(items).map((i) => i.id)).toEqual(['stall:a', 'stall:b']);
  });
});

describe('what the Home badge counts', () => {
  const missed = { available: true, count: { open: 5, open_capped: false, has_rows: true } };

  it.each(AGENCY_STALL_PRIORITY)('%s counts only when it is a danger or a warning', (code) => {
    const items = homeAttention([read('c1', { stats: stats({ stall: STALLS[code] }) })], NO_MISSED, fmt);
    expect(homeBadgeCount(items)).toBe(EXPECTED[code].tone === 'info' ? 0 : 1);
  });

  it('counts dangers and warnings, never a waiting row, never the missed calls (the Inbound badge has them)', () => {
    const items = homeAttention(
      [
        read('a', { stats: stats({ stall: STALLS.outside_calling_hours }) }),
        read('b', { stats: stats({ stall: STALLS.no_agents_available }), overdue: 2 }),
        read('c', { stats: stats({ stall: STALLS.auto_paused_carrier, abandoned_24h: 4, answered_24h: 100 }) }),
        read('d', { stats: stats({ abandoned_24h: 3, answered_24h: 100 }) }),
      ],
      missed,
      fmt,
    );
    // callbacks-overdue:b, stall:b, stall:c, abandonment:c, abandonment:d — not stall:a, not missed.
    expect(items).toHaveLength(7);
    expect(homeBadgeCount(items)).toBe(5);
    expect(items.filter((i) => i.badge).map((i) => i.id).sort()).toEqual(
      ['abandonment:c', 'abandonment:d', 'callbacks-overdue:b', 'stall:b', 'stall:c'],
    );
  });

  it('is zero when only missed calls and waiting campaigns are on the list', () => {
    const items = homeAttention([read('a', { stats: stats({ stall: STALLS.outside_calling_hours }) })], missed, fmt);
    expect(items).toHaveLength(2);
    expect(homeBadgeCount(items)).toBe(0);
  });
});

describe('the sidebar badge', () => {
  it('says what it counts to a screen reader', () => {
    expect(attentionBadgeLabel(1)).toBe('1 needs your attention');
    expect(attentionBadgeLabel(4)).toBe('4 need your attention');
    expect(attentionBadgeLabel(120)).toBe('more than 99 need your attention');
    expect(attentionBadgeLabel(0)).toBeNull();
  });
});

describe('the request bound', () => {
  it('is the board\'s own cap (the server applies it)', () => {
    expect(HOME_CAMPAIGN_CAP).toBe(25);
  });
});

describe('the floor', () => {
  it('is a row per running campaign, and per paused one with agents on it, linking to Agents', () => {
    const rows = homeFloor([
      read('r', { stats: stats({ agents_live: 0 }) }),
      read('p-empty', { status: 'paused', stats: stats({ agents_live: 0 }) }),
      read('p-staffed', { status: 'paused', stats: stats({ agents_live: 2 }) }),
      read('r-unread', { stats: null }),
    ]);
    expect(rows.map((r) => [r.campaign.id, r.to])).toEqual([
      ['r', '/agency/campaigns/r/agents'],
      ['p-staffed', '/agency/campaigns/p-staffed/agents'],
    ]);
  });

  it('breaks the floor down by state, a call being connected counting as on a call', () => {
    const [row] = homeFloor([read('r', {
      stats: stats({
        agents_live: 9,
        agents_by_state: { offline: 1, available: 2, reserved: 1, on_call: 3, wrapup: 1, break: 1 },
        abandoned_24h: 3,
        answered_24h: 100,
      }),
    })]);
    expect(row).toMatchObject({ onCall: 4, available: 2, wrapup: 1, onBreak: 1, agentsLive: 9 });
    expect(row!.abandonment).toEqual({ text: '3%', level: 'near' });
  });

  it('falls back to agents live without a per-state breakdown, and withholds a small rate', () => {
    const [row] = homeFloor([read('r', { stats: stats({ agents_live: 3, agents_by_state: undefined, answered_24h: 4 }) })]);
    expect(row).toMatchObject({ onCall: null, available: null, agentsLive: 3 });
    expect(row!.abandonment).toEqual({ text: 'Not enough calls yet', level: null });
  });
});

describe('today so far', () => {
  const row = (id: string, over: Partial<AgencyGroupRow> = {}): AgencyGroupRow => ({
    key: { campaign_id: id },
    attempts: 10,
    connected: 4,
    successes: 1,
    talk_seconds: 300,
    wrapup_seconds: 60,
    connect_rate_pct: null,
    success_rate_pct: null,
    aht_seconds: null,
    rates_reportable: false,
    success_rate_reportable: false,
    ...over,
  });
  const page = (rows: AgencyGroupRow[], total = rows.length) => ({ rows, total_groups: total }) as unknown as AgencyGroupPage;

  it('sums the campaigns that dialled today', () => {
    expect(todayTotals(page([row('a'), row('b', { attempts: 5, talk_seconds: 120 })]))).toEqual({
      dials: 15, conversations: 8, successes: 2, talkSeconds: 420, campaigns: 2,
    });
    expect(todayTotals(page([]))).toEqual({ dials: 0, conversations: 0, successes: 0, talkSeconds: 0, campaigns: 0 });
  });

  it('prints no total when the server held rows back', () => {
    expect(todayTotals(page([row('a')], 2))).toBeNull();
  });

  it('asks from midnight up to now (UTC here; other zones in agencyHome.timezone.test.ts)', () => {
    expect(todayWindow(new Date('2026-11-11T14:30:00.000Z'))).toEqual({
      from: '2026-11-11T00:00:00.000Z',
      to: '2026-11-11T14:30:00.000Z',
    });
  });

  it('gives a success rate over conversations, with the Insights floor', () => {
    expect(todaySuccessLine({ successes: 10, conversations: 80 })).toBe('Success rate 12.5% of conversations');
    expect(todaySuccessLine({ successes: 3, conversations: 24 })).toBe('Success rate: not enough calls yet');
    expect(todaySuccessLine({ successes: 0, conversations: 0 })).toBeNull();
  });
});
