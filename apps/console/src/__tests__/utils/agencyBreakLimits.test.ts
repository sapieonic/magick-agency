import { describe, it, expect } from 'vitest';
import {
  breakLimitError,
  breakLimitFor,
  breakReasonsErrors,
  breakReasonsFormOf,
  breakReasonsIssueCode,
  breakReasonsPayload,
  sameBreakLimits,
  withBreakLimit,
} from '../../utils/agency/breakLimits';

/**
 * Break limits on the console (LF6, LF20, LF26, LF27): the limit a station counts down to, and the
 * Settings editor's model of a campaign's `break_reasons`.
 */

describe('breakLimitFor (the station’s countdown)', () => {
  const reasons = [
    { code: 'tea', label: 'Tea', limit_minutes: 15 },
    { code: 'training', label: 'Training' },
    // Never sent (the server drops it on read), but the rule is the same here.
    { code: 'odd', label: 'Odd', limit_minutes: 0 },
  ];

  it('finds the reason’s limit by its code', () => {
    expect(breakLimitFor('tea', reasons)).toBe(15);
  });

  it('is null with no limit, an unknown code, no code, or a limit the rule refuses', () => {
    expect(breakLimitFor('training', reasons)).toBeNull();
    expect(breakLimitFor('lunch', reasons)).toBeNull();
    expect(breakLimitFor(null, reasons)).toBeNull();
    expect(breakLimitFor('odd', reasons)).toBeNull();
  });

  it('is null for every reserved reason, whatever a catalog says', () => {
    const listed = ['soft_phone', 'device_away', 'phone_call', 'away_ring'].map((code) => ({ code, label: code, limit_minutes: 5 }));
    for (const r of listed) expect(breakLimitFor(r.code, listed), r.code).toBeNull();
  });
});

describe('breakReasonsFormOf', () => {
  it('offers the built-ins, Tea 15 and Lunch 30, to a campaign that lists none of its own', () => {
    for (const stored of [[], undefined, null, [{ code: 'soft_phone', label: 'Soft phone' }], [{ nope: true }]]) {
      const form = breakReasonsFormOf(stored);
      expect(form.builtIn).toBe(true);
      const limits = Object.fromEntries(form.rows.map((r) => [r.reason.code, r.limit]));
      expect(limits).toMatchObject({ break: '', tea: '15', lunch: '30', training: '' });
    }
  });

  it('reads a campaign’s own list as stored, marking a reserved entry listed by hand', () => {
    const form = breakReasonsFormOf([
      { code: 'tea', label: 'Chai', limit_minutes: 10, is_paid: true },
      { code: 'device_away', label: 'Away' },
    ]);
    expect(form.builtIn).toBe(false);
    expect(form.rows.map((r) => [r.reason.code, r.limit, r.reserved])).toEqual([
      ['tea', '10', false],
      ['device_away', '', true],
    ]);
  });
});

describe('breakLimitError', () => {
  it('accepts empty (no limit) and whole minutes from 1 to 240', () => {
    for (const ok of ['', '  ', '1', '15', '240', ' 30 ']) expect(breakLimitError(ok), JSON.stringify(ok)).toBeNull();
  });

  it('refuses anything else, saying the rule', () => {
    for (const bad of ['0', '241', '1.5', '-5', 'ten', '1e2', '15 min']) {
      expect(breakLimitError(bad), bad).toBe('Enter whole minutes from 1 to 240, or leave it empty for no limit.');
    }
  });

  it('keys each refused row by its code, and never a reserved one', () => {
    const form = withBreakLimit(breakReasonsFormOf([{ code: 'tea', label: 'Tea' }, { code: 'lunch', label: 'Lunch' }]), 'tea', '500');
    expect(Object.keys(breakReasonsErrors(form))).toEqual(['tea']);
  });
});

describe('breakReasonsPayload', () => {
  it('keeps every other field of each reason, sets a typed limit and leaves the key out when emptied', () => {
    const stored = [
      { code: 'tea', label: 'Chai', is_paid: true, limit_minutes: 10 },
      { code: 'lunch', label: 'Lunch', is_paid: false, limit_minutes: 30, colour: 'amber' },
      { code: 'meeting', label: 'Meeting' },
    ];
    let form = breakReasonsFormOf(stored);
    form = withBreakLimit(form, 'tea', '20');
    form = withBreakLimit(form, 'lunch', '');
    form = withBreakLimit(form, 'meeting', ' 45 ');
    expect(breakReasonsPayload(form)).toEqual([
      { code: 'tea', label: 'Chai', is_paid: true, limit_minutes: 20 },
      { code: 'lunch', label: 'Lunch', is_paid: false, colour: 'amber' },
      { code: 'meeting', label: 'Meeting', limit_minutes: 45 },
    ]);
    // Cleared means the key is gone, never `null` (which the server refuses).
    expect('limit_minutes' in breakReasonsPayload(form)[1]!).toBe(false);
  });

  it('saves the built-ins whole once a limit changes, and leaves out a reserved entry', () => {
    const builtIn = withBreakLimit(breakReasonsFormOf([]), 'tea', '10');
    expect(breakReasonsPayload(builtIn).map((r) => r.code)).toEqual(['break', 'tea', 'lunch', 'meeting', 'training', 'technical_issue', 'admin']);
    const withReserved = breakReasonsFormOf([{ code: 'tea', label: 'Tea' }, { code: 'soft_phone', label: 'Soft phone' }]);
    expect(breakReasonsPayload(withReserved).map((r) => r.code)).toEqual(['tea']);
  });
});

describe('sameBreakLimits', () => {
  it('is one setting: the same limits are no change, a typed one is', () => {
    const a = breakReasonsFormOf([{ code: 'tea', label: 'Tea', limit_minutes: 15 }]);
    expect(sameBreakLimits(a, breakReasonsFormOf([{ code: 'tea', label: 'Tea', limit_minutes: 15 }]))).toBe(true);
    expect(sameBreakLimits(a, withBreakLimit(a, 'tea', ' 15'))).toBe(true);
    expect(sameBreakLimits(a, withBreakLimit(a, 'tea', '16'))).toBe(false);
    expect(sameBreakLimits(a, withBreakLimit(a, 'tea', ''))).toBe(false);
  });
});

describe('breakReasonsIssueCode (the server’s 400, on the right row)', () => {
  const form = breakReasonsFormOf([{ code: 'tea', label: 'Tea' }, { code: 'lunch', label: 'Lunch' }]);

  it('finds the row the message names', () => {
    expect(breakReasonsIssueCode('The limit for "lunch" must be a whole number of minutes from 1 to 240. Leave it out for no limit.', form)).toBe('lunch');
  });

  it('is null when the message names no row on the form', () => {
    expect(breakReasonsIssueCode('break_reasons may not list "soft_phone": it is reserved for the soft phone.', form)).toBeNull();
    expect(breakReasonsIssueCode('break_reasons must be an array', form)).toBeNull();
  });
});
