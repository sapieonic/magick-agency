import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/*
 * The recording proxy's failures, as an operator sees them (RC3), and the opt-in redirect hosts
 * (RC4); a call that did not ask for a recording has none to serve (RC1).
 *
 * Every answer the console renders as "We could not reach the service that stores this
 * recording" (any status but 403 and 404) is logged with a bounded `reason`, the call id and its
 * provider, and counted in `recording_fetch_failures_total{provider, surface="playback", reason}`.
 * Hosts are logged, never a URL: a signed carrier URL holds its secret in the path or query.
 */
const h = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log, track: vi.fn() };
});
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => h.log,
}));
vi.mock('@magick-agency/observability/metrics/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  trackRecordingFetchFailure: h.track,
}));

const { proxyCallRecording, fetchWithAllowedRedirects, recordingFetchErrorReason, recordingUpstreamStatusReason } = await import(
  '../../../src/utils/recording-proxy.js'
);
const { createRecordingAccessResolver } = await import('../../../src/telephony/recording-access.js');
const { CredentialUnavailableError } = await import('../../../src/telephony/credentials/credential-service.js');
const { Secret } = await import('../../../src/telephony/credentials/secret.js');

const TENANT = 'ten-1';
const AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
const SIGNED_TAIL = 'Signature=s3cr3t-signature';
const VL_URL = `https://recordings.voicelink.test/a/b.mp3?${SIGNED_TAIL}`;
const PLIVO_URL = `https://media.plivo.com/v1/Account/${AUTH_ID}/Recording/r-1.mp3`;
const REDIRECT_TARGET = `https://files.plivo-cdn.test/r-1.mp3?${SIGNED_TAIL}`;

const vl = (over: Record<string, unknown> = {}) => ({
  id: 'call-vl', recording_url: VL_URL, provider: 'voicelink', telephony_credential_id: null, tenant_id: TENANT, ...over,
});
const pl = (over: Record<string, unknown> = {}) => ({
  id: 'call-pl', recording_url: PLIVO_URL, provider: 'plivo', telephony_credential_id: 'cred-1', tenant_id: TENANT, ...over,
});

function credentials(state: 'active' | 'revoked' | 'boom' = 'active') {
  return {
    resolve: vi.fn(async (id: string) => {
      if (state === 'revoked') throw new CredentialUnavailableError(id, 'status', 'revoked');
      if (state === 'boom') throw new Error('database down');
      return {
        id, tenantId: TENANT, provider: 'plivo', accountRef: AUTH_ID, publicConfig: { auth_id: AUTH_ID },
        version: 1, secret: new Secret({ auth_token: 'tok_abcdefghijklmnop' }), previous: [],
      };
    }),
  };
}
const access = (opts: { creds?: ReturnType<typeof credentials>; plivoRedirectHosts?: string[] } = {}) =>
  createRecordingAccessResolver({
    voicelinkHosts: ['voicelink.test'],
    credentials: () => opts.creds ?? credentials(),
    ...(opts.plivoRedirectHosts ? { plivoRedirectHosts: opts.plivoRedirectHosts } : {}),
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
const redirect = (location: string) => ({
  ok: false, status: 302, body: null,
  headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) },
});
const answer = (status: number) => ({
  ok: status < 300, status, body: status < 300 ? 'bytes' : { cancel: vi.fn(async () => undefined) }, headers: { get: () => null },
});

/** Every argument any log call got, as one string: what must never hold a URL or its secret. */
function everythingLogged(): string {
  return JSON.stringify([h.log.info, h.log.warn, h.log.error, h.log.debug].flatMap((f) => f.mock.calls));
}
/** The structured fields of the last warn or error. */
function lastLogged(): Record<string, unknown> {
  const calls = [...h.log.warn.mock.calls, ...h.log.error.mock.calls];
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

beforeEach(() => {
  h.track.mockClear();
  for (const f of Object.values(h.log)) f.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('a call that did not ask for a recording (RC1)', () => {
  it('404s whatever the row still holds, without resolving access or fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const creds = credentials();
    const r = reply();
    await proxyCallRecording(pl({ recording_requested: false }), { headers: {} } as any, r, access({ creds }));
    expect(r.sent.code).toBe(404);
    expect(creds.resolve).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
  });

  it('serves a call that asked for one as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(200)));
    const r = reply();
    await proxyCallRecording(vl({ recording_requested: true }), { headers: {} } as any, r, access());
    expect(r.sent.code).toBe(200);
  });
});

describe('every "could not reach" answer is logged and counted with its reason (RC3)', () => {
  it.each([
    [401, 'upstream_unauthorized'],
    [403, 'upstream_unauthorized'],
    [404, 'upstream_not_found'],
    [410, 'upstream_not_found'],
    [500, 'upstream_status'],
    [503, 'upstream_status'],
  ] as const)('the carrier answers %i: 502, reason %s, the status logged', async (status, reason) => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(status)));
    const r = reply();
    await proxyCallRecording(pl(), { headers: {} } as any, r, access());
    expect(r.sent.code).toBe(502);
    expect(h.track).toHaveBeenCalledWith('plivo', 'playback', reason);
    expect(lastLogged()).toMatchObject({ callId: 'call-pl', provider: 'plivo', reason, upstreamStatus: status, host: 'media.plivo.com' });
  });

  it('the stored URL is off the carrier host: 502 host_not_allowed, the host logged, nothing fetched', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(vl({ recording_url: `https://voiceflowai.elisiontec.test/rec/x.mp3?${SIGNED_TAIL}` }), { headers: {} } as any, r, access());
    expect(r.sent.code).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith('voicelink', 'playback', 'host_not_allowed');
    expect(lastLogged()).toMatchObject({ reason: 'host_not_allowed', host: 'voiceflowai.elisiontec.test', hop: 0 });
  });

  it('the carrier host redirects elsewhere: 502 redirect_refused, the TARGET HOST and its sender logged, never the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect(REDIRECT_TARGET));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(), { headers: {} } as any, r, access());
    expect(r.sent.code).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith('plivo', 'playback', 'redirect_refused');
    expect(lastLogged()).toMatchObject({
      callId: 'call-pl', provider: 'plivo', reason: 'redirect_refused', hop: 1,
      host: 'media.plivo.com', redirectHost: 'files.plivo-cdn.test', redirectedFrom: 'media.plivo.com',
    });
    const logged = everythingLogged();
    expect(logged).not.toContain(SIGNED_TAIL);
    expect(logged).not.toContain('/Recording/');
    expect(logged).not.toContain('r-1.mp3');
  });

  it('a redirect loop: 502 too_many_redirects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirect(VL_URL)));
    const r = reply();
    await proxyCallRecording(vl(), { headers: {} } as any, r, access());
    expect(r.sent.code).toBe(502);
    expect(h.track).toHaveBeenCalledWith('voicelink', 'playback', 'too_many_redirects');
  });

  it('the fetch fails: 502 network, the host logged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const r = reply();
    await proxyCallRecording(vl(), { headers: {} } as any, r, access());
    expect(r.sent.code).toBe(502);
    expect(h.track).toHaveBeenCalledWith('voicelink', 'playback', 'network');
    expect(lastLogged()).toMatchObject({ reason: 'network', host: 'recordings.voicelink.test' });
    expect(everythingLogged()).not.toContain(SIGNED_TAIL);
  });

  it('a carrier host that never answers: 504 timeout once the headers are late (no more hanging the viewer)', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const r = reply();
    await proxyCallRecording(vl(), { headers: {} } as any, r, access(), { headersTimeoutMs: 20 });
    expect(r.sent.code).toBe(504);
    expect(h.track).toHaveBeenCalledWith('voicelink', 'playback', 'timeout');
    expect(lastLogged()).toMatchObject({ reason: 'timeout', host: 'recordings.voicelink.test' });
  });

  it('resolving the access throws: 502 access_error', async () => {
    const r = reply();
    await proxyCallRecording(pl(), { headers: {} } as any, r, access({ creds: credentials('boom') }));
    expect(r.sent.code).toBe(502);
    expect(h.track).toHaveBeenCalledWith('plivo', 'playback', 'access_error');
  });

  it('a credential that cannot serve recordings: 404 (read as not recorded), counted access_refused', async () => {
    const r = reply();
    await proxyCallRecording(pl(), { headers: {} } as any, r, access({ creds: credentials('revoked') }));
    expect(r.sent.code).toBe(404);
    expect(h.track).toHaveBeenCalledWith('plivo', 'playback', 'access_refused');
  });

  it('a recording that plays counts nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(200)));
    const r = reply();
    await proxyCallRecording(pl(), { headers: {} } as any, r, access());
    expect(r.sent.code).toBe(200);
    expect(h.track).not.toHaveBeenCalled();
  });

  it('the classifiers', () => {
    expect(recordingUpstreamStatusReason(401)).toBe('upstream_unauthorized');
    expect(recordingUpstreamStatusReason(404)).toBe('upstream_not_found');
    expect(recordingUpstreamStatusReason(429)).toBe('upstream_status');
    expect(recordingFetchErrorReason(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(recordingFetchErrorReason(new Error('x'), true)).toBe('timeout');
    expect(recordingFetchErrorReason(new TypeError('fetch failed'))).toBe('network');
  });
});

describe('Plivo redirect hosts from operator config (RC4, off by default)', () => {
  it('unset: a redirect off media.plivo.com is refused, as before RC4', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect(REDIRECT_TARGET)).mockResolvedValueOnce(answer(200));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(), { headers: {} } as any, r, access({ plivoRedirectHosts: [] }));
    expect(r.sent.code).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('listed: the redirect is followed WITHOUT the credential, and the recording streams', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect(REDIRECT_TARGET)).mockResolvedValueOnce(answer(200));
    vi.stubGlobal('fetch', fetchMock);
    const r = reply();
    await proxyCallRecording(pl(), { headers: { range: 'bytes=0-9' } } as any, r, access({ plivoRedirectHosts: ['files.plivo-cdn.test'] }));
    expect(r.sent.code).toBe(200);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([PLIVO_URL, REDIRECT_TARGET]);
    const hop = new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers);
    expect(hop.get('authorization')).toBeNull();
    expect(hop.get('range')).toBe('bytes=0-9');
  });

  it('listed hosts are exact, for redirect hops only: never a subdomain, never the first URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect('https://x.files.plivo-cdn.test/r.mp3'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithAllowedRedirects(PLIVO_URL, {}, ['media.plivo.com'], { exactHosts: true, redirectHosts: ['files.plivo-cdn.test'] }))
      .rejects.toMatchObject({ name: 'RecordingHostRefusedError', hop: 1, host: 'x.files.plivo-cdn.test', redirectedFrom: 'media.plivo.com' });
    const first = vi.fn();
    vi.stubGlobal('fetch', first);
    await expect(fetchWithAllowedRedirects(REDIRECT_TARGET, {}, ['media.plivo.com'], { exactHosts: true, redirectHosts: ['files.plivo-cdn.test'] }))
      .rejects.toMatchObject({ name: 'RecordingHostRefusedError', hop: 0 });
    expect(first).not.toHaveBeenCalled();
  });

  it('a VoiceLink call never gets the Plivo list', async () => {
    const resolve = access({ plivoRedirectHosts: ['files.plivo-cdn.test'] });
    expect(await resolve(vl())).not.toHaveProperty('redirectHosts');
    expect(await resolve(pl())).toMatchObject({ redirectHosts: ['files.plivo-cdn.test'] });
  });
});
