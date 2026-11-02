import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { parseConfig } from '../../../../src/config/load.js';

/**
 * `GET /client-config` (public, the mobile app's version gate) and the `MOBILE_*` / rate-limit
 * keys it and the per-user bucket read from config:
 *  - the defaults (`0.1.0` / `0.1.0`, no store links) through the REAL app, unauthenticated,
 *    charged to the app-scope `ip` bucket like any public request;
 *  - configured versions and https store links reach the body; one link alone is one key;
 *  - versions are `MAJOR.MINOR.PATCH` only, a store link is https only, and a minimum newer
 *    than the latest is refused at boot (a dirty parse must not throw in the comparison);
 *  - `RATE_LIMIT_USER_MAX` (platform block, default 600) and `RATE_LIMIT_IP_AUTH_MAX`
 *    (voice block's `rateLimit`, default 20 000);
 *  - `POST /client-config/uplink-probe` through the REAL app (Firebase and the user lookup
 *    stubbed): refused 401 without a verified bearer (before any body is read, so an
 *    oversized anonymous body is a 401, not a 413), the byte count for 32 KB, 413 above
 *    65536 bytes, 415 for another content type, and the per-user cap of 6 per window.
 *
 * Mutation-checked: moving the probe's authentication from `preParsing` to `preHandler`
 * reds "an anonymous oversized body is a 401"; dropping the `probeCap` call reds the cap case.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: {
    findByFirebaseUid: async (uid: string) => ({
      id: `00000000-0000-4000-8000-${uid.padStart(12, '0')}`,
      firebase_uid: uid, email: `${uid}@example.com`, display_name: uid, avatar_url: null,
      status: 'active', phone_number: null, email_unverified: false,
      created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    }),
  },
}));

import { buildApp } from '../../../../src/app.js';
import {
  clientConfigRoutes, UPLINK_PROBE_BODY_LIMIT, UPLINK_PROBE_MAX_PER_WINDOW,
} from '../../../../src/api/routes/client-config.routes.js';
import { registerRateLimit } from '../../../../src/api/middleware/rate-limit.middleware.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

function parse(extra: Record<string, string> = {}) {
  const r = parseConfig({ ...base, ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.config;
}

function refused(extra: Record<string, string>): string[] {
  const r = parseConfig({ ...base, ...extra });
  return r.ok ? [] : r.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

async function serve(env: Record<string, string>) {
  const app = Fastify({ logger: false });
  // The probe's per-user cap is built on the limiter, as in `app.ts`.
  await registerRateLimit(app, null);
  await app.register(clientConfigRoutes, { prefix: '/client-config', mobile: parse(env).mobile });
  await app.ready();
  return app;
}

describe('GET /client-config', () => {
  it('answers the defaults through the real app, with no session, in the public ip bucket', async () => {
    const app = await buildApp({ ctx: null });
    try {
      const res = await app.inject({ method: 'GET', url: '/client-config' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ mobile: { min_supported: '0.1.0', latest: '0.1.0' } });
      // The plain `ip` bucket's default (`RATE_LIMIT_MAX`): a whole floor's phones read this
      // at start-up and in each pre-flight from one NAT (`rate-limit-defaults.ts`).
      expect(res.headers['x-ratelimit-limit']).toBe('2000');
    } finally {
      await app.close();
    }
  });

  it('serves the configured versions and both store links', async () => {
    const app = await serve({
      MOBILE_MIN_SUPPORTED_VERSION: '1.2.0',
      MOBILE_LATEST_VERSION: '1.10.3',
      MOBILE_IOS_STORE_URL: 'https://apps.apple.com/app/id000000000',
      MOBILE_ANDROID_STORE_URL: 'https://play.google.com/store/apps/details?id=com.magickagency.agent',
    });
    const res = await app.inject({ method: 'GET', url: '/client-config' });
    expect(res.json()).toEqual({
      mobile: {
        min_supported: '1.2.0',
        latest: '1.10.3',
        store_urls: {
          ios: 'https://apps.apple.com/app/id000000000',
          android: 'https://play.google.com/store/apps/details?id=com.magickagency.agent',
        },
      },
    });
    await app.close();
  });

  it('carries only the store link that is set, and none when both are empty', async () => {
    const one = await serve({ MOBILE_ANDROID_STORE_URL: 'https://play.google.com/store/apps/details?id=x.y' });
    expect((await one.inject({ method: 'GET', url: '/client-config' })).json().mobile.store_urls)
      .toEqual({ android: 'https://play.google.com/store/apps/details?id=x.y' });
    await one.close();

    const none = await serve({ MOBILE_IOS_STORE_URL: '', MOBILE_ANDROID_STORE_URL: '' });
    expect((await none.inject({ method: 'GET', url: '/client-config' })).json().mobile).not.toHaveProperty('store_urls');
    await none.close();
  });
});

describe('MOBILE_* config', () => {
  it.each([['1'], ['1.2'], ['v1.2.3'], ['1.2.3-beta.1'], ['1.2.3+45'], ['01.2.3'], ['1.2.3 '], ['']])(
    'refuses a version that is not MAJOR.MINOR.PATCH: %j',
    (value) => {
      // An empty value is unset (the default applies); everything else is refused.
      if (value === '') {
        expect(parse({ MOBILE_LATEST_VERSION: value }).mobile.latestVersion).toBe('0.1.0');
        return;
      }
      expect(refused({ MOBILE_LATEST_VERSION: value, MOBILE_MIN_SUPPORTED_VERSION: '0.0.1' })
        .some((m) => m.startsWith('mobile.latestVersion'))).toBe(true);
    },
  );

  it('refuses a minimum newer than the latest, comparing numerically (1.10.0 > 1.9.0)', () => {
    expect(refused({ MOBILE_MIN_SUPPORTED_VERSION: '1.10.0', MOBILE_LATEST_VERSION: '1.9.0' }))
      .toEqual([expect.stringMatching(/^mobile\.minSupportedVersion: .*must not be newer/)]);
    expect(parse({ MOBILE_MIN_SUPPORTED_VERSION: '1.9.0', MOBILE_LATEST_VERSION: '1.10.0' }).mobile.minSupportedVersion)
      .toBe('1.9.0');
    expect(parse({ MOBILE_MIN_SUPPORTED_VERSION: '2.0.0', MOBILE_LATEST_VERSION: '2.0.0' }).mobile.latestVersion)
      .toBe('2.0.0');
  });

  it('reports a malformed version without the comparison throwing on the dirty result', () => {
    const issues = refused({ MOBILE_MIN_SUPPORTED_VERSION: 'not-a-version', MOBILE_LATEST_VERSION: '1.0.0' });
    expect(issues).toEqual([expect.stringMatching(/^mobile\.minSupportedVersion: .*MAJOR\.MINOR\.PATCH/)]);
  });

  it.each([['http://play.google.com/x'], ['javascript:alert(1)'], ['not a url']])(
    'refuses a store link that is not https: %j',
    (value) => {
      expect(refused({ MOBILE_IOS_STORE_URL: value }).some((m) => m.startsWith('mobile.iosStoreUrl'))).toBe(true);
    },
  );
});

describe('rate-limit config (Q9, amended 2026-11-01)', () => {
  it('defaults the per-user bucket to 600 and the bearer IP bucket to 20 000', () => {
    const config = parse();
    expect(config.userRateLimit.max).toBe(600);
    expect(config.rateLimit.ipAuthMax).toBe(20_000);
    expect(config.rateLimit.max).toBe(2000);
  });

  it('reads RATE_LIMIT_USER_MAX and RATE_LIMIT_IP_AUTH_MAX', () => {
    const config = parse({ RATE_LIMIT_USER_MAX: '120', RATE_LIMIT_IP_AUTH_MAX: '9000' });
    expect(config.userRateLimit.max).toBe(120);
    expect(config.rateLimit.ipAuthMax).toBe(9000);
  });

  it.each([['0'], ['-5'], ['1.5'], ['lots']])('refuses RATE_LIMIT_USER_MAX=%j', (value) => {
    expect(refused({ RATE_LIMIT_USER_MAX: value }).some((m) => m.startsWith('userRateLimit.max'))).toBe(true);
  });
});

describe('POST /client-config/uplink-probe', () => {
  const probe = (app: FastifyInstance, opts: { token?: string; bytes?: number; contentType?: string } = {}) =>
    app.inject({
      method: 'POST',
      url: '/client-config/uplink-probe',
      headers: {
        'content-type': opts.contentType ?? 'application/octet-stream',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      payload: Buffer.alloc(opts.bytes ?? 32 * 1024, 0x5a),
    });

  let app: FastifyInstance;
  beforeEach(async () => {
    mocks.verifyIdToken.mockImplementation(async (token: string) => {
      if (!token.startsWith('tok:')) throw new Error('bad token');
      return { uid: token.slice(4), email: 'x@example.com', email_verified: true };
    });
    app = await buildApp({ ctx: null });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses 401 without a bearer, and with a forged one', async () => {
    expect((await probe(app)).statusCode).toBe(401);
    expect((await probe(app, { token: 'forged' })).statusCode).toBe(401);
  });

  it('authenticates before reading the body: an anonymous oversized body is a 401, not a 413', async () => {
    const res = await probe(app, { bytes: UPLINK_PROBE_BODY_LIMIT * 4 });
    expect(res.statusCode).toBe(401);
  });

  it('reads the whole body and answers its byte count (the app sends 32 KB)', async () => {
    const res = await probe(app, { token: 'tok:agent-a' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ received_bytes: 32 * 1024 });
  });

  it('takes exactly 65536 bytes, and refuses one more with 413', async () => {
    const atLimit = await probe(app, { token: 'tok:agent-a', bytes: UPLINK_PROBE_BODY_LIMIT });
    expect(atLimit.statusCode, atLimit.body).toBe(200);
    expect(atLimit.json()).toEqual({ received_bytes: UPLINK_PROBE_BODY_LIMIT });
    const over = await probe(app, { token: 'tok:agent-b', bytes: UPLINK_PROBE_BODY_LIMIT + 1 });
    expect(over.statusCode).toBe(413);
  });

  it('refuses any content type but application/octet-stream with 415', async () => {
    const res = await probe(app, { token: 'tok:agent-a', contentType: 'application/json' });
    expect(res.statusCode).toBe(415);
  });

  it('caps each user at 6 probes per window, apart from other users and from GET /client-config', async () => {
    expect(UPLINK_PROBE_MAX_PER_WINDOW).toBe(6);
    for (let i = 0; i < UPLINK_PROBE_MAX_PER_WINDOW; i += 1) {
      const res = await probe(app, { token: 'tok:agent-a', bytes: 16 });
      expect(res.statusCode, `probe ${i + 1}`).toBe(200);
    }
    const capped = await probe(app, { token: 'tok:agent-a', bytes: 16 });
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ error: 'Too Many Requests', statusCode: 429 });
    expect(capped.headers['x-ratelimit-limit']).toBe(String(UPLINK_PROBE_MAX_PER_WINDOW));
    expect(Number(capped.headers['retry-after'])).toBeGreaterThan(0);

    expect((await probe(app, { token: 'tok:agent-b', bytes: 16 })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/client-config' })).statusCode).toBe(200);
  });
});
