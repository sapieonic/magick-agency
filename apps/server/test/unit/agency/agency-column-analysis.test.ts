import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  analyzeAgencyCsvColumns,
  suggestPhoneColumn,
  type AgencyColumnStat,
} from '../../../src/agency/agency-column-analysis.js';

function streamOf(content: string): Readable {
  return Readable.from([Buffer.from(content, 'utf8')]);
}

function stat(name: string, phoneScore: number, nonEmpty = 10): AgencyColumnStat {
  return { name, index: 0, samples: [], non_empty: nonEmpty, phone_score: phoneScore };
}

describe('column analysis for the mapping screen', () => {
  const csv = [
    'Mobile,First Name,Policy #,Alt Mobile',
    '9876543210,Asha,POL-1,',
    '9123456780,Ravi,POL-2,9000000001',
    '9988776655,Priya,POL-3,',
    '9555000111,Dev,POL-4,',
  ].join('\n');

  it('returns headers and exactly three sample values per column', async () => {
    const analysis = await analyzeAgencyCsvColumns({ source: streamOf(csv) });

    expect(analysis.headers).toEqual(['Mobile', 'First Name', 'Policy #', 'Alt Mobile']);
    expect(analysis.rows_sampled).toBe(4);

    const name = analysis.columns.find((c) => c.name === 'First Name')!;
    // Three, because a header alone cannot identify a phone column and four
    // would not fit the cell the UI renders them in.
    expect(name.samples).toEqual(['Asha', 'Ravi', 'Priya']);
  });

  it('skips empty values when sampling, so a sparse column still shows real data', async () => {
    const analysis = await analyzeAgencyCsvColumns({ source: streamOf(csv) });
    const alt = analysis.columns.find((c) => c.name === 'Alt Mobile')!;
    expect(alt.samples).toEqual(['9000000001']);
    expect(alt.non_empty).toBe(1);
  });

  it('scores phone-likelihood over VALUES, not header text', async () => {
    const analysis = await analyzeAgencyCsvColumns({ source: streamOf(csv), defaultCountryCode: '91' });

    const mobile = analysis.columns.find((c) => c.name === 'Mobile')!;
    const policy = analysis.columns.find((c) => c.name === 'Policy #')!;
    expect(mobile.phone_score).toBe(1);
    expect(policy.phone_score).toBe(0);
  });

  it('scores over non-empty values only, so a sparse phone column is not penalised', async () => {
    const analysis = await analyzeAgencyCsvColumns({ source: streamOf(csv), defaultCountryCode: '91' });
    const alt = analysis.columns.find((c) => c.name === 'Alt Mobile')!;
    // One of four rows populated, and that one is a valid number.
    expect(alt.phone_score).toBe(1);
    expect(alt.non_empty).toBe(1);
  });

  it('bounds the read and flags truncation', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => `+9198765${String(40000 + i)},N${i}`).join('\n');
    const analysis = await analyzeAgencyCsvColumns({
      source: streamOf(`Mobile,Name\n${rows}\n`),
      rowSample: 50,
    });
    expect(analysis.rows_sampled).toBe(50);
    expect(analysis.truncated).toBe(true);
  });

  it('de-duplicates headers exactly as the ingest will, so the mapping resolves', async () => {
    // If the mapper offered raw headers while the ingest wrote suffixed ones,
    // the operator's chosen column would not match at ingest time.
    const analysis = await analyzeAgencyCsvColumns({ source: streamOf('Mobile,Notes,Notes\n1,a,b\n') });
    expect(analysis.headers).toEqual(['Mobile', 'Notes', 'Notes (2)']);
  });

  it('handles a BOM so the first column is selectable', async () => {
    const analysis = await analyzeAgencyCsvColumns({ source: streamOf('﻿Mobile,Name\n9876543210,Asha\n') });
    expect(analysis.headers[0]).toBe('Mobile');
  });

  it('returns a structured empty analysis for an empty file', async () => {
    const analysis = await analyzeAgencyCsvColumns({ source: streamOf('') });
    expect(analysis.headers).toEqual([]);
    expect(analysis.columns).toEqual([]);
    expect(analysis.suggested_phone_column).toBeNull();
  });
});

describe('phone-column suggestion', () => {
  it('suggests the clear winner', () => {
    const result = suggestPhoneColumn([stat('Mobile', 1), stat('Ref No', 0.1)]);
    expect(result.suggested_phone_column).toBe('Mobile');
    expect(result.phone_column_ambiguous).toBe(false);
  });

  it('withholds a suggestion when two columns are within 10%', () => {
    // Guessing wrong here dials the wrong people, so declining is the correct
    // behaviour, not a cop-out.
    const result = suggestPhoneColumn([stat('Mobile', 1), stat('Alt Mobile', 0.98)]);
    expect(result.suggested_phone_column).toBeNull();
    expect(result.phone_column_ambiguous).toBe(true);
    expect(result.phone_column_candidates).toEqual(['Mobile', 'Alt Mobile']);
  });

  it('lets header text break a tie when only ONE candidate looks phone-ish', () => {
    // `Ref No` full of ten-digit integers scores like a phone column on values
    // alone; the header is the only signal that separates them.
    const result = suggestPhoneColumn([stat('Ref No', 1), stat('Mobile', 1)]);
    expect(result.suggested_phone_column).toBe('Mobile');
  });

  it('still declines when BOTH candidates look phone-ish — the spec\'s hard case', () => {
    // `Mobile` vs `Alt Mobile`: the header bonus applies to both and cancels, so
    // the tie stands and the operator picks. This is the case the header bonus
    // must NOT resolve.
    const result = suggestPhoneColumn([stat('Mobile', 1), stat('Alt Mobile', 1)]);
    expect(result.suggested_phone_column).toBeNull();
    expect(result.phone_column_ambiguous).toBe(true);
    expect(result.phone_column_candidates).toEqual(['Mobile', 'Alt Mobile']);
  });

  it('does not let header text alone create a suggestion', () => {
    // A column called `Phone` whose values never parse is not a phone column.
    const result = suggestPhoneColumn([stat('Phone', 0), stat('Ref', 0)]);
    expect(result.suggested_phone_column).toBeNull();
    expect(result.phone_column_ambiguous).toBe(false);
  });

  it('suggests nothing when no column parses as a phone number', () => {
    const result = suggestPhoneColumn([stat('Name', 0), stat('City', 0)]);
    expect(result.suggested_phone_column).toBeNull();
    expect(result.phone_column_candidates).toEqual([]);
  });
});
