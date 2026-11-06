import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type {
  CustomerSearchResponse,
  CustomerTimelineCampaignCall,
  CustomerTimelinePage,
} from '@magick-agency/contracts/api/agency/customer-history';
import { customerHistoryFixture } from '../helpers/customerHistory';

/**
 * The Customer history page (`docs/customer-history.md` §3–§5).
 *
 * Pinned: the summary (who the number belongs to, totals, DNC at every level, open
 * items), one row per timeline kind with CH8's visibility (notes hidden, a call
 * link only when the server gave a call page, through `go` for another account),
 * "Load more" by cursor, filters that re-query from the first page (and never mix
 * with an older query's rows or answers), the CSV export, the empty history, an
 * expired search, the rate-limit copy, and that none of it reaches analytics.
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
  getCustomerSearchOptions: vi.fn().mockResolvedValue({ default_country_code: '+91' }),
}));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  SOFTPHONE_FLAG: 'agency_softphone_enabled',
  useFeatureFlagEnabled: () => false,
}));

import CustomerHistoryPage, { AgentCustomerHistoryPage } from '../../pages/agency/CustomerHistoryPage';
import { clearCustomerSearchAnswers, rememberCustomerSearchAnswer } from '../../utils/customerHistoryStore';
import { ApiError } from '../../api/client';
import { formatWhen } from '../../utils/customerHistoryCopy';

/** A promise the test settles itself, to choose which of two requests answers last. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CAMPAIGN_ROOT = '6b0d8f1a-2c3e-4f4a-9b5c-6d7e8f9a0b1c';

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
  it('echoes the number the server searched, with a copy button whose label carries no number', () => {
    renderPage(customerHistoryFixture().search_response);
    expect(screen.getByTestId('customer-results-title').textContent).toBe('Results for +91 98765 43210');
    const copy = screen.getByRole('button', { name: 'Copy number' });
    for (const attr of copy.getAttributeNames()) expect(copy.getAttribute(attr)).not.toMatch(/\d{5}/);
  });

  it('moves focus to the results heading when a search opens', () => {
    renderPage(customerHistoryFixture().search_response);
    expect(document.activeElement).toBe(screen.getByTestId('customer-results-title'));
  });

  it('copies the E.164', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage(customerHistoryFixture().search_response);
    fireEvent.click(screen.getByRole('button', { name: 'Copy number' }));
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

  it('shows several people on one number in one campaign as separate rows, never merged (CH7)', () => {
    const answer = customerHistoryFixture().search_response;
    const [first, second] = answer.summary.contacts as [
      CustomerSearchResponse['summary']['contacts'][number],
      CustomerSearchResponse['summary']['contacts'][number],
    ];
    // A household line: two roster rows, same campaign, same number.
    second.campaign = first.campaign;
    second.campaigns = first.campaigns;
    renderPage(answer);
    const contacts = screen.getAllByTestId('customer-contact');
    expect(contacts).toHaveLength(2);
    expect(contacts[0]!.textContent).toContain('Asha Rao');
    expect(contacts[0]!.textContent).not.toContain('Ravi Rao');
    expect(contacts[1]!.textContent).toContain('Ravi Rao');
    expect(contacts[1]!.textContent).not.toContain('Asha Rao');
    for (const c of contacts) expect(c.textContent).toContain('October dues → October dues (retry 1)');
  });

  it('says nothing about truncation when every roster row came back', () => {
    renderPage(customerHistoryFixture().search_response);
    expect(screen.queryByTestId('customer-contacts-truncated')).toBeNull();
  });

  it('notes when the server cut the roster rows at 2,000', () => {
    const answer = customerHistoryFixture().search_response;
    answer.summary.contacts_truncated = true;
    renderPage(answer);
    expect(screen.getByTestId('customer-contacts-truncated').textContent).toBe(
      'This number is on more than 2,000 roster rows. This history covers the 2,000 most recent.',
    );
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
    expect(screen.getByTestId('customer-total-calls').textContent).toBe('5');
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
    expect(entry.textContent).toContain('Marked by an agent · Priya Nair');
    expect(entry.textContent).not.toContain('by Priya Nair');
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

  it("shows an open override's follow-up, or says none is scheduled", () => {
    const answer = customerHistoryFixture().search_response;
    const override = answer.summary.open.overrides[0]!;
    override.follow_up_at = '2026-11-07T09:30:00.000Z';
    answer.summary.open.overrides.push({ ...override, contact_id: 'other-contact', follow_up_at: null });
    renderPage(answer);
    const followUps = screen.getAllByTestId('customer-open-override-follow-up').map((e) => e.textContent);
    expect(followUps).toEqual([`Follow-up ${formatWhen('2026-11-07T09:30:00.000Z')}`, 'No follow-up scheduled']);
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
    // Its first attempt is not among the loaded rows.
    expect(within(campaign).getByTestId('customer-redial').textContent).toBe('Wrap-up redial 1 of an earlier call');
    expect(within(campaign).getByTestId('customer-override').textContent).toContain(
      'Customer asked to be called after salary day',
    );
  });

  it('links a wrap-up redial to its chain: names the first call and sets the redial in under it', () => {
    const answer = customerHistoryFixture().search_response;
    const redial = answer.timeline.entries[2] as CustomerTimelineCampaignCall;
    const first: CustomerTimelineCampaignCall = {
      ...redial,
      key: `campaign_call:${redial.chain_attempt_id}`,
      at: '2026-11-04T07:50:00.000Z',
      attempt_id: redial.chain_attempt_id,
      redial_of_attempt_id: null,
      redial_number: 0,
    };
    answer.timeline.entries.splice(3, 0, first);
    renderPage(answer);

    const rows = entries();
    expect(within(rows[2]!).getByTestId('customer-redial').textContent).toBe(
      `Wrap-up redial 1 of the call at ${formatWhen('2026-11-04T07:50:00.000Z')}`,
    );
    expect(within(rows[3]!).getByTestId('customer-redial-first').textContent).toBe('Redialled in wrap-up once');
    expect(within(rows[3]!).queryByTestId('customer-redial')).toBeNull();
    // One chain: both rows carry its first attempt, and only the redial is set in.
    expect(rows[2]!.getAttribute('data-chain')).toBe(redial.chain_attempt_id);
    expect(rows[3]!.getAttribute('data-chain')).toBe(redial.chain_attempt_id);
    expect(rows[2]!.className).not.toBe(rows[3]!.className);
    // A call outside any chain carries none.
    expect(rows[0]!.hasAttribute('data-chain')).toBe(false);
  });

  it('says "Recording expired" rather than offering a player, and the other recording states', () => {
    const answer = customerHistoryFixture().search_response;
    renderPage(answer);
    expect(within(entries()[2]!).getByTestId('customer-recording').textContent).toBe('Recording expired');
    expect(within(entries()[0]!).getByTestId('customer-recording').textContent).toBe('Recording available');
  });

  it.each([
    ['no_call', 'No call placed'],
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

describe('filters that fail, and answers that arrive late', () => {
  it('drops the old rows and cursor when a filter change fails, so Load more cannot mix two queries', async () => {
    const answer = customerHistoryFixture().search_response;
    mocks.getCustomerTimeline.mockRejectedValueOnce(new ApiError(503, { message: 'Service Unavailable' }));
    renderPage(answer);
    expect(entries()).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'softphone' } });

    expect(await screen.findByText('Service Unavailable')).toBeTruthy();
    expect(entries()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.queryByTestId('customer-timeline-empty')).toBeNull();

    // Try again re-runs the filters on screen, from the first page.
    mocks.getCustomerTimeline.mockResolvedValueOnce({ entries: answer.timeline.entries.slice(0, 1), next_cursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(kinds()).toEqual(['softphone_call']));
    expect(mocks.getCustomerTimeline).toHaveBeenLastCalledWith(
      { search_id: answer.search_id, filters: { channel: 'softphone' } },
      'tenant-1',
      ACCOUNT,
    );
  });

  it('refuses a "To" date before the "From" date on the page, and never sends it', async () => {
    renderPage(customerHistoryFixture().search_response);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-10' } });
    await waitFor(() => expect(mocks.getCustomerTimeline).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-05' } });

    expect(screen.getByTestId('customer-filter-range-error').textContent).toBe(
      'The end date must be on or after the start date.',
    );
    expect(screen.getByLabelText('To').getAttribute('aria-invalid')).toBe('true');
    expect(mocks.getCustomerTimeline).toHaveBeenCalledTimes(1);
    expect(entries()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Export CSV' }) as HTMLButtonElement).disabled).toBe(true);
    // The pickers steer away from it too.
    expect(screen.getByLabelText('To').getAttribute('min')).toBe('2026-11-10');
    expect(screen.getByLabelText('From').getAttribute('max')).toBe('2026-11-05');

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-12' } });
    await waitFor(() => expect(mocks.getCustomerTimeline).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('customer-filter-range-error')).toBeNull();
  });

  it("shows the server's refusal of a bad filter in the page's words, not the validator's", async () => {
    mocks.getCustomerTimeline.mockRejectedValue(
      new ApiError(400, { error: 'Bad Request', code: 'invalid_search_request', message: 'from must be before to' }),
    );
    renderPage(customerHistoryFixture().search_response);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'campaign' } });
    expect(await screen.findByText('Could not load the timeline.')).toBeTruthy();
    expect(screen.queryByText('from must be before to')).toBeNull();
  });

  it('shows the answer to the LATEST filter when an earlier one answers last', async () => {
    const answer = customerHistoryFixture().search_response;
    const pageA = deferred<CustomerTimelinePage>();
    const pageB = deferred<CustomerTimelinePage>();
    mocks.getCustomerTimeline.mockReturnValueOnce(pageA.promise).mockReturnValueOnce(pageB.promise);
    renderPage(answer);

    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'campaign' } });
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'softphone' } });

    await act(async () => pageB.resolve({ entries: answer.timeline.entries.slice(0, 1), next_cursor: null }));
    expect(kinds()).toEqual(['softphone_call']);

    // Filter A's answer arrives after B's: it belongs to filters nobody is looking at.
    await act(async () => pageA.resolve({ entries: answer.timeline.entries.slice(2, 3), next_cursor: 'cursor-of-a' }));
    expect(kinds()).toEqual(['softphone_call']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('drops a Load more page that arrives after the filters changed', async () => {
    const answer = customerHistoryFixture().search_response;
    const more = deferred<CustomerTimelinePage>();
    mocks.getCustomerTimeline
      .mockReturnValueOnce(more.promise)
      .mockResolvedValueOnce({ entries: answer.timeline.entries.slice(0, 1), next_cursor: null });
    renderPage(answer);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'softphone' } });
    await waitFor(() => expect(kinds()).toEqual(['softphone_call']));

    const older = answer.timeline.entries.map((e) => ({ ...e, key: `${e.key}-older` }));
    await act(async () => more.resolve({ entries: older, next_cursor: 'cursor-unfiltered' }));
    expect(kinds()).toEqual(['softphone_call']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
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

  it('says so when the export fails, and keeps the timeline', async () => {
    mocks.exportCustomerHistory.mockRejectedValue(new TypeError(''));
    renderPage(customerHistoryFixture().search_response);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Could not export this history.')).toBeTruthy();
    expect(screen.queryByTestId('customer-export-note')).toBeNull();
    expect(entries()).toHaveLength(5);
    expect((screen.getByRole('button', { name: 'Export CSV' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says the search cap was hit on a 429: an export is charged to it, as the server's own message says", async () => {
    mocks.exportCustomerHistory.mockRejectedValue(
      new ApiError(429, {
        error: 'Too Many Requests',
        message: "You've searched a lot of numbers in a short time. Try again in 12 seconds.",
        retryAfter: 12,
      }),
    );
    renderPage(customerHistoryFixture().search_response);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(
      await screen.findByText("You've searched a lot of numbers in a short time. Try again in 12 seconds."),
    ).toBeTruthy();
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

  it('is not empty while an untagged soft-phone call to the number is live', () => {
    const answer = customerHistoryFixture().search_response_empty;
    answer.summary.open.live_calls = [
      { channel: 'softphone', campaign: null, agent: { user_id: 'u1', name: 'Priya Nair' }, started_at: '2026-11-06T10:00:00.000Z' },
    ];
    renderPage(answer);
    expect(screen.queryByText('No calls to this number in the accounts you can see')).toBeNull();
    expect(screen.getByTestId('customer-live-call').textContent).toContain('Priya Nair');
    expect(screen.getByTestId('customer-dnc-none')).toBeTruthy();
  });

  it('is not empty with only a DNC mark or an unplaced soft-phone call in the timeline: shows them, and the export', () => {
    const full = customerHistoryFixture().search_response;
    const answer = customerHistoryFixture().search_response_empty;
    const softphone = full.timeline.entries[0]!;
    if (softphone.kind === 'softphone_call') {
      softphone.recording = 'no_call';
      softphone.talk_seconds = null;
    }
    answer.timeline.entries = [softphone, full.timeline.entries[3]!];
    answer.summary.dnc = full.summary.dnc;
    renderPage(answer);
    expect(screen.queryByText('No calls to this number in the accounts you can see')).toBeNull();
    expect(kinds()).toEqual(['softphone_call', 'dnc_mark']);
    expect(screen.getByTestId('customer-dnc-entry')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy();
  });

  it('shows the DNC entry on an otherwise empty history', () => {
    const answer = customerHistoryFixture().search_response_empty;
    answer.summary.dnc = customerHistoryFixture().search_response.summary.dnc;
    renderPage(answer);
    expect(screen.getByText('No calls to this number in the accounts you can see')).toBeTruthy();
    expect(screen.getByTestId('customer-dnc-entry')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
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

  it('keeps the filters when searching again after an expiry', async () => {
    const answer = customerHistoryFixture().search_response;
    const fresh = { ...customerHistoryFixture().search_response, search_id: 'chs_fresh' };
    mocks.searchCustomers.mockResolvedValue(fresh);
    mocks.getCustomerTimeline
      .mockRejectedValueOnce(new ApiError(404, customerHistoryFixture().error_search_expired))
      .mockResolvedValue({ entries: answer.timeline.entries.slice(0, 1), next_cursor: null });
    renderPage(answer);

    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'softphone' } });
    const banner = await screen.findByTestId('customer-search-expired');
    fireEvent.click(within(banner).getByRole('button', { name: 'Search again' }));

    await waitFor(() =>
      expect(mocks.getCustomerTimeline).toHaveBeenLastCalledWith(
        { search_id: 'chs_fresh', filters: { channel: 'softphone' } },
        'tenant-1',
        ACCOUNT,
      ),
    );
    await waitFor(() => expect(kinds()).toEqual(['softphone_call']));
    expect((screen.getByLabelText('Channel') as HTMLSelectElement).value).toBe('softphone');
    expect(screen.queryByTestId('customer-search-expired')).toBeNull();
  });

  it('says how long to wait on a 429', async () => {
    mocks.getCustomerTimeline.mockRejectedValue(
      new ApiError(429, { error: 'Too Many Requests', message: 'Rate limit exceeded', retryAfter: 30 }),
    );
    renderPage(customerHistoryFixture().search_response);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    // Timeline pages are not charged to the search cap: the general limit, not "searched a lot".
    expect(await screen.findByText('Too many requests in a short time. Try again in 30 seconds.')).toBeTruthy();
    expect(screen.queryByText(/searched a lot/)).toBeNull();
  });
});

describe('what analytics may see', () => {
  it('keeps the results (number, people, notes, fields) inside a ph-no-capture boundary', () => {
    renderPage(customerHistoryFixture().search_response);
    const results = screen.getByTestId('customer-results');
    expect(results.classList.contains('ph-no-capture')).toBe(true);
    for (const el of [
      screen.getByTestId('customer-results-title'),
      screen.getByRole('button', { name: 'Copy number' }),
      ...screen.getAllByTestId('customer-contact'),
      ...entries(),
    ]) {
      expect(el.closest('.ph-no-capture')).toBe(results);
    }
    // The page's own search box (its recent list included) is its own boundary.
    expect(screen.getByLabelText('Phone number').closest('.ph-no-capture')).toBe(screen.getByTestId('customer-search-box'));
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
