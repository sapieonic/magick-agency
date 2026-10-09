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
});
