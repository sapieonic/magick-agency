// `TENANT_HEADER` is the only header constant, so these cases assert its exact name and that
// it is lowercase. There are no platform API keys (decision #5), so no auth.middleware
// header re-exports to check.
import { describe, it, expect } from 'vitest';

import * as headers from '../../../../src/api/middleware/headers.js';

describe('headers.ts — canonical header-name constants', () => {
  it('defines the exact header-name string for each constant', () => {
    expect(headers.TENANT_HEADER).toBe('x-mgkvc-tenant');
  });

  it('uses all-lowercase names (Fastify normalizes incoming headers to lowercase)', () => {
    for (const value of [
      headers.TENANT_HEADER,
    ]) {
      expect(value).toBe(value.toLowerCase());
    }
  });
});
