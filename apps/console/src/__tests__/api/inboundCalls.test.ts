import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The inbound call routes and the queue (P2, `docs/inbound.md` §6) as the console calls them:
 * every method, path and body, the refusal bodies read into an `InboundRefusal`, and where a
 * Missed row's voicemail is fetched from — through the real `apiFetch`, so a status and a body
 * become the same error the console sees in production. The paths are the coordinator's to
 * reconcile with the server's build: they live in `INBOUND_PATHS` alone.
 */

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null, signOut: vi.fn() }) }));

import {
  INBOUND_PATHS,
  dispositionInboundCall,
  fetchVoicemailBlobUrl,
  getInboundCall,
  getInboundQueue,
  hangupInboundCall,
  markInboundCallDnc,
  updateInboundCallNotes,
  voicemailFetchUrl,
} from '../../api/inbound';
import { connected, owing, queueTile } from '../helpers/inbound';

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

beforeEach(() => {
  mocks.fetch.mockReset();
});

describe('the paths, in one place', () => {
  it('are all under /proxy/agency/inbound', () => {
    expect(INBOUND_PATHS.call('ib 1')).toBe('/proxy/agency/inbound/calls/ib%201');
    expect(INBOUND_PATHS.callHangup('ib-1')).toBe('/proxy/agency/inbound/calls/ib-1/hangup');
    expect(INBOUND_PATHS.callDisposition('ib-1')).toBe('/proxy/agency/inbound/calls/ib-1/disposition');
    expect(INBOUND_PATHS.callDnc('ib-1')).toBe('/proxy/agency/inbound/calls/ib-1/dnc');
    expect(INBOUND_PATHS.queue).toBe('/proxy/agency/inbound/queue');
  });
});

describe('the call routes', () => {
  it('GET reads the call', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { call: connected() }));
    expect((await getInboundCall('ib-1', 't-1', 'a-1')).state).toBe('connected');
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/inbound/calls/ib-1', method: 'GET' });
  });

  it('PATCH sends the notes, empty to clear them', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { call: owing({ notes: '' }) }));
    const result = await updateInboundCallNotes('ib-1', '', 't-1', 'a-1');
    expect(result.ok).toBe(true);
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/inbound/calls/ib-1', method: 'PATCH', body: { notes: '' } });
  });

  it('hang-up posts an empty body', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { call: connected() }));
    await hangupInboundCall('ib-1', 't-1', 'a-1');
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/inbound/calls/ib-1/hangup', method: 'POST', body: {} });
  });

  it('the outcome posts the code, notes and callback time', async () => {
    const body = { code: 'callback', notes: 'Evening', callback_at: '2026-11-10T12:00:00.000Z' };
    mocks.fetch.mockResolvedValue(respond(200, { call: owing(), contact_state: 'pending', next_attempt_at: null, callback_requested_at: null }));
    const result = await dispositionInboundCall('ib-1', body, 't-1', 'a-1');
    expect(result.ok).toBe(true);
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/inbound/calls/ib-1/disposition', method: 'POST', body });
  });

  it('a refused outcome is a value carrying the rule and the codes the catalog accepts', async () => {
    mocks.fetch.mockResolvedValue(
      respond(400, {
        code: 'inbound_disposition_invalid',
        message: 'Unknown code.',
        reason: 'unknown_code',
        allowed_codes: ['resolved', 7, 'escalated'],
        inbound_call_id: 'ib-1',
      }),
    );
    const result = await dispositionInboundCall('ib-1', { code: 'nope' }, 't-1', 'a-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toMatchObject({
      code: 'inbound_disposition_invalid',
      status: 400,
      reason: 'unknown_code',
      allowedCodes: ['resolved', 'escalated'],
      inboundCallId: 'ib-1',
    });
  });

  it('a reason the console does not know is dropped, never trusted', async () => {
    mocks.fetch.mockResolvedValue(respond(400, { code: 'inbound_disposition_invalid', message: 'x', reason: 'made_up' }));
    const result = await dispositionInboundCall('ib-1', { code: 'nope' }, 't-1', 'a-1');
    expect(result.ok ? null : result.refusal.reason).toBeNull();
  });

  it('DNC sends a trimmed reason only when there is one', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { call_id: 'ib-1', phone_e164: '+91', scope: 'account', dnc_recorded: true, contact_state: null }));
    await markInboundCallDnc('ib-1', '  ', 't-1', 'a-1');
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/inbound/calls/ib-1/dnc', method: 'POST', body: {} });
    await markInboundCallDnc('ib-1', ' Asked ', 't-1', 'a-1');
    expect(lastRequest().body).toEqual({ reason: 'Asked' });
  });
});

describe('the queue', () => {
  it('reads the tiles, and throws on a refusal', async () => {
    mocks.fetch.mockResolvedValue(respond(200, { tiles: [queueTile()] }));
    expect((await getInboundQueue('t-1', 'a-1')).tiles).toHaveLength(1);
    expect(lastRequest()).toMatchObject({ url: '/proxy/agency/inbound/queue', method: 'GET' });
    mocks.fetch.mockResolvedValue(respond(403, { code: 'inbound_disabled', message: 'Off.' }));
    await expect(getInboundQueue('t-1', 'a-1')).rejects.toBeTruthy();
  });
});

describe('the voicemail', () => {
  it('is fetched under the proxy whatever form the row’s URL takes', () => {
    expect(voicemailFetchUrl('/inbound/missed/m-1/voicemail')).toBe('/proxy/agency/inbound/missed/m-1/voicemail');
    expect(voicemailFetchUrl('inbound/missed/m-1/voicemail')).toBe('/proxy/agency/inbound/missed/m-1/voicemail');
    expect(voicemailFetchUrl('/proxy/agency/inbound/missed/m-1/voicemail')).toBe('/proxy/agency/inbound/missed/m-1/voicemail');
    expect(voicemailFetchUrl('https://cdn.example.com/v.wav')).toBe('https://cdn.example.com/v.wav');
  });

  it('plays from a blob URL, and says so plainly when it is gone', async () => {
    const original = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:vm-1');
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response);
    try {
      expect(await fetchVoicemailBlobUrl('/inbound/missed/m-1/voicemail', 't-1', 'a-1')).toEqual({ status: 'ready', url: 'blob:vm-1' });
    } finally {
      URL.createObjectURL = original;
    }
    expect(mocks.fetch.mock.calls[0]![0]).toBe('/proxy/agency/inbound/missed/m-1/voicemail');
    mocks.fetch.mockResolvedValue({ ok: false, status: 404, url: '', headers: new Headers() } as unknown as Response);
    expect(await fetchVoicemailBlobUrl('/inbound/missed/m-1/voicemail', 't-1')).toEqual({
      status: 'unavailable',
      message: 'This voicemail is no longer available.',
    });
  });
});
