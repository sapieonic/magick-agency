import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WebRtcCallRecord } from '../../types/webrtc-call';
import type { CallAnalysisResult } from '../../types/call';

/**
 * The shared call-detail view — one component, two products.
 *
 * ── What this file exists to prevent ────────────────────────────────────────
 * Everything asserted here is a defect that shipped, and every one of them
 * rendered perfectly. "It renders the call" was true of the version that offered
 * an agency supervisor a primary "Try again" button wired to the AI product's
 * endpoint, and true of the version that dropped a purged transcript out of the
 * DOM entirely. So the assertions are about what the component says when
 * something is ABSENT — a retry route it does not have, a recording it may not
 * play, a transcript that has aged out — because that is where a shared view
 * silently inherits the wrong product's answer.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  retryAnalysis: vi.fn(),
  loadTranscriptVisible: vi.fn(),
  saveTranscriptVisible: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
/*
 * `api/calls` is the AI product's client, and `AnalysisStatusCard` defaults its
 * retry to `retryAnalysis` in it. Mocked here so the "no handler ⇒ no call"
 * assertion below is an assertion about behaviour rather than about a module
 * that happened not to be imported.
 */
vi.mock('../../api/calls', () => ({
  retryAnalysis: mocks.retryAnalysis,
  fetchRecordingBlobUrl: vi.fn(),
}));
vi.mock('../../utils/transcript-prefs', () => ({
  loadTranscriptVisible: mocks.loadTranscriptVisible,
  saveTranscriptVisible: mocks.saveTranscriptVisible,
}));
vi.mock('../../components/audio/AudioWaveform', () => ({
  AudioWaveform: ({ src }: { src: string }) => <div data-testid="waveform" data-src={src} />,
}));

import {
  CallDetailView,
  type CallDetailViewProps,
} from '../../components/calls/CallDetailView';

const ANALYSIS: CallAnalysisResult = {
  common: { summary: 'Customer asked to be called back after six.' },
} as CallAnalysisResult;

const CALL: WebRtcCallRecord = {
  id: 'call-9', tenant_id: 'tenant-1', account_id: 'account-1',
  caller_id: '+919000000001', destination_phone: '+919876500001',
  provider: 'vobiz', provider_call_id: 'p-1', status: 'completed',
  outcome: 'browser_hangup', error_code: null, error_message: null,
  initiated_by: 'ac1f9d2e-1111-4222-8333-444455556666', metadata: null,
  recording_requested: true, recording_url: '/proxy/agency/x/recording',
  recording_duration_seconds: 47,
  answered_at: '2026-08-17T09:59:10.000Z', ended_at: '2026-08-17T09:59:59.000Z',
  duration_seconds: 59, talk_time_seconds: 47,
  analysis_status: 'completed', call_analysis: ANALYSIS,
  conversation_log: [{ role: 'agent', content: 'Good morning' }],
  created_at: '2026-08-17T09:58:00.000Z', updated_at: '2026-08-17T10:00:00.000Z',
};

/**
 * Every product prop stated, because every product prop is required — the
 * default this helper supplies is the TEST's choice, never the component's.
 */
function props(overrides: Partial<CallDetailViewProps> = {}): CallDetailViewProps {
  return {
    call: CALL,
    breadcrumbs: [{ label: 'Campaigns', href: '/agency/campaigns' }],
    leafLabel: 'Attempt 2',
    subtitle: 'Connected',
    roleLabels: { agent: 'Agent', customer: 'Customer' },
    identityFacts: [],
    identityCards: [],
    analysisEnabled: true,
    analysisTitle: 'Call summary',
    analysisMessages: { failed: "We couldn't create a summary for this call." },
    retryLabel: 'Try again',
    recordingEnabled: true,
    fetchRecording: vi.fn().mockResolvedValue({
      status: 'ready', url: 'blob:x', mimeType: 'audio/mpeg',
    }),
    onRetryAnalysis: undefined,
    onReload: vi.fn(),
    ...overrides,
  };
}

function renderView(overrides: Partial<CallDetailViewProps> = {}) {
  return render(
    <MemoryRouter>
      <CallDetailView {...props(overrides)} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.loadTranscriptVisible.mockReturnValue(true);
  mocks.retryAnalysis.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a retry affordance only exists when it can work', () => {
  it('offers no retry, and never touches the AI endpoint, without a handler', async () => {
    renderView({
      call: { ...CALL, analysis_status: 'failed', call_analysis: null },
      onRetryAnalysis: undefined,
    });

    // The honest half is still said.
    expect(screen.getByText("We couldn't create a summary for this call.")).toBeTruthy();
    // The dead affordance is not.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await waitFor(() => expect(mocks.retryAnalysis).not.toHaveBeenCalled());
  });

  it('offers the retry when the product supplied one', () => {
    renderView({
      call: { ...CALL, analysis_status: 'failed', call_analysis: null },
      onRetryAnalysis: vi.fn().mockResolvedValue(undefined),
    });

    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('withholds the retry on an expired summary with no recording to retry from', () => {
    renderView({
      call: {
        ...CALL, analysis_status: 'expired', call_analysis: null, recording_url: null,
      },
      analysisMessages: { expired: 'No recording was ever delivered.' },
      onRetryAnalysis: vi.fn(),
    });

    expect(screen.getByText('No recording was ever delivered.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('the identity of a call is the product’s answer, not this file’s', () => {
  it('renders the facts and cards it is handed, and nothing it is not', () => {
    renderView({
      identityFacts: [
        { label: 'Agent', value: 'Ravi Menon' },
        { label: 'Outcome', value: 'Connected' },
      ],
      identityCards: [{
        title: 'Disposition',
        facts: [
          { label: 'Code', value: 'not_interested' },
          { label: 'Notes', value: 'asked us to call after 6pm', prose: true },
        ],
      }],
    });

    expect(screen.getByTestId('call-fact-Agent').textContent).toContain('Ravi Menon');
    expect(screen.getByText('Disposition')).toBeTruthy();
    expect(screen.getByText('asked us to call after 6pm')).toBeTruthy();
    // The softphone's own facts are NOT baked in: a caller that does not pass
    // Provider or Initiated By does not get them — which is what stopped an
    // agency supervisor reading a dialing-session UUID off this page.
    expect(screen.queryByTestId('call-fact-Provider')).toBeNull();
    expect(screen.queryByTestId('call-fact-Initiated By')).toBeNull();
    expect(screen.queryByText(CALL.initiated_by!)).toBeNull();
  });

  it('states an absent fact rather than leaving a blank cell', () => {
    renderView({ identityFacts: [{ label: 'Agent', value: null }] });

    expect(screen.getByTestId('call-fact-Agent').textContent).toContain('--');
  });
});

describe('a missing recording says which kind of missing', () => {
  it('does not promise "check back soon" when the product may not play recordings', async () => {
    // Master nulls `recording_url` on a tenant without the capability and leaves
    // `recording_requested` true, so this is exactly the pair the old copy read.
    renderView({
      call: { ...CALL, recording_url: null, recording_requested: true },
      recordingEnabled: false,
    });

    const note = await screen.findByTestId('recording-note');
    expect(note.textContent).toContain('not enabled for this account');
    expect(note.textContent).not.toContain('check back soon');
  });

  it('still says "check back soon" when the recording really is finalising', async () => {
    renderView({
      call: { ...CALL, recording_url: null, recording_requested: true },
      recordingEnabled: true,
    });

    const note = await screen.findByTestId('recording-note');
    expect(note.textContent).toContain('check back soon');
  });

  it.each([
    ['purged', 'retention window'],
    ['not_recorded', 'was not recorded'],
    ['forbidden', 'not enabled for this account'],
    ['unreachable', 'could not reach'],
  ])('distinguishes a %s fetch from every other kind of nothing', async (status, phrase) => {
    renderView({ fetchRecording: vi.fn().mockResolvedValue({ status }) });

    const note = await screen.findByTestId('recording-note');
    expect(note.textContent).toContain(phrase);
    // The sentence that used to cover all four.
    expect(note.textContent).not.toContain('Recording not available.');
  });

  it('stays unqualified when the fetcher itself cannot say why', async () => {
    // `null` is the softphone's client collapsing every failure. Inventing one of
    // the four sentences above for it would put a specific claim on a caller that
    // made none.
    renderView({ fetchRecording: vi.fn().mockResolvedValue(null) });

    expect(await screen.findByText('Recording not available.')).toBeTruthy();
  });

  it('plays a recording that is there', async () => {
    renderView();
    expect(await screen.findByTestId('waveform')).toBeTruthy();
  });
});

describe('a recording the provider serves directly', () => {
  // Core hands back an absolute URL when the provider serves the file publicly
  // (VoiceLink/Elision) instead of one of its own proxy paths, because its egress
  // cannot reach that host. Asserted on the SHARED view because both products
  // format through it — the softphone and the agency supervisor alike.
  const VOICELINK_URL =
    'https://voiceflowai.elisiontec.com/voiceapp-recordings/client_1150/2026-07-11/abc.mp3';

  it('plays an absolute URL as-is, without calling the injected fetcher', async () => {
    const fetchRecording = vi.fn();
    renderView({ call: { ...CALL, recording_url: VOICELINK_URL }, fetchRecording });

    expect((await screen.findByTestId('waveform')).getAttribute('data-src')).toBe(VOICELINK_URL);
    expect(fetchRecording).not.toHaveBeenCalled();
  });

  it('opens its download in a new tab, since cross-origin `download` is ignored', async () => {
    renderView({ call: { ...CALL, recording_url: VOICELINK_URL }, fetchRecording: vi.fn() });

    const dl = await screen.findByRole('link', { name: /Download/i });
    expect(dl.getAttribute('href')).toBe(VOICELINK_URL);
    expect(dl.getAttribute('target')).toBe('_blank');
    expect(dl.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps a proxied download in-tab, where `download` is honoured', async () => {
    renderView();

    const dl = await screen.findByRole('link', { name: /Download/i });
    expect(dl.getAttribute('target')).toBeNull();
    expect(dl.getAttribute('rel')).toBeNull();
  });

  it('plays a direct URL even when the call viewed before it left an error behind', async () => {
    // This section is not remounted when the route's `:id` changes — same element
    // type, so React keeps its state — which means a rejected fetch for the
    // previous call is still sitting in `error`. That failure has nothing to do
    // with a URL the browser can play by itself, and must not hide it.
    const { rerender } = render(
      <MemoryRouter>
        <CallDetailView {...props({ fetchRecording: vi.fn().mockRejectedValue(new Error('network')) })} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Failed to load recording')).toBeTruthy();

    // A fresh element, not the same one: React bails out of re-rendering a
    // referentially identical element, which would make this pass for the wrong
    // reason.
    rerender(
      <MemoryRouter>
        <CallDetailView
          {...props({
            call: { ...CALL, id: 'call-2', recording_url: VOICELINK_URL },
            fetchRecording: vi.fn(),
          })}
        />
      </MemoryRouter>,
    );

    expect((await screen.findByTestId('waveform')).getAttribute('data-src')).toBe(VOICELINK_URL);
    expect(screen.queryByText('Failed to load recording')).toBeNull();
  });
});

describe('a transcript that aged out is a state, not an absence', () => {
  it('says the transcript was deleted when the summary outlived it', () => {
    // Core's retention step nulls `conversation_log` and leaves
    // `analysis_status` at `completed`, so the section simply vanished from under
    // a summary that is still on screen.
    renderView({ call: { ...CALL, conversation_log: null } });

    expect(screen.getByTestId('transcript-purged').textContent)
      .toContain('passed its retention window');
    // And does not misreport the summary as gone with it — that is the DSAR
    // erasure's sentence, and the summary is right there above.
    expect(screen.getByTestId('transcript-purged').textContent)
      .not.toContain('The transcript and summary for this call were deleted');
  });

  it('renders the transcript, and no purge notice, when the turns are there', () => {
    renderView();

    expect(screen.getByText('Good morning')).toBeTruthy();
    expect(screen.queryByTestId('transcript-purged')).toBeNull();
  });

  it('says nothing about a transcript on a call whose summary never completed', () => {
    // `pending` has no transcript yet and has not lost one. A purge notice here
    // would claim a deletion that did not happen.
    renderView({
      call: { ...CALL, conversation_log: null, analysis_status: 'pending', call_analysis: null },
      analysisMessages: { pending: "We're listening to the call." },
    });

    expect(screen.queryByTestId('transcript-purged')).toBeNull();
    expect(screen.getByText("We're listening to the call.")).toBeTruthy();
  });

  it('hides the whole analysis family when the product has no analytics entitlement', () => {
    renderView({ analysisEnabled: false, call: { ...CALL, conversation_log: null } });

    expect(screen.queryByTestId('transcript-purged')).toBeNull();
    expect(screen.queryByText('Call summary')).toBeNull();
    expect(screen.queryByText('Call Analysis')).toBeNull();
  });
});
