import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The account's call settings (`docs/call-log.md` §5) as the console calls them: the paths, the
 * body of the switch, the refusal that names the inbound numbers in its way, and the routes a
 * campaign receives unknown callers on. Through the real `apiFetch`.
 */

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null, signOut: vi.fn() }) }));

import { getCallSettings, getCampaignInboundDefaultRoutes, putCallSettings } from '../../api/callSettings';

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
  return { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined };
}

const BODY = {
  settings: { require_campaign: false, require_campaign_since: null, updated_at: null },
  readiness: { routes_missing_default: [], agents_without_campaign: [], agents_without_campaign_total: 0, unfiled_calls: 3 },
};

beforeEach(() => {
  mocks.fetch.mockReset();
});

describe('the call settings', () => {
  it('GET reads the setting and its readiness; a failure throws', async () => {
    mocks.fetch.mockResolvedValue(respond(200, BODY));
    expect(await getCallSettings('t-1', 'a-1')).toEqual(BODY);
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/call-settings', method: 'GET' });
    mocks.fetch.mockResolvedValue(respond(403, { message: 'No.' }));
    await expect(getCallSettings('t-1', 'a-1')).rejects.toBeTruthy();
  });

  it('PUT sends the switch alone', async () => {
    mocks.fetch.mockResolvedValue(respond(200, BODY));
    expect(await putCallSettings(true, 't-1', 'a-1')).toEqual({ ok: true, value: BODY });
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/call-settings', method: 'PUT', body: { require_campaign: true } });
    await putCallSettings(false, 't-1', 'a-1');
    expect(lastRequest().body).toEqual({ require_campaign: false });
  });

  it('a refused switch is a value naming the inbound numbers with no campaign for unknown callers', async () => {
    mocks.fetch.mockResolvedValue(respond(422, {
      code: 'default_campaign_required', message: 'Every inbound number needs a campaign for unknown callers before this can be switched on.',
      routes: [{ route_id: 'r-1', name: 'Sales line' }, { route_id: 7 }, 'nope'],
    }));
    expect(await putCallSettings(true, 't-1', 'a-1')).toEqual({
      ok: false,
      refusal: {
        code: 'default_campaign_required', status: 422,
        message: 'Every inbound number needs a campaign for unknown callers before this can be switched on.',
        routes: [{ route_id: 'r-1', name: 'Sales line' }],
      },
    });
  });

  it('any other refusal is `unknown`, with the server’s sentence', async () => {
    mocks.fetch.mockResolvedValue(respond(403, { message: 'Insufficient permissions.' }));
    expect(await putCallSettings(true, 't-1', 'a-1')).toMatchObject({ ok: false, refusal: { code: 'unknown', status: 403, routes: [] } });
  });

  it('the routes a campaign receives unknown callers on', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { routes: [{ route_id: 'r-1', name: 'Sales line' }] }));
    expect(await getCampaignInboundDefaultRoutes('camp 1', 't-1', 'a-1')).toEqual([{ route_id: 'r-1', name: 'Sales line' }]);
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/campaigns/camp%201/inbound-default-routes', method: 'GET' });
  });
});
