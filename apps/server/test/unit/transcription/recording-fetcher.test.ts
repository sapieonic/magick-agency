/*
 * PORT NOTE (magick-agency): ported from core test/unit/transcription/recording-fetcher.test.ts
 * @4850d1d9 (10 cases) and REWORKED with the fetcher (plan §4). Deleted: "selects
 * VoBiz auth headers", "selects Twilio Basic auth headers" (carrier credentials are
 * gone). Added: no auth headers on an allow-listed host; off-list host, lookalike
 * hosts (suffix, userinfo, path, query), http scheme, empty list and unparseable URL
 * are permanent failures that never reach `fetch`; the mimeType assertion the Twilio
 * case carried. Every other case runs unchanged against an allow-listed host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { fetchRecordingBytes } = await import('../../../src/transcription/recording-fetcher.js');

const HOSTS = ['recordings.voicelink.test'] as const;
const OPTS = { maxBytes: 1000, timeoutMs: 5000, allowedHosts: HOSTS };
const URL_OK = 'https://recordings.voicelink.test/abc.mp3';

/** Build a mock Response whose body streams `chunks` (each a Buffer) via a getReader(). */
function streamResponse(
  chunks: Buffer[],
  opts: { status?: number; contentType?: string; contentLength?: string } = {},
): Response {
  let i = 0;
  let cancelled = false;
  const reader = {
    read: async () => {
      if (cancelled || i >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: new Uint8Array(chunks[i++]!) };
    },
    cancel: async () => {
      cancelled = true;
    },
  };
  const headers = new Map<string, string>();
  if (opts.contentType) headers.set('content-type', opts.contentType);
  if (opts.contentLength) headers.set('content-length', opts.contentLength);
  return {
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: { getReader: () => reader },
    text: async () => '',
  } as unknown as Response;
}

function redirect(location: string | null, status = 302): Response {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) },
    body: null,
  } as unknown as Response;
}

describe('fetchRecordingBytes — redirects (SSRF)', () => {
  const origFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  it('fetches with redirect: manual, never the default follow', async () => {
    (global.fetch as any).mockResolvedValueOnce(streamResponse([Buffer.from('a')], { contentType: 'audio/mpeg' }));
    await fetchRecordingBytes(URL_OK, OPTS);
    expect((global.fetch as any).mock.calls[0][1].redirect).toBe('manual');
  });

  it('follows an allowed -> allowed redirect (absolute and relative Location)', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(redirect('https://eu.recordings.voicelink.test/moved.mp3', 301))
      .mockResolvedValueOnce(redirect('/final.mp3', 307))
      .mockResolvedValueOnce(streamResponse([Buffer.from('audio')], { contentType: 'audio/mpeg' }));
    const result = await fetchRecordingBytes(URL_OK, OPTS);
    expect(result.bytes.toString()).toBe('audio');
    const urls = (global.fetch as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(urls).toEqual([URL_OK, 'https://eu.recordings.voicelink.test/moved.mp3', 'https://eu.recordings.voicelink.test/final.mp3']);
  });

  it.each([
    ['an internal address', 'http://169.254.169.254/latest/meta-data/'],
    ['an https internal address', 'https://169.254.169.254/latest/meta-data/'],
    ['localhost on the DB port', 'https://localhost:5436/'],
    ['an off-list public host', 'https://evil.example/x.mp3'],
    ['an http downgrade of the allowed host', 'http://recordings.voicelink.test/x.mp3'],
    ['a userinfo trick', 'https://recordings.voicelink.test@evil.example/x.mp3'],
  ])('refuses an allowed -> %s redirect as a permanent failure, without following it', async (_l, loc) => {
    (global.fetch as any).mockResolvedValueOnce(redirect(loc));
    await expect(fetchRecordingBytes(URL_OK, OPTS)).rejects.toMatchObject({
      code: 'TRANSCRIPTION_FAILED',
      retryable: false,
      message: expect.stringContaining('allow-list'),
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect loop past the 3-hop cap (permanent)', async () => {
    (global.fetch as any).mockImplementation(async () => redirect(URL_OK));
    await expect(fetchRecordingBytes(URL_OK, OPTS)).rejects.toMatchObject({
      code: 'TRANSCRIPTION_FAILED',
      retryable: false,
      message: expect.stringContaining('redirects'),
    });
    expect(global.fetch).toHaveBeenCalledTimes(4); // the first URL + 3 hops
  });

  it('a redirect status without a Location is just a non-2xx response', async () => {
    (global.fetch as any).mockResolvedValueOnce(redirect(null));
    await expect(fetchRecordingBytes(URL_OK, OPTS)).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
  });
});

describe('fetchRecordingBytes', () => {
  const origFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('fetches an allow-listed host with NO credentials', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      streamResponse([Buffer.from('audio')], { contentType: 'audio/wav' }),
    );
    const result = await fetchRecordingBytes(URL_OK, OPTS);

    const init = (global.fetch as any).mock.calls[0][1] as { headers?: Record<string, string> };
    expect(init.headers).toBeUndefined();
    expect(result.mimeType).toBe('audio/wav');
  });

  it('accepts a subdomain of an allow-listed domain', async () => {
    (global.fetch as any).mockResolvedValueOnce(streamResponse([Buffer.from('audio')], { contentType: 'audio/mpeg' }));
    await fetchRecordingBytes('https://eu.recordings.voicelink.test/a.mp3', OPTS);
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['an unlisted host', 'https://evil.example/abc.mp3'],
    ['a suffix lookalike', 'https://recordings.voicelink.test.evil.example/abc.mp3'],
    ['a prefix lookalike', 'https://xrecordings.voicelink.test/abc.mp3'],
    ['the host in the userinfo position', 'https://recordings.voicelink.test@evil.example/abc.mp3'],
    ['the host in the path', 'https://evil.example/recordings.voicelink.test/abc.mp3'],
    ['the host in the query', 'https://evil.example/a.mp3?u=recordings.voicelink.test'],
    ['an http (cleartext) URL', 'http://recordings.voicelink.test/abc.mp3'],
    ['an unparseable URL', 'not a url'],
  ])('refuses %s as a permanent failure, without fetching', async (_label, url) => {
    await expect(fetchRecordingBytes(url, OPTS)).rejects.toMatchObject({
      code: 'TRANSCRIPTION_FAILED',
      retryable: false,
      message: expect.stringContaining('allow-list'),
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('an empty allow-list refuses everything (fail closed)', async () => {
    await expect(
      fetchRecordingBytes(URL_OK, { ...OPTS, allowedHosts: [] }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED', retryable: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('aborts mid-stream once maxBytes is exceeded (never buffers past the cap)', async () => {
    // Three 4-byte chunks = 12 bytes, cap is 6 → aborts after the 2nd chunk.
    (global.fetch as any).mockResolvedValueOnce(
      streamResponse([Buffer.from('aaaa'), Buffer.from('bbbb'), Buffer.from('cccc')], { contentType: 'audio/mpeg' }),
    );
    await expect(
      fetchRecordingBytes('https://recordings.voicelink.test/big.mp3', { ...OPTS, maxBytes: 6 }),
    ).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE', retryable: false });
  });

  it('rejects up front when Content-Length already exceeds the cap', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      streamResponse([Buffer.from('x')], { contentType: 'audio/mpeg', contentLength: '999999' }),
    );
    await expect(
      fetchRecordingBytes('https://recordings.voicelink.test/big.mp3', { ...OPTS, maxBytes: 100 }),
    ).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE', retryable: false });
  });

  it.each([401, 403, 404])('marks %i non-retryable', async (status) => {
    (global.fetch as any).mockResolvedValueOnce(streamResponse([], { status }));
    await expect(
      fetchRecordingBytes('https://recordings.voicelink.test/x.mp3', OPTS),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED', retryable: false });
  });

  it('marks a 500 retryable', async () => {
    (global.fetch as any).mockResolvedValueOnce(streamResponse([], { status: 500 }));
    await expect(
      fetchRecordingBytes('https://recordings.voicelink.test/x.mp3', OPTS),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED', retryable: true });
  });

  it('maps a fetch timeout (TimeoutError) to TIMEOUT', async () => {
    (global.fetch as any).mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(
      fetchRecordingBytes('https://recordings.voicelink.test/x.mp3', { ...OPTS, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('infers mimeType from the URL extension when Content-Type is octet-stream', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      streamResponse([Buffer.from('audio')], { contentType: 'application/octet-stream' }),
    );
    const result = await fetchRecordingBytes('https://recordings.voicelink.test/clip.wav', OPTS);
    expect(result.mimeType).toBe('audio/wav');
    expect(result.bytes.toString()).toBe('audio');
  });
});
