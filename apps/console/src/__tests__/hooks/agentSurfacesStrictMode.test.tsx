import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The two agent-surface hooks, and the supervisor page beside them, mounted the
 * way the app actually mounts them.
 *
 * ── The defect this file exists for ────────────────────────────────────────
 * `main.tsx` wraps the whole app in `<React.StrictMode>`, which in development
 * runs every effect **setup → cleanup → setup**. All three of these had a
 * `mounted` ref whose effect was cleanup-only:
 *
 *     useEffect(() => () => { mounted.current = false; }, []);
 *
 * The first cleanup sets it `false` and the second setup never puts it back, so
 * for the entire life of the component `mounted.current` is `false` while the
 * component is very much mounted. Every response then fails the staleness check,
 * no state is ever written, and the page spins forever. In development, and
 * only in development — which is the build every reviewer, every developer and
 * every demo sees.
 *
 * ── Why mounting under `StrictMode` is the honest way to pin it ────────────
 * Asserting on the ref, or calling the cleanup by hand, tests a paraphrase of
 * the bug rather than the bug: what makes it real is React's own double-invoke,
 * and the only way to be sure a fix survives is to let React do it. Each case
 * below therefore renders under `<StrictMode>` and asserts that the surface
 * REACHES ITS DATA — the observable the user has.
 *
 * Every case has a non-StrictMode twin immediately after it, because a hook that
 * hangs in both is a different bug from one that hangs only in development, and
 * a green suite should say which.
 */

const mocks = vi.hoisted(() => ({
  getMyStats: vi.fn(),
  getAgentStats: vi.fn(),
  getMyAttempts: vi.fn(),
  getAgentAttempts: vi.fn(),
  getMyCampaigns: vi.fn(),
  listAgencyCampaigns: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'tenant_admin',
    accountResolution: 'ready',
    accountError: null,
    reloadAccounts: vi.fn(),
  }),
}));
vi.mock('../../api/agencyStats', () => ({
  getMyStats: mocks.getMyStats,
  getAgentStats: mocks.getAgentStats,
  getMyAttempts: mocks.getMyAttempts,
  getAgentAttempts: mocks.getAgentAttempts,
  getMyCampaigns: mocks.getMyCampaigns,
}));
vi.mock('../../api/agencyCampaigns', () => ({
  listAgencyCampaigns: mocks.listAgencyCampaigns,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
}));

import { useAgentPerformance } from '../../hooks/useAgentPerformance';
import { AGENT_STATS_WINDOWS, windowRange } from '../../utils/agencyAgentPerformance';
import type { AgentStatsWindow } from '../../utils/agencyAgentPerformance';
import { useAgentAttempts } from '../../hooks/useAgentAttempts';
import { AgencyAnalyticsPage } from '../../pages/agency/AgencyAnalyticsPage';

function stats() {
  return {
    agent_user_id: 'user-1',
    bucket: 'day',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-20T12:00:00.000Z',
    totals: {
      attempts: 42,
      connected: 17,
      connect_rate_pct: 40.5,
      successes: 4,
      success_rate_pct: 23.5,
      talk_seconds: 1800,
      wrapup_seconds: 240,
      aht_seconds: 105,
      campaigns: 1,
    },
    buckets: [],
    by_campaign: [],
  };
}

function attempt(id: string) {
  return {
    id,
    contact_id: 'contact-1',
    campaign_id: 'camp-1',
    attempt_number: 1,
    phone_e164: '+919876543210',
    caller_id: '+911111111111',
    agent_user_id: 'user-1',
    state: 'ended',
    outcome: 'human',
    disposition_code: null,
    dispositioned_on_behalf: false,
    notes: null,
    talk_seconds: 60,
    created_at: '2026-08-20T09:00:00.000Z',
    dialed_at: '2026-08-20T09:00:01.000Z',
    ended_at: '2026-08-20T09:01:01.000Z',
  };
}

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
const plain = ({ children }: { children: ReactNode }) => <>{children}</>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMyStats.mockResolvedValue(stats());
  mocks.getAgentStats.mockResolvedValue(stats());
  mocks.getMyAttempts.mockResolvedValue({ rows: [attempt('a-1')], next_cursor: null });
  mocks.getAgentAttempts.mockResolvedValue({ rows: [attempt('a-1')], next_cursor: null });
  mocks.getMyCampaigns.mockResolvedValue([]);
  mocks.listAgencyCampaigns.mockResolvedValue([
    { id: 'camp-1', name: 'Renewals', status: 'running', wrapup_seconds: 30 },
  ]);
  mocks.getAgencyCampaignStats.mockResolvedValue({ attempts_total: 1 });
});

afterEach(() => cleanup());

describe('useAgentPerformance under StrictMode', () => {
  it('settles EVERY window when React double-invokes its effects', async () => {
    const { result } = renderHook(() => useAgentPerformance({ kind: 'me' }), { wrapper: strict });

    await waitFor(() => expect(result.current.periods.today?.status).toBe('ready'));
    // Asserted over the list rather than by name, so a sixth window cannot be
    // added without this noticing whether it settles.
    for (const window of AGENT_STATS_WINDOWS) {
      expect(result.current.periods[window]?.status, window).toBe('ready');
    }
  });

  it('settles without StrictMode too, so the failure above would be development-only', async () => {
    const { result } = renderHook(() => useAgentPerformance({ kind: 'me' }), { wrapper: plain });
    await waitFor(() => expect(result.current.periods.today?.status).toBe('ready'));
  });

  it('still settles on a manual reload after the double-invoke', async () => {
    /**
     * `reload` is the path the `mounted` ref exists for in the first place: its
     * cleanup is never handed to `useEffect`, so the flag is the only thing
     * standing between a navigate-away and a `setState` on nothing. Restoring the
     * flag must not have cost that.
     */
    const { result } = renderHook(() => useAgentPerformance({ kind: 'me' }), { wrapper: strict });
    await waitFor(() => expect(result.current.periods.today?.status).toBe('ready'));

    mocks.getMyStats.mockClear();
    result.current.reload();

    await waitFor(() =>
      expect(mocks.getMyStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length),
    );
    await waitFor(() => expect(result.current.periods.month?.status).toBe('ready'));
  });

  /**
   * The `windows` argument, which had no caller and no test.
   *
   * It is the mechanism that lets the panel offer a window the roster cannot
   * survive (core caps the per-agent read at 366 days and the roster reads at 92),
   * so it will get a caller the first time anyone adds a wider tile. Two things
   * have to hold before that is safe, and neither is visible from the default
   * path every other test in this file exercises.
   */
  it('asks for only the windows it was given, and settles them', async () => {
    const { result } = renderHook(
      // Deliberately an inline literal: this is how a caller would naturally
      // write it, and it is the shape that used to be the footgun.
      () => useAgentPerformance({ kind: 'me' }, null, ['today', 'week']),
      { wrapper: strict },
    );

    await waitFor(() => expect(result.current.periods.today?.status).toBe('ready'));
    await waitFor(() => expect(result.current.periods.week?.status).toBe('ready'));

    /*
     * Which ranges were asked for — never how many calls were made, and never a
     * count of DISTINCT ranges either. Both of those assert React's behaviour
     * rather than the hook's: StrictMode invokes the effect twice, and a to-date
     * window's `to` is `now.toISOString()`, so the second pass produces a
     * different range STRING for the same window, milliseconds later. Counting
     * distinct ranges therefore gave 2 or 4 depending on whether the two passes
     * landed in the same millisecond — which is exactly the flake this replaced.
     *
     * The stable property is containment: every range issued must be one this
     * window list can produce. A request for `month` would land outside it.
     */
    const now = new Date();
    const allowed = new Set(
      (['today', 'week'] as const).map((window) => windowRange(window, now).from),
    );
    for (const [query] of mocks.getMyStats.mock.calls) {
      expect(allowed.has(query.from), `unexpected range from=${query.from}`).toBe(true);
    }
    // Not merely absent from the request — absent from the state, so a panel
    // reading them gets `undefined` and renders its own loading tile rather than
    // a stale figure from a previous window set.
    expect(result.current.periods.month).toBeUndefined();
    expect(result.current.periods.last_week).toBeUndefined();
    expect(result.current.periods.last_month).toBeUndefined();
  });

  it('does not refetch forever when the window list is a fresh array each render', async () => {
    /**
     * The regression guard for the footgun itself. `windows` was a dependency of
     * the load callback by identity, so an inline literal — the natural way to
     * write the call above — meant a new dependency on every render: two requests
     * per render, forever. It typechecks, it reviews clean, and every existing
     * test passes, because none of them passes the prop.
     *
     * `load` keys on `windows.join()` instead. Rerendering with an equal-but-new
     * array must therefore issue nothing, which is what this asserts — under
     * StrictMode, whose double-invoke is what makes the loop tight.
     */
    const { rerender } = renderHook(
      ({ windows }: { windows: AgentStatsWindow[] }) =>
        useAgentPerformance({ kind: 'me' }, null, windows),
      { wrapper: strict, initialProps: { windows: ['today', 'week'] as AgentStatsWindow[] } },
    );

    await waitFor(() => expect(mocks.getMyStats.mock.calls.length).toBeGreaterThan(0));
    mocks.getMyStats.mockClear();

    for (let i = 0; i < 5; i += 1) {
      rerender({ windows: ['today', 'week'] as AgentStatsWindow[] });
    }
    await Promise.resolve();

    expect(mocks.getMyStats).not.toHaveBeenCalled();
  });
});

describe('useAgentAttempts under StrictMode', () => {
  it('reaches its first page when React double-invokes its effects', async () => {
    const { result } = renderHook(() => useAgentAttempts({ kind: 'me' }), { wrapper: strict });

    await waitFor(() => expect(result.current.page.status).toBe('ready'));
    expect(result.current.page.status === 'ready' && result.current.page.rows).toHaveLength(1);
  });

  it('reaches its first page without StrictMode too', async () => {
    const { result } = renderHook(() => useAgentAttempts({ kind: 'me' }), { wrapper: plain });
    await waitFor(() => expect(result.current.page.status).toBe('ready'));
  });

  it('appends a second page after the double-invoke', async () => {
    /**
     * `loadMore` writes through the same guard, so a half fix — the ref restored
     * for the first read but the append still discarded — would leave the button
     * doing nothing at all.
     */
    /*
      `mockResolvedValue`, not `…Once`: StrictMode double-invokes the effect, so
      the first page is READ TWICE and a one-shot value would be spent on the
      response that `decideListResponse` then discards.
    */
    mocks.getMyAttempts.mockResolvedValue({ rows: [attempt('a-1')], next_cursor: 'cur-1' });
    const { result } = renderHook(() => useAgentAttempts({ kind: 'me' }), { wrapper: strict });
    await waitFor(() => expect(result.current.page.status).toBe('ready'));

    mocks.getMyAttempts.mockResolvedValue({ rows: [attempt('a-2')], next_cursor: null });
    result.current.loadMore();

    await waitFor(() =>
      expect(result.current.page.status === 'ready' && result.current.page.rows.map((r) => r.id))
        .toEqual(['a-1', 'a-2']),
    );
  });
});

describe('AgencyAnalyticsPage under StrictMode', () => {
  it('renders its campaigns rather than spinning forever', async () => {
    /**
     * The same cleanup-only `mounted` effect, in a page rather than a hook, found
     * while fixing the two above. A supervisor opening Analytics in development
     * got a spinner that never resolved.
     */
    render(
      <MemoryRouter>
        <AgencyAnalyticsPage />
      </MemoryRouter>,
      { wrapper: strict },
    );

    expect(await screen.findByText('Renewals')).toBeTruthy();
  });
});
