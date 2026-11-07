import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { randomUUID } from 'node:crypto';
import { DEFAULTS, OTHER_TENANT, insertTenant, insertWebrtcCall } from '../../../../../packages/db/test/integration/setup/factories.js';

/*
 * The `GET /api/v1/webrtc-recordings/:id` route on real Postgres 5436 and the REAL signing
 * code. There is no `GET /webrtc-call/:id/recording-url` route or authenticated
 * `/recording` proxy, so the URL is minted with `signRecordingUrl`
 * exactly as the agency attempt route will. A VoiceLink recording carries no credentials:
 * the test asserts NONE are sent. Also covered: off-list host / redirect refusal, the
 * signed-URL TTL/path checks on the real route, and a Plivo recording on the tenant's
 * credential (below).
 */
const SECRET = 'integration-test-signing-secret-xyz123';
process.env['RECORDING_URL_SIGNING_SECRET'] = SECRET;
const HOST = 'recordings.voicelink.test';
const URL_OK = `https://${HOST}/recordings/abc.mp3`;
const REC_PREFIX = '/api/v1/webrtc-recordings';

const { webrtcRecordingsRoutes } = await import('../../../src/api/routes/webrtc-recordings.routes.js');
const { signRecordingUrl } = await import('../../../src/utils/recording-url.js');
const { createRecordingAccessResolver } = await import('../../../src/telephony/recording-access.js');
const { TelephonyCredentialService } = await import('../../../src/telephony/credentials/credential-service.js');
const { buildSealerFromConfig } = await import('../../../src/telephony/credentials/index.js');
const { telephonyCredentialRepository } = await import('@magick-agency/db/repositories/telephony-credential.repository');
const { tenantRepository } = await import('@magick-agency/db/repositories/tenant.repository');

/*
 * B21 on real Postgres: the credential service is the real one (real repository, real
 * sealer over a test keyring); only the carrier's verify call is stubbed. A Plivo
 * recording is fetched with Basic auth from the call's pinned credential; revoking the
 * credential ends playback.
 */
const credentialService = new TelephonyCredentialService({
  repo: telephonyCredentialRepository,
  tenants: tenantRepository,
  sealer: buildSealerFromConfig({ keyring: `t1:${Buffer.alloc(32, 7).toString('base64')}`, activeKeyId: 't1' }),
  fetchImpl: async () => ({ status: 200 }),
});

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
    await app.register(webrtcRecordingsRoutes, {
      prefix: REC_PREFIX,
      resolveRecordingAccess: createRecordingAccessResolver({ voicelinkHosts: [HOST], credentials: () => credentialService }),
    });
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

  describe('a Plivo recording on the tenant credential (B21)', () => {
    const AUTH_ID = 'MAABCDEFGHIJKLMNOPQR';
    const AUTH_TOKEN = 'tok_integration_0123456789';
    const PLIVO_URL = `https://media.plivo.com/v1/Account/${AUTH_ID}/Recording/r-1.mp3`;

    const adminId = randomUUID();

    async function plivoCall() {
      await insertTenant({ id: DEFAULTS.tenantId });
      // `truncateAll` empties the provider catalogue too; the credential's FK needs the row.
      await getTestPool().query(
        `INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo') ON CONFLICT (name) DO NOTHING`,
      );
      await getTestPool().query(
        `INSERT INTO super_admins (id, email, password_hash, name, status) VALUES ($1, 'rec@b21.example.com', 'x', 'Rec Admin', 'active')`,
        [adminId],
      );
      const created = await credentialService.create({
        tenantId: DEFAULTS.tenantId, provider: 'plivo', label: 'Main',
        fields: { auth_id: AUTH_ID, auth_token: AUTH_TOKEN }, adminId,
      });
      if (!created.ok) throw new Error(`credential create failed: ${created.code}`);
      const signedCall = await signed({
        provider: 'plivo', telephony_credential_id: created.value.id, recording_url: PLIVO_URL,
      });
      return { ...signedCall, credentialId: created.value.id };
    }

    it('fetches media.plivo.com with Basic auth from the pinned credential', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeUpstreamResponse(Buffer.from('PLIVO_MP3')));
      vi.stubGlobal('fetch', mockFetch);
      const { url } = await plivoCall();

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.toString()).toBe('PLIVO_MP3');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchedUrl, fetchInit] = mockFetch.mock.calls[0]!;
      expect(fetchedUrl).toBe(PLIVO_URL);
      expect(new Headers(fetchInit.headers).get('authorization'))
        .toBe(`Basic ${Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString('base64')}`);
    });

    it('a revoked credential ends playback: 404 recording_unavailable, nothing fetched', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      const { url, credentialId } = await plivoCall();
      const revoked = await credentialService.revoke(credentialId, adminId);
      expect(revoked.ok).toBe(true);

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('recording_unavailable');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
