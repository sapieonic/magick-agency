import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The three recording fetchers of calls that can be on a tenant's own carrier account (the
 * attempt's, an inbound call's, a soft-phone call's) against the server's two answers
 * (docs/carriers.md CR12): bytes, made into a blob URL as before, or, for a call on a carrier
 * whose recordings are public, `200 { redirect_url }`, which they ask for by naming JSON in
 * `Accept` and hand back as the URL to play, with no blob. The outcome tracking is unchanged.
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  track: vi.fn(),
  createObjectURL: vi.fn(() => 'blob:made'),
}));

vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null, signOut: vi.fn() }) }));
vi.mock('../../analytics/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../analytics/events')>()),
  trackAgencyRecordingOutcome: mocks.track,
}));

import {
  fetchAgencyAttemptRecordingBlobUrl,
  fetchInboundCallRecordingBlobUrl,
  RECORDING_FETCH_ACCEPT,
} from '../../api/agencySpine';
import { fetchManualCallRecordingBlobUrl } from '../../api/softphone';

const CARRIER_URL = 'https://recordings.voicelink.example/a/b.mp3';

function response(status: number, contentType: string, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => body,
    blob: async () => new Blob(['ID3audio'], { type: contentType }),
  } as unknown as Response;
}

const FETCHERS = [
  ['the attempt’s recording', () => fetchAgencyAttemptRecordingBlobUrl('camp-1', 'att-1', 't1', 'a1'), /\/campaigns\/camp-1\/attempts\/att-1\/recording$/],
  ['an inbound call’s recording', () => fetchInboundCallRecordingBlobUrl('camp-1', 'call-1', 't1', 'a1'), /\/campaigns\/camp-1\/call-log\/inbound\/call-1\/recording$/],
  ['a soft-phone call’s recording', () => fetchManualCallRecordingBlobUrl('call-1', 't1', 'a1'), /\/softphone\/calls\/call-1\/recording$/],
] as const;

let originalCreate: typeof URL.createObjectURL | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  originalCreate = URL.createObjectURL;
  URL.createObjectURL = mocks.createObjectURL as unknown as typeof URL.createObjectURL;
});
afterEach(() => {
  if (originalCreate) URL.createObjectURL = originalCreate;
});

describe.each(FETCHERS)('%s', (_label, run, path) => {
  it('asks for JSON first in Accept, beside the auth headers', async () => {
    mocks.fetch.mockResolvedValue(response(200, 'audio/mpeg', null));
    await run();
    const [url, init] = mocks.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toMatch(path);
    expect((init.headers as Record<string, string>)['Accept']).toBe(RECORDING_FETCH_ACCEPT);
    expect(RECORDING_FETCH_ACCEPT.startsWith('application/json')).toBe(true);
  });

  it('plays the carrier’s own URL from { redirect_url }, making no blob, and tracks it as ok', async () => {
    mocks.fetch.mockResolvedValue(response(200, 'application/json; charset=utf-8', { redirect_url: CARRIER_URL }));
    expect(await run()).toEqual({ status: 'ready', url: CARRIER_URL, mimeType: null });
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('still makes a blob of the bytes, with their type', async () => {
    mocks.fetch.mockResolvedValue(response(200, 'audio/mpeg', null));
    expect(await run()).toEqual({ status: 'ready', url: 'blob:made', mimeType: 'audio/mpeg' });
    expect(mocks.createObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith({ status: 'ok' });
  });

  it.each([
    ['no redirect_url', {}],
    ['an http URL', { redirect_url: 'http://recordings.voicelink.example/a.mp3' }],
    ['a javascript: URL', { redirect_url: 'javascript:alert(1)' }],
  ])('a JSON answer with %s is not playable: unreachable, no blob', async (_l, body) => {
    mocks.fetch.mockResolvedValue(response(200, 'application/json', body));
    expect(await run()).toEqual({ status: 'unreachable' });
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith({ status: 'unreachable' });
  });

  it('a revoked credential’s 404 still reads as not recorded', async () => {
    mocks.fetch.mockResolvedValue(response(404, 'application/json', { error: 'Not Found', code: 'recording_unavailable' }));
    expect(await run()).toEqual({ status: 'not_recorded' });
    expect(mocks.track).toHaveBeenCalledWith({ status: 'not_recorded' });
  });
});
