// `telephony.plivo` (the voice config block): read from env, defaulted and bounded, and
// what the BYOC factory hands every Plivo adapter.
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../../src/config/load.js';
import { DEFAULT_PLIVO_SETTINGS } from '../../../../src/telephony/plivo/plivo.adapter.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

const plivo = (env: Record<string, string>) => {
  const result = parseConfig({ ...valid, ...env });
  return result.ok ? result.config.telephony.plivo : null;
};

describe('telephony.plivo config', () => {
  it('defaults match the adapter’s own defaults, with no webhook base', () => {
    expect(plivo({})).toEqual(DEFAULT_PLIVO_SETTINGS);
    expect(DEFAULT_PLIVO_SETTINGS).toEqual({
      webhookBaseUrl: '', callsPerSecond: 2, dialRateMaxWaitMs: 5000, requestTimeoutMs: 15000, ringTimeoutSeconds: 45,
    });
  });

  it('reads every key from env', () => {
    expect(plivo({
      PLIVO_WEBHOOK_BASE_URL: 'https://srv.example.com/api/v1/webhooks/plivo',
      PLIVO_CALLS_PER_SECOND: '10',
      PLIVO_DIAL_RATE_MAX_WAIT_MS: '0',
      PLIVO_REQUEST_TIMEOUT_MS: '8000',
      PLIVO_RING_TIMEOUT_SECONDS: '30',
    })).toEqual({
      webhookBaseUrl: 'https://srv.example.com/api/v1/webhooks/plivo',
      callsPerSecond: 10,
      dialRateMaxWaitMs: 0,
      requestTimeoutMs: 8000,
      ringTimeoutSeconds: 30,
    });
  });

  it.each([
    ['PLIVO_CALLS_PER_SECOND', '0'],
    ['PLIVO_CALLS_PER_SECOND', '1.5'],
    ['PLIVO_DIAL_RATE_MAX_WAIT_MS', '-1'],
    ['PLIVO_REQUEST_TIMEOUT_MS', '500'],
    ['PLIVO_RING_TIMEOUT_SECONDS', '600'],
  ])('refuses %s=%s', (key, value) => {
    expect(plivo({ [key]: value })).toBeNull();
  });

  it.each([
    'http://srv.example.com/api/v1/webhooks/plivo',
    'srv.example.com/api/v1/webhooks/plivo',
    '/api/v1/webhooks/plivo',
    'https://srv.example.com/api/v1/webhooks/plivo?x=1',
    'https://srv.example.com/api/v1/webhooks/plivo#frag',
    'https://srv.example.com/api/v1/webhooks/plivo?',
    'not a url',
  ])('refuses PLIVO_WEBHOOK_BASE_URL=%s at load, saying what it must be', (value) => {
    const result = parseConfig({ ...valid, PLIVO_WEBHOOK_BASE_URL: value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.path.join('.') === 'telephony.plivo.webhookBaseUrl');
    expect(issue?.message).toMatch(/PLIVO_WEBHOOK_BASE_URL must be empty or an absolute https: URL with no query or fragment/);
  });

  it('accepts PLIVO_WEBHOOK_BASE_URL empty, or an absolute https: URL (a port, a path prefix, a trailing slash)', () => {
    for (const value of ['', 'https://srv.example.com', 'https://srv.example.com:8443/edge/api/v1/webhooks/plivo/']) {
      expect(plivo({ PLIVO_WEBHOOK_BASE_URL: value })?.webhookBaseUrl).toBe(value);
    }
  });

  it('a production boot does not require Plivo settings (Plivo accounts are tenants’, not env)', () => {
    const result = parseConfig({
      ...valid,
      NODE_ENV: 'production',
      VOICELINK_BASE_URL: 'https://vl.test', VOICELINK_USERNAME: 'u', VOICELINK_PASSWORD: 'p',
      VOICELINK_WEBHOOK_BASE_URL: 'https://srv.test/api/v1/webhooks/voicelink',
    });
    const issues = result.ok ? [] : result.issues.map((i) => i.path.join('.'));
    expect(issues.filter((p) => p.includes('plivo'))).toEqual([]);
  });
});
