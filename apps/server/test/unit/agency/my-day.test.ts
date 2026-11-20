import { describe, expect, it } from 'vitest';
import {
  buildMyDay,
  callLaterCustomerName,
  callLaterRouting,
  campaignRecordsPromises,
  myDayTarget,
  myDayWindow,
  parseMyDayQuery,
} from '../../../src/agency/my-day.js';
import { localDayStart } from '../../../src/agency/calling-hours.js';

/**
 * My day's pure rules (agent station BE-1, BE-2, BE-3; AS6, AS7, AS8; `src/agency/my-day.ts`):
 * the query, the campaign's day, `will_pay`'s null, the target, where the call-laters go, and the
 * customer's name on a row. The reads are pinned on Postgres in
 * `test/integration/agency/my-day.test.ts`.
 */

const CAMPAIGN = '11111111-1111-4111-8111-111111111111';

describe('parseMyDayQuery', () => {
  it('takes one campaign id, lower-cased', () => {
    expect(parseMyDayQuery({ campaign_id: CAMPAIGN.toUpperCase() })).toEqual({ ok: true, campaignId: CAMPAIGN });
  });

  it.each([
    ['nothing', {}],
    ['a malformed id', { campaign_id: 'abc' }],
    ['a repeated id', { campaign_id: [CAMPAIGN, CAMPAIGN] }],
    ['another key (no other agent, no window)', { campaign_id: CAMPAIGN, agent_user_id: CAMPAIGN }],
    ['a client clock', { campaign_id: CAMPAIGN, from: '2026-11-20T00:00:00Z' }],
  ])('refuses %s', (_label, query) => {
    expect(parseMyDayQuery(query as Record<string, unknown>).ok).toBe(false);
  });
});

describe('myDayWindow: the campaign\'s own day, by the server\'s clock', () => {
  it('Asia/Kolkata: 18:30 UTC the evening before to 18:30 UTC today', () => {
    const w = myDayWindow('Asia/Kolkata', new Date('2026-11-20T10:00:00Z'));
    expect(w).toEqual({
      timezone: 'Asia/Kolkata',
      start: new Date('2026-11-19T18:30:00Z'),
      end: new Date('2026-11-20T18:30:00Z'),
    });
  });

  it('Asia/Kolkata just after its midnight is already the next day', () => {
    const w = myDayWindow('Asia/Kolkata', new Date('2026-11-20T19:00:00Z'));
    expect(w.start).toEqual(new Date('2026-11-20T18:30:00Z'));
    expect(w.end).toEqual(new Date('2026-11-21T18:30:00Z'));
  });

  it('a zone behind UTC: America/New_York in November is UTC-5', () => {
    const w = myDayWindow('America/New_York', new Date('2026-11-20T03:00:00Z'));
    expect(w.start).toEqual(new Date('2026-11-19T05:00:00Z'));
    expect(w.end).toEqual(new Date('2026-11-20T05:00:00Z'));
  });

  it('a day with a clock change is 25 hours long (New York, 1 Nov 2026)', () => {
    const w = myDayWindow('America/New_York', new Date('2026-11-01T15:00:00Z'));
    expect(w.end.getTime() - w.start.getTime()).toBe(25 * 3_600_000);
  });

  it('an unreadable zone is cut at UTC midnight, and says so', () => {
    const w = myDayWindow('EST', new Date('2026-11-20T10:00:00Z'));
    expect(w).toEqual({ timezone: 'UTC', start: new Date('2026-11-20T00:00:00Z'), end: new Date('2026-11-21T00:00:00Z') });
  });

  it('localDayStart is null for an unusable zone', () => {
    expect(localDayStart('Not/AZone', new Date())).toBeNull();
  });
});

describe('will_pay (AS7): only where the outcomes can record a pay date', () => {
  it('a catalog with a promise outcome counts', () => {
    expect(campaignRecordsPromises([{ code: 'ptp', label: 'Will pay', requires_promise: true }])).toBe(true);
  });

  it('no promise outcome, and the default catalog (an empty one), is null', () => {
    expect(campaignRecordsPromises([{ code: 'sale', label: 'Sale', is_success: true }])).toBe(false);
    expect(campaignRecordsPromises([])).toBe(false);
    expect(campaignRecordsPromises(null)).toBe(false);
  });

  it('buildMyDay serves the count or null by it', () => {
    const base = {
      id: CAMPAIGN, assignment_mode: 'pool' as const, callback_fallback: 'pool' as const,
      context_display: {}, daily_target_calls: null,
    };
    const window = myDayWindow('UTC', new Date('2026-11-20T10:00:00Z'));
    const counts = { dialed: 9, calls: 4, talk_seconds: 600.4, successes: 2, promises: 3 };
    const read = { rows: [], today: 0, overdue: 0 };
    const now = new Date('2026-11-20T10:00:00Z');
    const withPromise = buildMyDay({ ...base, disposition_catalog: [{ code: 'ptp', label: 'Will pay', requires_promise: true }] }, window, counts, read, now);
    expect(withPromise).toMatchObject({ will_pay: 3, calls: 4, dialed: 9, talk_seconds: 600, successes: 2, target: null });
    const without = buildMyDay({ ...base, disposition_catalog: [{ code: 'sale', label: 'Sale' }] }, window, counts, read, now);
    expect(without.will_pay).toBeNull();
    expect(without).toMatchObject({
      campaign_id: CAMPAIGN, timezone: 'UTC', day_start: '2026-11-20T00:00:00.000Z', day_end: '2026-11-21T00:00:00.000Z',
      as_of: '2026-11-20T10:00:00.000Z',
    });
  });
});

describe('myDayTarget (BE-2, AS6)', () => {
  it('a set target is a calls target; none is null, never zero', () => {
    expect(myDayTarget(80)).toEqual({ metric: 'calls', value: 80 });
    expect(myDayTarget(null)).toBeNull();
    expect(myDayTarget(undefined)).toBeNull();
    expect(myDayTarget(0)).toBeNull();
    expect(myDayTarget(2001)).toBeNull();
  });
});

describe('callLaterRouting (AS8): routing decides, the copy follows', () => {
  it('pool: another agent may get the call, and one left today goes to the pool', () => {
    expect(callLaterRouting({ assignment_mode: 'pool', callback_fallback: 'wait' })).toEqual({ comes_to_me: false, left_today_goes_to: 'pool' });
  });

  it.each(['strict', 'preferred'] as const)('%s: they come to the agent; left today waits only with fallback wait', (mode) => {
    expect(callLaterRouting({ assignment_mode: mode, callback_fallback: 'wait' })).toEqual({ comes_to_me: true, left_today_goes_to: 'waits_for_me' });
    expect(callLaterRouting({ assignment_mode: mode, callback_fallback: 'pool' })).toEqual({ comes_to_me: true, left_today_goes_to: 'pool' });
  });
});

describe('callLaterCustomerName: the name, never the number', () => {
  it('the campaign\'s name role first', () => {
    expect(callLaterCustomerName({ borrower: '  Asha Rao ', name: 'Other' }, { roles: { name: 'borrower' } })).toBe('Asha Rao');
  });

  it('else the floor\'s guess', () => {
    expect(callLaterCustomerName({ customer_name: 'Ravi K' }, {})).toBe('Ravi K');
    expect(callLaterCustomerName({ borrower: '' , full_name: 'Meena S' }, { roles: { name: 'borrower' } })).toBe('Meena S');
  });

  it('null without one', () => {
    expect(callLaterCustomerName({ phone: '+919811122233' }, {})).toBeNull();
    expect(callLaterCustomerName(null, null)).toBeNull();
  });

  it('rows say overdue by the read\'s clock', () => {
    const now = new Date('2026-11-20T10:00:00Z');
    const day = buildMyDay(
      { id: CAMPAIGN, assignment_mode: 'strict', callback_fallback: 'wait', context_display: {}, disposition_catalog: [], daily_target_calls: 50 },
      myDayWindow('UTC', now),
      { dialed: 0, calls: 0, talk_seconds: 0, successes: 0, promises: 0 },
      {
        rows: [
          { contact_id: 'a', context: { name: 'Asha' }, due_at: new Date('2026-11-20T09:00:00Z') },
          { contact_id: 'b', context: {}, due_at: new Date('2026-11-20T15:00:00Z') },
        ],
        today: 1, overdue: 1,
      },
      now,
    );
    expect(day.target).toEqual({ metric: 'calls', value: 50 });
    expect(day.call_later).toEqual({
      rows: [
        { contact_id: 'a', customer_name: 'Asha', due_at: '2026-11-20T09:00:00.000Z', overdue: true },
        { contact_id: 'b', customer_name: null, due_at: '2026-11-20T15:00:00.000Z', overdue: false },
      ],
      today: 1, overdue: 1, comes_to_me: true, left_today_goes_to: 'waits_for_me',
    });
  });
});
