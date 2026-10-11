// Envelope encryption for per-tenant carrier credentials (decision B19).
//
// A secret is sealed with AES-256-GCM under a fresh 32-byte data key (DEK); the DEK is
// sealed with AES-256-GCM under a master key (KEK) from the keyring. Both layers bind
// the same context as additional authenticated data, so a ciphertext copied to another
// row, tenant, provider or secret version fails to open. The KEK sits behind
// `KeyWrapper`, which is async so a KMS-backed wrapper can replace the env keyring
// without touching callers or the schema (rows record the key id).
import crypto from 'node:crypto';

/** What a seal is bound to. Every field is part of the AAD. */
export interface SealContext {
  tenantId: string;
  credentialId: string;
  provider: string;
  secretVersion: number;
}

/** A sealed secret as stored: each blob is `nonce(12) ‖ ciphertext ‖ tag(16)`. */
export interface SealedSecret {
  kekId: string;
  wrappedDek: Buffer;
  ciphertext: Buffer;
}

/** Thrown for any failure to open a seal. Deliberately carries no detail about why. */
export class CredentialSealError extends Error {
  constructor(message = 'Telephony credential could not be opened') {
    super(message);
    this.name = 'CredentialSealError';
  }
}

/**
 * Wraps and unwraps data keys under a master key. Key ids are scheme-prefixed
 * (`env:v1`; a KMS wrapper would use its own prefix), and the wrapped blob is opaque,
 * so a different wrap scheme fits the same columns.
 */
export interface KeyWrapper {
  /** The (scheme-prefixed) key id new seals use. */
  readonly activeKeyId: string;
  /** Whether this wrapper can unwrap under a key id (a boot-time keyring check). */
  canUnwrap(kekId: string): boolean;
  wrap(dek: Buffer, aad: Buffer): Promise<{ kekId: string; wrapped: Buffer }>;
  unwrap(kekId: string, wrapped: Buffer, aad: Buffer): Promise<Buffer>;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Bumped only if the seal format itself changes; part of the AAD. */
const SEAL_FORMAT = 'v1';

function gcmSeal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  // A random 96-bit nonce per seal. Every seal also uses a fresh DEK, so a DEK never
  // sees a second nonce; the KEK sees one nonce per seal, far below the 2^32 bound.
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

function gcmOpen(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < NONCE_BYTES + TAG_BYTES) throw new CredentialSealError();
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CredentialSealError();
  }
}

/**
 * The AAD for one seal. Fields are length-prefixed rather than joined with a
 * separator, so no field value can shift a boundary (`a|b` + `c` vs `a` + `b|c`).
 */
export function sealAad(ctx: SealContext, layer: 'secret' | 'dek'): Buffer {
  const parts = [
    'magick-agency/telephony-credential', SEAL_FORMAT, layer,
    ctx.tenantId, ctx.credentialId, ctx.provider, String(ctx.secretVersion),
  ];
  return Buffer.concat(parts.map((p) => {
    const b = Buffer.from(p, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  }));
}

const ENV_SCHEME = 'env:';

/**
 * The env keyring (`TELEPHONY_CREDENTIAL_KEYS`) as a `KeyWrapper`. Keys are listed
 * as `v1:<base64>`; rows record them as `env:v1`.
 */
export class EnvKeyringWrapper implements KeyWrapper {
  private readonly keys: Map<string, Buffer>;
  readonly activeKeyId: string;

  constructor(keyring: string, activeKeyId: string) {
    this.activeKeyId = ENV_SCHEME + activeKeyId;
    this.keys = new Map();
    for (const entry of keyring.split(',').map((s) => s.trim()).filter(Boolean)) {
      const sep = entry.indexOf(':');
      const key = Buffer.from(entry.slice(sep + 1), 'base64');
      if (sep <= 0 || key.length !== KEY_BYTES) throw new Error('Invalid telephony credential keyring entry');
      this.keys.set(ENV_SCHEME + entry.slice(0, sep), key);
    }
    if (!this.keys.has(this.activeKeyId)) throw new Error('Active telephony credential key is not in the keyring');
  }

  canUnwrap(kekId: string): boolean {
    return this.keys.has(kekId);
  }

  async wrap(dek: Buffer, aad: Buffer): Promise<{ kekId: string; wrapped: Buffer }> {
    return { kekId: this.activeKeyId, wrapped: gcmSeal(this.keys.get(this.activeKeyId)!, dek, aad) };
  }

  async unwrap(kekId: string, wrapped: Buffer, aad: Buffer): Promise<Buffer> {
    const kek = this.keys.get(kekId);
    if (!kek) throw new CredentialSealError();
    return gcmOpen(kek, wrapped, aad);
  }
}

export class CredentialSealer {
  constructor(private readonly wrapper: KeyWrapper) {}

  get activeKeyId(): string {
    return this.wrapper.activeKeyId;
  }

  canUnwrap(kekId: string): boolean {
    return this.wrapper.canUnwrap(kekId);
  }

  async seal(secret: Record<string, unknown>, ctx: SealContext): Promise<SealedSecret> {
    const dek = crypto.randomBytes(KEY_BYTES);
    const plaintext = Buffer.from(JSON.stringify(secret), 'utf8');
    try {
      const ciphertext = gcmSeal(dek, plaintext, sealAad(ctx, 'secret'));
      const { kekId, wrapped } = await this.wrapper.wrap(dek, sealAad(ctx, 'dek'));
      return { kekId, wrappedDek: wrapped, ciphertext };
    } finally {
      dek.fill(0);
      plaintext.fill(0);
    }
  }

  async open(sealed: SealedSecret, ctx: SealContext): Promise<Record<string, unknown>> {
    const dek = await this.wrapper.unwrap(sealed.kekId, sealed.wrappedDek, sealAad(ctx, 'dek'));
    let plaintext: Buffer | null = null;
    try {
      plaintext = gcmOpen(dek, sealed.ciphertext, sealAad(ctx, 'secret'));
      const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CredentialSealError();
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw err instanceof CredentialSealError ? err : new CredentialSealError();
    } finally {
      dek.fill(0);
      plaintext?.fill(0);
    }
  }
}
