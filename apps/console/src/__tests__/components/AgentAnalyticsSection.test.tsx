import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { hollowRow, rosterBenchmark, rosterPage, rosterRow, thinRow } from '../helpers/roster';
import { campaignTotalRow, contributionPage } from '../helpers/contribution';
import { bestHoursPage } from '../helpers/bestHours';
import { periodRange } from '../../utils/agencyAgentPerformance';

/**
 * The supervisor's per-agent section — now the floor first, one person second.
 *
 * ── What this file used to pin, and what replaced it ──────────────────────
 * The section opened with a `<select>` of colleagues, and this file's cases were
 * about that control: nothing fetched until somebody was picked, every role
 * offered, the picker named. The control is gone — it answered "show me Ravi" when
 * the question a supervisor arrives with is "who should I be asking about", and it
 * showed one person's rate with nothing to read it against — so the cases now pin
 * the roster instead. **Three properties survived the change unaltered** and are
 * still here, because they were never about the picker:
 *
 *  1. **The gate is `agency.supervise`, and it sits OUTSIDE the panel.** The server
 *     floors the roster read and both per-agent twins on exactly that permission —
 *     a looser check renders a surface whose first read 403s, a tighter one hides
 *     it from an `account_admin`, who is the role it floors at. It has to be a
 *     separate component because hooks cannot be called conditionally: a check
 *     *inside* would fire the roster read for every `viewer`, `operator` and
 *     `agent` who opened the page.
 *  2. **The account-resolution guard.** Every read waits for both ids, so a
 *     settled resolution with no account is a terminal state, not a slow one.
 *  3. **The drill-down reads the SUPERVISOR twins, and only the twins.** Reaching
 *     for either `my-` form would show the supervisor their OWN shift under
 *     somebody else's name.
 *
 * ── And one property that is new and load-bearing ─────────────────────────
 * **The drill-down is the EXISTING shared panel, not a second renderer.** That is
 * asserted the only way a test can assert it — the drill-down issues
 * `getAgentStats` for all three periods and `getAgentAttempts`, exactly as the
 * dropdown used to — because a forked panel would still render numbers and would
 * differ from the agent's own view in wording and rounding, which is the drift the
 * shared component exists to prevent.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAgentStats: vi.fn(),
  getMyStats: vi.fn(),
  getMyCampaigns: vi.fn(),
  getAgentAttempts: vi.fn(),
  getMyAttempts: vi.fn(),
  getAgencyRoster: vi.fn(),
  getAgencyGroupedStats: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
/*
  Mocked at the API boundary, the same seam every other agency test mocks at —
  the server's roster route is being written in parallel and does not exist to call.
  All five reads are listed even though a given case only ever exercises some,
  precisely so "the `my-` form is NOT called" is an assertion rather than a mock
  that happens to be missing.
*/
vi.mock('../../api/agencyStats', () => ({
  getAgentStats: mocks.getAgentStats,
  getMyStats: mocks.getMyStats,
  getMyCampaigns: mocks.getMyCampaigns,
  getAgentAttempts: mocks.getAgentAttempts,
  getMyAttempts: mocks.getMyAttempts,
  getAgencyRoster: mocks.getAgencyRoster,
  /*
    The contribution view's read. Listed even though most cases never enter that
    view, because the section imports it transitively — and an export a factory
    omits throws on access rather than returning undefined, so leaving it out
    would make every case here depend on nothing ever reaching it.
  */
  getAgencyGroupedStats: mocks.getAgencyGroupedStats,
}));

import { AgentAnalyticsSection } from '../../components/agency/AgentAnalyticsSection';
import { AGENT_STATS_WINDOWS } from '../../utils/agencyAgentPerformance';

function stats() {
  return {
    agent_user_id: 'user-1',
    bucket: 'day',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-20T12:00:00.000Z',
    totals: {
      attempts: 30,
      connected: 11,
      connect_rate_pct: 36.7,
      successes: 3,
      success_rate_pct: 27.3,
      talk_seconds: 900,
      wrapup_seconds: 120,
      aht_seconds: 82,
      campaigns: 1,
    },
    buckets: [],
    by_campaign: [
      { campaign_id: 'camp-1', attempts: 30, connected: 11, successes: 3, talk_seconds: 900, wrapup_seconds: 120 },
    ],
  };
}

function tenant(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'account_admin',
    accountResolution: 'ready',
    accountError: null,
    reloadAccounts: vi.fn(),
    ...over,
  };
}

/**
 * The campaign LIST, not a name map.
 *
 * The section takes the page's own list now, because choosing which campaign the
 * roster opens on needs each campaign's `status` — a name map cannot say which one
 * is dialing. `running` here, so `defaultRosterCampaign` picks it.
 */
type TestCampaign = { id: string; name: string; status: string };

const ONE_CAMPAIGN: TestCampaign[] = [{ id: 'camp-1', name: 'Renewals', status: 'running' }];
const TWO_CAMPAIGNS: TestCampaign[] = [
  { id: 'camp-1', name: 'Renewals', status: 'running' },
  { id: 'camp-2', name: 'Winback', status: 'paused' },
];

function renderSection(
  canSupervise: boolean,
  campaigns: TestCampaign[] | null = ONE_CAMPAIGN,
) {
  return render(
    <MemoryRouter>
      <AgentAnalyticsSection
        canSupervise={canSupervise}
        campaigns={campaigns as never}
      />
    </MemoryRouter>,
  );
}

/**
 * One attempt row, so `AgentAttemptsPanel` renders its table (and therefore its
 * caption) rather than its empty state — the caption is where the drill-down proves
 * it was given the right person's NAME.
 */
function attempt() {
  return {
    id: 'attempt-1', contact_id: 'c1', campaign_id: 'camp-1', attempt_number: 1,
    phone_e164: '+919876500001', caller_id: '+919000000001',
    agent_user_id: 'user-1', agent_name: 'Ravi Kumar', reserved_agent_id: null,
    state: 'ended', outcome: 'connected', disposition_code: 'sold', notes: null,
    callback_at: null, dispositioned_by_user_id: 'user-1',
    dispositioned_at: '2026-08-20T10:00:00.000Z', dispositioned_on_behalf: false,
    webrtc_call_id: 'call-1', dialed_at: '2026-08-20T09:59:00.000Z',
    answered_at: '2026-08-20T09:59:05.000Z', bridged_at: '2026-08-20T09:59:07.000Z',
    ended_at: '2026-08-20T10:00:00.000Z', talk_seconds: 53, wrapup_seconds: 10,
    created_at: '2026-08-20T09:58:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  /*
    The default mock ECHOES the query back, the way the server does: `sort` and `order`
    are always sent explicitly, so the server never has a default to substitute. A
    fixed payload here would let the table's header disagree with the request in
    every case, which is a fixture artefact rather than a behaviour worth pinning.
  */
  mocks.getAgencyRoster.mockImplementation((query: Record<string, unknown>) =>
    Promise.resolve(
      rosterPage({
        sort: (query.sort as never) ?? 'successes',
        order: (query.order as never) ?? 'desc',
        campaign_id: (query.campaign_id as string | undefined) ?? null,
      }),
    ),
  );
  mocks.getAgentStats.mockResolvedValue(stats());
  mocks.getAgentAttempts.mockResolvedValue({ rows: [], next_cursor: null, limit: 50 });
  mocks.getAgencyGroupedStats.mockImplementation((query: { group_by: readonly string[] }) => {
    /*
      Three cuts of one route now reach this seam, keyed on `group_by` rather than on
      call order: the best-hours map (weekday × hour), the contribution rows
      (agent × campaign) and the campaign's own line (campaign alone). Keyed rather
      than ordered because the contribution view fires its two concurrently.
    */
    if (query.group_by.includes('day_of_week')) return Promise.resolve(bestHoursPage());
    return Promise.resolve(
      query.group_by.includes('agent')
        ? contributionPage()
        : contributionPage({ group_by: ['campaign'], rows: [campaignTotalRow() as never] }),
    );
  });
});

afterEach(() => cleanup());

describe('AgentAnalyticsSection — the permission gate', () => {
  it('renders nothing at all without agency.supervise', () => {
    const { container } = renderSection(false);
    expect(container.firstChild).toBeNull();
  });

  it('issues NO roster request without the permission', () => {
    /**
     * The reason the gate is a separate component rather than an early return
     * inside the panel. With the check inside, `useAgentRoster` would still run —
     * hooks cannot be conditional — and every `viewer`, `operator` and `agent`
     * opening the analytics page would fire a permission-shaped 403 that nothing
     * reads.
     */
    renderSection(false);
    expect(mocks.getAgencyRoster).not.toHaveBeenCalled();
  });

  it('renders the roster for someone who holds it', async () => {
    renderSection(true);
    expect(await screen.findByTestId('roster-table')).toBeTruthy();
  });
});

describe('AgentAnalyticsSection — the account-resolution guard', () => {
  /**
   * The fourth copy of a trap `AgentHomePage`, `RequireFlag` and
   * `AgencyAnalyticsPage` each got wrong first. `useAgentRoster`'s `load` returns
   * early without BOTH a tenant and an account, this section is not behind
   * `AgentSurfaceShell`, and `AgencyAnalyticsPage` renders the tab on ROLE alone —
   * so without a guard a supervisor whose resolution settled without an account got
   * a spinner that could never resolve, because nothing was in flight and nothing
   * would fire again.
   *
   * It matters more on the roster than it did on the picker: the account is a
   * REQUIRED predicate on that route rather than an optional filter, so there is no
   * degraded tenant-wide read to fall back to.
   */
  it.each(['ready', 'degraded', 'error'] as const)(
    'refuses rather than spins when resolution has settled at %s with no account',
    (accountResolution) => {
      /**
       * All three arms, not just `error`. `ready` with a null account is a tenant
       * that genuinely has no accounts, and `degraded` is a narrowed fallback list
       * that came back empty — a check on the STATUS alone catches neither, and they
       * are the two that reach real users.
       */
      mocks.useTenant.mockReturnValue(tenant({ accountResolution, accountId: null }));

      renderSection(true);

      expect(screen.getByText('We couldn’t open your account')).toBeTruthy();
      expect(screen.queryByTestId('roster-table')).toBeNull();
      expect(mocks.getAgencyRoster).not.toHaveBeenCalled();
      expect(mocks.getAgentStats).not.toHaveBeenCalled();
    },
  );

  it('shows a spinner while resolution is still in flight, not a refusal', () => {
    // A refusal shown for one frame is a refusal the user remembers, and this one
    // tells them their access is broken.
    mocks.useTenant.mockReturnValue(tenant({ accountResolution: 'loading', accountId: null }));

    renderSection(true);

    expect(screen.getByTestId('agent-analytics-resolving')).toBeTruthy();
    expect(screen.queryByText('We couldn’t open your account')).toBeNull();
    expect(mocks.getAgencyRoster).not.toHaveBeenCalled();
  });

  it('still refuses when an error arrives WITH an account id', () => {
    // `'error'` means neither account route answered, so the id in hand is a stale
    // local guess rather than something the server confirmed.
    mocks.useTenant.mockReturnValue(
      tenant({ accountResolution: 'error', accountError: 'Request Failed' }),
    );

    renderSection(true);

    expect(screen.getByText('We couldn’t open your account')).toBeTruthy();
    expect(screen.queryByTestId('roster-table')).toBeNull();
  });
});

describe('AgentAnalyticsSection — the roster read', () => {
  it('asks ONE question for the whole floor, not one per agent', async () => {
    /**
     * The whole reason this route exists. Fanning `getAgentStats` out over a member
     * list would be N requests and still could not answer the question, because a
     * rate is unreadable without the cohort and only the server can compute a
     * percentile over agents this client did not fetch.
     */
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [rosterRow(), rosterRow({ agent_user_id: 'user-2', agent_name: 'Meera' })] }),
    );

    renderSection(true);

    await screen.findByTestId('roster-table');
    expect(mocks.getAgencyRoster).toHaveBeenCalledTimes(1);
    // And nothing about any INDIVIDUAL until a row is opened.
    expect(mocks.getAgentStats).not.toHaveBeenCalled();
  });

  it('sends the account and tenant, and no agent id', async () => {
    // `account_id` is a required predicate on this route rather than an optional
    // filter: a tenant-wide roster is a different question and must not be
    // reachable by omitting a parameter.
    renderSection(true);
    await screen.findByTestId('roster-table');

    const [query, tenantId, accountId] = mocks.getAgencyRoster.mock.calls[0]!;
    expect(tenantId).toBe('tenant-1');
    expect(accountId).toBe('account-1');
    expect(query).not.toHaveProperty('agent_user_id');
    expect(query).toMatchObject({ sort: 'successes', order: 'desc' });
  });

  it.each([
    ['loading', 'roster-loading'],
    ['error', 'roster-error'],
    ['empty', 'roster-empty'],
  ] as const)('renders a distinguishable %s state', async (kind, testId) => {
    /**
     * Three screens, not one empty table. "Nobody dialled in this window" is a
     * TRUE, ordinary answer; "we could not ask" is a failure with a retry; "we are
     * still asking" is neither. A caller deriving all three from `rows.length === 0`
     * shows a supervisor an empty floor for a 403.
     */
    if (kind === 'loading') {
      // Never resolves, so the loading arm is the terminal state for this case.
      mocks.getAgencyRoster.mockReturnValue(new Promise(() => {}));
    } else if (kind === 'error') {
      mocks.getAgencyRoster.mockRejectedValue(new Error('Forbidden'));
    } else {
      mocks.getAgencyRoster.mockResolvedValue(rosterPage({ rows: [] }));
    }

    renderSection(true);

    expect(await screen.findByTestId(testId)).toBeTruthy();
    // Whichever one it is, the other two are absent — that is what "distinct" means
    // here, and it is the assertion a shared `rows.length` check would fail.
    for (const other of ['roster-loading', 'roster-error', 'roster-empty']) {
      if (other !== testId) expect(screen.queryByTestId(other)).toBeNull();
    }
  });

  it('offers a retry on a failed read, and re-asks', async () => {
    mocks.getAgencyRoster.mockRejectedValueOnce(new Error('Request Failed'));

    renderSection(true);

    const alert = await screen.findByTestId('roster-error');
    mocks.getAgencyRoster.mockResolvedValue(rosterPage());
    fireEvent.click(within(alert).getByRole('button', { name: /retry|try again/i }));

    await waitFor(() => expect(screen.getByTestId('roster-table')).toBeTruthy());
  });
});

describe('AgentAnalyticsSection — sorting is a refetch', () => {
  /**
   * Not a client-side re-sort, and the difference is correctness rather than taste:
   * `limit` truncates the roster to the top N *of the chosen order*, so re-ranking
   * the rows already in hand would re-order a page that was SELECTED by a different
   * question. On a floor small enough to fit under the limit that would look right,
   * which is how it would ship.
   */
  it('re-reads with the pressed column, descending first', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    mocks.getAgencyRoster.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^Dials/ }));

    await waitFor(() => expect(mocks.getAgencyRoster).toHaveBeenCalledTimes(1));
    expect(mocks.getAgencyRoster.mock.calls[0]![0]).toMatchObject({
      sort: 'attempts',
      order: 'desc',
    });
  });

  it('flips the direction when the same column is pressed again', async () => {
    // Pressing a NEW column starts it in the direction the column obviously means;
    // pressing the current one reverses it. A uniform default would make one of the
    // two take two presses to do the plain thing.
    renderSection(true);
    await screen.findByTestId('roster-table');

    fireEvent.click(screen.getByRole('button', { name: /^Dials/ }));
    await waitFor(() =>
      expect(mocks.getAgencyRoster.mock.calls.at(-1)![0]).toMatchObject({
        sort: 'attempts',
        order: 'desc',
      }),
    );
    await screen.findByTestId('roster-table');

    fireEvent.click(screen.getByRole('button', { name: /^Dials/ }));

    await waitFor(() =>
      expect(mocks.getAgencyRoster.mock.calls.at(-1)![0]).toMatchObject({
        sort: 'attempts',
        order: 'asc',
      }),
    );
  });

  it('starts the agent column ASCENDING — a name column means A–Z', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    mocks.getAgencyRoster.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^Agent/ }));

    await waitFor(() =>
      expect(mocks.getAgencyRoster.mock.calls[0]![0]).toMatchObject({
        sort: 'agent_user_id',
        order: 'asc',
      }),
    );
  });
});

describe('AgentAnalyticsSection — the filters refetch', () => {
  it('narrows to another campaign', async () => {
    renderSection(true, TWO_CAMPAIGNS);
    await screen.findByTestId('roster-table');
    mocks.getAgencyRoster.mockClear();

    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'camp-2' } });

    await waitFor(() =>
      expect(mocks.getAgencyRoster.mock.calls[0]![0]).toMatchObject({ campaign_id: 'camp-2' }),
    );
  });

  it('omits campaign_id entirely rather than sending a blank one', async () => {
    /**
     * The server whitelists this route's params and answers a malformed one with a 400,
     * so an empty `campaign_id` would be a validation error about a filter nobody
     * asked for. Reached by CHOOSING "All campaigns" now, because the roster no
     * longer opens there — see the default-scope cases below.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');
    mocks.getAgencyRoster.mockClear();

    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: '' } });

    await waitFor(() => expect(mocks.getAgencyRoster).toHaveBeenCalledTimes(1));
    expect(mocks.getAgencyRoster.mock.calls[0]![0]).not.toHaveProperty('campaign_id');
  });

  /**
   * ── The clock is PINNED, and two previous versions of this failed for not
   *    pinning it ───────────────────────────────────────────────────────────
   *
   * The original asserted `month.from <= week.from`, reasoning that "a month
   * starts no later than the week inside it". False whenever the 1st is not a
   * Monday: `periodRange` gives `week` a `startOfWeek(now, { weekStartsOn: 1 })`
   * and `month` a `startOfMonth(now)`, so on Tue 2026-09-01 the month began that
   * morning and the week began Mon 2026-08-31.
   *
   * Replacing it with "the range moved" is wrong in the mirror image: when the
   * 1st IS a Monday the two windows share one `from` by design — pinned in
   * `agencyAgentPerformance.test.ts` as "collapses all three when the 1st of a
   * month falls on a Monday" — so the ranges are legitimately equal and the
   * assertion fails on those dates instead.
   *
   * There is no date-independent phrasing of this, because the property being
   * tested is per-date. So the date is fixed and the expected range comes from
   * `periodRange` itself — the contract is "the section asks for the window the
   * supervisor selected", and re-deriving that boundary here would be a second
   * copy of a rule that already has its own tests.
   *
   * `toFake: ['Date']` only: faking timers wholesale would hang `waitFor`.
   */
  it('moves the window', async () => {
    // Tue 15 Sep 2026 — mid-week and mid-month, so week-start (Mon 14th) and
    // month-start (the 1st) are genuinely different instants.
    const now = new Date(2026, 8, 15, 9, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);

    try {
      renderSection(true);
      await screen.findByTestId('roster-table');
      const firstFrom = mocks.getAgencyRoster.mock.calls[0]![0].from as string;
      mocks.getAgencyRoster.mockClear();

      fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'month' } });

      await waitFor(() => expect(mocks.getAgencyRoster).toHaveBeenCalledTimes(1));
      const nextFrom = mocks.getAgencyRoster.mock.calls[0]![0].from as string;

      expect(nextFrom).toBe(periodRange('month', now).from);
      expect(firstFrom).toBe(periodRange('week', now).from);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentAnalyticsSection — honesty about what is not on screen', () => {
  it('names the former members the server dropped, and offers to show them', async () => {
    /**
     * The dialer runtime returns departed agents because it cannot know they departed; the server
     * drops them. Without this sentence that is a silent edit, and a supervisor
     * scanning for somebody who is not there concludes they did not dial.
     */
    mocks.getAgencyRoster.mockResolvedValue(rosterPage({ inactive_omitted: 2 }));

    renderSection(true);

    const note = await screen.findByTestId('roster-inactive');
    expect(note.textContent).toContain('2 former members hidden');
    expect(screen.getByTestId('roster-include-inactive')).toBeTruthy();
  });

  it('says nothing about former members when none were dropped', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    expect(screen.queryByTestId('roster-inactive')).toBeNull();
    expect(screen.queryByTestId('roster-include-inactive')).toBeNull();
  });

  it('re-reads with include_inactive, and keeps the toggle reachable afterwards', async () => {
    /**
     * `inactive_omitted` is 0 by definition once former members are shown, so a
     * toggle rendered only on a non-zero count could be switched on and never off
     * again — the reader would be stuck on a roster they cannot get back out of.
     */
    mocks.getAgencyRoster.mockResolvedValue(rosterPage({ inactive_omitted: 2 }));

    renderSection(true);
    await screen.findByTestId('roster-inactive');
    mocks.getAgencyRoster.mockResolvedValue(rosterPage({ inactive_omitted: 0 }));

    fireEvent.click(screen.getByTestId('roster-include-inactive'));

    await waitFor(() =>
      expect(mocks.getAgencyRoster.mock.calls.at(-1)![0]).toMatchObject({ include_inactive: true }),
    );
    await waitFor(() => expect(screen.queryByTestId('roster-inactive')).toBeNull());
    expect(screen.getByTestId('roster-include-inactive')).toBeTruthy();
  });

  it('says the roster was cut, and by which order — never as a fraction', async () => {
    /**
     * There is deliberately no "showing N of M" here. The server cuts to `limit` and
     * the server then filters the page it was handed, so `rows.length`, `total_agents`
     * and `inactive_omitted` are three related-but-independent facts and no
     * fraction over them is true. A read can legitimately return 1 row with
     * `total_agents: 3` and `inactive_omitted: 1`: "1 of 3" is wrong and "1 of 2"
     * is not derivable, because the server never saw the rows the dialer runtime cut.
     */
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [rosterRow()], total_agents: 137, limit: 100 }),
    );

    renderSection(true);

    const note = await screen.findByTestId('roster-truncated');
    expect(note.textContent).toContain('Showing the top 100');
    // The order is named, because "the rest" only means something relative to the
    // ranking that selected these rows.
    expect(note.textContent).toContain('conversions');
    // And no fraction, anywhere on the surface.
    expect(document.body.textContent).not.toMatch(/\bof 137\b/);
  });

  it('says nothing about truncation when the whole floor is on screen', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    expect(screen.queryByTestId('roster-truncated')).toBeNull();
  });

  it('does not claim truncation when the only missing rows were departed members', async () => {
    /**
     * The guard adds `inactive_omitted` back before comparing. A page of 1 row with
     * `total_agents: 2` and one former member dropped fit comfortably under the
     * limit — nothing was ranked away, and saying so would send a supervisor
     * looking for rows that do not exist.
     */
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [rosterRow()], total_agents: 2, inactive_omitted: 1 }),
    );

    renderSection(true);

    await screen.findByTestId('roster-inactive');
    expect(screen.queryByTestId('roster-truncated')).toBeNull();
  });

  it('reads out the POPULATION that dialled, not the row count', async () => {
    /**
     * `total_agents` and `benchmark.attempts`, off the same object as the
     * percentiles. `rows.length` would make the readout shrink when a former member
     * was dropped or when `limit` cut the page, which reads as the floor itself
     * having changed size.
     */
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [rosterRow()], total_agents: 8 }),
    );

    renderSection(true);

    expect((await screen.findByTestId('roster-count')).textContent).toBe(
      '8 agents dialled · 2,495 dials',
    );
  });

  it('leaves the team row untouched when former members are revealed', async () => {
    /**
     * The server never recomputes `benchmark` or `total_agents`, so both are
     * byte-identical whether or not rows were dropped — and the console must render
     * the pinned row from `benchmark` alone. A team row that MOVED when the reader
     * toggled a row filter would be a different number under the same name, which
     * is precisely what the benchmark's contract forbids.
     *
     * ── The two responses differ in their ROWS on purpose ──────────────────
     * An earlier version of this case served one fixture to both reads, so every
     * derivation agreed trivially and a row-derived team figure would have passed
     * it. Now the revealed page carries a second, very different agent — twice the
     * handled time on a third of the shift — under an IDENTICAL benchmark, which is
     * exactly what the server sends. So the assertion has teeth for the figure that
     * made it necessary: the pooled utilisation the team row shows since the
     * benchmark gained `shift_seconds`, which must come off the benchmark and never
     * off the rows.
     */
    const benchmark = rosterBenchmark();
    mocks.getAgencyRoster.mockImplementation((query: Record<string, unknown>) =>
      Promise.resolve(
        rosterPage({
          benchmark,
          total_agents: 3,
          inactive_omitted: query.include_inactive ? 0 : 2,
          rows: query.include_inactive
            ? [
                rosterRow(),
                rosterRow({
                  agent_user_id: 'user-departed',
                  agent_name: 'Anil Rao',
                  talk_seconds: 16_000,
                  wrapup_seconds: 2_000,
                  shift_seconds: 7_000,
                  break_seconds: 0,
                  occupancy_pct: 91.4,
                }),
              ]
            : [rosterRow()],
        }),
      ),
    );

    renderSection(true);
    const before = (await screen.findByTestId('roster-team-row')).textContent;
    expect(screen.queryByTestId('roster-row-user-departed')).toBeNull();

    fireEvent.click(screen.getByTestId('roster-include-inactive'));

    await waitFor(() =>
      expect(mocks.getAgencyRoster.mock.calls.at(-1)![0]).toMatchObject({ include_inactive: true }),
    );
    // The rows really did change...
    expect(await screen.findByTestId('roster-row-user-departed')).toBeTruthy();
    // ...and every figure on the pinned row did not.
    expect(screen.getByTestId('roster-team-row').textContent).toBe(before);
  });
});

describe('AgentAnalyticsSection — drilling into one person', () => {
  it('opens the EXISTING shared panel for the row that was pressed', async () => {
    /**
     * The drill-down is `AgentPerformancePanel` and `AgentAttemptsPanel`, the same
     * components an agent sees about themselves — which is why the assertion is on
     * the requests those panels make. A forked panel would still render numbers and
     * would drift from the agent's own view in wording, rounding and what counts as
     * absent; a coaching conversation held over two different screens about one
     * shift is worse than no screen at all.
     */
    renderSection(true);
    fireEvent.click(await screen.findByTestId('roster-open-user-1'));

    // All three periods, through the SUPERVISOR twin, for the person on the row.
    await waitFor(() => expect(mocks.getAgentStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length));
    for (const call of mocks.getAgentStats.mock.calls) expect(call[0]).toBe('user-1');
    await waitFor(() => expect(mocks.getAgentAttempts).toHaveBeenCalled());
    expect(mocks.getAgentAttempts.mock.calls[0]?.[0]).toBe('user-1');

    // Never the caller-scoped forms, which would show the supervisor their own
    // shift under somebody else's name.
    expect(mocks.getMyStats).not.toHaveBeenCalled();
    expect(mocks.getMyAttempts).not.toHaveBeenCalled();
  });

  it('replaces the roster rather than stacking under it, and offers a way back', async () => {
    renderSection(true);
    fireEvent.click(await screen.findByTestId('roster-open-user-1'));

    await screen.findByTestId('roster-back');
    expect(screen.queryByTestId('roster-table')).toBeNull();

    fireEvent.click(screen.getByTestId('roster-back'));

    expect(await screen.findByTestId('roster-table')).toBeTruthy();
  });

  it('names the person from the row, in the heading and in the table caption', async () => {
    mocks.getAgentAttempts.mockResolvedValue({ rows: [attempt()], next_cursor: null, limit: 50 });

    renderSection(true);
    fireEvent.click(await screen.findByTestId('roster-open-user-1'));

    // The name the server resolved on the roster payload — no second lookup, and no
    // name this client invented. The caption matters as much as the heading: a
    // screen-reader user arriving at the call table needs to know WHOSE calls these
    // are without going back up for the roster.
    expect(await screen.findByRole('heading', { name: 'Ravi Kumar' })).toBeTruthy();
    expect(await screen.findByText('Calls taken by Ravi Kumar, newest first')).toBeTruthy();
  });

  it('falls back to a marked-as-an-id name when the server could not resolve one', async () => {
    /**
     * `agent_name: null` means unresolvable, not "no name", and the drill-down uses
     * the same `agentDisplayName` fallback the live floor does. A blank caption
     * reads as a rendering bug; "Unknown" is indistinguishable between two people.
     */
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [rosterRow({ agent_user_id: 'ffffeeee-1111', agent_name: null })] }),
    );
    mocks.getAgentAttempts.mockResolvedValue({ rows: [attempt()], next_cursor: null, limit: 50 });

    renderSection(true);
    fireEvent.click(await screen.findByTestId('roster-open-ffffeeee-1111'));

    expect(await screen.findByRole('heading', { name: 'Agent ffffeeee' })).toBeTruthy();
    expect(await screen.findByText('Calls taken by Agent ffffeeee, newest first')).toBeTruthy();
  });

  it('does NOT inherit the roster’s campaign filter into the person’s totals', async () => {
    /**
     * The roster's filter narrows who is ON the list; the panel's scope narrows one
     * person's totals. Inheriting it would mean a supervisor who filtered the roster
     * to FIND somebody then read that person's whole week as though they had worked
     * only that campaign.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'camp-1' } });
    await waitFor(() => expect(screen.getByTestId('roster-table')).toBeTruthy());

    fireEvent.click(screen.getByTestId('roster-open-user-1'));

    await waitFor(() => expect(mocks.getAgentStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length));
    for (const call of mocks.getAgentStats.mock.calls) {
      expect(call[1]).not.toHaveProperty('campaign_id');
    }
  });

  it('still scopes the panel’s own figures when its selector is used', async () => {
    renderSection(true, TWO_CAMPAIGNS);
    fireEvent.click(await screen.findByTestId('roster-open-user-1'));
    const scope = await screen.findByTestId('campaign-scope');
    mocks.getAgentStats.mockClear();

    fireEvent.change(scope, { target: { value: 'camp-2' } });

    await waitFor(() => expect(mocks.getAgentStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length));
    for (const call of mocks.getAgentStats.mock.calls) {
      expect(call[0]).toBe('user-1');
      expect(call[1]).toMatchObject({ campaign_id: 'camp-2' });
    }
  });

  it('forgets the panel scope when a different person is opened', async () => {
    /**
     * The scope lives inside the keyed child, so the `key={agent_user_id}` remount
     * clears it. Carrying it across would scope a new person's figures to a campaign
     * they may never have worked — three tiles of honest zeroes that read as a bad
     * shift.
     */
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [rosterRow(), rosterRow({ agent_user_id: 'user-2', agent_name: 'Meera' })] }),
    );

    renderSection(true, TWO_CAMPAIGNS);
    fireEvent.click(await screen.findByTestId('roster-open-user-1'));
    fireEvent.change(await screen.findByTestId('campaign-scope'), { target: { value: 'camp-2' } });
    await waitFor(() => expect(screen.getByTestId('campaign-scope-note')).toBeTruthy());

    fireEvent.click(screen.getByTestId('roster-back'));
    fireEvent.click(await screen.findByTestId('roster-open-user-2'));

    await waitFor(() => expect(screen.queryByTestId('campaign-scope-note')).toBeNull());
  });

  it('re-seeds the drill-down window from the ROSTER’s every time a person is opened', async () => {
    /**
     * ⚠️ Rewritten. This case used to assert the OPPOSITE — that a tile chosen inside
     * one person's panel stuck when a second person was opened — on the grounds that
     * "this week means the same thing whoever is being looked at". That reasoning is
     * true and it is not the whole picture: the panel's tile and the ROSTER's window
     * are two different controls over the same reader's question, and only one of
     * them is visible at a time.
     *
     * So the sticky tile produced this: rank the week, open Priya, switch her tiles
     * to This month, go back. The roster header still says "This week" and is telling
     * the truth — the table really is a week — but the next row opened showed This
     * month. Two ranges one click apart, sharing a person's name, with nothing on
     * either screen saying they differ, and the discrepancy reading as the console
     * disagreeing with itself about a named colleague's figures.
     *
     * The invariant now is "the panel opens on the window the list was ranked in".
     * A tile moved inside a panel still applies to that panel for as long as it is
     * open, which is what a supervisor reading one person needs; what does not
     * survive is carrying it silently onto a screen that says something else.
     */
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [rosterRow(), rosterRow({ agent_user_id: 'user-2', agent_name: 'Meera' })] }),
    );

    renderSection(true);
    fireEvent.click(await screen.findByTestId('roster-open-user-1'));
    await screen.findByTestId('period-tile-today');
    fireEvent.click(screen.getByRole('tab', { name: /^This month/ }));
    // It does apply while that panel is open — the tile is not inert.
    expect(screen.getByRole('tab', { name: /^This month/ }).getAttribute('aria-selected')).toBe(
      'true',
    );

    fireEvent.click(screen.getByTestId('roster-back'));
    fireEvent.click(await screen.findByTestId('roster-open-user-2'));
    await screen.findByTestId('period-tile-today');

    /*
      Back to the roster's own window, which is the default `week`. Both assertions,
      because "This month is no longer selected" alone would also pass if the panel
      had landed on Today — the state this whole inheritance was introduced to stop.
    */
    expect(screen.getByRole('tab', { name: /^This month/ }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getByRole('tab', { name: /^This week/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});

describe('AgentAnalyticsSection — its controls have accessible names', () => {
  /**
   * Every case above reaches the filters through `getByLabelText` where it can and
   * through a `data-testid` where two controls share a name. A test id is not an
   * accessible name and carries no state: stripping `htmlFor` from these labels
   * would leave the rest of this file passing.
   */
  it('names all three filters', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');

    expect(screen.getByLabelText('Campaign')).toBe(screen.getByTestId('roster-campaign'));
    expect(screen.getByLabelText('Window')).toBe(screen.getByTestId('roster-period'));
    expect(screen.getByLabelText('Sort by')).toBe(screen.getByTestId('roster-sort'));
  });

  it('groups them so a second control called Campaign stays distinguishable', async () => {
    /**
     * The drill-down has its own "Campaign" — one narrows the roster, the other
     * scopes one person's figures. The containing group name is what tells them
     * apart by name rather than by test id, and it is the same reasoning
     * `FiltersCard` records for the attempts spine.
     */
    renderSection(true);
    const group = await screen.findByRole('group', { name: 'Roster filters' });
    expect(within(group).getByLabelText('Campaign')).toBe(screen.getByTestId('roster-campaign'));
  });

  it('drives the sort menu and the column headers from ONE state', async () => {
    /**
     * Two affordances, not two pieces of state — the headers are the better control
     * when they are visible and no control at all once the table scrolls sideways.
     * Pressing one has to move the other, which is what makes them one control
     * rather than two that can disagree.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');
    expect((screen.getByTestId('roster-sort') as HTMLSelectElement).value).toBe('successes');

    fireEvent.click(screen.getByRole('button', { name: /^AHT/ }));
    await screen.findByTestId('roster-table');

    expect((screen.getByTestId('roster-sort') as HTMLSelectElement).value).toBe('aht_seconds');
    expect(screen.getByRole('columnheader', { name: /^AHT/ }).getAttribute('aria-sort')).toBe(
      'descending',
    );
  });

  it('sorts from the menu too, and moves the header with it', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');

    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'occupancy_pct' } });
    await screen.findByTestId('roster-table');

    await waitFor(() =>
      expect(mocks.getAgencyRoster.mock.calls.at(-1)![0]).toMatchObject({
        sort: 'occupancy_pct',
        order: 'desc',
      }),
    );
    expect(
      screen.getByRole('columnheader', { name: /^Utilisation/ }).getAttribute('aria-sort'),
    ).toBe('descending');
  });

  it('still refuses to rate a thin row when it is the only row', async () => {
    // Reached through the section rather than the table directly, so the guarantee
    // is end-to-end: a supervisor cannot see a rate the server told us not to serve
    // as one, however the payload arrived.
    mocks.getAgencyRoster.mockResolvedValue(rosterPage({ rows: [thinRow()] }));

    renderSection(true);

    const row = await screen.findByTestId('roster-row-user-thin');
    expect(within(row).getAllByText('Not enough calls').length).toBeGreaterThan(0);
    expect(row.textContent).not.toContain('27.3%');
    expect(row.textContent).not.toContain('100%');
  });
});

describe('AgentAnalyticsSection — ONE campaign by default', () => {
  /**
   * The most consequential fix in this pass. The roster opened with
   * `campaignId: null`; the server applies no campaign predicate when the parameter is
   * absent and the server forwards without defaulting, so the DEFAULT screen pooled
   * every campaign in the account into one cohort — and the median, the middle-half
   * band and the per-row chips were all computed against that pool. A telecaller
   * agency runs several dealerships at once, each with its own lead list, so
   * "their conversion rate is below the bottom quarter of the team" was printed
   * beside a named person on the strength of a comparison across lists.
   */
  it('opens on the most recently active campaign, from the list the page already holds', async () => {
    renderSection(true, TWO_CAMPAIGNS);
    await screen.findByTestId('roster-table');

    // `camp-1` is `running`, `camp-2` is `paused`. No extra request: the list is a
    // prop.
    expect(mocks.getAgencyRoster).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyRoster.mock.calls[0]![0]).toMatchObject({ campaign_id: 'camp-1' });
    expect((screen.getByTestId('roster-campaign') as HTMLSelectElement).value).toBe('camp-1');
  });

  it('asks nothing at all until the campaign list has answered', async () => {
    /**
     * `null` is "not answered yet". Firing with `null` first would spend a request on
     * the pooled view and show its warning for a frame before replacing it — so the
     * read is held rather than defaulted twice.
     */
    renderSection(true, null);

    expect(screen.getByTestId('roster-loading')).toBeTruthy();
    expect(mocks.getAgencyRoster).not.toHaveBeenCalled();
  });

  it('falls back to every campaign when the account has none, and says so', async () => {
    // Nothing to scope to. The roster is empty either way, and the view reports
    // itself rather than pretending to a scope.
    mocks.getAgencyRoster.mockImplementation(() => Promise.resolve(rosterPage({ campaign_id: null })));

    renderSection(true, []);

    await screen.findByTestId('roster-table');
    expect(mocks.getAgencyRoster.mock.calls[0]![0]).not.toHaveProperty('campaign_id');
    expect(screen.getByTestId('roster-mixed-cohort')).toBeTruthy();
  });

  it('states that the pooled median mixes lead lists, above the table', async () => {
    // Above, not below: the three notes below the table are about what is NOT on
    // screen, which is a question the reader has after scanning. A caveat met after
    // the number it qualifies has been read is not a caveat.
    renderSection(true);
    await screen.findByTestId('roster-table');
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: '' } });

    const note = await screen.findByTestId('roster-mixed-cohort');
    expect(note.textContent).toContain('mixes lead lists');
    expect(note.textContent).toContain('not a like-for-like comparison');
  });

  it('suppresses the band chips on the pooled read and keeps the thin one', async () => {
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({
        campaign_id: null,
        rows: [rosterRow({ success_rate_pct: 4 }), thinRow()],
      }),
    );

    renderSection(true);

    await screen.findByTestId('roster-table');
    expect(screen.queryByTestId('roster-flag-user-1')).toBeNull();
    // Volume is not a comparison, so it survives the pooling.
    expect(screen.getByTestId('roster-flag-user-thin').textContent).toBe('Too few to rate');
  });

  it('says nothing about mixed lead lists once one campaign is in scope', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    expect(screen.queryByTestId('roster-mixed-cohort')).toBeNull();
  });

  it('keeps an explicit "All campaigns" choice rather than snapping back', async () => {
    // The default is applied once. A later campaign-list render must not drag the
    // reader back to one campaign.
    renderSection(true, TWO_CAMPAIGNS);
    await screen.findByTestId('roster-table');

    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: '' } });

    await screen.findByTestId('roster-mixed-cohort');
    expect((screen.getByTestId('roster-campaign') as HTMLSelectElement).value).toBe('');
  });

  it('does NOT let a failed campaign read latch the pooled view', async () => {
    /**
     * ⚠️ The page synthesises `[]` for this prop when the campaign list read FAILED
     * (`campaigns ?? (error !== null ? [] : null)`), so that this section falls back
     * to "every campaign" instead of spinning forever on a `null` nothing will clear.
     * The default was applied ONCE, on a ref — so it latched on that synthetic empty,
     * and after a successful Retry, with a real campaign list now in hand, the roster
     * stayed pooled. The median, the band and every per-row chip then computed across
     * different dealerships' lead lists: the exact comparison this default exists to
     * prevent, chosen by a transient network error rather than by the reader, on the
     * screen a supervisor acts on.
     *
     * `[]` → a real list is precisely the Retry sequence, so it is the sequence
     * asserted.
     */
    const { rerender } = render(
      <MemoryRouter>
        <AgentAnalyticsSection canSupervise campaigns={[] as never} />
      </MemoryRouter>,
    );
    await screen.findByTestId('roster-table');
    // Pooled while there is nothing to scope to, which is the fallback working.
    expect(mocks.getAgencyRoster.mock.calls[0]![0]).not.toHaveProperty('campaign_id');
    expect(screen.getByTestId('roster-mixed-cohort')).toBeTruthy();

    rerender(
      <MemoryRouter>
        <AgentAnalyticsSection canSupervise campaigns={TWO_CAMPAIGNS as never} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect((screen.getByTestId('roster-campaign') as HTMLSelectElement).value).toBe('camp-1'),
    );
    expect(
      mocks.getAgencyRoster.mock.calls[mocks.getAgencyRoster.mock.calls.length - 1]![0],
    ).toMatchObject({ campaign_id: 'camp-1' });
    await waitFor(() => expect(screen.queryByTestId('roster-mixed-cohort')).toBeNull());
  });

  it('issues ONE read across repeated renders with a fresh empty list', async () => {
    /**
     * The page passes a FRESH `[]` literal on every one of its own renders while the
     * campaign read is failed, and the default effect keys on that prop — so with the
     * ref no longer latching on an empty list, the effect now re-runs on each of
     * those renders. What must not follow is a second roster read: the scope did not
     * change, and a refetch per parent render would be a request storm on the path a
     * failure already put the reader on.
     *
     * ⚠️ Stated plainly, because the alternative would be a vacuous test: this does
     * NOT prove the `prev`-returning bail-out in `setFilters`. That line is defensive
     * — `setFilters` re-renders only this component, which does not produce a new
     * `campaigns` array, so no loop is reachable today and the case below passes with
     * the line removed. The reachable property is the read count, and that is what is
     * asserted.
     */
    const view = render(
      <MemoryRouter>
        <AgentAnalyticsSection canSupervise campaigns={[] as never} />
      </MemoryRouter>,
    );
    await screen.findByTestId('roster-table');
    const after = mocks.getAgencyRoster.mock.calls.length;

    for (let i = 0; i < 3; i += 1) {
      view.rerender(
        <MemoryRouter>
          <AgentAnalyticsSection canSupervise campaigns={[] as never} />
        </MemoryRouter>,
      );
    }
    await screen.findByTestId('roster-table');

    expect(mocks.getAgencyRoster.mock.calls.length).toBe(after);
  });

  it('still honours a reader’s explicit pooled choice once a real list has arrived', async () => {
    // The ref latches on the REAL list, so the "do not snap back" property above is
    // unaffected: the only thing that stopped being remembered is a default derived
    // from an empty list.
    renderSection(true, TWO_CAMPAIGNS);
    await screen.findByTestId('roster-table');
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: '' } });
    await screen.findByTestId('roster-mixed-cohort');

    expect((screen.getByTestId('roster-campaign') as HTMLSelectElement).value).toBe('');
  });
});

describe('AgentAnalyticsSection — a window the weekly review can actually be run against', () => {
  it('offers the two completed windows beside the three to-date ones', async () => {
    /**
     * At Monday 09:30 "this week" is ninety minutes of dials: every row under the
     * rating threshold, every rate "not enough calls", `agents_rated` 0 and every
     * band "no median yet". The screen was useless at exactly the moment a
     * supervisor opens it.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');

    const options = [...(screen.getByTestId('roster-period') as HTMLSelectElement).options].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(['Today', 'This week', 'Last week', 'This month', 'Last month']);
  });

  it('asks for a CLOSED range when a completed window is chosen', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    mocks.getAgencyRoster.mockClear();

    fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'last_week' } });

    await waitFor(() => expect(mocks.getAgencyRoster).toHaveBeenCalledTimes(1));
    const { from, to } = mocks.getAgencyRoster.mock.calls[0]![0] as { from: string; to: string };
    // Ends in the past — a settled window, not a to-date one — and stays well inside
    // the server's 92-day cap.
    expect(new Date(to).getTime()).toBeLessThan(Date.now());
    expect(new Date(to).getTime()).toBeGreaterThan(new Date(from).getTime());
    const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
  });

  it('opens the drill-down on the roster’s OWN window, not on today', async () => {
    /**
     * The drill-down defaulted to `today` while the roster ranked a week, so a row's
     * numbers changed the moment it was opened — the same person, two ranges, one
     * click apart, with nothing on screen saying so.
     */
    renderSection(true);
    fireEvent.click(await screen.findByTestId('roster-open-user-1'));
    await screen.findByTestId('period-tile-today');

    expect(screen.getByRole('tab', { name: /^This week/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /^Today/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('follows the roster when the reader moves the window', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');

    fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'last_month' } });
    await screen.findByTestId('roster-table');
    fireEvent.click(screen.getByTestId('roster-open-user-1'));
    await screen.findByTestId('period-tile-today');

    // EXACTLY last month, not the nearest to-date tile. This used to fold onto
    // "This month" because the panel had only three windows — see the test below.
    expect(screen.getByRole('tab', { name: /^Last month/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /^This month/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('opens a COMPLETED roster window on that window, with no caveat to read', async () => {
    /**
     * ⚠️ This is the regression the old `windowPeriodShiftNote` existed to
     * disclose. `windowPeriod('last_week')` was `'week'`, so a roster ranked over
     * LAST week opened a person on THIS week — a different range, sharing a name
     * with the one the reader was looking at a click earlier, and the fold
     * happened in silence. A supervisor who ranked last week, spotted a low row
     * and opened it read a different period's figures under that person's name,
     * and the two disagreeing looked like the console being wrong about one.
     *
     * The disclosure was the best available while the panel had only three
     * to-date tiles. It has five now, so the fold is gone and so is the note —
     * and its absence is asserted here rather than merely un-tested, because a
     * note reading "these tiles are today, this week and this month" would now
     * be a false statement about the screen it sits on.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'last_week' } });
    await screen.findByTestId('roster-table');
    fireEvent.click(screen.getByTestId('roster-open-user-1'));
    await screen.findByTestId('period-tile-today');

    expect(screen.getByRole('tab', { name: /^Last week/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /^This week/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByTestId('roster-window-shifted')).toBeNull();
  });

  it('says nothing on a to-date window either — there is never a fold now', async () => {
    renderSection(true);
    fireEvent.click(await screen.findByTestId('roster-open-user-1'));
    await screen.findByTestId('period-tile-today');

    expect(screen.queryByTestId('roster-window-shifted')).toBeNull();
  });
});

describe('AgentAnalyticsSection — the page it asks for, and the rows it can reach', () => {
  it('asks for the contract’s maximum limit rather than letting the server default to 100', async () => {
    // A 180-agent agency silently lost its 80 LOWEST converters under
    // `conversions desc` — the population a supervisor is triaging.
    renderSection(true);
    await screen.findByTestId('roster-table');
    expect(mocks.getAgencyRoster.mock.calls[0]![0]).toMatchObject({ limit: 200 });
  });

  it('offers no sort order without a column showing it', async () => {
    /**
     * The menu was built from the whole wire enum, so it offered `successes` and
     * `talk_seconds` — two orders with no column, one of them the DEFAULT. Both the
     * headers and the menu now come from `ROSTER_COLUMNS`.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');

    const options = [...(screen.getByTestId('roster-sort') as HTMLSelectElement).options];
    expect(options.map((option) => option.value)).not.toContain('talk_seconds');
    expect(options.map((option) => option.value)).toContain('successes');

    // One pressable header per option, and every option's label names one of them.
    const headers = screen
      .getAllByRole('columnheader')
      .filter((header) => header.querySelector('button') !== null);
    expect(headers.length).toBe(options.length);
    // "conversions" is the menu's word for the default order, and "Conversions" is
    // now the column showing it — the two used to disagree, because there was no
    // such column and the visible "Conversion" one was a rate.
    expect(options.map((option) => option.textContent)).toContain('conversions');
    expect(headers.some((header) => header.textContent?.startsWith('Conversions'))).toBe(true);
  });

  it('marks exactly one header as sorted on FIRST LOAD', async () => {
    /**
     * The default order is `successes` desc and there used to be no column for it, so
     * on first load every header reported `aria-sort="none"` and nothing on screen
     * said what the rows were ranked by. The pre-existing aria-sort case passes
     * `sort: 'attempts'`, so the default was never exercised.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');

    const sorted = screen
      .getAllByRole('columnheader')
      .filter((header) => (header.getAttribute('aria-sort') ?? 'none') !== 'none');
    expect(sorted.length).toBe(1);
    expect(sorted[0]!.textContent).toContain('Conversions');
    expect(sorted[0]!.getAttribute('aria-sort')).toBe('descending');
  });

  it('reaches a flagged row without re-sorting the page', async () => {
    // The flag column cannot be sorted — it is derived from a row's relationship to
    // the benchmark — so filtering is the only affordance that finds a marked row on
    // a page the ranking selected.
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({
        rows: [
          rosterRow({ agent_user_id: 'fine', success_rate_pct: 18 }),
          rosterRow({ agent_user_id: 'poor', success_rate_pct: 4 }),
        ],
      }),
    );

    renderSection(true);
    await screen.findByTestId('roster-table');
    mocks.getAgencyRoster.mockClear();

    fireEvent.click(screen.getByTestId('roster-only-flagged'));

    expect(screen.queryByTestId('roster-row-fine')).toBeNull();
    expect(screen.getByTestId('roster-row-poor')).toBeTruthy();
    // A filter over the rows in hand, not a different question.
    expect(mocks.getAgencyRoster).not.toHaveBeenCalled();
  });

  it('says so when the filter leaves nothing, rather than showing an empty table', async () => {
    /**
     * ⚠️ Strengthened, because the old assertion could not fail for the reason the
     * case is named after. It checked only that the sentence was PRESENT — and the
     * table mounted anyway, right beside it: nine column headers, an empty `<tbody>`,
     * and the sticky pinned team footer carrying the whole floor's figures under a
     * table with no rows in it. A footer captioned as the team's totals beneath an
     * empty selection reads as those totals belonging to nobody.
     *
     * So the absence of `roster-table` is now the assertion, and the sentence is the
     * secondary one. Unticking restores the table, which is what stops this passing
     * on a build that simply never renders the table.
     */
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [rosterRow({ success_rate_pct: 18 })] }),
    );

    renderSection(true);
    await screen.findByTestId('roster-table');

    fireEvent.click(screen.getByTestId('roster-only-flagged'));

    expect(screen.queryByTestId('roster-table')).toBeNull();
    expect(screen.getByTestId('roster-nothing-flagged')).toBeTruthy();

    // Untick and it comes back — so the emptiness above is the filter's, not a
    // component that stopped rendering.
    fireEvent.click(screen.getByTestId('roster-only-flagged'));
    expect(screen.getByTestId('roster-table')).toBeTruthy();
    expect(screen.queryByTestId('roster-nothing-flagged')).toBeNull();
  });

  it('keeps the table mounted when the filter DOES leave something', async () => {
    // The gate is `onlyFlagged && attention === 0`, not `onlyFlagged` — a filter that
    // found rows must not take the table with it.
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [thinRow({ agent_user_id: 'user-poor', agent_name: 'Poor' })] }),
    );

    renderSection(true);
    await screen.findByTestId('roster-table');
    fireEvent.click(screen.getByTestId('roster-only-flagged'));

    expect(screen.getByTestId('roster-table')).toBeTruthy();
    expect(screen.queryByTestId('roster-nothing-flagged')).toBeNull();
  });
});

describe('AgentAnalyticsSection — an all-departed page says ONE thing', () => {
  /**
   * Proven end to end: the dialer runtime returns 2 rows both `revoked`, the server
   * answers `200 { rows: [], inactive_omitted: 2, total_agents: 2 }`, and the console
   * rendered "Nobody was handed a call in this window" AND "2 former members hidden
   * — they dialled in this window" AND "2 agents dialled", simultaneously. `page` is
   * bound for both `ready` and `empty`, so the former-members note rendered
   * underneath the empty message. It is an ordinary the server response, not a shape
   * violation.
   */
  it('drops the "nobody dialled" sentence when rows were HIDDEN rather than absent', async () => {
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [], total_agents: 2, inactive_omitted: 2 }),
    );

    renderSection(true);

    const note = await screen.findByTestId('roster-all-departed');
    expect(screen.queryByTestId('roster-empty')).toBeNull();
    // And it points at the remedy that exists, rather than at a longer window.
    expect(note.textContent).toContain('Show former team members');
    expect(note.textContent).not.toContain('longer window');
    expect(screen.getByTestId('roster-inactive')).toBeTruthy();
    expect(screen.getByTestId('roster-include-inactive')).toBeTruthy();
  });

  it('renders no table for a page with no rows', async () => {
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [], total_agents: 2, inactive_omitted: 2 }),
    );

    renderSection(true);

    await screen.findByTestId('roster-all-departed');
    expect(screen.queryByTestId('roster-table')).toBeNull();
  });

  it('still says "nobody dialled" when nothing was hidden either', async () => {
    // The genuinely empty answer, where a longer window really is the remedy.
    mocks.getAgencyRoster.mockResolvedValue(rosterPage({ rows: [], inactive_omitted: 0 }));

    renderSection(true);

    expect(await screen.findByTestId('roster-empty')).toBeTruthy();
    expect(screen.queryByTestId('roster-all-departed')).toBeNull();
    expect(screen.queryByTestId('roster-inactive')).toBeNull();
  });

  it('does NOT say "nobody dialled" when the rows were UNATTRIBUTED', async () => {
    /**
     * ⚠️ `empty` keyed on `inactive_omitted` alone, so `{ rows: [],
     * unattributed_omitted: 3 }` — the server dropped three ids with no membership record
     * of any status, R4's third state — took the empty arm and rendered "Nobody was
     * handed a call in this window, so there is nothing to rank" directly above a
     * readout saying THREE AGENTS DIALLED. Two sentences from one payload,
     * contradicting each other, and the remedy the empty copy names (a longer window)
     * would not change a thing.
     */
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [], total_agents: 3, inactive_omitted: 0, unattributed_omitted: 3 }),
    );

    renderSection(true);

    const note = await screen.findByTestId('roster-all-unattributed');
    expect(screen.queryByTestId('roster-empty')).toBeNull();
    // It must not claim they left, and must not point at a toggle that cannot
    // reveal them: `include_inactive` widens a membership filter and these rows
    // match no membership at all.
    expect(note.textContent).not.toContain('left the team, so every row was hidden');
    expect(note.textContent).toContain('will not reveal them');
    expect(screen.queryByTestId('roster-all-departed')).toBeNull();
    // Still no table, and the readout still tells the truth about the floor.
    expect(screen.queryByTestId('roster-table')).toBeNull();
    expect(screen.getByTestId('roster-count').textContent).toContain('3 agents dialled');
  });

  it('says both things when both kinds of row were dropped', async () => {
    // The toggle is the remedy for one half and not the other, so the sentence has to
    // carry both — a single "everyone left" would be false about half of them.
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ rows: [], total_agents: 4, inactive_omitted: 2, unattributed_omitted: 2 }),
    );

    renderSection(true);

    const note = await screen.findByTestId('roster-all-hidden');
    expect(note.textContent).toContain('left the team');
    expect(note.textContent).toContain('could not be matched');
    expect(screen.queryByTestId('roster-empty')).toBeNull();
    expect(screen.queryByTestId('roster-all-departed')).toBeNull();
    expect(screen.queryByTestId('roster-all-unattributed')).toBeNull();
  });
});

describe('AgentAnalyticsSection — a benchmark-less page degrades instead of white-screening', () => {
  it('shows the failure and a retry rather than throwing during render', async () => {
    /**
     * `rosterCountReadout` reads `page.benchmark.attempts` and the pinned team row
     * reads a dozen more fields off it, so a body without a `benchmark` threw
     * `TypeError: Cannot read properties of undefined` DURING RENDER — and there is
     * no error boundary here, so the whole roster section disappeared. Every other
     * absence on this payload degrades gracefully; that one was a blank screen.
     *
     * Realistic rather than hypothetical: the server relays the dialer runtime's body through a
     * spread, and phase 02 swaps the data source underneath a console already built
     * against this payload.
     */
    const page = rosterPage();
    delete (page as { benchmark?: unknown }).benchmark;
    mocks.getAgencyRoster.mockResolvedValue(page);

    renderSection(true);

    expect(await screen.findByTestId('roster-error')).toBeTruthy();
    expect(screen.queryByTestId('roster-table')).toBeNull();
    expect(screen.queryByTestId('roster-count')).toBeNull();
  });

  it('treats a benchmark that is not an object as a failure too', async () => {
    const page = rosterPage();
    (page as { benchmark: unknown }).benchmark = null;
    mocks.getAgencyRoster.mockResolvedValue(page);

    renderSection(true);

    expect(await screen.findByTestId('roster-error')).toBeTruthy();
  });
});

describe('AgentAnalyticsSection — the way into the campaign’s contribution', () => {
  /**
   * A SECOND drill-down beside the per-agent one, and a different question: not
   * "who should I be asking about across the floor" but "who drove this campaign".
   * It cannot be columns on the roster, because a contribution needs the
   * campaign's own total (which the roster payload does not carry) and the roster
   * needs a cohort's percentiles (which the grouped read deliberately does not).
   */
  it('offers it for the campaign in scope, naming that campaign', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');

    expect(screen.getByTestId('roster-contribution-entry').textContent).toContain(
      'Who drove Renewals',
    );
  });

  it('does not offer it on the pooled read', async () => {
    /**
     * A share of every campaign in the account is not a contribution, and the
     * pooled view's own note above the table already tells the reader to pick one
     * campaign. A control that 400s or answers a different question is worse than
     * no control.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');

    fireEvent.change(screen.getByTestId('roster-campaign'), { target: { value: '' } });

    await waitFor(() => expect(screen.queryByTestId('roster-contribution-entry')).toBeNull());
  });

  it('replaces the roster with the contribution view, and asks the grouped route', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    mocks.getAgencyRoster.mockClear();

    fireEvent.click(screen.getByTestId('roster-contribution-entry'));

    await screen.findByTestId('contribution-table');
    // Replaced rather than stacked: exactly one read is ever in flight, and the
    // roster behind it cannot refetch because its controls are unmounted.
    expect(screen.queryByTestId('roster-table')).toBeNull();
    expect(mocks.getAgencyRoster).not.toHaveBeenCalled();
    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(2);
  });

  it('carries the roster’s window into it rather than resetting to today', async () => {
    /**
     * The same defect the per-agent drill-down had when it defaulted to `today`
     * while the roster showed the week: the same subject, two ranges, one click
     * apart, with nothing on screen saying so.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');

    fireEvent.change(screen.getByTestId('roster-period'), { target: { value: 'last_week' } });
    await screen.findByTestId('roster-table');
    fireEvent.click(screen.getByTestId('roster-contribution-entry'));

    await screen.findByTestId('contribution-table');
    expect((screen.getByTestId('contribution-period') as HTMLSelectElement).value).toBe(
      'last_week',
    );
  });

  it('comes back to the roster, and re-reads it', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    fireEvent.click(screen.getByTestId('roster-contribution-entry'));
    await screen.findByTestId('contribution-table');

    fireEvent.click(screen.getByTestId('contribution-back'));

    expect(await screen.findByTestId('roster-table')).toBeTruthy();
    expect(screen.queryByTestId('contribution-table')).toBeNull();
  });

  it('does not mount the per-agent panels for it', async () => {
    // Entering it is not opening a person: no `getAgentStats`, and certainly not the
    // `my-` twins. A ROW opens a person — see the cases below — and the panels are
    // mounted then and only then.
    renderSection(true);
    await screen.findByTestId('roster-table');
    fireEvent.click(screen.getByTestId('roster-contribution-entry'));
    await screen.findByTestId('contribution-table');

    expect(mocks.getAgentStats).not.toHaveBeenCalled();
    expect(mocks.getMyStats).not.toHaveBeenCalled();
    expect(mocks.getAgentAttempts).not.toHaveBeenCalled();
  });

  it('opens a person from a contribution row, through the SAME shared panels', async () => {
    /**
     * The property this file exists to pin, now from the second list. It is the same
     * assertion as the roster row's — three periods through the SUPERVISOR twin, for
     * the person on the row, and never a `my-` form — because it must be the same
     * two components: a forked panel would drift from the agent's own view in
     * wording, in rounding and in what counts as absent.
     *
     * And it needs nothing fabricated to get there. A grouped row carries the id (on
     * its `key`) and the name the server resolved, which is the entire shape those panels
     * are built against.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');
    fireEvent.click(screen.getByTestId('roster-contribution-entry'));
    await screen.findByTestId('contribution-table');

    fireEvent.click(screen.getByTestId('contribution-open-user-1'));

    await waitFor(() => expect(mocks.getAgentStats).toHaveBeenCalledTimes(AGENT_STATS_WINDOWS.length));
    for (const call of mocks.getAgentStats.mock.calls) expect(call[0]).toBe('user-1');
    await waitFor(() => expect(mocks.getAgentAttempts).toHaveBeenCalled());
    expect(mocks.getAgentAttempts.mock.calls[0]?.[0]).toBe('user-1');
    expect(mocks.getMyStats).not.toHaveBeenCalled();
    expect(mocks.getMyAttempts).not.toHaveBeenCalled();

    // The name from the grouped row, in the heading and in the call table's caption.
    expect(await screen.findByRole('heading', { name: 'Ravi Kumar' })).toBeTruthy();
  });

  it('comes back to the CONTRIBUTION table, and names it', async () => {
    /**
     * Back lands where the reader came from. Returning them to the roster instead
     * would make them re-enter the contribution view and re-choose its window to get
     * back to the screen they were reading — and the label has to say so, because
     * "All agents" describes the wrong screen.
     *
     * The mechanism is the branch order rather than a third piece of state: the
     * contribution campaign is still set while a person is open, so clearing the
     * person falls through to it.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');
    fireEvent.click(screen.getByTestId('roster-contribution-entry'));
    await screen.findByTestId('contribution-table');
    fireEvent.click(screen.getByTestId('contribution-open-user-1'));

    const back = await screen.findByTestId('roster-back');
    expect(back.textContent).toContain('Who drove Renewals');

    fireEvent.click(back);

    expect(await screen.findByTestId('contribution-table')).toBeTruthy();
    expect(screen.queryByTestId('roster-table')).toBeNull();
  });

  it('still says "All agents" for a person opened from the roster', async () => {
    // The label names the destination, and from the roster the destination is the
    // roster. Unchanged, and asserted beside its counterpart so the pair cannot
    // silently become one.
    renderSection(true);
    fireEvent.click(await screen.findByTestId('roster-open-user-1'));

    expect((await screen.findByTestId('roster-back')).textContent).toContain('All agents');
  });

  it('lets the contribution view re-scope itself without moving the roster’s filter', async () => {
    /**
     * Two campaign controls, one for each list, and they are deliberately not one:
     * the roster's decides who is ON the list, this one decides which campaign is
     * being contributed to. Coming back to a roster the reader had not re-scoped is
     * the property — a shared filter would silently re-rank the floor behind a screen
     * that had replaced it.
     */
    renderSection(true, TWO_CAMPAIGNS);
    await screen.findByTestId('roster-table');
    fireEvent.click(screen.getByTestId('roster-contribution-entry'));
    await screen.findByTestId('contribution-table');

    fireEvent.change(screen.getByTestId('contribution-campaign'), {
      target: { value: 'camp-2' },
    });

    // The contribution view followed...
    await waitFor(() =>
      expect(
        mocks.getAgencyGroupedStats.mock.calls
          .map((call) => call[0] as { campaign_id: string })
          .at(-1)!.campaign_id,
      ).toBe('camp-2'),
    );
    expect(await screen.findByRole('heading', { name: 'Who drove Winback' })).toBeTruthy();

    // ...and the roster behind it did not.
    fireEvent.click(screen.getByTestId('contribution-back'));
    await screen.findByTestId('roster-table');
    expect((screen.getByTestId('roster-campaign') as HTMLSelectElement).value).toBe('camp-1');
  });
});

describe('AgentAnalyticsSection — the way into the campaign’s best hours', () => {
  /**
   * A THIRD screen beside the roster and the contribution table, and a third
   * question: not "who should I be asking about" and not "who drove this campaign",
   * but "when should I roster people". It cannot be columns here for the same reason
   * the contribution view cannot: a roster row is a person's whole window, and an
   * hour is not on that payload at all.
   */
  it('offers it for the campaign in scope, naming that campaign', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');

    expect(screen.getByTestId('roster-best-hours-entry').textContent).toContain(
      'When Renewals connects',
    );
  });

  it('does not offer it on the pooled read', async () => {
    /**
     * Stronger than the contribution entry's version of this: with both time
     * dimensions grouped there is no room for `campaign` in `group_by`, so the read's
     * zone is unambiguous only under a single campaign filter and a pooled read is a
     * 400 upstream. The button being the only way in is what makes that state
     * unreachable rather than guarded.
     */
    renderSection(true);
    await screen.findByTestId('roster-table');

    fireEvent.change(screen.getByTestId('roster-campaign'), { target: { value: '' } });

    await waitFor(() => expect(screen.queryByTestId('roster-best-hours-entry')).toBeNull());
  });

  it('replaces the roster and asks the grouped route for weekday × hour', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    mocks.getAgencyRoster.mockClear();
    mocks.getAgencyGroupedStats.mockClear();

    fireEvent.click(screen.getByTestId('roster-best-hours-entry'));

    await screen.findByTestId('best-hours-matrix');
    // Replaced rather than stacked: exactly one read is ever in flight, and the roster
    // behind it cannot refetch because its controls are unmounted.
    expect(screen.queryByTestId('roster-table')).toBeNull();
    expect(mocks.getAgencyRoster).not.toHaveBeenCalled();
    // ONE request, not two — unlike the contribution view, which needs a second read
    // for the campaign's own line.
    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1);
    expect(
      (mocks.getAgencyGroupedStats.mock.calls[0]?.[0] as { group_by: readonly string[] }).group_by,
    ).toEqual(['day_of_week', 'hour_of_day']);
  });

  it('carries the roster’s window into it, and comes back to the roster', async () => {
    renderSection(true);
    await screen.findByTestId('roster-table');
    fireEvent.change(screen.getByTestId('roster-period'), { target: { value: 'last_week' } });
    await screen.findByTestId('roster-table');

    fireEvent.click(screen.getByTestId('roster-best-hours-entry'));
    await screen.findByTestId('best-hours-matrix');
    // Seeded from the roster rather than reset — the same defect the per-agent
    // drill-down had when it defaulted to `today` while the roster showed the week.
    expect((screen.getByTestId('best-hours-period') as HTMLSelectElement).value).toBe('last_week');

    fireEvent.click(screen.getByTestId('best-hours-back'));
    expect(await screen.findByTestId('roster-table')).toBeTruthy();
  });
});

describe('AgentAnalyticsSection — the compare tray', () => {
  /** Two or more people on the page, so the tray has something to compare. */
  function twoAgentPage(over: Record<string, unknown> = {}) {
    return rosterPage({ rows: [rosterRow(), thinRow()], ...over });
  }

  it('offers the tray beneath the roster when the cohort is one campaign', async () => {
    mocks.getAgencyRoster.mockResolvedValue(twoAgentPage({ campaign_id: 'camp-1' }));
    renderSection(true);
    await screen.findByTestId('roster-table');

    expect(screen.getByTestId('compare-tray-open')).toBeTruthy();
  });

  it('suppresses it entirely on the pooled read', async () => {
    /**
     * `mixedCohortNote` directly above the table already tells the reader that
     * comparing any ONE person against the floor's bands is switched off there — a
     * pooled median mixes different dealers' lead lists. A tray is the most emphatic
     * version of exactly that comparison, so offering it would contradict that
     * sentence in the loudest way the surface allows.
     */
    mocks.getAgencyRoster.mockResolvedValue(twoAgentPage({ campaign_id: null }));
    renderSection(true);
    await screen.findByTestId('roster-table');

    expect(screen.getByTestId('roster-mixed-cohort')).toBeTruthy();
    expect(screen.queryByTestId('compare-tray-open')).toBeNull();
  });

  it('issues no further request when it is opened and used', async () => {
    /**
     * E7's whole point, asserted where the reader actually meets the tray: it compares
     * people already on the page against the page's own benchmark. The roster read
     * count must not move.
     */
    mocks.getAgencyRoster.mockResolvedValue(twoAgentPage({ campaign_id: 'camp-1' }));
    renderSection(true);
    await screen.findByTestId('roster-table');
    const before = mocks.getAgencyRoster.mock.calls.length;
    const grouped = mocks.getAgencyGroupedStats.mock.calls.length;

    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
    expect(screen.getByTestId('compare-tray-table')).toBeTruthy();

    expect(mocks.getAgencyRoster.mock.calls.length).toBe(before);
    expect(mocks.getAgencyGroupedStats.mock.calls.length).toBe(grouped);
  });

  it('keeps the comparison across a REFETCH, which every control on the page is', async () => {
    /**
     * ⚠️ The tray's state used to live inside the tray, and the tray is mounted only
     * on a `ready` page. Every refetch — a column header, the window, the campaign,
     * the inactive toggle, a Retry — passes through `loading` first, so the tray was
     * unmounted and remounted closed and empty. A supervisor who picked four people
     * and then re-sorted the table lost the comparison and had to rebuild it, which
     * is the opposite of what a comparison is for.
     *
     * The window select is used here because it is the most ordinary of those
     * controls, and because it proves the transition really happened: the roster read
     * fires again with the new window.
     */
    mocks.getAgencyRoster.mockResolvedValue(twoAgentPage({ campaign_id: 'camp-1' }));
    renderSection(true);
    await screen.findByTestId('roster-table');

    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
    expect(screen.getByTestId('compare-tray-table')).toBeTruthy();

    const before = mocks.getAgencyRoster.mock.calls.length;
    fireEvent.change(screen.getByTestId('roster-period'), { target: { value: 'last_week' } });
    await waitFor(() =>
      expect(mocks.getAgencyRoster.mock.calls.length).toBeGreaterThan(before),
    );

    // Still open, still comparing the same two people.
    const table = await screen.findByTestId('compare-tray-table');
    expect(within(table).getByTestId('compare-row-user-1')).toBeTruthy();
    expect(within(table).getByTestId('compare-row-user-thin')).toBeTruthy();
  });

  it('prunes a compare selection the NEW page no longer carries', async () => {
    /**
     * ⚠️ The pruning that could never run. It lived inside the tray, where the
     * selection was always empty on mount, so `compareMissing` was dead code that
     * read as a safeguard — and any test over it inside the tray was testing a state
     * the product could not reach. It now lives with the state, above the loading
     * transition, which is the only place a page change can be compared against a
     * surviving selection.
     *
     * Left unpruned the hint would read "2 picked" over one column, which is the kind
     * of small lie that makes a reader distrust the figures beside it.
     */
    mocks.getAgencyRoster.mockResolvedValue(twoAgentPage({ campaign_id: 'camp-1' }));
    renderSection(true);
    await screen.findByTestId('roster-table');

    fireEvent.click(screen.getByTestId('compare-tray-open'));
    fireEvent.click(screen.getByTestId('compare-pick-user-1'));
    fireEvent.click(screen.getByTestId('compare-pick-user-thin'));
    expect(screen.getByTestId('compare-row-user-thin')).toBeTruthy();

    // A narrower window drops one of the two people from the floor entirely.
    mocks.getAgencyRoster.mockResolvedValue(
      rosterPage({ campaign_id: 'camp-1', rows: [rosterRow(), hollowRow()] }),
    );
    fireEvent.change(screen.getByTestId('roster-period'), { target: { value: 'last_week' } });

    await waitFor(() => expect(screen.queryByTestId('compare-row-user-thin')).toBeNull());
    /*
      Pruned, not merely unrendered — and this is the assertion the whole fix is
      about. `compareRows` filters the page's rows, so a stale id stops rendering a
      COLUMN on its own; what it does not do is leave the selection COUNT correct.
      The hint is read from `selected`, so "2 picked" over one column is what an
      unpruned selection looks like, and it is the state the effect exists to remove.
    */
    await waitFor(() =>
      expect(screen.getByTestId('compare-tray-hint').textContent).toContain('at least 2'),
    );
    // And the survivor is still picked, so this is a prune rather than a reset.
    expect(
      (screen.getByTestId('compare-pick-user-1') as HTMLInputElement).checked,
    ).toBe(true);
  });
});
