/**
 * The push carriers' credentials (Mode B, `docs/seams.md` §3.6), parsed from the `PUSH_*` env keys
 * by the platform config block (`config/blocks/platform.ts`) so a deployment with a broken key
 * refuses to boot instead of failing its first ring.
 *
 * The private keys are held as `KeyObject`s: `JSON.stringify` renders one as `{}` and
 * `util.inspect` shows only its type, so a config dump never prints key material. A parse failure
 * names the env key and what is wrong with it, never the value.
 */
import { createPrivateKey, type KeyObject } from 'node:crypto';

/** FCM HTTP v1: a Google service account of the Firebase project the Android app is built for. */
export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  /** RSA, signs the OAuth assertion (RS256). */
  privateKey: KeyObject;
}

export const APNS_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];

/** APNs token-based auth: a `.p8` key of the Apple developer team, and the app it pushes to. */
export interface ApnsCredentials {
  /** EC P-256, signs the provider token (ES256). */
  key: KeyObject;
  keyId: string;
  teamId: string;
  /** The app's bundle id; VoIP pushes go to the topic `{bundleId}.voip`. */
  bundleId: string;
  /** Which APNs a token belongs to: a debug build's token is sandbox's, a store build's production's. */
  env: ApnsEnvironment;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Standard or URL-safe base64; whitespace (a wrapped `base64` output) is ignored. */
export function decodeBase64(name: string, raw: string): Parsed<Buffer> {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length === 0 || !BASE64.test(compact)) return { ok: false, message: `${name} is not base64` };
  const bytes = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length === 0) return { ok: false, message: `${name} is not base64` };
  return { ok: true, value: bytes };
}

function privateKeyFrom(bytes: Buffer): KeyObject | null {
  const text = bytes.toString('utf8');
  try {
    if (text.includes('-----BEGIN')) return createPrivateKey({ key: text, format: 'pem' });
    return createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  }
}

const FCM_KEY = 'PUSH_FCM_SERVICE_ACCOUNT_JSON_B64';

/** `PUSH_FCM_SERVICE_ACCOUNT_JSON_B64`: the base64 of the service account's JSON key file. */
export function parseFcmServiceAccount(raw: string): Parsed<FcmCredentials> {
  const decoded = decodeBase64(FCM_KEY, raw);
  if (!decoded.ok) return decoded;
  let json: unknown;
  try {
    json = JSON.parse(decoded.value.toString('utf8'));
  } catch {
    return { ok: false, message: `${FCM_KEY} does not decode to JSON (it must be the base64 of the service account's key file)` };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, message: `${FCM_KEY} does not decode to a JSON object` };
  }
  const account = json as Record<string, unknown>;
  if (account['type'] !== undefined && account['type'] !== 'service_account') {
    return { ok: false, message: `${FCM_KEY} is not a service account key (its "type" is not "service_account")` };
  }
  const missing = ['project_id', 'client_email', 'private_key']
    .filter((field) => typeof account[field] !== 'string' || (account[field] as string).trim() === '');
  if (missing.length > 0) {
    return { ok: false, message: `${FCM_KEY}: the service account JSON has no ${missing.join(', ')}` };
  }
  const privateKey = privateKeyFrom(Buffer.from(account['private_key'] as string, 'utf8'));
  if (!privateKey || privateKey.asymmetricKeyType !== 'rsa') {
    return { ok: false, message: `${FCM_KEY}: the service account's private_key is not an RSA private key in PEM` };
  }
  return {
    ok: true,
    value: {
      projectId: (account['project_id'] as string).trim(),
      clientEmail: (account['client_email'] as string).trim(),
      privateKey,
    },
  };
}

const APNS_KEY = 'PUSH_APNS_KEY_P8_B64';

/** `PUSH_APNS_KEY_P8_B64`: the base64 of the `.p8` file Apple issues (a PKCS#8 EC P-256 key). */
export function parseApnsKey(raw: string): Parsed<KeyObject> {
  const decoded = decodeBase64(APNS_KEY, raw);
  if (!decoded.ok) return decoded;
  const key = privateKeyFrom(decoded.value);
  if (!key) return { ok: false, message: `${APNS_KEY} is not a private key (it must be the base64 of the .p8 file)` };
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return { ok: false, message: `${APNS_KEY} is not an EC P-256 key (an APNs auth key .p8 is one)` };
  }
  return { ok: true, value: key };
}
