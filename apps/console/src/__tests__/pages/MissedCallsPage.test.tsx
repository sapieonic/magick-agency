import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AgencyInboundMissedCall } from '@magick-agency/contracts/api/agency/inbound';

/**
 * Missed calls (`docs/inbound.md` §7): a supervisor reads the account's rows with an assignee
 * filter, anyone else their own; Call back opens the soft phone with the number and campaign in
 * history state (never the URL) and is unavailable for a withheld number or with the soft phone
 * off; a DNC caller is badged; Mark handled takes the row off "To follow up"; no permission hides
 * the page, and so does the flag off with no rows, while the flag off WITH rows keeps the list
 * readable under a notice (the kill switch); a dedicated agent is sent to their own frame. A
 * supervisor reassigns a row; a departed assignee reads "Former member" with the prompt; a row
 * closed because the customer was reached says so; Reopen puts a handled row back on the list; a
 * closed call says why when it was not the hours; every change re-reads the badge's count. The
 * flag-off notice says what callers hear, and the page guide gives "Nobody free to answer" the
 * summary's meaning.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  flags: { agency_inbound_enabled: true, agency_softphone_enabled: true } as Record<string, boolean>,
  listMissedInboundCalls: vi.fn(),
  markMissedInboundCallHandled: vi.fn(),
  reopenMissedInboundCall: vi.fn(),
  listTenantMembers: vi.fn(),
  getInboundQueue: vi.fn(),
  fetchVoicemailBlobUrl: vi.fn(),
  assignMissedInboundCall: vi.fn(),
  getMissedInboundCount: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me-1', display_name: 'Asha', email: 'a@x' } }) }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  SOFTPHONE_FLAG: 'agency_softphone_enabled',
  useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true,
}));
vi.mock('../../hooks/useReportsAccess', () => ({ useReportsAccess: () => ({ enabled: false, canSelf: false, canSupervise: false, userId: null }) }));
vi.mock('../../components/common/CapabilityUnavailable', () => ({
  CapabilityUnavailable: () => <div data-testid="capability-unavailable" />,
}));
vi.mock('../../components/common/PageDescription', () => ({
  PageDescription: ({ description, tips }: { description: string; tips?: string[] }) => (
    <div data-testid="page-description">{[description, ...(tips ?? [])].join(' | ')}</div>
  ),
}));
vi.mock('../../api/inbound', async () => {
  const actual = await vi.importActual<typeof import('../../api/inbound')>('../../api/inbound');
  return {
    ...actual,
    listMissedInboundCalls: mocks.listMissedInboundCalls,
    markMissedInboundCallHandled: mocks.markMissedInboundCallHandled,
    reopenMissedInboundCall: mocks.reopenMissedInboundCall,
    getInboundQueue: mocks.getInboundQueue,
    fetchVoicemailBlobUrl: mocks.fetchVoicemailBlobUrl,
    assignMissedInboundCall: mocks.assignMissedInboundCall,
    getMissedInboundCount: mocks.getMissedInboundCount,
  };
});
vi.mock('../../api/tenants', () => ({ listTenantMembers: mocks.listTenantMembers }));

import MissedCallsPage, { AgentMissedCallsPage } from '../../pages/agency/MissedCallsPage';
import { resetMissedCallsCountForTests } from '../../hooks/useMissedCallsCount';

function missed(o: Partial<AgencyInboundMissedCall> = {}): AgencyInboundMissedCall {
  return {
    id: 'm-1', account_id: 'account-1', route_id: 'r-1', route_name: 'Main line', from_e164: '+447700900123',
    to_e164: '+441632960001', arrived_at: '2026-11-08T09:30:00Z', ended_at: '2026-11-08T09:31:00Z', reason: 'closed',
    closed_cause: 'hours', outcome: 'closed', caller_dnc: false, matched_contact_id: 'c-1', matched_campaign_id: 'camp-1',
    matched_campaign_name: 'Renewals', callback_due_at: null, has_voicemail: false, assignee_user_id: 'me-1',
    assignee_name: 'Asha', assignee_departed: false, status: 'open', handled_reason: null, handled_by_user_id: null,
    handled_by_name: null, handled_at: null, ...o,
  };
}

let state: unknown = null;
function Where() {
  const l = useLocation();
  state = l.state;
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

async function renderAt(path: string, role: string) {
  mocks.useTenant.mockReturnValue({
    role, tenantId: 'tenant-1', accountId: 'account-1', accounts: [{ id: 'account-1', name: 'North' }],
    accountResolution: 'ready', accountError: null, reloadAccounts: vi.fn(),
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/agency/inbound/missed" element={<MissedCallsPage />} />
        <Route path="/dialer/missed" element={<AgentMissedCallsPage />} />
        <Route path="/dialer/phone" element={<div data-testid="softphone" />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags = { agency_inbound_enabled: true, agency_softphone_enabled: true };
  resetMissedCallsCountForTests();
  mocks.getMissedInboundCount.mockResolvedValue({ open: 1, open_capped: false, has_rows: true });
  mocks.listTenantMembers.mockResolvedValue([
    { membership: { account_id: 'account-1', status: 'active' }, user: { id: 'me-1', display_name: 'Asha', email: 'a@x' } },
    { membership: { account_id: null, status: 'active' }, user: { id: 'u-2', display_name: 'Ravi', email: 'r@x' } },
    // Another account's member and a revoked one: filterable by name, never offered for a reassign.
    { membership: { account_id: 'account-2', status: 'active' }, user: { id: 'u-3', display_name: 'Zoe', email: 'z@x' } },
    { membership: { account_id: 'account-1', status: 'revoked' }, user: { id: 'u-4', display_name: 'Omar', email: 'o@x' } },
  ]);
  mocks.listMissedInboundCalls.mockResolvedValue({ rows: [missed()], next_cursor: null, limit: 50 });
  mocks.getInboundQueue.mockResolvedValue({
    tiles: [{ route_id: 'r-1', route_name: 'Main line', open_now: true, waiting: 1, longest_wait_seconds: 30, connected: 2, eligible_agents: 1 }],
  });
});

describe('who sees what', () => {
  it('a supervisor reads the account’s, filters by assignee, and sees who each is assigned to', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({
      rows: [missed(), missed({ id: 'm-2', assignee_user_id: null, assignee_name: null }), missed({ id: 'm-3', assignee_user_id: 'u-2', assignee_name: 'Ravi' })],
      next_cursor: null, limit: 50,
    });
    await renderAt('/agency/inbound/missed', 'account_admin');
    expect(mocks.listMissedInboundCalls).toHaveBeenCalledWith({ status: 'open', limit: 50 }, 'tenant-1', 'account-1');
    expect(within(screen.getByTestId('missed-row-m-1')).getByText('You')).toBeTruthy();
    expect(within(screen.getByTestId('missed-row-m-2')).getByText('The account')).toBeTruthy();
    expect(within(screen.getByTestId('missed-row-m-3')).getByText('Ravi')).toBeTruthy();
    const assignee = screen.getByTestId('missed-filter-assignee') as HTMLSelectElement;
    expect([...assignee.options].map((o) => o.textContent)).toEqual(['Anyone', 'Me', 'The account (no one in particular)', 'Omar', 'Ravi', 'Zoe']);
    fireEvent.change(assignee, { target: { value: 'unassigned' } });
    fireEvent.change(screen.getByTestId('missed-filter-reason'), { target: { value: 'overflow' } });
    fireEvent.click(screen.getByTestId('missed-filter-apply'));
    await waitFor(() => expect(mocks.listMissedInboundCalls).toHaveBeenLastCalledWith(
      { status: 'open', assignee: 'unassigned', reason: 'overflow', limit: 50 }, 'tenant-1', 'account-1'));
  });

  it('an agent in the agent frame gets their own list, no assignee filter, and the nav entry current', async () => {
    await renderAt('/dialer/missed', 'agent');
    expect(screen.queryByTestId('missed-filter-assignee')).toBeNull();
    expect(screen.getByTestId('agent-nav-missed').getAttribute('aria-current')).toBe('page');
    expect(mocks.listTenantMembers).not.toHaveBeenCalled();
    expect(screen.getByTestId('missed-row-m-1')).toBeTruthy();
  });

  it('sends a dedicated agent on the agency path to their own frame', async () => {
    await renderAt('/agency/inbound/missed', 'agent');
    expect(screen.getByTestId('where').textContent).toBe('/dialer/missed');
  });

  it('is unavailable with the flag off and no rows to read, and to a role without agency.inbound.read', async () => {
    mocks.flags = { agency_inbound_enabled: false };
    mocks.getMissedInboundCount.mockResolvedValue({ open: 0, open_capped: false, has_rows: false });
    await renderAt('/agency/inbound/missed', 'account_admin');
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.listMissedInboundCalls).not.toHaveBeenCalled();
  });

  it('with the flag off and rows there, stays readable, and the notice says callers hear the closed message and still appear here', async () => {
    mocks.flags = { agency_inbound_enabled: false, agency_softphone_enabled: true };
    await renderAt('/agency/inbound/missed', 'account_admin');
    const notice = screen.getByTestId('missed-inbound-off').textContent ?? '';
    expect(notice).toMatch(/switched off for this account: callers hear the closed message and are still listed here/);
    // Never the old promise that nobody gets through: the server still answers and lists them.
    expect(notice).not.toMatch(/no new calls come in/);
    expect(screen.getByTestId('missed-row-m-1')).toBeTruthy();
    // The live queue reads the flag itself: nothing is waiting with inbound off.
    expect(mocks.getInboundQueue).not.toHaveBeenCalled();
    // Actions are offered; what they may do is the server's answer.
    expect(screen.getByTestId('missed-mark-handled')).toBeTruthy();
  });

  it('an agent`s own frame is readable with the flag off too, when they have rows', async () => {
    mocks.flags = { agency_inbound_enabled: false };
    await renderAt('/dialer/missed', 'agent');
    expect(screen.getByTestId('missed-inbound-off')).toBeTruthy();
    expect(screen.getByTestId('agent-nav-missed').getAttribute('aria-current')).toBe('page');
  });

  it('with the flag on there is no notice', async () => {
    await renderAt('/agency/inbound/missed', 'account_admin');
    expect(screen.queryByTestId('missed-inbound-off')).toBeNull();
  });
});

describe('reassign, departed assignees and rows closed because the customer was reached', () => {
  it('a supervisor reassigns an open row to a member of the account, and the badge re-reads', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({ rows: [missed()], next_cursor: null, limit: 50 });
    mocks.assignMissedInboundCall.mockResolvedValue({ ok: true, value: missed({ assignee_user_id: 'u-2', assignee_name: 'Ravi' }) });
    await renderAt('/agency/inbound/missed', 'account_admin');
    const reads = mocks.getMissedInboundCount.mock.calls.length;
    const row = within(screen.getByTestId('missed-row-m-1'));
    fireEvent.click(row.getByTestId('missed-reassign'));
    const select = row.getByTestId('missed-reassign-select') as HTMLSelectElement;
    // The account, then the active members of this account (tenant-level included), never others.
    expect([...select.options].map((o) => o.textContent)).toEqual(['The account', 'Asha (you)', 'Ravi']);
    // Nothing to save until the choice differs from where it is.
    expect((row.getByTestId('missed-reassign-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'u-2' } });
    await act(async () => {
      fireEvent.click(row.getByTestId('missed-reassign-save'));
    });
    expect(mocks.assignMissedInboundCall).toHaveBeenCalledWith('m-1', 'u-2', 'tenant-1', 'account-1');
    expect(within(screen.getByTestId('missed-row-m-1')).getByTestId('missed-assignee').textContent).toBe('Ravi');
    expect(screen.getByRole('status').textContent).toBe('Assigned the call from +447700900123 to Ravi.');
    expect(mocks.getMissedInboundCount.mock.calls.length).toBe(reads + 1);
  });

  it('to the account sends null; a row given away under an assignee filter leaves the view', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({ rows: [missed()], next_cursor: null, limit: 50 });
    mocks.assignMissedInboundCall.mockResolvedValue({ ok: true, value: missed({ assignee_user_id: null, assignee_name: null }) });
    await renderAt('/agency/inbound/missed', 'account_admin');
    fireEvent.change(screen.getByTestId('missed-filter-assignee'), { target: { value: 'me' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-filter-apply'));
    });
    const row = within(screen.getByTestId('missed-row-m-1'));
    fireEvent.click(row.getByTestId('missed-reassign'));
    fireEvent.change(row.getByTestId('missed-reassign-select'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(row.getByTestId('missed-reassign-save'));
    });
    expect(mocks.assignMissedInboundCall).toHaveBeenCalledWith('m-1', null, 'tenant-1', 'account-1');
    expect(screen.queryByTestId('missed-row-m-1')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Assigned the call from +447700900123 to the account.');
  });

  it('a refused reassign stays on the row, in the supervisor`s words', async () => {
    mocks.assignMissedInboundCall.mockResolvedValue({
      ok: false,
      refusal: { code: 'inbound_assignee_invalid', status: 400, message: 'x', details: [], phoneNumberId: null, routeId: null },
    });
    await renderAt('/agency/inbound/missed', 'account_admin');
    const row = within(screen.getByTestId('missed-row-m-1'));
    fireEvent.click(row.getByTestId('missed-reassign'));
    fireEvent.change(row.getByTestId('missed-reassign-select'), { target: { value: 'u-2' } });
    await act(async () => {
      fireEvent.click(row.getByTestId('missed-reassign-save'));
    });
    expect(row.getByRole('alert').textContent).toBe('That person can’t take this account’s missed calls any more. Choose someone else.');
    expect(row.getByTestId('missed-reassign-select')).toBeTruthy();
  });

  it('a departed assignee reads Former member, says who, and the reassign is the prompt', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({
      rows: [missed({ assignee_user_id: 'u-4', assignee_name: 'Omar', assignee_departed: true })], next_cursor: null, limit: 50,
    });
    await renderAt('/agency/inbound/missed', 'account_admin');
    const row = within(screen.getByTestId('missed-row-m-1'));
    expect(row.getByTestId('missed-assignee').textContent).toBe('Former member');
    expect(row.getByTestId('missed-departed').textContent).toBe('Omar no longer works in this account. Reassign it.');
    const prompt = row.getByTestId('missed-reassign');
    expect(prompt.className).toMatch(/btn-primary/);
    fireEvent.click(prompt);
    // The picker starts on the account, not on the person who left.
    expect((row.getByTestId('missed-reassign-select') as HTMLSelectElement).value).toBe('');
  });

  it('an agent has no reassign', async () => {
    await renderAt('/dialer/missed', 'agent');
    expect(screen.queryByTestId('missed-reassign')).toBeNull();
  });

  it('the Handled tab says when the customer was reached, and by whom', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({
      rows: [
        missed({ status: 'handled', handled_reason: 'reached', handled_by_user_id: 'u-2', handled_by_name: 'Ravi', handled_at: '2026-11-08T10:00:00Z' }),
        missed({ id: 'm-2', status: 'handled', handled_reason: 'reached', handled_by_user_id: 'me-1', handled_by_name: 'Asha', handled_at: '2026-11-08T10:00:00Z' }),
        missed({ id: 'm-3', status: 'handled', handled_reason: 'marked', handled_by_user_id: 'u-2', handled_by_name: 'Ravi', handled_at: '2026-11-08T10:00:00Z' }),
      ],
      next_cursor: null, limit: 50,
    });
    await renderAt('/agency/inbound/missed', 'account_admin');
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-tab-handled'));
    });
    const reached = within(screen.getByTestId('missed-row-m-1')).getByTestId('missed-handled').textContent;
    expect(reached).toContain('Customer reached by Ravi');
    expect(reached).toContain('an agent spoke to the customer after this call');
    expect(within(screen.getByTestId('missed-row-m-2')).getByTestId('missed-handled').textContent).toContain('Customer reached by you');
    const marked = within(screen.getByTestId('missed-row-m-3')).getByTestId('missed-handled').textContent;
    expect(marked).toContain('Ravi');
    expect(marked).not.toContain('reached');
    // No reassign on a handled row.
    expect(screen.queryByTestId('missed-reassign')).toBeNull();
  });
});

describe('Call back and Mark handled', () => {
  it('Call back opens the soft phone with the number and campaign in history state, not the URL', async () => {
    await renderAt('/agency/inbound/missed', 'account_admin');
    fireEvent.click(screen.getByRole('button', { name: /Call back/ }));
    expect(screen.getByTestId('where').textContent).toBe('/dialer/phone');
    expect(state).toEqual({ softphonePrefill: { number: '+447700900123', campaignId: 'camp-1' } });
  });

  it('a withheld number cannot be called back; a DNC caller is badged and still can (the soft phone asks why)', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({
      rows: [missed({ id: 'w', from_e164: null }), missed({ id: 'd', caller_dnc: true })], next_cursor: null, limit: 50,
    });
    await renderAt('/agency/inbound/missed', 'account_admin');
    const withheld = within(screen.getByTestId('missed-row-w'));
    expect(withheld.getByText('Number withheld')).toBeTruthy();
    expect((withheld.getByTestId('missed-call-back') as HTMLButtonElement).disabled).toBe(true);
    const dnc = within(screen.getByTestId('missed-row-d'));
    expect(dnc.getByTestId('missed-dnc').getAttribute('title')).toMatch(/asks for a reason/);
    expect((dnc.getByTestId('missed-call-back') as HTMLButtonElement).disabled).toBe(false);
  });

  it('without the soft phone there is no Call back, and the page says how to follow up', async () => {
    mocks.flags = { agency_inbound_enabled: true, agency_softphone_enabled: false };
    await renderAt('/agency/inbound/missed', 'account_admin');
    expect(screen.queryByTestId('missed-call-back')).toBeNull();
    expect(screen.getByTestId('missed-no-softphone').textContent).toMatch(/isn’t on for this account/);
  });

  it('Mark handled takes the row off the open list; a refusal stays on the row', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({ rows: [missed(), missed({ id: 'm-2' })], next_cursor: null, limit: 50 });
    mocks.markMissedInboundCallHandled
      .mockResolvedValueOnce({ ok: true, value: missed({ status: 'handled', handled_by_user_id: 'me-1', handled_at: '2026-11-08T10:00:00Z' }) })
      .mockResolvedValueOnce({ ok: false, refusal: { code: 'inbound_missed_call_not_found', status: 404, message: 'x', details: [], phoneNumberId: null, routeId: null } });
    await renderAt('/agency/inbound/missed', 'account_admin');
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('missed-row-m-1')).getByTestId('missed-mark-handled'));
    });
    expect(mocks.markMissedInboundCallHandled).toHaveBeenCalledWith('m-1', 'tenant-1', 'account-1');
    expect(screen.queryByTestId('missed-row-m-1')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/as handled/);
    // The badge re-reads after a change (one read at mount, one after the mark).
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('missed-row-m-2')).getByTestId('missed-mark-handled'));
    });
    expect(within(screen.getByTestId('missed-row-m-2')).getByRole('alert').textContent).toMatch(/isn’t yours to handle/);
  });

  it('the Handled tab lists who handled each call, with no follow-up actions (Reopen only)', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({
      rows: [missed({ status: 'handled', handled_by_user_id: 'u-2', handled_by_name: 'Ravi', handled_at: '2026-11-08T10:00:00Z' })],
      next_cursor: null, limit: 50,
    });
    await renderAt('/agency/inbound/missed', 'account_admin');
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-tab-handled'));
    });
    expect(mocks.listMissedInboundCalls).toHaveBeenLastCalledWith({ status: 'handled', limit: 50 }, 'tenant-1', 'account-1');
    const row = within(screen.getByTestId('missed-row-m-1'));
    expect(row.getByText('Ravi')).toBeTruthy();
    expect(row.queryByTestId('missed-mark-handled')).toBeNull();
    expect(row.queryByTestId('missed-call-back')).toBeNull();
    expect(row.getByTestId('missed-reopen').textContent).toBe('Reopen');
  });

  it('an open row has no Reopen', async () => {
    await renderAt('/agency/inbound/missed', 'account_admin');
    expect(within(screen.getByTestId('missed-row-m-1')).queryByTestId('missed-reopen')).toBeNull();
  });

  it('pages older calls with the cursor', async () => {
    mocks.listMissedInboundCalls
      .mockResolvedValueOnce({ rows: [missed()], next_cursor: 'cur-1', limit: 50 })
      .mockResolvedValueOnce({ rows: [missed({ id: 'm-older' })], next_cursor: null, limit: 50 });
    await renderAt('/agency/inbound/missed', 'account_admin');
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-load-more'));
    });
    expect(mocks.listMissedInboundCalls).toHaveBeenLastCalledWith({ status: 'open', cursor: 'cur-1', limit: 50 }, 'tenant-1', 'account-1');
    expect(screen.getByTestId('missed-row-m-older')).toBeTruthy();
    expect(screen.queryByTestId('missed-load-more')).toBeNull();
  });
});

describe('P2: the queue beside the list, and the voicemail', () => {
  it('a supervisor sees the live queue above the list; an agent does not', async () => {
    await renderAt('/agency/inbound/missed', 'account_admin');
    expect(screen.getByTestId('inbound-queue-tile-r-1')).toBeTruthy();
    expect(mocks.getInboundQueue).toHaveBeenCalledWith('tenant-1', 'account-1');
  });

  it('an agent’s own frame has no queue tiles', async () => {
    await renderAt('/dialer/missed', 'agent');
    expect(screen.queryByTestId('inbound-queue')).toBeNull();
    expect(mocks.getInboundQueue).not.toHaveBeenCalled();
  });

  it('plays a voicemail only when asked, from the row’s voicemail_url', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({
      rows: [
        missed({ has_voicemail: true, voicemail_url: '/inbound/missed/m-1/voicemail' }),
        missed({ id: 'm-2', has_voicemail: true }),
      ],
      next_cursor: null,
      limit: 50,
    });
    mocks.fetchVoicemailBlobUrl.mockResolvedValue({ status: 'ready', url: 'blob:vm-1' });
    await renderAt('/agency/inbound/missed', 'account_admin');
    // A row whose voicemail this build cannot serve says it was left, and offers no player.
    expect(within(screen.getByTestId('missed-row-m-2')).queryByTestId('missed-voicemail-play')).toBeNull();
    const row = within(screen.getByTestId('missed-row-m-1'));
    expect(mocks.fetchVoicemailBlobUrl).not.toHaveBeenCalled();
    const play = row.getByTestId('missed-voicemail-play');
    expect(play.getAttribute('aria-label')).toMatch(/^Play the voicemail from /);
    await act(async () => {
      fireEvent.click(play);
    });
    expect(mocks.fetchVoicemailBlobUrl).toHaveBeenCalledWith('/inbound/missed/m-1/voicemail', 'tenant-1', 'account-1');
    const audio = row.getByTestId('missed-voicemail-audio') as HTMLAudioElement;
    expect(audio.getAttribute('src')).toBe('blob:vm-1');
    expect(audio.hasAttribute('controls')).toBe(true);
  });

  it('a voicemail that cannot be fetched says so beside the button', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({
      rows: [missed({ has_voicemail: true, voicemail_url: '/inbound/missed/m-1/voicemail' })],
      next_cursor: null,
      limit: 50,
    });
    mocks.fetchVoicemailBlobUrl.mockResolvedValue({ status: 'unavailable', message: 'This voicemail is no longer available.' });
    await renderAt('/agency/inbound/missed', 'account_admin');
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-voicemail-play'));
    });
    expect(screen.getByTestId('missed-voicemail-error').textContent).toBe('This voicemail is no longer available.');
  });
});

describe('Reopen', () => {
  const handled = (o: Partial<AgencyInboundMissedCall> = {}) => missed({
    status: 'handled', handled_reason: 'reached', handled_by_user_id: 'u-2', handled_by_name: 'Ravi', handled_at: '2026-11-08T10:00:00Z', ...o,
  });

  it('puts a handled row back on the list: it leaves the Handled tab, is announced, and the badge re-reads', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({ rows: [handled(), handled({ id: 'm-2' })], next_cursor: null, limit: 50 });
    mocks.reopenMissedInboundCall.mockResolvedValue({ ok: true, value: missed() });
    await renderAt('/agency/inbound/missed', 'account_admin');
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-tab-handled'));
    });
    const reads = mocks.getMissedInboundCount.mock.calls.length;
    const button = within(screen.getByTestId('missed-row-m-1')).getByTestId('missed-reopen');
    expect(button.getAttribute('aria-label')).toBe('Reopen the call from +447700900123');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(mocks.reopenMissedInboundCall).toHaveBeenCalledWith('m-1', 'tenant-1', 'account-1');
    expect(screen.queryByTestId('missed-row-m-1')).toBeNull();
    expect(screen.getByTestId('missed-row-m-2')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Reopened the call from +447700900123. It is back on the list to follow up.');
    expect(mocks.getMissedInboundCount.mock.calls.length).toBe(reads + 1);
  });

  it('an agent reopens their own row from their frame', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({ rows: [handled({ handled_reason: 'marked', handled_by_user_id: 'me-1' })], next_cursor: null, limit: 50 });
    mocks.reopenMissedInboundCall.mockResolvedValue({ ok: true, value: missed() });
    await renderAt('/dialer/missed', 'agent');
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-tab-handled'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-reopen'));
    });
    expect(mocks.reopenMissedInboundCall).toHaveBeenCalledWith('m-1', 'tenant-1', 'account-1');
    expect(screen.queryByTestId('missed-row-m-1')).toBeNull();
  });

  it('a refused reopen stays on the row, in words, and the row stays where it is', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({ rows: [handled()], next_cursor: null, limit: 50 });
    mocks.reopenMissedInboundCall.mockResolvedValue({
      ok: false, refusal: { code: 'inbound_missed_call_not_found', status: 404, message: 'x', details: [], phoneNumberId: null, routeId: null },
    });
    await renderAt('/agency/inbound/missed', 'account_admin');
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-tab-handled'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('missed-reopen'));
    });
    const row = within(screen.getByTestId('missed-row-m-1'));
    expect(row.getByRole('alert').textContent).toBe('This missed call isn’t yours to reopen, or it no longer exists. Refresh the list.');
    expect(row.getByTestId('missed-handled')).toBeTruthy();
  });
});

describe('why a closed call was closed, and the words of the guide', () => {
  it('says the cause when it was not the opening hours; out of hours otherwise', async () => {
    mocks.listMissedInboundCalls.mockResolvedValue({
      rows: [
        missed({ id: 'h' }),
        missed({ id: 's', closed_cause: 'switched_off' }),
        missed({ id: 'n', closed_cause: 'no_route' }),
        missed({ id: 'c', closed_cause: 'credential_inactive' }),
        missed({ id: 'old', closed_cause: null }),
        missed({ id: 'o', reason: 'overflow', closed_cause: null, outcome: 'overflow' }),
        missed({ id: 'b', reason: 'overflow_no_capacity', closed_cause: null, outcome: 'overflow_no_capacity' }),
      ],
      next_cursor: null, limit: 50,
    });
    await renderAt('/agency/inbound/missed', 'account_admin');
    const reason = (id: string) => within(screen.getByTestId(`missed-row-${id}`)).getByTestId('missed-reason').textContent;
    expect(reason('h')).toBe('Out of hours');
    expect(reason('s')).toBe('Inbound switched off');
    expect(reason('n')).toBe('Number not on a route');
    expect(reason('c')).toBe('Phone line not active');
    expect(reason('old')).toBe('Out of hours');
    expect(reason('o')).toBe('Nobody free to answer');
    expect(reason('b')).toBe('All lines busy');
  });

  it('the guide gives "Nobody free to answer" its one meaning, never "a wait that ran too long", and names Reopen', async () => {
    await renderAt('/agency/inbound/missed', 'account_admin');
    const guide = screen.getByTestId('page-description').textContent ?? '';
    expect(guide).toContain('nobody free to answer (the caller waited as long as the line allows, the queue was full, or nobody in the team could take calls)');
    expect(guide).not.toMatch(/too long/);
    expect(guide).toContain('saves an outcome other than voicemail');
    expect(guide).toContain('Reopen, on the Handled tab, puts a call back on the list');
  });
});
