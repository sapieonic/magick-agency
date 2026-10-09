import { describe, it, expect } from 'vitest';

/*
 * Only `outcomeReportFilename` from `api/exportCsv.ts` is covered (the agency
 * outcome reports name their files with it); the console has no generic CSV
 * downloader, so there are no fetch / auth / URL stubs here.
 */
import { outcomeReportFilename } from '../../api/exportCsv';

describe('outcomeReportFilename', () => {
  it('uses the campaign name with a .csv suffix', () => {
    expect(outcomeReportFilename('June reminder batch', 'fallback.csv')).toBe('June reminder batch.csv');
  });

  it('falls back when the name is blank or only unsafe characters', () => {
    expect(outcomeReportFilename('   ', 'ai_calls_abc.csv')).toBe('ai_calls_abc.csv');
    expect(outcomeReportFilename('///', 'fallback.csv')).toBe('fallback.csv');
    expect(outcomeReportFilename(null, 'fallback')).toBe('fallback.csv');
  });

  it('strips path and reserved characters', () => {
    expect(outcomeReportFilename('Acme/Q2: "promo"*', 'x.csv')).toBe('Acme-Q2- -promo.csv');
  });
});
