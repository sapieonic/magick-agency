import { describe, expect, it } from 'vitest';
import { delayLabel, optionsOf } from '../../../utils/campaignSetup/ruleOptions';

/** What the setup steps' rule sentences share: the wait in words, and a select's options. */

describe('delayLabel', () => {
  it('says a wait in the largest whole unit, else hours and minutes', () => {
    expect(delayLabel(0)).toBe('0 minutes');
    expect(delayLabel(1)).toBe('1 minute');
    expect(delayLabel(45)).toBe('45 minutes');
    expect(delayLabel(60)).toBe('1 hour');
    expect(delayLabel(90)).toBe('1 hour 30 minutes');
    expect(delayLabel(121)).toBe('2 hours 1 minute');
    expect(delayLabel(1440)).toBe('1 day');
    expect(delayLabel(4320)).toBe('3 days');
  });

  it('reads a value only the API could store as a whole, non-negative minute', () => {
    expect(delayLabel(-5)).toBe('0 minutes');
    expect(delayLabel(59.6)).toBe('1 hour');
  });
});

describe('optionsOf', () => {
  const label = (n: number) => `n${n}`;

  it('offers the choices, each with its value as text and its label', () => {
    expect(optionsOf([1, 2], 2, label)).toEqual([{ value: '1', label: 'n1' }, { value: '2', label: 'n2' }]);
  });

  it('keeps a loaded value that is not a choice, in order, so opening never rewrites it', () => {
    expect(optionsOf([1, 5, 10], 7, label).map((o) => o.value)).toEqual(['1', '5', '7', '10']);
  });

  it('adds nothing for no value, or one that is not a number', () => {
    expect(optionsOf([1, 5], null, label).map((o) => o.value)).toEqual(['1', '5']);
    expect(optionsOf([1, 5], Number.NaN, label).map((o) => o.value)).toEqual(['1', '5']);
  });

  it('never sorts the shared choice list in place', () => {
    const choices = [10, 1];
    optionsOf(choices, 5, label);
    expect(choices).toEqual([10, 1]);
  });
});
