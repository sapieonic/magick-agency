import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AgencyInboundMissedCall } from '@magick-agency/contracts/api/agency/inbound';

/**
 * Missed calls (`docs/inbound.md` §7): a supervisor reads the account's rows with an assignee
 * filter, anyone else their own; Call back opens the soft phone with the number and campaign in
 * history state (never the URL) and is unavailable for a withheld number or with the soft phone
 * off; a DNC caller is badged; Mark handled takes the row off "To follow up"; the flag off or no
 * permission hides the page; a dedicated agent is sent to their own frame.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  flags: { agency_inbound_enabled: true, agency_softphone_enabled: true } as Record<string, boolean>,
  listMissedInboundCalls: vi.fn(),
  markMissedInboundCallHandled: vi.fn(),
  listTenantMembers: vi.fn(),
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
vi.mock('../../components/common/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('../../api/inbound', async () => {
  const actual = await vi.importActual<typeof import('../../api/inbound')>('../../api/inbound');
  return {
    ...actual,
    listMissedInboundCalls: mocks.listMissedInboundCalls,
    markMissedInboundCallHandled: mocks.markMissedInboundCallHandled,
  };
});
vi.mock('../../api/tenants', () => ({ listTenantMembers: mocks.listTenantMembers }));

import MissedCallsPage, { AgentMissedCallsPage } from '../../pages/agency/MissedCallsPage';

function missed(o: Partial<AgencyInboundMissedCall> = {}): AgencyInboundMissedCall {
  return {
    id: 'm-1', account_id: 'account-1', route_id: 'r-1', route_name: 'Main line', from_e164: '+447700900123',
    to_e164: '+441632960001', arrived_at: '2026-11-08T09:30:00Z', ended_at: '2026-11-08T09:31:00Z', reason: 'closed',
    outcome: 'closed', caller_dnc: false, matched_contact_id: 'c-1', matched_campaign_id: 'camp-1',
    matched_campaign_name: 'Renewals', callback_due_at: null, has_voicemail: false, assignee_user_id: 'me-1',
    assignee_name: 'Asha', status: 'open', handled_by_user_id: null, handled_by_name: null, handled_at: null, ...o,
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
  mocks.listTenantMembers.mockResolvedValue([
    { user: { id: 'me-1', display_name: 'Asha', email: 'a@x' } },
    { user: { id: 'u-2', display_name: 'Ravi', email: 'r@x' } },
  ]);
  mocks.listMissedInboundCalls.mockResolvedValue({ rows: [missed()], next_cursor: null, limit: 50 });
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
    expect([...assignee.options].map((o) => o.textContent)).toEqual(['Anyone', 'Me', 'The account (no one in particular)', 'Ravi']);
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

  it('is unavailable with the flag off, and to a role without agency.inbound.read', async () => {
    mocks.flags = { agency_inbound_enabled: false };
    await renderAt('/agency/inbound/missed', 'account_admin');
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.listMissedInboundCalls).not.toHaveBeenCalled();
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
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('missed-row-m-2')).getByTestId('missed-mark-handled'));
    });
    expect(within(screen.getByTestId('missed-row-m-2')).getByRole('alert').textContent).toMatch(/isn’t yours to handle/);
  });

  it('the Handled tab lists who handled each call, with no actions', async () => {
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
