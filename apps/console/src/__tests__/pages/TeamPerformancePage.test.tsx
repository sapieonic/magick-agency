import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  TEAM_PERFORMANCE_CACHE_TTL_MS,
  type AgencyTeamPerformance,
  type AgencyTeamPerformanceQuery,
} from '@magick-agency/contracts/api/agency/team-performance';
import { ApiError } from '../../api/client';
import { TEAM_ALL_CAMPAIGNS, TEAM_EMPTY, TEAM_ONE_CAMPAIGN, TEAM_AGENT } from '../helpers/teamRecorded';

/**
 * The Team performance page (`docs/team-performance.md` §2), against the recorded answers
 * (`helpers/teamRecorded.ts`): supervisors only, behind its flag; the filters in the URL and the
 * read they ask; the tiles, the charts and the table from the answer; Worth a look only with one
 * campaign (TP7); up to three picks and Compare picked (TP18); the refusals' words and Try again
 * only where it can help; the empty period; the last answer kept while the next loads; Download
 * Excel opening the existing export on the page's dates (TP19).
 */

const CAMPAIGN = TEAM_ONE_CAMPAIGN.campaign_id!;

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  flags: {} as Record<string, boolean>,
  listAgencyCampaigns: vi.fn(),
  listArchivedAgencyCampaigns: vi.fn(),
  getTeamPerformance: vi.fn(),
  /** The midnight timers armed now (`useAtLocalMidnight`, faked below): fired by `midnight()`. */
  midnight: new Set<() => void>(),
}));

vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'sup-1', display_name: 'Anitha N', email: 'a@x' } }) }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true,
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));
vi.mock('../../components/common/CapabilityUnavailable', () => ({
  CapabilityUnavailable: () => <div data-testid="capability-unavailable" />,
}));
vi.mock('../../api/agencyCampaigns', () => ({
  listAgencyCampaigns: mocks.listAgencyCampaigns,
  listArchivedAgencyCampaigns: mocks.listArchivedAgencyCampaigns,
}));
// Local midnight, on demand: each hook adds its callback while it is enabled.
vi.mock('../../hooks/useAtLocalMidnight', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useAtLocalMidnight: (fn: () => void, enabled: boolean) => {
      const latest = useRef(fn);
      latest.current = fn;
      useEffect(() => {
        if (!enabled) return undefined;
        const fire = () => latest.current();
        mocks.midnight.add(fire);
        return () => {
          mocks.midnight.delete(fire);
        };
      }, [enabled]);
    },
  };
});
vi.mock('../../api/teamPerformance', async () => {
  const actual = await vi.importActual<typeof import('../../api/teamPerformance')>('../../api/teamPerformance');
  return { ...actual, getTeamPerformance: mocks.getTeamPerformance };
});

import TeamPerformancePage, { TeamPerformanceView } from '../../pages/agency/TeamPerformancePage';

const NOW = new Date('2026-11-17T08:50:00.000Z');
const ALL_FLAGS = { agency_team_performance_enabled: true, agency_compare_enabled: true, agency_reports_enabled: true };

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

const where = () => screen.getByTestId('where').textContent!;
const params = () => new URLSearchParams(where().split('?')[1] ?? '');

/**
 * The page at `search`, on the clock `now` (`'real'`: the page reads the clock itself, which a
 * test fakes). `at(later)` moves the page's clock, as its own minute check would.
 */
function renderView(search = '', canCompare = true, now: Date | 'real' = NOW) {
  const tree = (at: Date | undefined) => (
    <MemoryRouter initialEntries={[`/agency/team-performance${search}`]}>
      <Where />
      <Routes>
        <Route
          path="/agency/team-performance"
          element={<TeamPerformanceView tenantId="t-1" accountId="a-1" accountName="North" canCompare={canCompare} now={at} settleMs={10} />}
        />
        <Route path="/agency/compare" element={<p>compare page</p>} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(tree(now === 'real' ? undefined : now));
  return { ...view, at: (later: Date) => view.rerender(tree(later)) };
}

/** The day after {@link NOW}, mid-morning. */
const NEXT_DAY = new Date('2026-11-18T08:50:00.000Z');

function tenant(role: string) {
  mocks.useTenant.mockReturnValue({ role, tenantId: 't-1', accountId: 'a-1', accounts: [{ id: 'a-1', name: 'North' }], accountResolution: 'ready' });
}

/** As the real server: the one-campaign answer for a campaign, the all-campaigns one without. */
function answerFor(q: AgencyTeamPerformanceQuery): AgencyTeamPerformance {
  const base = q.campaign_id ? { ...TEAM_ONE_CAMPAIGN, campaign_id: q.campaign_id } : TEAM_ALL_CAMPAIGNS;
  return { ...base, from: q.from, to: q.to, timezone: q.timezone };
}

const lastQuery = (): AgencyTeamPerformanceQuery => mocks.getTeamPerformance.mock.calls.at(-1)![0];
const refusal = (status: number, code: string) => new ApiError(status, { error: 'refused', code, message: 'fallback' });
const rowNames = () => screen.getAllByTestId('team-row').map((r) => within(r).getByRole('rowheader').textContent);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags = { ...ALL_FLAGS };
  tenant('account_admin');
  mocks.listAgencyCampaigns.mockResolvedValue([
    { id: CAMPAIGN, name: 'Nov dues', status: 'running', default_timezone: 'Asia/Kolkata' },
    { id: 'camp-2', name: 'Old batch', status: 'completed' },
  ]);
  mocks.listArchivedAgencyCampaigns.mockResolvedValue([]);
  mocks.getTeamPerformance.mockImplementation(async (q: AgencyTeamPerformanceQuery) => answerFor(q));
});

afterEach(() => {
  vi.useRealTimers();
  mocks.midnight.clear();
});

/** A minute on the page's refresh timer (setInterval faked by the test). */
function aMinute() {
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
}

/** Local midnight: every midnight timer armed now fires. */
const midnight = () =>
  act(() => {
    for (const fire of [...mocks.midnight]) fire();
  });

/** Gives a read that would start the time to (the settle timer is real). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

describe('who sees it', () => {
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/agency/team-performance']}>
        <TeamPerformancePage />
      </MemoryRouter>,
    );
  }

  it('is unavailable with the flag off, and reads nothing', () => {
    mocks.flags = { agency_compare_enabled: true };
    renderPage();
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.getTeamPerformance).not.toHaveBeenCalled();
  });

  it('is for supervisors only (TP3): a viewer, an operator or an agent reads nothing', () => {
    for (const role of ['viewer', 'operator', 'agent']) {
      tenant(role);
      const { unmount } = renderPage();
      expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
      unmount();
    }
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
    expect(mocks.getTeamPerformance).not.toHaveBeenCalled();
  });

  it('opens for a supervisor with the flag on', async () => {
    renderPage();
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalled());
  });
});

describe('the filters', () => {
  it('opens on All campaigns and Today, in the browser’s zone, with no campaign in the read', async () => {
    renderView();
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1));
    expect(lastQuery()).toEqual({ from: '2026-11-17', to: '2026-11-17', timezone: 'UTC' });
    expect(mocks.getTeamPerformance.mock.calls[0]!.slice(1, 3)).toEqual(['t-1', 'a-1']);
    expect((screen.getByTestId('team-campaign') as HTMLSelectElement).value).toBe('');
    expect(screen.getByText('Everything below follows these two filters.')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('team-summary').textContent).toBe('Today, up to 8:45 AM'));
  });

  it('writes the campaign, the window and the sort into the URL, and reads what they say', async () => {
    renderView();
    await screen.findByTestId('team-tiles');
    fireEvent.change(screen.getByTestId('team-campaign'), { target: { value: CAMPAIGN } });
    await waitFor(() => expect(lastQuery()).toEqual({ from: '2026-11-17', to: '2026-11-17', timezone: 'UTC', campaign_id: CAMPAIGN }));
    expect(params().get('campaign')).toBe(CAMPAIGN);
    fireEvent.change(screen.getByTestId('team-when'), { target: { value: 'last_7_days' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ from: '2026-11-11', to: '2026-11-17' }));
    expect(params().get('when')).toBe('7d');
    fireEvent.change(screen.getByTestId('team-campaign'), { target: { value: '' } });
    await waitFor(() => expect(lastQuery().campaign_id).toBeUndefined());
    expect(params().get('campaign')).toBeNull();
  });

  it('asks nothing for a custom window that breaks the reports’ rule, and says why', async () => {
    renderView('?when=custom&from=2026-09-01&to=2026-11-17');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/at most 30 days/);
    await new Promise((r) => setTimeout(r, 40));
    expect(mocks.getTeamPerformance).not.toHaveBeenCalled();
  });
});

describe('the figures', () => {
  it('shows the five tiles from the answer', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    const tiles = await screen.findByTestId('team-tiles');
    const tile = (id: string) => within(tiles).getByTestId(`team-tile-${id}`).textContent;
    expect(tile('calls')).toBe('Calls handled360by 10 agents');
    expect(tile('main')).toBe('Will pay9827% of calls handled');
    expect(tile('avg')).toBe('Average call2:57min:sec of talking');
    expect(tile('choose')).toBe('Time to choose outcome0:19average · 30 s allowed');
    expect(tile('callbacks')).toBe('Call-backs on time21 of 28due so far today');
  });

  it('says the soft-phone and inbound calls in the rate, and allowed time that differs, with All campaigns', async () => {
    renderView();
    const tiles = await screen.findByTestId('team-tiles');
    expect(within(tiles).getByTestId('team-tile-main').textContent).toContain('26% will-pay rate · counts 12 soft-phone and inbound calls');
    expect(within(tiles).getByTestId('team-tile-choose').textContent).toContain('allowed time differs by campaign');
  });

  it('draws the main outcome per working day as an image with words, and its numbers in a table', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    const chart = await screen.findByTestId('team-trend-chart');
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.getAttribute('aria-label')).toBe('Will pay per day over 7 working days, from 74 to 106; 98 on 17 Nov.');
    expect(screen.getByTestId('team-trend-last').textContent).toBe('98');
    expect(within(screen.getByTestId('team-trend-table')).getAllByRole('row')).toHaveLength(8);
    expect(screen.getByText('· whole team, last 7 working days')).toBeTruthy();
  });

  it('lists what happened on the calls, folds past the seventh, and footnotes a main bar that differs from its tile', async () => {
    // The rollup line reads the reader's clock for its day: the answer's.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    renderView(`?campaign=${CAMPAIGN}`);
    const outcomes = await screen.findByTestId('team-outcomes');
    expect(within(outcomes).getByRole('heading').textContent).toBe('What happened on today’s 360 calls');
    expect(within(outcomes).getAllByTestId('team-outcome')[0]!.textContent).toBe('Will pay96');
    expect(within(outcomes).getByText('Bars share one colour on purpose: this compares sizes, not outcome types.')).toBeTruthy();
    expect(within(outcomes).getByTestId('team-outcomes-line').textContent).toMatch(/^Dialler calls only · as of \d{1,2}:\d{2} [AP]M$/);
    // 96 conversations ended in Will pay; the tile counts 98 promises recorded.
    expect(within(outcomes).getByTestId('team-outcomes-footnote').textContent).toMatch(/\(98 vs 96 here\)/);
    fireEvent.change(screen.getByTestId('team-campaign'), { target: { value: '' } });
    await waitFor(() => expect(within(screen.getByTestId('team-outcomes')).getAllByTestId('team-outcome')).toHaveLength(8));
    expect(within(screen.getByTestId('team-outcomes')).getAllByTestId('team-outcome').at(-1)!.textContent).toBe('Other outcomes22');
  });
});

describe('the agents', () => {
  it('lists every row, sorted by the rate, with departed agents marked and thin ones in words', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    const names = rowNames();
    expect(names).toHaveLength(10);
    expect(names[0]).toContain('Lakshmi P');
    expect(names.find((n) => n?.includes('Pooja M'))).toContain('Pooja M (left)');
    const pooja = screen.getAllByTestId('team-row').find((r) => r.textContent!.includes('Pooja M'))!;
    expect(pooja.textContent).toContain('Too few calls (17; needs 20)');
    expect(within(screen.getByTestId('team-agents')).getByRole('columnheader', { name: 'Will pay' })).toBeTruthy();
  });

  it('names each figure after its column, for the phone layout, and leaves an empty Worth a look out of it', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    const heads = within(screen.getByTestId('team-agents')).getAllByRole('columnheader').map((h) => h.textContent);
    for (const row of screen.getAllByTestId('team-row')) {
      const cells = within(row).getAllByRole('cell');
      // Every figure is named as its column is; Worth a look, the last, carries badges or nothing.
      expect(cells.slice(0, -1).map((c) => c.getAttribute('data-label'))).toEqual(heads.slice(1, -1));
      const worth = cells.at(-1)!;
      expect(worth.hasAttribute('data-empty')).toBe(within(worth).queryAllByTestId('team-badge').length === 0);
    }
  });

  it('gives an agent whose name did not resolve the initials of the name shown, and every name a title', async () => {
    const lakshmi = TEAM_AGENT['Lakshmi P']!;
    const shown = `Agent ${lakshmi.slice(0, 8)}`;
    mocks.getTeamPerformance.mockImplementation(async (q: AgencyTeamPerformanceQuery) => {
      const a = answerFor(q);
      return { ...a, agents: a.agents.map((r) => (r.agent_user_id === lakshmi ? { ...r, agent_name: null } : r)) };
    });
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    const head = (name: string) => within(screen.getAllByTestId('team-row').find((r) => r.textContent!.includes(name))!).getByRole('rowheader');
    expect(head(shown).querySelector('[aria-hidden="true"]')!.textContent).toBe('AA');
    expect(within(head(shown)).getByTitle(shown)).toBeTruthy();
    expect(within(head('Swapna K')).getByTitle('Swapna K')).toBeTruthy();
  });

  it('gives the figures before the bars one width per column, its longest, so every bar starts at the same x', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    const table = within(await screen.findByTestId('team-agents')).getByRole('table');
    // The rows' longest: 51 calls, 24 promises, 47% (a "%" counts 2, a digit a little over 1).
    expect(table.style.getPropertyValue('--team-calls-ch')).toBe('2.25ch');
    expect(table.style.getPropertyValue('--team-main-ch')).toBe('2.25ch');
    expect(table.style.getPropertyValue('--team-rate-ch')).toBe('4.25ch');
  });

  it('names the scrolling table apart from its section', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    const section = await screen.findByTestId('team-agents');
    expect(within(section).getByRole('region', { name: 'Agents table' })).toBeTruthy();
    expect(within(section).queryAllByRole('region', { name: /^Agents · / })).toHaveLength(0);
  });

  it.each([
    ['a ResizeObserver reports', true],
    ['the window is resized, without a ResizeObserver', false],
  ])('makes the table a tab stop only while it scrolls sideways, so a phone’s cards get none (measured when %s)', async (_, withObserver) => {
    const size = { scrollWidth: 380, clientWidth: 380 };
    const names = ['scrollWidth', 'clientWidth'] as const;
    const before = names.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of names) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get(this: HTMLElement) {
          return this.getAttribute('aria-label') === 'Agents table' ? size[name] : 0;
        },
      });
    }
    // The box or the table changing size, as a browser's ResizeObserver reports it; or no
    // observer at all, and the window's resize instead.
    const observed = new Set<() => void>();
    vi.stubGlobal(
      'ResizeObserver',
      withObserver
        ? class {
            private readonly fire: () => void;
            constructor(callback: () => void) {
              this.fire = () => callback();
            }
            observe() {
              observed.add(this.fire);
            }
            unobserve() {}
            disconnect() {
              observed.delete(this.fire);
            }
          }
        : undefined,
    );
    try {
      renderView(`?campaign=${CAMPAIGN}`);
      const region = within(await screen.findByTestId('team-agents')).getByRole('region', { name: 'Agents table' });
      expect(region.hasAttribute('tabindex')).toBe(false);
      const resize = () =>
        act(() => {
          if (withObserver) for (const fire of observed) fire();
          else window.dispatchEvent(new Event('resize'));
        });
      // A wide screen: the box scrolls, and the table is wider than it.
      region.style.overflowX = 'auto';
      size.scrollWidth = 1100;
      size.clientWidth = 900;
      resize();
      expect(region.getAttribute('tabindex')).toBe('0');
      size.scrollWidth = 900;
      resize();
      expect(region.hasAttribute('tabindex')).toBe(false);
      // A phone: the cards' box does not scroll, even where a picked card's bleed reaches past it.
      region.style.overflowX = 'visible';
      size.scrollWidth = 336;
      size.clientWidth = 320;
      resize();
      expect(region.hasAttribute('tabindex')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      names.forEach((name, i) => {
        const own = before[i];
        if (own) Object.defineProperty(HTMLElement.prototype, name, own);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      });
    }
  });

  it('sorts with toggle pills, into the URL', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    expect(screen.getByTestId('team-sort-rate').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('team-sort-rate').textContent).toBe('Will-pay rate');
    fireEvent.click(screen.getByTestId('team-sort-shortest'));
    expect(screen.getByTestId('team-sort-shortest').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('team-sort-rate').getAttribute('aria-pressed')).toBe('false');
    expect(params().get('sort')).toBe('shortest');
    expect(rowNames()[0]).toContain('Lakshmi P');
    fireEvent.click(screen.getByTestId('team-sort-calls'));
    expect(rowNames().slice(0, 3).map((n) => n!.replace(/^\d+[A-Z]{2}/, ''))).toEqual(['Lakshmi P', 'Swapna K', 'Arjun T']);
  });

  it('marks who is worth a look with one campaign (TP15)', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    const row = (name: string) => screen.getAllByTestId('team-row').find((r) => r.textContent!.includes(name))!;
    expect(within(row('Lakshmi P')).getAllByTestId('team-badge').map((b) => b.textContent)).toEqual(['Stands out']);
    expect(within(row('Mahesh B')).getAllByTestId('team-badge').map((b) => b.textContent)).toEqual(['Low will-pay rate', 'Slow to choose outcome']);
    expect(within(row('Swapna K')).queryAllByTestId('team-badge')).toHaveLength(0);
    expect(screen.queryByTestId('team-choose-one')).toBeNull();
  });

  it('marks nobody with All campaigns, and says to choose one (TP7)', async () => {
    // Even an answer that carried findings is not drawn when it is not comparable: the rule is the console's too.
    mocks.getTeamPerformance.mockResolvedValue({ ...TEAM_ALL_CAMPAIGNS, findings: TEAM_ONE_CAMPAIGN.findings });
    renderView();
    await screen.findByTestId('team-agents');
    expect(screen.queryAllByTestId('team-badge')).toHaveLength(0);
    const note = screen.getByTestId('team-choose-one');
    expect(note.textContent).toBe('Choose one campaign to see who’s worth a look and to compare agents.');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    const button = screen.getByTestId('team-compare-picked') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The note is the button's description.
    expect(button.getAttribute('aria-describedby')).toBe(note.id);
  });
});

describe('a mixed scope (TP8)', () => {
  it('says once, calmly, that some campaigns record no Will pay when the answer is mixed', async () => {
    renderView();
    await screen.findByTestId('team-agents');
    const note = screen.getByTestId('team-mixed');
    expect(note.textContent).toBe('Some campaigns here don’t record Will pay; their calls still count in the will-pay rate.');
    expect(note.getAttribute('role')).toBeNull();
    expect(screen.getAllByTestId('team-mixed')).toHaveLength(1);
  });

  it('says nothing of it when the answer is not mixed', async () => {
    mocks.getTeamPerformance.mockResolvedValue({ ...TEAM_ALL_CAMPAIGNS, main_outcome: { ...TEAM_ALL_CAMPAIGNS.main_outcome, mixed: false } });
    renderView();
    await screen.findByTestId('team-agents');
    expect(screen.queryByTestId('team-mixed')).toBeNull();
  });

  it('says nothing of it with one campaign, which is never mixed', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    expect(screen.queryByTestId('team-mixed')).toBeNull();
  });
});

describe('picking for Compare agents (TP18)', () => {
  it('picks up to three, says how many to a screen reader, and opens Compare with the campaign, the window and the picks', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    expect(screen.getByTestId('team-picks').textContent).toBe('0 of 3 picked');
    expect(screen.getByTestId('team-picks').getAttribute('aria-live')).toBe('polite');
    expect((screen.getByTestId('team-compare-picked') as HTMLButtonElement).disabled).toBe(true);
    for (const name of ['Lakshmi P', 'Mahesh B', 'Ravi Kumar']) fireEvent.click(screen.getByRole('checkbox', { name: `Pick ${name} to compare` }));
    expect(screen.getByTestId('team-picks').textContent).toBe('3 of 3 picked');
    const fourth = screen.getByRole('checkbox', { name: 'Pick Swapna K to compare' }) as HTMLInputElement;
    expect(fourth.disabled).toBe(true);
    fireEvent.click(fourth);
    expect(screen.getByTestId('team-picks').textContent).toBe('3 of 3 picked');
    fireEvent.click(screen.getByTestId('team-compare-picked'));
    await screen.findByText('compare page');
    const to = new URLSearchParams(where().split('?')[1]);
    expect(where().startsWith('/agency/compare?')).toBe(true);
    expect(to.get('campaign')).toBe(CAMPAIGN);
    expect(to.get('when')).toBe('today');
    expect(to.get('agents')).toBe([TEAM_AGENT['Lakshmi P'], TEAM_AGENT['Mahesh B'], TEAM_AGENT['Ravi Kumar']].join(','));
  });

  it('clears the picks when a filter changes, but not when the sort does', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Lakshmi P to compare' }));
    fireEvent.click(screen.getByTestId('team-sort-calls'));
    expect(screen.getByTestId('team-picks').textContent).toBe('1 of 3 picked');
    fireEvent.change(screen.getByTestId('team-when'), { target: { value: 'this_week' } });
    expect(screen.getByTestId('team-picks').textContent).toBe('0 of 3 picked');
  });

  it('clears the picks when a preset’s dates move with the day, its question changing under the same filters', async () => {
    const view = renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick Lakshmi P to compare' }));
    expect(screen.getByTestId('team-picks').textContent).toBe('1 of 3 picked');
    view.at(NEXT_DAY);
    await waitFor(() => expect(lastQuery()).toMatchObject({ from: '2026-11-18', to: '2026-11-18' }));
    await waitFor(() => expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).every((b) => !b.disabled)).toBe(true));
    expect(screen.getByTestId('team-picks').textContent).toBe('0 of 3 picked');
    expect((screen.getByRole('checkbox', { name: 'Pick Lakshmi P to compare' }) as HTMLInputElement).checked).toBe(false);
  });

  it('disables the picks and Compare picked while the rows on screen are another filter’s', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    mocks.getTeamPerformance.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(screen.getByTestId('team-when'), { target: { value: 'this_week' } });
    await screen.findByTestId('team-updating');
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    fireEvent.click(boxes[0]!);
    expect(screen.getByTestId('team-picks').textContent).toBe('0 of 3 picked');
    expect((screen.getByTestId('team-compare-picked') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the picks disabled when the new filter’s read failed, over the last figures', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-agents');
    mocks.getTeamPerformance.mockRejectedValue(refusal(503, 'team_timed_out'));
    fireEvent.change(screen.getByTestId('team-when'), { target: { value: 'this_week' } });
    const stale = await screen.findByTestId('team-stale');
    expect(stale.textContent).toBe('These are the last figures that loaded, for 17 Nov, not for the filters above.');
    expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).every((b) => b.disabled)).toBe(true);
  });

  it('offers no picking without Compare agents', async () => {
    renderView(`?campaign=${CAMPAIGN}`, false);
    await screen.findByTestId('team-agents');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByTestId('team-compare-picked')).toBeNull();
    fireEvent.change(screen.getByTestId('team-campaign'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByTestId('team-choose-one').textContent).toBe('Choose one campaign to see who’s worth a look.'));
  });
});

describe('the states', () => {
  it('shows skeleton tiles until the first answer', async () => {
    let answer: (a: AgencyTeamPerformance) => void = () => {};
    mocks.getTeamPerformance.mockImplementation(() => new Promise((r) => (answer = r)));
    renderView();
    expect(await screen.findByTestId('team-tiles-skeleton')).toBeTruthy();
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalled());
    act(() => answer(TEAM_ALL_CAMPAIGNS));
    await screen.findByTestId('team-tiles');
    expect(screen.queryByTestId('team-tiles-skeleton')).toBeNull();
  });

  it('keeps the last answer up, marked Updating…, while a new filter’s read loads', async () => {
    renderView();
    await screen.findByTestId('team-tiles');
    mocks.getTeamPerformance.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(screen.getByTestId('team-campaign'), { target: { value: CAMPAIGN } });
    expect(await screen.findByTestId('team-updating')).toBeTruthy();
    expect(screen.getByTestId('team-tiles')).toBeTruthy();
  });

  it('says there were no calls, and offers the last 7 days', async () => {
    mocks.getTeamPerformance.mockResolvedValue(TEAM_EMPTY);
    renderView();
    expect(await screen.findByText('No calls in this period')).toBeTruthy();
    expect(screen.queryByTestId('team-tiles')).toBeNull();
    // No working days to draw either.
    expect(screen.queryByTestId('team-trend')).toBeNull();
    fireEvent.click(screen.getByTestId('team-try-7-days'));
    expect(params().get('when')).toBe('7d');
  });

  it('still draws the team’s earlier working days on a day nobody has dialled yet (TP12, TP14)', async () => {
    mocks.getTeamPerformance.mockResolvedValue({ ...TEAM_EMPTY, trend: TEAM_ONE_CAMPAIGN.trend });
    renderView();
    expect(await screen.findByText('No calls in this period')).toBeTruthy();
    expect(screen.queryByTestId('team-tiles')).toBeNull();
    expect(screen.queryByTestId('team-agents')).toBeNull();
    expect(screen.getByTestId('team-trend-chart').getAttribute('aria-label')).toBe('Will pay per day over 7 working days, from 74 to 106; 98 on 17 Nov.');
  });

  it('offers the last 7 days on an empty period only when the window is shorter than that', async () => {
    mocks.getTeamPerformance.mockResolvedValue(TEAM_EMPTY);
    for (const [when, offered] of [['week', true], ['7d', false], ['30d', false]] as const) {
      const { unmount } = renderView(`?when=${when}`);
      await screen.findByText('No calls in this period');
      expect(screen.queryByTestId('team-try-7-days') !== null, `when=${when}`).toBe(offered);
      unmount();
    }
  });

  it('names the campaign of stale figures when it is not the one chosen', async () => {
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-tiles');
    await waitFor(() => expect((screen.getByTestId('team-campaign') as HTMLSelectElement).value).toBe(CAMPAIGN));
    mocks.getTeamPerformance.mockRejectedValue(refusal(503, 'team_timed_out'));
    fireEvent.change(screen.getByTestId('team-campaign'), { target: { value: '' } });
    expect((await screen.findByTestId('team-stale')).textContent).toBe(
      'These are the last figures that loaded, for Nov dues, 17 Nov, not for the filters above.',
    );
  });

  it('says how far the figures run from the answer, not the clock: one read after the window ended covers all of it (TP11)', async () => {
    mocks.getTeamPerformance.mockImplementation(async (q: AgencyTeamPerformanceQuery) => ({ ...answerFor(q), as_of: '2026-11-18T00:00:05.000Z' }));
    // The page's clock still says 17 Nov; the server's answer was read on the 18th.
    renderView(`?campaign=${CAMPAIGN}&when=custom&from=2026-11-15&to=2026-11-17`);
    const tiles = await screen.findByTestId('team-tiles');
    await waitFor(() => expect(screen.getByTestId('team-summary').textContent).toBe('15 Nov to 17 Nov'));
    expect(within(tiles).getByTestId('team-tile-callbacks').textContent).toBe('Call-backs on time21 of 28due in this period');
  });

  it('says “due so far” for a longer window still running, and “due so far today” for one day', async () => {
    const { unmount } = renderView(`?campaign=${CAMPAIGN}&when=custom&from=2026-11-15&to=2026-11-17`);
    expect(within(await screen.findByTestId('team-tiles')).getByTestId('team-tile-callbacks').textContent).toBe('Call-backs on time21 of 28due so far');
    unmount();
    renderView(`?campaign=${CAMPAIGN}`);
    expect(within(await screen.findByTestId('team-tiles')).getByTestId('team-tile-callbacks').textContent).toBe('Call-backs on time21 of 28due so far today');
  });

  it('words a timed-out read and offers Try again, which reads again', async () => {
    mocks.getTeamPerformance.mockRejectedValueOnce(refusal(503, 'team_timed_out'));
    renderView();
    const error = await screen.findByTestId('team-error');
    expect(error.textContent).toContain('Too much to read at once. Try a shorter period.');
    fireEvent.click(within(error).getByTestId('team-retry'));
    await screen.findByTestId('team-tiles');
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('team-error')).toBeNull();
  });

  it('offers no Try again for a refusal that asking again would only repeat', async () => {
    mocks.getTeamPerformance.mockRejectedValue(refusal(404, 'team_campaign_not_found'));
    renderView(`?campaign=${CAMPAIGN}`);
    const error = await screen.findByTestId('team-error');
    expect(error.textContent).toContain('That campaign isn’t one of this account’s.');
    expect(within(error).queryByTestId('team-retry')).toBeNull();
  });

  it('reads a window that holds today again every minute, and a past one never', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { unmount } = renderView();
    await screen.findByTestId('team-tiles');
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2));
    // A quiet refresh: the same question, so no "Updating…".
    expect(screen.queryByTestId('team-updating')).toBeNull();
    unmount();
    mocks.getTeamPerformance.mockClear();
    renderView('?when=custom&from=2026-11-01&to=2026-11-07');
    await screen.findByTestId('team-tiles');
    act(() => {
      vi.advanceTimersByTime(180_000);
    });
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1);
  });
});

describe('reading again on its own (§2 States)', () => {
  it('reads Last 7 days and This week again, but never Last 30 days, a month-long read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    for (const [when, again] of [['7d', true], ['week', true], ['30d', false]] as const) {
      mocks.getTeamPerformance.mockClear();
      const { unmount } = renderView(`?when=${when}`);
      await screen.findByTestId('team-tiles');
      expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1);
      aMinute();
      fireEvent.focus(window);
      await settle();
      expect(mocks.getTeamPerformance.mock.calls.length > 1, `when=${when}`).toBe(again);
      unmount();
    }
  });

  it('does not read again on return while the answer is younger than the server’s cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // As the server: the figures run to the moment they were read.
    mocks.getTeamPerformance.mockImplementation(async (q: AgencyTeamPerformanceQuery) => ({ ...answerFor(q), as_of: new Date().toISOString() }));
    renderView();
    await screen.findByTestId('team-tiles');
    vi.setSystemTime(NOW.getTime() + TEAM_PERFORMANCE_CACHE_TTL_MS - 1_000);
    fireEvent.focus(window);
    await settle();
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW.getTime() + TEAM_PERFORMANCE_CACHE_TTL_MS);
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2));
  });

  it('does not ask again, on the timer or on return, after a refusal that would only repeat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mocks.getTeamPerformance.mockRejectedValue(refusal(404, 'team_campaign_not_found'));
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-error');
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1);
    aMinute();
    aMinute();
    fireEvent.focus(window);
    await settle();
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1);
  });

  it('stops after a timeout until the reader presses Try again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mocks.getTeamPerformance.mockRejectedValueOnce(refusal(503, 'team_timed_out'));
    renderView();
    const error = await screen.findByTestId('team-error');
    aMinute();
    fireEvent.focus(window);
    await settle();
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1);
    fireEvent.click(within(error).getByTestId('team-retry'));
    await screen.findByTestId('team-tiles');
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2);
    // Answered again: the minute's refresh resumes.
    aMinute();
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(3));
  });

  it('keeps the figures up after a failed quiet refresh, says so calmly, and tries again next minute', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-tiles');
    mocks.getTeamPerformance.mockRejectedValueOnce(refusal(429, 'team_busy'));
    aMinute();
    const line = await screen.findByTestId('team-refresh-failed');
    expect(line.textContent).toBe('Couldn’t refresh. Showing figures up to 8:45 AM.');
    expect(line.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('team-error')).toBeNull();
    expect(screen.queryByTestId('team-stale')).toBeNull();
    expect(screen.getByTestId('team-tiles')).toBeTruthy();
    expect(within(line).queryByTestId('team-retry')).toBeNull();
    aMinute();
    await waitFor(() => expect(screen.queryByTestId('team-refresh-failed')).toBeNull());
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(3);
  });

  it('holds the calm line while the next minute’s read is on its way, so it does not blink', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-tiles');
    mocks.getTeamPerformance.mockRejectedValueOnce(refusal(429, 'team_busy'));
    aMinute();
    await screen.findByTestId('team-refresh-failed');
    mocks.getTeamPerformance.mockImplementation(() => new Promise(() => {}));
    aMinute();
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(3));
    await settle();
    expect(screen.getByTestId('team-refresh-failed').textContent).toBe('Couldn’t refresh. Showing figures up to 8:45 AM.');
  });

  it('holds a failed first read’s words while it is asked again, with no skeleton in their place', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mocks.getTeamPerformance.mockRejectedValueOnce(refusal(429, 'team_busy'));
    renderView();
    await screen.findByTestId('team-error');
    mocks.getTeamPerformance.mockImplementation(() => new Promise(() => {}));
    aMinute();
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2));
    await settle();
    expect(screen.getByTestId('team-error').textContent).toContain('Too many reports are being worked out right now.');
    expect(screen.queryByTestId('team-tiles-skeleton')).toBeNull();
  });

  it('after a quiet refresh times out, keeps the figures and offers Try again, as nothing else will read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderView();
    await screen.findByTestId('team-tiles');
    mocks.getTeamPerformance.mockRejectedValueOnce(refusal(503, 'team_timed_out'));
    aMinute();
    const line = await screen.findByTestId('team-refresh-failed');
    expect(screen.queryByRole('alert')).toBeNull();
    aMinute();
    await settle();
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2);
    fireEvent.click(within(line).getByTestId('team-retry'));
    await waitFor(() => expect(screen.queryByTestId('team-refresh-failed')).toBeNull());
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(3);
  });

  it('past midnight reads a custom window once more, its last day whole; a preset reads its new day instead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // As the server: the figures run to the moment they were read.
    mocks.getTeamPerformance.mockImplementation(async (q: AgencyTeamPerformanceQuery) => ({ ...answerFor(q), as_of: new Date().toISOString() }));
    const preset = renderView('', true, 'real');
    await screen.findByTestId('team-tiles');
    vi.setSystemTime(new Date('2026-11-18T00:00:30.000Z'));
    midnight();
    await waitFor(() => expect(lastQuery()).toMatchObject({ from: '2026-11-18', to: '2026-11-18' }));
    await settle();
    // One read of the new day, none of the old day again.
    expect(mocks.getTeamPerformance.mock.calls.map(([q]) => q.from)).toEqual(['2026-11-17', '2026-11-18']);
    preset.unmount();

    mocks.getTeamPerformance.mockClear();
    vi.setSystemTime(NOW);
    renderView('?when=custom&from=2026-11-15&to=2026-11-17', true, 'real');
    await screen.findByTestId('team-tiles');
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-18T00:00:30.000Z'));
    midnight();
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('team-summary').textContent).toBe('15 Nov to 17 Nov'));
    await settle();
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2);
  });

  it('offers Try again when the read after a window’s last day fails, as nothing else will read it', async () => {
    const view = renderView('?when=custom&from=2026-11-15&to=2026-11-17');
    await screen.findByTestId('team-tiles');
    mocks.getTeamPerformance.mockRejectedValueOnce(refusal(429, 'team_busy'));
    view.at(NEXT_DAY);
    const line = await screen.findByTestId('team-refresh-failed');
    expect(line.textContent).toContain('Couldn’t refresh. Showing figures up to 8:45 AM.');
    fireEvent.click(within(line).getByTestId('team-retry'));
    await waitFor(() => expect(screen.queryByTestId('team-refresh-failed')).toBeNull());
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(3);
  });

  it('reads a custom window once more however the page learns the day has turned, and only once', async () => {
    let answer: (a: AgencyTeamPerformance) => void = () => {};
    const view = renderView('?when=custom&from=2026-11-15&to=2026-11-17');
    await screen.findByTestId('team-tiles');
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(1);
    mocks.getTeamPerformance.mockImplementation(() => new Promise((r) => (answer = r)));
    // The page's clock moves (its minute check, a return to the tab), no midnight timer.
    view.at(NEXT_DAY);
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2));
    // While it reads, the figures on screen still say how far they ran.
    expect(screen.getByTestId('team-summary').textContent).toBe('15 Nov to 17 Nov, up to 8:45 AM');
    // An answer that still ran to then (the server's 30 s cache) is not read again and again.
    act(() => answer(answerFor(lastQuery())));
    await settle();
    view.at(new Date('2026-11-18T09:50:00.000Z'));
    await settle();
    expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(2);
    // Nor once more when the reader comes back to it from another campaign.
    mocks.getTeamPerformance.mockImplementation(async (q: AgencyTeamPerformanceQuery) => answerFor(q));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Nov dues' })).toBeTruthy());
    fireEvent.change(screen.getByTestId('team-campaign'), { target: { value: CAMPAIGN } });
    // That campaign's own read, and its one read more.
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(4));
    fireEvent.change(screen.getByTestId('team-campaign'), { target: { value: '' } });
    await waitFor(() => expect(mocks.getTeamPerformance).toHaveBeenCalledTimes(5));
    await settle();
    await settle();
    expect(mocks.getTeamPerformance.mock.calls.map(([q]) => q.campaign_id ?? 'all')).toEqual(['all', 'all', CAMPAIGN, CAMPAIGN, 'all']);
  });
});

describe('Download Excel (TP19)', () => {
  it('opens on the dialog’s today at the latest, when the campaign’s day is behind the browser’s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // 08:50 UTC on 17 Nov is 22:50 on 16 Nov in Honolulu: the page's today is the campaign's tomorrow.
    mocks.listAgencyCampaigns.mockResolvedValue([{ id: CAMPAIGN, name: 'Nov dues', status: 'running', default_timezone: 'Pacific/Honolulu' }]);
    renderView(`?campaign=${CAMPAIGN}`);
    await screen.findByTestId('team-tiles');
    await waitFor(() => expect((screen.getByTestId('team-campaign') as HTMLSelectElement).value).toBe(CAMPAIGN));
    fireEvent.click(await screen.findByTestId('report-entry-team_performance'));
    const dialog = await screen.findByRole('dialog');
    const to = within(dialog).getByLabelText('To') as HTMLInputElement;
    expect(to.max).toBe('2026-11-16');
    expect(to.value).toBe('2026-11-16');
    expect((within(dialog).getByLabelText('From') as HTMLInputElement).value).toBe('2026-11-16');
  });

  it('chooses only the workbook even when the page’s window cannot be read', async () => {
    renderView('?when=custom&from=2026-09-01&to=2026-11-17');
    fireEvent.click(await screen.findByTestId('report-entry-team_performance'));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Excel') as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText('PDF') as HTMLInputElement).checked).toBe(false);
    // No dates to carry over: the dialog's default window.
    expect((within(dialog).getByLabelText('Custom') as HTMLInputElement).checked).toBe(false);
  });

  it('opens the campaign report on the page’s dates with only the workbook chosen', async () => {
    renderView(`?campaign=${CAMPAIGN}&when=7d`);
    await screen.findByTestId('team-tiles');
    const button = await screen.findByTestId('report-entry-team_performance');
    expect(button.textContent).toBe('Download Excel');
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Export campaign report')).toBeTruthy();
    expect((within(dialog).getByLabelText('Custom') as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText('From') as HTMLInputElement).value).toBe('2026-11-11');
    expect((within(dialog).getByLabelText('To') as HTMLInputElement).value).toBe('2026-11-17');
    expect((within(dialog).getByLabelText('Excel') as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText('PDF') as HTMLInputElement).checked).toBe(false);
  });

  it('opens the account report with All campaigns', async () => {
    renderView();
    await screen.findByTestId('team-tiles');
    fireEvent.click(await screen.findByTestId('report-entry-team_performance'));
    expect(within(await screen.findByRole('dialog')).getByText('Export account report')).toBeTruthy();
  });

  it('is not offered with reports off', async () => {
    mocks.flags = { agency_team_performance_enabled: true, agency_compare_enabled: true };
    renderView();
    await screen.findByTestId('team-tiles');
    expect(screen.queryByTestId('report-entry-team_performance')).toBeNull();
  });
});
