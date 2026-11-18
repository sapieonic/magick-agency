import { describe, expect, it } from 'vitest';
import {
  AGENCY_FLOOR_FROM_SKEW_MS,
  AGENCY_FLOOR_MAX_LOOKBACK_HOURS,
} from '@magick-agency/contracts/api/agency/floor';
import { AGENCY_PROMISES_SUMMARY_MAX_DAYS } from '@magick-agency/contracts/api/agency/promises';
import { RESERVED_BREAK_REASON_LABELS } from '@magick-agency/contracts/agency';
import { floorBreakLabel, floorTotals, parseFloorFrom, parsePromisesWindow } from '../../../src/agency/floor.js';

/**
 * The Live floor's pure rules (`src/agency/floor.ts`, decision B28b): the floor's `from`, the
 * promises summary's window, a break's label and the floor's totals.
 */

const NOW = new Date('2026-11-18T10:00:00.000Z');
const HOUR = 3_600_000;

describe('parseFloorFrom', () => {
  it('accepts a local midnight with its offset, as an instant', () => {
    const r = parseFloorFrom('2026-11-18T00:00:00+05:30', NOW);
    expect(r).toEqual({ ok: true, from: new Date('2026-11-17T18:30:00.000Z') });
  });

  it('refuses a missing, empty, repeated or malformed value, and a date without a time or an offset', () => {
    for (const raw of [undefined, '', ['2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z'], 'yesterday', '2026-11-18',
      '2026-11-18T00:00:00', '2026-02-30T00:00:00Z', '2026-11-18T00:00:00+25:00']) {
      expect(parseFloorFrom(raw, NOW).ok, String(raw)).toBe(false);
    }
  });

  it(`refuses one more than ${AGENCY_FLOOR_MAX_LOOKBACK_HOURS} hours back, and accepts the edge`, () => {
    const edge = new Date(NOW.getTime() - AGENCY_FLOOR_MAX_LOOKBACK_HOURS * HOUR);
    expect(parseFloorFrom(edge.toISOString(), NOW).ok).toBe(true);
    const r = parseFloorFrom(new Date(edge.getTime() - 1000).toISOString(), NOW);
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/at most 36 hours ago/) });
  });

  it('refuses the future beyond the clock skew, and accepts within it', () => {
    expect(parseFloorFrom(new Date(NOW.getTime() + AGENCY_FLOOR_FROM_SKEW_MS).toISOString(), NOW).ok).toBe(true);
    const r = parseFloorFrom(new Date(NOW.getTime() + AGENCY_FLOOR_FROM_SKEW_MS + 1000).toISOString(), NOW);
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/future/) });
  });
});

describe('parsePromisesWindow', () => {
  it('accepts two instants, from before to', () => {
    expect(parsePromisesWindow('2026-11-18T00:00:00+05:30', '2026-11-19T00:00:00+05:30')).toEqual({
      ok: true, from: new Date('2026-11-17T18:30:00.000Z'), to: new Date('2026-11-18T18:30:00.000Z'),
    });
  });

  it('refuses a missing or malformed bound, from at or after to', () => {
    expect(parsePromisesWindow(undefined, '2026-11-19T00:00:00Z').ok).toBe(false);
    expect(parsePromisesWindow('2026-11-18T00:00:00Z', undefined).ok).toBe(false);
    expect(parsePromisesWindow('2026-11-18', '2026-11-19T00:00:00Z').ok).toBe(false);
    expect(parsePromisesWindow(['2026-11-18T00:00:00Z'], '2026-11-19T00:00:00Z').ok).toBe(false);
    expect(parsePromisesWindow('2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')).toEqual({ ok: false, message: expect.stringMatching(/before/) });
    expect(parsePromisesWindow('2026-11-19T00:00:00Z', '2026-11-18T00:00:00Z').ok).toBe(false);
  });

  it(`caps the window at ${AGENCY_PROMISES_SUMMARY_MAX_DAYS} days, the edge included`, () => {
    expect(parsePromisesWindow('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z').ok).toBe(true);
    expect(parsePromisesWindow('2026-10-01T00:00:00Z', '2026-11-01T00:00:01Z'))
      .toEqual({ ok: false, message: expect.stringMatching(/at most 31 days/) });
  });
});

describe('floorBreakLabel', () => {
  it('labels a reserved code with its own label, whatever the catalog', () => {
    expect(floorBreakLabel('soft_phone', null)).toBe(RESERVED_BREAK_REASON_LABELS.soft_phone);
    expect(floorBreakLabel('device_away', [{ code: 'device_away', label: 'Sneaky' }] as never)).toBe(RESERVED_BREAK_REASON_LABELS.device_away);
  });

  it('labels a catalog code from the campaign catalog, else the default catalog when it lists none', () => {
    expect(floorBreakLabel('tea', [{ code: 'tea', label: 'Tea', is_paid: true }] as never)).toBe('Tea');
    expect(floorBreakLabel('lunch', [])).toBe('Lunch');
    expect(floorBreakLabel('lunch', null)).toBe('Lunch');
  });

  it('is null without a code or for a code nobody knows', () => {
    expect(floorBreakLabel(null, [])).toBeNull();
    expect(floorBreakLabel('gone_fishing', [{ code: 'tea', label: 'Tea' }] as never)).toBeNull();
  });
});

describe('floorTotals', () => {
  it('counts people on shift (not offline) and assigned (staffed, or on shift): on_shift <= assigned', () => {
    expect(floorTotals([
      { state: 'available', staffed: true },
      { state: 'on_call', staffed: false }, // on a campaign they are no longer staffed on, or the soft phone
      { state: 'offline', staffed: true }, // open session, station dropped; or no session
      { state: 'offline', staffed: false }, // an open session on a completed campaign, offline
      { state: 'break', staffed: true },
    ])).toEqual({ on_shift: 3, assigned: 4 });
    expect(floorTotals([])).toEqual({ on_shift: 0, assigned: 0 });
  });
});
