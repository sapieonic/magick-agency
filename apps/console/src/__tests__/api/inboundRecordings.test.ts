import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Uploading and deleting the account's recordings for inbound routes (`docs/inbound.md` §8.4) as
 * the console calls them: the multipart body (the name before the file: the server reads the
 * fields that precede it), the path and method, and the refusals read into a `RecordingRefusal`
 * (why an upload was refused, which routes hold a recording) — through the real `apiFetch` for
 * the delete, so a status and a body become the same error the console sees in production.
 */

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null, signOut: vi.fn() }) }));
vi.mock('../../api/authHeaders', () => ({ buildAuthHeaders: async () => ({ 'X-Tenant-Id': 't-1', 'X-Account-Id': 'a-1' }) }));

import {
  deleteInboundRecording,
  fetchRecordingBlobUrl,
  recordingAudioUrl,
  uploadInboundRecording,
} from '../../api/inboundRecordings';

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => (body === undefined ? Promise.reject(new Error('no body')) : body),
  } as unknown as Response;
}

const CLIP = { id: 'clip-1', name: 'Welcome', duration_seconds: 4.2, created_at: '2026-11-09T10:00:00Z', routes: [] };

beforeEach(() => {
  mocks.fetch.mockReset();
});

describe('uploadInboundRecording', () => {
  it('POSTs multipart to /proxy/agency/inbound/clips, the name first, and answers the clip', async () => {
    mocks.fetch.mockResolvedValue(respond(201, { clip: CLIP }));
    const file = new File(['RIFF'], 'welcome.wav', { type: 'audio/wav' });
    const result = await uploadInboundRecording(file, '  Welcome  ', 't-1', 'a-1');
    expect(result).toEqual({ ok: true, value: CLIP });
    const [url, init] = mocks.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/proxy/agency/inbound/clips');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['name', 'file']);
    expect(form.get('name')).toBe('Welcome');
    expect((form.get('file') as File).name).toBe('welcome.wav');
    // No JSON content type: the browser sets the multipart boundary.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('sends no name field when none is given (the server names it from the file)', async () => {
    mocks.fetch.mockResolvedValue(respond(201, { clip: CLIP }));
    await uploadInboundRecording(new File(['x'], 'a.mp3'), '   ', 't-1', 'a-1');
    expect([...(mocks.fetch.mock.calls[0]![1] as RequestInit).body as FormData].map(([k]) => k)).toEqual(['file']);
  });

  it('reads why an upload was refused', async () => {
    mocks.fetch.mockResolvedValue(respond(400, {
      error: 'Bad Request', code: 'inbound_clip_invalid', message: 'The recording is longer than 2 minutes.', upload_reason: 'too_long',
    }));
    const result = await uploadInboundRecording(new File(['x'], 'long.mp3'), '', 't-1', 'a-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toMatchObject({ code: 'inbound_clip_invalid', status: 400, uploadReason: 'too_long', routes: [] });
  });

  it('a 413 with no body of ours (the size limit answered first) reads as too large', async () => {
    mocks.fetch.mockResolvedValue(respond(413, undefined));
    const result = await uploadInboundRecording(new File(['x'], 'big.wav'), '', 't-1', 'a-1');
    expect(!result.ok && result.refusal.uploadReason).toBe('too_large');
  });

  it('a network failure is a refusal, not a throw', async () => {
    mocks.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await uploadInboundRecording(new File(['x'], 'a.wav'), '', 't-1', 'a-1');
    expect(!result.ok && result.refusal.code).toBe('unknown');
  });
});

describe('deleteInboundRecording', () => {
  it('DELETEs /proxy/agency/inbound/clips/:id', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, status: 204, headers: new Headers(), json: async () => undefined } as unknown as Response);
    expect(await deleteInboundRecording('clip 1', 't-1', 'a-1')).toEqual({ ok: true, value: undefined });
    const [url, init] = mocks.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/proxy/agency/inbound/clips/clip%201');
    expect(init.method).toBe('DELETE');
  });

  it('reads the routes a recording in use is held by', async () => {
    mocks.fetch.mockResolvedValue(respond(409, {
      error: 'Conflict', code: 'inbound_clip_in_use', message: 'x',
      routes: [{ route_id: 'r-1', name: 'Main line' }, { route_id: 7, name: 'bad' }],
    }));
    const result = await deleteInboundRecording('clip-1', 't-1', 'a-1');
    expect(!result.ok && result.refusal).toMatchObject({ code: 'inbound_clip_in_use', status: 409, routes: [{ route_id: 'r-1', name: 'Main line' }] });
  });
});

describe('fetchRecordingBlobUrl (the editor’s preview)', () => {
  it('asks our own API for the account’s recording or our standard one, the id encoded, with the console’s headers', () => {
    expect(recordingAudioUrl({ kind: 'uploaded', clipId: 'clip-1' })).toBe('/proxy/agency/inbound/clips/clip-1/audio');
    expect(recordingAudioUrl({ kind: 'uploaded', clipId: '../x?y' })).toBe('/proxy/agency/inbound/clips/..%2Fx%3Fy/audio');
    expect(recordingAudioUrl({ kind: 'standard', recording: 'closed' })).toBe('/proxy/agency/inbound/clips/standard/closed/audio');
  });

  it('plays from a blob URL, and says plainly when the recording is gone or could not load', async () => {
    const original = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:rec-1');
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response);
    try {
      expect(await fetchRecordingBlobUrl({ kind: 'standard', recording: 'busy' }, 't-1', 'a-1')).toEqual({ status: 'ready', url: 'blob:rec-1' });
    } finally {
      URL.createObjectURL = original;
    }
    const [url, init] = mocks.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/proxy/agency/inbound/clips/standard/busy/audio');
    expect(init.headers).toEqual({ 'X-Tenant-Id': 't-1', 'X-Account-Id': 'a-1' });

    mocks.fetch.mockResolvedValue({ ok: false, status: 404, url: '', headers: new Headers() } as unknown as Response);
    expect(await fetchRecordingBlobUrl({ kind: 'uploaded', clipId: 'clip-1' }, 't-1', 'a-1')).toEqual({
      status: 'unavailable', message: 'This recording no longer exists. Someone may have deleted it.',
    });
    mocks.fetch.mockResolvedValue({ ok: false, status: 503, url: '', headers: new Headers() } as unknown as Response);
    expect(await fetchRecordingBlobUrl({ kind: 'uploaded', clipId: 'clip-1' }, 't-1', 'a-1')).toEqual({
      status: 'unavailable', message: 'We couldn’t load the recording. Try again in a moment.',
    });
    mocks.fetch.mockRejectedValue(new Error('offline'));
    expect((await fetchRecordingBlobUrl({ kind: 'uploaded', clipId: 'clip-1' }, 't-1')).status).toBe('unavailable');
  });
});
