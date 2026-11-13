import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64url, signJwt } from '../../../../src/notifications/push/jwt.js';

// The two JWTs the push carriers take (src/notifications/push/jwt.ts): RS256 (Google's OAuth
// assertion) and ES256 (the APNs provider token, whose signature must be the raw r || s).

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function parts(jwt: string) {
  const [h, c, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c!, 'base64url').toString('utf8')) as Record<string, unknown>,
    input: `${h}.${c}`,
    signature: Buffer.from(s!, 'base64url'),
    raw: [h!, c!, s!],
  };
}

describe('signJwt', () => {
  it('RS256: three base64url parts, alg in the header, the claims as given, a signature the public key verifies', () => {
    const jwt = signJwt('RS256', { typ: 'JWT' }, { iss: 'a@b', iat: 1, exp: 3601 }, rsa.privateKey);
    const p = parts(jwt);
    expect(p.raw.every((part) => /^[A-Za-z0-9_-]+$/.test(part))).toBe(true);
    expect(p.header).toEqual({ typ: 'JWT', alg: 'RS256' });
    expect(p.claims).toEqual({ iss: 'a@b', iat: 1, exp: 3601 });
    expect(p.signature).toHaveLength(256);
    expect(verify('sha256', Buffer.from(p.input), rsa.publicKey, p.signature)).toBe(true);
    // Tampered claims no longer verify.
    const forged = `${p.raw[0]}.${base64url(JSON.stringify({ iss: 'x@y', iat: 1, exp: 3601 }))}`;
    expect(verify('sha256', Buffer.from(forged), rsa.publicKey, p.signature)).toBe(false);
  });

  it('ES256: kid in the header, a 64-byte raw r || s signature (JOSE), verifiable as ieee-p1363', () => {
    const jwt = signJwt('ES256', { kid: 'ABCDE12345' }, { iss: 'TEAM123456', iat: 1_700_000_000 }, ec.privateKey);
    const p = parts(jwt);
    expect(p.header).toEqual({ kid: 'ABCDE12345', alg: 'ES256' });
    expect(p.claims).toEqual({ iss: 'TEAM123456', iat: 1_700_000_000 });
    expect(p.signature).toHaveLength(64);
    expect(verify('sha256', Buffer.from(p.input), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, p.signature)).toBe(true);
  });

  it('the header cannot override alg', () => {
    const jwt = signJwt('ES256', { alg: 'none' }, { iss: 't' }, ec.privateKey);
    expect(parts(jwt).header['alg']).toBe('ES256');
  });
});
