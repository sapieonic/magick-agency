import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../api/client';
import type {
  AgencyMyContact,
  AgencyMyContactsSummary,
} from '@magick-agency/contracts/api/agency/assignment';

/**
 * My contacts at the station: the summary counts, search and bucket filter,
 * keyset "Load more", "Retry not reached (N)" (all, or the ticked rows), and the
 * per-row Call — including the calling-hours note and every refusal in words.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getMyContactsSummary: vi.fn(),
  listMyContacts: vi.fn(),
  retryMyContacts: vi.fn(),
  callMyContact: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyAssignment', () => ({
  getMyContactsSummary: mocks.getMyContactsSummary,
  listMyContacts: mocks.listMyContacts,
}));
vi.mock('../../api/agencyMyContacts', () => ({
  retryMyContacts: mocks.retryMyContacts,
  callMyContact: mocks.callMyContact,
}));

import { MyContactsPanel, myContactsLockReason } from '../../components/agency/MyContactsPanel';

const NOW = Date.parse('2026-11-03T10:00:00.000Z');

const DUE: AgencyMyContact = {
  id: 'c-due', campaign_id: 'camp-1', phone_e164: '+919800000001', bucket: 'pending', state: 'pending',
  attempt_count: 0, last_outcome: null, last_disposition: null,
  next_attempt_at: '2026-11-03T09:00:00.000Z', last_attempt_at: null,
  hero: [{ name: 'Name', value: 'Ravi Kumar' }, { name: 'Loan', value: 'LN-42' }],
  retry: { eligible: false, blocked: 'not_retryable', rounds_used: 0, available_at: null },
  override: null,
};
const MISSED: AgencyMyContact = {
  ...DUE, id: 'c-missed', phone_e164: '+919800000002', bucket: 'not_reached', state: 'exhausted',
  attempt_count: 3, last_outcome: 'no_answer', hero: [],
  retry: { eligible: true, blocked: null, rounds_used: 0, available_at: null },
};
const LATE_HOURS: AgencyMyContact = {
  ...DUE, id: 'c-hours', phone_e164: '+919800000003', hero: [],
  override: { disposition: 'ptp', extra_attempts: 0, retry_delay: false, calling_hours: true, granted_at: '' },
};

const SUMMARY: AgencyMyContactsSummary = {
  campaign_id: 'camp-1', assignment_mode: 'strict', total: 30,
  counts: { pending: 10, callback: 4, not_reached: 8, in_progress: 0, reached: 5, exhausted: 2, suppressed: 1 },
  due_now: 0,
  queue: { due: false, reason: 'callbacks_later', next_due_at: '2026-11-03T15:00:00.000Z' },
  unassigned_open: 0,
  retry: { allowed: true, rounds: 2, cooldown_minutes: 30, eligible: 8 },
};

const onClose = vi.fn();
const onCalled = vi.fn();

function renderPanel(over: Partial<Parameters<typeof MyContactsPanel>[0]> = {}) {
  return render(
    <MyContactsPanel
      campaignId="camp-1"
      campaignName="Collections"
      assignmentMode="strict"
      sessionId="sess-1"
      agentState="available"
      dialing
      queue={SUMMARY.queue}
      onClose={onClose}
      onCalled={onCalled}
      now={() => NOW}
      {...over}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });
  mocks.getMyContactsSummary.mockResolvedValue(SUMMARY);
  mocks.listMyContacts.mockResolvedValue({ rows: [DUE, MISSED, LATE_HOURS], next_cursor: 'cur-2', limit: 25 });
  mocks.retryMyContacts.mockResolvedValue({ reopened: 8, skipped: [], skipped_total: 0 });
  mocks.callMyContact.mockResolvedValue({
    attempt_id: 'att-1', contact_id: 'c-due', override_applied: [], retry_round_spent: false,
  });
});

afterEach(() => cleanup());

describe('the list and the counts', () => {
  it('shows the summary counts, the next callback time, and each contact with its hero fields', async () => {
    renderPanel();
    await screen.findByTestId('my-row-c-due');
    expect(within(screen.getByTestId('my-count-not_reached')).getByText('8')).toBeTruthy();
    expect(within(screen.getByTestId('my-count-suppressed')).getByText('DNC')).toBeTruthy();
    expect(screen.getByTestId('my-count-callback').textContent).toContain('next ');
    expect(screen.getByTestId('my-row-c-due').textContent).toContain('Ravi Kumar · LN-42');
    expect(screen.getByTestId('my-override-c-hours').textContent).toBe('Override: may call outside hours');
  });

  it('searches by phone and text, filters by bucket, and loads more by cursor', async () => {
    renderPanel();
    await screen.findByTestId('my-row-c-due');
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: ' 9800 ' } });
    fireEvent.change(screen.getByLabelText('Name or details'), { target: { value: 'Ravi' } });
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'callback' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() => expect(mocks.listMyContacts).toHaveBeenLastCalledWith({
      campaign_id: 'camp-1', bucket: ['callback'], phone: '9800', q: 'Ravi', limit: 25,
    }, 'tenant-1', 'account-1'));

    // A count is a one-click filter too.
    fireEvent.click(screen.getByTestId('my-count-reached'));
    await waitFor(() => expect(mocks.listMyContacts.mock.lastCall![0]).toMatchObject({ bucket: ['reached'] }));

    await screen.findByRole('button', { name: 'Load more' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(mocks.listMyContacts.mock.lastCall![0]).toMatchObject({ cursor: 'cur-2' }));
  });

  it('a search reads the list only: the counts do not depend on it', async () => {
    renderPanel();
    await screen.findByTestId('my-row-c-due');
    expect(mocks.getMyContactsSummary).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('my-count-reached'));
    await waitFor(() => expect(mocks.listMyContacts).toHaveBeenCalledTimes(2));
    await screen.findByTestId('my-row-c-due');
    expect(mocks.getMyContactsSummary).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('my-count-not_reached')).getByText('8')).toBeTruthy();
  });

  it('a summary read that failed is read again with the next search', async () => {
    mocks.getMyContactsSummary.mockRejectedValueOnce(new ApiError(503, { code: 'x', message: 'x' }));
    renderPanel();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await screen.findByTestId('my-row-c-due');
    expect(mocks.getMyContactsSummary).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a refusal of the read in words', async () => {
    mocks.getMyContactsSummary.mockRejectedValue(new ApiError(403, { code: 'not_staffed', message: 'x' }));
    renderPanel();
    expect(await screen.findByText('You’re no longer on this campaign. Ask your supervisor to add you back.')).toBeTruthy();
  });
});

describe('Retry not reached', () => {
  it('is offered with its count when nothing is due, and asks before reopening', async () => {
    renderPanel();
    const retry = await screen.findByTestId('my-retry');
    expect(retry.textContent).toContain('Retry not reached (8)');
    fireEvent.click(retry);
    expect(screen.getByTestId('my-retry-confirm').textContent).toContain('Put 8 contacts you didn’t reach back in your queue?');
    fireEvent.click(screen.getByTestId('my-retry-confirm-yes'));
    await waitFor(() => expect(mocks.retryMyContacts).toHaveBeenCalledWith(
      { campaign_id: 'camp-1', all: true }, 'tenant-1', 'account-1',
    ));
    expect((await screen.findByTestId('my-notice')).textContent).toContain('8 contacts back in your queue');
    // The counts are read again with the list after a retry.
    await waitFor(() => expect(mocks.getMyContactsSummary).toHaveBeenCalledTimes(2));
    expect(mocks.listMyContacts).toHaveBeenCalledTimes(2);
  });

  it('retries only the ticked rows when some are ticked (eligible rows only)', async () => {
    renderPanel();
    await screen.findByTestId('my-row-c-missed');
    expect((screen.getByLabelText('Include +919800000001 in the retry') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Include +919800000002 in the retry'));
    expect(screen.getByTestId('my-retry').textContent).toContain('Retry selected (1)');
    fireEvent.click(screen.getByTestId('my-retry'));
    fireEvent.click(screen.getByTestId('my-retry-confirm-yes'));
    await waitFor(() => expect(mocks.retryMyContacts).toHaveBeenCalledWith(
      { campaign_id: 'camp-1', contact_ids: ['c-missed'] }, 'tenant-1', 'account-1',
    ));
  });

  it('is not offered while something is due, and neither are the row checkboxes', async () => {
    mocks.getMyContactsSummary.mockResolvedValue({ ...SUMMARY, due_now: 2 });
    renderPanel();
    await screen.findByTestId('my-row-c-due');
    expect(screen.queryByTestId('my-retry')).toBeNull();
    expect(screen.queryByLabelText('Include +919800000002 in the retry')).toBeNull();
  });

  it('words a refusal', async () => {
    mocks.retryMyContacts.mockRejectedValue(new ApiError(403, { code: 'agent_retry_disabled', message: 'x' }));
    renderPanel();
    fireEvent.click(await screen.findByTestId('my-retry'));
    fireEvent.click(screen.getByTestId('my-retry-confirm-yes'));
    expect((await screen.findByText('This campaign doesn’t let agents retry their own contacts.'))).toBeTruthy();
  });
});

describe('Call', () => {
  it('dials a due contact from the station session and hands over to the station', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('my-call-c-due'));
    await waitFor(() => expect(mocks.callMyContact).toHaveBeenCalledWith(
      'c-due', { campaign_id: 'camp-1', session_id: 'sess-1' }, 'tenant-1', 'account-1',
    ));
    await waitFor(() => expect(onCalled).toHaveBeenCalledWith(DUE));
  });

  it('is disabled with the reason when the agent is not available', async () => {
    renderPanel({ agentState: 'break' });
    const call = await screen.findByTestId('my-call-c-due') as HTMLButtonElement;
    expect(call.disabled).toBe(true);
    const reason = document.getElementById(call.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('Go available to call a contact.');
  });

  it('asks for a 10–500 character note when the window is closed and the contact may be called outside it', async () => {
    renderPanel({ queue: { due: false, reason: 'outside_calling_hours', next_due_at: null } });
    fireEvent.click(await screen.findByTestId('my-call-c-hours'));
    const prompt = screen.getByTestId('my-note-prompt');
    expect(mocks.callMyContact).not.toHaveBeenCalled();
    const send = within(prompt).getByTestId('my-note-call') as HTMLButtonElement;
    fireEvent.change(within(prompt).getByTestId('my-note'), { target: { value: 'too short' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(within(prompt).getByTestId('my-note'), { target: { value: '  Customer asked for an evening call  ' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(mocks.callMyContact).toHaveBeenCalledWith('c-hours', {
      campaign_id: 'camp-1', session_id: 'sess-1', override_note: 'Customer asked for an evening call',
    }, 'tenant-1', 'account-1'));
  });

  // What the server sends (`my-contact-call.ts`, the `defer` arm): a contact holding an
  // unspent calling-hours override, called with no note, is `400 override_note_invalid`.
  const NOTE_NEEDED = () => new ApiError(400, {
    code: 'override_note_invalid', message: 'Add a note', details: { min: 10, max: 500 },
  });

  it('turns a no-note override_note_invalid refusal into the note prompt, then calls with the note', async () => {
    mocks.callMyContact.mockRejectedValueOnce(NOTE_NEEDED());
    renderPanel({ queue: null });
    fireEvent.click(await screen.findByTestId('my-call-c-hours'));
    const prompt = await screen.findByTestId('my-note-prompt');
    expect(prompt.textContent).toContain('The campaign is outside its calling hours. You may still call this contact');
    expect(prompt.textContent).toContain('Why call +919800000003 now?');
    expect(screen.getByTestId('my-notice').textContent).toBe('');
    fireEvent.change(within(prompt).getByTestId('my-note'), { target: { value: 'Customer asked for an evening call' } });
    fireEvent.click(within(prompt).getByTestId('my-note-call'));
    await waitFor(() => expect(mocks.callMyContact).toHaveBeenLastCalledWith('c-hours', {
      campaign_id: 'camp-1', session_id: 'sess-1', override_note: 'Customer asked for an evening call',
    }, 'tenant-1', 'account-1'));
    await waitFor(() => expect(onCalled).toHaveBeenCalledWith(LATE_HOURS));
  });

  it('keeps a refusal of a call made WITH a note inside the prompt, as its inline error', async () => {
    mocks.callMyContact.mockRejectedValueOnce(NOTE_NEEDED()).mockRejectedValueOnce(NOTE_NEEDED());
    renderPanel({ queue: null });
    fireEvent.click(await screen.findByTestId('my-call-c-hours'));
    const prompt = await screen.findByTestId('my-note-prompt');
    fireEvent.change(within(prompt).getByTestId('my-note'), { target: { value: 'Customer asked for an evening call' } });
    fireEvent.click(within(prompt).getByTestId('my-note-call'));
    await waitFor(() => expect(screen.getByTestId('my-note-prompt').textContent)
      .toContain('The note needs 10 to 500 characters.'));
    expect(screen.getByTestId('my-notice').textContent).toBe('');
  });

  it('says outside_calling_hours (no override held) as a refusal, without a note prompt', async () => {
    mocks.callMyContact.mockRejectedValueOnce(new ApiError(409, {
      code: 'outside_calling_hours', message: 'closed', details: { next_open_at: '2026-11-04T03:30:00.000Z' },
    }));
    renderPanel({ queue: null });
    fireEvent.click(await screen.findByTestId('my-call-c-due'));
    expect((await screen.findByTestId('my-notice')).textContent)
      .toContain('The campaign is outside its calling hours. It opens again');
    expect(screen.queryByTestId('my-note-prompt')).toBeNull();
  });

  it('while the note prompt is open, every other row’s Call is disabled with the reason', async () => {
    mocks.callMyContact.mockRejectedValueOnce(NOTE_NEEDED());
    renderPanel({ queue: null });
    fireEvent.click(await screen.findByTestId('my-call-c-hours'));
    await screen.findByTestId('my-note-prompt');
    const other = screen.getByTestId('my-call-c-due') as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    expect(document.getElementById(other.getAttribute('aria-describedby')!)?.textContent)
      .toBe('Finish or cancel the note above first.');
    // The prompt still names the first contact, and its call dials that one.
    expect(screen.getByTestId('my-note-prompt').textContent).toContain('+919800000003');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((screen.getByTestId('my-call-c-due') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says every other refusal in words', async () => {
    mocks.callMyContact.mockRejectedValueOnce(new ApiError(409, { code: 'dnc_listed', message: 'x' }));
    renderPanel();
    fireEvent.click(await screen.findByTestId('my-call-c-due'));
    expect((await screen.findByTestId('my-notice')).textContent)
      .toBe('This number is on the Do Not Call list. It can’t be called.');
    expect(onCalled).not.toHaveBeenCalled();
  });
});

describe('Escape', () => {
  it('closes the panel, but not while a call is being placed', async () => {
    let settle: (value: unknown) => void = () => {};
    mocks.callMyContact.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    renderPanel();
    fireEvent.click(await screen.findByTestId('my-call-c-due'));
    await waitFor(() => expect(mocks.callMyContact).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    settle({ attempt_id: 'att-1', contact_id: 'c-due', override_applied: [], retry_round_spent: false });
    await waitFor(() => expect(onCalled).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('the header lock', () => {
  it('is refused, with the reason, while a call is reserved, live or in wrap-up', () => {
    expect(myContactsLockReason('reserved', true)).toBe('Finish this call first.');
    expect(myContactsLockReason('on_call', true)).toBe('Finish this call first.');
    expect(myContactsLockReason('wrapup', true)).toBe('Save the outcome first.');
    expect(myContactsLockReason('available', false)).toBe('Your station isn’t connected.');
    expect(myContactsLockReason('available', true)).toBeNull();
    expect(myContactsLockReason('break', true)).toBeNull();
  });
});
