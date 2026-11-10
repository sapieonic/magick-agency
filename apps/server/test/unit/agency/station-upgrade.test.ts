import { describe, expect, it } from 'vitest';
import { DEFAULT_STATION_UPGRADE, parseStationUpgradeQuery, stationCanTakeInbound } from '../../../src/agency/station-upgrade.js';
import { stationIntervalsFor, STATION_INTERVALS } from '../../../src/api/routes/agency/helpers.js';
import { MOBILE_STATION_HEARTBEAT_GRACE_MS, STATION_HEARTBEAT_GRACE_MS } from '@magick-agency/domain/timers';

// The station upgrade's `client=` / `media=`: absent is the default, present must be
// exactly a listed value. Every station entry point refuses with the same parser.
describe('parseStationUpgradeQuery', () => {
  it('defaults both when the upgrade names neither (the browser console)', () => {
    expect(parseStationUpgradeQuery({ token: 't' })).toEqual({ ok: true, query: { client: 'web', media: 'pcm16', caps: [] } });
    expect(parseStationUpgradeQuery(undefined)).toEqual({ ok: true, query: DEFAULT_STATION_UPGRADE });
    expect(parseStationUpgradeQuery(null)).toEqual({ ok: true, query: DEFAULT_STATION_UPGRADE });
  });

  it('takes every listed value', () => {
    for (const client of ['web', 'mobile'] as const) {
      for (const media of ['pcm16', 'alaw8'] as const) {
        expect(parseStationUpgradeQuery({ client, media })).toEqual({ ok: true, query: { client, media, caps: [] } });
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
    expect(Object.isFrozen(DEFAULT_STATION_UPGRADE.caps)).toBe(true);
  });
});

// `caps=`: what the station can do beyond the dialer's frames. Never refused (a 1008 is terminal
// for the app): unknown values are ignored, a repeated parameter is the union.
describe('parseStationUpgradeQuery: caps', () => {
  const caps = (query: Record<string, unknown>) => {
    const r = parseStationUpgradeQuery({ client: 'mobile', media: 'alaw8', ...query });
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r.query.caps;
  };

  it.each<[string, Record<string, unknown>, string[]]>([
    ['absent', {}, []],
    ['empty', { caps: '' }, []],
    ['only commas and spaces', { caps: ' , ,' }, []],
    ['inbound', { caps: 'inbound' }, ['inbound']],
    ['inbound with unknown ones around it', { caps: 'video,inbound,push' }, ['inbound']],
    ['only unknown ones', { caps: 'video,push' }, []],
    ['spaces around the value', { caps: ' inbound ' }, ['inbound']],
    ['named twice', { caps: 'inbound,inbound' }, ['inbound']],
    ['repeated: the union', { caps: ['video', 'inbound'] }, ['inbound']],
    ['repeated, none known', { caps: ['video', ''] }, []],
    ['case-sensitive, as client and media', { caps: 'INBOUND' }, []],
    ['not a string', { caps: 1 }, []],
    ['an object', { caps: { inbound: true } }, []],
  ])('%s', (_what, query, expected) => {
    expect(caps(query)).toEqual(expected);
  });

  it('never refuses the upgrade over caps, and refuses client and media first as before', () => {
    expect(parseStationUpgradeQuery({ client: 'mobile', caps: 'anything,at,all' })).toMatchObject({ ok: true });
    expect(parseStationUpgradeQuery({ client: 'ios', caps: 'inbound' })).toEqual({ ok: false, reason: 'invalid_client' });
    expect(parseStationUpgradeQuery({ media: 'opus', caps: 'inbound' })).toEqual({ ok: false, reason: 'invalid_media' });
  });

  it('the app\'s upgrade: client=mobile&media=alaw8&caps=inbound', () => {
    expect(parseStationUpgradeQuery({ token: 't', client: 'mobile', media: 'alaw8', caps: 'inbound' }))
      .toEqual({ ok: true, query: { client: 'mobile', media: 'alaw8', caps: ['inbound'] } });
  });
});

describe('stationCanTakeInbound', () => {
  it('a console always, whatever it declares; a phone only with caps=inbound', () => {
    expect(stationCanTakeInbound({ client: 'web', caps: [] })).toBe(true);
    expect(stationCanTakeInbound({ client: 'web', caps: ['inbound'] })).toBe(true);
    expect(stationCanTakeInbound(DEFAULT_STATION_UPGRADE)).toBe(true);
    expect(stationCanTakeInbound({ client: 'mobile', caps: [] })).toBe(false);
    expect(stationCanTakeInbound({ client: 'mobile', caps: ['inbound'] })).toBe(true);
  });

  it('an older app build (no caps) cannot; one that sends caps=inbound can', () => {
    const old = parseStationUpgradeQuery({ client: 'mobile', media: 'alaw8' });
    const capable = parseStationUpgradeQuery({ client: 'mobile', media: 'alaw8', caps: 'inbound' });
    expect(old.ok && stationCanTakeInbound(old.query)).toBe(false);
    expect(capable.ok && stationCanTakeInbound(capable.query)).toBe(true);
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
