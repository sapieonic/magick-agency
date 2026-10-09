import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { parseConfig } from '../../../src/config/load.js';
import { recordingHostMatches } from '../../../src/utils/recording-proxy.js';
import { hopCountTrust } from '../../../src/app.js';

/**
 * The config rulings recorded in docs/decisions.md:
 *  - Q7/Q9 `TRUST_PROXY_HOPS`: default 1, never 0 / blank / `true`;
 *    `hopCountTrust` gives `request.ip` exactly N hops;
 *  - Q1 `DB_SSL_REJECT_UNAUTHORIZED` / `DB_SSL_CA`: verify by default, strict opt-out,
 *    PEM contents only; TLS parameters in `DATABASE_URL` are refused (pg would let them
 *    override the verified settings);
 *  - `VOICELINK_RECORDING_HOSTS`: unset → VoiceLink's recording host, set (even empty) →
 *    exactly that list; the real recording URL passes, lookalikes do not;
 *  - `AGENCY_TRANSCRIPT_RETENTION_DAYS`: 30 days by default (with the
 *    `DIALER_TRANSCRIPT_RETENTION_DAYS` fallback); `AGENCY_RETENTION_DAYS` stays unset and
 *    floored by `RETENTION_MIN_DAYS`.
 */

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

function parse(extra: Record<string, string> = {}) {
  const r = parseConfig({ ...base, ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.config;
}

function refused(extra: Record<string, string>): string[] {
  const r = parseConfig({ ...base, ...extra });
  if (r.ok) return [];
  return r.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('Q7/Q9: TRUST_PROXY_HOPS', () => {
  it('defaults to 1', () => {
    expect(parse().server.trustProxyHops).toBe(1);
  });

  it('takes a count', () => {
    expect(parse({ TRUST_PROXY_HOPS: '2' }).server.trustProxyHops).toBe(2);
  });

  it.each([['0'], [''], ['true'], ['-1'], ['1.5']])('refuses %j at boot (never 0, never a boolean)', (value) => {
    expect(refused({ TRUST_PROXY_HOPS: value }).some((m) => m.startsWith('server.trustProxyHops'))).toBe(true);
  });

  it('hopCountTrust(1): request.ip is the entry the proxy appended; a spoofed leftmost entry is ignored', async () => {
    const app = Fastify({ trustProxy: hopCountTrust(1) });
    app.get('/ip', async (r) => ({ ip: r.ip }));
    const ip = async (xff: string) =>
      (await app.inject({ method: 'GET', url: '/ip', remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': xff } })).json().ip;
    expect(await ip('203.0.113.7')).toBe('203.0.113.7');
    expect(await ip('6.6.6.6, 203.0.113.7')).toBe('203.0.113.7');
    await app.close();
  });

  it('a bare numeric trustProxy fails closed on this Fastify — why app.ts passes hopCountTrust', async () => {
    // Fastify 5.12 treats a hop COUNT as untrusted ("cannot validate the immediate peer"), so
    // `trustProxy: hops` would leave request.ip at the socket peer here.
    // Its types no longer accept a number either (hence the cast).
    const app = Fastify({ trustProxy: 1 as unknown as boolean });
    app.get('/ip', async (r) => ({ ip: r.ip }));
    const res = await app.inject({ method: 'GET', url: '/ip', remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(res.json().ip).toBe('10.0.0.5');
    await app.close();
  });
});

describe('Q1: Postgres TLS verification', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----';

  it('verifies by default, with no CA (Node roots)', () => {
    const db = parse().db;
    expect(db.sslRejectUnauthorized).toBe(true);
    expect(db.sslCa).toBeUndefined();
  });

  it('opts out only on an explicit false', () => {
    expect(parse({ DB_SSL_REJECT_UNAUTHORIZED: 'false' }).db.sslRejectUnauthorized).toBe(false);
    expect(parse({ DB_SSL_REJECT_UNAUTHORIZED: 'true' }).db.sslRejectUnauthorized).toBe(true);
  });

  it.each([[''], ['0'], ['no'], ['False ']])('refuses DB_SSL_REJECT_UNAUTHORIZED=%j rather than guessing', (value) => {
    expect(refused({ DB_SSL_REJECT_UNAUTHORIZED: value }).some((m) => m.startsWith('db.sslRejectUnauthorized'))).toBe(true);
  });

  it('DB_SSL_CA takes PEM text, with literal \\n sequences turned into newlines', () => {
    expect(parse({ DB_SSL_CA: PEM }).db.sslCa).toBe(PEM);
    expect(parse({ DB_SSL_CA: PEM.replace(/\n/g, '\\n') }).db.sslCa).toBe(PEM);
  });

  it.each([
    ['sslmode=require'], ['ssl=true'], ['sslrootcert=/etc/ca.pem'], ['sslcert=/c.pem'], ['sslkey=/k.pem'],
    ['sslnegotiation=direct'],
    ['SSLMode=disable'], ['application_name=x&sslmode=no-verify'],
  ])('refuses DATABASE_URL carrying the TLS parameter %j (it would override the verified settings)', (query) => {
    const issues = refused({ DATABASE_URL: `${base.DATABASE_URL}?${query}` });
    expect(issues.some((m) => m.startsWith('db.url') && m.includes('DB_SSL_CA'))).toBe(true);
  });

  it('accepts a DATABASE_URL with non-TLS parameters', () => {
    expect(parse({ DATABASE_URL: `${base.DATABASE_URL}?application_name=agency` }).db.url).toContain('application_name');
  });

  it('DB_SSL_CA refuses a file path (contents, not a path) and treats blank as unset', () => {
    expect(refused({ DB_SSL_CA: '/etc/ssl/certs/rds-ca.pem' }).some((m) => m.startsWith('db.sslCa'))).toBe(true);
    expect(parse({ DB_SSL_CA: '   ' }).db.sslCa).toBeUndefined();
  });
});

describe('VOICELINK_RECORDING_HOSTS', () => {
  const REAL = 'https://recording.app.voicelink.co.in/client_1150/2026-10-09/233ac831-e07e-45e1-92c0-643b919ba5c5.mp3';

  it('unset → VoiceLink\'s recording host', () => {
    expect(parse().voicelinkRecording.allowedHosts).toEqual(['recording.app.voicelink.co.in']);
  });

  it('explicitly empty → the empty list (every recording fetch refused: fail closed)', () => {
    const hosts = parse({ VOICELINK_RECORDING_HOSTS: '' }).voicelinkRecording.allowedHosts;
    expect(hosts).toEqual([]);
    expect(recordingHostMatches(REAL, hosts)).toBe(false);
  });

  it('a set list replaces the default', () => {
    expect(parse({ VOICELINK_RECORDING_HOSTS: 'rec.example.test' }).voicelinkRecording.allowedHosts).toEqual(['rec.example.test']);
  });

  it('a real VoiceLink recording URL passes the host check with the default', () => {
    expect(recordingHostMatches(REAL, parse().voicelinkRecording.allowedHosts)).toBe(true);
  });

  it.each([
    ['a lookalike suffix host', 'https://recording.app.voicelink.co.in.evil.test/client_1150/x.mp3'],
    ['the host only in the path', 'https://evil.test/recording.app.voicelink.co.in/client_1150/x.mp3'],
    ['the host only in userinfo', 'https://recording.app.voicelink.co.in@evil.test/x.mp3'],
    ['a sibling host', 'https://app.voicelink.co.in/client_1150/x.mp3'],
    ['plain http', 'http://recording.app.voicelink.co.in/client_1150/x.mp3'],
  ])('refuses %s', (_label, url) => {
    expect(recordingHostMatches(url, parse().voicelinkRecording.allowedHosts)).toBe(false);
  });
});

describe('analysis retention defaults', () => {
  it('transcripts default to 30 days; rows are kept (no default row window)', () => {
    const r = parse().retention;
    expect(r.agencyTranscriptRetentionDays).toBe(30);
    expect(r.agencyRetentionDays).toBeUndefined();
  });

  it('keeps the fallback order: AGENCY_TRANSCRIPT_RETENTION_DAYS, else DIALER_TRANSCRIPT_RETENTION_DAYS', () => {
    expect(parse({ DIALER_TRANSCRIPT_RETENTION_DAYS: '14' }).retention.agencyTranscriptRetentionDays).toBe(14);
    expect(parse({ DIALER_TRANSCRIPT_RETENTION_DAYS: '14', AGENCY_TRANSCRIPT_RETENTION_DAYS: '7' }).retention.agencyTranscriptRetentionDays).toBe(7);
  });

  it('the RETENTION_MIN_DAYS floor still refuses a short row window at boot', () => {
    expect(refused({ AGENCY_RETENTION_DAYS: '4' }).some((m) => m.startsWith('retention.agencyRetentionDays'))).toBe(true);
    expect(parse({ AGENCY_RETENTION_DAYS: '30' }).retention.agencyRetentionDays).toBe(30);
  });
});
