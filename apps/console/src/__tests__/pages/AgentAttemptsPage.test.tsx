import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgencyAttempt, AgencyKeysetPage } from '../../types/agency-spine';

/**
 * "My calls" — the agent's own dial history, at `/dialer/attempts`.
 *
 * ── What this file exists to prevent ───────────────────────────────────────
 * "Renders 200 with rows" passes against a list that shows only the calls that
 * connected, which is the list the platform already had. So the assertions here
 * are about the rows and states a naive render loses:
 *
 *  1. **The account-resolution trap.** An `agent` is level 5, below
 *     `account.read`'s `viewer` floor, so `GET /accounts` 403s for them. Every
 *     read waits for both ids — and "resolution settled with no account" must be
 *     an ERROR rather than a permanent spinner, because with no account nothing is
 *     in flight and nothing fires again. `AgentHomePage`, `RequireFlag` and
 *     `AgencyAnalyticsPage` all carry this guard and all three got it wrong first.
 *  2. **Three absences, told apart.** A failed read, a genuinely empty result, and
 *     a null field on a row are three different sentences. A `talk_seconds` of
 *     `null` on a call that never bridged is ORDINARY, and rendering it as `0`
 *     would tell somebody they spoke to a customer for no time at all when in
 *     truth they never got the customer.
 *  3. **Keyset paging, honestly.** "Load more" appends; a filter change resets the
 *     cursor; a response that has been overtaken is discarded rather than shown
 *     under the newer filter's controls.
 *  4. **The campaign column degrades truthfully.** The row carries an id and no
 *     name, and a campaign somebody was unstaffed from still has their calls on
 *     it.
 *  5. **There is no CSV export, deliberately** — the API's performance plugin has
 *     no csv route, so a button would 404 every time it was pressed.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getMyAttempts: vi.fn(),
  getAgentAttempts: vi.fn(),
  getMyCampaigns: vi.fn(),
  getMyStats: vi.fn(),
  getAgentStats: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyStats', () => ({
  getMyAttempts: mocks.getMyAttempts,
  getAgentAttempts: mocks.getAgentAttempts,
  getMyCampaigns: mocks.getMyCampaigns,
  getMyStats: mocks.getMyStats,
  getAgentStats: mocks.getAgentStats,
}));

import { AgentAttemptsPage } from '../../pages/agency/AgentAttemptsPage';

/** Connected, written up, real talk time. */
const CONNECTED: AgencyAttempt = {
  id: 'attempt-connected', contact_id: 'contact-1', campaign_id: 'camp-1', attempt_number: 2,
  phone_e164: '+919876500001', caller_id: '+919000000001',
  agent_user_id: 'user-1', agent_name: 'Ravi Menon', reserved_agent_id: 'session-1',
  state: 'ended', outcome: 'connected', disposition_code: 'not_interested',
  notes: 'asked us to call after 6pm', callback_at: null,
  dispositioned_by_user_id: 'user-1', dispositioned_at: '2026-08-20T10:00:00.000Z',
  dispositioned_on_behalf: false, webrtc_call_id: 'call-9',
  dialed_at: '2026-08-20T09:59:00.000Z', answered_at: '2026-08-20T09:59:10.000Z',
  bridged_at: '2026-08-20T09:59:12.000Z', ended_at: '2026-08-20T09:59:59.000Z',
  talk_seconds: 47, wrapup_seconds: 20, created_at: '2026-08-20T09:58:00.000Z',
};

/**
 * The row this list exists for, from the agent's side: the customer answered and
 * the call never bridged. `talk_seconds` is null — not zero — and it belongs to a
 * DIFFERENT campaign, which is the fact no campaign-scoped view can show.
 */
const NEVER_BRIDGED: AgencyAttempt = {
  ...CONNECTED, id: 'attempt-never-bridged', contact_id: 'contact-2', campaign_id: 'camp-2',
  attempt_number: 1, phone_e164: '+919876500002', state: 'ended', outcome: 'no_answer',
  disposition_code: null, notes: null, dispositioned_by_user_id: null,
  dispositioned_at: null, webrtc_call_id: null, bridged_at: null,
  talk_seconds: null, wrapup_seconds: null, created_at: '2026-08-20T09:40:00.000Z',
};

/** A campaign this person was unstaffed from, so no name resolves for it. */
const UNRESOLVABLE_CAMPAIGN: AgencyAttempt = {
  ...NEVER_BRIDGED, id: 'attempt-orphan-campaign',
  campaign_id: '4f21ab90-1111-4222-8333-444455556666',
  created_at: '2026-08-19T11:00:00.000Z',
};

function page(rows: AgencyAttempt[], nextCursor: string | null = null): AgencyKeysetPage<AgencyAttempt> {
  return { rows, next_cursor: nextCursor, limit: 50 };
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/dialer/attempts']}>
      <AgentAttemptsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  mocks.getMyAttempts.mockResolvedValue(page([CONNECTED, NEVER_BRIDGED]));
  mocks.getMyCampaigns.mockResolvedValue([
    staffing(),
    staffing({ campaign_id: 'camp-2', campaign_name: 'Collections', active: false }),
  ]);
});

afterEach(cleanup);

describe('AgentAttemptsPage — the account-resolution trap', () => {
  it('stops with an error rather than spinning when resolution settles with no account', async () => {
    /**
     * The precise bug. `accountResolution` can reach `ready`/`degraded`/`error`
     * with `accountId === null` — a tenant with genuinely zero accounts, or a
     * `'degraded'` fallback whose narrowed list came back empty — and nothing
     * fires again to set one. Both reads on this page wait for both ids, so
     * without this branch the spinner is permanent.
     */
    mocks.useTenant.mockReturnValue(tenant({ accountId: null, accountResolution: 'ready' }));

    renderPage();

    expect(await screen.findByText(/couldn’t open your account/i)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocks.getMyAttempts).not.toHaveBeenCalled();
    expect(mocks.getMyCampaigns).not.toHaveBeenCalled();
  });

  it('spins, rather than refusing, while resolution is still in flight', () => {
    // A refusal shown for one frame is a refusal the user remembers.
    mocks.useTenant.mockReturnValue(tenant({ accountId: null, accountResolution: 'loading' }));
    renderPage();
    expect(screen.queryByText(/couldn’t open your account/i)).toBeNull();
  });

  it('surfaces a failed account resolution with the server’s own detail', async () => {
    mocks.useTenant.mockReturnValue(
      tenant({ accountId: null, accountResolution: 'error', accountError: 'Forbidden' }),
    );
    renderPage();
    expect(await screen.findByText(/Forbidden/)).toBeTruthy();
  });

  it('spins rather than refusing while the ROLE has not resolved, and reads the moment it lands', async () => {
    /**
     * `TenantContext` fills `role` in asynchronously, so this is every cold
     * sign-in for one frame. Two things have to be true and they pull in opposite
     * directions:
     *
     *  - a **spinner**, never a refusal. A refusal shown for one frame is a
     *    refusal the user remembers, and `persona === null` covers "not resolved
     *    yet" far more often than it covers "no place in the dialer".
     *  - and it must **resolve on its own**. `AgentSurfaceShell` withholds its
     *    children until the persona is known, so unlike `/dialer/performance` —
     *    which calls its stats hook in the page body, above the shell — the list
     *    read here waits for the role. That costs one render, not a round trip,
     *    and it buys something: a role genuinely below the station floor issues no
     *    request at all rather than a 403 nothing reads.
     *
     * The failure this pins is the third possibility: a spinner that never becomes
     * anything. So the role is made to arrive, and the read must follow with no
     * further input.
     */
    mocks.useTenant.mockReturnValue(tenant({ role: undefined }));
    const { rerender } = renderPage();

    expect(screen.getByRole('status')).toBeTruthy();
    expect(mocks.getMyAttempts).not.toHaveBeenCalled();

    mocks.useTenant.mockReturnValue(tenant());
    rerender(
      <MemoryRouter initialEntries={['/dialer/attempts']}>
        <AgentAttemptsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.getMyAttempts).toHaveBeenCalled());
    expect(await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`)).toBeTruthy();
  });

  it('sends BOTH ids on every read', async () => {
    // `apiFetch` sends `X-Account-Id` only when the fourth argument is present,
    // and the API requires it — an omitted one does not degrade, it produces a 400
    // about a header this client never sent.
    renderPage();
    await waitFor(() => expect(mocks.getMyAttempts).toHaveBeenCalled());
    const call = mocks.getMyAttempts.mock.calls[0]!;
    expect(call[2]).toBe('tenant-1');
    expect(call[3]).toBe('account-1');
  });
});

describe('AgentAttemptsPage — the rows a call list cannot show', () => {
  it('reads the caller-scoped route, never the supervisor twin', async () => {
    /**
     * `my-attempts` takes no subject: The API scopes it to the caller. A page that
     * reached for the twin here would be naming the subject of its own history,
     * which is exactly what the paired routes exist to make impossible — and it
     * would 403 for the only role this page is for.
     */
    renderPage();
    await waitFor(() => expect(mocks.getMyAttempts).toHaveBeenCalled());
    expect(mocks.getAgentAttempts).not.toHaveBeenCalled();
  });

  it('shows a call that never bridged beside one that connected', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);
    expect(screen.getByTestId(`my-attempt-row-${NEVER_BRIDGED.id}`)).toBeTruthy();
  });

  it('never renders a null talk time as 0', async () => {
    /**
     * The rule this whole surface is built on, in the one place it bites hardest.
     * `talk_seconds` is null on every call that never bridged — abandoned, no
     * answer, failed — which is ordinary rather than missing data. `0:00` there
     * says the agent had the customer and said nothing.
     */
    renderPage();
    const cell = await screen.findByTestId(`my-attempt-talk-${NEVER_BRIDGED.id}`);
    expect(cell.textContent).toBe('—');
    expect(cell.textContent).not.toContain('0');

    // And a real zero is still a real zero, so the em dash is not a blanket rule.
    expect(screen.getByTestId(`my-attempt-talk-${CONNECTED.id}`).textContent).toBe('0:47');
  });

  it('says "not written up" rather than leaving the write-up blank', async () => {
    // An empty cell reads as data we failed to load. Nobody wrote this call up,
    // which is a fact about the call.
    renderPage();
    const row = await screen.findByTestId(`my-attempt-row-${NEVER_BRIDGED.id}`);
    expect(within(row).getByText('Not written up')).toBeTruthy();
  });

  it('counts what is shown and never claims a total the API cannot produce', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);
    const count = screen.getByTestId('attempts-count').textContent ?? '';
    expect(count).toContain('Showing 2 calls');
    // "2 of N" would be a number nothing counted: `AgencyKeysetPage` has no total
    // by design, because counting a filtered set of up to a million rows costs a
    // second scan for a figure that is stale on arrival.
    expect(count).not.toMatch(/\bof\s+\d/);
  });
});

describe('AgentAttemptsPage — the campaign column', () => {
  it('names the campaign each call belonged to', async () => {
    /**
     * The column that makes this list different from `/campaigns/:id/attempts`,
     * where the URL is the answer. Two campaigns in one shift is the ordinary case
     * for an agency, and it is the case no campaign-scoped view can show.
     */
    renderPage();
    const first = await screen.findByTestId(`my-attempt-campaign-${CONNECTED.id}`);
    expect(first.textContent).toBe('Renewals');
    expect(screen.getByTestId(`my-attempt-campaign-${NEVER_BRIDGED.id}`).textContent)
      .toBe('Collections');
  });

  it('resolves the names from ONE staffing read, never one request per row', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);
    expect(mocks.getMyCampaigns).toHaveBeenCalledTimes(1);
  });

  it('includes campaigns the agent was UNSTAFFED from', async () => {
    /**
     * Why the history and not `my-assignments`: that route is right to hide an
     * ended assignment, because it answers "where may I go now". This column asks
     * a different question, and a campaign somebody was taken off still has their
     * calls on it.
     */
    renderPage();
    await screen.findByTestId(`my-attempt-row-${NEVER_BRIDGED.id}`);
    // `camp-2` is `active: false` in the fixture and still resolves to a name.
    expect(screen.getByTestId(`my-attempt-campaign-${NEVER_BRIDGED.id}`).textContent)
      .toBe('Collections');
  });

  it('falls back to a shortened id for a campaign nothing can name', async () => {
    /**
     * The honest degradation. A campaign the API could not identify still has real
     * attempts, so a BLANK cell would say the dial belonged to nothing — and a
     * bare 36-character UUID dressed as a name is something no reader can use.
     * `Campaign 4f21ab90` is neither: it says "a campaign, and here is enough of
     * its id to chase it".
     */
    mocks.getMyAttempts.mockResolvedValue(page([UNRESOLVABLE_CAMPAIGN]));
    renderPage();

    const cell = await screen.findByTestId(`my-attempt-campaign-${UNRESOLVABLE_CAMPAIGN.id}`);
    expect(cell.textContent).toBe('Campaign 4f21ab90');
    expect(cell.textContent).not.toBe('');
    expect(cell.textContent).not.toBe(UNRESOLVABLE_CAMPAIGN.campaign_id);
    // The whole id is still reachable, for a supervisor chasing it in the API.
    expect(cell.getAttribute('title')).toBe(UNRESOLVABLE_CAMPAIGN.campaign_id);
  });

  it('shows the calls even when the staffing read failed outright', async () => {
    /**
     * The names are a courtesy; the dials are the point. A failed `my-campaigns`
     * must not withhold the history, and must not raise an alert over a table that
     * loaded perfectly well.
     */
    mocks.getMyCampaigns.mockRejectedValue(new Error('Request Failed (req_1)'));
    renderPage();

    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);
    expect(screen.getByTestId(`my-attempt-campaign-${CONNECTED.id}`).textContent)
      .toBe('Campaign camp-1');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('AgentAttemptsPage — the three absences', () => {
  it('shows a spinner while the first page is in flight', () => {
    mocks.getMyAttempts.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('surfaces a failed read with the server’s own sentence, and offers a retry', async () => {
    // These failures are mostly permission- or connectivity-shaped and our own
    // sentence would be a guess.
    mocks.getMyAttempts.mockRejectedValue(new Error('Request Failed (req_7)'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('req_7');
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeTruthy();
  });

  it('calls an empty UNFILTERED result a steady state, not a failure', async () => {
    /**
     * The absence a naive render loses. Somebody who has taken no calls is not an
     * error, and must not be told in the voice of one — the same rule the
     * performance panel applies to its own empty range.
     */
    mocks.getMyAttempts.mockResolvedValue(page([]));
    renderPage();

    expect(await screen.findByText('You haven’t taken any calls yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does NOT claim they have taken no calls when a filter is what emptied the list', async () => {
    /**
     * An answer about the query presented as an answer about the person — the
     * exact defect `AgencyCampaignAttemptsPage` shipped by omitting a key from its
     * `filtered` check. Telling an agent who filtered to one bad afternoon that
     * they have never taken a call is the worst sentence this screen could produce.
     */
    mocks.getMyAttempts.mockResolvedValue(page([]));
    renderPage();
    await screen.findByText('You haven’t taken any calls yet');

    fireEvent.click(screen.getByLabelText('Abandoned (no agent free)'));
    fireEvent.click(screen.getByText('Apply'));

    expect(await screen.findByText('No calls match those filters')).toBeTruthy();
    expect(screen.queryByText('You haven’t taken any calls yet')).toBeNull();
  });

  it('keeps the rows on screen when LOAD MORE is what failed', async () => {
    /**
     * The rows already fetched are still good. Blanking them because asking for
     * MORE of them failed throws away exactly what the reader came for, so the
     * failure sits beside the button.
     */
    mocks.getMyAttempts
      .mockResolvedValueOnce(page([CONNECTED], 'cursor-2'))
      .mockRejectedValueOnce(new Error('Upstream unavailable'));
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.click(screen.getByTestId('attempts-load-more'));

    expect((await screen.findByTestId('attempts-more-error')).textContent)
      .toContain('Upstream unavailable');
    expect(screen.getByTestId(`my-attempt-row-${CONNECTED.id}`)).toBeTruthy();
  });
});

describe('AgentAttemptsPage — keyset paging', () => {
  it('follows the cursor and APPENDS, never replacing', async () => {
    mocks.getMyAttempts
      .mockResolvedValueOnce(page([CONNECTED], 'cursor-2'))
      .mockResolvedValueOnce(page([NEVER_BRIDGED]));
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.click(screen.getByTestId('attempts-load-more'));

    await screen.findByTestId(`my-attempt-row-${NEVER_BRIDGED.id}`);
    // Both on screen: a keyset page is a continuation, not a replacement.
    expect(screen.getByTestId(`my-attempt-row-${CONNECTED.id}`)).toBeTruthy();
    expect(mocks.getMyAttempts.mock.calls[1]?.[1]).toEqual({ cursor: 'cursor-2', limit: 50 });
  });

  it('offers no "load more" once the cursor runs out', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);
    expect(screen.queryByTestId('attempts-load-more')).toBeNull();
  });

  it('RESETS the cursor when a filter changes', async () => {
    /**
     * The defect keyset pagination is most prone to. Without this, applying a
     * filter after a "load more" sends the OLD query's cursor with the NEW query's
     * filters — appending page 2 of one question to page 1 of another and
     * producing a list that is internally inconsistent for reasons nothing on
     * screen explains.
     *
     * It holds by construction rather than by care: the cursor lives in
     * `useAgentAttempts` and the panel never sees it, so there is no code path in
     * which a caller can change a filter and keep a cursor.
     */
    mocks.getMyAttempts
      .mockResolvedValueOnce(page([CONNECTED], 'cursor-2'))
      .mockResolvedValueOnce(page([NEVER_BRIDGED], 'cursor-3'))
      .mockResolvedValueOnce(page([UNRESOLVABLE_CAMPAIGN]));
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.click(screen.getByTestId('attempts-load-more'));
    await screen.findByTestId(`my-attempt-row-${NEVER_BRIDGED.id}`);

    fireEvent.click(screen.getByLabelText('Abandoned (no agent free)'));
    fireEvent.click(screen.getByText('Apply'));

    await screen.findByTestId(`my-attempt-row-${UNRESOLVABLE_CAMPAIGN.id}`);
    const filteredCall = mocks.getMyAttempts.mock.calls[2]!;
    expect(filteredCall[0]).toEqual({ outcome: ['abandoned'] });
    expect(filteredCall[1].cursor).toBeUndefined();
    // And the previous query's rows are GONE rather than sitting under the new
    // filter's controls.
    expect(screen.queryByTestId(`my-attempt-row-${CONNECTED.id}`)).toBeNull();
    expect(screen.queryByTestId(`my-attempt-row-${NEVER_BRIDGED.id}`)).toBeNull();
  });

  it('discards a first page that a newer read overtook', async () => {
    /**
     * Change a filter twice quickly and the slow response lands last. Applying it
     * would leave rows that do not match the controls above them, which reads as a
     * broken filter rather than as a race — so the reader's next move is to
     * distrust the whole screen. `decideListResponse` owns the rule; this asserts
     * the page actually obeys it.
     */
    const resolvers: ((value: AgencyKeysetPage<AgencyAttempt>) => void)[] = [];
    mocks.getMyAttempts.mockImplementation(
      () => new Promise<AgencyKeysetPage<AgencyAttempt>>((res) => resolvers.push(res)),
    );

    renderPage();
    await waitFor(() => expect(resolvers.length).toBe(1));

    fireEvent.click(screen.getByLabelText('Abandoned (no agent free)'));
    fireEvent.click(screen.getByText('Apply'));
    await waitFor(() => expect(resolvers.length).toBe(2));

    // The FIRST (now stale) read lands last, carrying a row the newer query did
    // not ask for.
    resolvers[0]!(page([CONNECTED]));
    resolvers[1]!(page([NEVER_BRIDGED]));

    await screen.findByTestId(`my-attempt-row-${NEVER_BRIDGED.id}`);
    expect(screen.queryByTestId(`my-attempt-row-${CONNECTED.id}`)).toBeNull();
  });
});

describe('AgentAttemptsPage — the filters', () => {
  it('sends the outcome filter as it was ticked', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.click(screen.getByLabelText('Abandoned (no agent free)'));
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() =>
      expect(mocks.getMyAttempts).toHaveBeenLastCalledWith(
        { outcome: ['abandoned'] }, { cursor: undefined, limit: 50 }, 'tenant-1', 'account-1',
      ),
    );
  });

  it('sends the attempt state and the campaign together', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.click(screen.getByLabelText('Ended'));
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'camp-2' } });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() =>
      expect(mocks.getMyAttempts.mock.calls.at(-1)?.[0]).toEqual({
        state: ['ended'],
        campaign_id: 'camp-2',
      }),
    );
  });

  it('searches by phone number, sending the param alongside every other filter', async () => {
    /**
     * The control was REMOVED once, and pinning why is the point of this test.
     * The API's whitelist for the two agent routes did not carry `phone` and
     * `forwardAllowedQuery` dropped an unlisted key SILENTLY, so the search
     * answered 200 with the person's entire unfiltered history presented as the
     * matches. Every row wrong, more rows than were asked for, and nothing on
     * screen saying so.
     *
     * Both halves have landed on the API — `phone` is forwarded, and an unknown key
     * is now rejected with a 400 rather than dropped — so the search is real and
     * the input is back.
     *
     * Asserted alongside every other filter rather than on its own, so the
     * assertion covers a fully populated request: the failure mode a phone-only
     * test would miss is a `phone` that displaces one of the keys built beside it.
     */
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.click(screen.getByLabelText('Ended'));
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'camp-2' } });
    // With surrounding space, because a number pasted out of a complaint carries
    // one and it is not part of the number.
    fireEvent.change(screen.getByTestId('phone-filter'), {
      target: { value: '  500001 ' },
    });
    fireEvent.change(screen.getByLabelText('First day'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('Last day'), { target: { value: '2026-08-03' } });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() =>
      expect(mocks.getMyAttempts.mock.calls.at(-1)?.[0]).toMatchObject({
        state: ['ended'],
        campaign_id: 'camp-2',
        phone: '500001',
      }),
    );
  });

  it('counts the phone search on the filter badge, and offers Clear for it alone', async () => {
    /**
     * The two shared helpers in `agencyAttemptFilters` COUNT `phone`, and the
     * count happens there rather than here.
     *
     * They used to exclude it, written while this surface had no such control so
     * that an empty result could not read as "nothing matched" for a search that
     * was never sent. With the search real, the exclusion inverted into the same
     * lie the other way round: a narrowed list with no Clear button and a badge
     * claiming nothing is applied. Both halves landed on the API — `phone` is
     * forwarded on the agent routes and an unknown key is now rejected rather
     * than dropped — so the helpers changed, in the leaf module.
     *
     * `AgentAttemptsPanel` deliberately does NOT correct it at the call site,
     * and says so: a local `|| Boolean(filters.phone)` is exactly how the two
     * surfaces sharing those helpers drift. What is pinned here is the behaviour
     * this page shows, wherever the arithmetic lives.
     */
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    expect(screen.queryByText('Clear')).toBeNull();

    fireEvent.change(screen.getByTestId('phone-filter'), {
      target: { value: '500001' },
    });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(screen.getByText('Clear')).toBeTruthy());

    // And Clear empties the box as well as the applied set — a draft left behind
    // is a filter the reader can see and the list no longer has.
    fireEvent.click(screen.getByText('Clear'));
    await waitFor(() =>
      expect(mocks.getMyAttempts.mock.calls.at(-1)?.[0]).not.toHaveProperty('phone'),
    );
    expect((screen.getByTestId('phone-filter') as HTMLInputElement).value).toBe('');
  });

  it('offers only campaigns it can NAME in the picker', async () => {
    /**
     * The column and the picker answer different questions, so they degrade
     * differently. A row is TOLD to the reader, so a shortened id is better than a
     * blank; an option is CHOSEN by them, and `Campaign 4f21ab90` is not something
     * anybody can recognise well enough to pick.
     */
    mocks.getMyCampaigns.mockResolvedValue([staffing(), staffing({ campaign_id: 'camp-3', campaign_name: null })]);
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    const options = [...screen.getByTestId('campaign-filter').querySelectorAll('option')]
      .map((option) => option.getAttribute('value'));
    expect(options).toEqual(['', 'camp-1']);
  });

  it('turns two day pickers into an INCLUSIVE range', async () => {
    /**
     * The convention that differs from the performance page one link away:
     * `/my-attempts` has an inclusive `to` on `created_at`, `/my-stats` an
     * exclusive one on `dialed_at`. A single-day range is where getting it wrong
     * is total — the whole result vanishes and the reader is told they took no
     * calls.
     */
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.change(screen.getByLabelText('First day'), { target: { value: '2026-08-03' } });
    fireEvent.change(screen.getByLabelText('Last day'), { target: { value: '2026-08-03' } });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(mocks.getMyAttempts.mock.calls.length).toBeGreaterThan(1));
    const sent = mocks.getMyAttempts.mock.calls.at(-1)![0] as { from: string; to: string };
    expect(new Date(sent.to).getTime()).toBeGreaterThan(new Date(sent.from).getTime());
    expect(new Date(sent.to).getDate()).toBe(3);
  });

  it('says what the range means, in words that are not the stats page’s words', async () => {
    // Two sibling screens, two conventions. Borrowing the other one's vocabulary
    // would put one label over two meanings.
    renderPage();
    const note = await screen.findByTestId('attempts-range-note');
    expect(note.textContent).toMatch(/included/i);
    expect(note.textContent).toMatch(/created/i);
  });

  it('refuses an inverted range before sending it', async () => {
    // The API refuses it too (400), but telling the reader before they press Apply
    // is the difference between a correction and a support ticket.
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.change(screen.getByLabelText('First day'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Last day'), { target: { value: '2026-08-01' } });

    expect(screen.getByTestId('attempts-inverted-range')).toBeTruthy();
    expect((screen.getByText('Apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears every filter back to the whole history', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.click(screen.getByLabelText('Abandoned (no agent free)'));
    fireEvent.click(screen.getByText('Apply'));
    await waitFor(() => expect(mocks.getMyAttempts.mock.calls.length).toBe(2));

    fireEvent.click(screen.getByText('Clear'));
    await waitFor(() => expect(mocks.getMyAttempts.mock.calls.at(-1)?.[0]).toEqual({}));
  });
});

describe('AgentAttemptsPage — the disposition-code filter', () => {
  it('never claims the list of codes is complete', async () => {
    /**
     * Codes are operator-configured free text held in each campaign's
     * `disposition_catalog`. The campaign-scoped view can offer a complete list —
     * one campaign, one catalog. This list spans every campaign the person has
     * worked, which is the entire reason it exists, so no complete client-side set
     * exists and a bare row of chips would quietly claim otherwise.
     */
    renderPage();
    const note = await screen.findByTestId('disposition-incomplete-note');
    expect(note.textContent).toMatch(/no single list/i);
    expect(note.textContent).toMatch(/loaded so far/i);
  });

  it('says a code with a comma in it cannot be searched for', async () => {
    /**
     * Such a code is unfilterable end to end and the client cannot fix it:
     * The API's `forwardAllowedQuery` joins repeated params with a comma and
     * the API's `multiParam` splits on one, so the code arrives as two and matches
     * nothing. The answer is an EMPTY list, which reads as a fact about the
     * person rather than about the encoding — the exact failure this screen's
     * other honesty sentences exist to prevent.
     */
    renderPage();
    const note = await screen.findByTestId('disposition-comma-note');
    expect(note.textContent).toMatch(/comma/i);
    expect(note.textContent).toMatch(/empty/i);
    // In the reader's words: which service does the joining is not their problem.
    expect(note.textContent).not.toMatch(/master|core|param|encod/i);
  });

  it('offers the codes on the rows in hand as a shortcut', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);
    // `not_interested` is on the loaded rows; nothing else is.
    expect(screen.getByLabelText('not_interested')).toBeTruthy();
  });

  it('takes a code that is on no loaded row, typed in full', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.change(screen.getByTestId('disposition-code-entry'), {
      target: { value: 'renamed_last_quarter' },
    });
    fireEvent.click(screen.getByTestId('disposition-code-add'));
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() =>
      expect(mocks.getMyAttempts.mock.calls.at(-1)?.[0]).toEqual({
        disposition_code: ['renamed_last_quarter'],
      }),
    );
  });

  it('keeps a code containing a COMMA as one value', async () => {
    /**
     * One value, because that is what the operator typed and this box asks for a
     * code "exactly as it was set up". The code will not MATCH — the API joins
     * repeated params with a comma and the API splits on one — but the client must
     * not be the thing that mangles it: splitting on commas in the entry box
     * would produce the same two useless codes one hop earlier, while hiding
     * that the code the reader typed is the one thing that cannot be filtered
     * on.
     */
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.change(screen.getByTestId('disposition-code-entry'), {
      target: { value: 'wrong number, do not call' },
    });
    fireEvent.click(screen.getByTestId('disposition-code-add'));
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() =>
      expect(mocks.getMyAttempts.mock.calls.at(-1)?.[0]).toEqual({
        disposition_code: ['wrong number, do not call'],
      }),
    );
  });

  it('sends several codes as several values, not as one joined string', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.click(screen.getByLabelText('not_interested'));
    fireEvent.change(screen.getByTestId('disposition-code-entry'), { target: { value: 'sold' } });
    fireEvent.click(screen.getByTestId('disposition-code-add'));
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => {
      const codes = (mocks.getMyAttempts.mock.calls.at(-1)?.[0] as { disposition_code: string[] })
        .disposition_code;
      expect([...codes].sort()).toEqual(['not_interested', 'sold']);
    });
  });
});

describe('AgentAttemptsPage — the shape of the screen', () => {
  it('offers no CSV export, and does not import the downloader', async () => {
    /**
     * Considered and rejected on a hard fact rather than forgotten: the campaign
     * spine has `/campaigns/:id/attempts.csv`, and the API's performance plugin has
     * NO csv route — neither `my-attempts.csv` nor the supervisor twin. So
     * `downloadSpineCsv` pointed at this data would 404, and an Export button would
     * be a control that fails every time it is pressed. Adding one is a
     * cross-service change (the server first, then the console), not a screen change.
     *
     * Pinned at the DOM and at the import, because the tempting way to add it is to
     * copy the campaign page's header wholesale.
     */
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);
    // No CONTROL named export. The privacy note does say the word — on purpose,
    // so a reader who came looking for a download stops looking — so the
    // assertion is on buttons and links rather than on the text.
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /export/i })).toBeNull();

    const panel = readFileSync(
      resolve(process.cwd(), 'src/components/agency/AgentAttemptsPanel.tsx'),
      'utf8',
    );
    // The IMPORT, not the word: the panel's own docstring names `downloadSpineCsv`
    // to record why it is absent, and a scrape that forbade the name would forbid
    // the explanation along with the mistake.
    expect(panel).not.toMatch(/^import[^;]*downloadSpineCsv/m);
    expect(panel).not.toContain("from '../../api/agencySpine'");
  });

  it('carries the agent nav, with THIS surface marked as current', async () => {
    /**
     * A full-viewport page with no navigation and no link is the trap
     * `DialerUnavailable` documents. Safe here, unlike on the station: this page
     * holds no socket, so leaving it cannot strand a customer against an agent
     * the API still believes is available.
     *
     * It used to be a `back` link plus one `sibling`, authored per page — so this
     * screen linked to two of the three agent surfaces and never said which one
     * the reader was on. The nav is the whole set, everywhere, with the current
     * entry rendered rather than linked.
     */
    renderPage();
    await screen.findByTestId('agent-nav-attempts');

    expect(screen.getByTestId('agent-nav-campaigns').getAttribute('href')).toBe('/dialer');
    expect(screen.getByTestId('agent-nav-performance').getAttribute('href'))
      .toBe('/dialer/performance');

    // The current one is not a link — pressing a link to the page you are on is
    // a control that does nothing.
    const current = screen.getByTestId('agent-nav-attempts');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.tagName).not.toBe('A');
  });

  it('serves a supervisor rather than bouncing them, and points them at their team’s screen', async () => {
    /**
     * Same rule as `/dialer/performance`. A supervisor who covers shifts has their
     * own calls, and refusing to show somebody their own history because of their
     * role would be strange — but a supervisor who opens "My calls" and finds their
     * own eleven would otherwise conclude the dialer has lost their team's.
     */
    mocks.useTenant.mockReturnValue(tenant({ role: 'account_admin' }));
    renderPage();

    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);
    const note = screen.getByTestId('supervisor-note');
    expect(within(note).getByRole('link', { name: /analytics/i }).getAttribute('href'))
      .toBe('/agency/analytics');
    // Still their OWN calls, through the caller-scoped route.
    expect(mocks.getAgentAttempts).not.toHaveBeenCalled();
  });

  it('shows no supervisor note to an agent', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);
    expect(screen.queryByTestId('supervisor-note')).toBeNull();
  });
});

describe('AgentAttemptsPage — the filter card’s controls have accessible names', () => {
  /**
   * The chips and the two date inputs already do this correctly — every one of
   * them is reached through `getByLabelText`. The campaign `<select>` was the
   * exception: it was only ever reached through `data-testid="campaign-filter"`,
   * so downgrading its `<label>` to a `<div>` left every case in this file
   * passing and left the control with no accessible name at all.
   */
  it('names the campaign filter, inside the named filter group', async () => {
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    const filters = screen.getByRole('group', { name: 'Filters' });
    expect(within(filters).getByLabelText('Campaign')).toBe(screen.getByTestId('campaign-filter'));
  });

  it('still applies a campaign chosen by its label rather than its test id', async () => {
    // A name is only worth asserting if the named thing is the real control.
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'camp-2' } });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() =>
      expect(mocks.getMyAttempts.mock.calls.at(-1)?.[0]).toMatchObject({ campaign_id: 'camp-2' }),
    );
  });

  it('groups the write-up codes under a name of their own', async () => {
    /**
     * The three `<fieldset>` legends are the other half of this: a row of chips
     * with no group name is a run of checkboxes whose subject exists only in the
     * visual layout above them.
     */
    renderPage();
    await screen.findByTestId(`my-attempt-row-${CONNECTED.id}`);

    expect(screen.getByRole('group', { name: 'What happened' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Where the call got to' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Write-up code' })).toBeTruthy();
  });
});
