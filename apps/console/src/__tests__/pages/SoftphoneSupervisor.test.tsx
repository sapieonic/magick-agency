import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getSoftphoneBootstrap: vi.fn(),
  listManualCalls: vi.fn(),
  getManualCall: vi.fn(),
  fetchManualCallRecordingBlobUrl: vi.fn(),
  listTenantMembers: vi.fn(),
  getAgencyCampaign: vi.fn(),
  isEnabled: vi.fn((_c: string) => true),
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: mocks.isEnabled, loading: false, map: {}, refresh: vi.fn() }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true }),
}));
vi.mock('../../api/softphone', () => ({
  getSoftphoneBootstrap: mocks.getSoftphoneBootstrap,
  listManualCalls: mocks.listManualCalls,
  getManualCall: mocks.getManualCall,
  fetchManualCallRecordingBlobUrl: mocks.fetchManualCallRecordingBlobUrl,
}));
vi.mock('../../api/tenants', () => ({ listTenantMembers: mocks.listTenantMembers }));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaign: mocks.getAgencyCampaign }));
vi.mock('../../api/calls', () => ({ retryAnalysis: vi.fn(), fetchRecordingBlobUrl: vi.fn() }));
vi.mock('../../components/audio/AudioWaveform', () => ({ AudioWaveform: () => <div data-testid="waveform" /> }));

import SoftphoneCallsPage from '../../pages/agency/softphone/SoftphoneCallsPage';
import SoftphoneCallDetailPage, { savedByLine } from '../../pages/agency/softphone/SoftphoneCallDetailPage';
import AgencyCampaignManualCallsPage from '../../pages/agency/AgencyCampaignManualCallsPage';
import { todayLocal } from '../../utils/softphone/callStats';
import { BOOTSTRAP, CAMPAIGN, manualCall } from '../helpers/softphone';
import type { WebRtcCallRecord } from '../../types/webrtc-call';
import type { AgencyManualCallListRow } from '../../types/softphone';
import { ANALYSIS_STATUS_LABELS, ANALYSIS_STATUS_MESSAGES } from '../../utils/vocabulary';

/**
 * The supervisor's soft-phone surfaces (`docs/softphone.md` §7): the account
 * list with its stats strip, filters and keyset paging; a campaign's Manual
 * calls; and one call's detail, where what the agent entered and what the AI
 * extracted are labelled apart and an override's reason is shown.
 */

const TAGGED: AgencyManualCallListRow = manualCall({
  id: 'mc-tag',
  agent_user_id: 'u-1',
  agent_name: 'Priya Nair',
  tag: { campaign_id: 'camp-1', campaign_name: CAMPAIGN.campaign_name },
  state: 'ended',
  outcome: 'connected',
  bridged_at: '2026-10-30T10:00:05Z',
  talk_seconds: 277,
  disposition_code: 'callback',
  disposition_source: 'campaign',
  dnc_overridden: true,
  settled_at: '2026-10-30T10:06:00Z',
  dispositioned_at: '2026-10-30T10:06:00Z',
  dispositioned_by_user_id: 'u-1',
});
const TAGGED_ROW: AgencyManualCallListRow = { ...TAGGED, analysis_status: 'completed' };
const UNTAGGED: AgencyManualCallListRow = manualCall({
  id: 'mc-free',
  agent_user_id: 'u-2',
  agent_name: 'Arjun Kulkarni',
  state: 'ended',
  outcome: 'connected',
  bridged_at: '2026-10-30T09:00:05Z',
  talk_seconds: 168,
  disposition_code: 'resolved',
  disposition_source: 'softphone',
  settled_at: '2026-10-30T09:04:00Z',
});
const AWAITING = manualCall({ id: 'mc-wait', agent_name: 'Sneha Menon', state: 'ended', outcome: 'connected', bridged_at: 'x', requires_disposition: true, talk_seconds: 190 });

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.isEnabled.mockImplementation(() => true);
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'account_admin' });
  mocks.getSoftphoneBootstrap.mockResolvedValue(BOOTSTRAP);
  mocks.listTenantMembers.mockResolvedValue([
    { membership: { role: 'agent' }, user: { id: 'u-1', display_name: 'Priya Nair', email: 'p@x' } },
    { membership: { role: 'agent' }, user: { id: 'u-2', display_name: 'Arjun Kulkarni', email: 'a@x' } },
  ]);
  mocks.listManualCalls.mockResolvedValue({
    rows: [TAGGED_ROW, { ...UNTAGGED, analysis_status: 'pending' }, { ...AWAITING, analysis_status: null }],
    next_cursor: 'cur-2',
    limit: 50,
  });
});
afterEach(cleanup);

async function renderList() {
  render(
    <MemoryRouter>
      <SoftphoneCallsPage />
    </MemoryRouter>,
  );
  await act(async () => {});
}

describe('Soft-phone calls (the account list)', () => {
  it('opens on today, account-wide, newest first', async () => {
    await renderList();
    const query = mocks.listManualCalls.mock.calls[0]![0];
    expect(query.limit).toBe(50);
    expect(query.from).toBe(new Date(`${todayLocal()}T00:00:00`).toISOString());
    expect(query.agent_user_id).toBeUndefined();
  });

  it('counts the calls listed in the stats strip and says what it counts', async () => {
    await renderList();
    const strip = screen.getByRole('group', { name: 'Summary of the calls listed' });
    expect(strip.textContent).toMatch(/Calls3/);
    expect(strip.textContent).toMatch(/Connected3/);
    // (277 + 168 + 190) / 3 = 211.7 s, rounded.
    expect(strip.textContent).toMatch(/Avg talk3:32/);
    expect(strip.textContent).toMatch(/Not logged to a campaign2/);
    expect(strip.textContent).toMatch(/Waiting for an outcome1/);
    expect(screen.getByTestId('softphone-stats-note').textContent).toMatch(/Across the 3 calls listed below — load older calls to include them/);
  });

  it('reads each outcome against the catalog it was saved with, and marks an override', async () => {
    await renderList();
    const tagged = screen.getByTestId('softphone-row-mc-tag');
    expect(tagged.textContent).toMatch(/Priya Nair/);
    expect(tagged.textContent).toMatch(/Home Loan Renewals/);
    expect(tagged.textContent).toMatch(/Callback requested/);
    expect(tagged.textContent).toMatch(/DNC override/);
    expect(within(tagged).getByRole('link').getAttribute('href')).toBe('/agency/softphone/calls/mc-tag');
    const free = screen.getByTestId('softphone-row-mc-free');
    expect(free.textContent).toMatch(/Not logged to a campaign/);
    expect(free.textContent).toMatch(/Query resolved/);
    expect(screen.getByTestId('softphone-row-mc-wait').textContent).toMatch(/No outcome yet/);
  });

  it('applies the filters as the §6 query: agent, logged to (incl. not logged), what happened, number', async () => {
    await renderList();
    fireEvent.change(screen.getByTestId('filter-agent'), { target: { value: 'u-2' } });
    fireEvent.change(screen.getByTestId('filter-campaign'), { target: { value: 'untagged' } });
    fireEvent.change(screen.getByTestId('filter-outcome'), { target: { value: 'busy' } });
    fireEvent.change(screen.getByTestId('filter-phone'), { target: { value: '98204 617' } });
    expect([...(screen.getByTestId('filter-campaign') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Any',
      'Not logged to a campaign',
      'Home Loan Renewals',
    ]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('filter-apply'));
    });
    expect(mocks.listManualCalls.mock.calls[1]![0]).toMatchObject({
      agent_user_id: 'u-2',
      campaign_id: 'untagged',
      outcome: 'busy',
      phone: '98204617',
      limit: 50,
    });
    expect(screen.getByText('5 active')).toBeTruthy();
  });

  it('lists what the Waiting for an outcome tile counts: the Status filter sends the server’s status', async () => {
    await renderList();
    expect([...(screen.getByTestId('filter-status') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Any',
      'On a call now',
      'Waiting for an outcome',
      'Done',
    ]);
    fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'awaiting_outcome' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('filter-apply'));
    });
    expect(mocks.listManualCalls.mock.calls[1]![0]).toMatchObject({ status: 'awaiting_outcome' });
    expect(screen.getByText('2 active')).toBeTruthy();
  });

  it('shows each call’s summary stage in the detail’s words, a dash when there is none', async () => {
    await renderList();
    const header = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(header).toContain('Summary');
    const status = (id: string) => within(screen.getByTestId(`softphone-row-${id}`)).getByTestId('summary-status');
    expect(status('mc-tag').textContent).toBe(ANALYSIS_STATUS_LABELS.completed);
    expect(status('mc-free').textContent).toBe(ANALYSIS_STATUS_LABELS.pending);
    expect(status('mc-free').getAttribute('title')).toBe(ANALYSIS_STATUS_MESSAGES.pending);
    expect(status('mc-wait').textContent).toBe('—');
  });

  it('leaves the Summary column out when the account has analysis off', async () => {
    mocks.isEnabled.mockImplementation(() => false);
    await renderList();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).not.toContain('Summary');
    expect(screen.queryByTestId('summary-status')).toBeNull();
  });

  it('refuses an inverted date range before it is sent', async () => {
    await renderList();
    fireEvent.change(screen.getByTestId('filter-from'), { target: { value: '2026-10-31' } });
    fireEvent.change(screen.getByTestId('filter-to'), { target: { value: '2026-10-01' } });
    expect((screen.getByTestId('filter-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('pages with the keyset cursor and appends', async () => {
    await renderList();
    mocks.listManualCalls.mockResolvedValueOnce({ rows: [manualCall({ id: 'mc-older', agent_name: 'X', state: 'ended', settled_at: 'y' })], next_cursor: null, limit: 50 });
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-load-more'));
    });
    expect(mocks.listManualCalls.mock.calls[1]![0].cursor).toBe('cur-2');
    expect(screen.getByTestId('softphone-row-mc-older')).toBeTruthy();
    expect(screen.getByTestId('softphone-row-mc-tag')).toBeTruthy();
    expect(screen.queryByTestId('softphone-load-more')).toBeNull();
  });

  it('says when nothing matches the filters, as a fact about the query', async () => {
    mocks.listManualCalls.mockResolvedValue({ rows: [], next_cursor: null, limit: 50 });
    await renderList();
    fireEvent.change(screen.getByTestId('filter-outcome'), { target: { value: 'busy' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('filter-apply'));
    });
    expect(screen.getByText('Nothing matches those filters')).toBeTruthy();
  });

  it('says a quiet day is a quiet day, not a filter that matched nothing', async () => {
    mocks.listManualCalls.mockResolvedValue({ rows: [], next_cursor: null, limit: 50 });
    await renderList();
    expect(screen.getByText('No soft-phone calls today')).toBeTruthy();
    expect(screen.getByText('Widen the date range to see earlier calls.')).toBeTruthy();
  });

  it('Clear goes back to the view it opened on (today), not to all time', async () => {
    await renderList();
    // The opening view is nothing to clear.
    expect(screen.queryByTestId('filter-clear')).toBeNull();
    fireEvent.change(screen.getByTestId('filter-from'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByTestId('filter-outcome'), { target: { value: 'busy' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('filter-apply'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('filter-clear'));
    });
    const query = mocks.listManualCalls.mock.calls.at(-1)![0];
    expect(query.from).toBe(new Date(`${todayLocal()}T00:00:00`).toISOString());
    expect(query.to).toBeDefined();
    expect(query.outcome).toBeUndefined();
    expect(screen.queryByTestId('filter-clear')).toBeNull();
  });
});

describe('a campaign’s Manual calls', () => {
  it('is the same list with the tag fixed', async () => {
    mocks.getAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Home Loan Renewals', status: 'running' });
    render(
      <MemoryRouter initialEntries={['/agency/campaigns/camp-1/manual-calls']}>
        <Routes>
          <Route path="/agency/campaigns/:id/manual-calls" element={<AgencyCampaignManualCallsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(mocks.listManualCalls.mock.calls[0]![0]).toMatchObject({ campaign_id: 'camp-1' });
    expect(screen.queryByTestId('filter-campaign')).toBeNull();
    expect(screen.getByTestId('campaign-tab-manual').getAttribute('aria-current')).toBe('page');
  });
});

const MEDIA: WebRtcCallRecord = {
  id: 'call-9',
  tenant_id: 't-1',
  account_id: 'a-1',
  caller_id: '+912248901120',
  destination_phone: '+919820461733',
  provider: 'vobiz',
  provider_call_id: 'p-1',
  status: 'completed',
  outcome: 'browser_hangup',
  error_code: null,
  error_message: null,
  initiated_by: 'sess-1',
  metadata: null,
  recording_requested: true,
  recording_url: null,
  recording_duration_seconds: 270,
  answered_at: '2026-10-30T10:00:05Z',
  ended_at: '2026-10-30T10:04:42Z',
  duration_seconds: 282,
  talk_time_seconds: 277,
  analysis_status: 'completed',
  call_analysis: { common: { summary: 'Customer wants the revised rate in writing.' }, custom: { objection_type: 'Rate too high' } } as never,
  conversation_log: [{ role: 'agent', content: 'Namaste' }],
  transcript_meta: null,
  created_at: '2026-10-30T10:00:00Z',
  updated_at: '2026-10-30T10:06:00Z',
} as WebRtcCallRecord;

async function renderDetail() {
  render(
    <MemoryRouter initialEntries={['/agency/softphone/calls/mc-tag']}>
      <Routes>
        <Route path="/agency/softphone/calls/:callId" element={<SoftphoneCallDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}

describe('a soft-phone call’s detail', () => {
  it('labels the agent’s outcome and call details apart from the AI’s analysis, and shows the override’s reason', async () => {
    mocks.getManualCall.mockResolvedValue({
      call: { ...TAGGED, notes: 'Wants it in writing.', fields: { customer_name: 'Rahul Verma', reason: 'Rate query', follow_up: true } },
      dispositioned_by_name: 'Priya Nair',
      overrides: { dnc_note: 'Customer called in and asked us to ring back', dnc_entry_id: 'dnc-1', hours_note: null },
      media: MEDIA,
      call_availability: 'available',
    });
    await renderDetail();
    expect(mocks.getManualCall).toHaveBeenCalledWith('mc-tag', 't-1', 'a-1');
    // Who saved the outcome, by name.
    expect(document.body.textContent).toMatch(/Saved[^·]+· by Priya Nair(?!,)/);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(['OutcomeAgent', 'Call detailsAgent', 'OverridesAgent']));
    expect(screen.getByTestId('analysis-source').textContent).toBe('AI');
    expect(document.body.textContent).toMatch(/Customer wants the revised rate in writing\./);
    expect(document.body.textContent).toMatch(/Customer nameRahul Verma/);
    expect(document.body.textContent).toMatch(/Follow-up neededYes/);
    expect(document.body.textContent).toMatch(/Callback requested/);
    expect(document.body.textContent).toMatch(/Called through Do Not CallCustomer called in and asked us to ring back/);
    // The trail goes back through the campaign the call was logged to.
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.getByRole('link', { name: 'Home Loan Renewals' }).getAttribute('href')).toBe('/agency/campaigns/camp-1/manual-calls');
  });

  it('names the supervisor who saved an outcome on the agent’s behalf, and says only what it knows without a name', async () => {
    const onBehalf = { ...TAGGED, dispositioned_on_behalf: true, dispositioned_by_user_id: 'sup-1' };
    expect(savedByLine(onBehalf, 'Meera Iyer')).toMatch(/ · by Meera Iyer, on the agent’s behalf$/);
    expect(savedByLine(onBehalf, null)).toMatch(/ · by a supervisor, on the agent’s behalf$/);
    expect(savedByLine(TAGGED, null)).not.toMatch(/ by /);
    expect(savedByLine({ ...TAGGED, dispositioned_at: null }, 'Priya Nair')).toBeNull();

    mocks.getManualCall.mockResolvedValue({
      call: onBehalf,
      dispositioned_by_name: 'Meera Iyer',
      overrides: { dnc_note: null, dnc_entry_id: null, hours_note: null },
      media: MEDIA,
      call_availability: 'available',
    });
    await renderDetail();
    expect(document.body.textContent).toMatch(/· by Meera Iyer, on the agent’s behalf/);
  });

  it('shows the record alone for a call that was never placed', async () => {
    mocks.getManualCall.mockResolvedValue({
      call: manualCall({ state: 'ended', outcome: 'failed', settled_at: 'x' }),
      overrides: { dnc_note: null, dnc_entry_id: null, hours_note: null },
      media: null,
      call_availability: 'never_placed',
    });
    await renderDetail();
    expect(screen.getByText('No call was placed')).toBeTruthy();
    expect(screen.queryByText('Overrides')).toBeNull();
    expect(document.body.textContent).toMatch(/Call record/);
  });

  it('cannot show a call the caller may not see, and says how to go back', async () => {
    mocks.getManualCall.mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404, details: { code: 'call_not_found' } }));
    await renderDetail();
    expect(screen.getByText('We can’t show this call')).toBeTruthy();
  });
});
