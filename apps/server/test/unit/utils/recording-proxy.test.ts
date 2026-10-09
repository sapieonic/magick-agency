import { describe, it, expect, vi, afterEach } from 'vitest';

/*
 * PORT NOTE (magick-agency): replaces core test/unit/utils/recording-proxy-byoc.test.ts
 * @4850d1d9 (30 cases), whose subject (per-carrier credentials, BYOC sources, the
 * credential seam) is deleted (plan §4). What carries over, rewritten against the
 * allow-list: the "HOST check, not a substring match" suite (the 8 hostile URLs, real
 * host, subdomain, case, unparseable) now asserts `recordingHostMatches`, and the
 * `proxyCallRecording` suite (404 without a recording, fetch) asserts no credentials
 * are attached and an off-list host is refused with 502 without fetching. The
 * Twilio / VoBiz / Plivo / Telnyx header cases, `resolveRecordingAuthSource` and the
 * `fetchRecordingBytes` credential case are deleted with their functions. New: Range
 * forwarding and the https-only rule.
 */
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { recordingHostMatches, recordingHostname, proxyCallRecording } = await import(
  '../../../src/utils/recording-proxy.js'
);

const HOSTS = ['voicelink.test'] as const;
const GOOD = 'https://recordings.voicelink.test/a/b.mp3';

describe('recording host matching is a HOST check, not a substring match', () => {
  // `recording_url` is persisted verbatim from the carrier's UNAUTHENTICATED
  // recording webhook, so the string inspected is attacker-chosen.
  const HOSTILE = [
    ['userinfo', 'https://voicelink.test@evil.example/rec.mp3'],
    ['userinfo with password', 'https://voicelink.test:x@evil.example/rec.mp3'],
    ['path segment', 'https://evil.example/voicelink.test/rec.mp3'],
    ['query string', 'https://evil.example/rec.mp3?from=voicelink.test'],
    ['fragment', 'https://evil.example/rec.mp3#voicelink.test'],
    ['subdomain suffix', 'https://voicelink.test.evil.example/rec.mp3'],
    ['prefix', 'https://notvoicelink.test/rec.mp3'],
    ['http scheme', 'http://recordings.voicelink.test/rec.mp3'],
  ] as const;

  for (const [label, url] of HOSTILE) {
    it(`refuses an attacker host smuggled via the ${label}`, () => {
      expect(recordingHostMatches(url, HOSTS)).toBe(false);
    });
  }

  it('accepts the real host, its apex and a subdomain', () => {
    expect(recordingHostMatches(GOOD, HOSTS)).toBe(true);
    expect(recordingHostMatches('https://voicelink.test/x.mp3', HOSTS)).toBe(true);
    expect(recordingHostMatches('https://eu.recordings.voicelink.test/x.mp3', HOSTS)).toBe(true);
  });

  it('is case-insensitive on the host, as DNS is, and ignores a trailing dot', () => {
    expect(recordingHostMatches('https://RECORDINGS.VoiceLink.TEST/x.mp3', HOSTS)).toBe(true);
    expect(recordingHostMatches('https://recordings.voicelink.test./x.mp3', HOSTS)).toBe(true);
    expect(recordingHostMatches(GOOD, ['VOICELINK.TEST'])).toBe(true);
  });

  it('matches nothing for an unparseable URL, an empty string or an empty list', () => {
    expect(recordingHostMatches('not a url at all voicelink.test', HOSTS)).toBe(false);
    expect(recordingHostMatches('', HOSTS)).toBe(false);
    expect(recordingHostMatches(GOOD, [])).toBe(false);
    expect(recordingHostname('not a url')).toBeNull();
    expect(recordingHostname('http://a.example')).toBeNull();
  });
});

function reply() {
  const sent: { code?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const r: any = {
    code(c: number) { sent.code = c; return r; },
    send(b: unknown) { sent.body = b; return r; },
    header(k: string, v: string) { sent.headers[k] = v; return r; },
    sent,
  };
  return r;
}

afterEach(() => vi.unstubAllGlobals());

describe('proxyCallRecording', () => {
  it('404s a call with no recording before anything else', async () => {
    const r = reply();
    await proxyCallRecording({ id: 'c', recording_url: null }, { headers: {} } as any, r, HOSTS);
    expect(r.sent.code).toBe(404);
  });

  it('fetches an allow-listed recording with NO credentials and streams it', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, body: 'bytes',
      headers: { get: (k: string) => (k === 'content-type' ? 'audio/mpeg' : null) },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording({ id: 'c', recording_url: GOOD }, { headers: {} } as any, r, HOSTS);
    expect(fetchMock).toHaveBeenCalledWith(GOOD, { headers: {}, redirect: 'manual' });
    expect(r.sent.code).toBe(200);
    expect(r.sent.body).toBe('bytes');
    expect(r.sent.headers['Content-Type']).toBe('audio/mpeg');
  });

  it('forwards a Range header and surfaces the upstream 206', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false, status: 206, body: 'part',
      headers: { get: (k: string) => (k === 'content-range' ? 'bytes 0-3/10' : null) },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording({ id: 'c', recording_url: GOOD }, { headers: { range: 'bytes=0-3' } } as any, r, HOSTS);
    expect(fetchMock).toHaveBeenCalledWith(GOOD, { headers: { Range: 'bytes=0-3' }, redirect: 'manual' });
    expect(r.sent.code).toBe(206);
    expect(r.sent.headers['Content-Range']).toBe('bytes 0-3/10');
  });

  it.each([
    ['an off-list host', 'https://evil.example/x.mp3', HOSTS],
    ['a lookalike host', 'https://voicelink.test.evil.example/x.mp3', HOSTS],
    ['an empty allow-list', GOOD, [] as readonly string[]],
  ])('502s %s without fetching', async (_l, url, hosts) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording({ id: 'c', recording_url: url }, { headers: {} } as any, r, hosts);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(502);
  });

  it('502s when the carrier answers non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null } })));
    const r = reply();
    await proxyCallRecording({ id: 'c', recording_url: GOOD }, { headers: {} } as any, r, HOSTS);
    expect(r.sent.code).toBe(502);
  });

  it('502s when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    const r = reply();
    await proxyCallRecording({ id: 'c', recording_url: GOOD }, { headers: {} } as any, r, HOSTS);
    expect(r.sent.code).toBe(502);
  });
});

describe('proxyCallRecording — redirects (SSRF)', () => {
  const redirect = (location: string | null, status = 302) => ({
    ok: false, status, body: null,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) },
  });
  const ok = () => ({ ok: true, status: 200, body: 'bytes', headers: { get: () => null } });

  it('fetches with redirect: manual and follows an allowed -> allowed hop', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect('https://eu.recordings.voicelink.test/m.mp3'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording({ id: 'c', recording_url: GOOD }, { headers: {} } as any, r, HOSTS);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([GOOD, 'https://eu.recordings.voicelink.test/m.mp3']);
    expect(fetchMock.mock.calls.every((c) => (c[1] as RequestInit).redirect === 'manual')).toBe(true);
    expect(r.sent.code).toBe(200);
  });

  it.each([
    ['an internal address', 'https://169.254.169.254/latest/meta-data/'],
    ['localhost', 'https://localhost:5436/'],
    ['an off-list host', 'https://evil.example/x.mp3'],
    ['an http downgrade', 'http://recordings.voicelink.test/x.mp3'],
  ])('502s an allowed -> %s redirect without following it', async (_l, loc) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect(loc));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording({ id: 'c', recording_url: GOOD }, { headers: {} } as any, r, HOSTS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.sent.code).toBe(502);
  });

  it('502s a redirect loop past the 3-hop cap', async () => {
    const fetchMock = vi.fn(async () => redirect(GOOD));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording({ id: 'c', recording_url: GOOD }, { headers: {} } as any, r, HOSTS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(r.sent.code).toBe(502);
  });
});
