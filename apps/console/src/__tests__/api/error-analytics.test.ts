import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackApiErrorEvent: vi.fn(),
  fetch: vi.fn(),
  currentUser: null as { getIdToken: () => Promise<string> } | null,
}));

vi.mock('../../analytics/events', () => ({
  trackApiErrorEvent: mocks.trackApiErrorEvent,
}));

vi.stubGlobal('fetch', mocks.fetch);

vi.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: mocks.currentUser }),
}));

/*
 * PORT NOTE (magick-agency): `safeAnalyticsPath` (4) and `captureApiError` (1)
 * are verbatim. The `raw fetch integrations` describe (3) is DELETED: it drove
 * the contact-list upload, audio-file upload and CSV-export downloader, AI-product
 * modules that are not ported.
 */
import { safeAnalyticsPath, captureApiError } from '../../api/error-analytics';

function fakeResponse(status: number, requestId?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (requestId) headers.set('x-request-id', requestId);
  return new Response(JSON.stringify({ message: 'nope' }), { status, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('safeAnalyticsPath', () => {
  it('drops origin and query string', () => {
    expect(safeAnalyticsPath('https://host/proxy/calls?phone=+91999')).toBe('/proxy/calls');
  });

  it('replaces UUID-like, numeric, email-like, and phone-like segments with :id', () => {
    expect(safeAnalyticsPath('https://host/proxy/calls/550e8400-e29b-41d4-a716-446655440000')).toBe('/proxy/calls/:id');
    expect(safeAnalyticsPath('/proxy/accounts/123456789012/usage')).toBe('/proxy/accounts/:id/usage');
    expect(safeAnalyticsPath('/proxy/users/test@example.com/reset')).toBe('/proxy/users/:id/reset');
    expect(safeAnalyticsPath('/proxy/calls/+14155551234/recording')).toBe('/proxy/calls/:id/recording');
  });

  it('replaces opaque resource id formats while preserving static route segments', () => {
    expect(safeAnalyticsPath('/proxy/accounts/507f1f77bcf86cd799439011/usage')).toBe('/proxy/accounts/:id/usage');
    expect(safeAnalyticsPath('/proxy/jobs/01ARZ3NDEKTSV4RRFFQ69G5FAV/events')).toBe('/proxy/jobs/:id/events');
    expect(safeAnalyticsPath('/proxy/users/ck8zqjk4a000001l5h9f3d7y4/profile')).toBe('/proxy/users/:id/profile');
    expect(safeAnalyticsPath('/proxy/messages/tz4a98xxat96iws9zmbrgj3a/status')).toBe('/proxy/messages/:id/status');
    expect(safeAnalyticsPath('/proxy/webrtc-call/conn_abc123/recording')).toBe('/proxy/webrtc-call/:id/recording');
    expect(safeAnalyticsPath('/proxy/files/dGhpcy1pc19hX3Rva2VuMTIzNDU2/download')).toBe('/proxy/files/:id/download');
  });

  it('preserves static route structure for normal path segments', () => {
    expect(safeAnalyticsPath('/proxy/contact-lists/template')).toBe('/proxy/contact-lists/template');
  });
});

describe('captureApiError', () => {
  it('tracks status, sanitized path, and optional request id', () => {
    captureApiError('/proxy/audio-files?name=x', fakeResponse(413, 'req_1'));

    expect(mocks.trackApiErrorEvent).toHaveBeenCalledWith({
      status: 413,
      path: '/proxy/audio-files',
      request_id: 'req_1',
    });
  });
});
