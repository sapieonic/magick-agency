import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import type {
  AgencyCallLogDiallerRow,
  AgencyCallLogInboundRow,
  AgencyCallLogPage,
  AgencyCallLogRow,
  AgencyCallLogSoftphoneRow,
} from '../../types/agency-call-log';

/** A dialler row of the Call log: the attempt row, marked. */
type AgencyAttempt = AgencyCallLogDiallerRow;

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
  getAgencyCampaignStats: vi.fn(),
  campaignLineage: vi.fn(),
  getCampaignCallLog: vi.fn(),
  downloadSpineCsv: vi.fn(),
  listCampaignAgents: vi.fn(),
  markMissedInboundCallHandled: vi.fn(),
  refreshMissedCallsCount: vi.fn(),
  // Typed with the parameter it really takes: inferred from `() => true`
  // the mock is zero-arg, and a per-capability `mockImplementation`
  // then fails to typecheck (vitest does not typecheck, so only `tsc`
  // catches it).
  isEnabled: vi.fn((_capability: string) => true),
  flags: new Set<string>(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));
// The tab bar's overdue-callbacks badge reads the allocation; never answered here, so no badge and no network.
vi.mock('../../api/agencyInsights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyInsights')>()),
  getInsightsAllocation: () => new Promise(() => {}),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: mocks.isEnabled, loading: false, map: {}, refresh: vi.fn() }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
// The campaign's workspace (header, health strip, bar) around the section reads these.
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
  campaignLineage: mocks.campaignLineage,
}));
vi.mock('../../api/agency', () => ({ listCampaignAgents: mocks.listCampaignAgents }));
vi.mock('../../api/inbound', () => ({ markMissedInboundCallHandled: mocks.markMissedInboundCallHandled }));
vi.mock('../../hooks/useMissedCallsCount', () => ({ refreshMissedCallsCount: mocks.refreshMissedCallsCount }));
vi.mock('../../api/agencySpine', () => ({
  getCampaignCallLog: mocks.getCampaignCallLog,
  downloadSpineCsv: mocks.downloadSpineCsv,
}));

import AttemptsPage from '../../pages/agency/AgencyCampaignAttemptsPage';
import { ApiError } from '../../api/client';
import { noLineage, workspaceStats } from '../helpers/campaignWorkspace';
import { attemptsLink, type InsightsAttemptsFilter } from '../../utils/agency/insights/links';

/** Connected, agent named, recording reachable. */
const BRIDGED: AgencyAttempt = {
  type: 'dialler',
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

/** Never dialled at all — the reaper ended it after a replica died. */
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

function page(rows: AgencyCallLogRow[], nextCursor: string | null = null): AgencyCallLogPage {
  return { rows, next_cursor: nextCursor, limit: 50 };
}

/**
 * Every date, said in the URL: the list as these cases mean it, whatever day they run on. A
 * bare `/attempts` opens on today ("the Call log opens on today", below).
 */
const ALL_DATES = '/agency/campaigns/camp-1/attempts?dates=all';

function renderPage(initialPath = ALL_DATES) {
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
  mocks.flags = new Set();
  mocks.isEnabled.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin',
  });
  // A STOPPED campaign by default: the primary case, not an afterthought.
  mocks.getAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Q3 Renewals', status: 'stopped' });
  mocks.getAgencyCampaignStats.mockResolvedValue(workspaceStats());
  mocks.campaignLineage.mockResolvedValue(noLineage());
  mocks.getCampaignCallLog.mockResolvedValue(page([BRIDGED, ABANDONED, ORPHANED, CANCELED]));
  mocks.listCampaignAgents.mockResolvedValue({ agents: [] });
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
    mocks.getCampaignCallLog.mockResolvedValue(page([{ ...BRIDGED, agent_name: null }]));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(within(row).getByText(BRIDGED.agent_user_id!)).toBeTruthy();
  });
});

describe('a terminal campaign is the primary case', () => {
  it('loads without polling and shows the rows on a stopped campaign', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(mocks.getCampaignCallLog).toHaveBeenCalledTimes(1);
    // The campaign's name is the top bar's (`useCampaignCrumbs`); its status is the header's.
    expect(await screen.findByText('Stopped')).toBeTruthy();
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
      expect(mocks.getCampaignCallLog).toHaveBeenLastCalledWith(
        'camp-1', { outcome: ['abandoned'] }, { limit: 50, type: 'all', includeCounts: true }, 'tenant-1', 'account-1',
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
      expect(mocks.getCampaignCallLog).toHaveBeenCalledWith(
        'camp-1', { contact_id: 'contact-2' }, { limit: 50, type: 'all', includeCounts: true }, 'tenant-1', 'account-1',
      );
    });
    expect(screen.getByTestId('attempts-pinned-contact')).toBeTruthy();
  });
});

describe('paging', () => {
  it('follows the cursor and appends, never replacing', async () => {
    mocks.getCampaignCallLog
      .mockResolvedValueOnce(page([BRIDGED], 'cursor-2'))
      .mockResolvedValueOnce(page([ABANDONED]));
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    fireEvent.click(screen.getByText('Load older calls'));

    await screen.findByTestId(`attempt-row-${ABANDONED.id}`);
    // Both on screen: a keyset page is a continuation, not a replacement.
    expect(screen.getByTestId(`attempt-row-${BRIDGED.id}`)).toBeTruthy();
    expect(mocks.getCampaignCallLog).toHaveBeenLastCalledWith(
      'camp-1', {}, { cursor: 'cursor-2', limit: 50, type: 'all' }, 'tenant-1', 'account-1',
    );
  });

  it('without a total from the server, counts what is shown and never claims "N of M"', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    const count = screen.getByTestId('attempts-count').textContent ?? '';
    // Tracks the default seed (4 rows), not a meaningful constant — the assertion
    // is about the SHAPE below: a count of what is on screen, never "N of M".
    expect(count).toContain('Showing 4 calls');
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
    // empty state read "This campaign has not dialled anyone yet" — an answer
    // about the query presented as an answer about the campaign.
    mocks.getCampaignCallLog.mockResolvedValue(page([]));
    renderPage('/agency/campaigns/camp-1/attempts?contact_id=contact-2');

    await screen.findByText('Nothing matches those filters');
    expect(screen.queryByText('No calls were placed')).toBeNull();
    expect(screen.queryByText(/has not dialled anyone yet/)).toBeNull();
  });

  it('still says so when the campaign really did dial nobody', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([]));
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

/*
  The export is the campaign's call log (SR6): it carries the soft-phone calls logged to the
  campaign whatever the flag says now, so the page says so while the soft phone is on OR the
  campaign holds any (`/stats` `softphone.placed`, the SR5 rule), and not otherwise.
*/
describe('the export’s soft-phone rows are mentioned when the file can hold them', () => {
  const TIP = 'The export also holds the soft-phone calls logged to this campaign, marked soft_phone in its source column.';
  const PLAIN_TITLE = 'Download everything matching the filters above, not just the rows on screen';
  async function exportButton(): Promise<HTMLElement> {
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    return screen.getByText('Export CSV').closest('button')!;
  }

  it('with the soft phone switched off, once the campaign’s stats show soft-phone calls', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(workspaceStats({ softphone: { placed: 3, connected: 2, human_connects: 1 } }));
    renderPage();
    const button = await exportButton();
    await waitFor(() => expect(screen.getByText(TIP)).toBeTruthy());
    expect(button.getAttribute('title')).toContain('with the soft-phone calls logged to this campaign');
  });

  it('with the soft phone on, whatever the stats say', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getAgencyCampaignStats.mockResolvedValue(workspaceStats({ softphone: { placed: 0, connected: 0, human_connects: 0 } }));
    renderPage();
    const button = await exportButton();
    expect(screen.getByText(TIP)).toBeTruthy();
    expect(button.getAttribute('title')).toContain('with the soft-phone calls logged to this campaign');
  });

  it('not with the soft phone off and none logged', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(workspaceStats({ softphone: { placed: 0, connected: 0, human_connects: 0 } }));
    renderPage();
    const button = await exportButton();
    await waitFor(() => expect(mocks.getAgencyCampaignStats).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(TIP)).toBeNull();
    expect(button.getAttribute('title')).toBe(PLAIN_TITLE);
  });

  it('not from a server that does not serve the count, with the soft phone off', async () => {
    renderPage();
    const button = await exportButton();
    await waitFor(() => expect(mocks.getAgencyCampaignStats).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(TIP)).toBeNull();
    expect(button.getAttribute('title')).toBe(PLAIN_TITLE);
  });
});

describe('the recording link stays inside the agency workspace', () => {
  /**
   * ─── THE BUG THIS PAGE REPORTED ──────────────────────────────────────────
   *
   * This link used to point at `/app/calls/dialer/history/:id` — out of
   * the agency workspace, into the old `/app` zone, onto a
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
  it('never points into the /app zone', async () => {
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
  it('renders the bar and marks Call log as the current section', async () => {
    renderPage();

    const tab = await screen.findByTestId('campaign-tab-attempts');
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(tab.textContent).toBe('Call log');
    // Its neighbours are reachable from here — the point of the bar is that
    // getting to another section does not mean going back through the campaign.
    expect(screen.getByTestId('campaign-tab-overview').getAttribute('aria-current')).toBeNull();
    // In the campaign's workspace: the header names the campaign (its h1), and Call log is the section.
    expect(screen.getByTestId('campaign-workspace')).toBeTruthy();
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Q3 Renewals');
    expect(screen.getByRole('heading', { level: 2, name: 'Call log' })).toBeTruthy();
  });

  it('has no second view to switch to: Call log is one list (CL11)', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    renderPage();

    await screen.findByTestId('campaign-tab-attempts');
    expect(screen.queryByTestId('call-log-views')).toBeNull();
    expect(screen.queryByTestId('campaign-tab-manual')).toBeNull();
  });
});

/**
 * The workspace re-reads the campaign on its header's poll (every 10 s while it dials) and on
 * the header's Refresh, and hands the section a new campaign object each time. The section
 * names things from it; it must not re-read the call log for it.
 */
describe('the workspace’s campaign re-read', () => {
  it('does not re-read the call log', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    await screen.findByRole('heading', { level: 1 });
    const listReads = mocks.getCampaignCallLog.mock.calls.length;
    const campaignReads = mocks.getAgencyCampaign.mock.calls.length;

    // The same campaign, as a new object: what every re-read hands over.
    const current = await mocks.getAgencyCampaign.mock.results[0]!.value;
    mocks.getAgencyCampaign.mockResolvedValue({ ...current });

    // The header's Refresh (the campaign), named exactly "Refresh".
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(mocks.getAgencyCampaign.mock.calls.length).toBe(campaignReads + 1));
    await waitFor(() => expect(mocks.getAgencyCampaignStats.mock.calls.length).toBeGreaterThan(1));
    // Let the new campaign object land and the section render with it.
    await act(async () => {});
    expect(mocks.getCampaignCallLog.mock.calls.length).toBe(listReads);
  });
});

/**
 * ── The filters live in the URL (the Insights drill-downs, docs/insights.md WS F) ──
 * A number on the campaign's analytic tabs opens this list with its filters in the query string. Every
 * one is read, sent, shown as a removable chip and written back; the list asks for the
 * exact total so the count on screen is the number that was clicked.
 */
function AttemptsLocationProbe() {
  const location = useLocation();
  return <span data-testid="location-search">{location.search}</span>;
}

function renderWithLocation(query: string) {
  return render(
    <MemoryRouter initialEntries={[`/agency/campaigns/camp-1/attempts${query}`]}>
      <AttemptsLocationProbe />
      <Routes>
        <Route path="/agency/campaigns/:id/attempts" element={<AttemptsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function currentQuery(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
}

/** The query of a link Insights builds (`attemptsLink`): what a drill-down really arrives with. */
const drilldown = (filter: InsightsAttemptsFilter = {}) => `?${attemptsLink('camp-1', filter).split('?')[1] ?? ''}`;

const DRILLDOWN = drilldown({
  outcome: 'connected', disposition: ['not_interested'], agent_user_id: 'ac1f9d2e-1111-4222-8333-444455556666',
  caller_id: '+919000000001', redial: true, agent_manual: true, agent_reopened: true,
  from: '2026-08-17T00:00:00.000Z', to: '2026-08-18T00:00:00.000Z',
});

describe('filters in the URL', () => {
  it('reads every drill-down filter from the URL and sends it on the Dialler chip, asking for the counts', async () => {
    renderWithLocation(DRILLDOWN);
    await waitFor(() => {
      expect(mocks.getCampaignCallLog).toHaveBeenLastCalledWith(
        'camp-1',
        {
          outcome: ['connected'],
          disposition_code: ['not_interested'],
          agent_user_id: 'ac1f9d2e-1111-4222-8333-444455556666',
          caller_id: '+919000000001',
          redial: '1',
          agent_manual: '1',
          agent_reopened: '1',
          placed: '1',
          dialed_from: '2026-08-17T00:00:00.000Z',
          dialed_to: '2026-08-18T00:00:00.000Z',
        },
        // An Insights figure is the dialler's alone (SR1): its link lands on the Dialler chip.
        { limit: 50, type: 'dialler', includeCounts: true },
        'tenant-1',
        'account-1',
      );
    });
  });

  it('shows each applied filter as a chip, in words', async () => {
    mocks.getAgencyCampaign.mockResolvedValue({
      id: 'camp-1', name: 'Q3 Renewals', status: 'stopped',
      disposition_catalog: [{ code: 'not_interested', label: 'Not interested' }],
    });
    renderWithLocation(DRILLDOWN);
    await screen.findByText('Stopped');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    const applied = within(screen.getByTestId('attempts-applied'));
    expect(applied.getByText('Outcome: Connected')).toBeTruthy();
    expect(applied.getByText('Written up as: Not interested')).toBeTruthy();
    // Named from the loaded rows, not shown as a UUID.
    expect(applied.getByText('Agent: Ravi Menon')).toBeTruthy();
    expect(applied.getByText('Caller ID: +919000000001')).toBeTruthy();
    expect(applied.getByText('Wrap-up redials')).toBeTruthy();
    expect(applied.getByText('Dialled by hand')).toBeTruthy();
    expect(applied.getByText('Dials after a reopen')).toBeTruthy();
    expect(applied.getByText('Dials placed')).toBeTruthy();
    expect(applied.getByText(/^Dialled from .+, up to .+$/)).toBeTruthy();
  });

  it('removing a chip rewrites the URL without it and reloads the list', async () => {
    renderWithLocation(DRILLDOWN);
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Wrap-up redials' }));

    await waitFor(() => expect(currentQuery().get('redial')).toBeNull());
    // Everything else is still applied.
    expect(currentQuery().get('caller_id')).toBe('+919000000001');
    expect(currentQuery().get('dialed_from')).toBe('2026-08-17T00:00:00.000Z');
    await waitFor(() => {
      const [, filters] = mocks.getCampaignCallLog.mock.calls.at(-1)!;
      expect(filters).not.toHaveProperty('redial');
      expect(filters).toHaveProperty('caller_id', '+919000000001');
    });

    // The dialled window is one chip for both ends.
    fireEvent.click(screen.getByRole('button', { name: /^Remove filter: Dialled from/ }));
    await waitFor(() => expect(currentQuery().get('dialed_from')).toBeNull());
    expect(currentQuery().get('dialed_to')).toBeNull();
  });

  it('writes the form back to the URL and keeps the filters the form has no control for', async () => {
    renderWithLocation('?caller_id=%2B919000000001&placed=1');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    fireEvent.click(screen.getByLabelText('Abandoned (no agent free)'));
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(currentQuery().getAll('outcome')).toEqual(['abandoned']));
    expect(currentQuery().get('caller_id')).toBe('+919000000001');
    expect(currentQuery().get('placed')).toBe('1');
  });

  it('fills the form from a link, so Apply does not silently undo it', async () => {
    renderWithLocation('?outcome=busy&phone=98765');
    const chip = (await screen.findByLabelText('Busy')) as HTMLInputElement;
    expect(chip.checked).toBe(true);
    expect((screen.getByPlaceholderText('Number or last digits') as HTMLInputElement).value).toBe('98765');
  });

  it('ignores an unknown key and a malformed flag rather than failing the page', async () => {
    renderWithLocation('?utm_source=mail&redial=yes&placed=1');
    await waitFor(() => {
      expect(mocks.getCampaignCallLog).toHaveBeenLastCalledWith(
        'camp-1', { placed: '1' }, { limit: 50, type: 'all', includeCounts: true }, 'tenant-1', 'account-1',
      );
    });
  });

  it('shows the exact count when the server sends one: the drill-down count', async () => {
    mocks.getCampaignCallLog.mockResolvedValue({
      ...page([BRIDGED, ABANDONED], 'cursor-2'), counts: { all: 1240, dialler: 1234, soft_phone: 6, inbound: 0, to_follow_up: 0 },
    });
    // The link Insights builds for a lifetime dials figure.
    renderWithLocation(drilldown());
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    const count = screen.getByTestId('attempts-count').textContent ?? '';
    // The dialler's count, the figure that was clicked: not every type's (1,240 with the
    // six soft-phone calls the same filters match).
    expect(count).toMatch(/^1[,.]?234 calls — showing 2$/);
    expect(screen.getByTestId('call-log-type-dialler').getAttribute('aria-pressed')).toBe('true');
  });

  it('the export carries every applied filter, the drill-down ones included', async () => {
    mocks.downloadSpineCsv.mockResolvedValue({
      blob: new Blob(['a']), truncated: false, reason: null, rowLimit: null, rows: 3,
    });
    renderWithLocation(drilldown({ redial: true, from: '2026-08-17T00:00:00.000Z' }));
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => {
      expect(mocks.downloadSpineCsv).toHaveBeenCalledWith(
        'camp-1', 'attempts', { redial: '1', placed: '1', dialed_from: '2026-08-17T00:00:00.000Z', source: 'dialler' }, 'tenant-1', 'account-1',
      );
    });
  });
});

describe('an automatic outcome (decisions OD1–OD8)', () => {
  const CATALOG = [
    { code: 'not_interested', label: 'Not interested' },
    { code: 'retry_later', label: 'Retry later' },
  ];
  const BUSY_AUTO: AgencyAttempt = {
    ...ABANDONED, id: 'attempt-busy-auto', contact_id: 'contact-5', outcome: 'busy',
    answered_at: null, auto_disposition_code: 'retry_later',
  };

  beforeEach(() => {
    mocks.getAgencyCampaign.mockResolvedValue({
      id: 'camp-1', name: 'Q3 Renewals', status: 'stopped', disposition_catalog: CATALOG,
    });
  });

  it('shows it in place of the dash, by its label and tagged automatic', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([BUSY_AUTO]));
    renderPage();
    const auto = await screen.findByTestId(`attempt-auto-disposition-${BUSY_AUTO.id}`);
    expect(auto.textContent).toBe('Retry later (automatic)');
    expect(auto.getAttribute('data-auto-disposition')).toBe('primary');
    // The whole Disposition cell: not also the "nobody wrote it up" dash beside it.
    expect(auto.closest('td')?.textContent).toBe('Retry later (automatic)');
  });

  it('keeps a write-up as the disposition and the automatic one secondary', async () => {
    const both: AgencyAttempt = { ...BRIDGED, auto_disposition_code: 'retry_later' };
    mocks.getCampaignCallLog.mockResolvedValue(page([both]));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${both.id}`);
    await within(row).findByText('Not interested');
    const auto = screen.getByTestId(`attempt-auto-disposition-${both.id}`);
    expect(auto.textContent).toBe('Retry later (automatic)');
    expect(auto.getAttribute('data-auto-disposition')).toBe('secondary');
  });

  it('shows the dash and no tag on a row without one', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([ABANDONED]));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${ABANDONED.id}`);
    // The Disposition column (When, Number, Try, Agent, Outcome, Disposition, …).
    expect(row.querySelectorAll('td')[5]?.textContent).toBe('—');
    expect(screen.queryByTestId(`attempt-auto-disposition-${ABANDONED.id}`)).toBeNull();
  });
});

/** The server's 400 for a filter it refuses: `{ error, details: [{ param, message }] }`. */
function refusal(param: string, message: string): ApiError {
  return new ApiError(400, { error: 'Validation failed', details: [{ param, message }] });
}

const PRIYA_ID = 'b2c3d4e5-2222-4333-8444-555566667777';

describe('a filter the server refuses', () => {
  it('shows no rows under it, plain copy, and no Retry that would send it again', async () => {
    // The first load answers rows; the agent filter from the URL is then refused.
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    mocks.getCampaignCallLog.mockRejectedValueOnce(refusal('agent_user_id', 'must be an agent id'));

    // The section's Refresh (the list), not the header's (the campaign).
    fireEvent.click(screen.getByRole('button', { name: 'Refresh call log' }));

    await waitFor(() => expect(screen.queryByTestId(`attempt-row-${BRIDGED.id}`)).toBeNull());
    const alert = await screen.findByText(/The agent filter does not match an agent/);
    expect(alert.textContent).not.toContain('must be an agent id');
    // The list's own Retry (ErrorAlert's), not the header's Retry contacts.
    expect(screen.queryByRole('button', { name: 'Retry loading' })).toBeNull();
    expect(screen.getByTestId('attempts-count').textContent).toBe('');
  });

  it('names the phone filter for a link that carries one with no digits', async () => {
    mocks.getCampaignCallLog.mockRejectedValue(
      refusal('phone', 'must contain at least one digit — search by the whole number or its last few digits'),
    );
    renderWithLocation('?phone=abc!!');

    expect(await screen.findByText(/The phone number filter needs at least one digit\./)).toBeTruthy();
    expect(screen.queryByText(/must contain at least one digit/)).toBeNull();
    // The list's own Retry (ErrorAlert's), not the header's Retry contacts.
    expect(screen.queryByRole('button', { name: 'Retry loading' })).toBeNull();
  });

  it('keeps Retry, and clears the stale rows, for a failure retrying can fix', async () => {
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    mocks.getCampaignCallLog.mockRejectedValueOnce(new ApiError(503, { message: 'Service unavailable' }));

    // The section's Refresh (the list), not the header's (the campaign).
    fireEvent.click(screen.getByRole('button', { name: 'Refresh call log' }));

    expect(await screen.findByRole('button', { name: 'Retry loading' })).toBeTruthy();
    expect(screen.queryByTestId(`attempt-row-${BRIDGED.id}`)).toBeNull();
  });
});

describe('the agent filter is picked by name', () => {
  it('offers the campaign’s agents and the agents on the rows, and sends the id', async () => {
    mocks.listCampaignAgents.mockResolvedValue({
      agents: [{ user_id: PRIYA_ID, name: 'Priya Shah', email: 'priya@example.com', role: 'agent', assigned_at: '2026-08-01T00:00:00.000Z' }],
    });
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(mocks.listCampaignAgents).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');

    const select = screen.getByTestId('attempts-agent-filter') as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.textContent)).toEqual(
      // Ravi is not assigned any more but has a row on screen.
      ['All agents', 'Priya Shah', 'Ravi Menon'],
    ));

    fireEvent.change(select, { target: { value: PRIYA_ID } });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(currentQuery().get('agent_user_id')).toBe(PRIYA_ID));
    expect(screen.getByText('Agent: Priya Shah')).toBeTruthy();
  });
});

describe('moving to another campaign on the same page', () => {
  it('drops the previous campaign’s agents and header at once, and ignores its late answers', async () => {
    // camp-1's header and agents answer only after the move to camp-2, which answers at once.
    let campaignOne: (value: unknown) => void = () => undefined;
    let agentsOne: (value: unknown) => void = () => undefined;
    mocks.getAgencyCampaign.mockImplementation((id: string) => (id === 'camp-1'
      ? new Promise((resolve) => { campaignOne = resolve; })
      : Promise.resolve({ id: 'camp-2', name: 'Q4 Winback', status: 'running' })));
    mocks.listCampaignAgents.mockImplementation((id: string) => (id === 'camp-1'
      ? new Promise((resolve) => { agentsOne = resolve; })
      : Promise.resolve({ agents: [{ user_id: 'asha-id', name: 'Asha Rao', email: 'asha@example.com', role: 'agent', assigned_at: '2026-08-01T00:00:00.000Z' }] })));
    let go: (to: string) => void = () => undefined;
    function Driver() {
      go = useNavigate();
      return null;
    }
    render(
      <MemoryRouter initialEntries={[ALL_DATES]}>
        <Driver />
        <Routes>
          <Route path="/agency/campaigns/:id/attempts" element={<AttemptsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);

    act(() => go('/agency/campaigns/camp-2/attempts?dates=all'));
    await waitFor(() => expect(mocks.listCampaignAgents).toHaveBeenCalledWith('camp-2', 'tenant-1', 'account-1'));
    await act(async () => {
      campaignOne({ id: 'camp-1', name: 'Q3 Renewals', status: 'stopped' });
      agentsOne({ agents: [{ user_id: PRIYA_ID, name: 'Priya Shah', email: 'priya@example.com', role: 'agent', assigned_at: '2026-08-01T00:00:00.000Z' }] });
    });

    const select = screen.getByTestId('attempts-agent-filter') as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.textContent)).toEqual(['All agents', 'Asha Rao', 'Ravi Menon']));
    expect(screen.getByText('Calls on Q4 Winback, newest first')).toBeTruthy();
  });
});

describe('moving to another campaign before its agents answer', () => {
  it('no longer offers the previous campaign’s agents while the new list is on its way', async () => {
    mocks.listCampaignAgents.mockImplementation((id: string) => (id === 'camp-1'
      ? Promise.resolve({ agents: [{ user_id: PRIYA_ID, name: 'Priya Shah', email: 'priya@example.com', role: 'agent', assigned_at: '2026-08-01T00:00:00.000Z' }] })
      : new Promise(() => {})));
    let go: (to: string) => void = () => undefined;
    function Driver() {
      go = useNavigate();
      return null;
    }
    render(
      <MemoryRouter initialEntries={[ALL_DATES]}>
        <Driver />
        <Routes>
          <Route path="/agency/campaigns/:id/attempts" element={<AttemptsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    const options = () => [...(screen.getByTestId('attempts-agent-filter') as HTMLSelectElement).options].map((o) => o.textContent);
    await waitFor(() => expect(options()).toContain('Priya Shah'));

    act(() => go('/agency/campaigns/camp-2/attempts?dates=all'));
    await waitFor(() => expect(mocks.listCampaignAgents).toHaveBeenCalledWith('camp-2', 'tenant-1', 'account-1'));
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(options()).toEqual(['All agents', 'Ravi Menon']);
  });
});

describe('a phone filter with no digits is caught in the form', () => {
  it('says so in a sentence and does not send it', async () => {
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    const calls = mocks.getCampaignCallLog.mock.calls.length;

    fireEvent.change(screen.getByPlaceholderText('Number or last digits'), { target: { value: 'abc!!' } });

    expect(screen.getByTestId('attempts-phone-unusable').textContent).toContain('Type at least one digit of the phone number.');
    expect((screen.getByText('Apply') as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.getCampaignCallLog.mock.calls.length).toBe(calls);
  });
});

describe('a phone number still being typed', () => {
  it('is not an error at its first "+", is said on Apply, and is never sent', async () => {
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    const calls = mocks.getCampaignCallLog.mock.calls.length;
    const field = screen.getByPlaceholderText('Number or last digits');

    fireEvent.change(field, { target: { value: '+' } });
    expect(screen.queryByTestId('attempts-phone-unusable')).toBeNull();
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect((screen.getByText('Apply') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText('Apply'));
    expect(screen.getByTestId('attempts-phone-unusable').textContent).toContain('Type at least one digit of the phone number.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.getCampaignCallLog.mock.calls.length).toBe(calls);

    // A digit clears it, and Apply sends it.
    fireEvent.change(field, { target: { value: '+9' } });
    expect(screen.queryByTestId('attempts-phone-unusable')).toBeNull();
    fireEvent.click(screen.getByText('Apply'));
    await waitFor(() => expect(currentQuery().get('phone')).toBe('+9'));
  });
});

describe('a link whose dates are the wrong way round', () => {
  it('says to swap them, not that a date cannot be read', async () => {
    mocks.getCampaignCallLog.mockRejectedValueOnce(refusal('from', '`from` must not be later than `to`'));
    renderWithLocation('?from=2026-08-20T00:00:00.000Z&to=2026-08-10T00:00:00.000Z');

    // The refusal itself, not the form's own check of the drafts the link filled in.
    const said = await screen.findByText(/Change or remove it above to see the call log/);
    expect(said.textContent).toContain('The “From” date is after the “To” date');
    expect(said.textContent).not.toContain('not a date this list can use');
  });
});

// ─── One list, every type (CL11, docs/call-log.md) ──────────────────────────

/** A soft-phone call logged to the campaign: connected, on the roster, outcome saved. */
const SOFT: AgencyCallLogSoftphoneRow = {
  type: 'soft_phone', id: 'manual-1', campaign_id: 'camp-1', contact_id: 'contact-9',
  phone_e164: '+919876500099', caller_id: '+919000000002',
  agent_user_id: 'bd2f9d2e-1111-4222-8333-444455556666', agent_name: 'Priya Nair',
  state: 'ended', outcome: 'connected', disposition_code: 'not_interested', notes: null, callback_at: null,
  promise_date: null, promise_amount: null,
  dispositioned_by_user_id: 'bd2f9d2e-1111-4222-8333-444455556666', dispositioned_at: '2026-08-17T10:31:00.000Z',
  dispositioned_on_behalf: false, webrtc_call_id: 'call-77',
  dialed_at: '2026-08-17T10:30:01.000Z', answered_at: '2026-08-17T10:30:08.000Z',
  bridged_at: '2026-08-17T10:30:08.000Z', ended_at: '2026-08-17T10:30:29.000Z', talk_seconds: 21,
  dnc_overridden: false, hours_overridden: false, requires_disposition: false,
  settled_at: '2026-08-17T10:31:00.000Z', callback_of: null, created_at: '2026-08-17T10:30:00.000Z',
};
const COUNTS = { all: 1326, dialler: 1240, soft_phone: 86, inbound: 0, to_follow_up: 0 };
const withCounts = (rows: AgencyCallLogRow[], counts = COUNTS, cursor: string | null = null): AgencyCallLogPage =>
  ({ ...page(rows, cursor), counts });
const lastCall = () => mocks.getCampaignCallLog.mock.calls.at(-1)!;

describe('the type chips', () => {
  it('shows All · Dialler · Soft phone with the counts for the filters, All on', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT, BRIDGED]));
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${SOFT.id}`);

    const chips = within(screen.getByRole('group', { name: 'Call type' })).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['All1,326', 'Dialler1,240', 'Soft phone86']);
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(screen.getByTestId('attempts-count').textContent).toMatch(/^1[,.]?326 calls — showing 2$/);
  });

  it('choosing a chip puts it in the URL, keeps the filters, and reads that type alone', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT, BRIDGED]));
    renderWithLocation('?outcome=connected');
    await screen.findByTestId(`attempt-row-${SOFT.id}`);

    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT]));
    fireEvent.click(screen.getByTestId('call-log-type-soft_phone'));
    await waitFor(() => expect(currentQuery().get('type')).toBe('soft_phone'));
    expect(currentQuery().getAll('outcome')).toEqual(['connected']);
    // The counts are of every type whatever chip is on: the rows are read again, the counts kept.
    await waitFor(() => expect(lastCall().slice(1, 3)).toEqual([
      { outcome: ['connected'] }, { limit: 50, type: 'soft_phone' },
    ]));
    expect(screen.getByTestId('call-log-type-all').textContent).toBe('All1,326');
    await waitFor(() => expect(screen.getByTestId('call-log-type-soft_phone').getAttribute('aria-pressed')).toBe('true'));
    // The count line is the chip's own count.
    expect(screen.getByTestId('attempts-count').textContent).toMatch(/^86 calls — showing 1$/);

    // Back to All: the param leaves the URL.
    fireEvent.click(screen.getByTestId('call-log-type-all'));
    await waitFor(() => expect(currentQuery().has('type')).toBe(false));
    expect(currentQuery().getAll('outcome')).toEqual(['connected']);
  });

  it('a later page keeps the chip, and the export is that type’s file', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.downloadSpineCsv.mockResolvedValue({ blob: new Blob(['a']), truncated: false, reason: null, rowLimit: null, rows: 1 });
    mocks.getCampaignCallLog.mockResolvedValueOnce(withCounts([SOFT], COUNTS, 'cursor-2')).mockResolvedValueOnce(page([{ ...SOFT, id: 'manual-2' }]));
    renderWithLocation('?placed=1&type=soft_phone');
    await screen.findByTestId(`attempt-row-${SOFT.id}`);

    fireEvent.click(screen.getByText('Load older calls'));
    await screen.findByTestId('attempt-row-manual-2');
    expect(lastCall().slice(1, 3)).toEqual([{ placed: '1' }, { cursor: 'cursor-2', limit: 50, type: 'soft_phone' }]);
    // The counts came with the first page and are kept.
    expect(screen.getByTestId('call-log-type-soft_phone').textContent).toBe('Soft phone86');

    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => expect(mocks.downloadSpineCsv).toHaveBeenCalledWith(
      'camp-1', 'attempts', { placed: '1', source: 'soft_phone' }, 'tenant-1', 'account-1',
    ));
  });

  it('hides the Soft phone chip, and so every chip, with the soft phone off and no soft-phone call in the range', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([BRIDGED], { all: 4, dialler: 4, soft_phone: 0, inbound: 0, to_follow_up: 0 }));
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(screen.queryByTestId('call-log-types')).toBeNull();
    // The count is still said.
    expect(screen.getByTestId('attempts-count').textContent).toBe('4 calls — showing 1');
  });

  it('keeps the Soft phone chip with the soft phone off while the range holds soft-phone calls (SR5)', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT, BRIDGED], { all: 5, dialler: 4, soft_phone: 1, inbound: 0, to_follow_up: 0 }));
    renderPage();
    await screen.findByTestId(`attempt-row-${SOFT.id}`);
    expect(screen.getByTestId('call-log-type-soft_phone').textContent).toBe('Soft phone1');
  });

  it('ignores a type it does not know', async () => {
    renderWithLocation('?placed=1&type=missed');
    await waitFor(() => expect(lastCall()[2]).toEqual({ limit: 50, type: 'all', includeCounts: true }));
  });
});

describe('a row of each type', () => {
  beforeEach(() => {
    mocks.flags = new Set(['agency_softphone_enabled']);
  });

  it('heads the table When · Type · Customer · Agent · What happened · Outcome · Talk time · Call', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'When', 'Type', 'Customer', 'Agent', 'What happened', 'Outcome', 'Talk time', 'Call',
    ]);
  });

  it('a dialler row says which try it was, and that it was a redial, under its type', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([BRIDGED, { ...ABANDONED, redial_number: 1, redial_of_attempt_id: BRIDGED.id }]));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(screen.getByTestId(`call-type-${BRIDGED.id}`).textContent).toBe('Dialler');
    expect(screen.getByTestId(`call-facts-${BRIDGED.id}`).textContent).toBe('Try 2');
    expect(screen.getByTestId(`call-facts-${ABANDONED.id}`).textContent).toBe('Try 1 · redial');
    expect(row.getAttribute('data-type')).toBe('dialler');
    expect(within(row).getByText('Open call').closest('a')!.getAttribute('href')).toBe('/agency/campaigns/camp-1/attempts/attempt-bridged');
  });

  it('a soft-phone row names its agent and its outcome from the campaign’s catalog, and opens the soft-phone call', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([SOFT]));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${SOFT.id}`);
    expect(row.getAttribute('data-type')).toBe('soft_phone');
    expect(screen.getByTestId(`call-type-${SOFT.id}`).textContent).toBe('Soft phone');
    expect(screen.queryByTestId(`call-facts-${SOFT.id}`)).toBeNull();
    expect(within(row).getByText('Priya Nair')).toBeTruthy();
    expect(screen.getByTestId(`attempt-outcome-${SOFT.id}`).textContent).toBe('Connected');
    // On the roster: the number links to its contact, as a dialler row's does.
    expect(within(row).getByText('+919876500099').closest('a')!.getAttribute('href')).toBe('/agency/campaigns/camp-1/contacts/contact-9');
    expect(within(row).getByText('Open call').closest('a')!.getAttribute('href')).toBe('/agency/softphone/calls/manual-1');
    expect(row.hasAttribute('data-not-dialled')).toBe(false);
  });

  it('says a soft-phone number is not on the list, and shows its override badges', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([{ ...SOFT, contact_id: null, dnc_overridden: true, hours_overridden: true }]));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${SOFT.id}`);
    expect(within(row).getByText('+919876500099').closest('a')).toBeNull();
    expect(within(row).getByText('not on the list')).toBeTruthy();
    expect(within(row).getByText('DNC override').getAttribute('title')).toBe('Called through a Do Not Call entry, with a note');
    expect(within(row).getByText('Hours override').getAttribute('title')).toBe('Called outside calling hours, with a note');
  });

  it('greys a soft-phone row whose dial was never sent and says Not dialled', async () => {
    const never: AgencyCallLogSoftphoneRow = {
      ...SOFT, id: 'manual-never', outcome: 'failed', disposition_code: null, dialed_at: null, answered_at: null,
      bridged_at: null, talk_seconds: null, webrtc_call_id: null,
    };
    mocks.getCampaignCallLog.mockResolvedValue(page([never, SOFT]));
    renderPage();
    const row = await screen.findByTestId('attempt-row-manual-never');
    expect(row.hasAttribute('data-not-dialled')).toBe(true);
    expect(screen.getByTestId('attempt-outcome-manual-never').textContent).toBe('Not dialled');
    expect(screen.getByTestId(`attempt-row-${SOFT.id}`).hasAttribute('data-not-dialled')).toBe(false);
  });

  it('says a soft-phone call is still on, and that an ended one owes its outcome', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([
      { ...SOFT, id: 'manual-live', state: 'bridged', outcome: null, disposition_code: null, ended_at: null, settled_at: null, talk_seconds: null },
      { ...SOFT, id: 'manual-owed', disposition_code: null, settled_at: null, requires_disposition: true },
    ]));
    renderPage();
    await screen.findByTestId('attempt-row-manual-live');
    expect(screen.getByTestId('attempt-outcome-manual-live').textContent).toBe('On a call now');
    expect(within(screen.getByTestId('attempt-row-manual-owed')).getByText('No outcome yet')).toBeTruthy();
  });

  it('offers no link to a soft-phone call with the soft phone off: its page is behind the flag', async () => {
    mocks.flags = new Set();
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT], { all: 1, dialler: 0, soft_phone: 1, inbound: 0, to_follow_up: 0 }));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${SOFT.id}`);
    expect(within(row).queryByText('Open call')).toBeNull();
  });
});

describe('what the Call log opens on', () => {
  /** 22 Nov 2026, 3:42 PM on the reader's calendar (TZ is UTC here). Only `Date` is faked: timers run. */
  const NOW = new Date('2026-11-22T15:42:00.000Z');
  const range = (from: string, to = from) => ({ from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` });
  const RUNNING = { id: 'camp-1', name: 'Q3 Renewals', status: 'running' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mocks.getAgencyCampaign.mockResolvedValue(RUNNING);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a live campaign: today alone when the URL carries no filter, the day in the form, and no Clear', async () => {
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(lastCall()[1]).toEqual(range('2026-11-22'));
    expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-11-22');
    expect((screen.getByLabelText('To date') as HTMLInputElement).value).toBe('2026-11-22');
    // The opening view is not something to clear, and the URL stays clean.
    expect(screen.queryByText('Clear')).toBeNull();
    expect(currentQuery().toString()).toBe('');
    // Read once, when the campaign was known: never a guess first.
    expect(mocks.getCampaignCallLog).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stopped', { status: 'stopped' }],
    ['completed', { status: 'completed' }],
    ['archived', { status: 'draft', archived_at: '2026-11-20T10:00:00.000Z' }],
  ])('a %s campaign opens on every date: its calls are all in the past', async (_name, over) => {
    mocks.getAgencyCampaign.mockResolvedValue({ ...RUNNING, ...over });
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(lastCall()[1]).toEqual({});
    expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('attempts-chip-created')).toBeNull();
    expect(mocks.getCampaignCallLog).toHaveBeenCalledTimes(1);
  });

  it('a finished campaign with no calls says so about the campaign, not about today', async () => {
    mocks.getAgencyCampaign.mockResolvedValue({ ...RUNNING, status: 'stopped' });
    mocks.getCampaignCallLog.mockResolvedValue(page([]));
    renderWithLocation('');
    await screen.findByText('No calls were placed');
    expect(screen.queryByText('Show last 7 days')).toBeNull();
  });

  it('waits for the campaign before reading the opening view, and reads at once what a link asks for', async () => {
    let answer: (value: unknown) => void = () => undefined;
    mocks.getAgencyCampaign.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const opening = renderWithLocation('');
    await act(async () => {});
    expect(mocks.getCampaignCallLog).not.toHaveBeenCalled();
    await act(async () => { answer({ ...RUNNING, status: 'completed' }); });
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(mocks.getCampaignCallLog).toHaveBeenCalledTimes(1);
    expect(lastCall()[1]).toEqual({});
    opening.unmount();

    // A link's filters do not depend on the campaign: nothing to wait for.
    mocks.getCampaignCallLog.mockClear();
    mocks.getAgencyCampaign.mockImplementation(() => new Promise(() => {}));
    renderWithLocation('?contact_id=contact-2');
    await waitFor(() => expect(lastCall()[1]).toEqual({ contact_id: 'contact-2' }));
  });

  it('opens on today when the campaign cannot be read', async () => {
    mocks.getAgencyCampaign.mockRejectedValue(new ApiError(503, { message: 'Service unavailable' }));
    renderWithLocation('');
    await waitFor(() => expect(mocks.getCampaignCallLog).toHaveBeenCalled());
    expect(lastCall()[1]).toEqual(range('2026-11-22'));
  });

  it('never narrows a link that carries a filter', async () => {
    renderWithLocation('?contact_id=contact-2');
    await waitFor(() => expect(lastCall()[1]).toEqual({ contact_id: 'contact-2' }));
  });

  it('Refresh after midnight moves the opening view on to the new day', async () => {
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(lastCall()[1]).toEqual(range('2026-11-22'));

    vi.setSystemTime(new Date('2026-11-23T00:05:00.000Z'));
    fireEvent.click(screen.getByLabelText('Refresh call log'));
    await waitFor(() => expect(lastCall()[1]).toEqual(range('2026-11-23')));
    // Counted again for the new day.
    expect(lastCall()[2]).toEqual({ limit: 50, type: 'all', includeCounts: true });
    await waitFor(() => expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-11-23'));
  });

  it('an empty day says so and offers the last seven days, then every date', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([]));
    renderWithLocation('');
    await screen.findByText('No calls on this campaign for these dates.');
    expect(screen.queryByText('No calls were placed')).toBeNull();
    expect(screen.getByText('Show all dates')).toBeTruthy();

    fireEvent.click(screen.getByText('Show last 7 days'));
    await waitFor(() => expect(lastCall()[1]).toEqual(range('2026-11-16', '2026-11-22')));
    expect(currentQuery().get('from')).toBe('2026-11-16T00:00:00.000Z');
    // Still empty: the same words, nothing offered that has already been done, and a way on.
    await screen.findByText('No calls on this campaign for these dates.');
    await waitFor(() => expect(screen.queryByText('Show last 7 days')).toBeNull());

    fireEvent.click(screen.getByText('Show all dates'));
    await waitFor(() => expect(lastCall()[1]).toEqual({}));
    expect(currentQuery().toString()).toBe('dates=all');
    // Every date and nothing: now it is a fact about the campaign.
    await screen.findByText('No calls were placed');
    expect(screen.queryByText('Show all dates')).toBeNull();
  });

  it('Show all dates keeps the chip', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([], { all: 3, dialler: 3, soft_phone: 0, inbound: 0, to_follow_up: 0 }));
    renderWithLocation('?type=soft_phone');
    // The chip's type is named in an empty day.
    await screen.findByText('No soft-phone calls on this campaign for these dates.');
    fireEvent.click(screen.getByText('Show all dates'));
    await waitFor(() => expect(currentQuery().toString()).toBe('type=soft_phone&dates=all'));
    expect(lastCall().slice(1, 3)).toEqual([{}, { limit: 50, type: 'soft_phone', includeCounts: true }]);
  });

  it('removing the dates asks for every date, and says so in the URL so it does not spring back', async () => {
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    fireEvent.click(within(screen.getByTestId('attempts-chip-created')).getByRole('button'));
    await waitFor(() => expect(currentQuery().get('dates')).toBe('all'));
    await waitFor(() => expect(lastCall()[1]).toEqual({}));
    // Clear goes back to the opening view.
    fireEvent.click(screen.getByText('Clear'));
    await waitFor(() => expect(currentQuery().toString()).toBe(''));
    await waitFor(() => expect(lastCall()[1]).toEqual(range('2026-11-22')));
  });

  it('a filter with no match offers Clear in the empty state', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([]));
    renderWithLocation('?outcome=busy');
    await screen.findByText('Nothing matches those filters');
    fireEvent.click(screen.getByTestId('call-log-empty-clear'));
    await waitFor(() => expect(currentQuery().toString()).toBe(''));
  });

  it('says beside the export that the file follows the dates shown', async () => {
    renderWithLocation('');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(screen.getByText('The export follows the dates shown above. Clear the dates to export every call on the campaign.')).toBeTruthy();
    mocks.downloadSpineCsv.mockResolvedValue({ blob: new Blob(['a']), truncated: false, reason: null, rowLimit: null, rows: 1 });
    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => expect(mocks.downloadSpineCsv).toHaveBeenCalledWith(
      'camp-1', 'attempts', range('2026-11-22'), 'tenant-1', 'account-1',
    ));
  });
});

describe('the counts are asked for only when they could have changed', () => {
  it('not for a chip, again for a filter, and again on Refresh', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT, BRIDGED]));
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${SOFT.id}`);
    expect(lastCall()[2]).toEqual({ limit: 50, type: 'all', includeCounts: true });

    // A chip: the rows again, the counts as they were (a page without counts leaves them alone).
    mocks.getCampaignCallLog.mockResolvedValue(page([BRIDGED]));
    fireEvent.click(screen.getByTestId('call-log-type-dialler'));
    await waitFor(() => expect(lastCall()[2]).toEqual({ limit: 50, type: 'dialler' }));
    await waitFor(() => expect(screen.queryByTestId(`attempt-row-${SOFT.id}`)).toBeNull());
    expect(screen.getByTestId('call-log-type-soft_phone').textContent).toBe('Soft phone86');
    expect(screen.getByTestId('attempts-count').textContent).toMatch(/^1[,.]?240 calls — showing 1$/);

    // Refresh: counted again.
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([BRIDGED], { all: 1330, dialler: 1243, soft_phone: 87, inbound: 0, to_follow_up: 0 }));
    fireEvent.click(screen.getByLabelText('Refresh call log'));
    await waitFor(() => expect(screen.getByTestId('call-log-type-soft_phone').textContent).toBe('Soft phone87'));
    expect(lastCall()[2]).toEqual({ limit: 50, type: 'dialler', includeCounts: true });

    // A filter: counted again.
    fireEvent.click(screen.getByLabelText('Busy'));
    fireEvent.click(screen.getByText('Apply'));
    await waitFor(() => expect(lastCall().slice(1, 3)).toEqual([{ outcome: ['busy'] }, { limit: 50, type: 'dialler', includeCounts: true }]));
  });
});

describe('the soft-phone status filter', () => {
  beforeEach(() => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT, BRIDGED]));
  });

  it('offers the Soft-phone calls list’s statuses and says it lists soft-phone calls only', async () => {
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${SOFT.id}`);
    const select = screen.getByLabelText(/Soft-phone status/) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Any', 'On a call now', 'Waiting for an outcome', 'Done']);
    expect(screen.getByText('Soft-phone calls only. A dialler or inbound call has no status.')).toBeTruthy();
  });

  it('applies to the list, the counts, later pages and the export, and is a chip that can be removed', async () => {
    mocks.downloadSpineCsv.mockResolvedValue({ blob: new Blob(['a']), truncated: false, reason: null, rowLimit: null, rows: 1 });
    renderWithLocation('?outcome=connected');
    await screen.findByTestId(`attempt-row-${SOFT.id}`);

    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT], { all: 4, dialler: 0, soft_phone: 4, inbound: 0, to_follow_up: 0 }, 'cursor-2'));
    fireEvent.change(screen.getByTestId('call-log-status-filter'), { target: { value: 'awaiting_outcome' } });
    fireEvent.click(screen.getByText('Apply'));
    await waitFor(() => expect(currentQuery().get('status')).toBe('awaiting_outcome'));
    expect(currentQuery().getAll('outcome')).toEqual(['connected']);
    // Counted again: the status is a filter, and the dialler's count follows it to 0.
    await waitFor(() => expect(lastCall().slice(1, 3)).toEqual([
      { outcome: ['connected'] }, { limit: 50, type: 'all', status: 'awaiting_outcome', includeCounts: true },
    ]));
    await waitFor(() => expect(screen.getByTestId('call-log-type-dialler').textContent).toBe('Dialler0'));
    expect(screen.getByText('Soft-phone status: Waiting for an outcome')).toBeTruthy();

    fireEvent.click(screen.getByText('Load older calls'));
    await waitFor(() => expect(lastCall()[2]).toEqual({ cursor: 'cursor-2', limit: 50, type: 'all', status: 'awaiting_outcome' }));

    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => expect(mocks.downloadSpineCsv).toHaveBeenCalledWith(
      'camp-1', 'attempts', { outcome: ['connected'], status: 'awaiting_outcome' }, 'tenant-1', 'account-1',
    ));

    // Removing its chip leaves the other filter and reads without it.
    fireEvent.click(within(screen.getByTestId('attempts-chip-softphone_status')).getByRole('button'));
    await waitFor(() => expect(currentQuery().has('status')).toBe(false));
    expect(currentQuery().getAll('outcome')).toEqual(['connected']);
    await waitFor(() => expect(lastCall()[2]).toEqual({ limit: 50, type: 'all', includeCounts: true }));
  });

  it('a link that carries it is read with it and fills the form; alone it is every date, and Clear drops it', async () => {
    mocks.getAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Q3 Renewals', status: 'running' });
    renderWithLocation('?status=live');
    await screen.findByTestId(`attempt-row-${SOFT.id}`);
    // A filter, so a live campaign is not narrowed to today behind it.
    expect(lastCall().slice(1, 3)).toEqual([{}, { limit: 50, type: 'all', status: 'live', includeCounts: true }]);
    expect((screen.getByTestId('call-log-status-filter') as HTMLSelectElement).value).toBe('live');
    fireEvent.click(screen.getByText('Clear'));
    await waitFor(() => expect(currentQuery().toString()).toBe(''));
  });

  it('with nothing matching says the filters match nothing, never that the campaign has no calls', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([], { all: 0, dialler: 0, soft_phone: 0, inbound: 0, to_follow_up: 0 }));
    renderWithLocation('?status=awaiting_outcome');
    await screen.findByText('Nothing matches those filters');
    expect(screen.queryByText('No calls were placed')).toBeNull();
  });

  it('is not offered with the soft phone off and no soft-phone call under the filters, and is while one is applied', async () => {
    mocks.flags = new Set();
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([BRIDGED], { all: 4, dialler: 4, soft_phone: 0, inbound: 0, to_follow_up: 0 }));
    const first = renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(screen.queryByTestId('call-log-status-filter')).toBeNull();
    first.unmount();

    mocks.getCampaignCallLog.mockResolvedValue(withCounts([], { all: 0, dialler: 0, soft_phone: 0, inbound: 0, to_follow_up: 0 }));
    renderWithLocation('?status=settled');
    await screen.findByText('Nothing matches those filters');
    expect((screen.getByTestId('call-log-status-filter') as HTMLSelectElement).value).toBe('settled');
  });

  it('ignores a status it does not know', async () => {
    renderWithLocation('?placed=1&status=done');
    await waitFor(() => expect(lastCall()[2]).toEqual({ limit: 50, type: 'all', includeCounts: true }));
  });
});

describe('the campaign’s old Soft-phone calls URL', () => {
  it('redirects to the Call log with the Soft phone chip on', async () => {
    const { CampaignManualCallsRedirect } = await import('../../pages/agency/AgencyCampaignAttemptsPage');
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT]));
    render(
      <MemoryRouter initialEntries={['/agency/campaigns/camp-1/manual-calls']}>
        <AttemptsLocationProbe />
        <Routes>
          <Route path="/agency/campaigns/:id/manual-calls" element={<CampaignManualCallsRedirect />} />
          <Route path="/agency/campaigns/:id/attempts" element={<AttemptsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId(`attempt-row-${SOFT.id}`);
    expect(currentQuery().get('type')).toBe('soft_phone');
    expect(screen.getByTestId('call-log-type-soft_phone').getAttribute('aria-pressed')).toBe('true');
    expect(lastCall()[2]).toMatchObject({ type: 'soft_phone' });
  });

  it('keeps the query an old link carried', async () => {
    const { CampaignManualCallsRedirect } = await import('../../pages/agency/AgencyCampaignAttemptsPage');
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([SOFT]));
    render(
      <MemoryRouter initialEntries={['/agency/campaigns/camp-1/manual-calls?phone=98765&type=dialler']}>
        <AttemptsLocationProbe />
        <Routes>
          <Route path="/agency/campaigns/:id/manual-calls" element={<CampaignManualCallsRedirect />} />
          <Route path="/agency/campaigns/:id/attempts" element={<AttemptsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId(`attempt-row-${SOFT.id}`);
    expect(currentQuery().get('phone')).toBe('98765');
    expect(currentQuery().getAll('type')).toEqual(['soft_phone']);
    expect(lastCall().slice(1, 3)).toEqual([{ phone: '98765' }, { limit: 50, type: 'soft_phone', includeCounts: true }]);
  });
});

// ─── Inbound in the log (docs/call-log.md §4, P2) ───────────────────────────

/** Answered by the caller's own agent after 18 seconds; on the roster, outcome saved. */
const INBOUND_ANSWERED: AgencyCallLogInboundRow = {
  type: 'inbound', id: 'inbound-answered', campaign_id: 'camp-1', campaign_source: 'contact', contact_id: 'contact-7',
  phone_e164: '+919876504821', caller_id: '+919000000001', route_name: 'Sales line',
  agent_user_id: 'bd2f9d2e-1111-4222-8333-444455556666', agent_name: 'Priya Nair', state: 'ended', outcome: 'answered',
  disposition_code: 'not_interested', notes: null, callback_at: null, promise_date: null, promise_amount: null,
  dispositioned_by_user_id: 'bd2f9d2e-1111-4222-8333-444455556666', dispositioned_at: '2026-08-17T15:47:00.000Z',
  dispositioned_on_behalf: false, webrtc_call_id: 'call-88', answered_at: '2026-08-17T15:42:01.000Z',
  bridged_at: '2026-08-17T15:42:19.000Z', ended_at: '2026-08-17T15:46:31.000Z', talk_seconds: 252,
  wait_seconds: 18, queued: true, via_sticky_agent: true, requires_disposition: false, settled_at: '2026-08-17T15:47:00.000Z',
  voicemail_seconds: null, follow_up: null, called_back: null, created_at: '2026-08-17T15:42:01.000Z',
};
/** Nobody free, left a voicemail; open, assigned to Arjun; not on the list. */
const INBOUND_MISSED: AgencyCallLogInboundRow = {
  ...INBOUND_ANSWERED, id: 'inbound-missed', campaign_source: 'route', contact_id: null, phone_e164: '+919812307730',
  agent_user_id: null, agent_name: null, outcome: 'voicemail', disposition_code: null, dispositioned_by_user_id: null,
  dispositioned_at: null, bridged_at: null, talk_seconds: null, wait_seconds: 100, via_sticky_agent: false, voicemail_seconds: 22,
  follow_up: { status: 'open', reason: 'overflow', closed_cause: null, assignee_user_id: 'u-arjun', assignee_name: 'Arjun Mehta', handled_reason: null, handled_at: null },
  created_at: '2026-08-17T15:12:00.000Z',
};
const INBOUND_COUNTS = { all: 1383, dialler: 1240, soft_phone: 86, inbound: 57, to_follow_up: 6 };

describe('the Inbound and To follow up chips', () => {
  beforeEach(() => {
    mocks.flags = new Set(['agency_softphone_enabled', 'agency_inbound_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([INBOUND_ANSWERED, BRIDGED], INBOUND_COUNTS));
  });

  it('shows All · Dialler · Soft phone · Inbound · To follow up with their counts, To follow up as owed work', async () => {
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${INBOUND_ANSWERED.id}`);
    const chips = within(screen.getByTestId('call-log-types')).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['All1,383', 'Dialler1,240', 'Soft phone86', 'Inbound57', 'To follow up6']);
    expect(screen.getByTestId('call-log-type-to_follow_up').hasAttribute('data-warning')).toBe(true);
    expect(screen.getByTestId('call-log-type-inbound').hasAttribute('data-warning')).toBe(false);
    expect(screen.queryByTestId('call-log-follow-up-note')).toBeNull();
  });

  it('hides To follow up at 0, and Inbound with inbound off and no inbound call in the range', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([BRIDGED], { ...INBOUND_COUNTS, to_follow_up: 0 }));
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(screen.queryByTestId('call-log-type-to_follow_up')).toBeNull();
    expect(screen.getByTestId('call-log-type-inbound')).toBeTruthy();
    cleanup();

    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([BRIDGED], { all: 1326, dialler: 1240, soft_phone: 86, inbound: 0, to_follow_up: 0 }));
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(screen.queryByTestId('call-log-type-inbound')).toBeNull();
    // Switched off, but the range holds inbound calls: the chip stays.
    cleanup();
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([INBOUND_ANSWERED], INBOUND_COUNTS));
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${INBOUND_ANSWERED.id}`);
    expect(screen.getByTestId('call-log-type-inbound')).toBeTruthy();
  });

  it('To follow up reads the open missed calls, says the dates do not narrow it, and exports that view', async () => {
    mocks.downloadSpineCsv.mockResolvedValue({ blob: new Blob(['a']), truncated: false, reason: null, rowLimit: null, rows: 1 });
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${INBOUND_ANSWERED.id}`);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([INBOUND_MISSED], INBOUND_COUNTS));
    fireEvent.click(screen.getByTestId('call-log-type-to_follow_up'));
    await waitFor(() => expect(currentQuery().get('type')).toBe('to_follow_up'));
    await screen.findByTestId(`attempt-row-${INBOUND_MISSED.id}`);
    expect(lastCall()[2]).toMatchObject({ type: 'to_follow_up' });
    expect(screen.getByTestId('call-log-follow-up-note').textContent).toContain('whatever the dates');
    expect(screen.getByTestId('attempts-count').textContent).toContain('6 calls');
    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => expect(mocks.downloadSpineCsv).toHaveBeenCalled());
    expect(mocks.downloadSpineCsv.mock.calls[0]![2]).toMatchObject({ source: 'to_follow_up' });
  });

  it('What happened offers Missed, Voicemail and Abandoned, sends them as outcomes, and names them on their chips', async () => {
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${INBOUND_ANSWERED.id}`);
    expect(screen.getByTestId('call-log-inbound-outcome-hint').textContent).toContain('inbound calls only');
    fireEvent.click(screen.getByLabelText('Missed'));
    fireEvent.click(screen.getByLabelText('Abandoned (hung up while waiting)'));
    fireEvent.click(screen.getByText('Apply'));
    await waitFor(() => expect(currentQuery().getAll('outcome')).toEqual(['missed', 'abandoned_in_queue']));
    await waitFor(() => expect(lastCall()[1]).toEqual({ outcome: ['missed', 'abandoned_in_queue'] }));
    expect(screen.getByText('Outcome: Missed')).toBeTruthy();
    expect(screen.getByText('Outcome: Abandoned (hung up while waiting)')).toBeTruthy();
  });

  it('does not offer the inbound choices with inbound off and no inbound call', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([BRIDGED], { all: 4, dialler: 4, soft_phone: 0, inbound: 0, to_follow_up: 0 }));
    renderWithLocation('?dates=all');
    await screen.findByTestId(`attempt-row-${BRIDGED.id}`);
    expect(screen.queryByLabelText('Missed')).toBeNull();
    expect(screen.queryByTestId('call-log-inbound-outcome-hint')).toBeNull();
  });
});

describe('an inbound row', () => {
  beforeEach(() => {
    mocks.flags = new Set(['agency_softphone_enabled', 'agency_inbound_enabled']);
  });

  it('an answered call: rang us, who answered, the wait and their own agent, its outcome, and its Call page', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([INBOUND_ANSWERED]));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${INBOUND_ANSWERED.id}`);
    expect(row.getAttribute('data-type')).toBe('inbound');
    expect(screen.getByTestId(`call-type-${INBOUND_ANSWERED.id}`).textContent).toBe('Inbound');
    expect(screen.getByTestId(`call-facts-${INBOUND_ANSWERED.id}`).textContent).toBe('rang us');
    expect(within(row).getByText('Priya Nair')).toBeTruthy();
    expect(screen.getByTestId(`attempt-outcome-${INBOUND_ANSWERED.id}`).textContent).toBe('Answered');
    expect(screen.getByTestId(`call-happened-detail-${INBOUND_ANSWERED.id}`).textContent).toBe('waited 0:18 · came through their agent');
    expect(within(row).getByText('+919876504821').closest('a')!.getAttribute('href')).toBe('/agency/campaigns/camp-1/contacts/contact-7');
    expect(within(row).getByText('4:12')).toBeTruthy();
    expect(within(row).getByText('Open call').closest('a')!.getAttribute('href')).toBe('/agency/campaigns/camp-1/calls/inbound/inbound-answered');
    expect(screen.queryByTestId(`call-follow-up-${INBOUND_ANSWERED.id}`)).toBeNull();
  });

  it('a missed call: why, who it is assigned to, To follow up with its two actions, and its voicemail', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([INBOUND_MISSED]));
    renderPage();
    const row = await screen.findByTestId(`attempt-row-${INBOUND_MISSED.id}`);
    expect(screen.getByTestId(`attempt-outcome-${INBOUND_MISSED.id}`).textContent).toBe('Missed');
    expect(screen.getByTestId(`call-happened-detail-${INBOUND_MISSED.id}`).textContent).toBe('nobody free to answer · waited 1:40');
    expect(screen.getByTestId(`call-assignee-${INBOUND_MISSED.id}`).textContent).toBe('assigned to Arjun Mehta');
    expect(within(row).getByText('not on the list')).toBeTruthy();
    const followUp = screen.getByTestId(`call-follow-up-${INBOUND_MISSED.id}`);
    expect(within(followUp).getByText('To follow up')).toBeTruthy();
    expect(screen.getByTestId(`mark-handled-${INBOUND_MISSED.id}`)).toBeTruthy();
    expect(screen.getByTestId(`call-back-${INBOUND_MISSED.id}`)).toBeTruthy();
    expect(within(row).getByText('Voicemail 0:22').closest('a')!.getAttribute('href')).toBe('/agency/campaigns/camp-1/calls/inbound/inbound-missed');
  });

  it('a withheld number has nothing to call back; a handled call says how it was closed and offers no action', async () => {
    const handled = { ...INBOUND_MISSED.follow_up!, status: 'handled' as const, handled_reason: 'reached' as const, handled_at: '2026-08-17T16:00:00.000Z' };
    mocks.getCampaignCallLog.mockResolvedValue(page([
      { ...INBOUND_MISSED, id: 'withheld', phone_e164: null, voicemail_seconds: null },
      { ...INBOUND_MISSED, id: 'reached', follow_up: handled },
    ]));
    renderPage();
    const withheld = await screen.findByTestId('attempt-row-withheld');
    expect(within(withheld).getByText('Number withheld')).toBeTruthy();
    expect(screen.queryByTestId('call-back-withheld')).toBeNull();
    expect(screen.getByTestId('mark-handled-withheld')).toBeTruthy();
    expect(screen.getByTestId('call-follow-up-reached').textContent).toBe('Customer reached');
    expect(screen.queryByTestId('mark-handled-reached')).toBeNull();
  });

  it('offers Call back only where the viewer may dial from the soft phone', async () => {
    mocks.flags = new Set(['agency_inbound_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(page([INBOUND_MISSED]));
    renderPage();
    await screen.findByTestId(`attempt-row-${INBOUND_MISSED.id}`);
    expect(screen.queryByTestId(`call-back-${INBOUND_MISSED.id}`)).toBeNull();
    expect(screen.getByTestId(`mark-handled-${INBOUND_MISSED.id}`)).toBeTruthy();
  });

  it('Mark handled is the Missed list’s action; the list and its counts are read again', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([INBOUND_MISSED], INBOUND_COUNTS));
    mocks.markMissedInboundCallHandled.mockResolvedValue({ ok: true, value: {} });
    renderWithLocation('?type=to_follow_up');
    await screen.findByTestId(`attempt-row-${INBOUND_MISSED.id}`);
    const reads = mocks.getCampaignCallLog.mock.calls.length;
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([], { ...INBOUND_COUNTS, to_follow_up: 5 }));
    fireEvent.click(screen.getByTestId(`mark-handled-${INBOUND_MISSED.id}`));
    await waitFor(() => expect(mocks.markMissedInboundCallHandled).toHaveBeenCalledWith('inbound-missed', 'tenant-1', 'account-1'));
    await waitFor(() => expect(mocks.getCampaignCallLog.mock.calls.length).toBe(reads + 1));
    expect(lastCall()[2]).toMatchObject({ type: 'to_follow_up', includeCounts: true });
    expect(mocks.refreshMissedCallsCount).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId(`attempt-row-${INBOUND_MISSED.id}`)).toBeNull());
    expect(screen.getByTestId('call-log-type-to_follow_up').textContent).toBe('To follow up5');
  });

  it('a Mark handled the server refuses is said on the row, and the row stays', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([INBOUND_MISSED]));
    mocks.markMissedInboundCallHandled.mockResolvedValue({ ok: false, refusal: { code: 'inbound_missed_call_not_found', message: 'gone' } });
    renderPage();
    await screen.findByTestId(`attempt-row-${INBOUND_MISSED.id}`);
    fireEvent.click(screen.getByTestId(`mark-handled-${INBOUND_MISSED.id}`));
    const said = await within(screen.getByTestId(`call-follow-up-${INBOUND_MISSED.id}`)).findByRole('alert');
    expect(said.textContent!.length).toBeGreaterThan(10);
    expect(screen.getByTestId(`attempt-row-${INBOUND_MISSED.id}`)).toBeTruthy();
  });

  it('Call back opens the soft phone with the number, this campaign and the missed call’s id, and dials nothing', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([INBOUND_MISSED]));
    let landed: { pathname: string; state: unknown } | null = null;
    function Phone() {
      const location = useLocation();
      landed = { pathname: location.pathname, state: location.state };
      return <p>the soft phone</p>;
    }
    render(
      <MemoryRouter initialEntries={[ALL_DATES]}>
        <Routes>
          <Route path="/agency/campaigns/:id/attempts" element={<AttemptsPage />} />
          <Route path="/dialer/phone" element={<Phone />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId(`call-back-${INBOUND_MISSED.id}`));
    await screen.findByText('the soft phone');
    expect(landed).toEqual({
      pathname: '/dialer/phone',
      state: { softphonePrefill: { number: '+919812307730', campaignId: 'camp-1', inboundCallId: 'inbound-missed' } },
    });
  });
});

describe('a missed call and its call back', () => {
  const CALL_BACK: AgencyCallLogSoftphoneRow = {
    ...SOFT, id: 'manual-callback', contact_id: null, phone_e164: '+919812307730', created_at: '2026-08-17T15:31:00.000Z',
    callback_of: { inbound_call_id: INBOUND_MISSED.id, arrived_at: INBOUND_MISSED.created_at },
  };
  const RUNG_BACK = { ...INBOUND_MISSED, called_back: { call_id: CALL_BACK.id, at: CALL_BACK.created_at } };

  beforeEach(() => {
    mocks.flags = new Set(['agency_softphone_enabled', 'agency_inbound_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(page([CALL_BACK, BRIDGED, RUNG_BACK]));
  });

  it('point at each other in words: the call back stays a Soft phone call', async () => {
    renderPage();
    await screen.findByTestId(`attempt-row-${CALL_BACK.id}`);
    expect(screen.getByTestId(`call-type-${CALL_BACK.id}`).textContent).toBe('Soft phone');
    expect(screen.getByTestId(`call-facts-${CALL_BACK.id}`).textContent).toBe('Call back · to the 3:12 PM missed call');
    const followUp = screen.getByTestId(`call-follow-up-${RUNG_BACK.id}`);
    expect(within(followUp).getByText('Called back 3:31 PM')).toBeTruthy();
    // Rung back, and the Missed row is still open: still to follow up.
    expect(within(followUp).getByText('To follow up')).toBeTruthy();
  });

  it('hovering one lights the other, and only the pair is marked', async () => {
    renderPage();
    const callBack = await screen.findByTestId(`attempt-row-${CALL_BACK.id}`);
    const missed = screen.getByTestId(`attempt-row-${RUNG_BACK.id}`);
    expect(callBack.hasAttribute('data-paired')).toBe(true);
    expect(missed.hasAttribute('data-paired')).toBe(true);
    expect(screen.getByTestId(`attempt-row-${BRIDGED.id}`).hasAttribute('data-paired')).toBe(false);
    fireEvent.mouseEnter(callBack);
    expect(missed.hasAttribute('data-pair-lit')).toBe(true);
    expect(callBack.hasAttribute('data-pair-lit')).toBe(false);
    fireEvent.mouseLeave(callBack);
    expect(missed.hasAttribute('data-pair-lit')).toBe(false);
    fireEvent.mouseEnter(missed);
    expect(callBack.hasAttribute('data-pair-lit')).toBe(true);
  });

  it('a dial the customer’s own call stopped says so', async () => {
    mocks.getCampaignCallLog.mockResolvedValue(page([{ ...CANCELED, disposition_code: 'inbound_call' }]));
    renderPage();
    await screen.findByTestId(`attempt-row-${CANCELED.id}`);
    expect(screen.getByTestId(`attempt-outcome-${CANCELED.id}`).textContent).toBe('Stopped: customer rang us');
  });
});

describe('every time on the Call log reads with AM / PM in capitals', () => {
  it('the When column, the pair’s times and a dialled-window chip', async () => {
    mocks.flags = new Set(['agency_softphone_enabled', 'agency_inbound_enabled']);
    const rungBack = { ...INBOUND_MISSED, called_back: { call_id: 'manual-cb', at: '2026-08-17T15:31:00.000Z' } };
    const callBack: AgencyCallLogSoftphoneRow = {
      ...SOFT, id: 'manual-cb', created_at: '2026-08-17T15:31:00.000Z',
      callback_of: { inbound_call_id: INBOUND_MISSED.id, arrived_at: INBOUND_MISSED.created_at },
    };
    mocks.getCampaignCallLog.mockResolvedValue(page([callBack, rungBack]));
    renderWithLocation('?dialed_from=2026-08-17T09:00:00.000Z&dialed_to=2026-08-17T18:00:00.000Z');
    const row = await screen.findByTestId(`attempt-row-${rungBack.id}`);
    expect(within(row).getByText('17 Aug 2026, 03:12 PM')).toBeTruthy();
    expect(within(row).getByText('Called back 3:31 PM')).toBeTruthy();
    expect(screen.getByTestId('call-facts-manual-cb').textContent).toBe('Call back · to the 3:12 PM missed call');
    expect(screen.getByText('Dialled from 17 Aug 2026, 09:00 AM, up to 17 Aug 2026, 06:00 PM')).toBeTruthy();
    // Not one lower-case period anywhere in the list or its chips.
    expect(document.body.textContent).not.toMatch(/\d (am|pm)\b/);
  });
});

describe('with To follow up on, the dates narrow nothing and the page says so', () => {
  beforeEach(() => {
    mocks.flags = new Set(['agency_softphone_enabled', 'agency_inbound_enabled']);
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([INBOUND_MISSED], INBOUND_COUNTS));
  });

  it('switches the date fields off with the reason, drops the export’s dates tip and the dates chip, and keeps the dates in the URL', async () => {
    renderWithLocation('?type=to_follow_up&from=2026-08-17T00:00:00.000Z&to=2026-08-17T23:59:59.999Z');
    await screen.findByTestId(`attempt-row-${INBOUND_MISSED.id}`);
    const [from, to] = [screen.getByLabelText('From date'), screen.getByLabelText(/^To date/)] as HTMLInputElement[];
    expect(from!.disabled).toBe(true);
    expect(to!.disabled).toBe(true);
    expect(screen.getByTestId('call-log-dates-off').textContent).toBe('To follow up shows every open missed call, whatever the dates.');
    expect(screen.queryByText(/The export follows the dates shown above/)).toBeNull();
    expect(screen.queryByText(/^Created /)).toBeNull();
    expect(screen.queryByText(/17 Aug 2026 to|From 17 Aug/)).toBeNull();

    // Another chip: the dates were kept, the fields work again, and the tip is back.
    mocks.getCampaignCallLog.mockResolvedValue(withCounts([INBOUND_ANSWERED], INBOUND_COUNTS));
    fireEvent.click(screen.getByTestId('call-log-type-inbound'));
    await screen.findByTestId(`attempt-row-${INBOUND_ANSWERED.id}`);
    expect(currentQuery().get('from')).toBe('2026-08-17T00:00:00.000Z');
    expect((screen.getByLabelText('From date') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId('call-log-dates-off')).toBeNull();
    expect(screen.getByText(/The export follows the dates shown above/)).toBeTruthy();
  });

  it('dates the wrong way round do not block Apply there', async () => {
    renderWithLocation('?type=to_follow_up&from=2026-08-20T00:00:00.000Z&to=2026-08-10T00:00:00.000Z');
    await screen.findByTestId(`attempt-row-${INBOUND_MISSED.id}`);
    expect(screen.queryByTestId('attempts-inverted-range')).toBeNull();
    expect((screen.getByText('Apply') as HTMLButtonElement).disabled).toBe(false);
  });
});
