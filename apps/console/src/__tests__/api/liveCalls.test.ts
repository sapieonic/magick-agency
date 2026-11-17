import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The live calls client against `docs/listening.md` §4 and the contract
 * (`api/agency/live-calls.ts`): each route's method, path, query and tenancy headers, through the
 * real `apiFetch`; a refused grant resolves to its status and code rather than throwing.
 */

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null, signOut: vi.fn() }) }));

import { grantListen, listLiveCalls, revealLiveCallNumber } from '../../api/liveCalls';

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

function lastRequest() {
  const [url, init] = mocks.fetch.mock.calls[mocks.fetch.mock.calls.length - 1]! as [string, RequestInit];
  return { url, method: init?.method ?? 'GET', body: init?.body, headers: init?.headers as Record<string, string> };
}

beforeEach(() => {
  mocks.fetch.mockReset();
});

describe('the live list', () => {
  it('GET /proxy/agency/live-calls with both tenancy headers', async () => {
    const body = { calls: [], as_of: '2026-11-16T10:00:00Z' };
    mocks.fetch.mockResolvedValue(respond(200, body));
    await expect(listLiveCalls({}, 't-1', 'a-1')).resolves.toEqual(body);
    const req = lastRequest();
    expect(req.url).toBe('/proxy/agency/live-calls');
    expect(req.method).toBe('GET');
    expect(req.headers['X-Tenant-Id']).toBe('t-1');
    expect(req.headers['X-Account-Id']).toBe('a-1');
  });

  it('one campaign’s, with campaign_id; a blank id is no filter', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { calls: [], as_of: 'x' }));
    await listLiveCalls({ campaign_id: 'camp 1' }, 't-1', 'a-1');
    expect(lastRequest().url).toBe('/proxy/agency/live-calls?campaign_id=camp+1');
    await listLiveCalls({ campaign_id: '' }, 't-1', 'a-1');
    expect(lastRequest().url).toBe('/proxy/agency/live-calls');
  });

  it('throws the refusal, as every read does', async () => {
    mocks.fetch.mockResolvedValue(respond(403, { error: 'Forbidden', code: 'feature_disabled', message: 'off' }));
    await expect(listLiveCalls({}, 't-1', 'a-1')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the number', () => {
  it('GET /live-calls/:callId/number, the id encoded', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { call_id: 'c/1', customer_phone: '+919845014321' }));
    await expect(revealLiveCallNumber('c/1', 't-1', 'a-1')).resolves.toEqual({ call_id: 'c/1', customer_phone: '+919845014321' });
    expect(lastRequest().url).toBe('/proxy/agency/live-calls/c%2F1/number');
    expect(lastRequest().method).toBe('GET');
  });
});

describe('the grant', () => {
  it('POST /live-calls/:callId/listen with no body: the grant', async () => {
    const grant = { listen_id: 'l-1', ws_url: '/proxy/agency/listen/s-1/l-1?token=abc', expires_at: '2026-11-16T10:01:00Z' };
    mocks.fetch.mockResolvedValue(respond(201, grant));
    await expect(grantListen('call-1', 't-1', 'a-1')).resolves.toEqual({ ok: true, grant });
    const req = lastRequest();
    expect(req.url).toBe('/proxy/agency/live-calls/call-1/listen');
    expect(req.method).toBe('POST');
    expect(req.body).toBeUndefined();
    expect(req.headers['X-Account-Id']).toBe('a-1');
  });

  it.each([
    [409, 'listen_limit_call'],
    [409, 'listen_recording_off'],
    [409, 'listen_own_call'],
    [404, 'listen_call_not_live'],
    [503, 'listen_limit_server'],
    [503, 'listen_unavailable'],
    [403, 'feature_disabled'],
  ])('a %i %s resolves to its status and code', async (status, code) => {
    mocks.fetch.mockResolvedValue(respond(status, { error: 'x', code, message: 'm' }));
    await expect(grantListen('call-1', 't-1', 'a-1')).resolves.toEqual({ ok: false, status, code });
  });

  it('no answer at all resolves to a null status', async () => {
    mocks.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(grantListen('call-1', 't-1', 'a-1')).resolves.toEqual({ ok: false, status: null, code: null });
  });
});
