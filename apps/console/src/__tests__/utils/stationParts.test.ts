import { describe, it, expect } from 'vitest';
import { calendarDay, clockTime, halfAmount, hoursMinutes, initials, runningClock, rupees } from '../../utils/agency/stationFormat';
import { breakIcon, outcomeIcon, outcomeTileLayout } from '../../utils/agency/stationTiles';
import { customerCard, factTilesInOrder, lastCallRows, phoneForDisplay } from '../../utils/agency/stationCustomer';
import { headsetCheckFrom, microphoneCheckFrom } from '../../utils/agency/stationDevices';
import { helpAnsweredLine, releaseBanner } from '../../utils/agency/stationCopy';
import { pickVoice } from '../../hooks/useSpeech';
import type { AgencyDisposition, AgencyReservedAttempt } from '../../types/agency';

describe('how the station writes numbers (AS15)', () => {
  it('₹ with Indian grouping, no decimals unless they are not zero', () => {
    expect(rupees('12500')).toBe('₹12,500');
    expect(rupees('125000')).toBe('₹1,25,000');
    expect(rupees('6250.50')).toBe('₹6,250.50');
    expect(rupees('6250.00')).toBe('₹6,250');
    expect(rupees('₹12,500')).toBe('₹12,500');
    expect(rupees('twelve')).toBeNull();
  });

  it('halves an amount for the Half chip, to the paisa', () => {
    expect(halfAmount('12500')).toBe('6250');
    expect(halfAmount('12501')).toBe('6250.50');
    expect(halfAmount('abc')).toBeNull();
  });

  it('dates as 20 Nov, times as 3:00 PM, clocks as 0:25, totals as 1h 52m', () => {
    expect(calendarDay('2026-11-20')).toBe('20 Nov');
    expect(calendarDay('next week')).toBe('next week');
    const d = new Date(2026, 10, 20, 15, 0);
    expect(clockTime(d)).toBe('3:00 PM');
    expect(clockTime(new Date(2026, 10, 20, 0, 5))).toBe('12:05 AM');
    expect(runningClock(25_000)).toBe('0:25');
    expect(runningClock(3_723_000)).toBe('1:02:03');
    expect(runningClock(-5)).toBe('0:00');
    expect(hoursMinutes(6720)).toBe('1h 52m');
    expect(hoursMinutes(2700)).toBe('45m');
    expect(hoursMinutes(7200)).toBe('2h');
  });

  it('initials for the avatar', () => {
    expect(initials('Ramesh Goud')).toBe('RG');
    expect(initials('K. Venkatesh Rao')).toBe('KR');
    expect(initials('Asha')).toBe('AS');
    expect(initials(null)).toBe('');
  });
});

const entry = (code: string, extra: Partial<AgencyDisposition> = {}): AgencyDisposition => ({ code, label: code, ...extra });

describe('outcome tiles (spec §6.2)', () => {
  it('keeps the server’s order and sizes by count: 1–6 big, 7–9 small, 10+ eight and More', () => {
    const six = Array.from({ length: 6 }, (_, i) => entry(`c${i}`));
    expect(outcomeTileLayout(six)).toMatchObject({ size: 'big', overflow: [] });
    expect(outcomeTileLayout(six).shown.map((e) => e.code)).toEqual(six.map((e) => e.code));
    const nine = Array.from({ length: 9 }, (_, i) => entry(`c${i}`));
    expect(outcomeTileLayout(nine)).toMatchObject({ size: 'small', overflow: [] });
    const twelve = Array.from({ length: 12 }, (_, i) => entry(`c${i}`));
    const layout = outcomeTileLayout(twelve);
    expect(layout.shown.map((e) => e.code)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    expect(layout.overflow.map((e) => e.code)).toEqual(['c8', 'c9', 'c10', 'c11']);
  });

  it('adds the red Don’t call again row only when no outcome stops calls itself', () => {
    expect(outcomeTileLayout([entry('a')]).dontCallAgainRow).toBe(true);
    expect(outcomeTileLayout([entry('a'), entry('dnc', { suppress: true })]).dontCallAgainRow).toBe(false);
  });

  it('works the picture out from the flags until the server sends one (BE-13)', () => {
    expect(outcomeIcon(entry('a', { requires_promise: true }))).toBe('rupee');
    expect(outcomeIcon(entry('a', { requires_datetime: true }))).toBe('clock');
    expect(outcomeIcon(entry('a', { suppress: true, requires_datetime: true }))).toBe('stop');
    expect(outcomeIcon(entry('a', { is_success: true }))).toBe('thumbs_up');
    expect(outcomeIcon({ ...entry('a'), label: 'Wrong number' })).toBe('wrong_number');
    expect(outcomeIcon({ ...entry('a'), label: 'Refused' })).toBe('refused');
    expect(outcomeIcon({ ...entry('a'), label: 'No one spoke' })).toBe('no_voice');
    expect(outcomeIcon(entry('a'))).toBe('dot');
    expect(outcomeIcon({ ...entry('a', { requires_promise: true }), icon: 'clock' })).toBe('clock');
    expect(outcomeIcon({ ...entry('a'), icon: 'not-a-picture' as never })).toBe('dot');
  });

  it('guesses a break’s picture from its code and label, a cup by default', () => {
    expect(breakIcon({ code: 'lunch', label: 'Lunch' })).toBe('meal');
    expect(breakIcon({ code: 'bio', label: 'Washroom' })).toBe('washroom');
    expect(breakIcon({ code: 'x', label: 'Team meeting' })).toBe('meeting');
    expect(breakIcon({ code: 'x', label: 'Training' })).toBe('training');
    expect(breakIcon({ code: 'x', label: 'Other' })).toBe('cup');
  });
});

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'EMI',
  contact_id: 'c-1',
  phone_e164: '+919876543321',
  caller_id: '+911234567890',
  attempt_number: 3,
  context: { Name: 'Ramesh Goud', City: 'Siddipet', 'Amount due': '12500', 'Due date': '2026-11-20', Loan: 'L-77' },
  prior_attempts: [
    { attempt_number: 1, outcome: 'no_answer', disposition_code: null, notes: null, ended_at: '2026-11-05T10:00:00Z', dialed_at: null, campaign_id: 'camp-1', campaign_name: 'EMI' },
    { attempt_number: 2, outcome: 'connected', disposition_code: 'cb', notes: 'Asked to call after salary.', ended_at: '2026-11-12T10:00:00Z', dialed_at: null, campaign_id: 'camp-1', campaign_name: 'EMI' },
  ],
};

describe('the customer card (spec 03/04, today’s data)', () => {
  it('reads the name and place from the columns, the other hero columns as facts, then Last call', () => {
    const card = customerCard(ATTEMPT, { hero: ['Name', 'City', 'Amount due', 'Due date'] });
    expect(card.name).toBe('Ramesh Goud');
    expect(card.initials).toBe('RG');
    expect(card.place).toBe('Siddipet');
    expect(card.phone).toBe('+919876543321');
    expect(card.facts.map((f) => [f.label, f.value])).toEqual([
      ['Amount due', '₹12,500'],
      ['Due date', '20 Nov'],
      ['Last call', '12 Nov'],
    ]);
    expect(card.lastSaid).toBe('Asked to call after salary.');
    expect(card.callLaterTag).toBeNull();
    expect(card.amountDue).toBe('12500');
  });

  it('falls back to the phone as the title when no column reads as a name', () => {
    const card = customerCard({ ...ATTEMPT, context: { Loan: 'L-1' }, prior_attempts: [] }, {});
    expect(card.name).toBeNull();
    expect(card.initials).toBe('');
  });

  it('takes the typed facts when the server sends them, and guesses nothing (BE-6)', () => {
    const facts = {
      name: 'Sunita Patil',
      place: 'Pune',
      tiles: [
        { column: 'City', type: 'text' as const, raw: 'Pune', value: null },
        { column: 'Loan', type: 'text' as const, raw: 'L-77', value: null },
        { column: 'Due on', role: 'due_date' as const, type: 'date' as const, raw: '20/11/2026', value: '2026-11-20' },
        { column: 'Balance', role: 'amount_due' as const, type: 'money' as const, raw: 'Rs 1,25,000/-', value: '125000.00' },
      ],
    };
    // Amount due, due date, then the rest; the place is not a tile again.
    expect(factTilesInOrder(facts).map((t) => t.column)).toEqual(['Balance', 'Due on', 'Loan']);
    const card = customerCard(
      {
        ...ATTEMPT,
        // The columns' names would guess differently: the typed facts win.
        context: { Name: 'Wrong Guess', Branch: 'Nowhere', 'Amount due': '99' },
        facts,
      },
      { hero: ['Name', 'Branch', 'Amount due'] },
    );
    expect(card.name).toBe('Sunita Patil');
    expect(card.initials).toBe('SP');
    expect(card.place).toBe('Pune');
    // Two facts, then Last call.
    expect(card.facts.map((f) => [f.label, f.value, f.kind])).toEqual([
      ['Balance', '₹1,25,000', 'money'],
      ['Due on', '20 Nov', 'date'],
      ['Last call', '12 Nov', 'last_call'],
    ]);
    expect(card.amountDue).toBe('125000.00');
  });

  it('shows an untyped or unread value exactly as written, and no ₹ on it', () => {
    const card = customerCard(
      {
        ...ATTEMPT,
        prior_attempts: [],
        facts: {
          tiles: [
            { column: 'Balance', role: 'amount_due', type: 'money', raw: 'about 12k', value: null },
            { column: 'EMI', type: 'text', raw: '4500', value: null },
            { column: 'Next', type: 'date', raw: 'after Diwali', value: null },
          ],
        },
      },
      undefined,
    );
    expect(card.name).toBeNull();
    expect(card.place).toBeNull();
    expect(card.facts.map((f) => [f.label, f.value, f.kind])).toEqual([
      ['Balance', 'about 12k', 'text'],
      ['EMI', '4500', 'text'],
      ['Next', 'after Diwali', 'text'],
    ]);
    // An amount the server could not read hides Full / Half.
    expect(card.amountDue).toBeNull();
  });

  it('tags a booked call-later arriving (03b), in the agent’s own words or as booked', () => {
    const due = new Date(2026, 10, 20, 15, 0).toISOString();
    const mine = customerCard({ ...ATTEMPT, callback: { due_at: due, booked_by_me: true, source: 'outcome' } }, undefined);
    expect(mine.callLaterTag).toBe('Call later · You said you will call at 3:00 PM');
    const theirs = customerCard({ ...ATTEMPT, callback: { due_at: due, booked_by_me: false, source: 'promise' } }, undefined);
    expect(theirs.callLaterTag).toBe('Call later · Booked for 3:00 PM');
  });

  it('masks the number on the card when the campaign says so (AS9)', () => {
    expect(customerCard(ATTEMPT, undefined, { phoneDisplay: 'masked' }).phone).toBe('98••• ••321');
    expect(customerCard(ATTEMPT, undefined).phone).toBe('+919876543321');
  });

  it('masks the number only when the campaign says so (AS9)', () => {
    expect(phoneForDisplay('+919876543321')).toBe('+919876543321');
    expect(phoneForDisplay('+919876543321', 'masked')).toBe('98••• ••321');
  });

  it('lists the last calls newest first, in the station’s words', () => {
    const rows = lastCallRows(ATTEMPT, [{ code: 'cb', label: 'Call later' }]);
    expect(rows.map((r) => [r.date, r.outcome, r.detail])).toEqual([
      ['12 Nov', 'Call later', '“Asked to call after salary.”'],
      ['5 Nov', 'No answer', null],
    ]);
  });
});

describe('device checks (spec 01)', () => {
  it('names a capture failure as 01b does', () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(microphoneCheckFrom(named('NotAllowedError'))).toBe('blocked');
    expect(microphoneCheckFrom(named('NotFoundError'))).toBe('not_found');
    expect(microphoneCheckFrom(named('NotReadableError'))).toBe('in_use');
    expect(microphoneCheckFrom(named('Weird'))).toBe('problem');
  });

  it('guesses a headset from the device labels, and says nothing where there are none', () => {
    expect(headsetCheckFrom(null)).toBe('unknown');
    expect(headsetCheckFrom([{ kind: 'audioinput', label: '' }])).toBe('unknown');
    expect(headsetCheckFrom([{ kind: 'audioinput', label: 'Jabra Evolve 20' }])).toBe('ok');
    expect(headsetCheckFrom([{ kind: 'audioinput', label: 'MacBook Pro Microphone' }])).toBe('missing');
  });
});

describe('the station’s own words, keyed on codes (AS15)', () => {
  it('says a call that did not connect once, whatever the reason', () => {
    expect(releaseBanner('no_answer')).toBe('The last call did not connect. You do not need to do anything.');
    expect(releaseBanner('busy')).toBe(releaseBanner('no_answer'));
    expect(releaseBanner('remote_hangup')).toBeNull();
  });

  it('says who answered a help request', () => {
    expect(helpAnsweredLine('Anitha N', 'listen')).toBe('Help is here. Anitha N is listening to this call.');
    expect(helpAnsweredLine(null, 'message')).toBe('Help is here. Your supervisor sent you a message.');
  });

  it('reads aloud in an Indian English voice when there is one (AS13)', () => {
    expect(pickVoice([{ lang: 'en-US' }, { lang: 'en_IN' }, { lang: 'hi-IN' }])).toBe(1);
    expect(pickVoice([{ lang: 'hi-IN' }, { lang: 'en-GB' }])).toBe(1);
    expect(pickVoice([{ lang: 'hi-IN' }])).toBe(-1);
  });
});
