import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/load.js';

/**
 * The config ceilings sized for a full floor (~500 agents, ~50 supervisors, 500
 * concurrent calls; the arithmetic is beside each default in `config/blocks/*.ts`). Pinned
 * so a default cannot drift back to a small-floor value unnoticed, and each stays
 * env-configurable.
 */
const env = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

function parse(extra: Record<string, string> = {}) {
  const result = parseConfig({ ...env, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}

describe('floor-sizing defaults', () => {
  it('MAX_CONCURRENT_CALLS: 1000 by default (a full floor holds ~860 slots at peak), env-configurable, never 0', () => {
    expect(parse().concurrency.maxConcurrentCalls).toBe(1000);
    expect(parse({ MAX_CONCURRENT_CALLS: '550' }).concurrency.maxConcurrentCalls).toBe(550);
    expect(parseConfig({ ...env, MAX_CONCURRENT_CALLS: '0' }).ok).toBe(false);
    expect(parseConfig({ ...env, MAX_CONCURRENT_CALLS: '12.5' }).ok).toBe(false);
  });

  it('DB_POOL_MAX: 30 by default, env-configurable', () => {
    expect(parse().db.poolMax).toBe(30);
    expect(parse({ DB_POOL_MAX: '20' }).db.poolMax).toBe(20);
    expect(parseConfig({ ...env, DB_POOL_MAX: '0' }).ok).toBe(false);
  });

  it('rate limits: sized for ~550 users behind one NAT and ~510 dials a minute, each env-configurable', () => {
    const c = parse();
    expect(c.rateLimit).toMatchObject({
      max: 2000, // unauthenticated per IP: 500 phones × 3 /client-config reads at shift start
      ipAuthMax: 20_000, // a bearer, per IP before auth: the whole signed-in floor (~11 000/min peak)
      webhookMax: 5000, // per carrier IP: ~1700 lifecycle webhooks a minute
      carrierMediaMax: 2000, // per carrier IP: one media upgrade per dial, ~510/min
      stationMax: 3600, // per IP: 500 agents × 6 reconnect rungs in one window
      internalMax: 1000,
      timeWindow: '1 minute',
    });
    expect(c.userRateLimit.max).toBe(600); // per verified user
    const tuned = parse({
      RATE_LIMIT_MAX: '1', RATE_LIMIT_IP_AUTH_MAX: '2', RATE_LIMIT_WEBHOOK_MAX: '3',
      RATE_LIMIT_CARRIER_MEDIA_MAX: '4', RATE_LIMIT_STATION_MAX: '5', RATE_LIMIT_USER_MAX: '6',
    });
    expect(tuned.rateLimit).toMatchObject({ max: 1, ipAuthMax: 2, webhookMax: 3, carrierMediaMax: 4, stationMax: 5 });
    expect(tuned.userRateLimit.max).toBe(6);
  });
});
