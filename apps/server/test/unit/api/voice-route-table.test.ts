// The voice plugin's route surface, enumerated from Fastify's own `onRoute` hook (never by
// grep). Exactly the two carrier surfaces the agency path uses are registered, under the
// `/api/v1/webrtc-call` and `/api/v1/webhooks` prefixes; there is no softphone control API,
// no `/browser-stream` leg and no VoBiz WebRTC webhook.
import { describe, it, expect } from 'vitest';
import type { RouteOptions } from 'fastify';
import { buildApp } from '../../../src/app.js';

describe('voice plugin route table', () => {
  it('registers exactly the PSTN media leg and the VoiceLink bridge webhook', async () => {
    const routes: string[] = [];
    const app = await buildApp({
      ctx: null,
      onRoute: (r: RouteOptions) => {
        const methods = Array.isArray(r.method) ? r.method : [r.method];
        for (const m of methods) if (m !== 'HEAD') routes.push(`${m} ${r.url}`);
      },
    });
    await app.ready();
    await app.close();

    const voice = routes.filter((r) => r.includes('/webrtc-call') || r.includes('/webhooks')).sort();
    expect(voice).toEqual([
      'GET /api/v1/webrtc-call/:id/pstn-stream',
      'POST /api/v1/webhooks/voicelink/webrtc-status/:callId',
    ]);
    expect(routes.some((r) => r.includes('browser-stream'))).toBe(false);
    expect(routes.some((r) => r.includes('/vobiz/'))).toBe(false);
  });
});
