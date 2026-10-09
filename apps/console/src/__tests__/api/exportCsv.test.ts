import { describe, it, expect } from 'vitest';

/*
 * PORT NOTE (magick-agency): only `outcomeReportFilename` is ported from
 * `api/exportCsv.ts` (the agency outcome reports name their files with it). The
 * `filenameFromContentDisposition` (3) and `downloadExportCsv — Content-Disposition`
 * (3) describes are deleted with the AI calls / static-calls downloader, and so
 * are the fetch / firebase / URL stubs and the download-name helper only they
 * used. The three cases below are verbatim.
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
