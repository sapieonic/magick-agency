import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * The agent home — every campaign they are staffed on, and the way into each.
 *
 * ── What this file inherits ────────────────────────────────────────────────
 * The landing logic moved here from `AgentLanding` when the API began allowing an
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
  getMyDay: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agency', () => ({ getMyAssignments: mocks.getMyAssignments }));
vi.mock('../../api/agencyStats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyStats')>()),
  getMyDay: mocks.getMyDay,
}));

import { AgentHomePage } from '../../pages/agency/AgentHomePage';
import { PARENT_BRAND } from '../helpers/parentBrand';

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
  mocks.getMyDay.mockRejectedValue(new Error('no my-day here'));
});

afterEach(() => cleanup());

/** The links into each list: the whole tile, named "Open <list>". */
const openLinks = () => screen.queryAllByRole('link', { name: /^Open / });

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
     * The API has no status check on join — a paused campaign accepts the agent and
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

    await screen.findByText('Ended by your supervisor. No more calls.');
    expect(screen.queryByTestId('where')).toBeNull();
    expect(openLinks()).toHaveLength(0);
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
     * `campaign_status` is null whenever the API's best-effort lookup failed. The
     * campaign is very probably fine, so a null must not refuse — otherwise a
     * thirty-second the API blip locks every agent out of a running campaign, which
     * is strictly worse than the refusal screen the status exists to avoid.
     */
    mocks.getMyAssignments.mockResolvedValue([assignment({ campaign_status: null })]);

    renderAt();

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1'),
    );
  });

  it('redirects on a status this client has never heard of', async () => {
    // The API owns the campaign lifecycle and the API forwards its value unchanged, so
    // a status the API adds arrives before this client knows the word. Refusing
    // unknown-to-us would lock agents out of a state the API considers dialable.
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
     * them would be exactly the silent choice the server no longer makes.
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

    const links = openLinks();
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(['Open Renewals', 'Open Collections']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/station?campaign=camp-1',
      '/station?campaign=camp-2',
    ]);
  });

  it('says that only one list can be worked at a time', async () => {
    // Being live on one campaign is the API's session index, and an agent who does
    // not know that reads a refusal at the second station as a broken app.
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: 'Collections' }),
    ]);

    renderAt();

    expect(await screen.findByText('You can work on only one list at a time.')).toBeTruthy();
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
    expect(screen.getByText('Ended by your supervisor. No more calls.')).toBeTruthy();
    // AS1: hidden, not greyed. The stopped tile has no way in at all.
    expect(openLinks().map((l) => l.getAttribute('aria-label'))).toEqual(['Open Renewals']);
    const stopped = screen.getAllByTestId('work-tile')[1]!;
    expect(stopped.getAttribute('data-closed')).toBe('true');
    expect(stopped.querySelector('a')).toBeNull();
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
    expect(openLinks()).toHaveLength(2);
    expect(screen.getByText('Paused by your supervisor')).toBeTruthy();
    expect(screen.getByText('Calling is on')).toBeTruthy();
  });

  it('renders a name-less campaign without a hole where the name should be', async () => {
    /**
     * `campaign_name` is nullable on the API's wire — a best-effort the API lookup,
     * documented null for the API outage or a deleted campaign. Rendered unguarded,
     * a brief outage produced rows with empty names beside an "Enter station"
     * link, which reads as a broken app rather than a transient upstream.
     */
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: null }),
    ]);

    renderAt();

    expect(await screen.findByText('Unnamed list')).toBeTruthy();
    // The id still drives the link — the name was only ever presentation.
    expect(openLinks()[1]!.getAttribute('href')).toBe('/station?campaign=camp-2');
  });
});

describe('AgentHomePage — the arrivals', () => {
  it('does not bounce an agent back into the station they just left', async () => {
    // Leave navigates here with `?left=station`. The assignments are unchanged, so
    // without the flag the redirect fires again immediately and the agent could
    // never get out.
    mocks.getMyAssignments.mockResolvedValue([assignment()]);

    renderAt('/dialer?left=station');

    await screen.findByText('Work finished for now');
    expect(screen.queryByTestId('where')).toBeNull();
    // A way back in that they choose, rather than one that chooses for them.
    expect(screen.getByRole('link', { name: 'Open Renewals' }).getAttribute('href')).toBe(
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

    await screen.findByText('Your work did not open');
    expect(screen.queryByText('Work finished for now')).toBeNull();
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
    // An empty array is the API's steady state for "nobody has staffed this agent",
    // not a failure — and the two must not render the same, because one is fixed by
    // their supervisor and the other by support.
    mocks.getMyAssignments.mockResolvedValue([]);

    renderAt();

    await screen.findByText('No work for you yet');
    // An agent holds no permission that could staff them, so a "try again" here
    // would be an instruction to repeat something that cannot work.
    expect(screen.getByText(/ask your supervisor/i)).toBeTruthy();
  });

  it('says so when the check itself failed, rather than showing the unassigned copy', async () => {
    mocks.getMyAssignments.mockRejectedValue(new Error('Request Failed'));

    renderAt();

    await screen.findByText('We could not load your work');
    expect(screen.queryByText(/ask your supervisor/i)).toBeNull();
    // The station's own words (AS15), never the server's or the client's sentence.
    expect(document.body.textContent).not.toContain('Request Failed');
  });

  it('reads the list again on Try again, and shows it once it loads', async () => {
    mocks.getMyAssignments
      .mockRejectedValueOnce(new Error('Request Failed'))
      .mockResolvedValueOnce([assignment(), assignment({ campaign_id: 'camp-2', campaign_name: 'Collections' })]);

    renderAt();

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByText('Collections');
    expect(mocks.getMyAssignments).toHaveBeenCalledTimes(2);
  });
});

describe('AgentHomePage — the account guards', () => {
  it('waits for both ids before asking', async () => {
    // `TenantContext` resolves the account asynchronously; a request sent in that
    // window carries no `X-Account-Id` and the API answers a 400 that has nothing
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
 * The exit for a viewer/operator on the agent persona: it read a back link to the old
 * platform (B17), then "Go to settings", which opened Profile and appearance. It now
 * reads "Open the console" and lands where `/agency` lands them, the campaign list
 * (`agencyLandingPath`). A dedicated agent gets no exit at all (level 5 has nothing
 * to return to).
 */
describe('AgentHomePage — the way back to the console', () => {
  it('offers a viewer with nothing assigned "Open the console" → the campaign list', async () => {
    mocks.useTenant.mockReturnValue(tenant({ role: 'viewer' }));
    mocks.getMyAssignments.mockResolvedValue([]);

    renderAt();

    const link = await screen.findByRole('link', { name: 'Open the console' });
    expect(link.getAttribute('href')).toBe('/agency/campaigns');
  });

  it('offers an operator with several campaigns the same exit', async () => {
    mocks.useTenant.mockReturnValue(tenant({ role: 'operator' }));
    mocks.getMyAssignments.mockResolvedValue([
      assignment(),
      assignment({ campaign_id: 'camp-2', campaign_name: 'Collections' }),
    ]);

    renderAt();

    const link = await screen.findByRole('link', { name: 'Open the console' });
    expect(link.getAttribute('href')).toBe('/agency/campaigns');
  });

  it('gives a dedicated agent no exit', async () => {
    mocks.getMyAssignments.mockResolvedValue([]);

    renderAt();

    await screen.findByRole('heading');
    expect(screen.queryByRole('link', { name: 'Open the console' })).toBeNull();
    expect(screen.queryByText(PARENT_BRAND)).toBeNull();
  });
});

describe('AgentHomePage — the way to "My performance"', () => {
  /**
   * ── Why the link is here and nowhere else ──────────────────────────────────
   * This is the only screen a dedicated `agent` reliably passes through, so it is
   * the only place a link to their own numbers can live. It deliberately does NOT
   * go on the station: navigating away closes the station socket, and for up to 45
   * seconds afterwards the API still has the agent in the dialable pool with no
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

    await screen.findByText('We could not load your work');
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

describe('AgentHomePage — the tiles (spec §3 01, AS1, AS15)', () => {
  const TWO = () => [
    assignment(),
    assignment({ campaign_id: 'camp-2', campaign_name: 'Collections', campaign_status: 'paused' }),
  ];
  const day = (today: number, overdue: number) => ({ call_later: { rows: [], today, overdue, comes_to_me: true, left_today_goes_to: 'waits_for_me' } });

  it('shows the agent’s call-laters today on each tile the agent can open', async () => {
    mocks.getMyAssignments.mockResolvedValue(TWO());
    mocks.getMyDay.mockImplementation((id: string) => Promise.resolve(id === 'camp-1' ? day(3, 1) : day(0, 0)));

    renderAt();

    const later = await screen.findByTestId('work-tile-call-later');
    expect(later.textContent).toBe('Call later · 3 today · 1 late');
    // None due on the other list: the line is hidden, not "0 today".
    expect(screen.getAllByTestId('work-tile-call-later')).toHaveLength(1);
    expect(mocks.getMyDay).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');
    expect(mocks.getMyDay).toHaveBeenCalledWith('camp-2', 'tenant-1', 'account-1');
    // Read as the tile's description, after its name.
    const link = screen.getByRole('link', { name: 'Open Renewals' });
    expect(link.getAttribute('aria-describedby')!.split(' ')).toContain(later.id);
  });

  it('leaves the call-later line off when the agent’s day cannot be read', async () => {
    mocks.getMyAssignments.mockResolvedValue(TWO());

    renderAt();

    await screen.findByText('Collections');
    await waitFor(() => expect(mocks.getMyDay).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('work-tile-call-later')).toBeNull();
  });

  it('never reads the day of a list that cannot be opened, nor on the way to a redirect', async () => {
    mocks.getMyAssignments.mockResolvedValue([assignment(), assignment({ campaign_id: 'camp-2', campaign_status: 'completed' })]);
    renderAt();
    await screen.findByText('Finished. Every customer was called.');
    await waitFor(() => expect(mocks.getMyDay).toHaveBeenCalledTimes(1));
    expect(mocks.getMyDay).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');
    cleanup();

    mocks.getMyDay.mockClear();
    mocks.getMyAssignments.mockResolvedValue([assignment()]);
    renderAt();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1'));
    expect(mocks.getMyDay).not.toHaveBeenCalled();
  });

  it('wears the station’s band, and its tiles and band never say the jargon (spec §6.6)', async () => {
    mocks.getMyAssignments.mockResolvedValue([
      ...TWO(),
      assignment({ campaign_id: 'camp-3', campaign_name: 'Old list', campaign_status: 'stopped' }),
    ]);

    renderAt();

    await screen.findByText('Old list');
    expect(screen.getByTestId('band-title').textContent).toBe('Namaste');
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Choose your work for today.');
    const words = `${screen.getByTestId('station-band').textContent} ${screen.getByTestId('work-tiles').textContent}`;
    expect(words).not.toMatch(/campaign|station|session|available|offline/i);
  });

  it('puts every way in on the keyboard, one stop per tile', async () => {
    mocks.getMyAssignments.mockResolvedValue(TWO());

    renderAt();

    await screen.findByText('Collections');
    for (const tile of screen.getAllByTestId('work-tile')) {
      const links = within(tile).getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(links[0]!.tabIndex).toBe(0);
    }
  });
});
