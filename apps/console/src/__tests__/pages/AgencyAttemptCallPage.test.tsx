import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AgencyAttempt } from '../../types/agency-spine';
import type { WebRtcCallRecord } from '../../types/webrtc-call';
import type { AgencyAttemptCallDetail } from '../../api/agencySpine';

/**
 * The agency's own call detail — the page the whole isolation scope was for.
 *
 * ── What this file exists to prevent ────────────────────────────────────────
 * "Renders the call" was already true of a version that used exactly ONE field
 * off the attempt it fetched (`attempt_number`, for the breadcrumb leaf) and
 * showed the softphone's facts card instead — Provider, plus an `Initiated By`
 * that on an agency leg is the dialing session id. So a supervisor clicking a row
 * in the attempts list landed on a page carrying less agency information than the
 * row they clicked, plus a raw UUID. It was also true of a version whose failed
 * summary offered a "Try again" wired to the AI product's endpoint, and whose
 * loading and error states dropped the trail back to the campaign.
 *
 * Every assertion below is one of those, stated as behaviour rather than as
 * markup: what the supervisor can READ, and what they cannot be offered.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  isEnabled: vi.fn((_capability: string) => true),
  getAgencyAttemptCall: vi.fn(),
  getAgencyCampaign: vi.fn(),
  fetchAgencyAttemptRecordingBlobUrl: vi.fn(),
  retryAnalysis: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: mocks.isEnabled, loading: false, map: {}, refresh: vi.fn() }),
}));
vi.mock('../../api/agencySpine', () => ({
  getAgencyAttemptCall: mocks.getAgencyAttemptCall,
  fetchAgencyAttemptRecordingBlobUrl: mocks.fetchAgencyAttemptRecordingBlobUrl,
}));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaign: mocks.getAgencyCampaign }));
/*
 * The AI product's call client. Mocked so "this page never calls the other
 * product's retry endpoint" is an assertion rather than an import that happens
 * not to resolve — `AnalysisStatusCard` still defaults to it for its two
 * AI-call callers.
 */
vi.mock('../../api/calls', () => ({
  retryAnalysis: mocks.retryAnalysis,
  fetchRecordingBlobUrl: vi.fn(),
}));
vi.mock('../../components/audio/AudioWaveform', () => ({
  AudioWaveform: () => <div data-testid="waveform" />,
}));

import AgencyAttemptCallPage from '../../pages/agency/AgencyAttemptCallPage';

/** A UUID, as master actually serves — a fixture that looks like a name is how a raw-id render passes review. */
const AGENT_ID = 'ac1f9d2e-1111-4222-8333-444455556666';
/** The dialing SESSION id, which is what core writes to `webrtc_calls.initiated_by`. */
const SESSION_ID = 'bd2e8c3f-2222-4333-8444-555566667777';

const ATTEMPT: AgencyAttempt = {
  id: 'attempt-1', contact_id: 'contact-1', campaign_id: 'camp-1', attempt_number: 3,
  phone_e164: '+919876500001', caller_id: '+919000000001',
  agent_user_id: AGENT_ID, agent_name: 'Ravi Menon',
  reserved_agent_id: 'session-1', state: 'ended', outcome: 'connected',
  disposition_code: 'not_interested', notes: 'asked us to call after 6pm',
  callback_at: null, dispositioned_by_user_id: 'ravi',
  dispositioned_at: '2026-08-17T10:00:00.000Z', dispositioned_on_behalf: false,
  webrtc_call_id: 'call-9', dialed_at: '2026-08-17T09:59:00.000Z',
  answered_at: '2026-08-17T09:59:10.000Z', bridged_at: '2026-08-17T09:59:12.000Z',
  ended_at: '2026-08-17T09:59:59.000Z', talk_seconds: 47, wrapup_seconds: 20,
  created_at: '2026-08-17T09:58:00.000Z',
};

const CALL: WebRtcCallRecord = {
  id: 'call-9', tenant_id: 'tenant-1', account_id: 'account-1',
  caller_id: '+919000000001', destination_phone: '+919876500001',
  provider: 'vobiz', provider_call_id: 'p-1', status: 'completed',
  // The MEDIA leg's outcome, not the attempt's — the two differ by design.
  outcome: 'browser_hangup', error_code: null, error_message: null,
  initiated_by: SESSION_ID, metadata: null,
  recording_requested: true, recording_url: '/proxy/agency/camp-1/attempts/attempt-1/recording',
  recording_duration_seconds: 47,
  answered_at: '2026-08-17T09:59:10.000Z', ended_at: '2026-08-17T09:59:59.000Z',
  duration_seconds: 59, talk_time_seconds: 47,
  analysis_status: 'completed',
  call_analysis: { common: { summary: 'Customer asked for a callback after six.' } } as never,
  conversation_log: [{ role: 'agent', content: 'Good morning' }],
  transcript_meta: null,
  created_at: '2026-08-17T09:58:00.000Z', updated_at: '2026-08-17T10:00:00.000Z',
};

function detail(over: Partial<AgencyAttemptCallDetail> = {}): AgencyAttemptCallDetail {
  return { attempt: ATTEMPT, call: CALL, call_availability: 'available', ...over };
}

/**
 * The breadcrumb trail, scoped.
 *
 * "Call attempts" is a link in BOTH the trail and the section bar, to the same
 * path — which is exactly what this page was missing, so both are asserted, each
 * within its own landmark rather than by a name lookup that finds two.
 */
function trail() {
  return within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/attempts/attempt-1']}>
      <Routes>
        <Route path="/agency/campaigns/:id/attempts/:attemptId" element={<AgencyAttemptCallPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.isEnabled.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin',
  });
  mocks.getAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Q3 Renewals', status: 'stopped' });
  mocks.getAgencyAttemptCall.mockResolvedValue(detail());
  mocks.fetchAgencyAttemptRecordingBlobUrl.mockResolvedValue({
    status: 'ready', url: 'blob:x', mimeType: 'audio/mpeg',
  });
  mocks.retryAnalysis.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the page carries the agency record, not the softphone’s', () => {
  it('shows who worked the call, how it was written up, and what they typed', async () => {
    renderPage();

    // The field the whole surface exists for, by NAME — master resolves the id.
    expect((await screen.findByTestId('call-fact-Agent')).textContent).toContain('Ravi Menon');
    // The ATTEMPT's outcome, in the attempts list's own words.
    expect(screen.getByTestId('call-fact-Outcome').textContent).toContain('Connected');
    expect(screen.getByTestId('call-fact-Where it got to').textContent).toContain('Ended');
    // The write-up, under the heading the list it came from uses.
    expect(screen.getByText('Disposition')).toBeTruthy();
    expect(screen.getByTestId('call-fact-Code').textContent).toContain('not_interested');
    // "frequently the answer to why was this number called four times".
    expect(screen.getByTestId('call-fact-Notes').textContent).toContain('asked us to call after 6pm');
    expect(screen.getByTestId('call-fact-Wrap-up').textContent).toContain('0:20');
  });

  it('never renders the dialing session id, or any softphone-only field', async () => {
    renderPage();
    await screen.findByTestId('call-fact-Agent');

    // The defect this page was built to stop reintroducing, one product along.
    expect(screen.queryByText(SESSION_ID)).toBeNull();
    expect(screen.queryByTestId('call-fact-Initiated By')).toBeNull();
    expect(screen.queryByTestId('call-fact-Provider')).toBeNull();
    // And not the media leg's outcome under the word the attempt owns.
    expect(screen.queryByText('browser hangup')).toBeNull();
  });

  it('says "no agent was free" rather than leaving the agent blank', async () => {
    // `agent_user_id: null` is ordinary on an abandoned attempt, not missing data.
    mocks.getAgencyAttemptCall.mockResolvedValue(detail({
      attempt: {
        ...ATTEMPT, agent_user_id: null, agent_name: null, outcome: 'abandoned',
        bridged_at: null, disposition_code: null, notes: null, dispositioned_at: null,
      },
    }));
    renderPage();

    expect((await screen.findByTestId('call-fact-Agent')).textContent)
      .toContain('No agent was free');
    expect(screen.getByTestId('call-fact-Code').textContent).toContain('Not written up');
    expect(screen.getByTestId('call-fact-Notes').textContent).toContain('None');
  });

  it('shows the callback only when one was asked for', async () => {
    renderPage();
    await screen.findByTestId('call-fact-Agent');
    expect(screen.queryByTestId('call-fact-Call back')).toBeNull();

    cleanup();
    mocks.getAgencyAttemptCall.mockResolvedValue(detail({
      attempt: { ...ATTEMPT, callback_at: '2026-08-18T12:30:00.000Z' },
    }));
    renderPage();
    expect(await screen.findByTestId('call-fact-Call back')).toBeTruthy();
  });
});

describe('the affordances that cannot work are not offered', () => {
  it('offers no retry on a failed summary, and never calls the AI endpoint', async () => {
    mocks.getAgencyAttemptCall.mockResolvedValue(detail({
      call: { ...CALL, analysis_status: 'failed', call_analysis: null, conversation_log: null },
    }));
    renderPage();

    // The truthful half is still said.
    expect(await screen.findByText("We couldn't create a summary for this call.")).toBeTruthy();
    // There is no agency retry route, so there is no button — and no cross-product
    // call, which is what the omitted handler used to produce.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await waitFor(() => expect(mocks.retryAnalysis).not.toHaveBeenCalled());
  });

  it('does not promise a recording is coming when the account may not play them', async () => {
    // Exactly the shape master sends: `recording_url` nulled on the capability,
    // `recording_requested` left true.
    mocks.isEnabled.mockImplementation((capability: string) => capability !== 'agency.recording');
    mocks.getAgencyAttemptCall.mockResolvedValue(detail({
      call: { ...CALL, recording_url: null, recording_requested: true },
    }));
    renderPage();

    const note = await screen.findByTestId('recording-note');
    expect(note.textContent).toContain('not enabled for this account');
    expect(note.textContent).not.toContain('check back soon');
  });

  it('says a recording aged out rather than reporting a fault', async () => {
    mocks.fetchAgencyAttemptRecordingBlobUrl.mockResolvedValue({ status: 'purged' });
    renderPage();

    const note = await screen.findByTestId('recording-note');
    expect(note.textContent).toContain('retention window');
  });
});

/*
 * ── The state this page exists for ──────────────────────────────────────────
 *
 * `call === null` is not an edge case here. The attempt→call link is un-FK'd and
 * the two sides purge on independent windows, with the agency side deliberately
 * given the longer one (§7b), so a null call is the STEADY state for every row
 * older than the call-side window — which is to say, for the compliance rows this
 * surface was built to answer. The page used to render an empty state and nothing
 * else on it, having fetched the agent, the disposition, the notes and the wrap-up
 * and thrown them away, while its own copy promised "the attempt record below".
 */
describe('a call that is not there is an empty state, never an error', () => {
  it('says the call aged out, and keeps the whole attempt record on screen', async () => {
    mocks.getAgencyAttemptCall.mockResolvedValue(
      detail({ call: null, call_availability: 'purged' }),
    );
    renderPage();

    expect(await screen.findByText('This call is no longer available')).toBeTruthy();
    // Not an error: nothing is broken and nothing offers a retry.
    expect(screen.queryByRole('alert')).toBeNull();

    // Every fact the ordinary path shows, on the state where the attempt record
    // is all there is — the same functions, read off the same attempt.
    expect(screen.getByTestId('call-fact-Agent').textContent).toContain('Ravi Menon');
    expect(screen.getByTestId('call-fact-Outcome').textContent).toContain('Connected');
    expect(screen.getByTestId('call-fact-Where it got to').textContent).toContain('Ended');
    expect(screen.getByTestId('call-fact-Code').textContent).toContain('not_interested');
    expect(screen.getByTestId('call-fact-Notes').textContent)
      .toContain('asked us to call after 6pm');
    expect(screen.getByTestId('call-fact-Wrap-up').textContent).toContain('0:20');

    // And the three the call row carried on the ordinary path — the header's
    // destination, the Timeline card's timing — which only the attempt has now.
    expect(screen.getByTestId('call-fact-Number').textContent).toContain('+919876500001');
    expect(screen.getByTestId('call-fact-When')).toBeTruthy();
    expect(screen.getByTestId('call-fact-Talk time').textContent).toContain('0:47');
  });

  it('promises exactly what it renders, and no more', async () => {
    mocks.getAgencyAttemptCall.mockResolvedValue(
      detail({ call: null, call_availability: 'purged' }),
    );
    renderPage();

    // The copy names a record below it. The heading it names is on screen.
    expect(await screen.findByText(/The attempt record below is retained/)).toBeTruthy();
    expect(screen.getByText('Attempt record')).toBeTruthy();
    expect(screen.getByText('Disposition')).toBeTruthy();
    // And it now claims only the half a missing call row actually costs the
    // reader — the recording and the transcript, not the record.
    expect(screen.getByText(/recording and transcript for this call/)).toBeTruthy();
  });

  it('distinguishes "never dialled" from "aged out", and keeps the record on both', async () => {
    // The same attempt fixture on purpose: "same record, same words" is only
    // checkable if the row is the same row. `talk_seconds` is the one field that
    // genuinely cannot exist when no call was ever placed.
    mocks.getAgencyAttemptCall.mockResolvedValue(detail({
      attempt: { ...ATTEMPT, webrtc_call_id: null, bridged_at: null, talk_seconds: null },
      call: null,
      call_availability: 'never_placed',
    }));
    renderPage();

    expect(await screen.findByText('No call was placed')).toBeTruthy();
    expect(screen.queryByText('This call is no longer available')).toBeNull();
    expect(screen.getByText(/never a call/)).toBeTruthy();
    expect(screen.getByText(/The attempt record below is all there is/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    // The record, again — an attempt that never reached a call is still the
    // campaign's record of having tried this number, and the write-up on it is
    // still the answer to why it was tried.
    expect(screen.getByTestId('call-fact-Number').textContent).toContain('+919876500001');
    expect(screen.getByTestId('call-fact-Agent').textContent).toContain('Ravi Menon');
    expect(screen.getByTestId('call-fact-Code').textContent).toContain('not_interested');
    expect(screen.getByTestId('call-fact-Notes').textContent)
      .toContain('asked us to call after 6pm');
    // No talk time, and no dash standing in for one.
    expect(screen.queryByTestId('call-fact-Talk time')).toBeNull();
  });
});

describe('every state keeps the way back to the campaign', () => {
  it('renders the trail and the section bar while loading', async () => {
    let release: (value: AgencyAttemptCallDetail) => void = () => {};
    mocks.getAgencyAttemptCall.mockReturnValue(
      new Promise<AgencyAttemptCallDetail>((resolve) => { release = resolve; }),
    );
    renderPage();

    // The trail back exists before the call does.
    const back = await trail().findByRole('link', { name: 'Call attempts' });
    expect(back.getAttribute('href')).toBe('/agency/campaigns/camp-1/attempts');
    expect(screen.getByTestId('campaign-tabs')).toBeTruthy();

    release(detail());
    await screen.findByTestId('call-fact-Agent');
  });

  it('holds the campaign crumb with a placeholder rather than inserting it late', async () => {
    // A crumb that appears once its own request lands reflows the header on every
    // load, so the slot is there from the first paint.
    let releaseCampaign: (value: unknown) => void = () => {};
    mocks.getAgencyCampaign.mockReturnValue(new Promise((resolve) => { releaseCampaign = resolve; }));
    renderPage();

    await screen.findByTestId('call-fact-Agent');
    const placeholder = trail().getByRole('link', { name: 'Campaign' });
    expect(placeholder.getAttribute('href')).toBe('/agency/campaigns/camp-1');

    releaseCampaign({ id: 'camp-1', name: 'Q3 Renewals', status: 'stopped' });
    expect(await trail().findByRole('link', { name: 'Q3 Renewals' })).toBeTruthy();
  });

  it('shows the trail on a stale link, and offers no retry that cannot work', async () => {
    // Master forwards core's `attempt_not_found` verbatim, so the sentence is
    // honest — and pressing Retry returns the same 404 forever.
    mocks.getAgencyAttemptCall.mockRejectedValue(Object.assign(
      new Error('Attempt not found on this campaign'),
      { statusCode: 404, details: { code: 'attempt_not_found' } },
    ));
    renderPage();

    expect(await screen.findByText('We can’t show this call')).toBeTruthy();
    expect(screen.getByText(/Attempt not found on this campaign/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry loading' })).toBeNull();
    // The way back is on the one state that most needs it.
    expect(trail().getByRole('link', { name: 'Call attempts' })).toBeTruthy();
    expect(screen.getByTestId('campaign-tabs')).toBeTruthy();
  });

  it('DOES offer a retry on a failure that retrying could fix', async () => {
    // The matched half: a 502 or a dropped connection is worth pressing again,
    // and suppressing the button for every error would be the opposite defect.
    mocks.getAgencyAttemptCall.mockRejectedValue(new Error('Failed to fetch'));
    renderPage();

    expect(await screen.findByRole('button', { name: 'Retry loading' })).toBeTruthy();
    expect(trail().getByRole('link', { name: 'Call attempts' })).toBeTruthy();
  });
});

describe('the analysis family follows the agency’s own entitlement', () => {
  it('hides the summary and transcript outright with agency.analytics off', async () => {
    mocks.isEnabled.mockImplementation((capability: string) => capability !== 'agency.analytics');
    // Master strips the content fields for the same capability, so this is the
    // payload the page really receives.
    mocks.getAgencyAttemptCall.mockResolvedValue(detail({
      call: { ...CALL, call_analysis: null, conversation_log: null, transcript_meta: null },
    }));
    renderPage();

    await screen.findByTestId('call-fact-Agent');
    // Hidden, not rendered empty: no summary heading, no transcript, and no
    // purge notice claiming a deletion that did not happen.
    expect(screen.queryByText('Call summary')).toBeNull();
    expect(screen.queryByText('Transcript')).toBeNull();
    expect(screen.queryByTestId('transcript-purged')).toBeNull();
  });

  it('says the transcript aged out when the summary outlived it', async () => {
    mocks.getAgencyAttemptCall.mockResolvedValue(detail({
      call: { ...CALL, conversation_log: null },
    }));
    renderPage();

    expect((await screen.findByTestId('transcript-purged')).textContent)
      .toContain('passed its retention window');
    // The summary is still there, so the DSAR sentence would be false.
    expect(screen.getByText('Customer asked for a callback after six.')).toBeTruthy();
  });
});

describe('the disposition the agent filed', () => {
  /*
    This is the deepest a supervisor can go on one call, and it was where the raw
    code was least excusable: the field was labelled "Code" and printed `ptp`, so
    the one screen that exists to explain a single call explained the least.
  */
  it('names the outcome, keeping the filed code on hover', async () => {
    mocks.getAgencyCampaign.mockResolvedValue({
      id: 'camp-1',
      name: 'Q3 Renewals',
      status: 'stopped',
      disposition_catalog: [
        { code: 'not_interested', label: 'Not interested' },
        { code: 'ptp', label: 'PTP' },
      ],
    });

    await renderPage();

    expect(await screen.findByText('Not interested')).toBeTruthy();
    expect(screen.getByText('Written up as')).toBeTruthy();
    // The label replaces the code on screen but must not hide what was filed.
    expect(screen.queryByText('not_interested')).toBeNull();
    expect(screen.getByTitle('Filed as “not_interested”')).toBeTruthy();
  });

  it('picks up the catalog when the campaign answers after the attempt', async () => {
    /*
      A stale-memo defect review caught, and the ordering it needs is the COMMON
      one — which is why every other test here missed it.

      The attempt and the campaign are two independent requests. `identityCards`
      memoised `agencyDispositionCard(detail.attempt, campaign?.disposition_catalog)`
      on `[detail]` alone, so whichever settled first won: the attempt usually
      does, the card cached the raw-code fallback, and the operator's own label
      never appeared however late the catalog arrived. Both mocks resolving in
      the same tick hid it completely.

      So the campaign is deliberately held until the code fallback is on screen.
    */
    let releaseCampaign: (value: unknown) => void = () => {};
    mocks.getAgencyCampaign.mockReturnValue(new Promise((resolve) => {
      releaseCampaign = resolve;
    }));

    renderPage();

    // The attempt has landed and the catalog has not, so the code stands in.
    expect(await screen.findByText('not_interested')).toBeTruthy();
    expect(screen.getByText('Code')).toBeTruthy();

    releaseCampaign({
      id: 'camp-1',
      name: 'Q3 Renewals',
      status: 'stopped',
      disposition_catalog: [{ code: 'not_interested', label: 'Not interested' }],
    });

    // And the label replaces it once the catalog is in hand.
    expect(await screen.findByText('Not interested')).toBeTruthy();
    expect(screen.getByText('Written up as')).toBeTruthy();
    expect(screen.queryByText('not_interested')).toBeNull();
  });

  it('falls back to the code, and says so, when the catalog cannot name it', async () => {
    // An older master sends no catalog; a code retired since the call was filed
    // is not in it. Either way the code is what we know, and the heading must
    // not promise a name it is not showing.
    mocks.getAgencyCampaign.mockResolvedValue({
      id: 'camp-1', name: 'Q3 Renewals', status: 'stopped',
    });

    await renderPage();

    expect(await screen.findByText('not_interested')).toBeTruthy();
    expect(screen.getByText('Code')).toBeTruthy();
    expect(screen.queryByText('Written up as')).toBeNull();
  });
});
