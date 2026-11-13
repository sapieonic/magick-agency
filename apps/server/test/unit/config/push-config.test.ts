import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/load.js';

// The `push` block (`PUSH_*`, config/blocks/platform.ts; docs/seams.md §2 and §3.6): each carrier's
// credentials are parsed into keys at load, so a broken one fails boot with a message naming the
// env key and what is wrong, never its value.

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ec384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
const pem = (key: typeof rsa.privateKey) => key.export({ format: 'pem', type: 'pkcs8' }).toString();
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

const ACCOUNT = {
  type: 'service_account',
  project_id: 'agent-app-123',
  private_key_id: 'abc',
  private_key: pem(rsa.privateKey),
  client_email: 'push@agent-app-123.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};
const FCM_B64 = b64(JSON.stringify(ACCOUNT));

const APNS = {
  PUSH_APNS_KEY_P8_B64: b64(pem(ec.privateKey)),
  PUSH_APNS_KEY_ID: 'ABCDE12345',
  PUSH_APNS_TEAM_ID: 'TEAM123456',
  PUSH_APNS_BUNDLE_ID: 'com.magickagency.agent',
  PUSH_APNS_ENV: 'production',
};

function push(env: Record<string, string>) {
  const result = parseConfig({ ...base, ...env });
  return result.ok ? result.config.push : null;
}

function issues(env: Record<string, string>): string[] {
  const result = parseConfig({ ...base, ...env });
  return result.ok ? [] : result.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('config.push', () => {
  it('is empty when no PUSH_* key is set (an empty value counts as unset)', () => {
    expect(push({})).toEqual({});
    expect(push({ PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: '', PUSH_APNS_KEY_ID: '' })).toEqual({});
  });

  describe('fcm (PUSH_FCM_SERVICE_ACCOUNT_JSON_B64)', () => {
    it('parses the service account to its project id, client email and RSA key; nothing else is kept', () => {
      const fcm = push({ PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: FCM_B64 })?.fcm;
      expect(fcm).toBeDefined();
      expect(Object.keys(fcm!).sort()).toEqual(['clientEmail', 'privateKey', 'projectId']);
      expect(fcm!.projectId).toBe('agent-app-123');
      expect(fcm!.clientEmail).toBe('push@agent-app-123.iam.gserviceaccount.com');
      expect(fcm!.privateKey.asymmetricKeyType).toBe('rsa');
      expect(fcm!.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()).toBe(ACCOUNT.private_key);
    });

    it('takes wrapped base64 (base64 without -w0) and URL-safe base64', () => {
      const wrapped = FCM_B64.replace(/(.{76})/g, '$1\n');
      expect(push({ PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: wrapped })?.fcm?.projectId).toBe('agent-app-123');
      const urlSafe = Buffer.from(JSON.stringify(ACCOUNT)).toString('base64url');
      expect(push({ PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: urlSafe })?.fcm?.projectId).toBe('agent-app-123');
    });

    const PATH = 'push.fcm.serviceAccountJsonB64';
    it.each([
      ['not base64', '%%% not base64 %%%', 'PUSH_FCM_SERVICE_ACCOUNT_JSON_B64 is not base64'],
      ['not JSON', b64('project_id=x'), 'PUSH_FCM_SERVICE_ACCOUNT_JSON_B64 does not decode to JSON (it must be the base64 of the service account\'s key file)'],
      ['a JSON array', b64('[1,2]'), 'PUSH_FCM_SERVICE_ACCOUNT_JSON_B64 does not decode to a JSON object'],
      ['another kind of credential', b64(JSON.stringify({ ...ACCOUNT, type: 'authorized_user' })), 'PUSH_FCM_SERVICE_ACCOUNT_JSON_B64 is not a service account key (its "type" is not "service_account")'],
      ['no client_email', b64(JSON.stringify({ ...ACCOUNT, client_email: undefined })), 'PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: the service account JSON has no client_email'],
      ['no project_id or private_key', b64(JSON.stringify({ type: 'service_account', client_email: 'a@b', project_id: ' ' })), 'PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: the service account JSON has no project_id, private_key'],
      ['a private_key that is not a key', b64(JSON.stringify({ ...ACCOUNT, private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' })), 'PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: the service account\'s private_key is not an RSA private key in PEM'],
      ['an EC private_key', b64(JSON.stringify({ ...ACCOUNT, private_key: pem(ec.privateKey) })), 'PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: the service account\'s private_key is not an RSA private key in PEM'],
    ])('refuses %s, naming the key and never the value', (_label, value, message) => {
      const found = issues({ PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: value });
      expect(found).toEqual([`${PATH}: ${message}`]);
      expect(found.join('\n')).not.toContain(value);
    });
  });

  describe('apns (PUSH_APNS_*)', () => {
    it('parses all five: the .p8 to an EC P-256 key, the ids, the bundle and the environment', () => {
      const apns = push(APNS)?.apns;
      expect(apns).toBeDefined();
      expect(Object.keys(apns!).sort()).toEqual(['bundleId', 'env', 'key', 'keyId', 'teamId']);
      expect(apns!.key.asymmetricKeyType).toBe('ec');
      expect(apns!.key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
      expect(apns).toMatchObject({ keyId: 'ABCDE12345', teamId: 'TEAM123456', bundleId: 'com.magickagency.agent', env: 'production' });
      expect(push({ ...APNS, PUSH_APNS_ENV: 'sandbox' })?.apns?.env).toBe('sandbox');
    });

    it('takes the key as the base64 of the PEM .p8 or of its DER', () => {
      const der = ec.privateKey.export({ format: 'der', type: 'pkcs8' });
      expect(push({ ...APNS, PUSH_APNS_KEY_P8_B64: b64(der) })?.apns?.key.asymmetricKeyType).toBe('ec');
    });

    it('a partial set fails naming each missing key', () => {
      expect(issues({ PUSH_APNS_KEY_ID: 'ABCDE12345' })).toEqual([
        'push.apns.keyP8B64: PUSH_APNS_KEY_P8_B64 is required when any PUSH_APNS_* key is set',
        'push.apns.teamId: PUSH_APNS_TEAM_ID is required when any PUSH_APNS_* key is set',
        'push.apns.bundleId: PUSH_APNS_BUNDLE_ID is required when any PUSH_APNS_* key is set',
        'push.apns.env: PUSH_APNS_ENV must be sandbox or production (required when any PUSH_APNS_* key is set)',
      ]);
    });

    it.each([
      ['PUSH_APNS_KEY_P8_B64', 'not base64', '%%%', 'push.apns.keyP8B64: PUSH_APNS_KEY_P8_B64 is not base64'],
      ['PUSH_APNS_KEY_P8_B64', 'not a key', b64('hello'), 'push.apns.keyP8B64: PUSH_APNS_KEY_P8_B64 is not a private key (it must be the base64 of the .p8 file)'],
      ['PUSH_APNS_KEY_P8_B64', 'an RSA key', b64(pem(rsa.privateKey)), 'push.apns.keyP8B64: PUSH_APNS_KEY_P8_B64 is not an EC P-256 key (an APNs auth key .p8 is one)'],
      ['PUSH_APNS_KEY_P8_B64', 'a P-384 key', b64(pem(ec384.privateKey)), 'push.apns.keyP8B64: PUSH_APNS_KEY_P8_B64 is not an EC P-256 key (an APNs auth key .p8 is one)'],
      ['PUSH_APNS_KEY_ID', 'a short key id', 'ABC', 'push.apns.keyId: PUSH_APNS_KEY_ID must be the 10-character key id of the .p8 key'],
      ['PUSH_APNS_TEAM_ID', 'a lower-case team id', 'team123456', 'push.apns.teamId: PUSH_APNS_TEAM_ID must be the 10-character Apple team id'],
      ['PUSH_APNS_BUNDLE_ID', 'a bundle id that is not reverse DNS', 'agent', 'push.apns.bundleId: PUSH_APNS_BUNDLE_ID must be the app\'s bundle id (reverse DNS)'],
      ['PUSH_APNS_BUNDLE_ID', 'the VoIP topic in place of the bundle id', 'com.magickagency.agent.voip', 'push.apns.bundleId: PUSH_APNS_BUNDLE_ID is the bundle id without .voip (the VoIP topic adds it)'],
      ['PUSH_APNS_ENV', 'an unknown environment', 'development', 'push.apns.env: PUSH_APNS_ENV must be sandbox or production (required when any PUSH_APNS_* key is set)'],
    ])('%s: refuses %s', (key, _label, value, message) => {
      const found = issues({ ...APNS, [key]: value });
      expect(found).toEqual([message]);
    });
  });

  it('both platforms at once; a config dump never prints key material', () => {
    const config = push({ PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: FCM_B64, ...APNS });
    expect(config?.fcm?.projectId).toBe('agent-app-123');
    expect(config?.apns?.keyId).toBe('ABCDE12345');
    for (const dump of [JSON.stringify(config), inspect(config, { depth: 10 })]) {
      expect(dump).not.toContain('PRIVATE KEY');
      expect(dump).not.toContain(FCM_B64.slice(0, 40));
      expect(dump).not.toContain(APNS.PUSH_APNS_KEY_P8_B64.slice(0, 40));
    }
  });
});
