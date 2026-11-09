// The Plivo adapter's inbound REST calls against a fake `fetch`: how each failure is read
// (`PlivoApiError` kinds), the 404s each operation reads as an answer, that a malformed id or
// number never reaches a URL, and the find-by-name paging. The request and response shapes
// themselves are pinned by the carrier fixture (`plivo-carrier.fixture.test.ts`, `inbound`).
import { describe, expect, it, vi } from 'vitest';

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { DEFAULT_PLIVO_SETTINGS, PlivoAdapter, type PlivoFetch } from '../../../../src/telephony/plivo/plivo.adapter.js';
import { Secret } from '../../../../src/telephony/credentials/secret.js';
import { PLIVO_APPLICATIONS_MAX_PAGES, PlivoApiError } from '../../../../src/telephony/plivo/plivo-inbound.wire.js';

const URLS = {
  answerUrl: 'https://a.test/api/v1/webhooks/plivo/inbound-answer/c', hangupUrl: 'https://a.test/api/v1/webhooks/plivo/inbound-status/c',
  fallbackAnswerUrl: 'https://a.test/api/v1/webhooks/plivo/inbound-fallback', fallbackMethod: 'POST' as const,
};

function adapter(responses: Array<{ status: number; body?: unknown } | Error>, webhookBaseUrl = '') {
  const sent: string[] = [];
  const fetchImpl: PlivoFetch = async (url) => {
    sent.push(url);
    const r = responses.shift();
    if (!r) throw new Error('no scripted response');
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => (r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return {
    sent,
    plivo: new PlivoAdapter({
      ...DEFAULT_PLIVO_SETTINGS, authId: 'MAABCDEFGHIJKLMNOPQR', authToken: new Secret('fixtureAuthToken-0001'), fetchImpl, webhookBaseUrl,
    }),
  };
}

const kindOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof PlivoApiError ? e.kind : `other:${String(e)}`));

describe('PlivoAdapter inbound calls', () => {
  it.each([
    [401, 'auth_rejected'], [403, 'auth_rejected'], [429, 'unreachable'], [500, 'unreachable'], [503, 'unreachable'], [400, 'refused'], [422, 'refused'],
  ])('HTTP %i is %s', async (status, kind) => {
    expect(await kindOf(adapter([{ status }]).plivo.createInboundApplication('n', URLS, 't'))).toBe(kind);
    expect(await kindOf(adapter([{ status }]).plivo.setNumberApp('+14155550101', 'app-1'))).toBe(kind);
  });

  it('a network failure or timeout is unreachable; an unreadable 2xx is refused', async () => {
    expect(await kindOf(adapter([new TypeError('fetch failed')]).plivo.getInboundApplication('app-1'))).toBe('unreachable');
    expect(await kindOf(adapter([{ status: 201, body: '<html>' }]).plivo.createInboundApplication('n', URLS, 't'))).toBe('refused');
    expect(await kindOf(adapter([{ status: 200, body: { nothing: true } }]).plivo.getNumberApp('+14155550101'))).toBe('refused');
  });

  it('reads 404 as an answer: no Application, already deleted, no such number', async () => {
    expect(await adapter([{ status: 404 }]).plivo.getInboundApplication('app-1')).toBeNull();
    expect(await adapter([{ status: 404 }]).plivo.updateInboundApplication('app-1', URLS, 't')).toBe('not_found');
    expect(await adapter([{ status: 404 }]).plivo.deleteInboundApplication('app-1')).toBe('not_found');
    expect(await adapter([{ status: 404 }]).plivo.getNumberApp('+14155550101')).toBeNull();
    expect(await adapter([{ status: 404 }]).plivo.setNumberApp('+14155550101', null)).toBe('not_found');
  });

  it('never builds a URL from a malformed application id or number', async () => {
    const { plivo, sent } = adapter([]);
    for (const p of [
      plivo.getInboundApplication(''), plivo.deleteInboundApplication('../Call/'), plivo.updateInboundApplication('a b', URLS, 't'),
      plivo.getNumberApp('sip:x@y'), plivo.setNumberApp('+14155550101', '../x'), plivo.setNumberApp('1<2', 'app-1'),
    ]) expect(await kindOf(p)).toBe('refused');
    expect(sent).toEqual([]);
  });

  it('finds Applications by exact name across pages, building each page from the offset', async () => {
    const page = (n: number, name: (i: number) => string, next: string | null) => ({
      status: 200,
      body: { meta: { next }, objects: Array.from({ length: n }, (_, i) => ({ app_id: `${1000 + i}`, app_name: name(i) })) },
    });
    const { plivo, sent } = adapter([
      page(20, (i) => (i === 3 ? 'inbound-x' : `other-${i}`), 'https://evil.test/next'),
      page(2, (i) => (i === 1 ? 'inbound-x' : 'inbound-x-not'), null),
    ]);
    expect(await plivo.findInboundApplications('inbound-x')).toEqual(['1003', '1001']);
    expect(sent).toEqual([
      'https://api.plivo.com/v1/Account/MAABCDEFGHIJKLMNOPQR/Application/?app_name=inbound-x&limit=20&offset=0',
      'https://api.plivo.com/v1/Account/MAABCDEFGHIJKLMNOPQR/Application/?app_name=inbound-x&limit=20&offset=20',
    ]);
  });

  it('reads at most PLIVO_APPLICATIONS_MAX_PAGES pages of a list that never ends (a host ignoring the name filter)', async () => {
    const page = (p: number) => ({
      status: 200,
      body: { meta: { next: 'more' }, objects: Array.from({ length: 20 }, (_, i) => ({ app_id: `${p * 100 + i}`, app_name: i === 0 ? 'inbound-x' : 'other' })) },
    });
    const { plivo, sent } = adapter(Array.from({ length: PLIVO_APPLICATIONS_MAX_PAGES + 3 }, (_, p) => page(p)));
    expect(await plivo.findInboundApplications('inbound-x')).toEqual(
      Array.from({ length: PLIVO_APPLICATIONS_MAX_PAGES }, (_, p) => `${p * 100}`));
    expect(sent).toHaveLength(PLIVO_APPLICATIONS_MAX_PAGES);
    expect(PLIVO_APPLICATIONS_MAX_PAGES).toBe(5);
  });
});

describe('PlivoAdapter.startRecording (the Record API, at an inbound call`s bind)', () => {
  const CALLBACK = 'https://a.test/api/v1/webhooks/plivo/webrtc-recording/c?token=t';
  // The callback must be on the webhook origin, as a dial`s are.
  const recorder = (responses: Array<{ status: number; body?: unknown } | Error>) => adapter(responses, 'https://a.test/api/v1/webhooks/plivo');

  it.each([[401, 'auth_rejected'], [429, 'unreachable'], [500, 'unreachable'], [404, 'refused'], [400, 'refused']])(
    'HTTP %i is %s', async (status, kind) => {
      expect(await kindOf(recorder([{ status }]).plivo.startRecording('cu-1', { callbackUrl: CALLBACK, timeLimitSeconds: 60 }))).toBe(kind);
    },
  );

  it('a network failure is unreachable; a 2xx without an id resolves with none', async () => {
    expect(await kindOf(recorder([new TypeError('fetch failed')]).plivo.startRecording('cu-1', { callbackUrl: CALLBACK, timeLimitSeconds: 60 })))
      .toBe('unreachable');
    expect(await recorder([{ status: 202, body: { message: 'call recording started' } }]).plivo
      .startRecording('cu-1', { callbackUrl: CALLBACK, timeLimitSeconds: 60 })).toEqual({ recordingId: null });
  });

  it('sends nothing for a malformed call id, a callback off the webhook origin or over http, or no time limit', async () => {
    const { plivo, sent } = recorder([]);
    for (const p of [
      plivo.startRecording('../Request', { callbackUrl: CALLBACK, timeLimitSeconds: 60 }),
      plivo.startRecording('', { callbackUrl: CALLBACK, timeLimitSeconds: 60 }),
      plivo.startRecording('cu-1', { callbackUrl: 'https://evil.test/api/v1/webhooks/plivo/webrtc-recording/c', timeLimitSeconds: 60 }),
      plivo.startRecording('cu-1', { callbackUrl: 'http://a.test/api/v1/webhooks/plivo/webrtc-recording/c', timeLimitSeconds: 60 }),
      plivo.startRecording('cu-1', { callbackUrl: CALLBACK, timeLimitSeconds: 0 }),
    ]) expect(await kindOf(p)).toBe('refused');
    expect(sent).toEqual([]);
  });
});
