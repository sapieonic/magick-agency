import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/load.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

describe('parseConfig', () => {
  it('parses a minimal environment with agency defaults', () => {
    const result = parseConfig(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.server.port).toBe(3021);
    expect(result.config.db.url).toBe(valid.DATABASE_URL);
  });

  it('agency.insightsRollup: 15 s and 200 buckets by default, read from the env, bounded', () => {
    const rollup = (env: Record<string, string>) => {
      const result = parseConfig({ ...valid, ...env });
      return result.ok ? result.config.agency.insightsRollup : null;
    };
    expect(rollup({})).toEqual({ intervalMs: 15_000, batchSize: 200 });
    expect(rollup({ AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS: '30000', AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE: '50' }))
      .toEqual({ intervalMs: 30_000, batchSize: 50 });
    expect(rollup({ AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS: '10' })).toBeNull();
    expect(rollup({ AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE: '0' })).toBeNull();
    expect(rollup({ AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE: 'many' })).toBeNull();
  });

  it('reports every missing required value', () => {
    const result = parseConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['db.url', 'redis.url']));
  });

  it('rejects an invalid NODE_ENV', () => {
    const result = parseConfig({ ...valid, NODE_ENV: 'staging' });
    expect(result.ok).toBe(false);
  });

  it('READYZ_DETAIL_TOKEN: unset or blank is off; set must be at least 32 characters', () => {
    const token = (env: Record<string, string>) => {
      const result = parseConfig({ ...valid, ...env });
      return result.ok ? { ok: true, token: result.config.server.readyzDetailToken } : { ok: false };
    };
    expect(token({})).toEqual({ ok: true, token: undefined });
    expect(token({ READYZ_DETAIL_TOKEN: '  ' })).toEqual({ ok: true, token: undefined });
    expect(token({ READYZ_DETAIL_TOKEN: 'short' })).toEqual({ ok: false });
    expect(token({ READYZ_DETAIL_TOKEN: 'x'.repeat(32) })).toEqual({ ok: true, token: 'x'.repeat(32) });
  });
});
