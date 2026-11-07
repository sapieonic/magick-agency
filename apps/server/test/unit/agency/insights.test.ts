import { describe, expect, it } from 'vitest';
import { InsightsCache, insightsCacheKey } from '../../../src/agency/insights/cache.js';
import { callingHoursDefault, hhmm, maxAttempts } from '../../../src/agency/insights/settings.js';
import { transitionOf } from '../../../src/agency/insights/transitions.js';
import { pace } from '../../../src/agency/insights/summary.js';
import { userIdOf } from '../../../src/agency/insights/shared.js';
import { windowEndToday } from '../../../src/agency/calling-hours.js';
import type { ActivityActor } from '../../../src/agency/agency-activity.js';

/** The pure parts of the insights reads (`src/agency/insights/`). */

describe('InsightsCache', () => {
  it('shares one computation inside the TTL, single flight included, and recomputes after it', async () => {
    let now = 0;
    const cache = new InsightsCache(5_000, 10, () => now);
    let runs = 0;
    const compute = async () => ++runs;
    const [a, b] = await Promise.all([cache.get('k', compute), cache.get('k', compute)]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
    now = 4_999;
    expect(await cache.get('k', compute)).toBe(1);
    now = 5_000;
    expect(await cache.get('k', compute)).toBe(2);
  });

  it('reuses a slow answer for four times what it took (the database is busy a quarter of the time at most)', async () => {
    let now = 0;
    const cache = new InsightsCache(5_000, 10, () => now);
    let runs = 0;
    const slow = async () => { now += 3_000; return ++runs; };
    expect(await cache.get('k', slow)).toBe(1);
    now = 3_000 + 11_999;
    expect(await cache.get('k', slow)).toBe(1);
    now = 3_000 + 12_000;
    expect(await cache.get('k', slow)).toBe(2);
  });

  it('never serves a failure to the next caller', async () => {
    const cache = new InsightsCache(5_000, 10, () => 0);
    await expect(cache.get('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await cache.get('k', async () => 'ok')).toBe('ok');
  });

  it('is bounded, oldest first out', async () => {
    const cache = new InsightsCache(5_000, 2, () => 0);
    await cache.get('a', async () => 1);
    await cache.get('b', async () => 2);
    await cache.get('c', async () => 3);
    expect(cache.size).toBe(2);
    expect(await cache.get('a', async () => 9)).toBe(9);
  });

  it('keys by section, campaign, status and updated_at, so a transition or an edit misses', () => {
    const base = { id: 'c1', status: 'running', updated_at: new Date('2026-11-04T10:00:00Z') };
    expect(insightsCacheKey('summary', base)).not.toBe(insightsCacheKey('allocation', base));
    expect(insightsCacheKey('summary', base)).not.toBe(insightsCacheKey('summary', { ...base, status: 'paused' }));
    expect(insightsCacheKey('summary', base))
      .not.toBe(insightsCacheKey('summary', { ...base, updated_at: new Date('2026-11-04T10:00:01Z') }));
  });
});

describe('settings', () => {
  it('calling hours are "default" only while window and days are all the column defaults', () => {
    const d = { calling_window_start: '09:00:00', calling_window_end: '20:00:00', calling_days: [5, 4, 3, 2, 1] };
    expect(callingHoursDefault(d)).toBe(true);
    expect(callingHoursDefault({ ...d, calling_window_end: '18:00:00' })).toBe(false);
    expect(callingHoursDefault({ ...d, calling_days: [1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(hhmm('24:00:00')).toBe('24:00');
    expect(hhmm('9:05')).toBe('09:05');
  });

  it('max attempts is the most any customer outcome allows, per key over the defaults', () => {
    expect(maxAttempts({})).toBe(4); // DEFAULT_RETRY_POLICY: busy ×4
    expect(maxAttempts({ no_answer: { delay_minutes: 30, max_attempts: 6 } })).toBe(6);
    expect(maxAttempts({ busy: { max_attempts: 1 } })).toBe(3); // no_answer's default 3 remains
  });
});

describe('the running pace', () => {
  it('dials per hour from 15 minutes; ETA in dialling hours; nulls when unknown', () => {
    expect(pace({ dials15m: 30, finished1h: 60, open: 300, everDialled: true })).toEqual({ dials_per_hour: 120, eta_seconds: 5 * 3600 });
    expect(pace({ dials15m: 0, finished1h: 0, open: 300, everDialled: true })).toEqual({ dials_per_hour: 0, eta_seconds: null });
    expect(pace({ dials15m: 0, finished1h: 0, open: 300, everDialled: false })).toEqual({ dials_per_hour: null, eta_seconds: null });
  });
});

describe('transitions', () => {
  const human: ActivityActor = { system: false, user_id: 'u1', type: 'human', api_key_id: null, display: 'Asha' };
  const system: ActivityActor = { system: true, user_id: null, type: 'unknown', api_key_id: null, display: null };
  const row = (source: 'master' | 'core', action: string, actor: ActivityActor = human) => ({ source, action, at: '2026-11-04T10:00:00.000Z', actor });

  it('maps each console and dialer row to its status, reason and actor, and skips the duplicates', () => {
    expect(transitionOf(row('master', 'agency_campaign.started'))).toMatchObject({ to_status: 'running', reason: 'supervisor', user_id: 'u1' });
    expect(transitionOf(row('master', 'agency_campaign.stopped'))).toMatchObject({ to_status: 'stopping', user_id: 'u1' });
    expect(transitionOf(row('core', 'agency_campaign.auto_paused', system))).toMatchObject({ to_status: 'paused', reason: 'abandonment_ceiling', user_id: null });
    expect(transitionOf(row('core', 'agency_campaign.stopped', system))).toMatchObject({ to_status: 'stopped', reason: 'calls_drained' });
    expect(transitionOf(row('core', 'agency_campaign.completed', system))).toMatchObject({ to_status: 'completed', reason: 'completed_by_dialler' });
    expect(transitionOf(row('core', 'agency_campaign.paused'))).toBeNull();
    expect(transitionOf(row('master', 'agency_campaign.completed'))).toBeNull();
  });

  it('an auto-pause reads its reason off the row: carrier_auth from the carrier-auth pause, else abandonment_ceiling', () => {
    const auto = (detail?: Record<string, unknown>) => ({ ...row('core', 'agency_campaign.auto_paused', system), ...(detail ? { detail } : {}) });
    expect(transitionOf(auto({ campaign_id: 'c1', reason: 'carrier_auth', telephony_provider: 'plivo' })))
      .toMatchObject({ to_status: 'paused', reason: 'carrier_auth', user_id: null });
    expect(transitionOf(auto({ campaign_id: 'c1', reason: 'abandonment_ceiling', measured_pct: 4 })))
      .toMatchObject({ to_status: 'paused', reason: 'abandonment_ceiling' });
    // An older guardrail row with no reason, or none at all, is the guardrail's.
    expect(transitionOf(auto({ campaign_id: 'c1' }))).toMatchObject({ reason: 'abandonment_ceiling' });
    expect(transitionOf(auto())).toMatchObject({ reason: 'abandonment_ceiling' });
    // A supervisor's console pause is never read off a detail field.
    expect(transitionOf({ ...row('master', 'agency_campaign.paused'), detail: { reason: 'carrier_auth' } })).toMatchObject({ reason: 'supervisor' });
  });
});

describe('user references', () => {
  it('reads a bare UUID or user:<uuid>; anything else is not a user', () => {
    const id = '0b6f2c8e-6a59-4b53-8f6c-1a4d0f6a2b11';
    expect(userIdOf(id)).toBe(id);
    expect(userIdOf(`user:${id.toUpperCase()}`)).toBe(id);
    expect(userIdOf('system:api')).toBeNull();
    expect(userIdOf('someone@example.com')).toBeNull();
    expect(userIdOf(null)).toBeNull();
  });
});

describe('windowEndToday', () => {
  const w = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' };
  it('today\'s end on a calling day in the campaign zone; none on a day off', () => {
    // Wed 4 Nov 2026, 10:00 IST.
    expect(windowEndToday(w, new Date('2026-11-04T04:30:00Z'))!.toISOString()).toBe('2026-11-04T12:30:00.000Z');
    // Sat 7 Nov.
    expect(windowEndToday(w, new Date('2026-11-07T04:30:00Z'))).toBeNull();
  });

  it('an overnight window: the small hours end this morning, the evening ends tomorrow', () => {
    const night = { start: '20:00', end: '02:00', days: [1, 2, 3, 4, 5, 6, 7], timezone: 'UTC' };
    expect(windowEndToday(night, new Date('2026-11-04T01:00:00Z'))!.toISOString()).toBe('2026-11-04T02:00:00.000Z');
    expect(windowEndToday(night, new Date('2026-11-04T21:00:00Z'))!.toISOString()).toBe('2026-11-05T02:00:00.000Z');
  });
});
