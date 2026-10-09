// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/api/middleware/headers.test.ts@4850d1d9.
// Only `TENANT_HEADER` is ported, so:
//  - 'defines the exact header-name string for each constant' and 'uses all-lowercase names …'
//    are MODIFIED to assert TENANT_HEADER only (the four other constants are not carried);
//  - 'keeps every header name distinct' is DELETED (one constant, nothing to be distinct from);
//  - 'auth.middleware header re-exports' / 're-exports each header constant identically to
//    headers.ts' is DELETED (auth.middleware is not carried, decision #5), together with the
//    logger/config/api-key-cache/posthog mocks that existed only to import it.
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
