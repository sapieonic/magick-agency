import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { WithPageCrumbs, suppliedCrumbs } from '../helpers/pageCrumbs';
import type { AgencyCallLogInboundRow, AgencyInboundCallLogDetail } from '../../types/agency-call-log';
import type { WebRtcCallRecord } from '../../types/webrtc-call';

/**
 * The inbound Call page (`/agency/campaigns/:id/calls/inbound/:callId`, docs/call-log.md §4):
 * the page an inbound row of the Call log opens. What it must get right: the caller's path in
 * order, the outcome or the follow-up by which call it was, the media only when the server
 * sent it, and a way back when the call is not this campaign's.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  isEnabled: vi.fn((_capability: string) => true),
  flags: new Set<string>(),
  getInboundCallLogDetail: vi.fn(),
  fetchInboundCallRecordingBlobUrl: vi.fn(),
  getAgencyCampaign: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));
vi.mock('../../api/agencyInsights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyInsights')>()),
  getInsightsAllocation: () => new Promise(() => {}),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: mocks.isEnabled, loading: false, map: {}, refresh: vi.fn() }),
}));
vi.mock('../../api/agencySpine', () => ({
  getInboundCallLogDetail: mocks.getInboundCallLogDetail,
  fetchInboundCallRecordingBlobUrl: mocks.fetchInboundCallRecordingBlobUrl,
}));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaign: mocks.getAgencyCampaign }));
vi.mock('../../api/calls', () => ({ retryAnalysis: vi.fn(), fetchRecordingBlobUrl: vi.fn() }));
vi.mock('../../components/audio/AudioWaveform', () => ({
  AudioWaveform: () => <div data-testid="waveform" />,
}));

import AgencyInboundCallPage from '../../pages/agency/AgencyInboundCallPage';
import { ApiError } from '../../api/client';

const ANSWERED: AgencyCallLogInboundRow = {
  type: 'inbound', id: 'inbound-1', campaign_id: 'camp-1', campaign_source: 'contact', contact_id: 'contact-7',
  phone_e164: '+919876504821', caller_id: '+919000000001', route_name: 'Sales line',
  agent_user_id: 'u-priya', agent_name: 'Priya Nair', state: 'ended', outcome: 'answered',
  disposition_code: 'will_pay', notes: 'Salary on 24th, will pay full EMI', callback_at: null,
  promise_date: '2026-11-25', promise_amount: '4850.00',
  dispositioned_by_user_id: 'u-priya', dispositioned_at: '2026-11-22T15:47:00.000Z', dispositioned_on_behalf: false,
  webrtc_call_id: 'call-9', answered_at: '2026-11-22T15:42:01.000Z', bridged_at: '2026-11-22T15:42:19.000Z',
  ended_at: '2026-11-22T15:46:31.000Z', talk_seconds: 252, wait_seconds: 18, queued: true, via_sticky_agent: true,
  requires_disposition: false, settled_at: '2026-11-22T15:47:00.000Z', voicemail_seconds: null, follow_up: null,
  called_back: null, created_at: '2026-11-22T15:42:01.000Z',
};
const MISSED: AgencyCallLogInboundRow = {
  ...ANSWERED, id: 'inbound-1', contact_id: null, agent_user_id: null, agent_name: null, outcome: 'voicemail',
  disposition_code: null, notes: null, promise_date: null, promise_amount: null, dispositioned_by_user_id: null,
  dispositioned_at: null, bridged_at: null, talk_seconds: null, wait_seconds: 100, via_sticky_agent: false, voicemail_seconds: 22,
  follow_up: { status: 'open', reason: 'overflow', closed_cause: null, assignee_user_id: 'u-arjun', assignee_name: 'Arjun Mehta', handled_reason: null, handled_at: null },
};

const CALL: WebRtcCallRecord = {
  id: 'call-9', tenant_id: 'tenant-1', account_id: 'account-1',
  caller_id: '+919000000001', destination_phone: '+919876504821',
  provider: 'plivo', provider_call_id: 'p-1', status: 'completed',
  outcome: 'browser_hangup', error_code: null, error_message: null,
  initiated_by: null, metadata: null,
  recording_requested: true, recording_url: '/proxy/agency/campaigns/camp-1/call-log/inbound/inbound-1/recording',
  recording_duration_seconds: 252,
  answered_at: '2026-11-22T15:42:01.000Z', ended_at: '2026-11-22T15:46:31.000Z',
  duration_seconds: 270, talk_time_seconds: 252,
  analysis_status: 'completed',
  call_analysis: { common: { summary: 'Customer rang back after a missed dial and will pay on 25 Nov.' } } as never,
  conversation_log: [{ role: 'agent', content: 'Good afternoon' }],
  transcript_meta: null,
  created_at: '2026-11-22T15:42:01.000Z', updated_at: '2026-11-22T15:47:00.000Z',
} as WebRtcCallRecord;

function detail(over: Partial<AgencyInboundCallLogDetail> = {}): AgencyInboundCallLogDetail {
  return {
    inbound: ANSWERED,
    journey: [
      { kind: 'rang', at: '2026-11-22T15:42:01.000Z', seconds: null },
      { kind: 'greeting', at: '2026-11-22T15:42:01.000Z', seconds: null },
      { kind: 'waited', at: null, seconds: 18 },
      { kind: 'answered', at: '2026-11-22T15:42:19.000Z', seconds: null },
      { kind: 'ended', at: '2026-11-22T15:46:31.000Z', seconds: 252 },
    ],
    dispositioned_by_name: 'Priya Nair',
    voicemail_url: null,
    call: CALL,
    call_availability: 'available',
    ...over,
  };
}

function Phone() {
  const location = useLocation();
  return <p data-testid="soft-phone">{JSON.stringify(location.state)}</p>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/calls/inbound/inbound-1']}>
      <WithPageCrumbs>
        <Routes>
          <Route path="/agency/campaigns/:id/calls/inbound/:callId" element={<AgencyInboundCallPage />} />
          <Route path="/dialer/phone" element={<Phone />} />
        </Routes>
      </WithPageCrumbs>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.flags = new Set(['agency_softphone_enabled']);
  mocks.isEnabled.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin' });
  mocks.getAgencyCampaign.mockResolvedValue({
    id: 'camp-1', name: 'Diwali EMI Collections', status: 'running',
    disposition_catalog: [{ code: 'will_pay', label: 'Will pay' }],
  });
  mocks.getInboundCallLogDetail.mockResolvedValue(detail());
  mocks.fetchInboundCallRecordingBlobUrl.mockResolvedValue({ status: 'ready', url: 'blob:x', mimeType: 'audio/mpeg' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('an answered inbound call', () => {
  it('reads the campaign’s call, and says who rang, when, and why it is in this log', async () => {
    renderPage();
    expect((await screen.findByTestId('inbound-call-caller')).textContent).toContain('98765 04821');
    expect(mocks.getInboundCallLogDetail).toHaveBeenCalledWith('camp-1', 'inbound-1', 'tenant-1', 'account-1');
    expect(screen.getByTestId('inbound-call-headline').textContent)
      .toBe('Inbound · 22 Nov 2026, 03:42 pm · filed under this campaign because the number is on its list');
  });

  it('tells the caller’s path in order', async () => {
    renderPage();
    const steps = within(await screen.findByTestId('inbound-call-journey')).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      'Rang3:42:01 pm · Sales line',
      'Greetingwe answered and played our message',
      'Waited 0:18came through their agent',
      'Priya Nair answered3:42:19 pm',
      'Ended3:46:31 pm · talk 4:12',
    ]);
  });

  it('shows the agent, the outcome by the campaign’s label, the notes, and the summary', async () => {
    renderPage();
    expect((await screen.findByTestId('call-fact-Agent')).textContent).toContain('Priya Nair');
    expect(screen.getByTestId('call-fact-What happened').textContent).toContain('Answered · waited 0:18 · came through their agent');
    expect(screen.getByTestId('call-fact-Outcome').textContent).toContain('Will pay');
    expect(screen.getByTestId('call-fact-Saved').textContent).toContain('by Priya Nair');
    expect(screen.getByTestId('call-fact-Notes').textContent).toContain('Salary on 24th');
    expect(screen.getByText(/Customer rang back after a missed dial/)).toBeTruthy();
    expect(screen.queryByText('Follow-up')).toBeNull();
  });

  it('puts the trail in the top bar: the campaign, Call log, Call', async () => {
    renderPage();
    await screen.findByTestId('inbound-call-caller');
    expect(suppliedCrumbs()).toBe('Diwali EMI Collections→/agency/campaigns/camp-1 / Call log→/agency/campaigns/camp-1/attempts / Call');
  });

  it('links to the contact, and Call back is a plain prefill: an answered call has no call back to be linked to', async () => {
    renderPage();
    await screen.findByTestId('inbound-call-caller');
    expect(screen.getByText('Open contact').closest('a')!.getAttribute('href')).toBe('/agency/campaigns/camp-1/contacts/contact-7');
    fireEvent.click(screen.getByTestId('inbound-call-back'));
    expect(JSON.parse((await screen.findByTestId('soft-phone')).textContent!)).toEqual({
      softphonePrefill: { number: '+919876504821', campaignId: 'camp-1', inboundCallId: null },
    });
  });
});

describe('a missed inbound call', () => {
  beforeEach(() => {
    mocks.getInboundCallLogDetail.mockResolvedValue(detail({
      inbound: MISSED,
      journey: [
        { kind: 'rang', at: '2026-11-22T15:42:01.000Z', seconds: null },
        { kind: 'waited', at: null, seconds: 100 },
        { kind: 'missed', at: null, seconds: null },
        { kind: 'voicemail', at: null, seconds: 22 },
        { kind: 'ended', at: '2026-11-22T15:43:41.000Z', seconds: null },
      ],
      dispositioned_by_name: null,
      voicemail_url: '/inbound/missed/inbound-1/voicemail',
      call: null,
      call_availability: 'never_placed',
    }));
  });

  it('shows the follow-up in place of an outcome, and offers the voicemail', async () => {
    renderPage();
    expect((await screen.findByTestId('call-fact-Follow-up')).textContent).toContain('To follow up');
    expect(screen.getByTestId('call-fact-Why it was missed').textContent).toContain('Nobody free to answer');
    expect(screen.getByTestId('call-fact-Assigned to').textContent).toContain('Arjun Mehta');
    expect(screen.getByTestId('call-fact-Agent').textContent).toContain('Nobody answered');
    expect(screen.queryByTestId('call-fact-Outcome')).toBeNull();
    expect(screen.getByTestId('missed-voicemail-play')).toBeTruthy();
    expect(within(screen.getByTestId('inbound-call-journey')).getByText('Nobody answered')).toBeTruthy();
    // No media leg: said, with the record still shown.
    expect(screen.getByText('There is no recording of this call')).toBeTruthy();
  });

  it('Call back carries the missed call’s id, so the call placed is its call back (CL1)', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('inbound-call-back'));
    expect(JSON.parse((await screen.findByTestId('soft-phone')).textContent!)).toEqual({
      softphonePrefill: { number: '+919876504821', campaignId: 'camp-1', inboundCallId: 'inbound-1' },
    });
  });

  it('offers no Call back with the soft phone off, or for a withheld number', async () => {
    mocks.flags = new Set();
    renderPage();
    await screen.findByTestId('inbound-call-caller');
    expect(screen.queryByTestId('inbound-call-back')).toBeNull();
    cleanup();

    mocks.flags = new Set(['agency_softphone_enabled']);
    mocks.getInboundCallLogDetail.mockResolvedValue(detail({ inbound: { ...MISSED, phone_e164: null }, call: null, call_availability: 'never_placed' }));
    renderPage();
    expect((await screen.findByTestId('inbound-call-caller')).textContent).toContain('Number withheld');
    expect(screen.queryByTestId('inbound-call-back')).toBeNull();
  });
});

describe('a call the page cannot show', () => {
  it('says a purged call’s recording has gone and keeps the record', async () => {
    mocks.getInboundCallLogDetail.mockResolvedValue(detail({ call: null, call_availability: 'purged' }));
    renderPage();
    expect(await screen.findByText('This call’s recording and transcript are no longer available')).toBeTruthy();
    expect(screen.getByTestId('call-fact-Outcome').textContent).toContain('Will pay');
  });

  it('a call that is not this campaign’s offers the way back to the Call log, and no Retry', async () => {
    mocks.getInboundCallLogDetail.mockRejectedValue(new ApiError(404, { error: 'Not Found', code: 'inbound_call_not_found', message: 'Inbound call not found on this campaign' }));
    renderPage();
    expect(await screen.findByText('We can’t show this call')).toBeTruthy();
    expect(screen.getByText('Back to the call log').closest('a')!.getAttribute('href')).toBe('/agency/campaigns/camp-1/attempts?type=inbound');
    expect(screen.queryByText('Retry')).toBeNull();
  });
});
