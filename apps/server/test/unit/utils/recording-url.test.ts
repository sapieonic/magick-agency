import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * PORT NOTE (magick-agency): ported from core test/unit/utils/recording-url.test.ts
 * @4850d1d9. The signing secret is `config.recordingUrlSigningSecret` (set through the
 * mocked config) instead of process.env, and core's `config.webhooks.secret`
 * fallback is gone; the suite's cases are unchanged.
 *
 * PORT NOTE (magick-agency, Phase 8): the default `basePath` is agency's only playback route,
 * `/api/v1/webrtc-recordings` (core's AI-calls `/api/v1/recordings` is not ported; lane D review
 * carry-forward). MODIFIED (2): the first two cases assert the new default path.
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { recordingUrlSigningSecret: 'test-secret-do-not-use-in-prod-1234567890' as string | undefined },
}));
vi.mock('../../../src/config/index.js', () => ({ config: mockConfig }));

const { signRecordingUrl, verifyRecordingToken } = await import('../../../src/utils/recording-url.js');

function parseQuery(path: string) {
  const url = new URL(`http://x${path}`);
  return {
    pathname: url.pathname,
    tenant: url.searchParams.get('tenant') ?? undefined,
    account: url.searchParams.get('account') ?? undefined,
    exp: url.searchParams.get('exp') ?? undefined,
    sig: url.searchParams.get('sig') ?? undefined,
  };
}

describe('signRecordingUrl', () => {
  it('returns a path under /api/v1/webrtc-recordings/:id with required query params (agency default)', () => {
    const { path, expiresAt } = signRecordingUrl({
      callId: 'call-abc',
      tenantId: 't1',
      accountId: 'a1',
      ttlSeconds: 600,
    });
    const parsed = parseQuery(path);
    expect(parsed.pathname).toBe('/api/v1/webrtc-recordings/call-abc');
    expect(parsed.tenant).toBe('t1');
    expect(parsed.account).toBe('a1');
    expect(parsed.exp).toBeDefined();
    expect(parsed.sig).toBeDefined();
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('url-encodes call IDs containing special characters', () => {
    const { path } = signRecordingUrl({
      callId: 'call/with spaces',
      tenantId: 't',
      accountId: 'a',
    });
    expect(path).toMatch(/\/api\/v1\/webrtc-recordings\/call%2Fwith%20spaces\?/);
  });

  it('honors a custom basePath (WebRTC playback proxy)', () => {
    const { path } = signRecordingUrl({
      callId: 'wc-1',
      tenantId: 't1',
      accountId: 'a1',
      basePath: '/api/v1/webrtc-recordings',
    });
    expect(parseQuery(path).pathname).toBe('/api/v1/webrtc-recordings/wc-1');
  });

  it('signature is basePath-independent — a WebRTC-issued token verifies', () => {
    // The signature covers callId+tenant+account+exp, not the path, so the shared
    // verifyRecordingToken works for tokens issued under either base path.
    const { path } = signRecordingUrl({
      callId: 'wc-1',
      tenantId: 't1',
      accountId: 'a1',
      basePath: '/api/v1/webrtc-recordings',
    });
    expect(verifyRecordingToken('wc-1', parseQuery(path))).toEqual({ tenantId: 't1', accountId: 'a1' });
  });
});

describe('verifyRecordingToken', () => {
  it('accepts a freshly signed token', () => {
    const { path } = signRecordingUrl({ callId: 'c1', tenantId: 't1', accountId: 'a1' });
    const q = parseQuery(path);
    const result = verifyRecordingToken('c1', q);
    expect(result).toEqual({ tenantId: 't1', accountId: 'a1' });
  });

  it('rejects tokens for a different callId (signature covers callId)', () => {
    const { path } = signRecordingUrl({ callId: 'c1', tenantId: 't1', accountId: 'a1' });
    const q = parseQuery(path);
    expect(verifyRecordingToken('c2', q)).toBeNull();
  });

  it('rejects tokens with a swapped tenant', () => {
    const { path } = signRecordingUrl({ callId: 'c1', tenantId: 't1', accountId: 'a1' });
    const q = parseQuery(path);
    expect(verifyRecordingToken('c1', { ...q, tenant: 't2' })).toBeNull();
  });

  it('rejects tokens with a swapped account', () => {
    const { path } = signRecordingUrl({ callId: 'c1', tenantId: 't1', accountId: 'a1' });
    const q = parseQuery(path);
    expect(verifyRecordingToken('c1', { ...q, account: 'a2' })).toBeNull();
  });

  it('rejects tokens with a tampered signature', () => {
    const { path } = signRecordingUrl({ callId: 'c1', tenantId: 't1', accountId: 'a1' });
    const q = parseQuery(path);
    expect(verifyRecordingToken('c1', { ...q, sig: 'AAAA' })).toBeNull();
  });

  it('rejects tokens missing any required field', () => {
    const { path } = signRecordingUrl({ callId: 'c1', tenantId: 't1', accountId: 'a1' });
    const q = parseQuery(path);
    expect(verifyRecordingToken('c1', { ...q, sig: undefined })).toBeNull();
    expect(verifyRecordingToken('c1', { ...q, exp: undefined })).toBeNull();
    expect(verifyRecordingToken('c1', { ...q, tenant: undefined })).toBeNull();
    expect(verifyRecordingToken('c1', { ...q, account: undefined })).toBeNull();
  });

  it('rejects expired tokens', () => {
    const realNow = Date.now;
    try {
      const { path } = signRecordingUrl({
        callId: 'c1',
        tenantId: 't1',
        accountId: 'a1',
        ttlSeconds: 60,
      });
      const q = parseQuery(path);
      // Jump 2 hours into the future.
      vi.spyOn(Date, 'now').mockReturnValue(realNow() + 2 * 60 * 60 * 1000);
      expect(verifyRecordingToken('c1', q)).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects non-numeric exp values', () => {
    const { path } = signRecordingUrl({ callId: 'c1', tenantId: 't1', accountId: 'a1' });
    const q = parseQuery(path);
    expect(verifyRecordingToken('c1', { ...q, exp: 'not-a-number' })).toBeNull();
  });
});

describe('roundtrip', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('signs and verifies multiple distinct calls without cross-talk', () => {
    const a = signRecordingUrl({ callId: 'c1', tenantId: 't1', accountId: 'a1' });
    const b = signRecordingUrl({ callId: 'c2', tenantId: 't1', accountId: 'a1' });
    const qA = parseQuery(a.path);
    const qB = parseQuery(b.path);
    expect(verifyRecordingToken('c1', qA)).toEqual({ tenantId: 't1', accountId: 'a1' });
    expect(verifyRecordingToken('c2', qB)).toEqual({ tenantId: 't1', accountId: 'a1' });
    // A's token must not authorize B and vice versa.
    expect(verifyRecordingToken('c2', qA)).toBeNull();
    expect(verifyRecordingToken('c1', qB)).toBeNull();
  });
});
