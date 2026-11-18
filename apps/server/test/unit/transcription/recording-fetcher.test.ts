/*
 * Covers: no auth headers on an allow-listed host; off-list host, lookalike
 * hosts (suffix, userinfo, path, query), http scheme, empty list and unparseable URL
 * are permanent failures that never reach `fetch`; the mimeType assertion. Every other case runs against an allow-listed host.
 * B21: a BYOC fetch's headers go to the first URL only, and `exactHosts` refuses subdomains.
 * Plivo's real access (PL6 as amended 2026-11-18): the analysis worker fetches a regional
 * media host (`aps1.media.plivo.com`) with the credential, and refuses `api.plivo.com`,
 * `evilmedia.plivo.com` and lookalikes permanently, without a request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  trackRecordingFetchFailure: track,
}));

const { fetchRecordingBytes } = await import('../../../src/transcription/recording-fetcher.js');
const { createRecordingAccessResolver } = await import('../../../src/telephony/recording-access.js');
const { Secret } = await import('../../../src/telephony/credentials/secret.js');

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

describe('fetchRecordingBytes — a BYOC credential (B21)', () => {
  const origFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });
  const PLIVO = 'https://media.plivo.com/v1/Account/MA1/Recording/r.mp3';
  const BYOC = { maxBytes: 1000, timeoutMs: 5000, allowedHosts: ['media.plivo.com'], headers: { Authorization: 'Basic abc' }, exactHosts: true };
  const authOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('authorization');

  it('sends the headers to the first URL, with the timeout signal', async () => {
    (global.fetch as any).mockResolvedValueOnce(streamResponse([Buffer.from('a')], { contentType: 'audio/mpeg' }));
    await fetchRecordingBytes(PLIVO, BYOC);
    const call = (global.fetch as any).mock.calls[0];
    expect(authOf(call)).toBe('Basic abc');
    expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('never sends them past a redirect: the hop carries no Authorization', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(redirect(`${PLIVO}?v=2`))
      .mockResolvedValueOnce(streamResponse([], { status: 401 }));
    await expect(fetchRecordingBytes(PLIVO, BYOC)).rejects.toMatchObject({ retryable: false });
    const calls = (global.fetch as any).mock.calls;
    expect(calls).toHaveLength(2);
    expect(authOf(calls[0])).toBe('Basic abc');
    expect(authOf(calls[1])).toBeNull();
  });

  it('with exactHosts refuses a subdomain of the recording host without fetching (permanent)', async () => {
    await expect(fetchRecordingBytes('https://x.media.plivo.com/r.mp3', BYOC)).rejects.toMatchObject({
      code: 'TRANSCRIPTION_FAILED', retryable: false,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("fetchRecordingBytes — Plivo's media hosts on the real access (PL6 as amended 2026-11-18)", () => {
  const origFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });
  const AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
  const BASIC = `Basic ${Buffer.from(`${AUTH_ID}:tok`).toString('base64')}`;
  const PATH = `/v1/Account/${AUTH_ID}/Recording/r-1.mp3`;

  /** The options the analysis runner builds from a Plivo call's access (`fetchRecording`). */
  async function plivoOpts() {
    const access = await createRecordingAccessResolver({
      voicelinkHosts: ['recordings.voicelink.test'],
      credentials: () => ({
        resolve: async (id: string) => ({
          id, tenantId: 't', provider: 'plivo', accountRef: AUTH_ID, publicConfig: {},
          version: 1, secret: new Secret({ auth_token: 'tok' }), previous: [],
        }),
      }),
    })({ provider: 'plivo', telephony_credential_id: 'cred-1', tenant_id: 't' });
    return {
      maxBytes: 1000, timeoutMs: 5000, provider: 'plivo',
      allowedHosts: access.allowedHosts, headers: access.headers,
      ...(access.exactHosts ? { exactHosts: true } : {}),
    };
  }
  const authOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('authorization');

  it.each([
    ['media.plivo.com', `https://media.plivo.com${PATH}`],
    ['aps1.media.plivo.com (refused on staging before the amendment)', `https://aps1.media.plivo.com${PATH}`],
    ['usw1.media.plivo.com', `https://usw1.media.plivo.com${PATH}`],
  ])('fetches %s with the credential on the first request', async (_l, url) => {
    (global.fetch as any).mockResolvedValueOnce(streamResponse([Buffer.from('a')], { contentType: 'audio/mpeg' }));
    await fetchRecordingBytes(url, await plivoOpts());
    expect((global.fetch as any).mock.calls[0][0]).toBe(url);
    expect(authOf((global.fetch as any).mock.calls[0])).toBe(BASIC);
  });

  it.each([
    ['api.plivo.com', `https://api.plivo.com/v1/Account/${AUTH_ID}/Call/`],
    ['plivo.com', `https://plivo.com${PATH}`],
    ['evilmedia.plivo.com', `https://evilmedia.plivo.com${PATH}`],
    ['media.plivo.com.evil.com', `https://media.plivo.com.evil.com${PATH}`],
    ['aps1.media.plivo.com.evil.com', `https://aps1.media.plivo.com.evil.com${PATH}`],
    ['the media host as userinfo', `https://media.plivo.com@evil.com${PATH}`],
    ['a regional host over http', `http://aps1.media.plivo.com${PATH}`],
  ])('refuses %s as a permanent failure, without a request', async (_l, url) => {
    await expect(fetchRecordingBytes(url, await plivoOpts())).rejects.toMatchObject({
      code: 'TRANSCRIPTION_FAILED', retryable: false, message: expect.stringContaining('allow-list'),
    });
    expect(global.fetch).not.toHaveBeenCalled();
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

// RC3: the analysis worker's failed fetches are counted with the playback proxy's reasons.
describe('fetchRecordingBytes — failures counted by reason (RC3)', () => {
  const origFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn(); track.mockClear(); });
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  it.each([
    [401, 'upstream_unauthorized'],
    [404, 'upstream_not_found'],
    [500, 'upstream_status'],
  ] as const)('a %i is counted as %s for the call\'s provider', async (status, reason) => {
    (global.fetch as any).mockResolvedValueOnce(streamResponse([], { status }));
    await expect(fetchRecordingBytes(URL_OK, { ...OPTS, provider: 'voicelink' })).rejects.toBeTruthy();
    expect(track).toHaveBeenCalledWith('voicelink', 'analysis', reason);
  });

  it('an off-list host is host_not_allowed; a refused redirect is redirect_refused', async () => {
    await expect(fetchRecordingBytes('https://evil.example/x.mp3', { ...OPTS, provider: 'voicelink' })).rejects.toBeTruthy();
    expect(track).toHaveBeenLastCalledWith('voicelink', 'analysis', 'host_not_allowed');
    (global.fetch as any).mockResolvedValueOnce(redirect('https://evil.example/x.mp3'));
    await expect(fetchRecordingBytes(URL_OK, { ...OPTS, provider: 'voicelink' })).rejects.toBeTruthy();
    expect(track).toHaveBeenLastCalledWith('voicelink', 'analysis', 'redirect_refused');
  });

  it('no provider given: nothing is counted', async () => {
    (global.fetch as any).mockResolvedValueOnce(streamResponse([], { status: 500 }));
    await expect(fetchRecordingBytes(URL_OK, OPTS)).rejects.toBeTruthy();
    expect(track).not.toHaveBeenCalled();
  });
});
