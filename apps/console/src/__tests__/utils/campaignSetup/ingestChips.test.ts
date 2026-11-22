import { describe, expect, it } from 'vitest';
import {
  SURE_PHONE_SHARE,
  customersContinue,
  fileRowLine,
  fileSizeWords,
  ingestChips,
  phoneColumnIsSure,
  shouldAutoCheck,
} from '../../../utils/campaignSetup/ingestChips';
import { initialMapping, setDefaultCountryCode } from '../../../utils/agencyColumnMapping';
import { HIGH_REJECTION_RATIO } from '../../../utils/agencyIngestSummary';
import type { AgencyColumnAnalysis } from '../../../types/agency-campaign';
import { ANALYSIS, UPLOAD, ingestJob } from './customersFixtures';

function withPhone(over: Partial<AgencyColumnAnalysis['columns'][number]>, analysis: Partial<AgencyColumnAnalysis> = {}): AgencyColumnAnalysis {
  return {
    ...ANALYSIS,
    ...analysis,
    columns: ANALYSIS.columns.map((c) => (c.name === 'Cust Mobile' ? { ...c, ...over } : c)),
  };
}

describe('phoneColumnIsSure (CS8)', () => {
  it('is sure when the server suggested a column and most sampled rows hold a valid number in it', () => {
    expect(phoneColumnIsSure(ANALYSIS)).toBe(true);
  });

  it('is never sure when the server withheld the suggestion, or two columns were too close to call', () => {
    expect(phoneColumnIsSure({ ...ANALYSIS, suggested_phone_column: null })).toBe(false);
    expect(phoneColumnIsSure({ ...ANALYSIS, phone_column_ambiguous: true })).toBe(false);
  });

  it('is not sure of a suggested column that is not in the file, or of a file with no rows', () => {
    expect(phoneColumnIsSure({ ...ANALYSIS, suggested_phone_column: 'Mobile' })).toBe(false);
    expect(phoneColumnIsSure({ ...ANALYSIS, rows_sampled: 0 })).toBe(false);
  });

  it('counts blanks against the column: valid numbers over every sampled row, at the high-rejection line', () => {
    expect(SURE_PHONE_SHARE).toBeCloseTo(1 - HIGH_REJECTION_RATIO);
    // 100 rows, every value valid, but only 80 filled: 80% valid, exactly the line.
    expect(phoneColumnIsSure(withPhone({ phone_score: 1, non_empty: 80 }))).toBe(true);
    // 79 filled: below it, so the mapper asks.
    expect(phoneColumnIsSure(withPhone({ phone_score: 1, non_empty: 79 }))).toBe(false);
    // Every row filled, but only 70% parse.
    expect(phoneColumnIsSure(withPhone({ phone_score: 0.7, non_empty: 100 }))).toBe(false);
  });
});

describe('shouldAutoCheck', () => {
  const mapping = initialMapping(ANALYSIS);

  it('checks only as a fresh analysis lands', () => {
    expect(shouldAutoCheck('analyzing', 'mapping', ANALYSIS, mapping)).toBe(true);
    // Both answers came before React drew `analyzing`.
    expect(shouldAutoCheck('uploading', 'mapping', ANALYSIS, mapping)).toBe(true);
    // "Change columns" re-enters the mapping from a finished check: the supervisor is asking.
    expect(shouldAutoCheck('done', 'mapping', ANALYSIS, mapping)).toBe(false);
    // A step that mounts with the mapping already open (no transition seen).
    expect(shouldAutoCheck(null, 'mapping', ANALYSIS, mapping)).toBe(false);
    expect(shouldAutoCheck('mapping', 'mapping', ANALYSIS, mapping)).toBe(false);
  });

  it('does not check when the column is not sure, or the mapping cannot be sent', () => {
    expect(shouldAutoCheck('analyzing', 'mapping', { ...ANALYSIS, phone_column_ambiguous: true, suggested_phone_column: null }, initialMapping({ ...ANALYSIS, suggested_phone_column: null }))).toBe(false);
    expect(shouldAutoCheck('analyzing', 'mapping', ANALYSIS, setDefaultCountryCode(mapping, 'abc'))).toBe(false);
    expect(shouldAutoCheck('analyzing', 'mapping', null, null)).toBe(false);
  });
});

describe('ingestChips (CS6)', () => {
  it('derives each chip from the job’s counts, in the mock-up’s words', () => {
    const chips = ingestChips(ingestJob());
    expect(chips.map((c) => [c.key, c.tone, c.text])).toEqual([
      ['ready', 'success', '1,240 customers ready'],
      ['bad_phone', 'warning', '12 rows have a bad phone number. They will be left out'],
      ['dnc', 'muted', '8 on the Do Not Call list. They will be left out'],
      ['skipped', 'info', '6 already in this campaign'],
    ]);
  });

  it('adds up to the rows in the file, whatever the reasons (IM3)', () => {
    const jobs = [
      ingestJob(),
      ingestJob({
        rows_read: 100, accepted: 60, skipped: 0, rejected: 40, duplicates: 15,
        rejected_by_reason: { duplicate_phone: 10, duplicate_key: 5, ragged_row: 4, value_too_large: 1, invalid_phone: 20 },
      }),
      // Served before `rejected_by_reason`: every rejection is "another problem".
      ingestJob({ rows_read: 10, accepted: 7, skipped: 0, rejected: 3, rejected_by_reason: undefined as never }),
      // A breakdown that overshoots `rejected` cannot push the chips past the file.
      ingestJob({ rows_read: 10, accepted: 8, skipped: 0, rejected: 2, rejected_by_reason: { invalid_phone: 5 } }),
    ];
    for (const job of jobs) {
      const total = ingestChips(job).reduce((sum, chip) => sum + chip.count, 0);
      expect(total).toBe(job.rows_read);
    }
  });

  it('names duplicates and other problems as their own chips', () => {
    const chips = ingestChips(ingestJob({
      rows_read: 100, accepted: 60, skipped: 0, rejected: 40, duplicates: 15,
      rejected_by_reason: { duplicate_phone: 10, duplicate_key: 5, ragged_row: 4, value_too_large: 1, invalid_phone: 20 },
    }));
    expect(chips.find((c) => c.key === 'duplicates')?.text).toBe('15 rows repeat an earlier row. They will be left out');
    expect(chips.find((c) => c.key === 'other')?.text).toBe('5 rows have another problem. They will be left out');
  });

  it('says it in the past after an import, and agrees in number', () => {
    const chips = ingestChips(ingestJob({
      dry_run: false, rows_read: 3, accepted: 1, skipped: 0, rejected: 2,
      rejected_by_reason: { invalid_phone: 1, dnc_suppressed: 1 },
    }));
    expect(chips.map((c) => c.text)).toEqual([
      '1 customer added',
      '1 row has a bad phone number. It was left out',
      '1 on the Do Not Call list. It was left out',
    ]);
  });

  it('puts the rejected-rows download on the first rejection chip, and the skipped one on its own', () => {
    const chips = ingestChips(ingestJob());
    expect(chips.filter((c) => c.download !== null).map((c) => [c.key, c.download])).toEqual([
      ['bad_phone', 'rejected'],
      ['skipped', 'skipped'],
    ]);
    const onlyDnc = ingestChips(ingestJob({ rejected: 8, rows_read: 1_254, rejected_by_reason: { dnc_suppressed: 8 } }));
    expect(onlyDnc.find((c) => c.download === 'rejected')?.key).toBe('dnc');
    expect(ingestChips(ingestJob({ has_rejected_export: false, has_skipped_export: false })).every((c) => c.download === null)).toBe(true);
  });

  it('warns when nothing is ready, groups with en-IN commas, and leaves a job that did not complete to the full summary', () => {
    expect(ingestChips(ingestJob({ accepted: 0, rows_read: 26 }))[0]).toMatchObject({ tone: 'warning', text: 'No new customers to add' });
    expect(ingestChips(ingestJob({ accepted: 125_000, rows_read: 125_026 }))[0]!.text).toBe('1,25,000 customers ready');
    expect(ingestChips(ingestJob({ status: 'failed' }))).toEqual([]);
    expect(ingestChips(ingestJob({ status: 'cancelled', dry_run: false }))).toEqual([]);
  });
});

describe('the file row', () => {
  it('reads size and rows, exact once a job has finished', () => {
    expect(fileSizeWords(900)).toBe('900 bytes');
    expect(fileSizeWords(48 * 1024)).toBe('48 KB');
    expect(fileSizeWords(5 * 1024 * 1024)).toBe('5 MB');
    expect(fileSizeWords(1.25 * 1024 * 1024)).toBe('1.3 MB');
    expect(fileRowLine(UPLOAD, ANALYSIS, null)).toBe('48 KB · 100+ rows');
    expect(fileRowLine(UPLOAD, { rows_sampled: 1, truncated: false }, null)).toBe('48 KB · 1 row');
    expect(fileRowLine(UPLOAD, ANALYSIS, ingestJob())).toBe('48 KB · 1,266 rows');
  });
});

describe('customersContinue', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');

  it('skips when nothing is uploaded, and offers nothing while anything runs or the mapper is open', () => {
    expect(customersContinue('idle', null, null)).toEqual({ label: 'Skip for now', action: 'next' });
    for (const phase of ['uploading', 'analyzing', 'mapping', 'ingesting'] as const) {
      expect(customersContinue(phase, null, null)).toBeNull();
    }
    expect(customersContinue('done', ingestJob(), null, { importing: true })).toBeNull();
  });

  it('adds a checked file with customers ready, by its count', () => {
    expect(customersContinue('done', ingestJob(), null)).toEqual({ label: 'Add 1,240 customers', action: 'import' });
    expect(customersContinue('done', ingestJob({ accepted: 1 }), null)).toEqual({ label: 'Add 1 customer', action: 'import' });
  });

  it('never imports a check with none ready, one that failed, or one an import already holds', () => {
    const skip = { label: 'Skip for now', action: 'next' };
    expect(customersContinue('done', ingestJob({ accepted: 0 }), null)).toEqual(skip);
    expect(customersContinue('done', ingestJob({ status: 'failed' }), null)).toEqual(skip);
    expect(customersContinue('done', ingestJob({ import_job_id: 'import-1' }), null)).toEqual(skip);
  });

  it('continues after an import, and offers the retry while the check can still be imported (IM2)', () => {
    const imported = ingestJob({ job_id: 'import-1', dry_run: false, check_job_id: 'check-1', check_expires_at: null });
    expect(customersContinue('done', imported, ingestJob())).toEqual({ label: 'Continue', action: 'next' });

    const failed = { ...imported, status: 'failed' as const, accepted: 0, rejected: 0, skipped: 0, rows_read: 0 };
    expect(customersContinue('done', failed, ingestJob(), { now })).toEqual({ label: 'Add customers again', action: 'import' });
    // The check has expired: no retry; nothing landed, so skip.
    expect(customersContinue('done', failed, ingestJob({ check_expires_at: '2026-11-22T11:00:00.000Z' }), { now })).toEqual({ label: 'Skip for now', action: 'next' });
    // A stopped import whose rows partly landed, with no check to retry: those customers are in.
    const stopped = { ...imported, status: 'cancelled' as const, accepted: 300 };
    expect(customersContinue('done', stopped, null, { now })).toEqual({ label: 'Continue', action: 'next' });
  });
});
