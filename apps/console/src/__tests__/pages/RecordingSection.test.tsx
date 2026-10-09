import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

/**
 * RecordingSection — provider-aware playback wiring.
 *
 * Absolute `recording_url` (e.g. VoiceLink/Elision `https://…mp3`) plays
 * directly (no proxy fetch, no URL.revokeObjectURL on unmount). Relative
 * paths blob-fetch through `fetchRecordingBlobUrl` and revoke on unmount.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  fetchRecordingBlobUrl: vi.fn(),
  retryAnalysis: vi.fn(),
  createObjectURL: vi.fn(() => 'blob:created'),
  revokeObjectURL: vi.fn(),
}));

// CallDetailPage's context imports (Tenant/Governance/Metadata) all transitively
// import AuthContext, which calls firebase initializeApp() at module load — that
// throws `auth/invalid-api-key` in CI (no VITE_FIREBASE_API_KEY). Mock AuthContext
// so Firebase never initializes; the component under test doesn't use it directly.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ firebaseUser: { email: 'me@example.com' } }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/calls', () => ({
  fetchRecordingBlobUrl: mocks.fetchRecordingBlobUrl,
  retryAnalysis: mocks.retryAnalysis,
}));

// Lightweight stub — exposes the `src` prop so we can assert what got passed
// without needing a real AudioContext (jsdom/happy-dom lack Web Audio).
vi.mock('../../components/audio/AudioWaveform', () => ({
  AudioWaveform: ({ src }: { src: string }) => (
    <div data-testid="waveform" data-src={src} />
  ),
}));

vi.mock('../../components/common', () => ({
  LoadingSpinner: () => <span data-testid="spinner">loading</span>,
}));
vi.mock('../../components/common/ErrorText', () => ({
  ErrorText: ({ message }: { message: string }) => <span role="alert">{message}</span>,
}));

vi.stubGlobal(
  'URL',
  Object.assign(URL, {
    createObjectURL: mocks.createObjectURL,
    revokeObjectURL: mocks.revokeObjectURL,
  }),
);

import { RecordingSection } from '../../components/calls/CallDetailSections';

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.fetchRecordingBlobUrl.mockReset();
  mocks.revokeObjectURL.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('RecordingSection', () => {
  it('plays an absolute https URL directly without calling the proxy fetch', async () => {
    const url =
      'https://voiceflowai.elisiontec.com/voiceapp-recordings/client_1150/2026-07-11/abc.mp3';

    render(<RecordingSection callId="call-1" recordingUrl={url} />);

    const waveform = await screen.findByTestId('waveform');
    expect(waveform.getAttribute('data-src')).toBe(url);
    expect(mocks.fetchRecordingBlobUrl).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spinner')).toBeNull();
  });

  it('plays an absolute http URL directly (regex matches http too)', async () => {
    const url = 'http://legacy.example.com/recording.mp3';

    render(<RecordingSection callId="call-2" recordingUrl={url} />);

    const waveform = await screen.findByTestId('waveform');
    expect(waveform.getAttribute('data-src')).toBe(url);
    expect(mocks.fetchRecordingBlobUrl).not.toHaveBeenCalled();
  });

  it('opens a direct provider link in a new tab (cross-origin `download` is ignored)', async () => {
    const url = 'https://voiceflowai.elisiontec.com/rec.mp3';

    render(<RecordingSection callId="call-3" recordingUrl={url} />);

    const dl = await screen.findByRole('link', { name: /Download/i });
    expect(dl.getAttribute('href')).toBe(url);
    // Without this the browser ignores `download` on a cross-origin href and
    // navigates, unmounting the SPA to render the audio file.
    expect(dl.getAttribute('target')).toBe('_blank');
    expect(dl.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps a proxied blob download in-tab (same-origin `download` is honoured)', async () => {
    mocks.fetchRecordingBlobUrl.mockResolvedValue('blob:mock-456');

    render(<RecordingSection callId="call-4" recordingUrl="/api/v1/calls/call-4/recording" />);

    const dl = await screen.findByRole('link', { name: /Download/i });
    expect(dl.getAttribute('href')).toBe('blob:mock-456');
    expect(dl.getAttribute('download')).toBe('recording_call-4.wav');
    expect(dl.getAttribute('target')).toBeNull();
    expect(dl.getAttribute('rel')).toBeNull();
  });

  it('does NOT revoke the URL on unmount when playing an absolute URL', () => {
    const url = 'https://voiceflowai.elisiontec.com/rec.mp3';
    const { unmount } = render(<RecordingSection callId="c" recordingUrl={url} />);
    unmount();
    expect(mocks.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('blob-fetches through the API for a relative proxy path', async () => {
    mocks.fetchRecordingBlobUrl.mockResolvedValue('blob:mock-123');

    render(
      <RecordingSection callId="call-1" recordingUrl="/api/v1/calls/call-1/recording" />,
    );

    await waitFor(() => {
      expect(mocks.fetchRecordingBlobUrl).toHaveBeenCalledWith(
        'tenant-1',
        'call-1',
        'account-1',
      );
    });
    const waveform = await screen.findByTestId('waveform');
    expect(waveform.getAttribute('data-src')).toBe('blob:mock-123');
  });

  it('revokes the object URL on unmount for the relative (blob) path', async () => {
    mocks.fetchRecordingBlobUrl.mockResolvedValue('blob:mock-xyz');

    const { unmount } = render(
      <RecordingSection callId="call-1" recordingUrl="/api/v1/calls/call-1/recording" />,
    );

    await screen.findByTestId('waveform');
    unmount();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:mock-xyz');
  });

  it('renders "Recording not available." when the proxy fetch resolves null', async () => {
    mocks.fetchRecordingBlobUrl.mockResolvedValue(null as unknown as string);

    render(
      <RecordingSection callId="call-1" recordingUrl="/api/v1/calls/call-1/recording" />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Recording not available/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('waveform')).toBeNull();
  });

  it('shows an error state when the proxy fetch throws', async () => {
    mocks.fetchRecordingBlobUrl.mockRejectedValue(new Error('boom'));

    render(
      <RecordingSection callId="call-1" recordingUrl="/api/v1/calls/call-1/recording" />,
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Failed to load recording/i);
    expect(screen.queryByTestId('waveform')).toBeNull();
  });
});
