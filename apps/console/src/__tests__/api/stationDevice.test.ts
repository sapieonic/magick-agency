import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENCY_STATION_DEVICE_ID_PATTERN } from '@magick-agency/contracts/agency';

/**
 * One station per agent (OS3): every request that can hand this window the station names the
 * window, and only the agent's own choices take it over. The server decides who holds the station
 * from these bodies alone, so they are pinned here: a join or soft-phone open that stopped taking
 * over would strand a reloaded station behind "open on another device"; a mint that took over
 * would let a sleeping laptop steal the station back from the agent's phone.
 */

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: { getIdToken: () => Promise.resolve('tok') } }) }));
vi.mock('../../analytics/posthog', () => ({ captureError: vi.fn() }));

import { createAgencySession, mintStationToken } from '../../api/agency';
import { openSoftphoneSession } from '../../api/softphone';
import { pageWasDiscarded, resetStationDeviceIdForTests, stationDeviceId } from '../../utils/stationDevice';

function lastBody(): Record<string, unknown> {
  const init = mocks.fetch.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async () =>
    new Response(JSON.stringify({ session_id: 's' }), { status: 200, headers: { 'content-type': 'application/json' } }));
});

describe('the station device id', () => {
  it('is one per page load, in the pattern the server accepts', () => {
    resetStationDeviceIdForTests();
    const id = stationDeviceId();
    expect(id).toMatch(AGENCY_STATION_DEVICE_ID_PATTERN);
    expect(stationDeviceId()).toBe(id);
    resetStationDeviceIdForTests();
    expect(stationDeviceId()).not.toBe(id);
  });
});

describe('what each request says about the device', () => {
  it('the campaign join names this window and takes the station over unless told not to', async () => {
    await createAgencySession('camp-1', 't1', 'a1');
    expect(lastBody()).toEqual({ campaign_id: 'camp-1', device_id: stationDeviceId(), take_over: true });
    await createAgencySession('camp-1', 't1', 'a1', { takeOver: false });
    expect(lastBody()).toEqual({ campaign_id: 'camp-1', device_id: stationDeviceId(), take_over: false });
  });

  it('the soft-phone open names this window and takes the station over unless told not to', async () => {
    await openSoftphoneSession('t1', 'a1');
    expect(lastBody()).toEqual({ device_id: stationDeviceId(), take_over: true });
    await openSoftphoneSession('t1', 'a1', { takeOver: false });
    expect(lastBody()).toEqual({ device_id: stationDeviceId(), take_over: false });
  });

  it('a reconnect mint names this window and never takes over unless asked', async () => {
    await mintStationToken('sess-1', 't1', 'a1');
    expect(lastBody()).toEqual({ device_id: stationDeviceId(), take_over: false });
    await mintStationToken('sess-1', 't1', 'a1', { takeOver: true });
    expect(lastBody()).toEqual({ device_id: stationDeviceId(), take_over: true });
  });
});

describe('pageWasDiscarded', () => {
  it('reads document.wasDiscarded, false where the browser does not say', () => {
    expect(pageWasDiscarded()).toBe(false);
    Object.defineProperty(document, 'wasDiscarded', { value: true, configurable: true });
    try {
      expect(pageWasDiscarded()).toBe(true);
    } finally {
      delete (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
    }
  });
});
