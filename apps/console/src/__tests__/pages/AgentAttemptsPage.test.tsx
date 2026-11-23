import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AgencyMyCallRow, AgencyMyCallsPage } from '../../types/agency-call-log';

/**
 * "My calls" (`/dialer/attempts`, `docs/call-log.md` §7, CL9): the signed-in person's calls of
 * every type as one list, with chips and To follow up first.
 *
 * What this file holds: the chips and what each asks the server for; that the old
 * `?view=softphone` URL still opens the soft-phone calls; To follow up's two parts and its empty
 * words; that a number the server hid is shown as it arrived and never looked up for display;
 * that Call back on such a row reads the number from the Missed list only when it is pressed;
 * and that nothing on the page opens a call's recording.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getMyCalls: vi.fn(),
  getMyCampaigns: vi.fn(),
  getMissedInboundCall: vi.fn(),
  markMissedInboundCallHandled: vi.fn(),
  refreshMissedCallsCount: vi.fn(),
  softphone: true,
  missed: true,
  /** The Missed calls badge's live count (null: no answer yet). */
  missedOpen: null as number | null,
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/myCalls', () => ({ getMyCalls: mocks.getMyCalls }));
vi.mock('../../api/agencyStats', () => ({ getMyCampaigns: mocks.getMyCampaigns }));
vi.mock('../../api/inbound', () => ({
  getMissedInboundCall: mocks.getMissedInboundCall,
  markMissedInboundCallHandled: mocks.markMissedInboundCallHandled,
}));
vi.mock('../../hooks/useMissedCallsCount', () => ({
  refreshMissedCallsCount: mocks.refreshMissedCallsCount,
  missedBadgeLabel: () => null,
  missedBadgeText: () => null,
}));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: () => ({
    available: mocks.missed,
    count: mocks.missedOpen === null ? null : { open: mocks.missedOpen, open_capped: false, has_rows: true },
  }),
}));
vi.mock('../../components/agency/AgentNav', () => ({
  AgentNav: () => <nav data-testid="agent-nav" />,
  useSoftphoneAvailable: () => mocks.softphone,
}));
vi.mock('../../analytics/events', () => ({ trackAgentSurfaceViewed: vi.fn() }));

import { AgentAttemptsPage } from '../../pages/agency/AgentAttemptsPage';
import { MyCallsList } from '../../components/agency/MyCallsList';

const BASE: AgencyMyCallRow = {
  type: 'dialler', id: 'd-1', created_at: '2026-11-22T13:10:00.000Z', campaign_id: 'c-1', campaign_name: 'Diwali EMI Collections',
  contact_id: 'k-1', customer_name: 'Anjali Verma', phone: '+919876543210', phone_masked: false,
  state: 'ended', outcome: 'connected', disposition_code: 'call_later', disposition_label: 'Call later', auto_disposition_code: null,
  callback_at: null, promise_date: null, promise_amount: null, talk_seconds: 182, notes: 'asked for the EMI letter', attempt_number: 1,
  redial: false, dialed_at: '2026-11-22T13:10:01.000Z', requires_disposition: false, callback_of: null, wait_seconds: null,
  queued: false, voicemail_seconds: null, follow_up: null, called_back: null,
};
const DIALLER = BASE;
const SOFT: AgencyMyCallRow = {
  ...BASE, type: 'soft_phone', id: 's-1', created_at: '2026-11-22T14:05:00.000Z', campaign_id: null, campaign_name: null,
  contact_id: null, customer_name: null, phone: '+919811000040', attempt_number: null, disposition_code: null, disposition_label: null,
  outcome: 'no_answer', talk_seconds: null, notes: null,
};
const ANSWERED: AgencyMyCallRow = {
  ...BASE, type: 'inbound', id: 'i-1', created_at: '2026-11-22T15:42:00.000Z', customer_name: 'Sunita Deshmukh',
  phone: '97••• ••821', phone_masked: true, outcome: 'answered', disposition_code: 'will_pay', disposition_label: 'Will pay',
  promise_date: '2026-11-25', talk_seconds: 252, attempt_number: null, dialed_at: null, wait_seconds: 18, notes: null,
};
const MISSED_MASKED: AgencyMyCallRow = {
  ...BASE, type: 'inbound', id: 'm-1', created_at: '2026-11-22T15:12:00.000Z', campaign_id: 'c-2', campaign_name: 'General enquiries',
  contact_id: null, customer_name: null, phone: '98••• ••730', phone_masked: true, outcome: 'overflow', disposition_code: null,
  disposition_label: null, talk_seconds: null, attempt_number: null, dialed_at: null, wait_seconds: 100, queued: true, notes: null,
  follow_up: { status: 'open', reason: 'overflow', closed_cause: null, handled_reason: null },
};
const MISSED_FULL: AgencyMyCallRow = {
  ...MISSED_MASKED, id: 'm-2', created_at: '2026-11-22T13:22:00.000Z', campaign_id: 'c-1', campaign_name: 'Diwali EMI Collections',
  customer_name: 'Vikram Patil', phone: '+919700002210', phone_masked: false, wait_seconds: 52,
  follow_up: { status: 'open', reason: 'abandoned_in_queue', closed_cause: null, handled_reason: null },
};
const COUNTS = { to_follow_up: 3, missed_open: 2, callbacks_due: 1 };
const CALLBACK = {
  contact_id: 'k-9', campaign_id: 'c-1', campaign_name: 'Diwali EMI Collections', customer_name: 'Anjali Verma',
  due_at: '2026-11-22T13:45:00.000Z', overdue: true,
};

const page = (rows: AgencyMyCallRow[], over: Partial<AgencyMyCallsPage> = {}): AgencyMyCallsPage =>
  ({ rows, next_cursor: null, limit: 50, counts: COUNTS, ...over });

function Where() {
  const location = useLocation();
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>;
}
function Phone() {
  const location = useLocation();
  return <span data-testid="phone-state">{JSON.stringify(location.state)}</span>;
}

async function renderPage(path = '/dialer/attempts') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dialer/attempts" element={<><AgentAttemptsPage /><Where /></>} />
        <Route path="/dialer/phone" element={<Phone />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}
const lastQuery = () => mocks.getMyCalls.mock.calls.at(-1)![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.softphone = true;
  mocks.missed = true;
  mocks.missedOpen = null;
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1', accountId: 'account-1', role: 'agent', accountResolution: 'ready', accountError: null, reloadAccounts: vi.fn(),
  });
  // Reset, not only cleared: an answer a test queued and never used must not reach the next one.
  mocks.getMyCalls.mockReset();
  mocks.getMyCalls.mockResolvedValue(page([ANSWERED, SOFT, DIALLER]));
  mocks.getMyCampaigns.mockResolvedValue([
    { campaign_id: 'c-1', campaign_name: 'Diwali EMI Collections', campaign_status: 'running', assigned_at: 'x', unassigned_at: null, active: true },
  ]);
});
afterEach(cleanup);

describe('My calls: one list with chips', () => {
  it('opens on All, with To follow up first carrying what the agent still owes', async () => {
    await renderPage();
    expect(lastQuery()).toMatchObject({ type: 'all', includeCounts: true });
    const chips = within(screen.getByTestId('my-calls-types')).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['To follow up3', 'All', 'Dialler', 'Soft phone', 'Inbound']);
    expect(screen.getByTestId('my-calls-type-all').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My calls');
  });

  it('lists every type in one table, each row saying its type, its campaign and what happened', async () => {
    await renderPage();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['When', 'Type', 'Customer', 'Campaign', 'What happened', 'Outcome', 'Talk time']);
    expect(screen.getByTestId('my-call-type-i-1').textContent).toBe('Inbound');
    expect(screen.getByTestId('my-call-type-d-1').textContent).toBe('Dialler · Try 1');
    expect(screen.getByTestId('my-call-campaign-d-1').textContent).toBe('Diwali EMI Collections');
    expect(screen.getByTestId('my-call-campaign-s-1').textContent).toBe('No campaign');
    expect(screen.getByTestId('my-call-outcome-i-1').textContent).toBe('Will pay · 25 Nov');
    expect(screen.getByTestId('my-call-happened-s-1').textContent).toBe('No answer');
    // Times in the house style.
    expect(screen.getByTestId('my-call-row-d-1').textContent).toContain('PM');
  });

  it('shows a number the server hid exactly as it arrived, and one in full grouped for reading', async () => {
    await renderPage();
    expect(screen.getByTestId('my-call-customer-i-1').textContent).toBe('Sunita Deshmukh97••• ••821');
    expect(screen.getByTestId('my-call-customer-d-1').textContent).toBe('Anjali Verma+91 98765 43210');
    // Showing the list reads nothing else about a number.
    expect(mocks.getMissedInboundCall).not.toHaveBeenCalled();
  });

  it('offers no way to a recording or a call page: an agent does not hear recordings', async () => {
    await renderPage();
    const table = screen.getByRole('table');
    expect(within(table).queryAllByRole('link')).toEqual([]);
    expect(table.textContent).not.toMatch(/Open call|Recording|Summary/);
  });

  it('a chip asks for that type and is kept in the URL', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('my-calls-type-inbound'));
    await waitFor(() => expect(lastQuery()).toMatchObject({ type: 'inbound' }));
    expect(screen.getByTestId('where').textContent).toBe('/dialer/attempts?type=inbound');
  });

  it('the old Soft-phone calls tab’s URL opens the Soft phone chip', async () => {
    await renderPage('/dialer/attempts?view=softphone');
    expect(lastQuery()).toMatchObject({ type: 'soft_phone' });
    expect(screen.getByTestId('my-calls-type-soft_phone').getAttribute('aria-pressed')).toBe('true');
  });

  it('filters by campaign and by date, and sends no dates for To follow up’s hint to contradict', async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId('my-calls-campaign-filter'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByTestId('my-calls-apply'));
    await waitFor(() => expect(lastQuery()).toMatchObject({ campaign: 'c-1' }));
    expect(screen.getByTestId('where').textContent).toBe('/dialer/attempts?campaign_id=c-1');
    fireEvent.click(screen.getByTestId('my-calls-clear'));
    await waitFor(() => expect(lastQuery()['campaign']).toBeUndefined());
    // There is no search by number: on a campaign that hides numbers it would give the digits away.
    expect(screen.queryByPlaceholderText(/number/i)).toBeNull();
  });

  it('says a failed read failed, with no rows of the last chip left under it', async () => {
    await renderPage();
    mocks.getMyCalls.mockRejectedValueOnce(new Error('The server is busy.'));
    fireEvent.click(screen.getByTestId('my-calls-type-dialler'));
    expect(await screen.findByText('The server is busy.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('follows the cursor and appends', async () => {
    mocks.getMyCalls.mockResolvedValueOnce(page([ANSWERED], { next_cursor: 'cur-2' }));
    await renderPage();
    mocks.getMyCalls.mockResolvedValueOnce(page([DIALLER], { counts: undefined }));
    fireEvent.click(screen.getByTestId('my-calls-load-more'));
    await waitFor(() => expect(screen.getByTestId('my-call-row-d-1')).toBeTruthy());
    expect(screen.getByTestId('my-call-row-i-1')).toBeTruthy();
    expect(lastQuery()).toMatchObject({ cursor: 'cur-2', type: 'all' });
    expect(screen.queryByTestId('my-calls-load-more')).toBeNull();
  });

  it('hides the Soft phone and Inbound chips from someone who has neither', async () => {
    mocks.softphone = false;
    mocks.missed = false;
    mocks.getMyCalls.mockResolvedValue(page([DIALLER], { counts: { to_follow_up: 0, missed_open: 0, callbacks_due: 0 } }));
    await renderPage();
    expect(within(screen.getByTestId('my-calls-types')).getAllByRole('button').map((c) => c.textContent)).toEqual(['All', 'Dialler']);
  });
});

describe('My calls: To follow up', () => {
  beforeEach(() => {
    mocks.getMyCalls.mockResolvedValue(page([MISSED_MASKED, MISSED_FULL], { callbacks_due: [CALLBACK] }));
  });

  it('lists my open missed calls, then the callbacks I booked that are due', async () => {
    await renderPage('/dialer/attempts?type=to_follow_up');
    expect(lastQuery()).toMatchObject({ type: 'to_follow_up' });
    expect(screen.getByTestId('my-call-type-m-1').textContent).toBe('Inbound · missed');
    expect(screen.getByTestId('my-call-row-m-1').textContent).toContain('nobody free to answer · waited 1:40');
    expect(screen.getByTestId('my-call-row-m-2').textContent).toContain('hung up while waiting · 0:52');
    const callbacks = screen.getByTestId('my-calls-callbacks');
    expect(within(callbacks).getByRole('heading').textContent).toBe('Callbacks due');
    const due = screen.getByTestId('my-callback-k-9').textContent!;
    expect(due).toContain('Anjali Verma');
    expect(due).toMatch(/Late by /);
    expect(due).toContain('Diwali EMI Collections · you booked it for');
    // The dates do not narrow this view, and the fields say so.
    expect(screen.getByTestId('my-calls-dates-off').textContent).toBe('To follow up shows everyone you still owe a call, whatever the dates.');
  });

  it('says nobody is waiting when there is nobody', async () => {
    mocks.getMyCalls.mockResolvedValue(page([], { callbacks_due: [], counts: { to_follow_up: 0, missed_open: 0, callbacks_due: 0 } }));
    await renderPage('/dialer/attempts?type=to_follow_up');
    expect(screen.getByText('Nobody is waiting for a call from you.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('asks for the callbacks of the chosen campaign, and says so when the filter leaves nobody', async () => {
    mocks.getMyCalls.mockResolvedValue(page([], { callbacks_due: [], counts: COUNTS }));
    await renderPage('/dialer/attempts?type=to_follow_up&campaign_id=c-1');
    // One request carries the campaign for the missed calls and the callbacks alike.
    expect(mocks.getMyCalls.mock.calls.at(-1)![0]).toMatchObject({ type: 'to_follow_up', campaign: 'c-1' });
    expect(screen.getByText('Nobody matches that campaign')).toBeTruthy();
    expect(screen.getByText('Clear the campaign filter to see everyone you still owe a call.')).toBeTruthy();
    expect(screen.queryByText('Nobody is waiting for a call from you.')).toBeNull();
    expect(screen.queryByTestId('my-calls-callbacks')).toBeNull();
  });

  it('shows the callbacks even with no missed call', async () => {
    mocks.getMyCalls.mockResolvedValue(page([], { callbacks_due: [CALLBACK] }));
    await renderPage('/dialer/attempts?type=to_follow_up');
    expect(screen.getByTestId('my-callback-k-9')).toBeTruthy();
    expect(screen.queryByText('Nobody is waiting for a call from you.')).toBeNull();
  });

  it('Mark handled is the Missed list’s action; the list and the badge are read again', async () => {
    mocks.markMissedInboundCallHandled.mockResolvedValue({ ok: true, value: {} });
    await renderPage('/dialer/attempts?type=to_follow_up');
    const reads = mocks.getMyCalls.mock.calls.length;
    fireEvent.click(screen.getByTestId('my-call-handled-m-2'));
    await waitFor(() => expect(mocks.getMyCalls.mock.calls.length).toBe(reads + 1));
    expect(mocks.markMissedInboundCallHandled).toHaveBeenCalledWith('m-2', 'tenant-1', 'account-1');
    expect(mocks.refreshMissedCallsCount).toHaveBeenCalled();
  });

  it('Call back on a number shown in full opens the soft phone with it, the campaign and the missed call’s id', async () => {
    await renderPage('/dialer/attempts?type=to_follow_up');
    fireEvent.click(screen.getByTestId('my-call-back-m-2'));
    const state = JSON.parse((await screen.findByTestId('phone-state')).textContent!);
    expect(Object.values(state)[0]).toEqual({ number: '+919700002210', campaignId: 'c-1', inboundCallId: 'm-2' });
    expect(mocks.getMissedInboundCall).not.toHaveBeenCalled();
  });

  it('Call back on a hidden number reads that Missed row by its id only when pressed, for the pad', async () => {
    mocks.getMissedInboundCall.mockResolvedValue({ id: 'm-1', from_e164: '+919812307730' });
    await renderPage('/dialer/attempts?type=to_follow_up');
    expect(mocks.getMissedInboundCall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('my-call-back-m-1'));
    const state = JSON.parse((await screen.findByTestId('phone-state')).textContent!);
    // That one row, by its id: never a page of the list, which an agent with many open rows would overrun.
    expect(mocks.getMissedInboundCall).toHaveBeenCalledWith('m-1', 'tenant-1', 'account-1');
    expect(Object.values(state)[0]).toEqual({ number: '+919812307730', campaignId: 'c-2', inboundCallId: 'm-1' });
  });

  it('says so on the row when the number cannot be read, and dials nothing', async () => {
    mocks.getMissedInboundCall.mockRejectedValue(new Error('offline'));
    await renderPage('/dialer/attempts?type=to_follow_up');
    fireEvent.click(screen.getByTestId('my-call-back-m-1'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('phone-state')).toBeNull();
  });

  it('offers no Call back without the soft phone', async () => {
    mocks.softphone = false;
    await renderPage('/dialer/attempts?type=to_follow_up');
    expect(screen.queryByTestId('my-call-back-m-2')).toBeNull();
    expect(screen.getByTestId('my-call-handled-m-2')).toBeTruthy();
  });
});

describe('My calls: what is owed is counted when it can have changed, not on every chip or filter', () => {
  const badge = () => screen.getByTestId('my-calls-count-to_follow_up').textContent;
  const asksForCounts = () => lastQuery()['includeCounts'] === true;

  it('asks for the counts on the first load, and keeps them on a chip tap without asking again', async () => {
    await renderPage();
    expect(asksForCounts()).toBe(true);
    expect(badge()).toBe('3');
    // The server sends no counts unless asked: the badge must be the one already held.
    mocks.getMyCalls.mockResolvedValue(page([ANSWERED], { counts: undefined }));
    fireEvent.click(screen.getByTestId('my-calls-type-inbound'));
    await waitFor(() => expect(lastQuery()).toMatchObject({ type: 'inbound' }));
    expect(asksForCounts()).toBe(false);
    await act(async () => {});
    expect(badge()).toBe('3');
  });

  it('keeps the counts on a filter change without asking again', async () => {
    await renderPage();
    mocks.getMyCalls.mockResolvedValue(page([DIALLER], { counts: undefined }));
    fireEvent.change(screen.getByTestId('my-calls-campaign-filter'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByTestId('my-calls-apply'));
    await waitFor(() => expect(lastQuery()).toMatchObject({ campaign: 'c-1' }));
    expect(asksForCounts()).toBe(false);
    await act(async () => {});
    expect(badge()).toBe('3');
  });

  it('asks for them again on Refresh, and shows the new number', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('my-calls-type-inbound'));
    await waitFor(() => expect(lastQuery()).toMatchObject({ type: 'inbound' }));
    expect(asksForCounts()).toBe(false);
    mocks.getMyCalls.mockResolvedValue(page([ANSWERED], { counts: { to_follow_up: 7, missed_open: 6, callbacks_due: 1 } }));
    const reads = mocks.getMyCalls.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh my calls' }));
    await waitFor(() => expect(mocks.getMyCalls.mock.calls.length).toBe(reads + 1));
    expect(lastQuery()).toMatchObject({ type: 'inbound', includeCounts: true });
    await waitFor(() => expect(badge()).toBe('7'));
  });

  it('asks for them again after Mark handled: what is owed has changed', async () => {
    mocks.markMissedInboundCallHandled.mockResolvedValue({ ok: true, value: {} });
    mocks.getMyCalls.mockResolvedValue(page([MISSED_MASKED, MISSED_FULL], { callbacks_due: [CALLBACK] }));
    await renderPage('/dialer/attempts?type=to_follow_up');
    const reads = mocks.getMyCalls.mock.calls.length;
    fireEvent.click(screen.getByTestId('my-call-handled-m-2'));
    await waitFor(() => expect(mocks.getMyCalls.mock.calls.length).toBe(reads + 1));
    expect(asksForCounts()).toBe(true);
  });

  it('asks again on the next read when the first one failed', async () => {
    mocks.getMyCalls.mockRejectedValueOnce(new Error('The server is busy.'));
    await renderPage();
    fireEvent.click(screen.getByTestId('my-calls-type-dialler'));
    await waitFor(() => expect(lastQuery()).toMatchObject({ type: 'dialler' }));
    expect(asksForCounts()).toBe(true);
  });
});

describe('My calls: the To follow up badge and the Missed calls badge count the same rows', () => {
  const owed = (missed: number) => ({ to_follow_up: missed + 1, missed_open: missed, callbacks_due: 1 });
  const badge = () => screen.getByTestId('my-calls-count-to_follow_up').textContent;

  it('reads the counts again when the Missed badge says another number, and leaves the rows alone', async () => {
    mocks.missedOpen = 5;
    mocks.getMyCalls.mockResolvedValueOnce(page([ANSWERED, SOFT, DIALLER], { counts: owed(2), next_cursor: 'more' }));
    mocks.getMyCalls.mockResolvedValueOnce(page([MISSED_FULL], { counts: owed(5) }));
    await renderPage();
    await waitFor(() => expect(mocks.getMyCalls).toHaveBeenCalledTimes(2));
    expect(lastQuery()).toMatchObject({ type: 'all', limit: 1, includeCounts: true });
    await waitFor(() => expect(badge()).toBe('6'));
    // The one-row read is for its counts: the list on screen and its next page are as they were.
    expect(screen.getByTestId('my-call-row-d-1')).toBeTruthy();
    expect(screen.queryByTestId('my-call-row-m-2')).toBeNull();
    expect(screen.getByTestId('my-calls-load-more')).toBeTruthy();
    // Asked once: the two now agree.
    await act(async () => {});
    expect(mocks.getMyCalls).toHaveBeenCalledTimes(2);
  });

  it('reads nothing more while the two agree', async () => {
    mocks.missedOpen = 2;
    mocks.getMyCalls.mockResolvedValue(page([DIALLER], { counts: owed(2) }));
    await renderPage();
    await act(async () => {});
    expect(mocks.getMyCalls).toHaveBeenCalledTimes(1);
    expect(badge()).toBe('3');
  });

  it('asks once for a number the list never agrees with, not in a loop', async () => {
    mocks.missedOpen = 5;
    mocks.getMyCalls.mockResolvedValue(page([DIALLER], { counts: owed(2) }));
    await renderPage();
    await waitFor(() => expect(mocks.getMyCalls).toHaveBeenCalledTimes(2));
    await act(async () => {});
    await act(async () => {});
    expect(mocks.getMyCalls).toHaveBeenCalledTimes(2);
  });

  it('under To follow up, reads the list again when the badge moves', async () => {
    mocks.getMyCalls.mockResolvedValueOnce(page([MISSED_FULL], { counts: owed(1), callbacks_due: [CALLBACK] }));
    mocks.getMyCalls.mockResolvedValueOnce(page([MISSED_MASKED, MISSED_FULL], { counts: owed(2), callbacks_due: [CALLBACK] }));
    const view = (missedOpen: number) => (
      <MemoryRouter initialEntries={['/dialer/attempts?type=to_follow_up']}>
        <MyCallsList softphone inbound missedOpen={missedOpen} />
      </MemoryRouter>
    );
    const { rerender } = render(view(1));
    await act(async () => {});
    expect(mocks.getMyCalls).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('my-call-row-m-1')).toBeNull();
    // A customer rings and nobody answers: the Missed badge's poll says 2.
    rerender(view(2));
    await waitFor(() => expect(screen.getByTestId('my-call-row-m-1')).toBeTruthy());
    expect(mocks.getMyCalls).toHaveBeenCalledTimes(2);
    expect(lastQuery()).toMatchObject({ type: 'to_follow_up', limit: 50, includeCounts: true });
    expect(badge()).toBe('3');
  });

  it('does not follow a supervisor’s badge, which counts the account’s rows', async () => {
    mocks.missedOpen = 40;
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin', accountResolution: 'ready', accountError: null, reloadAccounts: vi.fn(),
    });
    mocks.getMyCalls.mockResolvedValue(page([DIALLER], { counts: owed(0) }));
    await renderPage();
    await act(async () => {});
    expect(mocks.getMyCalls).toHaveBeenCalledTimes(1);
  });
});

describe('My calls: who it serves', () => {
  it('serves a supervisor their own calls, and points them at their team’s screen', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin', accountResolution: 'ready', accountError: null, reloadAccounts: vi.fn(),
    });
    await renderPage();
    expect(screen.getByText(/These are your own calls/)).toBeTruthy();
    expect(mocks.getMyCalls).toHaveBeenCalled();
  });

  it('stops with an error rather than spinning when no account could be opened', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1', accountId: null, role: 'agent', accountResolution: 'ready', accountError: null, reloadAccounts: vi.fn(),
    });
    await renderPage();
    expect(await screen.findByText(/couldn’t open your account/i)).toBeTruthy();
    expect(mocks.getMyCalls).not.toHaveBeenCalled();
  });
});
