import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type {
  AgencyAccountCallsPage,
  AgencyCallLogDiallerRow,
  AgencyCallLogInboundRow,
  AgencyCallLogRow,
  AgencyCallLogSoftphoneRow,
} from '../../types/agency-call-log';

/**
 * The account's All calls (`/agency/calls`, `docs/call-log.md` §7, CL34): the campaign Call
 * log's table at the account's scope. What is its own is held here: the Campaign column and
 * what it says for a call filed under none, the Campaign filter, that it opens on today and
 * has no export, its floor, and the old Soft-phone calls URL landing on it.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAccountCalls: vi.fn(),
  getCampaignCallLog: vi.fn(),
  downloadSpineCsv: vi.fn(),
  listAgencyCampaigns: vi.fn(),
  listCampaignAgents: vi.fn(),
  markMissedInboundCallHandled: vi.fn(),
  refreshMissedCallsCount: vi.fn(),
  flags: new Set<string>(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, loading: false, map: {}, refresh: vi.fn() }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaigns: mocks.listAgencyCampaigns }));
vi.mock('../../api/agency', () => ({ listCampaignAgents: mocks.listCampaignAgents }));
vi.mock('../../api/inbound', () => ({ markMissedInboundCallHandled: mocks.markMissedInboundCallHandled }));
vi.mock('../../hooks/useMissedCallsCount', () => ({ refreshMissedCallsCount: mocks.refreshMissedCallsCount }));
vi.mock('../../api/agencySpine', () => ({
  getAccountCalls: mocks.getAccountCalls,
  getCampaignCallLog: mocks.getCampaignCallLog,
  downloadSpineCsv: mocks.downloadSpineCsv,
}));
// The campaign's workspace is not on this page; the module is imported by the shared list's file.
vi.mock('../../pages/agency/campaign-detail/CampaignWorkspace', () => ({ CampaignWorkspace: () => null }));

import AllCallsPage, { SoftphoneCallsRedirect } from '../../pages/agency/AllCallsPage';

const DIALLER: AgencyCallLogDiallerRow = {
  type: 'dialler', id: 'd-1', contact_id: 'k-1', campaign_id: 'c-1', campaign_name: 'Diwali EMI Collections', attempt_number: 1,
  phone_e164: '+919876500001', caller_id: '+919000000001', agent_user_id: 'u-1', agent_name: 'Priya Nair', reserved_agent_id: 's-1',
  state: 'ended', outcome: 'connected', disposition_code: 'will_pay', notes: null, callback_at: null, dispositioned_by_user_id: 'u-1',
  dispositioned_at: '2026-11-22T10:00:00.000Z', dispositioned_on_behalf: false, webrtc_call_id: 'call-1',
  dialed_at: '2026-11-22T09:59:00.000Z', answered_at: null, bridged_at: '2026-11-22T09:59:12.000Z', ended_at: '2026-11-22T10:00:00.000Z',
  talk_seconds: 47, wrapup_seconds: 20, created_at: '2026-11-22T09:58:00.000Z',
};
const SOFT_UNTAGGED: AgencyCallLogSoftphoneRow = {
  type: 'soft_phone', id: 's-1', campaign_id: null, campaign_name: null, contact_id: null, phone_e164: '+919811000040',
  caller_id: '+919000000002', agent_user_id: 'u-2', agent_name: 'Arjun Mehta', state: 'ended', outcome: 'connected',
  disposition_code: 'resolved', notes: null, callback_at: null, promise_date: null, promise_amount: null,
  dispositioned_by_user_id: 'u-2', dispositioned_at: null, dispositioned_on_behalf: false, webrtc_call_id: 'call-2',
  dialed_at: '2026-10-01T08:00:01.000Z', answered_at: null, bridged_at: null, ended_at: '2026-10-01T08:02:00.000Z', talk_seconds: 60,
  dnc_overridden: false, hours_overridden: false, requires_disposition: false, settled_at: '2026-10-01T08:03:00.000Z',
  callback_of: null, created_at: '2026-10-01T08:00:00.000Z',
};
const INBOUND_UNFILED: AgencyCallLogInboundRow = {
  type: 'inbound', id: 'i-1', campaign_id: null, campaign_name: null, campaign_source: null, contact_id: null,
  phone_e164: '+919500000008', caller_id: '+919000000009', route_name: 'Sales line', agent_user_id: 'u-1', agent_name: 'Priya Nair',
  state: 'ended', outcome: 'answered', disposition_code: null, notes: null, callback_at: null, promise_date: null, promise_amount: null,
  dispositioned_by_user_id: null, dispositioned_at: null, dispositioned_on_behalf: false, webrtc_call_id: 'call-3',
  answered_at: '2026-11-22T11:00:02.000Z', bridged_at: '2026-11-22T11:00:20.000Z', ended_at: '2026-11-22T11:04:00.000Z',
  talk_seconds: 220, wait_seconds: 18, queued: true, via_sticky_agent: false, requires_disposition: false,
  settled_at: '2026-11-22T11:05:00.000Z', voicemail_seconds: null, follow_up: null, called_back: null, created_at: '2026-11-22T11:00:00.000Z',
};
const RULE_OFF = { require_campaign: false, require_campaign_since: null };

const page = (rows: AgencyCallLogRow[], over: Partial<AgencyAccountCallsPage> = {}): AgencyAccountCallsPage => ({
  rows, next_cursor: null, limit: 50, rule: RULE_OFF,
  counts: { all: rows.length, dialler: 1, soft_phone: 1, inbound: 1, to_follow_up: 0 }, ...over,
});

function Where() {
  const location = useLocation();
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>;
}

async function renderAt(path = '/agency/calls') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/agency/calls" element={<><AllCallsPage /><Where /></>} />
        <Route path="/agency/softphone" element={<SoftphoneCallsRedirect />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}
const lastCall = () => mocks.getAccountCalls.mock.calls.at(-1)! as [Record<string, unknown>, Record<string, unknown>, string, string];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags = new Set(['agency_softphone_enabled', 'agency_inbound_enabled']);
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'account_admin' });
  mocks.getAccountCalls.mockResolvedValue(page([INBOUND_UNFILED, DIALLER, SOFT_UNTAGGED]));
  mocks.listAgencyCampaigns.mockResolvedValue([
    { id: 'c-1', name: 'Diwali EMI Collections', disposition_catalog: [{ code: 'will_pay', label: 'Will pay' }] },
    { id: 'c-2', name: 'Gold Loan Renewals', disposition_catalog: [] },
  ]);
});
afterEach(cleanup);

describe('All calls', () => {
  it('reads the account’s calls, opening on today, with the chips’ counts', async () => {
    await renderAt();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('All calls');
    const [filters, options, tenantId, accountId] = lastCall();
    expect(filters['from']).toBeDefined();
    expect(filters['to']).toBeDefined();
    expect(options).toMatchObject({ type: 'all', includeCounts: true, campaign: null });
    expect([tenantId, accountId]).toEqual(['t-1', 'a-1']);
    // The campaign's read is never used here.
    expect(mocks.getCampaignCallLog).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('call-log-types')).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['All3', 'Dialler1', 'Soft phone1', 'Inbound1']);
  });

  it('adds a Campaign column: the campaign as a link to its Call log, or that the call has none', async () => {
    await renderAt('/agency/calls?dates=all');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['When', 'Type', 'Campaign', 'Customer', 'Agent', 'What happened', 'Outcome', 'Talk time', 'Call']);
    const campaign = within(screen.getByTestId('call-campaign-d-1')).getByRole('link');
    expect(campaign.textContent).toBe('Diwali EMI Collections');
    expect(campaign.getAttribute('href')).toBe('/agency/campaigns/c-1/attempts');
    expect(screen.getByTestId('call-campaign-s-1').textContent).toBe('No campaign');
    expect(screen.getByTestId('call-campaign-i-1').textContent).toBe('No campaign');
    // Each row's outcome in its own campaign's words.
    expect(screen.getByTestId('attempt-row-d-1').textContent).toContain('Will pay');
  });

  it('labels a call from before the rule was switched on "Before the rule", and a later one "No campaign"', async () => {
    mocks.getAccountCalls.mockResolvedValue(page([INBOUND_UNFILED, SOFT_UNTAGGED], {
      rule: { require_campaign: true, require_campaign_since: '2026-11-01T00:00:00.000Z' },
    }));
    await renderAt('/agency/calls?dates=all');
    // 1 Oct is before the switch-on; 22 Nov is after it.
    expect(screen.getByTestId('call-campaign-s-1').textContent).toBe('Before the rule');
    expect(screen.getByTestId('call-campaign-i-1').textContent).toBe('No campaign');
  });

  it('opens each row’s own page: the attempt in its campaign, the soft-phone call; an unfiled inbound call has none', async () => {
    await renderAt('/agency/calls?dates=all');
    const link = (id: string) => within(screen.getByTestId(`attempt-row-${id}`)).queryByRole('link', { name: /Open call/ });
    expect(link('d-1')!.getAttribute('href')).toBe('/agency/campaigns/c-1/attempts/d-1');
    expect(link('s-1')!.getAttribute('href')).toBe('/agency/softphone/calls/s-1');
    expect(link('i-1')).toBeNull();
  });

  it('filters by campaign, and by the calls filed under none', async () => {
    await renderAt();
    const select = screen.getByTestId('all-calls-campaign-filter') as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.textContent)).toEqual(['All campaigns', 'No campaign', 'Diwali EMI Collections', 'Gold Loan Renewals']));
    fireEvent.change(select, { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastCall()[1]).toMatchObject({ campaign: 'none' }));
    expect(screen.getByTestId('where').textContent).toContain('campaign_id=none');
    expect(screen.getByTestId('attempts-chip-campaign').textContent).toContain('Campaign: No campaign');
    // A chip keeps the campaign; Clear drops it.
    fireEvent.click(screen.getByTestId('call-log-type-soft_phone'));
    await waitFor(() => expect(lastCall()[1]).toMatchObject({ campaign: 'none', type: 'soft_phone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(lastCall()[1]).toMatchObject({ campaign: null }));
  });

  it('opens on what a link asks for: Settings › Calls’ unfiled calls', async () => {
    await renderAt('/agency/calls?campaign_id=none&from=2026-10-23T00:00:00.000Z&to=2026-11-22T23:59:59.999Z');
    const [filters, options] = lastCall();
    expect(filters).toMatchObject({ from: '2026-10-23T00:00:00.000Z', to: '2026-11-22T23:59:59.999Z' });
    expect(options).toMatchObject({ campaign: 'none' });
  });

  it('To follow up speaks of the account, and is not narrowed by the dates', async () => {
    mocks.getAccountCalls.mockResolvedValue(page([], { counts: { all: 3, dialler: 1, soft_phone: 1, inbound: 1, to_follow_up: 2 } }));
    await renderAt('/agency/calls?type=to_follow_up');
    expect(screen.getByTestId('call-log-follow-up-note').textContent).toMatch(/^Every missed call in this account that is still open/);
    expect(screen.getByText('Nobody is waiting for a call back in this account.')).toBeTruthy();
  });

  it('has no export: a campaign’s file is its own Call log’s', async () => {
    await renderAt();
    expect(screen.queryByRole('button', { name: /Export CSV/ })).toBeNull();
  });

  it('says an empty day is about the dates, in the account’s words', async () => {
    mocks.getAccountCalls.mockResolvedValue(page([], { counts: { all: 0, dialler: 0, soft_phone: 0, inbound: 0, to_follow_up: 0 } }));
    await renderAt();
    expect(screen.getByText('No calls in this account for these dates.')).toBeTruthy();
  });

  it('asks nothing for a reader below agency.supervise, and says whose page it is', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'viewer' });
    await renderAt();
    expect(screen.getByText(/Only supervisors can see every call in the account/)).toBeTruthy();
    expect(mocks.getAccountCalls).not.toHaveBeenCalled();
  });
});

describe('the old Soft-phone calls URL', () => {
  it('lands on All calls with the Soft phone chip on', async () => {
    await renderAt('/agency/softphone');
    expect(screen.getByTestId('where').textContent).toBe('/agency/calls?type=soft_phone');
    await waitFor(() => expect(lastCall()[1]).toMatchObject({ type: 'soft_phone' }));
  });

  it('keeps the rest of its query', async () => {
    await renderAt('/agency/softphone?agent_user_id=u-2&type=dialler');
    expect(screen.getByTestId('where').textContent).toBe('/agency/calls?agent_user_id=u-2&type=soft_phone');
  });
});
