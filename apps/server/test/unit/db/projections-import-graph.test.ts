import { describe, expect, it, vi } from 'vitest';

// The agency repository's projections read whether a carrier's ringing can be cancelled from
// the codec-free declaration (`telephony/carrier-ringing.ts`), never the carrier-module
// registry, which loads every carrier's media codec and the tables it builds at load.
vi.mock('../../../src/telephony/carrier-modules.js', () => {
  throw new Error('the repository projections must not load the carrier modules');
});

describe('agency repository projections', () => {
  it('load without the carrier modules', async () => {
    const projections = await import('../../../src/db/repositories/agency/projections.js');
    expect(typeof projections.projectManualCallRow).toBe('function');
  });
});
