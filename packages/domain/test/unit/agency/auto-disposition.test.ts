import { describe, expect, it } from 'vitest';
import { AGENCY_AUTO_DISPOSITION_OUTCOMES } from '@magick-agency/contracts/agency';
import { autoDispositionRefusal, isAutoDispositionOutcome } from '../../../src/auto-disposition';

describe('isAutoDispositionOutcome (OD2)', () => {
  it('accepts exactly the five unanswered outcomes', () => {
    const all = ['connected', 'no_answer', 'busy', 'failed', 'machine', 'invalid', 'abandoned',
      'agent_disconnected', 'orphaned', 'canceled', 'ringing', ''];
    expect(all.filter(isAutoDispositionOutcome)).toEqual([...AGENCY_AUTO_DISPOSITION_OUTCOMES]);
  });
});

describe('autoDispositionRefusal (OD3)', () => {
  const catalog = [
    { code: 'retry_later', label: 'Retry later' },
    { code: 'callback', label: 'Callback', requires_datetime: true, retry: { max_attempts: 2 } },
    { code: 'do_not_call', label: 'Do not call', suppress: true },
    { code: 'sale', label: 'Sale', terminal: true },
  ];

  it('allows a plain, a callback or a retrying entry: an automatic outcome is a label only', () => {
    expect(autoDispositionRefusal(catalog, 'retry_later')).toBeNull();
    expect(autoDispositionRefusal(catalog, 'callback')).toBeNull();
  });

  it('refuses a code the catalog lacks, one that suppresses, one that is terminal', () => {
    expect(autoDispositionRefusal(catalog, 'gone')).toBe('missing');
    expect(autoDispositionRefusal(catalog, 'do_not_call')).toBe('suppress');
    expect(autoDispositionRefusal(catalog, 'sale')).toBe('terminal');
  });

  it('reads the FIRST entry with the code, as every catalog lookup does', () => {
    expect(autoDispositionRefusal([{ code: 'x', label: 'X' }, { code: 'x', label: 'X', suppress: true }], 'x')).toBeNull();
    expect(autoDispositionRefusal([{ code: 'x', label: 'X', terminal: true }, { code: 'x', label: 'X' }], 'x')).toBe('terminal');
  });

  it('is safe on a malformed catalog', () => {
    expect(autoDispositionRefusal(null, 'x')).toBe('missing');
    expect(autoDispositionRefusal({ x: 1 }, 'x')).toBe('missing');
    expect(autoDispositionRefusal([null, 3, 'x', { code: 'x', suppress: 'yes' }], 'x')).toBeNull();
  });
});
