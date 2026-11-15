import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  combineKeyParts,
  ingestAgencyCsv,
  type AgencyIngestCandidate,
  type AgencyIngestContact,
  type AgencyIngestKeyInfo,
  type AgencyIngestRejection,
  type AgencyIngestScreenResult,
  type AgencyIngestSkip,
} from '../../../src/agency/agency-csv-ingest.js';

/**
 * The screen (IM1, IM3, IM4): the per-batch question the CSV pass asks its caller (the Do
 * Not Call list, the campaign's roster) BEFORE any row of the batch claims its duplicate
 * key, and the order rows are settled in. The check and the import both run this one
 * function, so these are the rules both report by.
 */

interface Screened {
  summary: Awaited<ReturnType<typeof ingestAgencyCsv>>;
  contacts: AgencyIngestContact[];
  rejections: AgencyIngestRejection[];
  skips: AgencyIngestSkip[];
  batches: number;
  asked: Array<{ candidates: AgencyIngestCandidate[]; key: AgencyIngestKeyInfo }>;
}

async function screenRun(
  csv: string,
  screen: (c: readonly AgencyIngestCandidate[]) => Partial<AgencyIngestScreenResult>,
  options: Partial<Parameters<typeof ingestAgencyCsv>[0]> = {},
): Promise<Screened> {
  const out: Screened = { contacts: [], rejections: [], skips: [], batches: 0, asked: [] } as unknown as Screened;
  out.summary = await ingestAgencyCsv({
    source: Readable.from([Buffer.from(csv, 'utf8')]),
    phoneColumn: 'Mobile',
    defaultCountryCode: '91',
    onBatch: (batch) => { out.batches += 1; out.contacts.push(...batch); },
    onRejected: (r) => { out.rejections.push(r); },
    onSkipped: (s) => { out.skips.push(s); },
    screen: (candidates, key) => {
      out.asked.push({ candidates: [...candidates], key });
      const r = screen(candidates);
      return { dnc: r.dnc ?? new Map(), existing: r.existing ?? new Set() };
    },
    ...options,
  });
  return out;
}

const byPhone = (phones: string[]) => (c: readonly AgencyIngestCandidate[]) =>
  new Set(c.flatMap((x, i) => (phones.includes(x.phone_e164) ? [i] : [])));

describe('the screen settles rows before they claim a key', () => {
  it('a Do Not Call row claims no key: a later row with the same loan on another number is imported (IM4)', async () => {
    const { summary, contacts, rejections } = await screenRun(
      'Mobile,Loan No\n9876500001,LN-1\n9876500002,LN-1\n9876500003,LN-1\n',
      () => ({ dnc: new Map([['+919876500001', 'tenant']]) }),
      { dedupeColumns: ['Loan No'] },
    );
    expect(contacts.map((c) => c.phone_e164)).toEqual(['+919876500002']);
    expect(rejections.map((r) => [r.row_number, r.reason_code])).toEqual([[2, 'dnc_suppressed'], [4, 'duplicate_key']]);
    // The duplicate names the row it repeats: the imported one, never the Do Not Call row.
    expect(rejections[1]!.reason).toContain('as row 3 of this file');
    expect(summary).toMatchObject({ accepted: 1, rejected: 2, skipped: 0, duplicates: 1, dnc_by_scope: { tenant: 1 } });
  });

  it('a row the campaign holds is skipped, never rejected, and so is every row with its key (IM3)', async () => {
    const { summary, contacts, rejections, skips } = await screenRun(
      'Mobile,Name\n9876500001,Asha\n9876500002,Ravi\n9876500001,Asha again\nnope,Bad\n',
      (c) => ({ existing: byPhone(['+919876500001'])(c) }),
    );
    expect(contacts.map((c) => c.phone_e164)).toEqual(['+919876500002']);
    expect(skips.map((s) => [s.row_number, s.reason_code, s.raw_value])).toEqual([
      [2, 'already_in_campaign', '9876500001'],
      [4, 'already_in_campaign', '9876500001'],
    ]);
    expect(rejections.map((r) => r.reason_code)).toEqual(['invalid_phone']);
    expect(summary).toMatchObject({ rows_read: 4, accepted: 1, skipped: 2, rejected: 1, duplicates: 0 });
    expect(summary.accepted + summary.skipped + summary.rejected).toBe(summary.rows_read);
  });

  it('wins over Do Not Call: a row already imported is reported as already in the campaign', async () => {
    const { summary } = await screenRun(
      'Mobile\n9876500001\n',
      (c) => ({ existing: new Set([0]), dnc: new Map([[c[0]!.phone_e164, 'campaign']]) }),
    );
    expect(summary).toMatchObject({ accepted: 0, skipped: 1, rejected: 0, dnc_by_scope: {} });
  });

  it('asks once per batch, with the key the row will claim, and settles every batch boundary', async () => {
    const lines = ['Mobile,Loan No'];
    for (let i = 0; i < 5; i++) lines.push(`98765000${i}${i},LN-${i}`);
    const { asked, batches } = await screenRun(lines.join('\n'), () => ({ existing: new Set([0, 1]) }), {
      dedupeColumns: ['loan no'], batchSize: 2,
    });
    expect(asked.map((a) => a.candidates.length)).toEqual([2, 2, 1]);
    expect(asked[0]!.key).toEqual({ mode: 'column', columns: ['Loan No'], phone_parts: [false] });
    expect(asked[0]!.candidates.map((c) => c.key)).toEqual(['ln-0', 'ln-1']);
    // Every batch reaches onBatch, even one that accepted nothing, so the caller's cancel
    // check sees every boundary.
    expect(batches).toBe(3);
  });

  it('a phone key is the normalised number; a combined key is the JSON of its parts', async () => {
    const phone = await screenRun('Mobile\n09876500001\n', () => ({}));
    expect(phone.asked[0]!.key).toEqual({ mode: 'phone', columns: ['Mobile'], phone_parts: [true] });
    expect(phone.asked[0]!.candidates[0]!.key).toBe('+919876500001');
    const combined = await screenRun('Mobile,Loan No\n9876500001, LN-1 \n', () => ({}), { dedupeColumns: ['Loan No', 'Mobile'] });
    expect(combined.asked[0]!.key.phone_parts).toEqual([false, true]);
    expect(combined.asked[0]!.candidates[0]!.key).toBe(JSON.stringify(['ln-1', '+919876500001']));
    const none = await screenRun('Mobile\n9876500001\n', () => ({}), { dedupePhones: false });
    expect(none.asked[0]!.key.mode).toBe('none');
    expect(none.asked[0]!.candidates[0]!.key).toBeNull();
  });

  it("a screen that throws is the caller's error, unchanged (the fail-closed Do Not Call halt)", async () => {
    class Halt extends Error {}
    await expect(ingestAgencyCsv({
      source: Readable.from([Buffer.from('Mobile\n9876500001\n')]),
      phoneColumn: 'Mobile',
      screen: () => { throw new Halt('list down'); },
    })).rejects.toBeInstanceOf(Halt);
  });

  it('reports the screened rejections in file order, whatever order they were settled in', async () => {
    const { summary } = await screenRun(
      'Mobile\n9876500001\nbad\n9876500003\n',
      () => ({ dnc: new Map([['+919876500001', 'account'], ['+919876500003', 'account']]) }),
    );
    expect(summary.errors.map((e) => e.row_number)).toEqual([2, 3, 4]);
  });
});

describe('combineKeyParts — the one definition of a duplicate key', () => {
  it('compares each part trimmed and case-insensitive, and a blank part means no key', () => {
    expect(combineKeyParts([' LN-1 '])).toBe('ln-1');
    expect(combineKeyParts(['LN-1', 'Pune'])).toBe('["ln-1","pune"]');
    expect(combineKeyParts(['a,b', 'c'])).not.toBe(combineKeyParts(['a', 'b,c']));
    expect(combineKeyParts(['LN-1', ''])).toBeNull();
    expect(combineKeyParts(['LN-1', null])).toBeNull();
    expect(combineKeyParts([])).toBeNull();
  });
});
