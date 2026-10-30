import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The soft-phone client against `docs/softphone.md` §6: every route's method,
 * path and body, the list query, and the refusal bodies narrowed into typed
 * results — through the real `apiFetch`, so a status and a body become the same
 * `ApiError` the console sees in production.
 */

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null, signOut: vi.fn() }) }));

import {
  dispositionManualCall,
  getManualCall,
  getSoftphoneBootstrap,
  getSoftphoneSettings,
  hangupManualCall,
  listManualCalls,
  markManualCallDnc,
  openSoftphoneSession,
  placeManualCall,
  putSoftphoneSettings,
  returnFromSoftphone,
  switchToSoftphone,
  updateManualCall,
} from '../../api/softphone';
import { manualCall, BOOTSTRAP } from '../helpers/softphone';

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
  return {
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(init.body as string) : undefined,
    headers: init?.headers as Record<string, string>,
  };
}

beforeEach(() => {
  mocks.fetch.mockReset();
});

describe('the routes, methods and bodies of §6', () => {
  it('GET /bootstrap with both tenancy headers', async () => {
    mocks.fetch.mockResolvedValue(respond(200, BOOTSTRAP));
    await getSoftphoneBootstrap('t-1', 'a-1');
    const req = lastRequest();
    expect(req.url).toBe('/proxy/agency/softphone/bootstrap');
    expect(req.method).toBe('GET');
    expect(req.headers['X-Tenant-Id']).toBe('t-1');
    expect(req.headers['X-Account-Id']).toBe('a-1');
  });

  it('POST /sessions with an empty body (the agent is the caller)', async () => {
    mocks.fetch.mockResolvedValue(respond(201, { session_id: 's' }));
    const result = await openSoftphoneSession('t', 'a');
    expect(result.ok).toBe(true);
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/softphone/sessions', method: 'POST', body: {} });
  });

  it('POST /calls with session, number, caller ID, tag, fields and overrides', async () => {
    mocks.fetch.mockResolvedValue(respond(201, manualCall()));
    const body = {
      session_id: 'sess-sp',
      to: '9820461733',
      caller_id: '+912248908888',
      campaign_id: 'camp-1',
      fields: { customer_name: 'Rahul' },
      overrides: { dnc_note: 'Customer asked for this call' },
    };
    const result = await placeManualCall(body, 't', 'a');
    expect(result).toEqual({ ok: true, value: manualCall() });
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/softphone/calls', method: 'POST', body });
  });

  it('PATCH, hangup, disposition and dnc on /calls/:id', async () => {
    mocks.fetch.mockResolvedValue(respond(200, manualCall()));
    await updateManualCall('mc-1', { fields: { a: 1 }, notes: 'n' }, 't', 'a');
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/softphone/calls/mc-1', method: 'PATCH', body: { fields: { a: 1 }, notes: 'n' } });
    await hangupManualCall('mc-1', 't', 'a');
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/softphone/calls/mc-1/hangup', method: 'POST', body: {} });
    await dispositionManualCall('mc-1', { code: 'resolved', notes: 'ok', fields: {} }, 't', 'a');
    expect(lastRequest()).toMatchObject({
      url: '/proxy/agency/softphone/calls/mc-1/disposition',
      method: 'POST',
      body: { code: 'resolved', notes: 'ok', fields: {} },
    });
    await markManualCallDnc('mc-1', '  ', 't', 'a');
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/softphone/calls/mc-1/dnc', method: 'POST', body: {} });
    await markManualCallDnc('mc-1', 'asked', 't', 'a');
    expect(lastRequest().body).toEqual({ reason: 'asked' });
  });

  it('GET /calls sends only the filters that are set', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { rows: [], next_cursor: null, limit: 50 }));
    await listManualCalls({ limit: 50, campaign_id: 'untagged', phone: '9198', cursor: 'abc' }, 't', 'a');
    const url = new URL(lastRequest().url, 'http://x');
    expect(url.pathname).toBe('/proxy/agency/softphone/calls');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50', campaign_id: 'untagged', phone: '9198', cursor: 'abc' });
  });

  it('GET /calls/:id, GET and PUT /settings', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { call: manualCall() }));
    await getManualCall('mc-1', 't', 'a');
    expect(lastRequest().url).toBe('/proxy/agency/softphone/calls/mc-1');
    mocks.fetch.mockResolvedValue(respond(200, { settings: { record_calls: true } }));
    expect(await getSoftphoneSettings('t', 'a')).toEqual({ record_calls: true });
    const payload = { disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: true, default_caller_id: null };
    const saved = await putSoftphoneSettings(payload, 't', 'a');
    expect(saved).toEqual({ ok: true, value: { record_calls: true } });
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/softphone/settings', method: 'PUT', body: payload });
  });

  it('the two switch routes on the campaign session (§4.2)', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { session_id: 's-1', state: 'on_call', pending_state: 'break', break_reason: 'soft_phone' }));
    const switched = await switchToSoftphone('s-1', 't', 'a');
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/sessions/s-1/softphone', method: 'POST' });
    expect(switched.ok && switched.value.pending_state).toBe('break');
    await returnFromSoftphone('s-1', 't', 'a');
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/sessions/s-1/softphone/return', method: 'POST' });
  });
});

describe('refusals become typed results', () => {
  const place = () => placeManualCall({ session_id: 's', to: '9820461733' }, 't', 'a');

  it('dnc_listed carries its entry', async () => {
    mocks.fetch.mockResolvedValue(
      respond(409, {
        error: 'Conflict',
        code: 'dnc_listed',
        message: 'Listed',
        entry: { id: 'dnc-1', scope: 'campaign', reason: 'Asked', created_at: '2026-10-12T09:00:00Z' },
      }),
    );
    const result = await place();
    expect(result.ok).toBe(false);
    if (result.ok || result.refusal.code !== 'dnc_listed') throw new Error('expected dnc_listed');
    expect(result.refusal.status).toBe(409);
    expect(result.refusal.entry).toEqual({ id: 'dnc-1', scope: 'campaign', reason: 'Asked', created_at: '2026-10-12T09:00:00Z' });
  });

  it('outside_calling_hours carries the window, its zone source and the next opening', async () => {
    mocks.fetch.mockResolvedValue(
      respond(409, {
        code: 'outside_calling_hours',
        message: 'Closed',
        window: { start: '09:00', end: '20:00', days: [1, 2], timezone: 'Asia/Kolkata' },
        timezone_source: 'contact',
        next_open_at: '2026-11-02T03:30:00Z',
      }),
    );
    const result = await place();
    if (result.ok || result.refusal.code !== 'outside_calling_hours') throw new Error('expected outside_calling_hours');
    expect(result.refusal.window.timezone).toBe('Asia/Kolkata');
    expect(result.refusal.timezone_source).toBe('contact');
    expect(result.refusal.next_open_at).toBe('2026-11-02T03:30:00Z');
  });

  it('outcome_pending carries the call that holds the session', async () => {
    mocks.fetch.mockResolvedValue(respond(409, { code: 'outcome_pending', message: 'Pending', call: manualCall({ state: 'ended' }) }));
    const result = await place();
    if (result.ok || result.refusal.code !== 'outcome_pending') throw new Error('expected outcome_pending');
    expect(result.refusal.call.id).toBe('mc-1');
  });

  it('session_on_campaign names the campaign session to switch', async () => {
    mocks.fetch.mockResolvedValue(
      respond(409, { code: 'session_on_campaign', message: 'On campaign', session_id: 's-c', campaign_id: 'camp-1', campaign_name: 'Renewals', state: 'available' }),
    );
    const result = await openSoftphoneSession('t', 'a');
    if (result.ok || result.refusal.code !== 'session_on_campaign') throw new Error('expected session_on_campaign');
    expect(result.refusal).toMatchObject({ session_id: 's-c', campaign_id: 'camp-1', campaign_name: 'Renewals', state: 'available' });
  });

  it('keeps allowed_codes and details on the generic refusals', async () => {
    mocks.fetch.mockResolvedValue(respond(400, { code: 'disposition_invalid', message: 'x', allowed_codes: ['a', 'b'] }));
    const d = await dispositionManualCall('mc-1', { code: 'zzz' }, 't', 'a');
    expect(!d.ok && d.refusal).toMatchObject({ code: 'disposition_invalid', allowed_codes: ['a', 'b'], status: 400 });
    mocks.fetch.mockResolvedValue(respond(400, { code: 'fields_invalid', message: 'x', details: [{ path: 'fields.reason', message: 'Pick one' }] }));
    const f = await updateManualCall('mc-1', { fields: {} }, 't', 'a');
    expect(!f.ok && f.refusal).toMatchObject({ code: 'fields_invalid', details: [{ path: 'fields.reason', message: 'Pick one' }] });
  });

  it('degrades a malformed narrowed refusal, an unknown code and a network failure to `unknown` with a sentence', async () => {
    mocks.fetch.mockResolvedValue(respond(409, { code: 'dnc_listed', message: 'Listed, no entry' }));
    const malformed = await place();
    expect(!malformed.ok && malformed.refusal).toMatchObject({ code: 'unknown', raw_code: 'dnc_listed', message: 'Listed, no entry' });

    mocks.fetch.mockResolvedValue(respond(409, { code: 'something_new', message: 'New thing' }));
    const unknown = await place();
    expect(!unknown.ok && unknown.refusal).toMatchObject({ code: 'unknown', raw_code: 'something_new', message: 'New thing' });

    mocks.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const network = await place();
    expect(!network.ok && network.refusal).toMatchObject({ code: 'unknown', status: null, message: 'Failed to fetch' });
  });
});
