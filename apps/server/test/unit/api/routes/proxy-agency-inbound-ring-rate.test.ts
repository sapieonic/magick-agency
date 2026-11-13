import { describe, expect, it } from 'vitest';
import { ringTokenRateKey } from '../../../../src/api/routes/proxy-agency-inbound-ring.routes.js';

// The token-only ring routes' rate-limit bucket: per IP and call for a call this process rings, so
// agents behind one carrier NAT never spend each other's answers; one per IP for any other id.
describe('ringTokenRateKey', () => {
  const ringing = '7d2b9e4f-6a1c-4e3d-8b5a-2f9c0e1d7a64';
  const tenancy = (id: string) => (id === ringing ? { tenantId: 't', accountId: 'a' } : null);

  it('a ringing call gets its own bucket per IP, whatever the id\'s case', () => {
    expect(ringTokenRateKey('10.0.0.1', ringing, tenancy)).toBe(`ring:10.0.0.1:${ringing}`);
    expect(ringTokenRateKey('10.0.0.1', ringing.toUpperCase(), tenancy)).toBe(`ring:10.0.0.1:${ringing}`);
    expect(ringTokenRateKey('10.0.0.2', ringing, tenancy)).toBe(`ring:10.0.0.2:${ringing}`);
  });

  it('every other id (unknown, malformed, missing) shares the IP\'s one bucket: the flood cap', () => {
    expect(ringTokenRateKey('10.0.0.1', 'e5d4c3b2-0a9f-4e8d-9c7b-6a5f4e3d2c1b', tenancy)).toBe('ring:10.0.0.1');
    expect(ringTokenRateKey('10.0.0.1', 'not-a-uuid', tenancy)).toBe('ring:10.0.0.1');
    expect(ringTokenRateKey('10.0.0.1', undefined, tenancy)).toBe('ring:10.0.0.1');
  });
});
