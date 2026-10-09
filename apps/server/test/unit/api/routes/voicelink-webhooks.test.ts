import { describe, it, expect, vi, beforeEach } from 'vitest';

// Covers only the `POST /voicelink/webrtc-status/:callId` route, against
// apps/server/src/api/routes/webhooks.routes.ts (which carries that one route). The route module
// imports only the logger and the VoiceLink webhook parser, so the harness mocks only
// `@magick-agency/observability`; the parser stays REAL.
//
// The route takes no `callManager` and there is no AI-call path to touch, so there is no
// assertion that `callManager.handleTelephonyEvent` is not called. 'short-circuits with
// {status:true} when no webrtcBridge is wired' builds the plugin with `webrtcBridge: null`.
// Fixture: `buildAppWithBridge` passes only `{ webrtcBridge }` as the route's options.

// ── Hoisted mocks ──────────────────────────────────────────────────────
// webhooks.routes.ts pulls in a wide dependency graph; mock it the same way
// vobiz-webhooks.test.ts / telnyx-webhooks.test.ts do so the route module loads
// in isolation. The VoiceLink webhook PARSER (voicelink.webhook.ts) is left REAL
// so the informational-vs-terminal routing decision is genuinely exercised.

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
}));

vi.mock('@magick-agency/observability', () => ({
  // `isLevelEnabled` is part of pino's logger surface and a child inherits it.
  // The route guards the raw-body capture on it, because `maskPiiValue` is an
  // eagerly-evaluated argument — a deep clone with a regex per string — so
  // relying on pino's own level check would still pay the masking on every
  // webhook. A mock without it throws before the handler does anything, which is
  // how these three cases failed when the guard was added.
  createChildLogger: () => ({
    info: mocks.logInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    isLevelEnabled: () => false,
  }),
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    isLevelEnabled: () => false,
  },
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { webhooksRoutes } from '../../../../src/api/routes/webhooks.routes.js';

function postJson(app: FastifyInstance, url: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

describe('VoiceLink WebRTC webhook — POST /voicelink/webrtc-status/:callId', () => {
  const WEBRTC_ID = 'webrtc-call-1';

  async function buildAppWithBridge(bridge: unknown): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(
      async (instance) => {
        await webhooksRoutes(instance, {
          webrtcBridge: bridge as any,
        });
      },
      { prefix: '/api/v1/webhooks' },
    );
    await app.ready();
    return app;
  }

  beforeEach(() => vi.clearAllMocks());

  it('routes a terminal (answered) event to handleVoicelinkStatus as hangup', async () => {
    const handleVoicelinkStatus = vi.fn().mockResolvedValue(undefined);
    const verifyWsToken = vi.fn().mockResolvedValue(true);
    const app = await buildAppWithBridge({ handleVoicelinkStatus, verifyWsToken });

    const res = await postJson(app, `/api/v1/webhooks/voicelink/webrtc-status/${WEBRTC_ID}`, {
      event: 'call.completed',
      call: { id: 'pcid-9', direction: 'outbound', status: 'completed', callStatus: 'ANSWERED', durationSec: 12 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: true });
    expect(handleVoicelinkStatus).toHaveBeenCalledOnce();
    const [id, event] = handleVoicelinkStatus.mock.calls[0]!;
    expect(id).toBe(WEBRTC_ID);
    expect(event).toMatchObject({ callId: WEBRTC_ID, eventType: 'hangup' });
    await app.close();
  });

  it('call.initiated (informational) does not invoke handleVoicelinkStatus', async () => {
    const handleVoicelinkStatus = vi.fn().mockResolvedValue(undefined);
    const verifyWsToken = vi.fn().mockResolvedValue(true);
    const app = await buildAppWithBridge({ handleVoicelinkStatus, verifyWsToken });

    const res = await postJson(app, `/api/v1/webhooks/voicelink/webrtc-status/${WEBRTC_ID}`, {
      event: 'call.initiated',
      call: { id: 'pcid-9', direction: 'outbound', status: 'initiated' },
    });

    expect(res.statusCode).toBe(200);
    expect(handleVoicelinkStatus).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a webhook whose token fails verification (403, no handling)', async () => {
    const handleVoicelinkStatus = vi.fn().mockResolvedValue(undefined);
    const verifyWsToken = vi.fn().mockResolvedValue(false);
    const app = await buildAppWithBridge({ handleVoicelinkStatus, verifyWsToken });

    const res = await postJson(app, `/api/v1/webhooks/voicelink/webrtc-status/${WEBRTC_ID}?token=bad`, {
      event: 'call.completed',
      call: { id: 'pcid-9', callStatus: 'ANSWERED' },
    });

    expect(res.statusCode).toBe(403);
    expect(handleVoicelinkStatus).not.toHaveBeenCalled();
    await app.close();
  });

  it('short-circuits with {status:true} when no webrtcBridge is wired', async () => {
    const app = await buildAppWithBridge(null); // no bridge
    const res = await postJson(app, `/api/v1/webhooks/voicelink/webrtc-status/${WEBRTC_ID}`, {
      event: 'call.answered',
      call: { id: 'pcid-9', direction: 'outbound', status: 'answered', callStatus: 'ANSWERED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: true });
    await app.close();
  });
});
