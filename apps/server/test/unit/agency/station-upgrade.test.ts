import { describe, expect, it } from 'vitest';
import { DEFAULT_STATION_UPGRADE, parseStationUpgradeQuery } from '../../../src/agency/station-upgrade.js';
import { stationIntervalsFor, STATION_INTERVALS } from '../../../src/api/routes/agency/helpers.js';
import { MOBILE_STATION_HEARTBEAT_GRACE_MS, STATION_HEARTBEAT_GRACE_MS } from '@magick-agency/domain/timers';

// The station upgrade's `client=` / `media=`: absent is the default, present must be
// exactly a listed value. Every station entry point refuses with the same parser.
describe('parseStationUpgradeQuery', () => {
  it('defaults both when the upgrade names neither (the browser console)', () => {
    expect(parseStationUpgradeQuery({ token: 't' })).toEqual({ ok: true, query: { client: 'web', media: 'pcm16' } });
    expect(parseStationUpgradeQuery(undefined)).toEqual({ ok: true, query: DEFAULT_STATION_UPGRADE });
    expect(parseStationUpgradeQuery(null)).toEqual({ ok: true, query: DEFAULT_STATION_UPGRADE });
  });

  it('takes every listed value', () => {
    for (const client of ['web', 'mobile'] as const) {
      for (const media of ['pcm16', 'alaw8'] as const) {
        expect(parseStationUpgradeQuery({ client, media })).toEqual({ ok: true, query: { client, media } });
      }
    }
  });

  it.each([
    [{ client: 'ios' }, 'invalid_client'],
    [{ client: '' }, 'invalid_client'],
    [{ client: 'MOBILE' }, 'invalid_client'],
    [{ client: ['web', 'mobile'] }, 'invalid_client'],
    [{ client: 1 }, 'invalid_client'],
    [{ client: 'ios', media: 'opus' }, 'invalid_client'],
    [{ media: 'opus' }, 'invalid_media'],
    [{ media: 'PCM16' }, 'invalid_media'],
    [{ client: 'mobile', media: '' }, 'invalid_media'],
  ])('refuses %j as %s', (query, reason) => {
    expect(parseStationUpgradeQuery(query)).toEqual({ ok: false, reason });
  });

  it('cannot be mutated through the default', () => {
    expect(Object.isFrozen(DEFAULT_STATION_UPGRADE)).toBe(true);
  });
});

describe('stationIntervalsFor', () => {
  it('serves the mobile app the mobile grace and the web exactly what it always had', () => {
    expect(stationIntervalsFor('web')).toBe(STATION_INTERVALS);
    expect(stationIntervalsFor(undefined)).toBe(STATION_INTERVALS);
    expect(stationIntervalsFor('something')).toBe(STATION_INTERVALS);
    expect(STATION_INTERVALS.heartbeat_grace_ms).toBe(STATION_HEARTBEAT_GRACE_MS);

    const mobile = stationIntervalsFor('mobile');
    expect(mobile.heartbeat_grace_ms).toBe(MOBILE_STATION_HEARTBEAT_GRACE_MS);
    // Only the grace differs: the app-level ping still renews the ownership key at heartbeat_ms.
    expect({ ...mobile, heartbeat_grace_ms: STATION_INTERVALS.heartbeat_grace_ms }).toEqual(STATION_INTERVALS);
  });
});
