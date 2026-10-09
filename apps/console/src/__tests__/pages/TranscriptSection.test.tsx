import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * TranscriptSection — per-user show/hide preference.
 *
 * The toggle is a pure display preference persisted in localStorage (no backend):
 * off hides the transcript body and suppresses playback auto-scroll (there is no
 * rendered turn to scroll to). The stored choice is honored on mount so the user
 * is never asked again, and the toggle stays reachable in every state.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  fetchRecordingBlobUrl: vi.fn(),
  retryAnalysis: vi.fn(),
  scrollIntoView: vi.fn(),
}));

// CallDetailSections' imports transitively pull in AuthContext, which calls
// firebase initializeApp() at module load — that throws `auth/invalid-api-key`
// in CI (no VITE_FIREBASE_API_KEY). Mock it so Firebase never initializes.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ firebaseUser: { email: 'me@example.com' } }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/calls', () => ({
  fetchRecordingBlobUrl: mocks.fetchRecordingBlobUrl,
  retryAnalysis: mocks.retryAnalysis,
}));
vi.mock('../../components/audio/AudioWaveform', () => ({
  AudioWaveform: ({ src }: { src: string }) => <div data-testid="waveform" data-src={src} />,
}));
vi.mock('../../components/common', () => ({
  LoadingSpinner: () => <span data-testid="spinner">loading</span>,
}));
vi.mock('../../components/common/ErrorText', () => ({
  ErrorText: ({ message }: { message: string }) => <span role="alert">{message}</span>,
}));

import { TranscriptSection } from '../../components/calls/CallDetailSections';
import { loadTranscriptVisible } from '../../utils/transcript-prefs';

const STORAGE_KEY = 'magick-agency-transcript-visible'; // B17 rename (cusui: `magickvoice-transcript-visible`)

const ENTRIES = [
  { role: 'assistant' as const, content: 'Hello, am I speaking with Alex?', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'user' as const, content: 'Yes, speaking.', timestamp: '2026-01-01T00:00:05.000Z' },
];

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 't_1', accountId: 'a_1' });
  localStorage.clear();
  // jsdom/happy-dom don't implement scrollIntoView.
  Element.prototype.scrollIntoView = mocks.scrollIntoView;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('TranscriptSection visibility preference', () => {
  it('shows the transcript by default when no preference is stored', () => {
    render(<TranscriptSection entries={ENTRIES} />);

    expect(screen.getByText('Yes, speaking.')).toBeTruthy();
    expect(screen.getByLabelText(/show transcript/i)).toBeTruthy();
  });

  it('hides the transcript body when the toggle is turned off, and persists it', () => {
    render(<TranscriptSection entries={ENTRIES} />);

    fireEvent.click(screen.getByLabelText(/show transcript/i));

    expect(screen.queryByText('Yes, speaking.')).toBeNull();
    expect(screen.getByText(/transcript hidden/i)).toBeTruthy();
    // Persisted so the user is not asked again.
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
    expect(loadTranscriptVisible()).toBe(false);
  });

  it('honors a stored "hidden" preference on mount (no flash of content)', () => {
    localStorage.setItem(STORAGE_KEY, 'false');

    render(<TranscriptSection entries={ENTRIES} />);

    expect(screen.queryByText('Yes, speaking.')).toBeNull();
    expect(screen.getByText(/transcript hidden/i)).toBeTruthy();
  });

  it('re-renders the transcript when toggled back on', () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    render(<TranscriptSection entries={ENTRIES} />);

    fireEvent.click(screen.getByLabelText(/show transcript/i));

    expect(screen.getByText('Yes, speaking.')).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('suppresses playback auto-scroll while hidden, and scrolls when shown', () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    const { rerender } = render(<TranscriptSection entries={ENTRIES} activeIndex={1} />);

    // Hidden: nothing rendered to scroll to.
    expect(mocks.scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText(/show transcript/i));
    rerender(<TranscriptSection entries={ENTRIES} activeIndex={1} />);

    expect(mocks.scrollIntoView).toHaveBeenCalled();
  });

  it('keeps the toggle reachable when there are no entries', () => {
    render(<TranscriptSection entries={[]} />);

    expect(screen.getByLabelText(/show transcript/i)).toBeTruthy();
    expect(screen.getByText(/no conversation entries recorded/i)).toBeTruthy();
  });

  it('falls back to visible when localStorage throws (private mode)', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    render(<TranscriptSection entries={ENTRIES} />);
    expect(screen.getByText('Yes, speaking.')).toBeTruthy();

    // Toggling still works in-session even though persistence fails.
    expect(() => fireEvent.click(screen.getByLabelText(/show transcript/i))).not.toThrow();
    expect(screen.getByText(/transcript hidden/i)).toBeTruthy();

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
