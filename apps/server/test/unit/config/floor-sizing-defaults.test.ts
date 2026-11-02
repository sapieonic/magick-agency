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
});
