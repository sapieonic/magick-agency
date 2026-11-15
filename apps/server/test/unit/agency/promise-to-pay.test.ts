import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Promise to pay (decisions PT1–PT14), the server's pure half: the catalogue rules on both
// validators (the public layer's and the internal handler's), the soft phone's and inbound
// routes' refusal, the disposition fields, the follow-up's instant, the contact's copy and its
// state, the list filter's SQL, the callback codes and the agent's panel. The route, the SQL and
// the exports run on real Postgres in `test/integration/api/promise-to-pay-routes.test.ts`.
// ---------------------------------------------------------------------------

import { validateAgencyCampaignConfig as validatePublic } from '../../../src/agency/agency-campaign-config.js';
import { validateAgencyCampaignConfig as validateInternal } from '../../../src/agency/campaign-config.js';
import { promiseZoneFor, validateDispositionFields, dispositionErrorMessage } from '../../../src/agency/disposition.js';
import { contactPromiseWrite, promiseFollowUpAt, promiseFollowUpDays } from '../../../src/agency/promise-to-pay.js';
import { callbackCodes } from '../../../src/db/repositories/agency/assignment-sql.js';
import { promiseFilterSql } from '../../../src/db/repositories/agency/query-builders.js';
import { contactPromise, promiseDateText, projectPriorAttempt } from '../../../src/db/repositories/agency/projections.js';
import { prepareManualDisposition } from '../../../src/agency/softphone/manual-disposition.js';
import { inboundContactSettlement } from '../../../src/agency/inbound/inbound-settlement.js';
import { softphoneRefusalMessage } from '../../../src/agency/softphone/types.js';
import { parseContactFilters } from '../../../src/agency/spine-filters.js';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import { buildPanel } from '../../../src/agency/dialer/live-attempt.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

const PTP = { code: 'ptp', label: 'Promised to pay', requires_promise: true };

function issues(entry: Record<string, unknown>, validate: 'public' | 'internal' = 'internal') {
  const body = { disposition_catalog: [entry] };
  const out = validate === 'public' ? validatePublic(body) : validateInternal(body);
  return out.map((i) => `${i.field}: ${i.message}`);
}

describe('PT10: the catalogue entry', () => {
  it.each(['public', 'internal'] as const)('accepts a promise, with or without a follow-up, terminal or retrying (%s)', (v) => {
    expect(issues(PTP, v)).toEqual([]);
    expect(issues({ ...PTP, promise_follow_up_days: 1 }, v)).toEqual([]);
    expect(issues({ ...PTP, promise_follow_up_days: 14, is_success: true, requires_note: true }, v)).toEqual([]);
    expect(issues({ ...PTP, terminal: true }, v)).toEqual([]);
    expect(issues({ ...PTP, retry: { delay_minutes: 60, max_attempts: 3 } }, v)).toEqual([]);
    expect(issues({ ...PTP, override: { extra_attempts: 2 } }, v)).toEqual([]);
  });

  it.each(['public', 'internal'] as const)('refuses each nonsensical combination with its own field (%s)', (v) => {
    expect(issues({ ...PTP, requires_promise: 'yes' }, v)).toEqual([
      'disposition_catalog[0].requires_promise: requires_promise must be a boolean.',
    ]);
    expect(issues({ ...PTP, requires_datetime: true }, v)[0]).toMatch(/^disposition_catalog\[0\]\.requires_promise: An outcome cannot ask for both a promise to pay and a callback time/);
    expect(issues({ ...PTP, suppress: true }, v)).toContain(
      'disposition_catalog[0].requires_promise: An outcome that stops the number being called cannot record a promise to pay.',
    );
    for (const days of [0, 15, 1.5, '3', null]) {
      expect(issues({ ...PTP, promise_follow_up_days: days }, v)[0]).toMatch(/promise_follow_up_days: The follow-up must be a whole number of days from 1 to 14/);
    }
    expect(issues({ code: 'x', label: 'X', promise_follow_up_days: 3 }, v)).toEqual([
      'disposition_catalog[0].promise_follow_up_days: A follow-up after the promised date needs the outcome to ask for a promise to pay.',
    ]);
    expect(issues({ ...PTP, promise_follow_up_days: 3, retry: { max_attempts: 2 } }, v)[0]).toMatch(/cannot also retry/);
    expect(issues({ ...PTP, promise_follow_up_days: 3, terminal: true }, v)[0]).toMatch(/A closing outcome cannot book a follow-up/);
  });

  it('the soft phone\'s and inbound routes\' own catalogues cannot ask for a promise', () => {
    const out = validateInternal({ disposition_catalog: [PTP] }, {}, { allowDispositionOverride: false, allowPromise: false });
    expect(out).toEqual([{
      field: 'disposition_catalog[0].requires_promise',
      message: 'Only a campaign\'s outcome list can ask for a promise to pay: calls from this list have no campaign contact to keep the promise on.',
    }]);
    expect(validateInternal({ disposition_catalog: [{ code: 'x', label: 'X', requires_promise: false }] }, {}, { allowPromise: false })).toEqual([]);
  });

  it('PT11: a promise entry cannot be an automatic outcome for unanswered calls', () => {
    const out = validateInternal({ disposition_catalog: [PTP], outcome_dispositions: { no_answer: 'ptp' } });
    expect(out).toEqual([expect.objectContaining({
      field: 'outcome_dispositions.no_answer',
      message: expect.stringMatching(/records a promise to pay.*nobody spoke to the customer/),
    })]);
  });
});

describe('PT4, PT8: the disposition\'s promise fields', () => {
  const now = new Date('2026-11-15T20:00:00Z'); // already 16 Nov in Kolkata
  const kolkataToday = { year: 2026, month: 11, day: 16 };

  it('validates in the customer\'s today and returns the promise', () => {
    expect(validateDispositionFields(PTP, { promise_date: '2026-11-15' }, now, kolkataToday))
      .toEqual({ ok: false, code: 'invalid_promise_date' });
    expect(validateDispositionFields(PTP, { promise_date: '2026-11-16', promise_amount: '99.9' }, now, kolkataToday))
      .toEqual({ ok: true, notes: null, callbackAt: null, promise: { day: kolkataToday, date: '2026-11-16', amount: '99.90' } });
    // No zone given: UTC's today (15 Nov) is the floor.
    expect(validateDispositionFields(PTP, { promise_date: '2026-11-15' }, now)).toMatchObject({ ok: true });
  });

  it('a note requirement is still checked first', () => {
    expect(validateDispositionFields({ ...PTP, requires_note: true }, {}, now)).toEqual({ ok: false, code: 'note_required' });
  });

  it('picks the zone as calling hours do: the contact\'s when usable, else the campaign\'s, else UTC', () => {
    expect(promiseZoneFor('Asia/Kolkata', 'Europe/London')).toBe('Asia/Kolkata');
    expect(promiseZoneFor('IST', 'Europe/London')).toBe('Europe/London');
    expect(promiseZoneFor(null, 'Mars/Olympus')).toBe('UTC');
  });

  it('every refusal names what to do, for the app versions that show the message as it is', () => {
    expect(dispositionErrorMessage('promise_required')).toMatch(/update it or pick another outcome/);
    expect(dispositionErrorMessage('invalid_promise_date')).toMatch(/at most 180 days ahead/);
    expect(softphoneRefusalMessage({ code: 'disposition_invalid', reason: 'promise_required' }))
      .toBe(dispositionErrorMessage('promise_required'));
    expect(softphoneRefusalMessage({ code: 'disposition_invalid', reason: 'unknown_code' })).toBe('That outcome cannot be saved as submitted.');
  });

  it('the soft phone and inbound outcome name the promise refusal as their reason', () => {
    const base = { catalog: [PTP] as AgencyDisposition[], code: 'ptp', callFields: [], submittedFields: undefined, storedFields: {}, now };
    expect(prepareManualDisposition({ ...base })).toEqual({ ok: false, refusal: { code: 'disposition_invalid', reason: 'promise_required' } });
    expect(prepareManualDisposition({ ...base, promiseDate: '2026-11-20', promiseAmount: 'lots' }))
      .toEqual({ ok: false, refusal: { code: 'disposition_invalid', reason: 'invalid_promise_amount' } });
    const ok = prepareManualDisposition({ ...base, promiseDate: '2026-11-20' });
    expect(ok.ok && ok.prepared.promise).toMatchObject({ date: '2026-11-20', amount: null });
  });
});

describe('PT2, PT3: the follow-up', () => {
  const promise = { day: { year: 2026, month: 11, day: 18 }, date: '2026-11-18', amount: null };

  it('is the start of the promised day + N in the customer\'s zone, only when the entry asks for it', () => {
    expect(promiseFollowUpAt({ ...PTP, promise_follow_up_days: 2 }, promise, 'Asia/Kolkata')?.toISOString())
      .toBe('2026-11-19T18:30:00.000Z');
    // PT3: no follow-up days, no instant; a promise alone books nothing.
    expect(promiseFollowUpAt(PTP, promise, 'Asia/Kolkata')).toBeNull();
    expect(promiseFollowUpAt({ ...PTP, promise_follow_up_days: 2 }, null, 'UTC')).toBeNull();
    // A stored value the validator would refuse is treated as none.
    expect(promiseFollowUpDays({ ...PTP, promise_follow_up_days: 99 })).toBeNull();
    expect(promiseFollowUpDays({ promise_follow_up_days: 2 })).toBeNull();
  });

  it('is a callback code (CA4 ownership, CA5 fallback, the callback bucket); a promise without one is not', () => {
    expect(callbackCodes([
      PTP, { ...PTP, code: 'ptp_f', promise_follow_up_days: 3 }, { code: 'cb', label: 'CB', requires_datetime: true },
    ] as AgencyDisposition[])).toEqual(['ptp_f', 'cb']);
  });

  it('an inbound promise with a follow-up books it even when the entry counts as a success', () => {
    const at = new Date('2026-11-20T03:30:00Z');
    const decision = { reason: 'callback_scheduled' as const, suppressedReason: null };
    expect(inboundContactSettlement({ is_success: true }, decision, at, { followUp: true })).toEqual({ kind: 'callback', at });
    expect(inboundContactSettlement({ is_success: true }, decision, at)).toEqual({ kind: 'completed' });
  });
});

describe('PT6, PT7: the contact\'s copy and its state', () => {
  it('stores the promised day\'s bounds in the customer\'s zone (DST-correct)', () => {
    const w = contactPromiseWrite({ day: { year: 2026, month: 10, day: 25 }, date: '2026-10-25', amount: '1.00' }, 'Europe/London', new Date('2026-10-20T00:00:00Z'))!;
    expect(w.dueFrom.toISOString()).toBe('2026-10-24T23:00:00.000Z');
    // 25 Oct 2026 is 25 hours long in London.
    expect(w.dueUntil.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('reads the state from the stored instants and the follow-up mark', () => {
    const row = {
      promise_date: '2026-11-18', promise_amount: '5.00',
      promise_due_from: new Date('2026-11-17T18:30:00Z'), promise_due_until: new Date('2026-11-18T18:30:00Z'),
      promise_followed_up_at: null,
    };
    expect(contactPromise(row, new Date('2026-11-17T18:29:00Z'))).toEqual({ date: '2026-11-18', amount: '5.00', state: 'upcoming' });
    expect(contactPromise(row, new Date('2026-11-18T12:00:00Z'))?.state).toBe('due_today');
    expect(contactPromise(row, new Date('2026-11-19T00:00:00Z'))?.state).toBe('missed');
    expect(contactPromise({ ...row, promise_followed_up_at: new Date() }, new Date('2026-11-19T00:00:00Z'))?.state).toBe('followed_up');
    expect(contactPromise({ ...row, promise_date: null, promise_due_from: null, promise_due_until: null })).toBeNull();
  });

  it('formats a DATE pg read as local midnight by its local day, never through UTC', () => {
    expect(promiseDateText(new Date(2026, 10, 18))).toBe('2026-11-18');
    expect(promiseDateText('2026-11-18')).toBe('2026-11-18');
    expect(promiseDateText(null)).toBeNull();
  });

  it('the list filter: each state is the same comparison, behind the partial index\'s predicate', () => {
    expect(promiseFilterSql(['any', 'missed'], 'c')).toBe('(c.promise_date IS NOT NULL AND (true))');
    expect(promiseFilterSql(['missed', 'due_today'], 'c')).toBe(
      '(c.promise_date IS NOT NULL AND ((now() >= c.promise_due_until AND c.promise_followed_up_at IS NULL)'
      + ' OR (now() >= c.promise_due_from AND now() < c.promise_due_until)))');
    expect(parseContactFilters({ promise: 'missed,upcoming' })).toEqual({ ok: true, filters: { promise: ['missed', 'upcoming'] } });
    expect(parseContactFilters({ promise: 'paid' }).ok).toBe(false);
  });

  it('PT9: a prior attempt carries its promise only when it has one', () => {
    const base = {
      attempt_number: 1, outcome: 'connected' as const, disposition_code: 'ptp', auto_disposition_code: null,
      notes: null, ended_at: null, dialed_at: null, campaign_id: 'c', campaign_name: 'C',
    };
    expect(projectPriorAttempt({ ...base, promise_date: '2026-11-18', promise_amount: '10.00' }))
      .toMatchObject({ promise_date: '2026-11-18', promise_amount: '10.00' });
    expect(projectPriorAttempt({ ...base, promise_date: null, promise_amount: null })).not.toHaveProperty('promise_date');
  });
});

describe('PT9: the agent\'s panel', () => {
  function cmd(contact: Record<string, unknown>): DialCommand {
    return {
      attemptId: 'a1', campaignId: 'c1', contactId: 'k1', callerId: '+919000000001', attemptNumber: 2,
      campaign: { name: 'Collections' },
      contact: { phone_e164: '+919811100001', context: {}, ...contact },
    } as unknown as DialCommand;
  }

  it('carries the contact\'s latest promise, and nothing when there is none', () => {
    const panel = buildPanel(cmd({
      promise_date: new Date(2099, 0, 5), promise_amount: '12500.00',
      promise_due_from: new Date('2099-01-04T18:30:00Z'), promise_due_until: new Date('2099-01-05T18:30:00Z'),
      promise_followed_up_at: null,
    }), []);
    expect(panel.promise).toEqual({ date: '2099-01-05', amount: '12500.00', state: 'upcoming' });
    expect(buildPanel(cmd({ promise_date: null }), [])).not.toHaveProperty('promise');
  });
});
