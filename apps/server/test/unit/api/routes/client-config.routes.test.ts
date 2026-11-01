import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { parseConfig } from '../../../../src/config/load.js';

/**
 * `GET /client-config` (public, the mobile app's version gate) and the `MOBILE_*` / rate-limit
 * keys it and the per-user bucket read from config:
 *  - the defaults (`0.1.0` / `0.1.0`, no store links) through the REAL app, unauthenticated,
 *    charged to the app-scope `ip` bucket like any public request;
 *  - configured versions and https store links reach the body; one link alone is one key;
 *  - versions are `MAJOR.MINOR.PATCH` only, a store link is https only, and a minimum newer
 *    than the latest is refused at boot (a dirty parse must not throw in the comparison);
 *  - `RATE_LIMIT_USER_MAX` (platform block, default 300) and `RATE_LIMIT_IP_AUTH_MAX`
 *    (voice block's `rateLimit`, default 3000).
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildApp } from '../../../../src/app.js';
import { clientConfigRoutes } from '../../../../src/api/routes/client-config.routes.js';

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
      expect(res.headers['x-ratelimit-limit']).toBe('200');
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
  it('defaults the per-user bucket to 300 and the bearer IP bucket to 3000', () => {
    const config = parse();
    expect(config.userRateLimit.max).toBe(300);
    expect(config.rateLimit.ipAuthMax).toBe(3000);
    expect(config.rateLimit.max).toBe(200);
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
