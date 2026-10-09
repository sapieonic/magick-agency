import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AgencyAttempt, AgencyKeysetPage } from '../../types/agency-spine';

/**
 * The campaign Attempts view.
 *
 * ── What this file exists to prevent ────────────────────────────────────────
 * "Renders 200 with rows" passes against a view that shows only the calls that
 * connected — which is precisely the view the platform already had at
 * `/app/calls/dialer/history`, and precisely the reason this page was built.
 * So the assertions here are about the rows a naive render drops or mislabels:
 * an abandoned attempt with no agent and no recording, and a page that works on
 * a campaign nobody is dialing any more.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getCampaignAttempts: vi.fn(),
  downloadSpineCsv: vi.fn(),
  // Typed with the parameter it really takes: inferred from `() => true`
  // the mock is zero-arg, and a per-capability `mockImplementation`
  // then fails to typecheck (vitest does not typecheck, so only `tsc`
  // catches it).
  isEnabled: vi.fn((_capability: string) => true),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: mocks.isEnabled, loading: false, map: {}, refresh: vi.fn() }),
}));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaign: mocks.getAgencyCampaign }));
vi.mock('../../api/agencySpine', () => ({
  getCampaignAttempts: mocks.getCampaignAttempts,
  downloadSpineCsv: mocks.downloadSpineCsv,
}));

import AttemptsPage from '../../pages/agency/AgencyCampaignAttemptsPage';

/** Connected, agent named, recording reachable. */
const BRIDGED: AgencyAttempt = {
  id: 'attempt-bridged', contact_id: 'contact-1', campaign_id: 'camp-1', attempt_number: 2,
  phone_e164: '+919876500001', caller_id: '+919000000001',
  // A UUID, as the server actually serves. A fixture that looks like a name is how
  // a raw-UUID render passes review — which is what happened the first time.
  agent_user_id: 'ac1f9d2e-1111-4222-8333-444455556666', agent_name: 'Ravi Menon',
  reserved_agent_id: 'session-1', state: 'ended', outcome: 'connected',
  disposition_code: 'not_interested', notes: 'asked us to call after 6pm',
  callback_at: null, dispositioned_by_user_id: 'ravi',
  dispositioned_at: '2026-08-17T10:00:00.000Z', dispositioned_on_behalf: false,
  webrtc_call_id: 'call-9', dialed_at: '2026-08-17T09:59:00.000Z',
  answered_at: '2026-08-17T09:59:10.000Z', bridged_at: '2026-08-17T09:59:12.000Z',
  ended_at: '2026-08-17T09:59:59.000Z', talk_seconds: 47, wrapup_seconds: 20,
  created_at: '2026-08-17T09:58:00.000Z',
};

/**
 * The row this page exists for: the customer answered, no agent was free, and
 * we hung up. No agent, no recording, no disposition — and no row of any kind
 * in `webrtc_calls`, so no call list anywhere can show it.
 */
const ABANDONED: AgencyAttempt = {
  ...BRIDGED, id: 'attempt-abandoned', contact_id: 'contact-2', attempt_number: 1,
  phone_e164: '+919876500002', agent_user_id: null, agent_name: null, reserved_agent_id: null,
  outcome: 'abandoned', disposition_code: null, notes: null,
  dispositioned_by_user_id: null, dispositioned_at: null,
  webrtc_call_id: null, answered_at: '2026-08-17T09:50:10.000Z', bridged_at: null,
  talk_seconds: null, created_at: '2026-08-17T09:50:00.000Z',
};

/** Never dialed at all — the reaper ended it after a replica died. */
const ORPHANED: AgencyAttempt = {
  ...ABANDONED, id: 'attempt-orphaned', contact_id: 'contact-3',
  phone_e164: '+919876500003', outcome: 'orphaned', dialed_at: null,
  answered_at: null, created_at: '2026-08-17T09:40:00.000Z',
};

/**
 * Stopped before anyone picked up — the agent cancelled the ringing dial, or their
 * station socket dropped mid-ring and the pre-bind grace ended it.
 *
 * `answered_at` is null and so is `bridged_at`, which is what separates it from
 * `ABANDONED` above: nobody was reached, so nobody was inconvenienced. Reading it
 * as `abandoned` is the pilot defect the server's classifier fix repairs, and the reason
 * a supervisor needs the two to render differently.
 */
const CANCELED: AgencyAttempt = {
  ...ORPHANED, id: 'attempt-canceled', contact_id: 'contact-4',
  phone_e164: '+919876500004', outcome: 'canceled',
  dialed_at: '2026-08-17T09:30:00.000Z', created_at: '2026-08-17T09:30:00.000Z',
};

function page(rows: AgencyAttempt[], nextCursor: string | null = null): AgencyKeysetPage<AgencyAttempt> {
  return { rows, next_cursor: nextCursor, limit: 50 };
}

function renderPage(initialPath = '/agency/campaigns/camp-1/attempts') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/agency/campaigns/:id/attempts" element={<AttemptsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isEnabled.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin',
  });
  // A STOPPED campaign by default: the primary case, not an afterthought.
  mocks.getAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Q3 Renewals', status: 'stopped' });
  mocks.getCampaignAttempts.mockResolvedValue(page([BRIDGED, ABANDONED, ORPHANED, CANCELED]));
});

afterEach(cleanup);

describe('the rows a call list cannot show', () => {
  it('shows an abandoned attempt beside a connected one', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    // The assertion the ticket asks for by name.
    expect(screen.getByTestId(`attempt-row-${ABANDONED.id}`)).toBeTruthy();
    expect(screen.getByTestId(`attempt-outcome-${ABANDONED.id}`).textContent)
      .toContain('Abandoned');
  });

  it('shows an attempt that never dialed', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${ORPHANED.id}`);
    expect(screen.getByTestId(`attempt-outcome-${ORPHANED.id}`).textContent)
      .toContain('Interrupted');
  });

  it('names US as the actor on a dial we stopped, not the customer', async () => {
    // The label is the whole point of the outcome, and it is deliberately
    // "Stopped by us before answer" rather than "Cancelled before answer".
    // "Cancelled" on a phone call reads most naturally as the CUSTOMER declining,
    // which inverts the decision a supervisor makes from this screen: a decline is
    // information about the number (they are screening), our own cancel is not,
    // and that is the entire basis for re-dialling these contacts.
    renderPage();
    await screen.findByTestId(`attempt-row-${CANCELED.id}`);

    const text = screen.getByTestId(`attempt-outcome-${CANCELED.id}`).textContent;
    expect(text).toContain('Stopped by us');
    // Never the raw slug: `copy()` falls back to the bare key, so an omission from
    // the spine's map would not throw — it would just print "canceled".
    expect(text).not.toContain('canceled');
  });

  it('renders it distinctly from the abandoned row it used to be filed as', async () => {
    // Before the classifier fix these two were the SAME outcome on this screen, so
    // asserting the copy alone would not prove they are now separable.
    renderPage();
    await screen.findByTestId(`attempt-row-${CANCELED.id}`);

    const canceled = screen.getByTestId(`attempt-outcome-${CANCELED.id}`).textContent;
    const abandoned = screen.getByTestId(`attempt-outcome-${ABANDONED.id}`).textContent;
    expect(canceled).not.toEqual(abandoned);
    expect(abandoned).toContain('Abandoned');
  });

  it('says WHY an attempt has no agent instead of leaving a gap', async () => {
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${ABANDONED.id}`);
    // A blank or an em dash reads as data we failed to load, which is the
    // opposite of the truth: no agent is the defining fact of this row.
    const agentCell = within(row).getByText('No agent was free');
    expect(agentCell).toBeTruthy();
    expect(agentCell.textContent).not.toBe('—');
    // The DISPOSITION cell on the same row does show an em dash, and correctly
    // so: nobody wrote this call up, which is genuinely absent data rather than
    // a fact with a reason behind it. The two must not be rendered alike.
  });

  it('offers no recording link where there is no call, and says so', async () => {
    renderPage();
    const abandoned = await screen.findByTestId(`attempt-row-${ABANDONED.id}`);
    expect(within(abandoned).queryByText('Open call')).toBeNull();
    expect(within(abandoned).getByText('No call was connected')).toBeTruthy();

    const bridged = screen.getByTestId(`attempt-row-${BRIDGED.id}`);
    const link = within(bridged).getByText('Open call').closest('a');
    // Deliberately a LINK to the call page rather than an inline player: the
    // call may have been purged since (the server keeps the id un-FK'd on purpose),
    // and that page is where "no longer available" can be said properly.
    //
    // And it is the AGENCY's call page, keyed on the attempt — see the
    // shell-boundary block below for why that matters.
    expect(link?.getAttribute('href'))
      .toBe(`/agency/campaigns/camp-1/attempts/${BRIDGED.id}`);
  });

  it('names the agent as a PERSON, not as a UUID', async () => {
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(within(row).getByText('Ravi Menon')).toBeTruthy();
    // The dialer runtime can only serve the id (it has no user table); the server resolves it.
    // Rendering the id is a column a supervisor can neither read nor filter by
    // — and the original fixture for this test was the string 'ravi', which is
    // precisely how that shipped unnoticed.
    expect(within(row).queryByText(BRIDGED.agent_user_id!)).toBeNull();
  });

  it('falls back to the id rather than claiming there was no agent', async () => {
    // The server could not resolve the name. The attempt still HAD an agent, so
    // "no agent" would be false — the id is a real, if unreadable, answer.
    mocks.getCampaignAttempts.mockResolvedValue(page([{ ...BRIDGED, agent_name: null }]));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(within(row).getByText(BRIDGED.agent_user_id!)).toBeTruthy();
  });
});

describe('a terminal campaign is the primary case', () => {
  it('loads without polling and shows the rows on a stopped campaign', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(mocks.getCampaignAttempts).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Q3 Renewals')).toBeTruthy();
  });
});

describe('filters', () => {
  it('sends the outcome filter, and the export takes the same one', async () => {
    mocks.downloadSpineCsv.mockResolvedValue({
      blob: new Blob(['a']), truncated: false, reason: null, rowLimit: null, rows: 3,
    });
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    fireEvent.click(screen.getByLabelText('Abandoned (no agent free)'));
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => {
      expect(mocks.getCampaignAttempts).toHaveBeenLastCalledWith(
        'camp-1', { outcome: ['abandoned'] }, { limit: 50 }, 'tenant-1', 'account-1',
      );
    });

    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => {
      // The export must be of what is on screen, not of everything — an export
      // that silently drops the filters is a file that does not match the view
      // it was taken from.
      expect(mocks.downloadSpineCsv).toHaveBeenCalledWith(
        'camp-1', 'attempts', { outcome: ['abandoned'] }, 'tenant-1', 'account-1',
      );
    });
  });

  it('refuses an inverted date range before sending it', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-08-01' } });

    expect(screen.getByTestId('attempts-inverted-range')).toBeTruthy();
    expect((screen.getByText('Apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('pins to one contact when arrived at from the drill-down', async () => {
    renderPage('/agency/campaigns/camp-1/attempts?contact_id=contact-2');
    await waitFor(() => {
      expect(mocks.getCampaignAttempts).toHaveBeenCalledWith(
        'camp-1', { contact_id: 'contact-2' }, { limit: 50 }, 'tenant-1', 'account-1',
      );
    });
    expect(screen.getByTestId('attempts-pinned-contact')).toBeTruthy();
  });
});

describe('paging', () => {
  it('follows the cursor and appends, never replacing', async () => {
    mocks.getCampaignAttempts
      .mockResolvedValueOnce(page([BRIDGED], 'cursor-2'))
      .mockResolvedValueOnce(page([ABANDONED]));
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    fireEvent.click(screen.getByText('Load older attempts'));

    await screen.findByTestId(`attempt-row-${ABANDONED.id}`);
    // Both on screen: a keyset page is a continuation, not a replacement.
    expect(screen.getByTestId(`attempt-row-${BRIDGED.id}`)).toBeTruthy();
    expect(mocks.getCampaignAttempts).toHaveBeenLastCalledWith(
      'camp-1', {}, { cursor: 'cursor-2', limit: 50 }, 'tenant-1', 'account-1',
    );
  });

  it('counts what is shown and never claims a total the API cannot produce', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    const count = screen.getByTestId('attempts-count').textContent ?? '';
    // Tracks the default seed (4 rows), not a meaningful constant — the assertion
    // is about the SHAPE below: a count of what is on screen, never "N of M".
    expect(count).toContain('Showing 4 attempts');
    // "3 of N" would be a number nothing counted — the API has no total by
    // design, because counting a million rows per page is a second scan for a
    // figure that is stale on arrival.
    expect(count).not.toMatch(/\bof\s+\d/);
  });
});

describe('an empty result is never reported as a fact about the campaign', () => {
  it('does not say "no calls were placed" when pinned to one contact', async () => {
    // Arriving from a contact with no attempts, on a campaign that dialled
    // thousands. `contact_id` was omitted from the `filtered` flag, so the
    // empty state read "This campaign has not dialed anyone yet" — an answer
    // about the query presented as an answer about the campaign.
    mocks.getCampaignAttempts.mockResolvedValue(page([]));
    renderPage('/agency/campaigns/camp-1/attempts?contact_id=contact-2');

    await screen.findByText('Nothing matches those filters');
    expect(screen.queryByText('No calls were placed')).toBeNull();
    expect(screen.queryByText(/has not dialed anyone yet/)).toBeNull();
  });

  it('still says so when the campaign really did dial nobody', async () => {
    mocks.getCampaignAttempts.mockResolvedValue(page([]));
    renderPage();
    await screen.findByText('No calls were placed');
  });
});

describe('export truncation', () => {
  it('warns as an ERROR and names the remedy when the file is short', async () => {
    mocks.downloadSpineCsv.mockResolvedValue({
      blob: new Blob(['a']), truncated: true, reason: 'row_limit', rowLimit: 50000, rows: 50000,
    });
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    fireEvent.click(screen.getByText('Export CSV'));

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    const [message, level] = mocks.showToast.mock.calls[0]!;
    // A campaign can hold a million contacts, so truncation is the ORDINARY
    // outcome of an unfiltered export. A success toast with a footnote is read
    // as "done" and the short file is handed over.
    expect(level).toBe('error');
    expect(message).toContain('50,000');
    expect(message).toContain('Narrow it down');
    // The remedy must name controls that exist on THIS page.
    expect(message).toContain('outcome');
  });
});

describe('permissions', () => {
  it('hides the export from a role that cannot supervise', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1', accountId: 'account-1', role: 'operator',
    });
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(screen.queryByText('Export CSV')).toBeNull();
  });
});

describe('the recording link stays inside the agency workspace', () => {
  /**
   * ─── THE BUG THIS PAGE REPORTED ──────────────────────────────────────────
   *
   * This link used to point at `/app/calls/dialer/history/:id` — out of
   * `AgencyLayout`, into the primary application's shell, onto a
   * `calls.dialer`-gated route, with the campaign context and this very list
   * gone. It pointed there because that
   * was the only place a call detail existed.
   *
   * It now points at the agency's own detail page, and the assertion is on the
   * href rather than on the link merely rendering — the old link rendered
   * perfectly too.
   */
  it('links the row to the agency call detail, keyed on the ATTEMPT', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    const link = screen.getByText('Open call').closest('a');
    expect(link?.getAttribute('href'))
      .toBe(`/agency/campaigns/camp-1/attempts/${BRIDGED.id}`);
  });

  /**
   * Keyed on the attempt, NOT on `webrtc_call_id`. That is what lets the
   * destination exist for a purged call: the attempt outlives the call by design
   * (the link is deliberately un-FK'd), so a call-id-keyed route would have
   * nothing to resolve for exactly the rows a compliance request is about.
   */
  it('does not key the link on the call id', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    const href = screen.getByText('Open call').closest('a')?.getAttribute('href') ?? '';
    expect(href).not.toContain(String(BRIDGED.webrtc_call_id));
  });

  /**
   * The `calls.dialer` degradation is gone, and its absence is the fix. The old
   * cell had to warn "Recorded — needs dialer access" because a pure agency
   * supervisor can legitimately lack that capability and would have landed on a
   * refusal screen. The destination is now gated on `agency`, which this view
   * already requires, so there is no such viewer.
   */
  it('no longer degrades on calls.dialer, because the destination does not need it', async () => {
    mocks.isEnabled.mockImplementation((capability: string) => capability !== 'calls.dialer');
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    expect(screen.getByText('Open call')).toBeTruthy();
    expect(screen.queryByText('Recorded — needs dialer access')).toBeNull();
  });

  /** And the link is never a `/app` one, whatever the capability map says. */
  it('never points into the primary application', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    const href = screen.getByText('Open call').closest('a')?.getAttribute('href') ?? '';
    expect(href.startsWith('/agency/')).toBe(true);
    expect(href).not.toContain('/app');
  });
});

/**
 * ── This screen is a section of the campaign workspace ──────────
 *
 * The bar is what makes it one, and it is rendered by each page rather than by
 * a shared route layout — so without an assertion here it could be deleted
 * from this one file and every suite in the repo would stay green. That is the
 * whole reason this test exists.
 */
describe('the campaign section bar', () => {
  it('renders the bar and marks Call attempts as the current section', async () => {
    renderPage();

    const tab = await screen.findByTestId('campaign-tab-attempts');
    expect(tab.getAttribute('aria-current')).toBe('page');
    // Its neighbours are reachable from here — the point of the bar is that
    // getting to another section does not mean going back through the campaign.
    expect(screen.getByTestId('campaign-tab-overview').getAttribute('aria-current')).toBeNull();
  });
});
