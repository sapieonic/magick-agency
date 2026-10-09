import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ORIGINATOR_HEADER, ORIGINATOR } from '../../config';

// Mock global fetch before importing the modules under test.
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  currentUser: null as { getIdToken: () => Promise<string> } | null,
}));

vi.stubGlobal('fetch', mocks.fetch);

vi.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: mocks.currentUser }),
}));

// Avoid PostHog side-effects during tests.
vi.mock('../../analytics/posthog', () => ({
  captureError: vi.fn(),
}));

// Blob-download helpers used by the raw-fetch endpoints touch these browser
// APIs; stub them so the modules under test run in happy-dom.
vi.stubGlobal('URL', Object.assign(URL, {
  createObjectURL: vi.fn(() => 'blob:mock'),
  revokeObjectURL: vi.fn(),
}));

Object.defineProperty(window, 'location', {
  value: { href: '' },
  writable: true,
});

/*
 * PORT NOTE (magick-agency): the apiFetch cases (3) and the recording-blob case
 * are verbatim. DELETED with the modules they exercised: the super-admin
 * `saFetch` / `saFetchRaw` cases (2 — super-admin is its own app), contact-list
 * upload and template download (2), audio-file upload (1) and the two CSV-export
 * downloader cases (2) — AI-product endpoints, not ported.
 */
import { apiFetch } from '../../api/client';
import { fetchRecordingBlobUrl } from '../../api/calls';

function okJson(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });
}

function headersOf(callIndex = 0): Record<string, string> {
  const [, opts] = mocks.fetch.mock.calls[callIndex]!;
  return (opts as RequestInit & { headers: Record<string, string> }).headers;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser = null;
  window.location.href = '';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('x-mgkvc-originator header', () => {
  it('is sent on apiFetch requests', async () => {
    mocks.fetch.mockResolvedValue(okJson());

    await apiFetch('/api/example');

    expect(headersOf()[ORIGINATOR_HEADER]).toBe(ORIGINATOR);
  });

  it('is sent alongside auth/tenant/account headers on apiFetch', async () => {
    mocks.currentUser = { getIdToken: () => Promise.resolve('tok') };
    mocks.fetch.mockResolvedValue(okJson());

    await apiFetch('/api/example', { method: 'POST', body: '{}' }, 'tenant-1', 'account-1');

    const headers = headersOf();
    expect(headers[ORIGINATOR_HEADER]).toBe(ORIGINATOR);
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['X-Tenant-Id']).toBe('tenant-1');
    expect(headers['X-Account-Id']).toBe('account-1');
  });

  it('callers cannot accidentally override it via options.headers', async () => {
    mocks.fetch.mockResolvedValue(okJson());

    await apiFetch('/api/example', { headers: { 'X-Custom': 'v' } });

    const headers = headersOf();
    expect(headers[ORIGINATOR_HEADER]).toBe(ORIGINATOR);
    expect(headers['X-Custom']).toBe('v');
  });

});

// The endpoints below bypass apiFetch and assemble their own headers for
// multipart/binary payloads, so each needs independent coverage.
describe('x-mgkvc-originator header — raw-fetch endpoints', () => {
  it('is sent on call-recording blob fetch', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(new Blob(['audio']), { status: 200 }),
    );

    await fetchRecordingBlobUrl('t1', 'call-1', 'a1');

    expect(headersOf()[ORIGINATOR_HEADER]).toBe(ORIGINATOR);
  });

});
