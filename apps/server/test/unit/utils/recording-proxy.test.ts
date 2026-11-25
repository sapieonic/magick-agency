import { describe, it, expect, vi, afterEach } from 'vitest';

/*
 * Covers the recording proxy against the host allow-list: the "HOST check, not a
 * substring match" suite (hostile URLs, real host, subdomain, case, unparseable)
 * asserts `recordingHostMatches`, and the `proxyCallRecording` suite (404 without
 * a recording, fetch) asserts no credentials are attached and an off-list host is
 * refused with 502 without fetching. Also covers Range forwarding and the
 * https-only rule.
 *
 * B21 suites: a redirect hop never carries the first request's headers (Range
 * excepted), whoever the caller; a Plivo recording is proxied with Basic auth on hop 0
 * only, to Plivo's media hosts only (`media.plivo.com` and its regional subdomains such as
 * `aps1.media.plivo.com`, PL6 as amended 2026-11-18; never `api.plivo.com`); a revoked (or missing) credential refuses
 * playback with 404 before any fetch. The proxy runs on the real carrier table
 * (`createRecordingAccessResolver`), so the VoiceLink cases above also pin that
 * VoiceLink behaviour is unchanged by it.
 */
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { recordingHostMatches, recordingHostname, proxyCallRecording, fetchWithAllowedRedirects, acceptsJsonRedirect } = await import(
  '../../../src/utils/recording-proxy.js'
);
const { createRecordingAccessResolver } = await import('../../../src/telephony/recording-access.js');
const { CredentialUnavailableError } = await import('../../../src/telephony/credentials/credential-service.js');
const { Secret } = await import('../../../src/telephony/credentials/secret.js');

const HOSTS = ['voicelink.test'] as const;
const GOOD = 'https://recordings.voicelink.test/a/b.mp3';

const TENANT = 'ten-1';
const CRED = 'cred-1';
const AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
const AUTH_TOKEN = 'tok_abcdefghijklmnop';
const BASIC = `Basic ${Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString('base64')}`;
const PLIVO_URL = `https://media.plivo.com/v1/Account/${AUTH_ID}/Recording/r-1.mp3`;

/** A VoiceLink call row (the service's own account: no credential). */
const vl = (recording_url: string | null) => ({
  id: 'c', recording_url, provider: 'voicelink', telephony_credential_id: null, tenant_id: TENANT,
});
/** A Plivo call row pinned to the tenant's credential. */
const pl = (recording_url: string | null, credentialId: string | null = CRED) => ({
  id: 'c', recording_url, provider: 'plivo', telephony_credential_id: credentialId, tenant_id: TENANT,
});

/** A credential source holding one active Plivo credential (or refusing as revoked). */
function credentials(state: 'active' | 'revoked' = 'active') {
  return {
    resolve: vi.fn(async (id: string) => {
      if (state === 'revoked') throw new CredentialUnavailableError(id, 'status', 'revoked');
      return {
        id, tenantId: TENANT, provider: 'plivo', accountRef: AUTH_ID, publicConfig: { auth_id: AUTH_ID },
        version: 1, secret: new Secret({ auth_token: AUTH_TOKEN }), previous: [],
      };
    }),
  };
}

/** The real carrier table over `hosts` and a credential source. */
type CredentialSource = Awaited<ReturnType<Parameters<typeof createRecordingAccessResolver>[0]['credentials']>>;
const access = (hosts: readonly string[], creds: CredentialSource = credentials()) =>
  createRecordingAccessResolver({ voicelinkHosts: hosts, credentials: () => creds });

describe('recording host matching is a HOST check, not a substring match', () => {
  // `recording_url` is persisted unmodified from the carrier's UNAUTHENTICATED
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

  it('matches nothing for a host with an empty label, never a "subdomain"', () => {
    expect(recordingHostMatches('https://.voicelink.test/x.mp3', HOSTS)).toBe(false);
    expect(recordingHostMatches('https://eu..voicelink.test/x.mp3', HOSTS)).toBe(false);
    expect(recordingHostname('https://a..b.example/x')).toBeNull();
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
    await proxyCallRecording(vl(null), { headers: {} } as any, r, access(HOSTS));
    expect(r.sent.code).toBe(404);
  });

  it('fetches an allow-listed recording with NO credentials and streams it', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, body: 'bytes',
      headers: { get: (k: string) => (k === 'content-type' ? 'audio/mpeg' : null) },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(vl(GOOD), { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock).toHaveBeenCalledWith(GOOD, { headers: {}, redirect: 'manual', signal: expect.any(AbortSignal) });
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
    await proxyCallRecording(vl(GOOD), { headers: { range: 'bytes=0-3' } } as any, r, access(HOSTS));
    expect(fetchMock).toHaveBeenCalledWith(GOOD, { headers: { Range: 'bytes=0-3' }, redirect: 'manual', signal: expect.any(AbortSignal) });
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
    await proxyCallRecording(vl(url), { headers: {} } as any, r, access(hosts));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(502);
  });

  it('502s when the carrier answers non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null } })));
    const r = reply();
    await proxyCallRecording(vl(GOOD), { headers: {} } as any, r, access(HOSTS));
    expect(r.sent.code).toBe(502);
  });

  it('502s when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    const r = reply();
    await proxyCallRecording(vl(GOOD), { headers: {} } as any, r, access(HOSTS));
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
    await proxyCallRecording(vl(GOOD), { headers: {} } as any, r, access(HOSTS));
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
    await proxyCallRecording(vl(GOOD), { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.sent.code).toBe(502);
  });

  it('502s a redirect loop past the 3-hop cap', async () => {
    const fetchMock = vi.fn(async () => redirect(GOOD));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(vl(GOOD), { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(r.sent.code).toBe(502);
  });
});

describe('fetchWithAllowedRedirects — headers go to the first URL only (B21)', () => {
  const redirect = (location: string) => ({
    ok: false, status: 302, body: null,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) },
  });
  const ok = () => ({ ok: true, status: 200, body: 'bytes', headers: { get: () => null } });
  const headersOf = (init: unknown) => new Headers((init as RequestInit).headers);

  it('drops Authorization (and every other header but Range) on a redirect hop', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect('https://eu.recordings.voicelink.test/m.mp3'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    await fetchWithAllowedRedirects(GOOD, {
      headers: { Authorization: 'Basic c2VjcmV0', Cookie: 'k=v', Range: 'bytes=5-' },
    }, HOSTS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = headersOf(fetchMock.mock.calls[0]![1]);
    expect(first.get('authorization')).toBe('Basic c2VjcmV0');
    const hop = headersOf(fetchMock.mock.calls[1]![1]);
    expect(hop.get('authorization')).toBeNull();
    expect(hop.get('cookie')).toBeNull();
    // Range is the viewer's own seek offset: kept so seeking survives a redirect.
    expect(hop.get('range')).toBe('bytes=5-');
  });

  it('drops headers given as a Headers object or an entry list too', async () => {
    const shapes: NonNullable<RequestInit['headers']>[] =[new Headers({ authorization: 'Basic x' }), [['Authorization', 'Basic x']]];
    for (const headers of shapes) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(redirect('https://recordings.voicelink.test/m.mp3'))
        .mockResolvedValueOnce(ok());
      vi.stubGlobal('fetch', fetchMock);
      await fetchWithAllowedRedirects(GOOD, { headers }, HOSTS);
      expect(headersOf(fetchMock.mock.calls[1]![1]).get('authorization')).toBeNull();
    }
  });

  it('keeps the rest of init (the timeout signal) on every hop', async () => {
    const signal = AbortSignal.timeout(60_000);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect('https://recordings.voicelink.test/m.mp3'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    await fetchWithAllowedRedirects(GOOD, { signal, headers: { Authorization: 'x' } }, HOSTS);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).signal).toBe(signal);
  });

  it('with exactHosts refuses a subdomain of a listed host, on the first URL and on a hop', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect('https://x.media.plivo.com/r.mp3'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithAllowedRedirects('https://x.media.plivo.com/r.mp3', {}, ['media.plivo.com'], { exactHosts: true }))
      .rejects.toMatchObject({ name: 'RecordingHostRefusedError', hop: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fetchWithAllowedRedirects(PLIVO_URL, {}, ['media.plivo.com'], { exactHosts: true }))
      .rejects.toMatchObject({ name: 'RecordingHostRefusedError', hop: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('proxyCallRecording — a Plivo recording on the tenant credential (B21)', () => {
  const ok = (status = 200) => ({ ok: status < 300, status, body: 'bytes', headers: { get: () => null } });
  const headersOf = (init: unknown) => new Headers((init as RequestInit).headers);

  it('fetches media.plivo.com with Basic auth_id:auth_token resolved for recording', async () => {
    const creds = credentials();
    const fetchMock = vi.fn().mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(PLIVO_URL), { headers: { range: 'bytes=0-9' } } as any, r, access(HOSTS, creds));
    expect(creds.resolve).toHaveBeenCalledWith(CRED, 'recording');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(PLIVO_URL);
    const sent = headersOf(fetchMock.mock.calls[0]![1]);
    expect(sent.get('authorization')).toBe(BASIC);
    expect(sent.get('range')).toBe('bytes=0-9');
    expect(r.sent.code).toBe(200);
  });

  it('sends the credential on hop 0 only: a redirect hop (even back to the media host) carries none', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: 302, body: null,
        headers: { get: (k: string) => (k.toLowerCase() === 'location' ? `${PLIVO_URL}?v=2` : null) },
      })
      .mockResolvedValueOnce(ok(401));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(PLIVO_URL), { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchMock.mock.calls[0]![1]).get('authorization')).toBe(BASIC);
    expect(headersOf(fetchMock.mock.calls[1]![1]).get('authorization')).toBeNull();
    expect(r.sent.code).toBe(502);
  });

  it.each([
    ['aps1.media.plivo.com', `https://aps1.media.plivo.com/v1/Account/${AUTH_ID}/Recording/r-1.mp3`],
    ['usw1.media.plivo.com', `https://usw1.media.plivo.com/v1/Account/${AUTH_ID}/Recording/r-1.mp3`],
  ])('proxies a recording on the regional media host %s, Basic auth on hop 0 (staging refused aps1 before 2026-11-18)', async (_l, url) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(url), { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(url);
    expect(headersOf(fetchMock.mock.calls[0]![1]).get('authorization')).toBe(BASIC);
    expect(r.sent.code).toBe(200);
  });

  it('follows a redirect from media.plivo.com to a regional media host, without the credential', async () => {
    const regional = `https://aps1.media.plivo.com/v1/Account/${AUTH_ID}/Recording/r-1.mp3`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: 302, body: null,
        headers: { get: (k: string) => (k.toLowerCase() === 'location' ? regional : null) },
      })
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(PLIVO_URL), { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([PLIVO_URL, regional]);
    expect(headersOf(fetchMock.mock.calls[1]![1]).get('authorization')).toBeNull();
    expect(r.sent.code).toBe(200);
  });

  it.each([
    ['the REST API host', `https://api.plivo.com/v1/Account/${AUTH_ID}/Call/`],
    ['the apex', 'https://plivo.com/r.mp3'],
    ['a host ending in media.plivo.com without the dot', 'https://evilmedia.plivo.com/r.mp3'],
    ['the media host as a prefix of another domain', 'https://media.plivo.com.evil.com/r.mp3'],
    ['a regional host as a prefix of another domain', 'https://aps1.media.plivo.com.evil.com/r.mp3'],
    ['the media host as userinfo', 'https://media.plivo.com@evil.com/r.mp3'],
    ['a regional host over http', 'http://aps1.media.plivo.com/r.mp3'],
    ['a VoiceLink host', GOOD],
    ['an attacker host', 'https://evil.example/r.mp3'],
  ])('502s a Plivo recording_url on %s without fetching (the credential never leaves)', async (_l, url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(url), { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(502);
  });

  it('a revoked credential refuses playback with 404 recording_unavailable, before any fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(PLIVO_URL), { headers: {} } as any, r, access(HOSTS, credentials('revoked')));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(404);
    expect(r.sent.body).toMatchObject({ code: 'recording_unavailable' });
  });

  it('a Plivo call with no pinned credential is refused, never fetched on another account (B20)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const creds = credentials();
    const r = reply();
    await proxyCallRecording(pl(PLIVO_URL, null), { headers: {} } as any, r, access(HOSTS, creds));
    expect(creds.resolve).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(404);
  });

  it('an unknown provider is refused before any fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording({ ...vl(GOOD), provider: 'acme' }, { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(404);
  });

  it('502s (not 404) when the access resolver fails for another reason (a database error)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(PLIVO_URL), { headers: {} } as any, r, async () => { throw new Error('db down'); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(502);
  });
});

describe('proxyCallRecording — a VoiceLink call pinned to a tenant credential is redirected, not fetched (CR12)', () => {
  /** A VoiceLink call row pinned to the tenant's VoiceLink credential. */
  const vlPinned = (recording_url: string | null) => ({
    id: 'c', recording_url, provider: 'voicelink', telephony_credential_id: CRED, tenant_id: TENANT,
  });
  /** A credential source holding one VoiceLink credential, active or revoked. */
  function vlCredentials(state: 'active' | 'revoked' = 'active') {
    return {
      resolve: vi.fn(async (id: string) => {
        if (state === 'revoked') throw new CredentialUnavailableError(id, 'status', 'revoked');
        return {
          id, tenantId: TENANT, provider: 'voicelink', accountRef: 'tenant-user', publicConfig: { username: 'Tenant-User' },
          version: 1, secret: new Secret({ password: 'tenant-password' }), previous: [],
        };
      }),
    };
  }

  it('resolves the credential for recording, then answers 302 to the stored URL, no-store, fetching nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const creds = vlCredentials();
    const r = reply();
    await proxyCallRecording(vlPinned(GOOD), { headers: { range: 'bytes=0-9' } } as any, r, access(HOSTS, creds));
    expect(creds.resolve).toHaveBeenCalledWith(CRED, 'recording');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(302);
    expect(r.sent.headers).toEqual({ Location: GOOD, 'Cache-Control': 'no-store', Vary: 'Accept' });
    expect(JSON.stringify(r.sent)).not.toContain('tenant-password');
  });

  it('a revoked credential refuses it with 404 recording_unavailable: no redirect, no fetch (B21)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(vlPinned(GOOD), { headers: {} } as any, r, access(HOSTS, vlCredentials('revoked')));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(404);
    expect(r.sent.body).toMatchObject({ code: 'recording_unavailable' });
    expect(r.sent.headers['Location']).toBeUndefined();
  });

  it.each([
    ['an attacker host', 'https://evil.example/r.mp3'],
    ['a lookalike host', 'https://voicelink.test.evil.example/r.mp3'],
    ['the allowed host as userinfo', 'https://voicelink.test@evil.example/r.mp3'],
    ['http', 'http://recordings.voicelink.test/r.mp3'],
    ['a javascript: URL', 'javascript:alert(1)'],
  ])('a stored URL on %s is refused 502 as a fetch would be: no redirect', async (_l, url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(vlPinned(url), { headers: {} } as any, r, access(HOSTS, vlCredentials()));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(502);
    expect(r.sent.body).toMatchObject({ message: 'The recording is not hosted on an allowed carrier host' });
    expect(r.sent.headers['Location']).toBeUndefined();
  });

  it('with no VoiceLink hosts configured, nothing is redirected', async () => {
    const r = reply();
    await proxyCallRecording(vlPinned(GOOD), { headers: {} } as any, r, access([], vlCredentials()));
    expect(r.sent.code).toBe(502);
    expect(r.sent.headers['Location']).toBeUndefined();
  });

  it('a VoiceLink call on the service`s account that reaches the proxy is still fetched, as before', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: 'bytes', headers: { get: () => null } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(vl(GOOD), { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.sent.code).toBe(200);
  });

  it('a pinned Plivo call is still fetched server-side with Basic auth, never redirected', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, body: 'bytes', headers: { get: () => null } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(PLIVO_URL), { headers: {} } as any, r, access(HOSTS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get('authorization')).toBe(BASIC);
    expect(r.sent.code).toBe(200);
    expect(r.sent.headers['Location']).toBeUndefined();
  });
});

describe('acceptsJsonRedirect: a script asking for JSON by name, never through a wildcard', () => {
  it.each([
    ['application/json', true],
    ['application/json, audio/*;q=0.9, */*;q=0.1', true],
    ['audio/*, Application/JSON;q=0.5', true],
    [['audio/*', 'application/json'], true],
    [undefined, false],
    ['', false],
    ['*/*', false],
    ['audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,application/ogg;q=0.7,video/*;q=0.6,*/*;q=0.5', false],
    ['application/*', false],
    ['application/json;q=0', false],
    ['application/jsonp', false],
  ] as const)('%j → %s', (accept, expected) => {
    expect(acceptsJsonRedirect(accept as string | string[] | undefined)).toBe(expected);
  });
});

describe('proxyCallRecording — the redirect as JSON for a script that asks (CR12)', () => {
  const JSON_ACCEPT = 'application/json, audio/*;q=0.9, */*;q=0.1';
  const vlPinned = (recording_url: string | null) => ({
    id: 'c', recording_url, provider: 'voicelink', telephony_credential_id: CRED, tenant_id: TENANT,
  });
  function vlCredentials(state: 'active' | 'revoked' = 'active') {
    return {
      resolve: vi.fn(async (id: string) => {
        if (state === 'revoked') throw new CredentialUnavailableError(id, 'status', 'revoked');
        return {
          id, tenantId: TENANT, provider: 'voicelink', accountRef: 'tenant-user', publicConfig: { username: 'Tenant-User' },
          version: 1, secret: new Secret({ password: 'tenant-password' }), previous: [],
        };
      }),
    };
  }

  it('answers 200 { redirect_url }, no-store, with no Location and no fetch, once the credential serves', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const creds = vlCredentials();
    const r = reply();
    await proxyCallRecording(vlPinned(GOOD), { headers: { accept: JSON_ACCEPT } } as any, r, access(HOSTS, creds));
    expect(creds.resolve).toHaveBeenCalledWith(CRED, 'recording');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(200);
    expect(r.sent.body).toEqual({ redirect_url: GOOD });
    expect(r.sent.headers).toEqual({ 'Cache-Control': 'no-store', Vary: 'Accept' });
  });

  it('sends the viewer to the URL as the host check parsed it, never the stored string', async () => {
    vi.stubGlobal('fetch', vi.fn());
    // A stored URL with a stray line break and a character a header cannot carry: the parser
    // drops the one and percent-encodes the other, and that is what the viewer is sent.
    const stored = `${GOOD.replace('.mp3', '')}\n-€.mp3 `;
    const normalised = new URL(stored).href;
    expect(normalised).not.toBe(stored);
    const json = reply();
    await proxyCallRecording(vlPinned(stored), { headers: { accept: JSON_ACCEPT } } as any, json, access(HOSTS, vlCredentials()));
    expect(json.sent.body).toEqual({ redirect_url: normalised });
    const redirect = reply();
    await proxyCallRecording(vlPinned(stored), { headers: {} } as any, redirect, access(HOSTS, vlCredentials()));
    expect(redirect.sent.code).toBe(302);
    expect(redirect.sent.headers['Location']).toBe(normalised);
  });

  it.each([
    ['no Accept', {}],
    ['an audio element’s Accept', { accept: 'audio/webm,audio/ogg,audio/*;q=0.9,*/*;q=0.5' }],
    ['JSON refused with q=0', { accept: 'application/json;q=0, */*' }],
  ])('keeps the 302 for %s', async (_l, headers) => {
    const r = reply();
    await proxyCallRecording(vlPinned(GOOD), { headers } as any, r, access(HOSTS, vlCredentials()));
    expect(r.sent.code).toBe(302);
    expect(r.sent.headers['Location']).toBe(GOOD);
    expect(r.sent.body).toBeUndefined();
  });

  it('a revoked credential is the same 404 when JSON is asked for: no URL in the body', async () => {
    const r = reply();
    await proxyCallRecording(vlPinned(GOOD), { headers: { accept: JSON_ACCEPT } } as any, r, access(HOSTS, vlCredentials('revoked')));
    expect(r.sent.code).toBe(404);
    expect(r.sent.body).toMatchObject({ code: 'recording_unavailable' });
    expect(JSON.stringify(r.sent)).not.toContain(GOOD);
  });

  it('a URL off the allow-list is the same 502 when JSON is asked for: never handed out', async () => {
    const evil = 'https://evil.example/r.mp3';
    const r = reply();
    await proxyCallRecording(vlPinned(evil), { headers: { accept: JSON_ACCEPT } } as any, r, access(HOSTS, vlCredentials()));
    expect(r.sent.code).toBe(502);
    expect(JSON.stringify(r.sent)).not.toContain('evil.example');
  });

  it('a service VoiceLink call and a pinned Plivo call are still fetched and streamed when JSON is asked for', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, body: 'bytes', headers: { get: () => null } }));
    vi.stubGlobal('fetch', fetchMock);
    const service = reply();
    await proxyCallRecording(vl(GOOD), { headers: { accept: JSON_ACCEPT } } as any, service, access(HOSTS));
    expect(service.sent.code).toBe(200);
    expect(service.sent.body).toBe('bytes');
    const plivo = reply();
    await proxyCallRecording(pl(PLIVO_URL), { headers: { accept: JSON_ACCEPT } } as any, plivo, access(HOSTS));
    expect(plivo.sent.code).toBe(200);
    expect(plivo.sent.body).toBe('bytes');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
