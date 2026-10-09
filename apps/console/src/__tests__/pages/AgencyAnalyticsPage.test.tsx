import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The supervisor's cross-campaign analytics page.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * The page shipped with no test at all — 216 lines, a new route and a new sidebar
 * entry — and three of its properties are exactly the kind that look fine in review
 * and fail in front of a user:
 *
 *  1. **Per-campaign failure isolation.** The page is opened *because* something
 *     looks wrong, so one campaign's failed `/stats` read must annotate its own
 *     card and leave the other campaigns' figures on screen. `Promise.all` here
 *     would blank the page on the first 404.
 *  2. **A bounded fan-out.** `listAgencyCampaigns` is unpaginated, so the request
 *     count is a property of the account's history, not of the screen.
 *  3. **Terminating when there is no account.** The early return used to skip
 *     `setLoading(false)`, leaving a permanent spinner in a state that never
 *     resolves itself.
 *
 * ── The per-agent tab, added after this file was written ────────────────────
 * The page grew a second half — the floor, ranked, and one named person behind
 * each row — and two things about it are pinned below rather than in the
 * component's own file, because only the page can decide them: the tab is gated
 * on `agency.supervise` (master's exact floor on the roster read and on both
 * per-agent twins, so a looser gate renders a tab whose first click 403s), and it
 * mounts only when chosen, so the campaign half's N `/stats` requests are not
 * joined by a roster read on every page view.
 *
 * The tab's own surface used to open with a dropdown of colleagues, and the
 * assertions below used to reach for `data-testid="agent-picker"`. It now opens on
 * the roster table, so they reach for `roster-table` instead — the property being
 * pinned is unchanged (the tab swaps the campaign list for the agent surface and
 * mounts nothing until chosen), only the thing that surface renders moved.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  listAgencyCampaigns: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
  useTeam: vi.fn(),
  getAgentStats: vi.fn(),
  getMyStats: vi.fn(),
  getMyCampaigns: vi.fn(),
  getAgencyRoster: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyCampaigns', () => ({
  listAgencyCampaigns: mocks.listAgencyCampaigns,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
}));
/*
  The per-agent tab's own reads. Mocked here — rather than left to hit the real
  modules — so a request fired from the CAMPAIGN tab shows up as a call count in
  the tests below instead of as a network error nobody looks at.
*/
vi.mock('../../hooks/useTeam', () => ({ useTeam: mocks.useTeam }));
vi.mock('../../api/agencyStats', () => ({
  getAgentStats: mocks.getAgentStats,
  getMyStats: mocks.getMyStats,
  getMyCampaigns: mocks.getMyCampaigns,
  getAgencyRoster: mocks.getAgencyRoster,
}));

import { AgencyAnalyticsPage } from '../../pages/agency/AgencyAnalyticsPage';
import { rosterPage } from '../helpers/roster';

function renderPage() {
  return render(
    <MemoryRouter>
      <AgencyAnalyticsPage />
    </MemoryRouter>,
  );
}

function tenant(over: Record<string, unknown> = {}) {
  return { tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin', ...over };
}

function campaign(over: Record<string, unknown> = {}) {
  return { id: 'camp-1', name: 'Renewals', status: 'running', wrapup_seconds: 30, ...over };
}

/** A stats payload shaped enough for the two child components to render. */
function stats(over: Record<string, unknown> = {}) {
  return {
    contacts_total: 100,
    attempts_total: 50,
    attempts_connected: 20,
    stall: null,
    other_stalls: [],
    ...over,
  };
}

/**
 * A `no_agents_available` stall, COMPLETE.
 *
 * Every field the copy function reads is present, including
 * `on_break_by_reason` — `stallCopy` passes it straight to `Object.entries`, and
 * the mirrored type declares it required, so core is contracted to send it. An
 * earlier version of this fixture omitted it and crashed the render, which is a
 * fixture bug rather than a product one: a partial stall payload would be a
 * contract violation, not an input the page has to survive.
 */
function noAgentsStall() {
  return {
    code: 'no_agents_available',
    agents_on_shift: 4,
    on_call: 3,
    on_break_by_reason: { lunch: 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  mocks.listAgencyCampaigns.mockResolvedValue([campaign()]);
  mocks.getAgencyCampaignStats.mockResolvedValue(stats());
  mocks.useTeam.mockReturnValue({ members: [], loading: false, error: null, reload: vi.fn() });
  mocks.getAgencyRoster.mockResolvedValue(rosterPage());
  mocks.getAgentStats.mockResolvedValue({
    agent_user_id: 'user-1',
    bucket: 'day',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-20T00:00:00.000Z',
    totals: {
      attempts: 0,
      connected: 0,
      connect_rate_pct: null,
      successes: 0,
      success_rate_pct: null,
      talk_seconds: 0,
      wrapup_seconds: 0,
      aht_seconds: null,
      campaigns: 0,
    },
    buckets: [],
    by_campaign: [],
  });
});

afterEach(() => cleanup());

describe('AgencyAnalyticsPage — the happy path', () => {
  it('lists every campaign with a link to its detail page', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([
      campaign(),
      campaign({ id: 'camp-2', name: 'Collections', status: 'paused' }),
    ]);

    renderPage();

    await screen.findByText('Renewals');
    expect(screen.getByText('Collections')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Renewals' }).getAttribute('href')).toBe(
      '/agency/campaigns/camp-1',
    );
  });

  it('fetches stats once per campaign', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([
      campaign(),
      campaign({ id: 'camp-2', name: 'Collections' }),
    ]);

    renderPage();

    await waitFor(() => expect(mocks.getAgencyCampaignStats).toHaveBeenCalledTimes(2));
    expect(mocks.getAgencyCampaignStats.mock.calls.map((c) => c[0])).toEqual(['camp-1', 'camp-2']);
  });
});

describe('AgencyAnalyticsPage — failure isolation', () => {
  it('one campaign’s failed stats read leaves its siblings’ figures alone', async () => {
    /**
     * The property the page's header argues for at length and nothing verified. With
     * `Promise.all` the first rejection discards every sibling's resolved value, so
     * a single deleted campaign would blank a supervisor's whole screen.
     */
    mocks.listAgencyCampaigns.mockResolvedValue([
      campaign(),
      campaign({ id: 'camp-2', name: 'Collections' }),
    ]);
    mocks.getAgencyCampaignStats.mockImplementation((id: string) =>
      id === 'camp-1' ? Promise.reject(new Error('gone')) : Promise.resolve(stats()),
    );

    renderPage();

    // The failed card says so, scoped to itself…
    await screen.findByText(/couldn’t load this campaign’s numbers/i);
    expect(screen.getAllByText(/couldn’t load this campaign’s numbers/i)).toHaveLength(1);
    // …and both campaigns are still on the page.
    expect(screen.getByText('Renewals')).toBeTruthy();
    expect(screen.getByText('Collections')).toBeTruthy();
  });

  it('says the campaign’s setup is unaffected, so nobody goes looking for damage', async () => {
    mocks.getAgencyCampaignStats.mockRejectedValue(new Error('gone'));

    renderPage();

    expect(await screen.findByText(/setup and contacts are\s+unaffected/i)).toBeTruthy();
  });

  it('surfaces a failed campaign LIST read as a page-level error with a retry', async () => {
    // The one failure that genuinely is the whole page: with no campaigns there is
    // nothing to show stats for.
    mocks.listAgencyCampaigns.mockRejectedValue(new Error('Request Failed'));

    renderPage();

    await screen.findByText(/Request Failed/i);
    // `ErrorAlert`'s retry carries aria-label "Retry loading".
    expect(screen.getByRole('button', { name: /retry loading/i })).toBeTruthy();
  });
});

describe('AgencyAnalyticsPage — the empty and terminal states', () => {
  it('shows an empty state with a create action for someone who may create', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([]);

    renderPage();

    await screen.findByText(/no campaigns yet/i);
    expect(screen.getByRole('link', { name: /new campaign/i })).toBeTruthy();
    expect(mocks.getAgencyCampaignStats).not.toHaveBeenCalled();
  });

  it('omits the create action for a role that cannot create', async () => {
    // `agency.campaigns.write` floors at `account_admin`; an operator reads the
    // page and must not be offered a control that would 403.
    mocks.useTenant.mockReturnValue(tenant({ role: 'operator' }));
    mocks.listAgencyCampaigns.mockResolvedValue([]);

    renderPage();

    await screen.findByText(/no campaigns yet/i);
    expect(screen.queryByRole('link', { name: /new campaign/i })).toBeNull();
  });

  /**
   * ── The spinner that never ended ──────────────────────────────────────────
   * `load()` returns early with no account, and used to do so without clearing
   * `loading` — so the render's `loading && campaigns === null` branch showed a
   * spinner forever. `accountResolution` can settle with `accountId === null` (a
   * tenant with no accounts, a narrowed fallback that came back empty) and nothing
   * fires again, so this is a terminal state, not a slow one.
   */
  it('stops rather than spinning when there is no account', async () => {
    mocks.useTenant.mockReturnValue(tenant({ accountId: null }));

    renderPage();

    await waitFor(() => {
      expect(document.querySelector('[class*="spinner"], [role="status"]')).toBeNull();
    });
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
  });
});

describe('AgencyAnalyticsPage — context changes and unmount', () => {
  /**
   * Both raised in review on PR #263. Neither is reachable through `AgencyLayout`
   * today — it renders no `Outlet` without an account and keys it by `accountId`, so
   * a switch remounts this page — but a page's correctness should not rest on its
   * parent's gate, and these are the two ways it would show something untrue.
   */
  it('clears the previous context’s data when the account goes away', async () => {
    // Otherwise the LAST account's campaigns and figures stay on screen, which reads
    // as data about the account you are now in.
    mocks.listAgencyCampaigns.mockResolvedValue([campaign()]);
    const { rerender } = renderPage();
    await screen.findByText('Renewals');

    mocks.useTenant.mockReturnValue(tenant({ accountId: null }));
    rerender(
      <MemoryRouter>
        <AgencyAnalyticsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.queryByText('Renewals')).toBeNull());
  });

  it('does not write state after unmount, even for a manual retry', async () => {
    /**
     * `load` is wired to `onRetry`, and `useEffect` only ever holds the cleanup of
     * the call IT made — so a retry's `cancelled` flag could never be set. The
     * generation counter does not help either: nothing bumps it on unmount. A
     * navigate-away shortly after pressing Retry therefore resolved into an
     * unmounted component.
     *
     * Asserted by unmounting while the list read is still in flight and requiring no
     * error to surface. React 18 no longer warns on setState-after-unmount, so this
     * fails via the `console.error` spy only if something throws — which is what a
     * write into a torn-down tree does.
     */
    let resolveList: (rows: unknown[]) => void = () => {};
    mocks.listAgencyCampaigns.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve as (rows: unknown[]) => void;
      }),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderPage();
    unmount();
    // The request lands after the component is gone.
    resolveList([campaign()]);
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('AgencyAnalyticsPage — the health strip is gated on being live', () => {
  /**
   * The strip diagnoses a LIVE campaign — pacing stalls, concurrency ceilings, a
   * 24-hour abandonment rate. On a draft or stopped campaign every one of those is
   * absent or frozen, and rendering it anyway would show a supervisor a clean bill
   * of health for a campaign that is simply not running.
   */
  it('renders a stall diagnosis for a running campaign', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ stall: noAgentsStall() }));

    renderPage();

    // The strip is the only thing on this page that renders a stall diagnosis.
    expect(await screen.findByText(/nobody is free to take a call/i)).toBeTruthy();
  });

  it('does not render the strip for a terminal campaign', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([campaign({ status: 'completed' })]);
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ stall: noAgentsStall() }));

    renderPage();

    await screen.findByText('Renewals');
    // Same stall payload as the case above, which the strip renders as a sentence.
    // Absent here means the strip did not render at all.
    expect(screen.queryByText(/nobody is free to take a call/i)).toBeNull();
  });
});

describe('AgencyAnalyticsPage — the per-agent tab', () => {
  it('offers the tab to a role that holds agency.supervise', async () => {
    renderPage();
    expect(await screen.findByTestId('tab-agents')).toBeTruthy();
  });

  it('hides the tab from a role that does not', async () => {
    /**
     * The gate has to be `agency.supervise` and nothing looser. The campaign half
     * of this page needs only `agency.campaigns.read` (`viewer`), so a `viewer`
     * legitimately reads it — and would be handed a tab whose first read 403s.
     * A tab that fails on click reads as a broken product rather than an absent
     * one.
     */
    mocks.useTenant.mockReturnValue(tenant({ role: 'viewer' }));

    renderPage();

    await waitFor(() => expect(mocks.listAgencyCampaigns).toHaveBeenCalled());
    expect(screen.queryByTestId('tab-agents')).toBeNull();
  });

  it('mounts nothing for the agent half until the tab is chosen', async () => {
    /**
     * The campaign tab already pays one `/stats` request per campaign. Mounting
     * the per-agent panel beside it would add a members read and three stats reads
     * to every page view, for a panel most visits never scroll to.
     */
    renderPage();
    await screen.findByTestId('tab-agents');
    /*
      The roster read is the one that would fire, and asserting on IT rather than
      on `useTeam` is the point: the agent surface no longer reads the member list
      at all (the roster carries `agent_name` on every row), so a `useTeam`
      assertion here would now pass whatever the tab did.
    */
    expect(mocks.getAgencyRoster).not.toHaveBeenCalled();
    expect(mocks.getAgentStats).not.toHaveBeenCalled();
  });

  it('swaps the campaign list for the roster when it is', async () => {
    renderPage();
    (await screen.findByTestId('tab-agents')).click();

    expect(await screen.findByTestId('roster-table')).toBeTruthy();
    /*
      Replaced rather than stacked — see the page. Asserted on the campaign's LINK
      rather than on its name: the roster's own campaign filter legitimately carries
      "Renewals" as an option (the page hands it the list it already holds), so a
      bare text query would now fail for a page that is behaving correctly. The card
      is what must be gone, and the link is the card.
    */
    expect(screen.queryByRole('link', { name: 'Renewals' })).toBeNull();
  });

  it('still fetches the campaign list on the agent tab, to resolve names', async () => {
    // `by_campaign[]` carries ids and no names, and the campaign list is the one
    // request this page has already made. It is also what fills the roster's own
    // campaign filter, so the agent tab needs it twice over.
    renderPage();
    (await screen.findByTestId('tab-agents')).click();
    await screen.findByTestId('roster-table');
    expect(mocks.listAgencyCampaigns).toHaveBeenCalled();
  });

  /**
   * ── The two tabs are TABS, and that is asserted by role, not by test id ────
   *
   * Every case above reaches the control through `data-testid="tab-agents"`. A
   * test id is not an accessible name and carries no state: removing `role="tab"`
   * and `aria-selected` from both buttons left this whole file passing, and with
   * it the only thing that tells a screen reader "two views, one of them current"
   * from "two buttons".
   */
  describe('as an accessible tablist', () => {
    it('names both views and marks which one is showing', async () => {
      renderPage();
      await screen.findByText('Renewals');

      const list = screen.getByRole('tablist', { name: 'Analytics view' });
      expect(list).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'By campaign' }).getAttribute('aria-selected'))
        .toBe('true');
      expect(screen.getByRole('tab', { name: 'By agent' }).getAttribute('aria-selected'))
        .toBe('false');
    });

    it('moves the selected state when the other tab is chosen', async () => {
      renderPage();
      fireEvent.click(await screen.findByRole('tab', { name: 'By agent' }));

      await screen.findByTestId('roster-table');
      expect(screen.getByRole('tab', { name: 'By agent' }).getAttribute('aria-selected'))
        .toBe('true');
      expect(screen.getByRole('tab', { name: 'By campaign' }).getAttribute('aria-selected'))
        .toBe('false');
    });

    it('points both tabs at the panel they swap', async () => {
      // Otherwise they are two buttons beside an unrelated region and the
      // relationship exists only visually.
      renderPage();
      await screen.findByText('Renewals');

      const panel = screen.getByRole('tabpanel');
      for (const tab of screen.getAllByRole('tab')) {
        expect(tab.getAttribute('aria-controls')).toBe(panel.id);
      }
    });

    it('exposes no tablist at all to a role that gets only one view', async () => {
      // A tablist of one is a control with nothing to choose, announced as a
      // choice.
      mocks.useTenant.mockReturnValue(tenant({ role: 'viewer' }));

      renderPage();
      await screen.findByText('Renewals');

      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
    });
  });
});
