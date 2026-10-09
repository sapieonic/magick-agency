import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * "My performance" — the agent's own numbers, at `/dialer/performance`.
 *
 * ── What is worth pinning here ─────────────────────────────────────────────
 * Four properties, each recording a defect this repo has already shipped once
 * somewhere else:
 *
 *  1. **The account-resolution trap.** An `agent` is level 5, below
 *     `account.read`'s `viewer` floor, so `GET /accounts` 403s for them. Every
 *     read waits for both ids — and "resolution settled with no account" must be
 *     an ERROR rather than a permanent spinner, because with no account nothing
 *     is in flight and nothing fires again. `AgentHomePage`, `RequireFlag` and
 *     `AgencyAnalyticsPage` all carry this guard, and all three got it wrong
 *     first.
 *  2. **A null rate never renders as `0.0%`.** These numbers are read by the
 *     person being measured, so a zero reported for a measurement that has not
 *     been taken is not a cosmetic problem.
 *  3. **Dials and conversations are both on screen, with the rate between
 *     them.** A decided product rule, not a layout preference.
 *  4. **A supervisor is served, never bounced.** `AgentHomePage` redirects them
 *     away; this page must not, because a supervisor who covers shifts has their
 *     own numbers.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getMyStats: vi.fn(),
  getAgentStats: vi.fn(),
  getMyCampaigns: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyStats', () => ({
  getMyStats: mocks.getMyStats,
  getAgentStats: mocks.getAgentStats,
  getMyCampaigns: mocks.getMyCampaigns,
}));

import { AGENT_STATS_WINDOWS, windowRange } from '../../utils/agencyAgentPerformance';
import { AgentPerformancePage } from '../../pages/agency/AgentPerformancePage';

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function tree() {
  return (
    <MemoryRouter initialEntries={['/dialer/performance']}>
      <Routes>
        <Route path="/dialer/performance" element={<AgentPerformancePage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderPage() {
  return render(tree());
}

/**
 * Re-render the same tree after changing what `useTenant` returns.
 *
 * A rerender rather than a fresh `render`, because a fresh one would remount
 * everything and prove nothing: what a workspace switch does in the app is give
 * the SAME mounted page a new tenant or account, and whether the campaign scope
 * survives that is the whole question.
 */
function rerenderPage(rerender: (ui: React.ReactElement) => void) {
  rerender(tree());
}

function tenant(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'agent',
    accountResolution: 'ready',
    accountError: null,
    reloadAccounts: vi.fn(),
    ...over,
  };
}

function stats(over: Record<string, unknown> = {}) {
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
      occupancy: {
        shift_seconds: 1000,
        by_state: { available: 400, reserved: 0, on_call: 500, wrapup: 100, break: 0, offline: 0 },
      },
      ...(over['totals'] as object | undefined),
    },
    buckets: [
      { bucket_start: '2026-08-19', attempts: 20, connected: 8, successes: 2, talk_seconds: 900, wrapup_seconds: 120 },
      { bucket_start: '2026-08-20', attempts: 22, connected: 9, successes: 2, talk_seconds: 900, wrapup_seconds: 120 },
    ],
    by_campaign: [
      { campaign_id: 'camp-1', attempts: 42, connected: 17, successes: 4, talk_seconds: 1800, wrapup_seconds: 240 },
    ],
    ...over,
  };
}

function staffing(over: Record<string, unknown> = {}) {
  return {
    campaign_id: 'camp-1',
    campaign_name: 'Renewals',
    campaign_status: 'running',
    assigned_at: '2026-08-01T09:00:00.000Z',
    unassigned_at: null,
    active: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  mocks.getMyStats.mockResolvedValue(stats());
  mocks.getMyCampaigns.mockResolvedValue([staffing()]);
});

afterEach(() => {
  cleanup();
  // Only the clock-pinned tests install fake timers; restoring
  // unconditionally is cheaper than remembering which ones did.
  vi.useRealTimers();
});

describe('AgentPerformancePage — the account-resolution trap', () => {
  it('stops with an error rather than spinning when resolution settles with no account', async () => {
    /**
     * The precise bug. `accountResolution` can reach `ready`/`degraded`/`error`
     * with `accountId === null` — a tenant with genuinely zero accounts, or a
     * `'degraded'` fallback whose narrowed list came back empty — and nothing
     * fires again to set one. Both reads here wait for both ids, so without this
     * branch the spinner is permanent.
     */
    mocks.useTenant.mockReturnValue(tenant({ accountId: null, accountResolution: 'ready' }));

    renderPage();

    expect(await screen.findByText(/couldn’t open your account/i)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocks.getMyStats).not.toHaveBeenCalled();
    expect(mocks.getMyCampaigns).not.toHaveBeenCalled();
  });

  it('spins, rather than refusing, while resolution is still in flight', () => {
    // A refusal shown for one frame is a refusal the user remembers.
    mocks.useTenant.mockReturnValue(tenant({ accountId: null, accountResolution: 'loading' }));
    renderPage();
    expect(screen.queryByText(/couldn’t open your account/i)).toBeNull();
  });

  it('surfaces a failed account resolution too, with the server’s own detail', async () => {
    mocks.useTenant.mockReturnValue(
      tenant({ accountId: null, accountResolution: 'error', accountError: 'Forbidden' }),
    );
    renderPage();
    expect(await screen.findByText(/Forbidden/)).toBeTruthy();
  });

  it('spins while the ROLE has not resolved, but does NOT hold the reads back for it', async () => {
    /**
     * `TenantContext` fills `role` in asynchronously, so this is every cold
     * sign-in for one frame: the persona is `null`, the page shows a spinner
     * rather than a refusal (a refusal shown for one frame is one the user
     * remembers), and the reads fire anyway because they depend on the two ids
     * and not on the role.
     *
     * That last part is deliberate and is asserted so it is not "tidied" into a
     * role gate. Both ids are already resolved here, so waiting for the role
     * would delay every agent's first paint by a round trip to spare a role below
     * the station floor — which does not exist today — a single 403.
     * `AgentLanding` documents the same trade for the same reason.
     */
    mocks.useTenant.mockReturnValue(tenant({ role: undefined }));
    renderPage();
    expect(screen.getByRole('status')).toBeTruthy();
    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length));
  });
});

describe('AgentPerformancePage — the populated page', () => {
  /**
   * The clock is PINNED for the two range assertions below, and only `Date` is
   * faked so the timers `waitFor` polls on stay real. The suite runs in UTC (see
   * `vite.config.ts`), so the expected instants can be written as literals.
   *
   * Pinned because the property is a boundary one. `startOfDay` and
   * `startOfWeek(…, { weekStartsOn: 1 })` are the SAME instant on a Monday, so a
   * clock-dependent assertion about the three ranges is green six days a week
   * and red on the seventh — which is precisely what the earlier version of this
   * test did: it counted DISTINCT `from` values and expected three, and failed
   * every Monday against a page that was asking correctly.
   *
   * A window is identified by its NAME, not by its range. `useAgentPerformance`
   * loops `AGENT_STATS_WINDOWS` in order and keys its state on the window, so
   * the honest assertion is positional — today, week, last_week, month,
   * last_month — and it lets the Monday coincidence be what it is rather than
   * treating it as a fault.
   *
   * There are FIVE now, not three. The two completed windows are the ones an
   * agent had no way to ask for, and they differ in a way the old assertions
   * could not have expressed: their `to` is NOT `now`. `last_week` ends where
   * `week` begins, so the pair tiles exactly and no dial is in both or neither.
   */
  const clockAt = (iso: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });

  it('asks for all three periods, day-bucketed — on a Monday, when two ranges coincide', async () => {
    clockAt('2026-08-24T09:00:00.000Z');

    renderPage();
    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalledTimes(5));
    for (const call of mocks.getMyStats.mock.calls) {
      expect(call[0].bucket).toBe('day');
      expect(call[1]).toBe('tenant-1');
      expect(call[2]).toBe('account-1');
    }
    // Five requests, one per window, in window order. `week` repeats `today`
    // because on Monday morning the agent's week IS their morning.
    expect(mocks.getMyStats.mock.calls.map((c) => c[0].from)).toEqual([
      '2026-08-24T00:00:00.000Z',
      '2026-08-24T00:00:00.000Z',
      '2026-08-17T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
    /*
      The three to-date windows share ONE end — a call landing between two of
      them would appear in one and not the other; see the hook's single `now`.
      The two completed ones end where their to-date sibling begins, which is
      what makes the pair tile exactly rather than overlap by a morning.
    */
    expect(mocks.getMyStats.mock.calls.map((c) => c[0].to)).toEqual([
      '2026-08-24T09:00:00.000Z',
      '2026-08-24T09:00:00.000Z',
      '2026-08-24T00:00:00.000Z',
      '2026-08-24T09:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
  });

  it('asks for five separated ranges any other day of the week', async () => {
    // A Wednesday: the same five windows, now with distinct anchors. Both days
    // are asserted so neither reading of "the windows" can drift.
    clockAt('2026-08-26T09:00:00.000Z');

    renderPage();
    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalledTimes(5));
    expect(mocks.getMyStats.mock.calls.map((c) => c[0].from)).toEqual([
      '2026-08-26T00:00:00.000Z',
      '2026-08-24T00:00:00.000Z',
      '2026-08-17T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
  });

  it('asks for all three when the first of the month IS a Monday and all three coincide', async () => {
    /**
     * The third case, and the one the two above still leave open. On a Monday
     * that is also the 1st, `startOfDay`, `startOfWeek` and `startOfMonth` are
     * ONE instant, so a page asking correctly emits three identical `from`
     * values — which the count-the-distinct-values reading scores as one period,
     * not three. That reading is what already cost a day here; the Monday case
     * caught it at two, and this catches it at one.
     *
     * 2026-06-01 is a Monday. Twelve dates a year satisfy the pair, so this is
     * an ordinary morning for somebody, not a contrivance.
     */
    clockAt('2026-06-01T09:00:00.000Z');

    renderPage();
    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalledTimes(5));
    expect(mocks.getMyStats.mock.calls.map((c) => c[0].from)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-05-25T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    ]);
    // And still one request per window rather than a deduplicated fetch: the
    // hook keys its state on the window NAME, so every answer has to arrive
    // however identical two of the ranges are.
    expect(mocks.getMyStats.mock.calls).toHaveLength(5);
  });

  it('shows dials AND conversations, with the connect rate between them', async () => {
    /**
     * The decided product rule. Asserted at the DOM and in ORDER, because the
     * failure mode is a well-meaning "simplification" into one "calls" number —
     * and an agent reading one number cannot tell whether they are being credited
     * for dialling or for talking.
     */
    renderPage();

    const tile = await screen.findByTestId('period-tile-today');
    expect(within(tile).getByText('Dials')).toBeTruthy();
    expect(within(tile).getByText('Connect rate')).toBeTruthy();
    expect(within(tile).getByText('Conversations')).toBeTruthy();
    /*
      Wait for a FIGURE, not for the tile.

      `AgentPerformancePanel` renders each figure as "…" while the read is in
      flight, inside the very element these testids name — so awaiting the tile
      resolves on the loading render and every value assertion below it becomes
      a race, won locally and lost under CI's slower scheduling.
    */
    await waitFor(() =>
      expect(within(screen.getByTestId('today-attempts')).getByText('42')).toBeTruthy(),
    );
    expect(within(screen.getByTestId('today-connected')).getByText('17')).toBeTruthy();

    const labels = [...tile.querySelectorAll('[data-testid^="today-"]')].map(
      (node) => node.getAttribute('data-testid'),
    );
    expect(labels).toEqual(['today-attempts', 'today-connect_rate', 'today-connected']);
  });

  it('renders the derived readouts for the selected period', async () => {
    renderPage();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('conversion-rate-readout')).getByText('23.5%'),
      ).toBeTruthy(),
    );
    expect(within(await screen.findByTestId('handle-time-readout')).getByText('1:45')).toBeTruthy();
    expect(within(await screen.findByTestId('wrapup-readout')).getByText('4:00')).toBeTruthy();
  });

  it('draws the day chart and says whose day it is', async () => {
    renderPage();
    expect(await screen.findByTestId('bucket-chart')).toBeTruthy();
    // The timezone caveat is on the page at full weight rather than in a title
    // attribute — a caveat you have to hover to find is one the chart gets read
    // without.
    expect(screen.getByTestId('bucket-timezone-note').textContent).toContain(
      'own campaign’s local time',
    );
  });

  it('resolves campaign ids in the breakdown through the staffing history', async () => {
    // `by_campaign[]` carries ids and no names — master's contract — so without
    // `my-campaigns` this table is a column of uuids.
    renderPage();
    const row = await screen.findByTestId('campaign-row-camp-1');
    expect(within(row).getByText('Renewals')).toBeTruthy();
  });

  it('carries the agent nav, with THIS surface marked as current', async () => {
    /**
     * The station has no escape route on purpose: clicking away drops the socket
     * and core keeps the agent in the dialable pool for up to 45 seconds
     * afterwards, so a reservation landing in that window bridges a customer to
     * nobody. This page holds no socket, so links out are ordinary navigation —
     * and necessary, since a full-viewport page with no navigation is a trap.
     *
     * The nav replaced a `back` link plus one `sibling`. Those were authored per
     * page, so each agent screen linked to some of its neighbours and none of
     * them said which screen the reader was on.
     */
    renderPage();
    await screen.findByTestId('agent-nav-performance');

    expect(screen.getByTestId('agent-nav-campaigns').getAttribute('href')).toBe('/dialer');
    expect(screen.getByTestId('agent-nav-attempts').getAttribute('href')).toBe('/dialer/attempts');

    const current = screen.getByTestId('agent-nav-performance');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.tagName).not.toBe('A');
  });

  it('says how far back the figures reach, so five windows do not read as all of it', async () => {
    /**
     * "Last month" is the furthest any aggregate on this page goes, and the note
     * says so because an agent who has worked here a year would otherwise read
     * the widest tile as their whole record.
     *
     * ── The limit is OURS, and the note must not blame the server ────────────
     * This comment used to say "core caps a stats window at 92 days". That is
     * `ROSTER_MAX_WINDOW_DAYS`, the whole-floor bound; the per-agent read this
     * page calls accepts 366 (`AGENT_STATS_MAX_WINDOW_DAYS`). The copy inherited
     * the error and told an agent who worked here in March that March was
     * unreachable — false, and false in the product's own voice.
     *
     * So the absence is asserted, not just the presence. Matching only
     * /last month/ and /My calls/ would stay green if somebody "helpfully"
     * restored "core caps this at 92 days; open My calls for your total" —
     * which is how the wrong number got on screen the first time.
     */
    renderPage();
    const note = await screen.findByTestId('history-reach-note');
    expect(note.textContent).toMatch(/last month/i);
    expect(note.textContent).toMatch(/My calls/i);

    // No server ceiling, real or invented, and no borrowed roster bound.
    expect(note.textContent).not.toMatch(/\b92\b/);
    expect(note.textContent).not.toMatch(/\bcaps?\b/i);
    expect(note.textContent).not.toMatch(/\bserver\b/i);
    // And it must not promise a COUNT: "My calls" pages 50 rows at a time and
    // reports loaded rows, never a total. It can find a March call; it cannot
    // say how many there were.
    expect(note.textContent).not.toMatch(/\btotals?\b/i);
  });
});

describe('AgentPerformancePage — null is never zero', () => {
  it('renders a null connect rate as "not measured yet", never as 0.0%', async () => {
    /**
     * The rule the whole surface is built on. `0.0%` on an agent's first morning
     * is the product telling them they failed at something they have not yet had
     * the chance to do — the `abandonment_rate_24h_pct` lesson, aimed at a person.
     */
    mocks.getMyStats.mockResolvedValue(
      stats({ totals: { connect_rate_pct: null, success_rate_pct: null, aht_seconds: null } }),
    );

    renderPage();

    // The loading render puts "…" inside this same element, so wait for the
    // resolved figure rather than for the element.
    await waitFor(() =>
      expect(screen.getByTestId('today-connect_rate').textContent).toContain('Not measured yet'),
    );
    const figure = screen.getByTestId('today-connect_rate');
    expect(figure.textContent).not.toContain('0.0%');
    expect(figure.textContent).not.toContain('0%');
  });

  it('renders a null conversion rate and a null average the same way', async () => {
    mocks.getMyStats.mockResolvedValue(
      stats({ totals: { connect_rate_pct: null, success_rate_pct: null, aht_seconds: null } }),
    );

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByTestId('conversion-rate-readout').getAttribute('data-known'),
      ).toBe('false'),
    );
    const conversion = screen.getByTestId('conversion-rate-readout');
    expect(conversion.textContent).not.toContain('0%');
    expect(screen.getByTestId('handle-time-readout').getAttribute('data-known')).toBe('false');
  });

  it('does not draw a zeroed occupancy breakdown', async () => {
    /**
     * Core computes occupancy from an event log that shipped after the dialer, so
     * an older session returns zeros rather than nulls. Drawing a bar from those
     * zeros claims somebody spent a shift doing nothing at all.
     */
    mocks.getMyStats.mockResolvedValue(
      stats({
        totals: {
          occupancy: {
            shift_seconds: 28800,
            by_state: { available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 },
          },
        },
      }),
    );

    renderPage();

    expect(await screen.findByTestId('occupancy-unmeasured')).toBeTruthy();
    expect(screen.queryByTestId('occupancy-bar')).toBeNull();
  });

  it('draws occupancy when it was actually measured', async () => {
    renderPage();
    expect(await screen.findByTestId('occupancy-bar')).toBeTruthy();
    expect(screen.getByTestId('occupancy-on_call').textContent).toContain('8:20');
    expect(screen.queryByTestId('occupancy-unmeasured')).toBeNull();
  });

  it('does not draw signed-out time, or divide the shift by it', async () => {
    /**
     * `shift_seconds` on core's side is the sum of the states EXCLUDING
     * `offline`, so the bar has to be too. Half an hour on calls out of a
     * ninety-minute shift is a third of it; with six signed-out hours folded into
     * the denominator the same half hour read as 6.7%.
     */
    mocks.getMyStats.mockResolvedValue(
      stats({
        totals: {
          occupancy: {
            shift_seconds: 5400,
            by_state: {
              available: 3600, reserved: 0, on_call: 1800, wrapup: 0, break: 0, offline: 21600,
            },
          },
        },
      }),
    );

    renderPage();

    expect(await screen.findByTestId('occupancy-bar')).toBeTruthy();
    expect(screen.getByTestId('occupancy-on_call').textContent).toBe('On a call30:00 · 33.3%');
    expect(screen.queryByTestId('occupancy-offline')).toBeNull();
    // The shift and the states agree, so there is no gap to announce.
    expect(screen.queryByTestId('occupancy-gap')).toBeNull();
  });

  it('says so when the shift is longer than the states account for', async () => {
    /**
     * The note this asserts could never render before: with `offline` in the
     * denominator the recorded sum was always ≥ a `shift_seconds` that excludes
     * it, so the gap was structurally zero and the branch was dead code. A
     * station closed without signing out is the case it is written for.
     */
    mocks.getMyStats.mockResolvedValue(
      stats({
        totals: {
          occupancy: {
            shift_seconds: 3600,
            by_state: {
              available: 600, reserved: 0, on_call: 1800, wrapup: 0, break: 0, offline: 900,
            },
          },
        },
      }),
    );

    renderPage();

    expect(await screen.findByTestId('occupancy-gap')).toBeTruthy();
    expect(screen.getByTestId('occupancy-gap').textContent).toContain(
      'closes without signing out',
    );
    // Shares are still of what was RECORDED, so they reach 100% rather than
    // quietly refusing to, which would read as a rounding bug.
    expect(screen.getByTestId('occupancy-on_call').textContent).toBe('On a call30:00 · 75%');
  });

  it('shows nothing at all for a period spent entirely signed out', async () => {
    /**
     * The third state, and distinct from both. Nothing failed and nothing is
     * missing — the shift being broken down is zero seconds long, which is what
     * core reports as `shift_seconds: 0`. A full-width `offline` bar would claim
     * a shift that was never worked.
     */
    mocks.getMyStats.mockResolvedValue(
      stats({
        totals: {
          occupancy: {
            shift_seconds: 0,
            by_state: {
              available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 21600,
            },
          },
        },
      }),
    );

    renderPage();

    expect(await screen.findByTestId('occupancy-unmeasured')).toBeTruthy();
    expect(screen.queryByTestId('occupancy-bar')).toBeNull();
  });
});

describe('AgentPerformancePage — the period tiles are an accessible tablist', () => {
  /**
   * The tiles are pinned by ROLE and by selection state, not by `data-testid`.
   * Removing `role="tab"` and `aria-selected` from them left every existing case
   * in this file passing, and with it the only thing that distinguishes a period
   * selector from three unrelated buttons for anybody not looking at the screen.
   */
  it('names the three periods and marks the one in view', async () => {
    renderPage();
    await screen.findByTestId('period-tile-today');

    expect(screen.getByRole('tablist', { name: 'Period' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Today/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /^This week/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: /^This month/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('moves the selection when another period is chosen', async () => {
    renderPage();
    await screen.findByTestId('period-tile-today');

    fireEvent.click(screen.getByRole('tab', { name: /^This month/ }));

    expect(screen.getByRole('tab', { name: /^This month/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /^Today/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('points every tab at the panel it controls', async () => {
    renderPage();
    await screen.findByTestId('period-tile-today');

    const panel = screen.getByRole('tabpanel');
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    }
  });
});

describe('AgentPerformancePage — the empty and failed states', () => {
  it('says nothing happened, rather than leaving four em dashes to be read as failure', async () => {
    mocks.getMyStats.mockResolvedValue(
      stats({
        totals: {
          attempts: 0,
          connected: 0,
          connect_rate_pct: null,
          successes: 0,
          success_rate_pct: null,
          aht_seconds: null,
          talk_seconds: 0,
          wrapup_seconds: 0,
          campaigns: 0,
        },
        buckets: [],
        by_campaign: [],
      }),
    );

    renderPage();

    expect(await screen.findByTestId('empty-range')).toBeTruthy();
    expect(screen.getByTestId('breakdown-empty')).toBeTruthy();
  });

  it('explains the missing chart on a single-day range instead of drawing one bar', async () => {
    mocks.getMyStats.mockResolvedValue(
      stats({
        buckets: [
          { bucket_start: '2026-08-20', attempts: 5, connected: 2, successes: 1, talk_seconds: 60, wrapup_seconds: 10 },
        ],
      }),
    );

    renderPage();

    expect(await screen.findByTestId('bucket-chart-single')).toBeTruthy();
    expect(screen.queryByTestId('bucket-chart')).toBeNull();
  });

  it('fails one period without blanking the others', async () => {
    /**
     * `Promise.all` here would let one failed range blank all five on a page
     * whose whole purpose is telling somebody how their shift went. The same
     * reasoning `AgencyAnalyticsPage` applies per campaign.
     *
     * ── Why the clock is pinned and the discriminator is exact ──────────────
     * This used to select the failing range with `getDate() === 1` on an unpinned
     * clock, which was wrong twice over once there were five windows. `month` and
     * `last_month` BOTH start on the 1st, so it failed two while claiming one; and
     * on the 1st of any month `today` starts on the 1st as well, so `today` failed
     * too and the assertion below threw — a test that went red on one day in
     * thirty, for a reason having nothing to do with the behaviour it guards.
     *
     * Pinning mid-month and matching `month`'s exact `from` makes it fail exactly
     * the one range it names, on every day of the year.
     */
    const now = new Date('2026-08-20T14:30:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'], now });
    const monthFrom = windowRange('month', now).from;

    mocks.getMyStats.mockImplementation((query: { from: string }) =>
      query.from === monthFrom
        ? Promise.reject(new Error('Upstream unavailable'))
        : Promise.resolve(stats()),
    );

    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('period-tile-month-failed').textContent).toContain('Didn’t load'),
    );
    // The other four are untouched — including `last_month`, which the old
    // day-of-month discriminator also knocked out.
    expect(screen.getByTestId('today-attempts').textContent).toContain('42');
    expect(screen.queryByTestId('period-tile-last_month-failed')).toBeNull();
  });

  it('names who fixes an empty staffing history, instead of offering a retry that cannot work', async () => {
    // An agent holds no permission that could staff them, so "try again" here
    // would be an instruction to repeat something that cannot succeed.
    mocks.getMyCampaigns.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByTestId('history-empty')).toBeTruthy();
    expect(screen.getByTestId('history-empty').textContent).toContain('Ask your supervisor');
  });

  it('surfaces a failed staffing read with the server’s own sentence', async () => {
    mocks.getMyCampaigns.mockRejectedValue(new Error('Request Failed (req_1)'));
    renderPage();
    expect(await screen.findByTestId('history-error')).toBeTruthy();
    expect(screen.getByTestId('history-error').textContent).toContain('req_1');
  });
});

describe('AgentPerformancePage — the staffing history', () => {
  it('includes ENDED assignments and marks them as such', async () => {
    /**
     * The whole reason this reads `my-campaigns` rather than `my-assignments`:
     * the per-campaign breakdown above will name a campaign the agent was taken
     * off, and without the history that is a row with no explanation.
     */
    mocks.getMyCampaigns.mockResolvedValue([
      staffing(),
      staffing({
        campaign_id: 'camp-2',
        campaign_name: 'Collections',
        campaign_status: 'completed',
        active: false,
        unassigned_at: '2026-08-15T00:00:00.000Z',
      }),
    ]);

    renderPage();

    const ended = await screen.findByTestId('history-row-camp-2');
    expect(within(ended).getByText('No longer assigned')).toBeTruthy();
    expect(within(ended).getByText(/every contact has been dialled/i)).toBeTruthy();
    expect(screen.getByTestId('staffing-summary').textContent).toContain('2 in total');
    expect(screen.getByTestId('staffing-summary').textContent).toContain('1 finished');
  });

  it('renders an unrecognised campaign status verbatim rather than mapping it away', async () => {
    /**
     * `AgencyCampaignStatusBadge` prints an unknown status as-is on purpose —
     * that is what lets master forward core's lifecycle without this client
     * mirroring it. Pinned here so the new surface keeps the property.
     */
    mocks.getMyCampaigns.mockResolvedValue([staffing({ campaign_status: 'quiescing' })]);
    renderPage();
    const row = await screen.findByTestId('history-row-camp-1');
    expect(within(row).getByText(/quiescing/i)).toBeTruthy();
  });

  it('stands in for a null campaign name rather than leaving a hole', async () => {
    // Master resolves the name through a best-effort core call, documented null
    // for a core outage or a deleted campaign.
    mocks.getMyCampaigns.mockResolvedValue([staffing({ campaign_name: null })]);
    renderPage();
    expect(await screen.findByText('Unnamed campaign')).toBeTruthy();
  });
});

describe('AgentPerformancePage — a supervisor', () => {
  it('is SERVED here rather than redirected away', async () => {
    /**
     * `AgentHomePage` sends a supervisor to the campaigns workspace, because a
     * supervisor asking for `/dialer` wants the dialer and not their own empty
     * staffing list. This page does the opposite on purpose: a supervisor who
     * covers shifts has their own calls, and refusing to show somebody their own
     * numbers because of their role would be a strange thing to do.
     */
    mocks.useTenant.mockReturnValue(tenant({ role: 'account_admin' }));

    renderPage();

    expect(await screen.findByTestId('period-tile-today')).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('points them at the surface that answers the OTHER question', async () => {
    // A supervisor who opens "My performance" and finds their own eleven calls
    // would otherwise conclude the dialer has lost their team's numbers.
    mocks.useTenant.mockReturnValue(tenant({ role: 'account_admin' }));
    renderPage();
    const note = await screen.findByTestId('supervisor-note');
    expect(within(note).getByRole('link', { name: /analytics/i }).getAttribute('href')).toBe(
      '/agency/analytics',
    );
  });

  it('reads its own numbers through the my- route, never the supervisor twin', async () => {
    // The `my-` routes take no subject: master scopes them to the caller. A page
    // that reached for the twin here would be naming the subject of its own
    // stats read.
    mocks.useTenant.mockReturnValue(tenant({ role: 'account_admin' }));
    renderPage();
    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalled());
    expect(mocks.getAgentStats).not.toHaveBeenCalled();
  });

  it('shows no supervisor note to an agent', async () => {
    renderPage();
    await screen.findByTestId('period-tile-today');
    expect(screen.queryByTestId('supervisor-note')).toBeNull();
  });
});

describe('AgentPerformancePage — the staffing counters', () => {
  /**
   * `staffingSummary` computed `waiting` and the summary line dropped it, which
   * left "how many of my campaigns are paused" answerable only by reading every
   * badge in the list. The count is the point of a summary line.
   */
  it('reports waiting beside current and finished', async () => {
    mocks.getMyCampaigns.mockResolvedValue([
      staffing({ campaign_id: 'camp-1', campaign_name: 'Renewals', campaign_status: 'running' }),
      staffing({ campaign_id: 'camp-2', campaign_name: 'Winback', campaign_status: 'paused' }),
      staffing({ campaign_id: 'camp-3', campaign_name: 'Q2 push', campaign_status: 'stopped', active: false }),
    ]);

    renderPage();

    const summary = await screen.findByTestId('staffing-summary');
    expect(summary.textContent).toContain('3 in total');
    expect(summary.textContent).toContain('1 waiting');
    expect(summary.textContent).toContain('1 finished');
  });

  it('counts draft and stopping as waiting, and completed as finished', async () => {
    mocks.getMyCampaigns.mockResolvedValue([
      staffing({ campaign_id: 'camp-1', campaign_status: 'draft' }),
      staffing({ campaign_id: 'camp-2', campaign_status: 'stopping' }),
      staffing({ campaign_id: 'camp-3', campaign_status: 'completed', active: false }),
    ]);

    renderPage();

    const summary = await screen.findByTestId('staffing-summary');
    expect(summary.textContent).toContain('2 waiting');
    expect(summary.textContent).toContain('1 finished');
  });

  it('says None yet rather than four zeroes for an agent never staffed', async () => {
    mocks.getMyCampaigns.mockResolvedValue([]);
    renderPage();
    const summary = await screen.findByTestId('staffing-summary');
    expect(summary.textContent).toBe('None yet');
    // And no assignment line either: there is nothing for "of them" to refer to.
    expect(screen.queryByTestId('staffing-active')).toBeNull();
  });

  it('counts a campaign worked twice as one campaign', async () => {
    /**
     * A staffing history repeats campaigns by construction — master's own
     * docstring: staffed in March, unstaffed in April, staffed again in June is
     * three rows and one campaign. Printing the row count under a heading reading
     * "Campaigns you've worked" told the agent a number about master's table
     * rather than about their working life, and it was worst for the people with
     * the longest one.
     */
    mocks.getMyCampaigns.mockResolvedValue([
      staffing({
        campaign_id: 'camp-1',
        campaign_name: 'Renewals',
        assigned_at: '2026-03-01T00:00:00.000Z',
        unassigned_at: '2026-04-01T00:00:00.000Z',
        active: false,
      }),
      staffing({
        campaign_id: 'camp-1',
        campaign_name: 'Renewals',
        assigned_at: '2026-06-01T00:00:00.000Z',
      }),
    ]);

    renderPage();

    const summary = await screen.findByTestId('staffing-summary');
    expect(summary.textContent).toContain('1 in total');
    expect(summary.textContent).not.toContain('2 in total');
    /*
      Both stints still show as rows — the history is the point of the section,
      and deduplicating the COUNT must not deduplicate the list. (Asserted by
      test id rather than by the name, which also appears in the campaign-scope
      selector above.)
    */
    expect(screen.getAllByTestId('history-row-camp-1')).toHaveLength(2);
  });

  it('keeps the assignment count out of the campaign chain', async () => {
    /**
     * The chain used to read "N in total · N current · N waiting · N finished",
     * and "current" counts ASSIGNMENT ROWS while the other three count
     * CAMPAIGNS. They overlap: a paused campaign somebody is still staffed on is
     * one of the `waiting` AND one of the `current`, so four numbers in one
     * middot chain invited an addition producing more campaigns than the agent has
     * ever seen.
     */
    mocks.getMyCampaigns.mockResolvedValue([
      staffing({ campaign_id: 'camp-1', campaign_status: 'paused' }),
      staffing({ campaign_id: 'camp-2', campaign_status: 'stopped', active: false }),
    ]);

    renderPage();

    const summary = await screen.findByTestId('staffing-summary');
    expect(summary.textContent).toBe('2 in total · 1 waiting · 1 finished');
    // The other axis, in its own words and its own element.
    expect(screen.getByTestId('staffing-active').textContent)
      .toBe('You’re currently assigned to 1 of them.');
  });

  it('counts live assignment ROWS, not campaigns, on that line', async () => {
    // Two current stints on one campaign is a real thing about the staffing
    // table, and `active` is per row because master's flag is.
    mocks.getMyCampaigns.mockResolvedValue([
      staffing({ campaign_id: 'camp-1', assigned_at: '2026-03-01T00:00:00.000Z' }),
      staffing({ campaign_id: 'camp-1', assigned_at: '2026-06-01T00:00:00.000Z' }),
    ]);

    renderPage();

    expect((await screen.findByTestId('staffing-summary')).textContent).toContain('1 in total');
    expect(screen.getByTestId('staffing-active').textContent)
      .toBe('You’re currently assigned to 2 of them.');
  });
});

describe('AgentPerformancePage — scoping the figures to one campaign', () => {
  /**
   * `by_campaign[]` and `buckets[]` are two foldings of one row set, so the
   * payload answers "which campaigns" and "which days" but never "which days on
   * THIS campaign". Core's stats query takes `campaign_id` and master forwards
   * it, so the cross-tab is asked for by scoping the request — which is what this
   * control does.
   */
  const twoCampaigns = () => [
    staffing({ campaign_id: 'camp-1', campaign_name: 'Renewals' }),
    staffing({ campaign_id: 'camp-2', campaign_name: 'Winback' }),
  ];

  it('offers no selector when there is only one campaign to choose', async () => {
    // One campaign means the record is already that campaign's: a filter whose
    // only setting changes nothing is worse than no filter.
    mocks.getMyCampaigns.mockResolvedValue([staffing()]);
    renderPage();
    await screen.findByTestId('staffing-summary');
    expect(screen.queryByTestId('campaign-scope')).toBeNull();
  });

  it('offers the selector once more than one campaign is nameable', async () => {
    mocks.getMyCampaigns.mockResolvedValue(twoCampaigns());
    renderPage();
    const select = await screen.findByTestId('campaign-scope');
    expect(select.textContent).toContain('All campaigns');
    expect(select.textContent).toContain('Renewals');
    expect(select.textContent).toContain('Winback');
  });

  it('does not offer a campaign it cannot name', async () => {
    /**
     * Picking "Campaign 4f21ab90" from a menu is not a choice anyone makes on
     * purpose. Unnameable ids still appear in the breakdown below, where a
     * shortened id is a label rather than a decision.
     */
    mocks.getMyCampaigns.mockResolvedValue([
      staffing({ campaign_id: 'camp-1', campaign_name: 'Renewals' }),
      staffing({ campaign_id: 'camp-2', campaign_name: 'Winback' }),
      staffing({ campaign_id: 'camp-3', campaign_name: null }),
    ]);

    renderPage();

    const select = await screen.findByTestId('campaign-scope');
    expect(within(select).getAllByRole('option')).toHaveLength(3);
    expect(select.textContent).not.toContain('camp-3');
  });

  it('sends no campaign_id at all until one is chosen', async () => {
    mocks.getMyCampaigns.mockResolvedValue(twoCampaigns());
    renderPage();
    await screen.findByTestId('campaign-scope');

    /*
      The guard, and it is not ceremony: without it this test passed on a page
      that made NO requests whatsoever — a loop over an empty array asserts
      nothing, and "all three periods were suppressed" and "all three were sent
      unscoped" are the same green. The five other loops in these tests already
      count first; this one did not.
    */
    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length));

    // Omitted rather than sent empty: master forwards only the params it finds,
    // and a blank `campaign_id` reaching core is a validation issue about a
    // filter nobody asked for.
    for (const call of mocks.getMyStats.mock.calls) {
      expect(call[0]).not.toHaveProperty('campaign_id');
    }
  });

  it('re-reads EVERY window scoped, not just the selected one', async () => {
    /**
     * The tiles sit side by side. Leaving some cross-campaign while another is
     * scoped would put different questions under one heading.
     */
    mocks.getMyCampaigns.mockResolvedValue(twoCampaigns());
    renderPage();
    const select = await screen.findByTestId('campaign-scope');
    mocks.getMyStats.mockClear();

    fireEvent.change(select, { target: { value: 'camp-2' } });

    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalledTimes(5));
    for (const call of mocks.getMyStats.mock.calls) {
      expect(call[0]).toMatchObject({ campaign_id: 'camp-2', bucket: 'day' });
    }
  });

  it('says what the figures now mean while scoped, and stops saying it when cleared', async () => {
    /**
     * Without the note the three period figures silently become one campaign's,
     * and a reader who comes back to the tab reads a campaign's morning as their
     * whole morning.
     */
    mocks.getMyCampaigns.mockResolvedValue(twoCampaigns());
    renderPage();
    const select = await screen.findByTestId('campaign-scope');
    expect(screen.queryByTestId('campaign-scope-note')).toBeNull();

    fireEvent.change(select, { target: { value: 'camp-1' } });
    expect(await screen.findByTestId('campaign-scope-note')).toBeTruthy();

    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByTestId('campaign-scope-note')).toBeNull());
  });

  it('drops the campaign scope when the workspace changes underneath it', async () => {
    /**
     * The defect. `scope` is a campaign id belonging to ONE tenant and account,
     * and it used to live in plain page state with no reset and no key. After a
     * switch all three periods stayed scoped to a campaign in the tenant the
     * reader had just left, that id was absent from the new options list so the
     * selector could not deselect it, and "Every figure below counts this
     * campaign only" stayed on screen naming nothing.
     *
     * Asserted on the READS rather than on the control, because the wrong request
     * going out is the part that puts a foreign campaign's figures on screen. A
     * reset in an effect would not satisfy this: the effect runs after the render
     * that has already issued three scoped reads.
     */
    mocks.getMyCampaigns.mockResolvedValue(twoCampaigns());
    const { rerender } = renderPage();

    const select = await screen.findByTestId('campaign-scope');
    fireEvent.change(select, { target: { value: 'camp-2' } });
    await waitFor(() => expect(screen.getByTestId('campaign-scope-note')).toBeTruthy());

    // The new workspace has its own campaigns, and `camp-2` is not among them.
    mocks.getMyCampaigns.mockResolvedValue([
      staffing({ campaign_id: 'camp-7', campaign_name: 'Upgrades' }),
      staffing({ campaign_id: 'camp-8', campaign_name: 'Reactivation' }),
    ]);
    mocks.useTenant.mockReturnValue(tenant({ accountId: 'account-2' }));
    mocks.getMyStats.mockClear();
    rerenderPage(rerender);

    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length));
    for (const call of mocks.getMyStats.mock.calls) {
      expect(call[0]).not.toHaveProperty('campaign_id');
    }
    // And nothing is left claiming the figures belong to one campaign.
    await waitFor(() => expect(screen.queryByTestId('campaign-scope-note')).toBeNull());
  });

  it('drops the scope on a TENANT switch too, not only an account one', async () => {
    mocks.getMyCampaigns.mockResolvedValue(twoCampaigns());
    const { rerender } = renderPage();

    fireEvent.change(await screen.findByTestId('campaign-scope'), { target: { value: 'camp-1' } });
    await waitFor(() => expect(screen.getByTestId('campaign-scope-note')).toBeTruthy());

    mocks.useTenant.mockReturnValue(tenant({ tenantId: 'tenant-2' }));
    mocks.getMyStats.mockClear();
    rerenderPage(rerender);

    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length));
    for (const call of mocks.getMyStats.mock.calls) {
      expect(call[0]).not.toHaveProperty('campaign_id');
    }
  });

  it('is reachable by its accessible label, not only by a test id', async () => {
    /**
     * Every case in this describe reaches the `<select>` through
     * `data-testid="campaign-scope"`. Stripping `htmlFor` from its label left all
     * of them passing — and left the control with no accessible name at all, on a
     * page whose primary reader is a dedicated agent with no navigation and no
     * other way to work out what a bare combo box narrows.
     */
    mocks.getMyCampaigns.mockResolvedValue(twoCampaigns());
    renderPage();

    const byLabel = await screen.findByLabelText('Campaign');
    expect(byLabel).toBe(screen.getByTestId('campaign-scope'));

    // And it is still a real control reached that way, not just a named node.
    fireEvent.change(byLabel, { target: { value: 'camp-2' } });
    await waitFor(() => expect(screen.getByTestId('campaign-scope-note')).toBeTruthy());
  });

  it('drops the filter back to every campaign, not to an empty string', async () => {
    mocks.getMyCampaigns.mockResolvedValue(twoCampaigns());
    renderPage();
    const select = await screen.findByTestId('campaign-scope');
    fireEvent.change(select, { target: { value: 'camp-1' } });
    await waitFor(() => expect(screen.getByTestId('campaign-scope-note')).toBeTruthy());
    mocks.getMyStats.mockClear();

    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => expect(mocks.getMyStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length));
    for (const call of mocks.getMyStats.mock.calls) {
      expect(call[0]).not.toHaveProperty('campaign_id');
    }
  });
});
