import { describe, expect, it } from 'vitest';
import type { AgencyMyCallRow } from '../../types/agency-call-log';
import {
  MY_CALLS_TO_FOLLOW_UP_PATH,
  callbackDueCopy,
  myCallBackOf,
  myCallCustomer,
  myCallFollowUp,
  myCallOutcome,
  myCallTypeLine,
  myCallWhatHappened,
  myCallsChips,
  myCallsEmpty,
  myCallsFiltersFromParams,
  myCallsParamsForFilters,
  myCallsParamsForType,
  myCallsTypeFromParams,
} from '../../utils/agency/myCalls';

/** The agent's own My calls (`docs/call-log.md` §7): what the URL means, the chips and each row's words. */

const ROW: AgencyMyCallRow = {
  type: 'dialler', id: 'a-1', created_at: '2026-11-22T13:10:00.000Z', campaign_id: 'c-1', campaign_name: 'Diwali EMI Collections',
  contact_id: 'k-1', customer_name: 'Anjali Verma', phone: '+919876543210', phone_masked: false,
  state: 'ended', outcome: 'connected', disposition_code: 'call_later', disposition_label: 'Call later', auto_disposition_code: null,
  callback_at: null, promise_date: null, promise_amount: null, talk_seconds: 182, notes: null, attempt_number: 1, redial: false,
  dialed_at: '2026-11-22T13:10:01.000Z', requires_disposition: false, callback_of: null, wait_seconds: null, queued: false,
  voicemail_seconds: null, follow_up: null, called_back: null,
};
const row = (over: Partial<AgencyMyCallRow>): AgencyMyCallRow => ({ ...ROW, ...over });
const MISSED = row({
  type: 'inbound', id: 'i-1', outcome: 'abandoned_in_queue', disposition_code: null, disposition_label: null, attempt_number: null,
  dialed_at: null, talk_seconds: null, wait_seconds: 52, queued: true,
  follow_up: { status: 'open', reason: 'abandoned_in_queue', closed_cause: null, handled_reason: null },
});

describe('the chip in the URL', () => {
  const type = (search: string) => myCallsTypeFromParams(new URLSearchParams(search));

  it('opens on All, and on the chip the URL names', () => {
    expect(type('')).toBe('all');
    expect(type('type=to_follow_up')).toBe('to_follow_up');
    expect(type('type=inbound')).toBe('inbound');
    expect(type('type=nonsense')).toBe('all');
  });

  it('the old Soft-phone calls tab (?view=softphone) is the Soft phone chip', () => {
    expect(type('view=softphone')).toBe('soft_phone');
    // A chip named outright wins over the old word.
    expect(type('view=softphone&type=dialler')).toBe('dialler');
    expect(type('view=campaign')).toBe('all');
  });

  it('choosing a chip drops the old word and keeps the rest', () => {
    const next = myCallsParamsForType(new URLSearchParams('view=softphone&campaign_id=c-1'), 'inbound');
    expect(next.toString()).toBe('campaign_id=c-1&type=inbound');
    expect(myCallsParamsForType(next, 'all').toString()).toBe('campaign_id=c-1');
    expect(MY_CALLS_TO_FOLLOW_UP_PATH).toBe('/dialer/attempts?type=to_follow_up');
  });

  it('reads and writes the two filters beside it', () => {
    const params = new URLSearchParams('type=dialler&campaign_id=none&from=2026-11-20T18:30:00.000Z&to=garbage');
    expect(myCallsFiltersFromParams(params)).toEqual({ campaign: 'none', from: '2026-11-20T18:30:00.000Z', to: null });
    expect(myCallsParamsForFilters(params, { campaign: null, from: null, to: null }).toString()).toBe('type=dialler');
  });
});

describe('the chips', () => {
  const ids = (...args: Parameters<typeof myCallsChips>) => myCallsChips(...args).map((c) => c.id);

  it('puts To follow up first, with what the agent still owes as its number', () => {
    const chips = myCallsChips({ to_follow_up: 3, missed_open: 2, callbacks_due: 1 }, 'all', { softphone: true, inbound: true });
    expect(chips.map((c) => c.label)).toEqual(['To follow up', 'All', 'Dialler', 'Soft phone', 'Inbound']);
    expect(chips[0]).toMatchObject({ count: 3, warning: true });
    // No other chip carries a number.
    expect(chips.slice(1).every((c) => c.count === null)).toBe(true);
  });

  it('offers a type the agent cannot use only while its chip is on', () => {
    expect(ids(null, 'all', { softphone: false, inbound: false })).toEqual(['all', 'dialler']);
    expect(ids(null, 'soft_phone', { softphone: false, inbound: false })).toEqual(['all', 'dialler', 'soft_phone']);
    // A callback due is owed whatever inbound's flag says.
    expect(ids({ to_follow_up: 1, missed_open: 0, callbacks_due: 1 }, 'all', { softphone: false, inbound: false })).toEqual(['to_follow_up', 'all', 'dialler']);
  });
});

describe('a row', () => {
  it('says its type and what only that type has', () => {
    expect(myCallTypeLine(ROW)).toBe('Dialler · Try 1');
    expect(myCallTypeLine(row({ attempt_number: 2, redial: true }))).toBe('Dialler · Try 2 · redial');
    expect(myCallTypeLine(row({ type: 'soft_phone', attempt_number: null }))).toBe('Soft phone');
    const back = row({ type: 'soft_phone', attempt_number: null, created_at: '2026-11-22T15:31:00.000Z', callback_of: { inbound_call_id: 'i-1', arrived_at: '2026-11-22T15:12:00.000Z' } });
    expect(myCallTypeLine(back)).toBe('Soft phone · Call back');
    expect(myCallBackOf(back)).toBe('to the 3:12 PM missed call');
    expect(myCallTypeLine(MISSED)).toBe('Inbound · missed');
    expect(myCallTypeLine(row({ type: 'inbound', outcome: 'answered' }))).toBe('Inbound');
  });

  it('shows a hidden number as it arrived, and groups one in full', () => {
    expect(myCallCustomer(ROW)).toEqual({ name: 'Anjali Verma', number: '+91 98765 43210' });
    expect(myCallCustomer({ customer_name: null, phone: '98••• ••210', phone_masked: true })).toEqual({ name: null, number: '98••• ••210' });
    expect(myCallCustomer({ customer_name: null, phone: null, phone_masked: false }).number).toBe('Number withheld');
  });

  it('says what happened on the line', () => {
    expect(myCallWhatHappened(ROW)).toEqual({ text: 'Connected', key: 'connected' });
    expect(myCallWhatHappened(row({ type: 'inbound', outcome: 'answered', wait_seconds: 18 }))).toEqual({ text: 'Answered', key: 'connected', detail: 'waited 0:18' });
    expect(myCallWhatHappened(MISSED)).toEqual({ text: 'Missed', key: 'missed', detail: 'hung up while waiting · 0:52' });
    expect(myCallWhatHappened(row({ type: 'soft_phone', dialed_at: null, outcome: 'failed' })).text).toBe('Not dialled');
    expect(myCallWhatHappened(row({ type: 'soft_phone', state: 'connected', outcome: null })).text).toBe('On a call now');
    expect(myCallWhatHappened(row({ outcome: 'canceled', disposition_code: 'inbound_call' })).text).toBe('Stopped: customer rang us');
  });

  it('says the saved outcome in the campaign’s words, with its day', () => {
    expect(myCallOutcome(ROW)).toBe('Call later');
    expect(myCallOutcome(row({ disposition_code: 'will_pay', disposition_label: 'Will pay', promise_date: '2026-11-25' }))).toBe('Will pay · 25 Nov');
    // The campaign's list no longer has the code: the code itself.
    expect(myCallOutcome(row({ disposition_code: 'old_code', disposition_label: null }))).toBe('old_code');
    expect(myCallOutcome(row({ disposition_code: 'no_disposition', disposition_label: null }))).toBe('No outcome chosen');
    expect(myCallOutcome(row({ disposition_code: null, disposition_label: null, auto_disposition_code: 'no_answer' }))).toBe('no_answer (automatic)');
    expect(myCallOutcome(row({ disposition_code: null, disposition_label: null }))).toBeNull();
  });

  it('says where a missed call’s follow-up stands', () => {
    expect(myCallFollowUp(ROW)).toBeNull();
    expect(myCallFollowUp(MISSED)).toEqual({ calledBack: null, status: 'To follow up', open: true });
    const calledBack = { ...MISSED, created_at: '2026-11-22T15:12:00.000Z', called_back: { call_id: 's-1', at: '2026-11-22T15:31:00.000Z' } };
    expect(myCallFollowUp(calledBack)).toEqual({ calledBack: 'Called back 3:31 PM', status: 'To follow up', open: true });
    const handled = { ...MISSED, follow_up: { ...MISSED.follow_up!, status: 'handled' as const, handled_reason: 'reached' as const } };
    expect(myCallFollowUp(handled)).toEqual({ calledBack: null, status: 'Customer reached', open: false });
  });
});

describe('a callback due', () => {
  const now = new Date('2026-11-22T15:48:00.000Z');
  const callback = (dueAt: string) => ({ contact_id: 'k-1', campaign_id: 'c-1', campaign_name: 'Diwali EMI Collections', customer_name: 'Anjali Verma', due_at: dueAt, overdue: false });

  it('is due at a time, or late by how long', () => {
    expect(callbackDueCopy(callback('2026-11-22T16:00:00.000Z'), now)).toEqual({ due: 'Due 4:00 PM', late: false, booked: 'you booked it for 4:00 PM' });
    expect(callbackDueCopy(callback('2026-11-22T13:45:00.000Z'), now)).toEqual({ due: 'Late by 2 hours', late: true, booked: 'you booked it for 1:45 PM' });
    expect(callbackDueCopy(callback('2026-11-22T15:28:00.000Z'), now).due).toBe('Late by 20 minutes');
    expect(callbackDueCopy(callback('2026-11-22T14:40:00.000Z'), now).due).toBe('Late by 1 hour');
    expect(callbackDueCopy(callback('2026-11-19T15:00:00.000Z'), now).due).toBe('Late by 3 days');
  });
});

describe('an empty list', () => {
  it('says nobody is waiting, under To follow up', () => {
    expect(myCallsEmpty('to_follow_up').title).toBe('Nobody is waiting for a call from you.');
    expect(myCallsEmpty('all').title).toBe('No calls yet');
    expect(myCallsEmpty('inbound', true).title).toBe('Nothing matches those filters');
  });
});
