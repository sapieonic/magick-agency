// The inbound Application's URLs (`inbound-urls.ts`): built on `PLIVO_WEBHOOK_BASE_URL` as
// written, stored without the token, given to the carrier with it, and the signature's subject
// rebuilt from the STORED URL plus the request's query (never from env).
import { describe, expect, it } from 'vitest';
import {
  inboundSignedUrl,
  plivoInboundAnswerUrl,
  plivoInboundFallbackUrl,
  plivoInboundStatusUrl,
  plivoInboundUrls,
  splitInboundToken,
  withInboundToken,
} from '../../../../src/telephony/plivo/inbound-urls.js';

const CRED = '0f9c2a4e-6b1d-4c3e-9a8f-1b2c3d4e5f60';

describe('inbound URLs', () => {
  it('keeps the base as written (host case, port, path prefix), only trailing slashes stripped', () => {
    const base = 'https://Edge.Example.com:8443/prefix/api/v1/webhooks/plivo//';
    expect(plivoInboundAnswerUrl(base, CRED)).toBe(`https://Edge.Example.com:8443/prefix/api/v1/webhooks/plivo/inbound-answer/${CRED}`);
    expect(plivoInboundStatusUrl(base, CRED)).toBe(`https://Edge.Example.com:8443/prefix/api/v1/webhooks/plivo/inbound-status/${CRED}`);
    expect(plivoInboundFallbackUrl(base)).toBe('https://Edge.Example.com:8443/prefix/api/v1/webhooks/plivo/inbound-fallback');
  });

  it('has no URLs without a base; uses the operator`s fallback (GET) when one is set, else ours (POST)', () => {
    expect(plivoInboundUrls({ webhookBaseUrl: '', inboundFallbackAnswerUrl: 'https://x.test/f.xml' }, CRED)).toBeNull();
    const base = 'https://agency.test/api/v1/webhooks/plivo';
    expect(plivoInboundUrls({ webhookBaseUrl: base, inboundFallbackAnswerUrl: '' }, CRED)).toMatchObject({
      fallbackAnswerUrl: `${base}/inbound-fallback`, fallbackMethod: 'POST',
    });
    expect(plivoInboundUrls({ webhookBaseUrl: base, inboundFallbackAnswerUrl: 'https://static.test/f.xml?v=2' }, CRED)).toMatchObject({
      fallbackAnswerUrl: 'https://static.test/f.xml?v=2', fallbackMethod: 'GET',
    });
  });

  it('adds the token as a query parameter, and splits it back off (other parameters kept, in order)', () => {
    const stored = `https://agency.test/api/v1/webhooks/plivo/inbound-answer/${CRED}`;
    expect(withInboundToken(stored, 'abc_DEF-123')).toBe(`${stored}?token=abc_DEF-123`);
    expect(splitInboundToken(`${stored}?token=abc_DEF-123`)).toEqual({ stored, token: 'abc_DEF-123' });
    expect(splitInboundToken(stored)).toEqual({ stored, token: null });
    expect(splitInboundToken('https://a.test/x?a=1&token=t&b=2')).toEqual({ stored: 'https://a.test/x?a=1&b=2', token: 't' });
    expect(withInboundToken('https://a.test/x?a=1', 't')).toBe('https://a.test/x?a=1&token=t');
    expect(splitInboundToken('not a url')).toBeNull();
  });

  it('the signed URL is the stored one plus the query the request arrived with', () => {
    const stored = `https://Agency.test:8443/p/api/v1/webhooks/plivo/inbound-answer/${CRED}`;
    // The route sees its own path (a proxy may have stripped the prefix): only the query is taken.
    expect(inboundSignedUrl(stored, `/api/v1/webhooks/plivo/inbound-answer/${CRED}?token=t`)).toBe(`${stored}?token=t`);
    expect(inboundSignedUrl(stored, `/api/v1/webhooks/plivo/inbound-answer/${CRED}`)).toBe(stored);
  });
});
