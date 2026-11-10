import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AGENCY_INBOUND_ROUTE_DEFAULTS,
  AGENCY_INBOUND_ROUTE_LIMITS as L,
  type AgencyInboundRouteConfig,
} from '@magick-agency/contracts/agency';
import { parseInboundRouteCreate, parseInboundRouteUpdate, type InboundRoutePatch } from '../../../../src/agency/inbound/route-config.js';
import type { AgencyInboundRoutePatch } from '../../../../src/db/repositories/agency.repository.js';

/*
 * The inbound route body (docs/inbound.md §8.1). The validator's bounds against the table's
 * CHECKs are exercised end to end in test/integration/agency/inbound-route-repository.test.ts
 * ("the validator's extremes are stored").
 */

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
// The validator's patch is the repository's: one shape from the request to the UPDATE.
const _patchShapesAgree: Equals<InboundRoutePatch, AgencyInboundRoutePatch> = true;
void _patchShapesAgree;

const MIN = { name: 'Main line', timezone: 'Europe/London' };

function issuesOf(body: unknown): Array<{ path: string; message: string }> {
  const out = parseInboundRouteCreate(body);
  if (out.ok) throw new Error('expected a refusal');
  return out.issues;
}

const paths = (body: unknown) => issuesOf(body).map((i) => i.path);

describe('parseInboundRouteCreate', () => {
  it('fills every field the body leaves out from AGENCY_INBOUND_ROUTE_DEFAULTS', () => {
    const out = parseInboundRouteCreate(MIN);
    expect(out).toEqual({
      ok: true,
      phoneNumberIds: undefined,
      config: { ...AGENCY_INBOUND_ROUTE_DEFAULTS, ...MIN, clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips } },
    });
  });

  it('keeps every field given; clips per slot; trims the name and the zone; de-duplicates ids', () => {
    const greeting = randomUUID();
    const campaign = randomUUID();
    const n = randomUUID();
    const body = {
      name: '  Sales  ', timezone: ' America/New_York ',
      weekly_hours: [{ day: 1, start: '09:00', end: '17:30' }, { day: 5, start: '22:00', end: '02:00' }, { day: 6, start: '00:00', end: '24:00' }],
      holidays: [{ from: '2026-12-25', to: '2026-12-26', label: ' Christmas ' }, { from: '2027-01-01', to: '2027-01-01' }],
      clips: { greeting, busy: null },
      sticky_mode: 'strict', sticky_wait_seconds: 60, sticky_lookback_days: 90,
      pool_campaign_ids: [campaign, campaign.toUpperCase()],
      queue_max_wait_seconds: 300, max_waiting: 5, max_concurrent: 8,
      after_hours_action: 'voicemail', overflow_action: 'callback', record_calls: true, recording_notice: false,
      analysis_profile_id: randomUUID(),
      disposition_catalog: [{ code: 'sorted', label: 'Sorted' }],
      phone_number_ids: [n, n],
    };
    const out = parseInboundRouteCreate(body);
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    expect(out.config).toMatchObject({
      name: 'Sales', timezone: 'America/New_York', sticky_mode: 'strict', pool_campaign_ids: [campaign],
      clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips, greeting },
      holidays: [{ from: '2026-12-25', to: '2026-12-26', label: 'Christmas' }, { from: '2027-01-01', to: '2027-01-01', label: null }],
      weekly_hours: body.weekly_hours, after_hours_action: 'voicemail', recording_notice: false,
    });
    expect(out.phoneNumberIds).toEqual([n]);
  });

  it('refuses a missing name or zone, a blank or overlong name, an abbreviation for a zone', () => {
    expect(paths({})).toEqual(expect.arrayContaining(['name', 'timezone']));
    expect(paths({ ...MIN, name: '   ' })).toEqual(['name']);
    expect(paths({ ...MIN, name: 'x'.repeat(L.NAME_MAX + 1) })).toEqual(['name']);
    for (const zone of ['GMT', 'EST', 'IST', 'Mars/Base', '']) expect(paths({ ...MIN, timezone: zone }), zone).toEqual(['timezone']);
  });

  it('refuses each malformed stretch of hours, at its own path', () => {
    const hours = (h: unknown[]) => paths({ ...MIN, weekly_hours: h });
    expect(hours([{ day: 0, start: '09:00', end: '17:00' }])).toEqual(['weekly_hours[0].day']);
    expect(hours([{ day: 8, start: '09:00', end: '17:00' }])).toEqual(['weekly_hours[0].day']);
    expect(hours([{ day: 1, start: '24:00', end: '02:00' }])).toEqual(['weekly_hours[0].start']);
    expect(hours([{ day: 1, start: '9:00', end: '17:00' }])).toEqual(['weekly_hours[0].start']);
    expect(hours([{ day: 1, start: '09:00', end: '24:30' }])).toEqual(['weekly_hours[0].end']);
    expect(hours([{ day: 1, start: '09:00', end: '17:00:00' }])).toEqual(['weekly_hours[0].end']);
    expect(hours([{ day: 1, start: '09:00', end: '17:00' }, { day: 2, start: '10:00', end: '10:00' }])).toEqual(['weekly_hours[1].end']);
    expect(hours([{ day: 1, start: '09:00', end: '17:00', lunch: true }])).toEqual(['weekly_hours[0]']);
    expect(hours(Array.from({ length: L.WEEKLY_HOURS_MAX + 1 }, () => ({ day: 1, start: '09:00', end: '10:00' })))).toEqual(['weekly_hours']);
    expect(parseInboundRouteCreate({ ...MIN, weekly_hours: Array.from({ length: L.WEEKLY_HOURS_MAX }, () => ({ day: 1, start: '09:00', end: '10:00' })) }).ok).toBe(true);
  });

  it('refuses each malformed holiday, at its own path', () => {
    const hol = (h: unknown[]) => paths({ ...MIN, holidays: h });
    expect(hol([{ from: '2026-02-30', to: '2026-03-01' }])).toEqual(['holidays[0].from']);
    expect(hol([{ from: '2026-12-26', to: '2026-12-25' }])).toEqual(['holidays[0].to']);
    expect(hol([{ from: '2026-12-01', to: '2027-01-01' }])).toEqual(['holidays[0].to']); // 32 days
    expect(parseInboundRouteCreate({ ...MIN, holidays: [{ from: '2026-12-01', to: '2026-12-31' }] }).ok).toBe(true); // 31
    expect(hol([{ from: '2026-12-25', to: '2026-12-25', label: 'x'.repeat(L.HOLIDAY_LABEL_MAX + 1) }])).toEqual(['holidays[0].label']);
    expect(hol(Array.from({ length: L.HOLIDAYS_MAX + 1 }, () => ({ from: '2026-12-25', to: '2026-12-25' })))).toEqual(['holidays']);
  });

  it('refuses every number out of its bounds, and the two cross-field rules', () => {
    const at = (o: object) => paths({ ...MIN, ...o });
    expect(at({ sticky_wait_seconds: L.STICKY_WAIT_SECONDS.min - 1 })).toEqual(['sticky_wait_seconds']);
    expect(at({ sticky_wait_seconds: 30.5 })).toEqual(['sticky_wait_seconds']);
    expect(at({ sticky_lookback_days: L.STICKY_LOOKBACK_DAYS.max + 1 })).toEqual(['sticky_lookback_days']);
    expect(at({ queue_max_wait_seconds: L.QUEUE_MAX_WAIT_SECONDS.max + 1 })).toEqual(['queue_max_wait_seconds']);
    expect(at({ max_waiting: -1 })).toEqual(['max_waiting']);
    expect(at({ max_concurrent: 0 })).toEqual(['max_concurrent']);
    expect(at({ max_concurrent: '20' })).toEqual(['max_concurrent']);
    expect(at({ sticky_wait_seconds: 60, queue_max_wait_seconds: 30 })).toEqual(['sticky_wait_seconds']);
    expect(parseInboundRouteCreate({ ...MIN, max_waiting: 20 }).ok).toBe(true); // the default max_concurrent is 20
    expect(at({ max_waiting: 21 })).toEqual(['max_waiting']);
  });

  it('refuses unknown values, unknown fields, malformed ids and a catalog the campaign rules refuse', () => {
    expect(paths({ ...MIN, sticky_mode: 'sticky' })).toEqual(['sticky_mode']);
    expect(paths({ ...MIN, overflow_action: 'hangup' })).toEqual(['overflow_action']);
    expect(paths({ ...MIN, clips: { greeting: 'not-a-uuid' } })).toEqual(['clips.greeting']);
    expect(paths({ ...MIN, clips: { lobby: null } })).toEqual(['clips']);
    expect(paths({ ...MIN, pool_campaign_ids: ['x'] })).toEqual(['pool_campaign_ids[0]']);
    expect(paths({ ...MIN, phone_number_ids: Array.from({ length: L.NUMBERS_MAX + 1 }, () => randomUUID()) })).toEqual(['phone_number_ids']);
    const unknown = issuesOf({ ...MIN, colour: 'blue' });
    expect(unknown).toEqual([{ path: '', message: 'Unknown field: colour.' }]);
    const catalog = paths({ ...MIN, disposition_catalog: [{ code: 'a', label: 'A' }, { code: 'a', label: 'Again' }] });
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((p) => p.startsWith('disposition_catalog'))).toBe(true);
    // Overrides are a campaign feature: a caller matched to no campaign has no contact to carry one.
    expect(paths({ ...MIN, disposition_catalog: [{ code: 'later', label: 'Later', override: { retry_delay: true } }] })[0])
      .toMatch(/^disposition_catalog/);
    expect(paths(null)).toEqual(['']);
  });
});

describe('parseInboundRouteUpdate', () => {
  const stored: AgencyInboundRouteConfig = {
    ...AGENCY_INBOUND_ROUTE_DEFAULTS,
    clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips, closed: '11111111-1111-4111-8111-111111111111' },
    name: 'Main line',
    timezone: 'Europe/London',
    max_waiting: 10,
    max_concurrent: 20,
  };

  it('applies only the fields present, clips per slot, and names what changed', () => {
    const greeting = randomUUID();
    const out = parseInboundRouteUpdate({ clips: { greeting }, record_calls: true, name: 'Main line' }, stored);
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    expect(out.patch).toEqual({ clips: { greeting }, record_calls: true, name: 'Main line' });
    expect(out.config.clips).toEqual({ ...stored.clips, greeting });
    expect(out.config.record_calls).toBe(true);
    expect(out.changed).toEqual(['clips', 'record_calls']); // the name was sent unchanged
    expect(out.phoneNumberIds).toBeUndefined();
  });

  it('an empty patch changes nothing; phone_number_ids alone is the number set', () => {
    const n = randomUUID();
    expect(parseInboundRouteUpdate({}, stored)).toEqual({ ok: true, patch: {}, config: stored, changed: [], phoneNumberIds: undefined });
    expect(parseInboundRouteUpdate({ phone_number_ids: [] }, stored)).toMatchObject({ ok: true, phoneNumberIds: [] });
    expect(parseInboundRouteUpdate({ phone_number_ids: [n] }, stored)).toMatchObject({ ok: true, patch: {}, phoneNumberIds: [n] });
  });

  it('judges the route the patch makes: a lower max_concurrent under the stored max_waiting is refused', () => {
    const out = parseInboundRouteUpdate({ max_concurrent: 5 }, stored);
    expect(out).toEqual({ ok: false, issues: [{ path: 'max_waiting', message: expect.stringMatching(/max_concurrent/) }] });
    expect(parseInboundRouteUpdate({ max_concurrent: 5, max_waiting: 5 }, stored).ok).toBe(true);
    expect(parseInboundRouteUpdate({ queue_max_wait_seconds: 20 }, stored)).toMatchObject({ ok: false, issues: [{ path: 'sticky_wait_seconds' }] });
  });

  it('refuses what a create refuses, at the same paths', () => {
    expect(parseInboundRouteUpdate({ timezone: 'GMT' }, stored)).toMatchObject({ ok: false, issues: [{ path: 'timezone' }] });
    expect(parseInboundRouteUpdate({ name: '' }, stored)).toMatchObject({ ok: false, issues: [{ path: 'name' }] });
    expect(parseInboundRouteUpdate({ weekly_hours: [{ day: 7, start: '10:00', end: '10:00' }] }, stored))
      .toMatchObject({ ok: false, issues: [{ path: 'weekly_hours[0].end' }] });
    expect(parseInboundRouteUpdate({ id: randomUUID() }, stored)).toMatchObject({ ok: false, issues: [{ path: '' }] });
  });
});
