import { describe, expect, it } from 'vitest';
import { AGENCY_MAX_DEDUPE_COLUMNS, dedupeKeyName } from '../src/api/agency/agency-campaign';

// The one owner of the duplicate key's name: the ingest's `duplicate_key` rejection
// column, Insights readiness and the console all print it, so a rejected-rows export
// and the screen name the same key the same way.
describe('dedupeKeyName', () => {
  it('names one column as itself', () => {
    expect(dedupeKeyName(['Loan No'])).toBe('Loan No');
  });

  it('joins a combination with " + ", in the order given', () => {
    expect(dedupeKeyName(['Loan No', 'Branch'])).toBe('Loan No + Branch');
    expect(dedupeKeyName(['Branch', 'Loan No', 'Mobile'])).toBe('Branch + Loan No + Mobile');
  });

  it('is null for no key (the phone dedupe, or none)', () => {
    expect(dedupeKeyName([])).toBeNull();
  });

  it('a key holds at most three columns', () => {
    expect(AGENCY_MAX_DEDUPE_COLUMNS).toBe(3);
  });
});
