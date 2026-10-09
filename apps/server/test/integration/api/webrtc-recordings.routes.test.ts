import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { DEFAULTS, OTHER_TENANT, insertWebrtcCall } from '../../../../../packages/db/test/integration/setup/factories.js';

/*
 * The `GET /api/v1/webrtc-recordings/:id` route on real Postgres 5436 and the REAL signing
 * code. There is no `GET /webrtc-call/:id/recording-url` route or authenticated
 * `/recording` proxy, so the URL is minted with `signRecordingUrl`
 * exactly as the agency attempt route will. No carrier credentials exist: the test asserts
 * NONE are sent. Also covered: off-list host / redirect refusal and the signed-URL TTL/path
 * checks on the real route.
 */
const SECRET = 'integration-test-signing-secret-xyz123';
process.env['RECORDING_URL_SIGNING_SECRET'] = SECRET;
const HOST = 'recordings.voicelink.test';
const URL_OK = `https://${HOST}/recordings/abc.mp3`;
const REC_PREFIX = '/api/v1/webrtc-recordings';

const { webrtcRecordingsRoutes } = await import('../../../src/api/routes/webrtc-recordings.routes.js');
const { signRecordingUrl } = await import('../../../src/utils/recording-url.js');

function makeUpstreamResponse(body: Buffer | string, init: { status?: number; contentRange?: string; contentLength?: string; location?: string } = {}): Response {
  const headers = new Headers();
  headers.set('content-type', 'audio/mpeg');
  if (init.contentLength) headers.set('content-length', init.contentLength);
  if (init.contentRange) headers.set('content-range', init.contentRange);
  if (init.location) headers.set('location', init.location);
  return new Response(body, { status: init.status ?? 200, headers });
}

describe('webrtc recording playback (integration)', () => {
  let app: FastifyInstance;

  beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 }); });
  beforeEach(async () => {
    await truncateAll();
    app = Fastify({ logger: false });
    await app.register(webrtcRecordingsRoutes, { prefix: REC_PREFIX, allowedHosts: [HOST] });
    await app.ready();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });
  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  async function signed(callOverrides: Record<string, unknown> = {}, ttlSeconds?: number) {
    const call = await insertWebrtcCall({ recording_url: URL_OK, status: 'completed', ...callOverrides });
    const { path } = signRecordingUrl({
      callId: call.id, tenantId: call.tenant_id, accountId: call.account_id, basePath: REC_PREFIX, ...(ttlSeconds ? { ttlSeconds } : {}),
    });
    return { call, url: path };
  }

  it('proxies the upstream VoiceLink recording with NO credentials attached', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeUpstreamResponse(Buffer.from('VOICELINK_MP3_BYTES'), { contentLength: '19' }));
    vi.stubGlobal('fetch', mockFetch);
    const { call, url } = await signed();

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(res.rawPayload.toString()).toBe('VOICELINK_MP3_BYTES');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [fetchedUrl, fetchInit] = mockFetch.mock.calls[0]!;
    expect(fetchedUrl).toBe(call.recording_url);
    expect(fetchInit.headers).toEqual({});
  });

  it('passes a Range request header through to upstream and forwards 206 + Content-Range', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeUpstreamResponse(Buffer.from('RANGE_BYTES'), { status: 206, contentRange: 'bytes 0-10/100', contentLength: '11' }));
    vi.stubGlobal('fetch', mockFetch);
    const { url } = await signed();

    const res = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-10' } });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-10/100');
    expect((mockFetch.mock.calls[0]![1].headers as Record<string, string>)['Range']).toBe('bytes=0-10');
  });

  it('returns 403 when the signature is tampered', async () => {
    const { url } = await signed();
    const res = await app.inject({ method: 'GET', url: url.replace(/sig=[^&]+/, 'sig=AAAA') });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when the URL has expired (and an extended expiry fails the HMAC)', async () => {
    const { url } = await signed();
    expect((await app.inject({ method: 'GET', url: url.replace(/exp=\d+/, 'exp=1') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: url.replace(/exp=(\d+)/, (_m, n) => `exp=${Number(n) + 99999}`) })).statusCode).toBe(403);
  });

  it('returns 403 when the tenant or account in the query is swapped (cross-tenant replay)', async () => {
    const { url, call } = await signed();
    expect((await app.inject({ method: 'GET', url: url.replace(`tenant=${call.tenant_id}`, `tenant=${OTHER_TENANT}`) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: url.replace(`account=${call.account_id}`, `account=${OTHER_TENANT}`) })).statusCode).toBe(403);
  });

  it("a token signed for one call cannot play another call's recording", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const a = await signed();
    const b = await insertWebrtcCall({ recording_url: URL_OK });
    const res = await app.inject({ method: 'GET', url: a.url.replace(a.call.id, b.id) });
    expect(res.statusCode).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 404 when the token's principal is not the call's owner", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const call = await insertWebrtcCall({ recording_url: URL_OK });
    const { path } = signRecordingUrl({ callId: call.id, tenantId: OTHER_TENANT, accountId: DEFAULTS.accountId, basePath: REC_PREFIX });
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 404 if the call row gets deleted between sign and playback', async () => {
    const { url, call } = await signed();
    await getTestPool().query('DELETE FROM agency_calls WHERE id = $1', [call.id]);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('returns 404 for a call with no recording', async () => {
    const { url } = await signed({ recording_url: null });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/no recording/i);
  });

  it('returns 502 when the upstream provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream down', { status: 500 })));
    const { url } = await signed();
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(502);
  });

  it('returns 502 without fetching when the stored URL is off the allow-list, or redirects off it', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const off = await signed({ recording_url: 'https://evil.example/x.mp3' });
    expect((await app.inject({ method: 'GET', url: off.url })).statusCode).toBe(502);
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockResolvedValueOnce(makeUpstreamResponse('', { status: 302, location: 'https://169.254.169.254/latest/meta-data/' }));
    const bounce = await signed();
    expect((await app.inject({ method: 'GET', url: bounce.url })).statusCode).toBe(502);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
