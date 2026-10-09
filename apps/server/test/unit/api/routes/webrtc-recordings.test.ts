/*
 * The route takes the VoiceLink host allow-list as an option, so the proxy-call case also
 * asserts it is forwarded and an extra case asserts the default (none) is an empty list.
 * Also covered: a token check that never reaches the repository, in both directions of the
 * 403 case, and a 404 for a cross-ACCOUNT token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  webrtcRepo: { findById: vi.fn() },
  verifyRecordingToken: vi.fn(),
  proxyCallRecording: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: mocks.webrtcRepo,
}));
// recording-url + recording-proxy both import the config module at load time;
// stub them so the route can be tested without booting real config.
vi.mock('../../../../src/utils/recording-url.js', () => ({
  verifyRecordingToken: mocks.verifyRecordingToken,
}));
vi.mock('../../../../src/utils/recording-proxy.js', () => ({
  proxyCallRecording: mocks.proxyCallRecording,
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import Fastify from 'fastify';
import { webrtcRecordingsRoutes } from '../../../../src/api/routes/webrtc-recordings.routes.js';

const QS = '?tenant=t1&account=a1&exp=9999999999&sig=abc';

describe('webrtc-recordings routes (signed playback proxy)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(webrtcRecordingsRoutes, { prefix: '/api/v1/webrtc-recordings', allowedHosts: ['voicelink.test'] });
    await app.ready();
  });

  it('returns 403 when the signed token is invalid or expired', async () => {
    mocks.verifyRecordingToken.mockReturnValue(null);
    const res = await app.inject({ method: 'GET', url: `/api/v1/webrtc-recordings/call-1${QS}` });
    expect(res.statusCode).toBe(403);
    expect(mocks.webrtcRepo.findById).not.toHaveBeenCalled();
    expect(mocks.proxyCallRecording).not.toHaveBeenCalled();
  });

  it('returns 404 when the call does not exist', async () => {
    mocks.verifyRecordingToken.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
    mocks.webrtcRepo.findById.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: `/api/v1/webrtc-recordings/call-1${QS}` });
    expect(res.statusCode).toBe(404);
    expect(mocks.proxyCallRecording).not.toHaveBeenCalled();
  });

  it('returns 404 when the token principal does not match the call owner', async () => {
    mocks.verifyRecordingToken.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
    // Same call id but a different tenant — a token must not cross tenants.
    mocks.webrtcRepo.findById.mockResolvedValue({ id: 'call-1', tenant_id: 't2', account_id: 'a1', recording_url: 'https://media.vobiz.ai/r.mp3' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/webrtc-recordings/call-1${QS}` });
    expect(res.statusCode).toBe(404);
    expect(mocks.proxyCallRecording).not.toHaveBeenCalled();
  });

  it('proxies the recording when the token is valid and scoped to the owner', async () => {
    mocks.verifyRecordingToken.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
    mocks.webrtcRepo.findById.mockResolvedValue({ id: 'call-1', tenant_id: 't1', account_id: 'a1', recording_url: 'https://media.vobiz.ai/r.mp3' });
    mocks.proxyCallRecording.mockImplementation(async (_rec: unknown, _req: unknown, reply: any) => reply.send('audio-bytes'));
    const res = await app.inject({ method: 'GET', url: `/api/v1/webrtc-recordings/call-1${QS}` });
    expect(res.statusCode).toBe(200);
    expect(mocks.proxyCallRecording).toHaveBeenCalledTimes(1);
    expect(mocks.proxyCallRecording.mock.calls[0]![3]).toEqual(['voicelink.test']);
  });

  it('returns 404 when the token principal belongs to another ACCOUNT of the same tenant', async () => {
    mocks.verifyRecordingToken.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
    mocks.webrtcRepo.findById.mockResolvedValue({ id: 'call-1', tenant_id: 't1', account_id: 'a2', recording_url: 'https://x/r.mp3' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/webrtc-recordings/call-1${QS}` });
    expect(res.statusCode).toBe(404);
    expect(mocks.proxyCallRecording).not.toHaveBeenCalled();
  });

  it('with no host option the proxy is handed an empty allow-list (fail closed)', async () => {
    const bare = Fastify();
    await bare.register(webrtcRecordingsRoutes, { prefix: '/r' });
    await bare.ready();
    mocks.verifyRecordingToken.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
    mocks.webrtcRepo.findById.mockResolvedValue({ id: 'call-1', tenant_id: 't1', account_id: 'a1', recording_url: 'https://x/r.mp3' });
    mocks.proxyCallRecording.mockImplementation(async (_r: unknown, _q: unknown, reply: any) => reply.send('x'));
    await bare.inject({ method: 'GET', url: `/r/call-1${QS}` });
    expect(mocks.proxyCallRecording.mock.calls[0]![3]).toEqual([]);
    await bare.close();
  });
});
