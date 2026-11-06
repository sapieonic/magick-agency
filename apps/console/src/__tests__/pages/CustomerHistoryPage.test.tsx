import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CustomerSearchResponse } from '@magick-agency/contracts/api/agency/customer-history';
import { customerHistoryFixture } from '../helpers/customerHistory';

/**
 * The Customer history page (`docs/customer-history.md` §3–§5).
 *
 * Pinned: the summary (who the number belongs to, totals, DNC at every level, open
 * items), one row per timeline kind with CH8's visibility (notes hidden, a call
 * link only when the server gave a call page, through `go` for another account),
 * "Load more" by cursor, filters that re-query from the first page, the CSV export,
 * the empty history, an expired search and the rate-limit copy.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  go: vi.fn(),
  searchCustomers: vi.fn(),
  getCustomerTimeline: vi.fn(),
  exportCustomerHistory: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/UrlScopeContext', () => ({
  useUrlScope: () => ({ scope: null, prefix: '', history: null, go: mocks.go }),
}));
vi.mock('../../api/customerHistory', () => ({
  searchCustomers: mocks.searchCustomers,
  getCustomerTimeline: mocks.getCustomerTimeline,
  exportCustomerHistory: mocks.exportCustomerHistory,
}));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  SOFTPHONE_FLAG: 'agency_softphone_enabled',
  useFeatureFlagEnabled: () => false,
}));

import CustomerHistoryPage, { AgentCustomerHistoryPage } from '../../pages/agency/CustomerHistoryPage';
import { clearCustomerSearchAnswers, rememberCustomerSearchAnswer } from '../../utils/customerHistoryStore';
import { ApiError } from '../../api/client';

const ACCOUNT = '0f4e3d2c-1b0a-4987-8654-3210fedcba98';
const OTHER_ACCOUNT = '11111111-2222-4333-8444-555555555555';

function renderPage(answer: CustomerSearchResponse | null, searchId = answer?.search_id ?? 'chs_unknown') {
  if (answer) rememberCustomerSearchAnswer(answer);
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/agency/customers', state: { searchId } }]}>
      <Routes>
        <Route path="/agency/customers" element={<CustomerHistoryPage />} />
        <Route path="/agency/softphone/calls/:id" element={<div data-testid="softphone-call-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const entries = () => screen.queryAllByTestId('customer-timeline-entry');
const kinds = () => entries().map((e) => e.getAttribute('data-kind'));

beforeEach(() => {
  vi.clearAllMocks();
  clearCustomerSearchAnswers();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: ACCOUNT,
    role: 'account_admin',
    accountResolution: 'ready',
    accountError: null,
    reloadAccounts: vi.fn(),
  });
  mocks.getCustomerTimeline.mockResolvedValue({ entries: [], next_cursor: null });
});


describe('the header and the summary', () => {
  it('echoes the number the server searched, with a copy button', () => {
    renderPage(customerHistoryFixture().search_response);
    expect(screen.getByTestId('customer-results-title').textContent).toBe('Results for +91 98765 43210');
    expect(screen.getByRole('button', { name: 'Copy +91 98765 43210' })).toBeTruthy();
  });

  it('copies the E.164', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage(customerHistoryFixture().search_response);
    fireEvent.click(screen.getByRole('button', { name: 'Copy +91 98765 43210' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('+919876543210'));
  });

  it('shows who the number belongs to, per retry chain', () => {
    renderPage(customerHistoryFixture().search_response);
    const contacts = screen.getAllByTestId('customer-contact');
    expect(contacts).toHaveLength(2);
    const first = contacts[0]!;
    expect(first.textContent).toContain('October dues → October dues (retry 1)');
    expect(first.textContent).toContain('Running');
    expect(first.textContent).toContain('Asha Rao');
    expect(first.textContent).toContain('LN-0042');
    expect(first.textContent).toContain('Waiting');
    expect(first.textContent).toContain('3 calls placed');
    expect(first.textContent).toContain('Assigned to Priya Nair');
    expect(first.textContent).toContain('from october-dues.csv');
    const second = contacts[1]!;
    expect(second.textContent).toContain('Suppressed: On the Do Not Call list');
    expect(second.textContent).toContain('Shared pool');
    // One account in the whole answer: its name would only be noise.
    expect(first.textContent).not.toContain('Collections North');
  });

  it('names the account when the answer spans several', () => {
    const answer = customerHistoryFixture().search_response;
    answer.summary.contacts[1]!.account_id = OTHER_ACCOUNT;
    answer.summary.contacts[1]!.account_name = 'Collections South';
    renderPage(answer);
    expect(screen.getAllByTestId('customer-contact')[1]!.textContent).toContain('Account: Collections South');
  });

  it('shows the totals and the last contact', () => {
    renderPage(customerHistoryFixture().search_response);
    expect(screen.getByTestId('customer-total-calls').textContent).toBe('4');
    expect(screen.getByTestId('customer-total-connected').textContent).toBe('2');
    const last = screen.getByTestId('customer-last-contacted').textContent ?? '';
    expect(last).toContain('by Priya Nair');
    expect(last).toContain('Soft-phone call');
    expect(last).toContain('Connected');
    expect(last).toContain('ptp');
  });

  it('shows every DNC entry with its level, who and why', () => {
    renderPage(customerHistoryFixture().search_response);
    const entry = screen.getByTestId('customer-dnc-entry');
    expect(entry.textContent).toContain('Campaign: October dues (Collections North)');
    expect(entry.textContent).toContain('Marked by an agent by Priya Nair');
    expect(entry.textContent).toContain('Asked not to be called');
    expect(screen.queryByTestId('customer-dnc-none')).toBeNull();
  });

  it('shows the open items: callback due with its owner, the override, the live call', () => {
    renderPage(customerHistoryFixture().search_response);
    expect(screen.getByTestId('customer-open-callback').textContent).toContain('for Priya Nair');
    expect(screen.getByTestId('customer-open-override').textContent).toContain('Override from ptp');
    expect(screen.getByTestId('customer-open-override').textContent).toContain('2 extra attempts, retry delay waived');
    expect(screen.getByTestId('customer-live-call').textContent).toContain('Live now');
  });
});

describe('the timeline', () => {
  it('renders one row per kind, newest first, as the server ordered them', () => {
    renderPage(customerHistoryFixture().search_response);
    expect(kinds()).toEqual(['softphone_call', 'callback', 'campaign_call', 'dnc_mark', 'roster_entry']);
    expect(entries()[1]!.textContent).toContain('Callback · Upcoming');
    expect(entries()[3]!.textContent).toContain('Added to a do-not-call list');
    expect(entries()[4]!.textContent).toContain('Added to October dues from october-dues.csv');
  });

  it('shows the notes it may, says "Notes hidden" where it may not, and the soft-phone fields', () => {
    renderPage(customerHistoryFixture().search_response);
    const [softphone, , campaign] = entries();
    expect(within(softphone!).getByTestId('customer-notes').textContent).toBe('Will pay on Friday');
    expect(within(softphone!).getByTestId('customer-call-fields').textContent).toContain('promised_amount');
    expect(within(softphone!).getByTestId('customer-call-fields').textContent).toContain('UPI');
    expect(within(campaign!).getByTestId('customer-notes-hidden').textContent).toBe('Notes hidden');
    expect(within(campaign!).queryByTestId('customer-notes')).toBeNull();
  });

  it('shows the campaign call’s agent, outcome, code, talk time, redial and override note', () => {
    renderPage(customerHistoryFixture().search_response);
    const campaign = entries()[2]!;
    expect(campaign.textContent).toContain('Karan Shah');
    expect(campaign.textContent).toContain('Connected');
    expect(campaign.textContent).toContain('Outcome code: callback');
    expect(campaign.textContent).toContain('Talk time 1m 35s');
    expect(within(campaign).getByTestId('customer-redial').textContent).toBe('Wrap-up redial 1');
    expect(within(campaign).getByTestId('customer-override').textContent).toContain(
      'Customer asked to be called after salary day',
    );
  });

  it('says "Recording expired" rather than offering a player, and the other recording states', () => {
    const answer = customerHistoryFixture().search_response;
    renderPage(answer);
    expect(within(entries()[2]!).getByTestId('customer-recording').textContent).toBe('Recording expired');
    expect(within(entries()[0]!).getByTestId('customer-recording').textContent).toBe('Recording available');
  });

  it.each([
    ['no_call', 'No call was connected'],
    ['not_recorded', 'Not recorded'],
  ] as const)('labels recording %s', (state, label) => {
    const answer = customerHistoryFixture().search_response;
    const call = answer.timeline.entries[0]!;
    if (call.kind === 'softphone_call') call.recording = state;
    renderPage(answer);
    expect(within(entries()[0]!).getByTestId('customer-recording').textContent).toBe(label);
  });

  it('links a call to its page only when the server gave one (CH8)', () => {
    renderPage(customerHistoryFixture().search_response);
    const link = within(entries()[0]!).getByTestId('customer-call-link');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/agency/softphone/calls/d4c3b2a1-0f9e-4d8c-b7a6-958473625140');
    // The campaign call's `call_page` is null: no link at all.
    expect(within(entries()[2]!).queryByTestId('customer-call-link')).toBeNull();
  });

  it('opens a call in another account through the URL scope, not a plain link', () => {
    const answer = customerHistoryFixture().search_response;
    const call = answer.timeline.entries[2]!;
    if (call.kind === 'campaign_call') {
      call.call_page = { account_id: OTHER_ACCOUNT, campaign_id: 'camp-9', attempt_id: 'att-9' };
    }
    renderPage(answer);
    const button = within(entries()[2]!).getByTestId('customer-call-link');
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(mocks.go).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', accountId: OTHER_ACCOUNT },
      '/agency/campaigns/camp-9/attempts/att-9',
    );
  });

  it('loads more with the cursor, appending the next page', async () => {
    const answer = customerHistoryFixture().search_response;
    const more = customerHistoryFixture().search_response.timeline.entries.map((e) => ({ ...e, key: `${e.key}-older` }));
    mocks.getCustomerTimeline.mockResolvedValue({ entries: more.slice(0, 2), next_cursor: null });
    renderPage(answer);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(entries()).toHaveLength(7));
    expect(mocks.getCustomerTimeline).toHaveBeenCalledWith(
      { search_id: answer.search_id, cursor: answer.timeline.next_cursor },
      'tenant-1',
      ACCOUNT,
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('re-queries from the first page when a filter changes', async () => {
    const answer = customerHistoryFixture().search_response;
    mocks.getCustomerTimeline.mockResolvedValue({ entries: answer.timeline.entries.slice(2, 3), next_cursor: null });
    renderPage(answer);

    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: '6b0d8f1a-2c3e-4f4a-9b5c-6d7e8f9a0b1c' } });

    await waitFor(() => expect(kinds()).toEqual(['campaign_call']));
    expect(mocks.getCustomerTimeline).toHaveBeenLastCalledWith(
      { search_id: answer.search_id, filters: { campaign_ids: ['6b0d8f1a-2c3e-4f4a-9b5c-6d7e8f9a0b1c'] } },
      'tenant-1',
      ACCOUNT,
    );

    fireEvent.click(screen.getByLabelText('Connected calls only'));
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'softphone' } });
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'connected' } });
    fireEvent.change(screen.getByLabelText('Outcome code'), { target: { value: 'ptp' } });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-06' } });

    await waitFor(() =>
      expect(mocks.getCustomerTimeline).toHaveBeenLastCalledWith(
        {
          search_id: answer.search_id,
          filters: {
            campaign_ids: ['6b0d8f1a-2c3e-4f4a-9b5c-6d7e8f9a0b1c'],
            connected_only: true,
            channel: 'softphone',
            outcomes: ['connected'],
            disposition_codes: ['ptp'],
            agent_user_ids: ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
            from: '2026-10-01T00:00:00.000Z',
            to: '2026-11-07T00:00:00.000Z',
          },
        },
        'tenant-1',
        ACCOUNT,
      ),
    );
    // No call to the timeline ever carried a cursor: every filter change starts again.
    for (const call of mocks.getCustomerTimeline.mock.calls) expect(call[0]).not.toHaveProperty('cursor');
  });

  it('says so when the filters match nothing, and Clear filters starts again', async () => {
    renderPage(customerHistoryFixture().search_response);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'campaign' } });
    expect((await screen.findByTestId('customer-timeline-empty')).textContent).toBe(
      'Nothing in this history matches these filters.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() =>
      expect(mocks.getCustomerTimeline).toHaveBeenLastCalledWith(
        { search_id: 'chs_6f1c2b9e4d8a4f0fa1b2c3d4e5f60718' },
        'tenant-1',
        ACCOUNT,
      ),
    );
  });
});

describe('the export', () => {
  function stubDownload() {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    return {
      click,
      restore: () => {
        createObjectURL.mockRestore();
        revokeObjectURL.mockRestore();
        click.mockRestore();
      },
    };
  }

  it('exports with the search id and the current filters, under the server’s filename', async () => {
    const { click, restore } = stubDownload();
    mocks.exportCustomerHistory.mockResolvedValue({ blob: new Blob(['x']), filename: 'history.csv', truncated: false });
    renderPage(customerHistoryFixture().search_response);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'campaign' } });

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect((await screen.findByTestId('customer-export-note')).textContent).toBe('Export downloaded.');
    expect(mocks.exportCustomerHistory).toHaveBeenCalledWith(
      { search_id: 'chs_6f1c2b9e4d8a4f0fa1b2c3d4e5f60718', filters: { channel: 'campaign' } },
      'tenant-1',
      ACCOUNT,
    );
    expect(click).toHaveBeenCalled();
    restore();
  });

  it('says when the file was cut short', async () => {
    const { restore } = stubDownload();
    mocks.exportCustomerHistory.mockResolvedValue({ blob: new Blob(['x']), filename: 'h.csv', truncated: true });
    renderPage(customerHistoryFixture().search_response);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect((await screen.findByTestId('customer-export-note')).textContent).toContain('only the newest rows');
    restore();
  });
});

describe('the empty history', () => {
  it('says there are no calls in the accounts you can see, and still shows the DNC status', () => {
    renderPage(customerHistoryFixture().search_response_empty);
    expect(screen.getByText('No calls to this number in the accounts you can see')).toBeTruthy();
    expect(screen.getByTestId('customer-dnc-none').textContent).toBe('Not on any do-not-call list');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows the DNC entry on an otherwise empty history', () => {
    const answer = customerHistoryFixture().search_response_empty;
    answer.summary.dnc = customerHistoryFixture().search_response.summary.dnc;
    renderPage(answer);
    expect(screen.getByText('No calls to this number in the accounts you can see')).toBeTruthy();
    expect(screen.getByTestId('customer-dnc-entry')).toBeTruthy();
  });
});

describe('refusals', () => {
  it('asks to search again when the search has expired, and searches the same number', async () => {
    const answer = customerHistoryFixture().search_response;
    mocks.getCustomerTimeline.mockRejectedValue(new ApiError(404, customerHistoryFixture().error_search_expired));
    const fresh = { ...customerHistoryFixture().search_response, search_id: 'chs_fresh' };
    mocks.searchCustomers.mockResolvedValue(fresh);
    renderPage(answer);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    const banner = await screen.findByTestId('customer-search-expired');
    expect(banner.textContent).toContain('This search has expired. Search the number again');

    fireEvent.click(within(banner).getByRole('button', { name: 'Search again' }));
    await waitFor(() =>
      expect(mocks.searchCustomers).toHaveBeenCalledWith({ by: 'phone', value: '+919876543210' }, 'tenant-1', ACCOUNT),
    );
    await waitFor(() => expect(screen.queryByTestId('customer-search-expired')).toBeNull());
  });

  it('says how long to wait on a 429', async () => {
    mocks.getCustomerTimeline.mockRejectedValue(
      new ApiError(429, { error: 'Too Many Requests', message: 'Rate limit exceeded', retryAfter: 30 }),
    );
    renderPage(customerHistoryFixture().search_response);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(
      await screen.findByText("You've searched a lot of numbers in a short time. Try again in 30 seconds."),
    ).toBeTruthy();
  });
});

describe('no answer in memory', () => {
  it('shows the empty page with the search box, after a reload or for an unknown id', () => {
    renderPage(null, 'chs_from_before_the_reload');
    expect(screen.getByLabelText('Phone number')).toBeTruthy();
    expect(screen.getByTestId('customer-history-intro')).toBeTruthy();
    expect(screen.queryByTestId('customer-results-title')).toBeNull();
  });

  it('refuses a role without the permission', () => {
    mocks.useTenant.mockReturnValue({ tenantId: 't', accountId: ACCOUNT, role: 'some_unknown_role' });
    renderPage(customerHistoryFixture().search_response);
    expect(screen.getByText("Customer history isn't available to you")).toBeTruthy();
    expect(screen.queryByTestId('customer-results-title')).toBeNull();
  });
});

describe('the agent surface', () => {
  it('serves the same page in the agent frame, with its nav entry current', () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: ACCOUNT,
      role: 'agent',
      accountResolution: 'ready',
      accountError: null,
      reloadAccounts: vi.fn(),
    });
    const answer = customerHistoryFixture().search_response;
    // What an agent gets (CH8): no call pages.
    for (const e of answer.timeline.entries) if ('call_page' in e) e.call_page = null;
    rememberCustomerSearchAnswer(answer);
    render(
      <MemoryRouter initialEntries={[{ pathname: '/dialer/customers', state: { searchId: answer.search_id } }]}>
        <Routes>
          <Route path="/dialer/customers" element={<AgentCustomerHistoryPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Customer history' })).toBeTruthy();
    expect(screen.getByTestId('agent-nav-customers').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('customer-results-title').textContent).toBe('Results for +91 98765 43210');
    expect(screen.queryAllByTestId('customer-call-link')).toHaveLength(0);
  });
});
