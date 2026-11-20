import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WhatHappened } from '../../components/agency/station/WhatHappened';
import { AttemptDispositionCell } from '../../components/agency/AttemptDispositionCell';
import { ContactPromiseLine } from '../../components/agency/PromiseNote';
import {
  DISPOSITION_BLOCK_COPY,
  EMPTY_DISPOSITION_FORM,
  blockReason,
  buildSubmitPayload,
  promiseDateBlocked,
  type DispositionFormState,
} from '../../utils/agencyDispositionForm';
import { formatPromise, formatPromiseAmount, formatPromiseDate, PROMISE_STATE_HINTS } from '../../utils/format/promise';
import { validatePromiseEntry } from '../../utils/agency/config/configValidate';
import { dispositionSummary, editCatalog } from '../../utils/agencyCampaignConfigForm';
import { rosterFiltersFromParams, rosterFiltersToParams, rosterFilterGroupCount } from '../../utils/agencyRosterFilters';
import { NON_SELECTOR_CONTACT_FILTERS } from '../../utils/agencyRetrySelector';
import { refusalCopy } from '../../utils/softphone/refusalCopy';
import type { AgencyDisposition } from '../../types/agency';

/**
 * Promise to pay (decisions PT1–PT14) in the console: What happened?'s pay date row and its checks
 * (the client half of the server's rule), the submitted payload, the catalogue editor's rules
 * (the server's words), the Contacts filter in the URL, and how a promise is printed.
 */

afterEach(cleanup);

// 11 Aug 2026, midday UTC: the suite's TZ is pinned to UTC, so the agent's today is 11 Aug.
const T0 = Date.parse('2026-08-11T12:00:00.000Z');
const PTP: AgencyDisposition = { code: 'ptp', label: 'Promised to pay', requires_promise: true };
const PTP_FOLLOW: AgencyDisposition = { ...PTP, code: 'ptp_follow', promise_follow_up_days: 3 };
const CATALOG: AgencyDisposition[] = [
  { code: 'sale', label: 'Sale', is_success: true },
  PTP,
  PTP_FOLLOW,
];
const form = (patch: Partial<DispositionFormState>): DispositionFormState => ({ ...EMPTY_DISPOSITION_FORM, ...patch });

describe('the pad\'s checks (PT4, PT5): the client half of the server\'s rule', () => {
  it('needs a date, a real one, near the agent\'s today, and a well-formed amount', () => {
    expect(blockReason(CATALOG, form({ selectedCode: 'ptp' }), T0)).toBe('promise_required');
    expect(blockReason(CATALOG, form({ selectedCode: 'ptp', promiseDate: '2026-02-30' }), T0)).toBe('promise_date_invalid');
    // One day either side of the agent's today: the customer may be a day behind or ahead.
    expect(blockReason(CATALOG, form({ selectedCode: 'ptp', promiseDate: '2026-08-10' }), T0)).toBeNull();
    expect(blockReason(CATALOG, form({ selectedCode: 'ptp', promiseDate: '2026-08-09' }), T0)).toBe('promise_date_invalid');
    // The far edge: AGENCY_PROMISE_MAX_DAYS_AHEAD (30) after the agent's today, plus the one day
    // the customer may be ahead. T0's day is 2026-08-11, so 2026-09-11 is the last date allowed.
    expect(promiseDateBlocked('2026-09-11', T0)).toBe(false);
    expect(promiseDateBlocked('2026-09-12', T0)).toBe(true);
    expect(blockReason(CATALOG, form({ selectedCode: 'ptp', promiseDate: '2026-08-18', promiseAmount: '12,500' }), T0))
      .toBe('promise_amount_invalid');
    expect(blockReason(CATALOG, form({ selectedCode: 'ptp', promiseDate: '2026-08-18', promiseAmount: '  ' }), T0)).toBeNull();
    expect(DISPOSITION_BLOCK_COPY.promise_required).toBe('This outcome needs the date the customer promised to pay.');
  });

  it('sends the promise only with the outcome that asks for it, the amount exact', () => {
    expect(buildSubmitPayload(CATALOG, form({ selectedCode: 'ptp', promiseDate: '2026-08-18', promiseAmount: '12500.5' }), T0))
      .toEqual({ disposition_code: 'ptp', promise_date: '2026-08-18', promise_amount: '12500.50' });
    expect(buildSubmitPayload(CATALOG, form({ selectedCode: 'ptp', promiseDate: '2026-08-18' }), T0))
      .toEqual({ disposition_code: 'ptp', promise_date: '2026-08-18' });
    // A date left in the form from an earlier selection never rides on another outcome.
    expect(buildSubmitPayload(CATALOG, form({ selectedCode: 'sale', promiseDate: '2026-08-18', promiseAmount: '5' }), T0))
      .toEqual({ disposition_code: 'sale' });
  });
});

describe('What happened?\'s pay date row (the redesigned station, spec 05)', () => {
  function tiles(selectedCode: string, patch: Partial<DispositionFormState> = {}, amountDue: string | null = null) {
    const onChange = vi.fn();
    render(
      <WhatHappened
        catalog={CATALOG}
        form={form({ selectedCode, ...patch })}
        onChange={onChange}
        enabled
        now={() => T0}
        amountDue={amountDue}
        comesToMe={null}
        rejection={null}
        keysRemapped={false}
        onNeedsNote={() => {}}
        readAloud={{ available: false, say: () => {} }}
        onAskDontCallAgain={() => {}}
        dontCallAgainOffered={false}
        shake={0}
      />,
    );
    return onChange;
  }

  it('appears only for a promise outcome; chips and the picker set the date, the field the amount', () => {
    tiles('sale');
    expect(screen.queryByTestId('promise-row')).toBeNull();
    cleanup();
    const onChange = tiles('ptp');
    expect(screen.getByText('Pay date')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedCode: 'ptp', promiseDate: '2026-08-12' }));
    fireEvent.change(screen.getByLabelText('Other date'), { target: { value: '2026-09-01' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ promiseDate: '2026-09-01' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '700' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ promiseAmount: '700' }));
  });

  it('echoes what will be saved (no ₹ on a promised amount, PT5), and says when a follow-up is booked', () => {
    tiles('ptp', { promiseDate: '2026-08-18', promiseAmount: '12500' });
    expect(screen.getByTestId('promise-resolved').textContent).toBe('Will pay on 18 Aug · 12,500');
    // Saving this outcome books no call: nothing says it will.
    expect(screen.queryByTestId('promise-follow-up')).toBeNull();
    cleanup();
    tiles('ptp_follow', { promiseDate: '2026-08-18' });
    expect(screen.getByTestId('promise-resolved').textContent).toBe('Will pay on 18 Aug');
    expect(screen.getByTestId('promise-follow-up').textContent).toBe('We will call again on 21 Aug.');
  });

  it('offers Full and Half of the amount due as plain numbers, and fills the amount with either', () => {
    const onChange = tiles('ptp', {}, '12500');
    const full = screen.getByRole('button', { name: 'Full · 12,500' });
    fireEvent.click(full);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ promiseAmount: '12500' }));
    fireEvent.click(screen.getByRole('button', { name: 'Half · 6,250' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ promiseAmount: '6250' }));
    expect(screen.getByTestId('promise-row').textContent).not.toMatch(/₹/);
  });
});

describe('printing a promise (PT5: no currency, en-IN grouping, the customer\'s day)', () => {
  it('formats the date from its own parts and the amount from its digits', () => {
    expect(formatPromiseDate('2026-11-18')).toBe('18 Nov 2026');
    expect(formatPromiseAmount('125000.00')).toBe('1,25,000');
    expect(formatPromiseAmount('12500.50')).toBe('12,500.50');
    expect(formatPromiseAmount('999999999999.99')).toBe('9,99,99,99,99,999.99');
    expect(formatPromise({ date: '2026-11-18', amount: null })).toBe('Promised 18 Nov 2026');
    expect(PROMISE_STATE_HINTS.missed).toMatch(/does not mean unpaid/);
  });

  it('shows a call\'s promise under its outcome, and a contact\'s with its state', () => {
    render(
      <table><tbody><tr><td>
        <AttemptDispositionCell
          attempt={{ id: 'a1', disposition_code: 'ptp', auto_disposition_code: null, dispositioned_on_behalf: false, promise_date: '2026-11-18', promise_amount: '700.00' }}
          catalog={CATALOG}
          placeholder="—"
          testIdPrefix="t"
        />
      </td></tr></tbody></table>,
    );
    expect(screen.getByTestId('t-promise-a1').textContent).toBe('Promised 18 Nov 2026 · 700');
    render(<ContactPromiseLine promise={{ date: '2026-11-18', amount: null, state: 'missed' }} testId="line" />);
    expect(screen.getByTestId('line').textContent).toBe('Promised 18 Nov 2026Missed');
    expect(screen.getByText('Missed').getAttribute('title')).toBe(PROMISE_STATE_HINTS.missed);
  });
});

describe('the catalogue editor (PT10): the server\'s rules and words', () => {
  it('names each nonsensical combination on its field', () => {
    expect(validatePromiseEntry({ ...PTP }, 'd[0]')).toEqual({});
    expect(validatePromiseEntry({ ...PTP, requires_datetime: true }, 'd[0]')['d[0].requires_promise'])
      .toMatch(/both a promise to pay and a callback time/);
    expect(validatePromiseEntry({ ...PTP, suppress: true }, 'd[0]')['d[0].requires_promise']).toMatch(/stops the number being called/);
    expect(validatePromiseEntry({ ...PTP, promise_follow_up_days: 15 }, 'd[0]')['d[0].promise_follow_up_days']).toMatch(/from 1 to 14/);
    expect(validatePromiseEntry({ ...PTP, promise_follow_up_days: 2, terminal: true }, 'd[0]')['d[0].promise_follow_up_days'])
      .toMatch(/A closing outcome cannot book a follow-up/);
    expect(validatePromiseEntry({ ...PTP, promise_follow_up_days: 2, retry: { max_attempts: 2 } }, 'd[0]')['d[0].promise_follow_up_days'])
      .toMatch(/cannot also retry/);
    expect(validatePromiseEntry({ code: 'x', label: 'X', promise_follow_up_days: 2 }, 'd[0]')['d[0].promise_follow_up_days'])
      .toMatch(/needs the outcome to ask for a promise/);
  });

  it('turning the promise off takes its follow-up with it; the summary says what it does', () => {
    const next = editCatalog(
      { dispositions: [{ ...PTP_FOLLOW }], autoCodeRows: new Set() },
      { type: 'update', index: 0, patch: { requires_promise: false } },
    );
    expect(next.dispositions[0]).not.toHaveProperty('promise_follow_up_days');
    expect(dispositionSummary(PTP_FOLLOW)).toMatch(/We call the contact 3 days after the promised date, in calling hours\./);
    expect(dispositionSummary(PTP)).toMatch(/Recording the promise does not book a call by itself\./);
  });
});

describe('the Contacts filter (PT7)', () => {
  it('round-trips through the URL, counts as a group, drops unknown values, and is never a retry dimension', () => {
    const filters = rosterFiltersFromParams(new URLSearchParams('promise=missed&promise=due_today&promise=paid'));
    expect(filters.promise).toEqual(['missed', 'due_today']);
    expect(rosterFiltersToParams(filters).toString()).toBe('promise=missed&promise=due_today');
    expect(rosterFilterGroupCount(filters)).toBe(1);
    expect(NON_SELECTOR_CONTACT_FILTERS.promise).toBe(true);
  });
});

describe('a soft-phone refusal names the promise rule', () => {
  it('in the pad\'s own words', () => {
    expect(refusalCopy({ code: 'disposition_invalid', status: 400, message: 'x', reason: 'promise_required' }))
      .toBe('Choose the pay date.');
    expect(refusalCopy({ code: 'disposition_invalid', status: 400, message: 'x', reason: 'promise_needs_contact' }))
      .toMatch(/this number is not on the work’s list/);
    expect(refusalCopy({ code: 'disposition_invalid', status: 400, message: 'x' }))
      .toBe('That did not save. Check what you chose, the note and the time.');
  });
});
