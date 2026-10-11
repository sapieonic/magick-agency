// The credential seal (decision B19): a sealed secret opens only under the exact
// context it was sealed for, any tampered byte refuses, and a rotated keyring still
// opens rows sealed under an older key id.
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  CredentialSealer, CredentialSealError, EnvKeyringWrapper, sealAad, type SealContext,
} from '../../../src/telephony/credentials/credential-sealer.js';
import { telephonyCredentialsSchema } from '../../../src/config/blocks/voice.js';

const k1 = crypto.randomBytes(32).toString('base64');
const k2 = crypto.randomBytes(32).toString('base64');
const CTX: SealContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
  provider: 'plivo',
  secretVersion: 1,
};
const SECRET = { auth_token: 'tok_canary_9f3b' };

function sealer(keyring = `v1:${k1}`, active = 'v1'): CredentialSealer {
  return new CredentialSealer(new EnvKeyringWrapper(keyring, active));
}

describe('CredentialSealer', () => {
  it('round-trips a secret and never stores it in the clear', async () => {
    const s = sealer();
    const sealed = await s.seal(SECRET, CTX);
    expect(sealed.kekId).toBe('env:v1');
    expect(sealed.ciphertext.toString('latin1')).not.toContain('tok_canary');
    expect(sealed.wrappedDek.length).toBe(12 + 32 + 16);
    expect(await s.open(sealed, CTX)).toEqual(SECRET);
  });

  it('uses a fresh nonce and data key per seal', async () => {
    const s = sealer();
    const a = await s.seal(SECRET, CTX);
    const b = await s.seal(SECRET, CTX);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.subarray(0, 12).equals(b.wrappedDek.subarray(0, 12))).toBe(false);
  });

  it.each<[string, Partial<SealContext>]>([
    ['another tenant', { tenantId: '33333333-3333-4333-8333-333333333333' }],
    ['another credential row', { credentialId: '44444444-4444-4444-8444-444444444444' }],
    ['another provider', { provider: 'twilio' }],
    ['an older secret version', { secretVersion: 0 }],
  ])('refuses to open under %s', async (_label, change) => {
    const s = sealer();
    const sealed = await s.seal(SECRET, CTX);
    await expect(s.open(sealed, { ...CTX, ...change })).rejects.toBeInstanceOf(CredentialSealError);
  });

  it('refuses a data key swapped in from another seal', async () => {
    const s = sealer();
    const a = await s.seal(SECRET, CTX);
    const b = await s.seal({ auth_token: 'other' }, CTX);
    await expect(s.open({ ...a, wrappedDek: b.wrappedDek }, CTX)).rejects.toBeInstanceOf(CredentialSealError);
  });

  it.each(['ciphertext', 'wrappedDek'] as const)('refuses a flipped byte in %s', async (field) => {
    const s = sealer();
    const sealed = await s.seal(SECRET, CTX);
    for (const at of [0, 12, sealed[field].length - 1]) {
      const bad = Buffer.from(sealed[field]);
      bad[at] = bad[at]! ^ 0x01;
      await expect(s.open({ ...sealed, [field]: bad }, CTX)).rejects.toBeInstanceOf(CredentialSealError);
    }
  });

  it('refuses a truncated blob and an unknown key id', async () => {
    const s = sealer();
    const sealed = await s.seal(SECRET, CTX);
    await expect(s.open({ ...sealed, ciphertext: Buffer.alloc(10) }, CTX)).rejects.toBeInstanceOf(CredentialSealError);
    await expect(s.open({ ...sealed, kekId: 'env:v9' }, CTX)).rejects.toBeInstanceOf(CredentialSealError);
    // A bare id without its scheme is not a key this wrapper holds.
    await expect(s.open({ ...sealed, kekId: 'v1' }, CTX)).rejects.toBeInstanceOf(CredentialSealError);
  });

  it('opens a row sealed under a retired-but-listed key after rotation, and seals new ones under the active key', async () => {
    const old = await sealer(`v1:${k1}`, 'v1').seal(SECRET, CTX);
    const rotated = sealer(`v1:${k1},v2:${k2}`, 'v2');
    expect(await rotated.open(old, CTX)).toEqual(SECRET);
    expect((await rotated.seal(SECRET, CTX)).kekId).toBe('env:v2');
    expect(rotated.canUnwrap('env:v1')).toBe(true);
    expect(rotated.canUnwrap('v1')).toBe(false);
    // Once v1 is dropped from the keyring, its rows no longer open.
    await expect(sealer(`v2:${k2}`, 'v2').open(old, CTX)).rejects.toBeInstanceOf(CredentialSealError);
  });

  it('error messages carry no secret or key material', async () => {
    const s = sealer();
    const sealed = await s.seal(SECRET, CTX);
    const err = await s.open(sealed, { ...CTX, secretVersion: 2 }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toMatch(/tok_canary|v1:/);
  });

  it('length-prefixes AAD fields so no value can shift a boundary', () => {
    const a = sealAad({ ...CTX, tenantId: 'a|b', credentialId: 'c' }, 'secret');
    const b = sealAad({ ...CTX, tenantId: 'a', credentialId: 'b|c' }, 'secret');
    expect(a.equals(b)).toBe(false);
    expect(sealAad(CTX, 'secret').equals(sealAad(CTX, 'dek'))).toBe(false);
  });
});

describe('telephonyCredentials config', () => {
  const parse = (keyring?: string, activeKeyId?: string) =>
    telephonyCredentialsSchema.safeParse({ keyring, activeKeyId });

  it('is optional: unset means no credential store', () => {
    expect(parse().success).toBe(true);
  });

  it('accepts a valid keyring with the active key listed', () => {
    expect(parse(`v1:${k1}, v2:${k2}`, 'v2').success).toBe(true);
  });

  it.each([
    ['active key missing', `v1:${k1}`, undefined],
    ['active key not listed', `v1:${k1}`, 'v2'],
    ['short key', `v1:${crypto.randomBytes(16).toString('base64')}`, 'v1'],
    ['bad id', `V 1:${k1}`, 'V 1'],
    ['duplicate id', `v1:${k1},v1:${k2}`, 'v1'],
    ['active without keyring', '', 'v1'],
  ])('refuses %s, without echoing key material', (_label, keyring, active) => {
    const r = parse(keyring, active);
    expect(r.success).toBe(false);
    const text = JSON.stringify(r.error?.issues);
    expect(text).not.toContain(k1);
    expect(text).not.toContain(k2);
  });
});
