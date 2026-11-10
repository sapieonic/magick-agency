import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashInboundToken, mintInboundToken } from '../../../../src/telephony/plivo/inbound-token.js';

describe('the inbound purpose token (docs/inbound.md §3.1)', () => {
  it('is 256 random bits, URL-safe as it is, and different every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { token } = mintInboundToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(encodeURIComponent(token)).toBe(token);
      seen.add(token);
    }
    expect(seen.size).toBe(50);
  });

  it('is stored only as sha256 hex, the shape the credential CHECK holds it to', () => {
    const { token, tokenHash } = mintInboundToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashInboundToken(token)).toBe(tokenHash);
    expect(tokenHash).not.toContain(token);
  });
});
