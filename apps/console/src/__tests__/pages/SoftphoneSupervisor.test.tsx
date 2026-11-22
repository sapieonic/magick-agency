import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WithPageCrumbs, suppliedCrumbs } from '../helpers/pageCrumbs';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getSoftphoneBootstrap: vi.fn(),
  listManualCalls: vi.fn(),
  getManualCall: vi.fn(),
  fetchManualCallRecordingBlobUrl: vi.fn(),
  listTenantMembers: vi.fn(),
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
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));
vi.mock('../../api/calls', () => ({ retryAnalysis: vi.fn(), fetchRecordingBlobUrl: vi.fn() }));
vi.mock('../../components/audio/AudioWaveform', () => ({ AudioWaveform: () => <div data-testid="waveform" /> }));

import SoftphoneCallDetailPage, { savedByLine } from '../../pages/agency/softphone/SoftphoneCallDetailPage';
import { BOOTSTRAP, CAMPAIGN, manualCall } from '../helpers/softphone';
import type { WebRtcCallRecord } from '../../types/webrtc-call';
import type { AgencyManualCallListRow } from '../../types/softphone';
import { ANALYSIS_DELAY_MESSAGES, ANALYSIS_STATUS_LABELS, ANALYSIS_STATUS_MESSAGES } from '../../utils/vocabulary';

/**
 * A soft-phone call's detail (`docs/softphone.md` §7), where what the agent entered and what
 * the AI extracted are labelled apart and an override's reason is shown. The account's list of
 * soft-phone calls is All calls now (`AllCallsPage.test.tsx`, `docs/call-log.md` §7).
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
      <WithPageCrumbs>
        <Routes>
          <Route path="/agency/softphone/calls/:callId" element={<SoftphoneCallDetailPage />} />
        </Routes>
      </WithPageCrumbs>
    </MemoryRouter>,
  );
  await act(async () => {});
}

describe('a soft-phone call’s detail', () => {
  it('labels the agent’s outcome and call details apart from the AI’s analysis, and shows the override’s reason', async () => {
    mocks.getManualCall.mockResolvedValue({
      call: { ...TAGGED, notes: 'Wants it in writing.', fields: { customer_name: 'Rahul Verma', reason: 'Rate query', follow_up: true } },
      dispositioned_by_name: 'Priya Nair',
      overrides: {
        dnc_note: 'Customer called in and asked us to ring back', dnc_entry_id: 'dnc-1', hours_note: null,
        dnc_entry: { id: 'dnc-1', scope: 'campaign', reason: 'Asked twice', created_at: '2026-10-12T09:00:00Z', campaign_id: 'camp-1' },
      },
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
    // The entry as the agent saw it — reach, reason, date — never its id.
    expect(document.body.textContent).toMatch(/Listed forCampaign: Home Loan Renewals/);
    expect(document.body.textContent).toMatch(/ReasonAsked twice/);
    expect(document.body.textContent).toMatch(/Listed on12 Oct 2026/);
    expect(document.body.textContent).not.toContain('dnc-1');
    // The trail goes back through the campaign the call was logged to: its Call log, Soft phone chip on.
    expect(suppliedCrumbs()).toMatch(
      /^All calls→\/agency\/calls \/ Home Loan Renewals→\/agency\/campaigns\/camp-1\/attempts\?type=soft_phone \/ .+/,
    );
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
      overrides: { dnc_note: null, dnc_entry_id: null, dnc_entry: null, hours_note: null },
      media: MEDIA,
      call_availability: 'available',
    });
    await renderDetail();
    expect(document.body.textContent).toMatch(/· by Meera Iyer, on the agent’s behalf/);
  });

  it('shows the record alone for a call that was never placed', async () => {
    mocks.getManualCall.mockResolvedValue({
      call: manualCall({ state: 'ended', outcome: 'failed', settled_at: 'x' }),
      overrides: { dnc_note: null, dnc_entry_id: null, dnc_entry: null, hours_note: null },
      media: null,
      call_availability: 'never_placed',
    });
    await renderDetail();
    expect(screen.getByText('No call was placed')).toBeTruthy();
    expect(screen.queryByText('Overrides')).toBeNull();
    expect(document.body.textContent).toMatch(/Call record/);
  });

  it('says a placed call’s media is a supervisor’s when it is withheld, never that no call was placed', async () => {
    mocks.getManualCall.mockResolvedValue({
      call: TAGGED,
      overrides: { dnc_note: null, dnc_entry_id: null, dnc_entry: null, hours_note: null },
      media: null,
      call_availability: 'available',
    });
    await renderDetail();
    expect(screen.getByText('The recording and analysis are available to supervisors')).toBeTruthy();
    expect(screen.queryByText('No call was placed')).toBeNull();
    expect(screen.queryByText(/no longer available/)).toBeNull();
    expect(document.body.textContent).toMatch(/Call record/);
  });

  it('cannot show a call the caller may not see, and says how to go back', async () => {
    mocks.getManualCall.mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404, details: { code: 'call_not_found' } }));
    await renderDetail();
    expect(screen.getByText('We can’t show this call')).toBeTruthy();
    // Back is All calls with the Soft phone chip on: the Soft-phone calls page is gone (CL35).
    const back = screen.getByRole('link', { name: 'Back to All calls' });
    expect(back.getAttribute('href')).toBe('/agency/calls?type=soft_phone');
  });
});
