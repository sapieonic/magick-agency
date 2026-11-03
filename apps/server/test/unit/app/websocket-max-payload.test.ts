import { AGENCY_WS_MAX_MESSAGE_BYTES } from '@magick-agency/contracts/agency';
import { describe, it, expect, vi } from 'vitest';
import type { RouteOptions } from 'fastify';

/**
 * The inbound WebSocket message bound (`maxPayload`, `src/utils/ws-limits.ts`), set where
 * `app.ts` registers `@fastify/websocket`. One `ws` server serves every WebSocket route, so
 * the bound must sit above the largest legitimate message on EVERY route. The routes are
 * enumerated from `buildApp`'s own `onRoute` hook (never by grep), and must be exactly the
 * routes `WS_ROUTE_LARGEST_MESSAGE_BYTES` sizes: a new WebSocket route reds this test until
 * someone decides what its largest message is.
 *
 * The station socket's behaviour at the bound (1009 past it, ignored under it) is pinned on
 * real sockets by `test/unit/load/station-inbound-fuzz.test.ts`.
 *
 * Mutation-checked: registering `@fastify/websocket` without options in `app.ts` reds the
 * first case (`ws`'s 100 MiB default).
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildApp } from '../../../src/app.js';
import {
  WS_LARGEST_LEGITIMATE_MESSAGE_BYTES,
  WS_MAX_PAYLOAD_DEFAULT_BYTES,
  WS_ROUTE_LARGEST_MESSAGE_BYTES,
} from '../../../src/utils/ws-limits.js';
import { parseConfig } from '../../../src/config/load.js';

const env = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

async function websocketRoutesAndBound(): Promise<{ routes: string[]; maxPayload: number | undefined }> {
  const routes: string[] = [];
  const app = await buildApp({
    ctx: null,
    onRoute: (r: RouteOptions) => {
      if ((r as { websocket?: boolean }).websocket === true) routes.push(r.url);
    },
  });
  await app.ready();
  const maxPayload = (app.websocketServer as unknown as { options: { maxPayload?: number } }).options.maxPayload;
  await app.close();
  return { routes: [...new Set(routes)].sort(), maxPayload };
}

describe('WebSocket maxPayload', () => {
  it('registers @fastify/websocket with the 64 KiB bound, not ws\'s 100 MiB default', async () => {
    const { maxPayload } = await websocketRoutesAndBound();
    expect(maxPayload).toBe(64 * 1024);
    // The wire contract's number, which the console sizes its largest frame from.
    expect(maxPayload).toBe(AGENCY_WS_MAX_MESSAGE_BYTES);
    expect(maxPayload).toBe(WS_MAX_PAYLOAD_DEFAULT_BYTES);
  });

  it('sizes exactly the WebSocket routes the app registers', async () => {
    const { routes } = await websocketRoutesAndBound();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toEqual(Object.keys(WS_ROUTE_LARGEST_MESSAGE_BYTES).sort());
  });

  it('sits above every route\'s largest legitimate message with at least 25% margin', () => {
    for (const [route, bytes] of Object.entries(WS_ROUTE_LARGEST_MESSAGE_BYTES)) {
      expect(bytes * 1.25, route).toBeLessThanOrEqual(WS_MAX_PAYLOAD_DEFAULT_BYTES);
    }
    // The station's 1 s pcm16 frame: 42 668 base64 characters plus the 40-character envelope.
    expect(WS_LARGEST_LEGITIMATE_MESSAGE_BYTES).toBe(42_708);
    expect(WS_ROUTE_LARGEST_MESSAGE_BYTES['/proxy/agency/station/:sessionId']).toBe(42_708);
  });

  it('is configurable as WS_MAX_PAYLOAD_BYTES, never below the largest legitimate message', () => {
    const dflt = parseConfig(env);
    expect(dflt.ok && dflt.config.server.wsMaxPayloadBytes).toBe(WS_MAX_PAYLOAD_DEFAULT_BYTES);

    const raised = parseConfig({ ...env, WS_MAX_PAYLOAD_BYTES: '131072' });
    expect(raised.ok && raised.config.server.wsMaxPayloadBytes).toBe(131_072);

    const tooLow = parseConfig({ ...env, WS_MAX_PAYLOAD_BYTES: String(WS_LARGEST_LEGITIMATE_MESSAGE_BYTES - 1) });
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.issues.map((i) => i.path.join('.'))).toContain('server.wsMaxPayloadBytes');

    const atFloor = parseConfig({ ...env, WS_MAX_PAYLOAD_BYTES: String(WS_LARGEST_LEGITIMATE_MESSAGE_BYTES) });
    expect(atFloor.ok).toBe(true);
  });
});
