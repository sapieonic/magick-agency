import { describe, expect, it } from 'vitest';
import { AGENCY_CONTEXT_FIELD_TYPES, type AgencyContextFieldType } from '@magick-agency/contracts/agency';
import {
  parseContextFact, parseDateFact, parseMoneyFact, parseNumberFact, parsePhoneFact, parseYesNoFact,
  type ContextFactType,
} from '../../../src/context-facts';

/**
 * The parse rule behind `AgencyFactTile.value` (`src/context-facts.ts`, BE-6, AS19): money, dates,
 * numbers, phone numbers and yes / no as
 * real rosters carry them, read tolerantly of Indian formats, and `null` whenever the reading is
 * not certain (the client then shows the raw text). A table of real-world values, each side.
 */
describe('parseMoneyFact', () => {
  const READ: Array<[string, string]> = [
    ['125000', '125000'],
    ['₹1,25,000', '125000'],
    ['₹ 1,25,000', '125000'],
    ['1,25,000.50', '125000.50'],
    ['12,34,56,789', '123456789'],
    ['125,000', '125000'],
    ['1,250,000.5', '1250000.5'],
    ['1,000', '1000'],
    ['12500.00', '12500.00'],
    ['Rs. 12,500/-', '12500'],
    ['Rs 12,500', '12500'],
    ['rs.12500', '12500'],
    ['INR 5,000.00', '5000.00'],
    ['5000 INR', '5000'],
    ['12,500/- only', '12500'],
    ['  12500  ', '12500'],
    ['1 25 000', '125000'],
    ['12 500', '12500'],
    ['007500', '7500'],
    ['0', '0'],
    ['0.50', '0.50'],
  ];
  it.each(READ)('reads %j as %j', (raw, value) => {
    expect(parseMoneyFact(raw)).toBe(value);
  });

  const REFUSED: Array<[string, string]> = [
    ['blank', ''],
    ['spaces only', '   '],
    ['a placeholder', '-'],
    ['not applicable', 'N/A'],
    ['a minus sign', '-500'],
    ['brackets (a credit)', '(500)'],
    ['a decimal comma', '12,50'],
    ['a grouping that is neither form', '1,2,3'],
    ['a short last group', '1,25,00'],
    ['three decimals', '12.505'],
    ['two decimal points', '1.2.3'],
    ['words', '1.25 lakh'],
    ['an exponent', '1e+21'],
    ['another currency', '$500'],
    ['junk', 'pending'],
    ['two amounts', '500 / 600'],
    ['two amounts side by side, not a grouping', '5000 2500'],
    ['a space where no grouping comma stands', '12 50'],
    ['a space in a western group of two', '1 25'],
    ['spaces and commas in one amount', '1 25,000'],
    ['a space among the decimals', '125000.5 0'],
    ['too long to be one amount', '1'.repeat(65)],
  ];
  it.each(REFUSED)('refuses %s (%j) with null', (_why, raw) => {
    expect(parseMoneyFact(raw)).toBeNull();
  });
});

describe('parseDateFact', () => {
  const READ: Array<[string, string]> = [
    ['2026-11-25', '2026-11-25'],
    ['2026-1-5', '2026-01-05'],
    ['2026/11/25', '2026-11-25'],
    ['2026-11-25 00:00:00', '2026-11-25'],
    ['2026-11-25T10:30', '2026-11-25'],
    ['25/11/2026', '2026-11-25'],
    ['5/1/2026', '2026-01-05'],
    ['25-11-2026', '2026-11-25'],
    ['25.11.2026', '2026-11-25'],
    ['25-11-26', '2026-11-25'],
    ['25/11/2026 10:30 AM', '2026-11-25'],
    // Day first, as the roster's country writes it: 3 April, never 4 March.
    ['03/04/2026', '2026-04-03'],
    ['25 Nov 2026', '2026-11-25'],
    ['25-Nov-2026', '2026-11-25'],
    ['25-Nov-26', '2026-11-25'],
    ['25 November 2026', '2026-11-25'],
    ['25th Nov 2026', '2026-11-25'],
    ['1st Sept 2026', '2026-09-01'],
    ['25 nov, 2026', '2026-11-25'],
    ['Nov 25, 2026', '2026-11-25'],
    ['November 25 2026', '2026-11-25'],
    ['29/02/2028', '2028-02-29'],
    ['  25/11/2026 ', '2026-11-25'],
  ];
  it.each(READ)('reads %j as %j', (raw, value) => {
    expect(parseDateFact(raw)).toBe(value);
  });

  const REFUSED: Array<[string, string]> = [
    ['blank', ''],
    ['a placeholder', 'NA'],
    ['month first with numbers (never guessed)', '11/25/2026'],
    ['a day the calendar does not have', '31/02/2026'],
    ['29 February in a common year', '29/02/2026'],
    ['month 13', '01/13/2026'],
    ['an instant with a zone', '2026-11-25T18:30:00Z'],
    ['an instant with an offset', '2026-11-25T18:30:00+05:30'],
    ['a spreadsheet serial number', '46351'],
    ['a month name it does not know', '25 Novv 2026'],
    ['no year', '25 Nov'],
    ['a three-digit year', '25/11/226'],
    ['a year out of range', '25/11/1850'],
    ['junk', 'next Friday'],
    ['an amount', '₹12,500'],
  ];
  it.each(REFUSED)('refuses %s (%j) with null', (_why, raw) => {
    expect(parseDateFact(raw)).toBeNull();
  });
});

describe('parseDateFact: a two-digit year is the century nearest today', () => {
  const NOW = new Date('2026-11-20T06:00:00Z');
  const CASES: Array<[string, string]> = [
    // 41 years back is nearer than 59 ahead.
    ['15/08/85', '1985-08-15'],
    ['15-Aug-85', '1985-08-15'],
    ['25-11-26', '2026-11-25'],
    ['01/01/00', '2000-01-01'],
    // About 43 years ahead is nearer than nearly 57 back.
    ['01/01/70', '2070-01-01'],
    // Either side of the ±50-year edge, by the whole date: 49½ years back, and 49½ ahead.
    ['20/05/77', '1977-05-20'],
    ['20/05/76', '2076-05-20'],
  ];
  it.each(CASES)('on 20 Nov 2026 reads %j as %j', (raw, value) => {
    expect(parseDateFact(raw, NOW)).toBe(value);
  });

  it('follows the clock it is given', () => {
    expect(parseDateFact('15/08/85', new Date('2060-01-01T00:00:00Z'))).toBe('2085-08-15');
    expect(parseContextFact('15/08/85', 'date', NOW)).toBe('1985-08-15');
  });

  it('a four-digit year is taken as written', () => {
    expect(parseDateFact('15/08/2085', NOW)).toBe('2085-08-15');
  });
});

describe('parseNumberFact (AS19)', () => {
  const READ: Array<[string, string]> = [
    ['24', '24'],
    ['1,25,000', '125000'],
    ['125,000', '125000'],
    ['1 25 000', '125000'],
    ['10.375', '10.375'],
    ['0012', '12'],
    ['0', '0'],
    ['  7  ', '7'],
    ['1,250,000.5', '1250000.5'],
  ];
  it.each(READ)('reads %j as %j', (raw, value) => {
    expect(parseNumberFact(raw)).toBe(value);
  });

  const REFUSED: Array<[string, string]> = [
    ['blank', ''],
    ['a placeholder', '-'],
    ['a rupee sign', '₹1,25,000'],
    ['a currency word', 'Rs 500'],
    ['a minus sign', '-5'],
    ['a plus sign', '+5'],
    ['a percent', '12%'],
    ['a decimal comma', '12,50'],
    ['a grouping of neither form', '1,2,3'],
    ['two numbers side by side', '5000 2500'],
    ['spaces and commas mixed', '1,25 000'],
    ['two decimal points', '1.2.3'],
    ['a trailing point', '12.'],
    ['words', '1.25 lakh'],
    ['an exponent', '1e5'],
    ['too long', '1'.repeat(65)],
  ];
  it.each(REFUSED)('refuses %s (%j)', (_why, raw) => {
    expect(parseNumberFact(raw)).toBeNull();
  });
});

describe('parsePhoneFact (AS19)', () => {
  const READ: Array<[string, string]> = [
    ['9876543210', '9876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['098765 43210', '09876543210'],
    ['(020) 2567-8901', '02025678901'],
    ['+1 (415) 555-0100', '+14155550100'],
    ['123456', '123456'],
    ['123456789012345', '123456789012345'],
    ['  98765-43210  ', '9876543210'],
  ];
  it.each(READ)('reads %j as %j', (raw, value) => {
    expect(parsePhoneFact(raw)).toBe(value);
  });

  const REFUSED: Array<[string, string]> = [
    ['blank', ''],
    ['a placeholder', 'N/A'],
    ['five digits', '12345'],
    ['sixteen digits', '1234567890123456'],
    ['a plus not first', '91+9876543210'],
    ['two pluses', '++919876543210'],
    ['letters', '98765 ABCDE'],
    ['an extension', '020 2567 8901 ext 12'],
    ['dots', '98765.43210'],
    ['a spreadsheet float', '9876543210.0'],
    ['two numbers', '9876543210 / 9123456780'],
    ['punctuation only', '(--)'],
  ];
  it.each(REFUSED)('refuses %s (%j)', (_why, raw) => {
    expect(parsePhoneFact(raw)).toBeNull();
  });
});

describe('parseYesNoFact (AS19)', () => {
  it.each(['yes', 'Yes', 'Y', 'y', 'TRUE', 'true', '1', 'haan', 'Haan', 'ha', '  YES  '])('reads %j as yes', (raw) => {
    expect(parseYesNoFact(raw)).toBe('yes');
  });
  it.each(['no', 'No', 'N', 'n', 'FALSE', 'false', '0', 'nahi', 'Nahin', ' no '])('reads %j as no', (raw) => {
    expect(parseYesNoFact(raw)).toBe('no');
  });
  it.each(['', '-', 'maybe', 'yes please', 'yess', 'nope', '2', 'हाँ', 'y e s', 'ok'])('refuses %j', (raw) => {
    expect(parseYesNoFact(raw)).toBeNull();
  });
});

describe('parseContextFact', () => {
  it('knows exactly the contract\'s field types', () => {
    const same: [ContextFactType] extends [AgencyContextFieldType]
      ? [AgencyContextFieldType] extends [ContextFactType] ? true : false
      : false = true;
    void same;
    // Every listed type other than text reads something.
    const samples: Record<AgencyContextFieldType, string> = {
      text: 'x', money: '₹5', date: '2026-11-25', number: '5', phone: '9876543210', yes_no: 'yes',
    };
    for (const type of AGENCY_CONTEXT_FIELD_TYPES) {
      expect(parseContextFact(samples[type], type) === null, type).toBe(type === 'text');
    }
  });

  it('reads the AS19 types by the column type, and a type it does not know as null', () => {
    expect(parseContextFact('1,25,000', 'number')).toBe('125000');
    expect(parseContextFact('+91 98765 43210', 'phone')).toBe('+919876543210');
    expect(parseContextFact('Haan', 'yes_no')).toBe('yes');
    expect(parseContextFact('1,25,000', 'phone')).toBeNull();
    expect(parseContextFact('Haan', 'number')).toBeNull();
    expect(parseContextFact('yes', 'percent' as ContextFactType)).toBeNull();
  });

  it('reads by the column type; text is never parsed', () => {
    expect(parseContextFact('₹1,25,000', 'money')).toBe('125000');
    expect(parseContextFact('25/11/2026', 'date')).toBe('2026-11-25');
    expect(parseContextFact('₹1,25,000', 'text')).toBeNull();
    expect(parseContextFact('25/11/2026', 'text')).toBeNull();
    // The wrong type for the value is null, never a guess.
    expect(parseContextFact('25/11/2026', 'money')).toBeNull();
    expect(parseContextFact('₹1,25,000', 'date')).toBeNull();
  });
});
