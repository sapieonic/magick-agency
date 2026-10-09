import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * The agent home — every campaign they are staffed on, and the way into each.
 *
 * ── What this file inherits ────────────────────────────────────────────────
 * The landing logic moved here from `AgentLanding` when master began allowing an
 * agent several assignments. Every case the old `AgentLanding.test.tsx` protected
 * is carried forward, and they are the ones worth naming because each records a
 * bug that shipped:
 *
 *  - the redirect fills in `?campaign=`, because `/station` alone lands on the
 *    console's "No campaign selected." refusal;
 *  - `?left=` must not be bounced back in, or an agent can never get out;
 *  - a failed ACCOUNT resolution must stop rather than spin forever;
 *  - a nullable `campaign_name` must not leave holes in the copy;
 *  - "nobody staffed you" and "we could not find out" are different screens.
 *
 * New here, and the reason this page exists: two assignments must both be
 * offered, and a campaign that is not taking calls must say so BEFORE the agent
 * clicks into a station that would refuse them.
 *
 * Assertions are about resolved LOCATIONS and rendered screens rather than about
 * hooks having been called — this defect class is navigational.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getMyAssignments: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agency', () => ({ getMyAssignments: mocks.getMyAssignments }));

import { AgentHomePage } from '../../pages/agency/AgentHomePage';

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(entry = '/dialer') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/dialer" element={<AgentHomePage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A resolved tenant context for an agent. Overridden per test. */
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

function assignment(over: Record<string, unknown> = {}) {
  return {
    campaign_id: 'camp-1',
    campaign_name: 'Renewals',
    campaign_status: 'running',
    assigned_at: '2026-08-16T09:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  mocks.getMyAssignments.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('AgentHomePage — one assignment', () => {
  it('sends the agent straight to their station, with ?campaign= filled in', async () => {
    /**
     * The common shift is one campaign, and making those agents click past a list
     * of one every morning would be a regression dressed as a feature. `?campaign=`
     * stays canonical: `/station` alone lands on the console's refusal, which is
     * the whole reason this is a redirect and not a link.
     */
    mocks.getMyAssignments.mockResolvedValue([assignment()]);

    renderAt();

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1'),
    );
  });

  it('STILL redirects when that one campaign is merely paused', async () => {
    /**
     * Core has no status check on join — a paused campaign accepts the agent and
     * they wait for their supervisor to resume it. An earlier version of
     * `assignmentEntry` blocked this, which meant a supervisor pausing for two
     * minutes locked every one of their agents out of the station. This case is the
     * fence around that.
     */
    mocks.getMyAssignments.mockResolvedValue([assignment({ campaign_status: 'paused' })]);

    renderAt();

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1'),
    );
  });

  it('does NOT redirect when that one campaign is terminal', async () => {
    // `stopped` will never send a call, so entering is pointless rather than
    // refused. The agent reads why on a page with a link, instead of sitting on a
    // dead station.
    mocks.getMyAssignments.mockResolvedValue([assignment({ campaign_status: 'stopped' })]);

    renderAt();

    await screen.findByText(/won’t start again/i);
    expect(screen.queryByTestId('where')).toBeNull();
    expect(screen.queryByRole('link', { name: /enter station/i })).toBeNull();
  });

  it('still redirects a name-less assignment — the id is what the redirect needs', async () => {
    mocks.getMyAssignments.mockResolvedValue([assignment({ campaign_name: null })]);

    renderAt();

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1'),
    );
  });

  it('redirects when the status could not be resolved at all', async () => {
    /**
     * `campaign_status` is null whenever master's best-effort lookup failed. The
     * campaign is very probably fine, so a null must not refuse — otherwise a
     * thirty-second core blip locks every agent out of a running campaign, which
     * is strictly worse than the refusal screen the status exists to avoid.
     */
    mocks.getMyAssignments.mockResolvedValue([assignment({ campaign_status: null })]);

    renderAt();

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1'),
    );
  });

  it('redirects on a status this client has never heard of', async () => {
    // Core owns the campaign lifecycle and master forwards its value verbatim, so
    // a status core adds arrives before this client knows the word. Refusing
    // unknown-to-us would lock agents out of a state core considers dialable.
    mocks.getMyAssignments.mockResolvedValue([assignment({ campaign_status: 'draining' })]);

    renderAt();

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1'),
    );
  });
});

describe('AgentHomePage — several assignments', () => {
  it('offers both rather than choosing for them', async () => {
    /**
     * The reason this page exists. A supervisor's staffing list says what an agent
     * MAY work; it cannot say what they are working at 2pm, and picking one for
     * them would be exactly the silent choice migration 064 removed from master.
     */
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: 'Collections' }),
    ]);

    renderAt();

    await screen.findByText('Renewals');
    expect(screen.getByText('Collections')).toBeTruthy();
    // No redirect: the agent chooses.
    expect(screen.queryByTestId('where')).toBeNull();

    const links = screen.getAllByRole('link', { name: /enter station/i });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/station?campaign=camp-1',
      '/station?campaign=camp-2',
    ]);
  });

  it('says that only one campaign can be worked at a time', async () => {
    // Being live on one campaign is core's session index, and an agent who does
    // not know that reads a refusal at the second station as a broken app.
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: 'Collections' }),
    ]);

    renderAt();

    expect(await screen.findByText(/only be on one campaign at a time/i)).toBeTruthy();
  });

  it('keeps a terminal campaign on the list, with its reason and no way in', async () => {
    // Removing it would leave the agent wondering where an assignment went; a
    // greyed control with no stated reason reads as an outage or a lost
    // permission — the house rule the console's disabled affordances follow.
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: 'Collections', campaign_status: 'stopped' }),
    ]);

    renderAt();

    await screen.findByText('Collections');
    expect(screen.getByText(/won’t start again/i)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /enter station/i })).toHaveLength(1);
    expect(screen.getByText(/closed/i)).toBeTruthy();
  });

  it('offers a paused campaign alongside a running one, with a note', async () => {
    // Both enterable. The note is context beside the control, not a substitute for
    // it — an agent may want to be at the station before it resumes.
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: 'Collections', campaign_status: 'paused' }),
    ]);

    renderAt();

    await screen.findByText('Collections');
    expect(screen.getAllByRole('link', { name: /enter station/i })).toHaveLength(2);
    expect(screen.getByText(/wait at the station/i)).toBeTruthy();
  });

  it('renders a name-less campaign without a hole where the name should be', async () => {
    /**
     * `campaign_name` is nullable on master's wire — a best-effort core lookup,
     * documented null for a core outage or a deleted campaign. Rendered unguarded,
     * a brief outage produced rows with empty names beside an "Enter station"
     * link, which reads as a broken app rather than a transient upstream.
     */
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: null }),
    ]);

    renderAt();

    expect(await screen.findByText('Unnamed campaign')).toBeTruthy();
    // The id still drives the link — the name was only ever presentation.
    expect(
      screen.getAllByRole('link', { name: /enter station/i })[1]!.getAttribute('href'),
    ).toBe('/station?campaign=camp-2');
  });
});

describe('AgentHomePage — the arrivals', () => {
  it('does not bounce an agent back into the station they just left', async () => {
    // Leave navigates here with `?left=station`. The assignments are unchanged, so
    // without the flag the redirect fires again immediately and the agent could
    // never get out.
    mocks.getMyAssignments.mockResolvedValue([assignment()]);

    renderAt('/dialer?left=station');

    await screen.findByText(/you’ve left the station/i);
    expect(screen.queryByTestId('where')).toBeNull();
    // A way back in that they choose, rather than one that chooses for them.
    expect(screen.getByRole('link', { name: /enter station/i }).getAttribute('href')).toBe(
      '/station?campaign=camp-1',
    );
  });

  it('says what happened after a refused join, and does not call it leaving', async () => {
    /**
     * The console's failure screen is full-viewport with no navigation on it, and
     * every route back used to resolve the assignment and return the agent to it.
     * `?left=refused` is the console's way of saying "do not send them straight
     * back", and it is a different sentence from a deliberate leave: telling
     * somebody they "left" when they were refused entry is a false account of what
     * just happened to them.
     */
    mocks.getMyAssignments.mockResolvedValue([assignment()]);

    renderAt('/dialer?left=refused');

    await screen.findByText(/that station didn’t open/i);
    expect(screen.queryByText(/you’ve left the station/i)).toBeNull();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('treats an unrecognised arrival value as an ordinary visit', async () => {
    // A hand-edited or stale URL must not strand an agent on a landing screen
    // when their station is available.
    mocks.getMyAssignments.mockResolvedValue([assignment()]);

    renderAt('/dialer?left=banana');

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1'),
    );
  });
});

describe('AgentHomePage — nothing to work, and nothing to say', () => {
  it('tells an unassigned agent who fixes it', async () => {
    // An empty array is master's steady state for "nobody has staffed this agent",
    // not a failure — and the two must not render the same, because one is fixed by
    // their supervisor and the other by support.
    mocks.getMyAssignments.mockResolvedValue([]);

    renderAt();

    await screen.findByText(/not assigned to a campaign yet/i);
    // An agent holds no permission that could staff them, so a "try again" here
    // would be an instruction to repeat something that cannot work.
    expect(screen.getByText(/ask your supervisor/i)).toBeTruthy();
  });

  it('says so when the check itself failed, rather than showing the unassigned copy', async () => {
    mocks.getMyAssignments.mockRejectedValue(new Error('Request Failed'));

    renderAt();

    await screen.findByText(/couldn’t check your campaigns/i);
    expect(screen.queryByText(/ask your supervisor/i)).toBeNull();
  });
});

describe('AgentHomePage — the account guards', () => {
  it('waits for both ids before asking', async () => {
    // `TenantContext` resolves the account asynchronously; a request sent in that
    // window carries no `X-Account-Id` and master answers a 400 that has nothing
    // to do with the agent's assignments.
    mocks.useTenant.mockReturnValue(tenant({ accountId: null, accountResolution: 'loading' }));

    renderAt();

    expect(mocks.getMyAssignments).not.toHaveBeenCalled();
  });

  /**
   * ── The spinner that never ends ────────────────────────────────────────────
   *
   * The effect waits for both ids, so with no account there is nothing in flight
   * and nothing will arrive. `RequireFlag`'s comment records that this bug used to
   * hit an `agent` on every sign-in: level 5 is below `account.read`'s `viewer`
   * floor, so `GET /accounts` 403s for them. Reintroducing it here, for the one
   * role the page was written for, is the shape of mistake worth being loud about.
   */
  it('stops on a failed account resolution instead of spinning', async () => {
    mocks.useTenant.mockReturnValue(
      tenant({ accountId: null, accountResolution: 'error', accountError: 'Forbidden' }),
    );

    renderAt();

    await screen.findByText(/couldn’t open your account/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('stops when resolution settles with no account at all', async () => {
    // A tenant with genuinely zero accounts, or a degraded fallback whose narrowed
    // list came back empty. Nothing fires again to set one.
    mocks.useTenant.mockReturnValue(tenant({ accountId: null, accountResolution: 'ready' }));

    renderAt();

    await screen.findByText(/couldn’t open your account/i);
  });
});

describe('AgentHomePage — who it is for', () => {
  it('sends a supervisor to the campaigns workspace and asks nothing', async () => {
    /**
     * A supervisor who opens `/dialer` is asking for the dialer, not for their own
     * staffing — they are usually staffed on nothing, so this page would tell them
     * "nobody has assigned you a campaign", which is true and useless.
     */
    mocks.useTenant.mockReturnValue(tenant({ role: 'account_admin' }));

    renderAt();

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/agency/campaigns'),
    );
    expect(mocks.getMyAssignments).not.toHaveBeenCalled();
  });

  it('serves an operator as an agent — they hold every agent permission', async () => {
    // The predicate is the persona, not `role === 'agent'`. An operator holds all
    // four agent permissions and no supervisory one.
    mocks.useTenant.mockReturnValue(tenant({ role: 'operator' }));
    mocks.getMyAssignments.mockResolvedValue([assignment()]);

    renderAt();

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1'),
    );
  });

  it('asks nothing while the role is still unresolved', () => {
    // Redirecting on an unresolved role would send an agent to the supervisor's
    // campaign list for a frame and then bounce them.
    mocks.useTenant.mockReturnValue(tenant({ role: undefined }));

    renderAt();

    expect(mocks.getMyAssignments).not.toHaveBeenCalled();
    expect(screen.queryByTestId('where')).toBeNull();
  });
});

/*
 * NEW in Magick Agency (decision B17): the exit for a viewer/operator on the
 * agent persona read "Back to MagickVoice"; it now reads "Go to settings" and
 * still lands on `/app`, this console's own platform zone. A dedicated agent
 * gets no exit at all (level 5 has nothing to return to).
 */
describe('AgentHomePage — the way to settings (B17)', () => {
  it('offers a viewer with nothing assigned "Go to settings" → /app', async () => {
    mocks.useTenant.mockReturnValue(tenant({ role: 'viewer' }));
    mocks.getMyAssignments.mockResolvedValue([]);

    renderAt();

    const link = await screen.findByRole('link', { name: 'Go to settings' });
    expect(link.getAttribute('href')).toBe('/app');
  });

  it('offers an operator with several campaigns the same exit', async () => {
    mocks.useTenant.mockReturnValue(tenant({ role: 'operator' }));
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: 'Collections' }),
    ]);

    renderAt();

    const link = await screen.findByRole('link', { name: 'Go to settings' });
    expect(link.getAttribute('href')).toBe('/app');
  });

  it('gives a dedicated agent no exit', async () => {
    mocks.getMyAssignments.mockResolvedValue([]);

    renderAt();

    await screen.findByRole('heading');
    expect(screen.queryByRole('link', { name: 'Go to settings' })).toBeNull();
    expect(screen.queryByText(/MagickVoice/i)).toBeNull();
  });
});

describe('AgentHomePage — the way to "My performance"', () => {
  /**
   * ── Why the link is here and nowhere else ──────────────────────────────────
   * This is the only screen a dedicated `agent` reliably passes through, so it is
   * the only place a link to their own numbers can live. It deliberately does NOT
   * go on the station: navigating away closes the station socket, and for up to 45
   * seconds afterwards core still has the agent in the dialable pool with no
   * console attached — a reservation landing in that window bridges a customer to
   * nobody (`agencyStationExit.ts`, and the reason Exit refuses while
   * `available`). A "check your stats" link beside a live call is that bug with a
   * friendly label.
   */
  it('offers it beside the campaign list', async () => {
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: 'Collections' }),
    ]);

    renderAt();

    // The nav replaced the old "See how I'm doing" / "See my calls" pair. Both
    // history destinations are still here — and so, now, is a marker saying
    // which screen the reader is on, which the old links could not express.
    expect((await screen.findByTestId('agent-nav-performance')).getAttribute('href'))
      .toBe('/dialer/performance');
    expect(screen.getByTestId('agent-nav-attempts').getAttribute('href'))
      .toBe('/dialer/attempts');
    expect(screen.getByTestId('agent-nav-campaigns').getAttribute('aria-current')).toBe('page');
  });

  it('offers it to an agent who has just left a station', async () => {
    // The one arrival where somebody most wants to look back at the shift.
    mocks.getMyAssignments.mockResolvedValue([assignment()]);

    renderAt('/dialer?left=station');

    // The nav replaced the old "See how I'm doing" / "See my calls" pair. Both
    // history destinations are still here — and so, now, is a marker saying
    // which screen the reader is on, which the old links could not express.
    expect((await screen.findByTestId('agent-nav-performance')).getAttribute('href'))
      .toBe('/dialer/performance');
    expect(screen.getByTestId('agent-nav-attempts').getAttribute('href'))
      .toBe('/dialer/attempts');
    expect(screen.getByTestId('agent-nav-campaigns').getAttribute('aria-current')).toBe('page');
  });

  it('offers it even to an agent who has been taken off every campaign', async () => {
    /**
     * Without it, an agent unstaffed from everything lands on "you're not assigned
     * to a campaign yet" — a screen with no navigation on it — and their own
     * history becomes unreachable at exactly the moment they most want to look at
     * it.
     */
    mocks.getMyAssignments.mockResolvedValue([]);

    renderAt();

    // The nav replaced the old "See how I'm doing" / "See my calls" pair. Both
    // history destinations are still here — and so, now, is a marker saying
    // which screen the reader is on, which the old links could not express.
    expect((await screen.findByTestId('agent-nav-performance')).getAttribute('href'))
      .toBe('/dialer/performance');
    expect(screen.getByTestId('agent-nav-attempts').getAttribute('href'))
      .toBe('/dialer/attempts');
    expect(screen.getByTestId('agent-nav-campaigns').getAttribute('aria-current')).toBe('page');
  });

  it('does NOT offer it when we could not even check their campaigns', async () => {
    // Nothing is known about this session yet, so pointing at another read of the
    // same backend is an invitation to a second failure.
    mocks.getMyAssignments.mockRejectedValue(new Error('Request Failed'));

    renderAt();

    await screen.findByText(/couldn’t check your campaigns/i);
    /*
     * By testid, because the copy this used to query for no longer exists. The
     * three sibling tests moved to `agent-nav-*` when `AgentNav` replaced the
     * hand-written links; this one kept `queryByRole('link', {name: /how i'm
     * doing/i})`, and `AgentNav` labels that destination "My performance" — so
     * the query matched nothing whether the nav was on the error card or not.
     * It passed for the wrong reason and guarded nothing.
     */
    expect(screen.queryByTestId('agent-nav-performance')).toBeNull();
    expect(screen.queryByTestId('agent-nav-attempts')).toBeNull();
    expect(screen.queryByTestId('agent-nav-campaigns')).toBeNull();
  });
});
