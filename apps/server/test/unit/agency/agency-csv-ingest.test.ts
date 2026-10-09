import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  ingestAgencyCsv,
  AgencyIngestError,
  dedupeHeaders,
  AGENCY_MAX_COLUMNS,
  type AgencyIngestContact,
  type AgencyIngestRejection,
  type AgencyIngestSummary,
} from '../../../src/agency/agency-csv-ingest.js';

/**
 * Built against a fixture matrix (cases C1–C19). The module
 * takes a `Readable`, so every case here runs in the unit tier with no
 * infrastructure — which is exactly why it takes a `Readable`.
 *
 * Where a case calls for asserting WHICH outcome occurs, the assertion here IS the decision,
 * and the comment says why.
 */

function streamOf(content: string | Buffer): Readable {
  return Readable.from([Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')]);
}

interface RunResult {
  summary: AgencyIngestSummary;
  contacts: AgencyIngestContact[];
  rejections: AgencyIngestRejection[];
}

async function run(
  content: string | Buffer,
  options: Partial<Parameters<typeof ingestAgencyCsv>[0]> & { phoneColumn: string },
): Promise<RunResult> {
  const contacts: AgencyIngestContact[] = [];
  const rejections: AgencyIngestRejection[] = [];
  const summary = await ingestAgencyCsv({
    source: streamOf(content),
    onBatch: (batch) => {
      contacts.push(...batch);
    },
    onRejected: (r) => {
      rejections.push(r);
    },
    ...options,
  });
  return { summary, contacts, rejections };
}

// ─── C1/C2/C3/C4 — the phone column is MAPPED, never inferred ───────────────

describe('C1 — arbitrary headers, phone column by mapping', () => {
  const csv = 'Mobile,First Name,Policy #,Renewal Dt\n9876543210,Asha,POL-1,2026-09-01\n';

  it('accepts the mapped column and keeps every other header as-is', async () => {
    const { summary, contacts } = await run(csv, { phoneColumn: 'Mobile' });

    expect(summary.accepted).toBe(1);
    expect(contacts[0]!.phone_e164).toBe('+919876543210');
    // Headers kept as-is — the space in "First Name" and the "#" in "Policy #"
    // survive, because the agent screen renders these keys as-is.
    expect(contacts[0]!.context).toEqual({
      'First Name': 'Asha',
      'Policy #': 'POL-1',
      'Renewal Dt': '2026-09-01',
    });
    // The phone column is NOT duplicated into context.
    expect(contacts[0]!.context).not.toHaveProperty('Mobile');
  });
});

describe('C2 — a phone column with an awkward name', () => {
  it('maps by supplied name, never by inference', async () => {
    const csv = 'Contact Number (primary),Name\n9876543210,Asha\n';
    const { summary, contacts } = await run(csv, { phoneColumn: 'Contact Number (primary)' });
    expect(summary.accepted).toBe(1);
    expect(contacts[0]!.phone_e164).toBe('+919876543210');
  });

  it('fails the file when the mapped column is absent', async () => {
    const csv = 'Mobile,Name\n9876543210,Asha\n';
    await expect(run(csv, { phoneColumn: 'Telephone' })).rejects.toMatchObject({
      name: 'AgencyIngestError',
      code: 'phone_column_missing',
    });
  });
});

describe('C3 — a column literally named `phone` takes no special path', () => {
  it('works, and only because it was mapped', async () => {
    const csv = 'phone,name\n9876543210,Asha\n';
    const { summary } = await run(csv, { phoneColumn: 'phone' });
    expect(summary.accepted).toBe(1);
  });

  it('is still rejected when a DIFFERENT column is mapped and it is invalid', async () => {
    // Proves there is no fallback to a column called `phone`.
    const csv = 'phone,alt\n9876543210,notanumber\n';
    const { summary, rejections } = await run(csv, { phoneColumn: 'alt' });
    expect(summary.accepted).toBe(0);
    expect(rejections[0]!.reason_code).toBe('invalid_phone');
  });
});

describe('C4 — two plausible phone columns', () => {
  it('the mapped one wins; the other is data, not a second recipient', async () => {
    const csv = 'phone,alt_phone,name\n9876543210,9123456780,Asha\n';
    const { summary, contacts } = await run(csv, { phoneColumn: 'phone' });
    expect(summary.accepted).toBe(1);
    expect(contacts[0]!.phone_e164).toBe('+919876543210');
    expect(contacts[0]!.context['alt_phone']).toBe('9123456780');
  });
});

// ─── C5/C6 — column count ───────────────────────────────────────────────────

describe('C5 — 43 columns', () => {
  it('accepts 40+ columns and lands 42 keys in context', async () => {
    const headers = Array.from({ length: 43 }, (_, i) => (i === 0 ? 'Mobile' : `col_${i}`));
    const values = Array.from({ length: 43 }, (_, i) => (i === 0 ? '9876543210' : `v${i}`));
    const csv = `${headers.join(',')}\n${values.join(',')}\n`;

    const { summary, contacts } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.accepted).toBe(1);
    // 43 columns minus the phone column.
    expect(Object.keys(contacts[0]!.context)).toHaveLength(42);
  });
});

describe('C6 — above the column cap', () => {
  it('rejects deterministically with a structured error, not a crash', async () => {
    const count = AGENCY_MAX_COLUMNS + 20;
    const headers = Array.from({ length: count }, (_, i) => (i === 0 ? 'Mobile' : `col_${i}`));
    const csv = `${headers.join(',')}\n`;

    await expect(run(csv, { phoneColumn: 'Mobile' })).rejects.toMatchObject({
      name: 'AgencyIngestError',
      code: 'too_many_columns',
    });
  });

  it('publishes the cap as a constant so the limit shown to the admin is the real one', () => {
    // The number in the UI must come from metadata, not a copy.
    expect(AGENCY_MAX_COLUMNS).toBe(100);
    expect(AGENCY_MAX_COLUMNS).toBeGreaterThan(43); // C5 must fit
  });
});

// ─── C7 — empty values ──────────────────────────────────────────────────────

describe('C7 — empty and placeholder values', () => {
  it('preserves empty strings as empty strings, not missing keys', async () => {
    // The agent must see a blank field, not an absent one — a missing key reads
    // as "we never asked", a blank reads as "we asked and it was empty".
    const csv = 'Mobile,Name,Notes,Flag\n9876543210,Asha,,   \n';
    const { contacts } = await run(csv, { phoneColumn: 'Mobile' });
    expect(contacts[0]!.context).toEqual({ Name: 'Asha', Notes: '', Flag: '' });
    expect(Object.keys(contacts[0]!.context)).toContain('Notes');
  });

  it('rejects a row with an empty phone rather than blanking it', async () => {
    const csv = 'Mobile,Name\n,Asha\n';
    const { summary, rejections } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.accepted).toBe(0);
    expect(summary.rejected).toBe(1);
    expect(rejections[0]!.reason_code).toBe('missing_phone_value');
    expect(rejections[0]!.column).toBe('Mobile');
  });

  it('treats literal NULL and - as ordinary text, not as empty', async () => {
    // Deliberate: guessing that "NULL" means empty is how you lose a customer
    // whose surname is genuinely recorded that way by an upstream system.
    const csv = 'Mobile,Name,Ref\n9876543210,NULL,-\n';
    const { contacts } = await run(csv, { phoneColumn: 'Mobile' });
    expect(contacts[0]!.context).toEqual({ Name: 'NULL', Ref: '-' });
  });
});

// ─── C8 — oversized cell (assert which) ──────────────────────────────────────

describe('C8 — an oversized cell', () => {
  it('REJECTS the row with `value_too_large` and does not blow the buffer', async () => {
    // The decision: reject. A `context` value rides the station socket on every
    // reservation and renders on the agent screen, so an unbounded cell is both
    // a memory and a UI problem. Rejecting one row is recoverable; shipping a
    // 256KB cell into every reservation frame is not.
    const huge = 'x'.repeat(256 * 1024);
    const csv = `Mobile,Notes\n9876543210,"${huge}"\n`;

    const { summary, rejections } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.accepted).toBe(0);
    expect(rejections[0]!.reason_code).toBe('value_too_large');
    expect(rejections[0]!.column).toBe('Notes');
    // The oversized value is NOT echoed back in the rejection — that would put
    // the 256KB straight into the error response we were avoiding.
    expect(rejections[0]!.context).toEqual({});
  });

  it('accepts a large-but-reasonable cell', async () => {
    const big = 'x'.repeat(4 * 1024);
    const csv = `Mobile,Notes\n9876543210,"${big}"\n`;
    const { summary } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.accepted).toBe(1);
  });
});

// ─── C9 — duplicates ────────────────────────────────────────────────────────

describe('C9 — duplicates across E.164, local and spaced forms', () => {
  it('collapses to one contact with {accepted:1, duplicates:2}', async () => {
    const csv = [
      'Mobile,Name',
      '+919876543210,A',
      '9876543210,B',
      '+91 98765 43210,C',
    ].join('\n');

    const { summary, contacts, rejections } = await run(csv, { phoneColumn: 'Mobile' });

    expect(summary.accepted).toBe(1);
    expect(summary.duplicates).toBe(2);
    expect(contacts).toHaveLength(1);
    // The FIRST occurrence wins, so the retained context is A's.
    expect(contacts[0]!.context['Name']).toBe('A');
    expect(rejections.every((r) => r.reason_code === 'duplicate_phone')).toBe(true);
  });

  it('can be switched off, keeping both people behind a shared number', async () => {
    // Two people on one household/switchboard number is legitimate and common
    // in this market. With dedupe on, the second is dropped and it looks like
    // dedupe working correctly — which is why it is an option, and why the
    // idempotency constraint is on source_row_number rather than phone_e164.
    const csv = 'Mobile,Name\n+919876543210,Asha\n+919876543210,Ravi\n';

    const on = await run(csv, { phoneColumn: 'Mobile' });
    expect(on.summary.accepted).toBe(1);
    expect(on.summary.duplicates).toBe(1);

    const off = await run(csv, { phoneColumn: 'Mobile', dedupePhones: false });
    expect(off.summary.accepted).toBe(2);
    expect(off.summary.duplicates).toBe(0);
    expect(off.contacts.map((c) => c.context['Name'])).toEqual(['Asha', 'Ravi']);
    // Distinct source rows, which is what makes them separately idempotent.
    expect(off.contacts.map((c) => c.source_row_number)).toEqual([2, 3]);
  });

  it('counts duplicates inside `rejected` so the four numbers reconcile', async () => {
    // Accepted + rejected + duplicates must visibly reconcile to
    // rows_read. Duplicates are a KIND of rejection, so rows_read == accepted +
    // rejected, and `duplicates` is the subset callers surface separately.
    const csv = 'Mobile\n+919876543210\n+919876543210\nnotaphone\n';
    const { summary } = await run(csv, { phoneColumn: 'Mobile' });

    expect(summary.rows_read).toBe(3);
    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toBe(2);
    expect(summary.duplicates).toBe(1);
    expect(summary.accepted + summary.rejected).toBe(summary.rows_read);
  });
});

// ─── C10 — invalid numbers ──────────────────────────────────────────────────

describe('C10 — invalid numbers', () => {
  it('rejects each with a row number and reason, and never silently blanks', async () => {
    const csv = [
      'Mobile,Name',
      'abc,A',
      '+1,B',
      '12345,C',
      '+9199999999999999999,D',
      ',E',
    ].join('\n');

    const { summary, contacts, rejections } = await run(csv, { phoneColumn: 'Mobile' });

    expect(summary.accepted).toBe(0);
    expect(contacts).toHaveLength(0);
    expect(summary.rejected).toBe(5);

    // Row numbers are file lines: header is line 1, so data starts at 2.
    expect(rejections.map((r) => r.row_number)).toEqual([2, 3, 4, 5, 6]);
    expect(rejections.map((r) => r.reason_code)).toEqual([
      'invalid_phone',
      'invalid_phone',
      'invalid_phone',
      'invalid_phone',
      'missing_phone_value',
    ]);
    // The raw value is preserved for the summary's "e.g. row 88: ..." line.
    expect(rejections[0]!.raw_value).toBe('abc');
  });
});

// ─── C11 — mixed E.164 and local, with a per-campaign country code ──────────

describe('C11 — mixed E.164 and local formats', () => {
  const csv = [
    'Mobile,Name',
    '+14155550123,US',
    '9876543210,Local',
    '09876543210,LocalTrunk',
    '+91 98765 43210,Spaced',
  ].join('\n');

  it('preserves E.164 as-is and applies the campaign country code to local forms', async () => {
    const { summary, contacts } = await run(csv, {
      phoneColumn: 'Mobile',
      defaultCountryCode: '91',
    });
    // Local, trunk-prefixed and spaced forms all collapse to one number, so
    // three input rows yield one contact plus two duplicates.
    expect(contacts.map((c) => c.phone_e164)).toEqual(['+14155550123', '+919876543210']);
    expect(summary.duplicates).toBe(2);
  });

  it('honours a DIFFERENT campaign country code', async () => {
    // With only a platform-wide default, a US campaign's
    // local numbers silently become +91 and get dialed. The country code is a
    // per-call option here, and the campaign supplies it.
    const { contacts } = await run('Mobile\n4155550123\n', {
      phoneColumn: 'Mobile',
      defaultCountryCode: '1',
    });
    expect(contacts[0]!.phone_e164).toBe('+14155550123');
  });

  it('does not read the country code from the environment', async () => {
    // Vary it through the option, never through process.env,
    // or the result is import-order dependent.
    const a = await run('Mobile\n4155550123\n', { phoneColumn: 'Mobile', defaultCountryCode: '1' });
    const b = await run('Mobile\n9876543210\n', { phoneColumn: 'Mobile', defaultCountryCode: '91' });
    expect(a.contacts[0]!.phone_e164).toBe('+14155550123');
    expect(b.contacts[0]!.phone_e164).toBe('+919876543210');
  });
});

// ─── C12/C13/C14/C15 — encoding and line endings ────────────────────────────

describe('C12 — UTF-8 BOM', () => {
  it('strips the BOM so the first header is usable as the phone column', async () => {
    // The existing parser fails this (it does not set `bom`), deliberately left
    // alone. This module must not inherit that bug.
    const csv = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Mobile,Name\n9876543210,Asha\n', 'utf8'),
    ]);
    const { summary, contacts } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.headers[0]).toBe('Mobile');
    expect(summary.accepted).toBe(1);
    expect(contacts[0]!.phone_e164).toBe('+919876543210');
  });
});

describe('C13 — UTF-16', () => {
  it('rejects with a clear encoding error rather than producing garbage headers', async () => {
    const utf16 = Buffer.from('﻿Mobile,Name\n9876543210,Asha\n', 'utf16le');
    await expect(run(utf16, { phoneColumn: 'Mobile' })).rejects.toMatchObject({
      name: 'AgencyIngestError',
      code: 'unsupported_encoding',
    });
  });

  it('also catches BOM-less UTF-16 via its interleaved NUL bytes', async () => {
    const utf16 = Buffer.from('Mobile,Name\n9876543210,Asha\n', 'utf16le');
    await expect(run(utf16, { phoneColumn: 'Mobile' })).rejects.toMatchObject({
      code: 'unsupported_encoding',
    });
  });
});

describe('C14 — non-UTF-8 bytes (latin1 accents)', () => {
  it('REJECTS when the corruption is in a header', async () => {
    // The decision: fatal in a header, tolerated in a cell. A mangled header is
    // an unmappable key and an unrenderable label; a mangled value is a slightly
    // wrong name on one screen. Failing a 1M-row file over the latter is worse
    // than showing it.
    const latin1 = Buffer.concat([
      Buffer.from('Mobile,Pr', 'utf8'),
      Buffer.from([0xe9]), // é in latin1 — invalid as UTF-8
      Buffer.from('nom\n9876543210,Asha\n', 'utf8'),
    ]);
    await expect(run(latin1, { phoneColumn: 'Mobile' })).rejects.toMatchObject({
      code: 'unsupported_encoding',
    });
  });

  it('ACCEPTS a value with invalid bytes, replacing them with U+FFFD EXACTLY', async () => {
    // "Tolerated" needs a DEFINED result, not just "does not fail". This value
    // lands in `agency_contacts.context` and is rendered as-is on the
    // agent's screen mid-call, so the exact output is contract: each invalid
    // byte becomes one U+FFFD replacement character, and nothing is dropped.
    // Pinned so a dependency bump cannot silently change it to a dropped byte
    // or a raw passthrough.
    const latin1 = Buffer.concat([
      Buffer.from('Mobile,Name\n9876543210,Ren', 'utf8'),
      Buffer.from([0xe9]), // é in latin1 — not valid UTF-8
      Buffer.from('e\n', 'utf8'),
    ]);
    const { summary, contacts } = await run(latin1, { phoneColumn: 'Mobile' });

    expect(summary.accepted).toBe(1);
    expect(contacts[0]!.context['Name']).toBe('Ren�e');
    expect(contacts[0]!.context['Name']).toHaveLength(5);
  });
});

describe('C15 — CRLF line endings', () => {
  it('leaves no trailing \\r on the last column of any row', async () => {
    const csv = 'Mobile,Name,City\r\n9876543210,Asha,Mumbai\r\n9123456780,Ravi,Pune\r\n';
    const { summary, contacts } = await run(csv, { phoneColumn: 'Mobile' });

    expect(summary.accepted).toBe(2);
    expect(summary.headers).toEqual(['Mobile', 'Name', 'City']);
    for (const contact of contacts) {
      for (const [key, value] of Object.entries(contact.context)) {
        expect(key).not.toContain('\r');
        expect(value).not.toContain('\r');
      }
      expect(contact.phone_e164).not.toContain('\r');
    }
    expect(contacts[0]!.context['City']).toBe('Mumbai');
  });
});

// ─── C16/C17 — quoting ──────────────────────────────────────────────────────

describe('C16 — quoted commas', () => {
  it('keeps a comma inside quotes in one field', async () => {
    const csv = 'Mobile,Address\n9876543210,"Mumbai, MH"\n';
    const { contacts } = await run(csv, { phoneColumn: 'Mobile' });
    expect(contacts[0]!.context['Address']).toBe('Mumbai, MH');
  });
});

describe('C17 — embedded newlines', () => {
  it('does not split the row and keeps the newline in context', async () => {
    const csv = 'Mobile,Notes\n9876543210,"line one\nline two"\n';
    const { summary, contacts } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.accepted).toBe(1);
    expect(contacts[0]!.context['Notes']).toBe('line one\nline two');
  });

  it('keeps source_row_number correct for rows AFTER the multiline one', async () => {
    // The bug this guards: counting emitted records instead of file lines
    // drifts by one line for every multiline row, so every row number after it
    // is wrong — and the operator reconciles these against their spreadsheet.
    const csv = [
      'Mobile,Notes', // line 1
      '9876543210,"a', // line 2  ─┐ one record spanning
      'b"', //            line 3  ─┘ lines 2-3
      '9123456780,plain', // line 4
      'notaphone,x', // line 5
    ].join('\n');

    const { contacts, rejections } = await run(csv, { phoneColumn: 'Mobile' });

    expect(contacts[0]!.source_row_number).toBe(2);
    // Would be 3 if we counted records rather than lines.
    expect(contacts[1]!.source_row_number).toBe(4);
    expect(rejections[0]!.row_number).toBe(5);
  });
});

// ─── C18 — ragged rows (assert which) ────────────────────────────────────────

describe('C18 — ragged rows', () => {
  it('PADS a short row and accepts it', async () => {
    // Short means a trailing column was omitted — benign, and the missing
    // values are genuinely empty.
    const csv = 'Mobile,Name,City\n9876543210,Asha\n';
    const { summary, contacts } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.accepted).toBe(1);
    expect(contacts[0]!.context).toEqual({ Name: 'Asha', City: '' });
  });

  it('REJECTS a long row as `ragged_row`', async () => {
    // Long almost always means an unquoted comma, which shifts every column
    // after it — so the cell read as the phone number may be another column's
    // data. Accepting it risks dialing a number parsed out of the wrong field.
    const csv = 'Mobile,Name\n9876543210,Asha,Mumbai,extra\n';
    const { summary, rejections } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.accepted).toBe(0);
    expect(rejections[0]!.reason_code).toBe('ragged_row');
    expect(rejections[0]!.reason).toContain('unquoted comma');
  });

  it('keeps source_row_number right across a ragged row', async () => {
    const csv = 'Mobile,Name\n9876543210,Asha,extra\n9123456780,Ravi\n';
    const { contacts, rejections } = await run(csv, { phoneColumn: 'Mobile' });
    expect(rejections[0]!.row_number).toBe(2);
    expect(contacts[0]!.source_row_number).toBe(3);
  });
});

// ─── C19 — degenerate files are results, not throws ─────────────────────────

describe('C19 — empty, header-only and blank-line files', () => {
  it('returns a structured empty result for a completely empty file', async () => {
    const { summary } = await run('', { phoneColumn: 'Mobile' });
    expect(summary.rows_read).toBe(0);
    expect(summary.accepted).toBe(0);
    expect(summary.headers).toEqual([]);
  });

  it('returns a structured empty result for a header-only file', async () => {
    const { summary } = await run('Mobile,Name\n', { phoneColumn: 'Mobile' });
    expect(summary.rows_read).toBe(0);
    expect(summary.accepted).toBe(0);
    expect(summary.headers).toEqual(['Mobile', 'Name']);
    expect(summary.context_columns).toEqual(['Name']);
  });

  it('skips blank lines without counting them as rows', async () => {
    const csv = 'Mobile,Name\n\n9876543210,Asha\n\n\n';
    const { summary } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.rows_read).toBe(1);
    expect(summary.accepted).toBe(1);
  });
});

// ─── Duplicate headers ─────────────────────────────────

describe('duplicate CSV headers', () => {
  it('suffixes repeats (2), (3) with the first occurrence unchanged', () => {
    expect(dedupeHeaders(['Notes', 'Name', 'Notes', 'Notes'])).toEqual([
      'Notes',
      'Name',
      'Notes (2)',
      'Notes (3)',
    ]);
  });

  it('keeps both columns in context instead of silently collapsing them', async () => {
    // A JSONB object would keep only the last `Notes` — data loss the agent can
    // never detect, on a screen whose whole job is showing what we know.
    const csv = 'Mobile,Notes,Notes\n9876543210,first,second\n';
    const { summary, contacts } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.headers).toEqual(['Mobile', 'Notes', 'Notes (2)']);
    expect(contacts[0]!.context).toEqual({ Notes: 'first', 'Notes (2)': 'second' });
  });
});

// ─── Ignored columns ────────────────────────────────────────────

describe('ignored columns', () => {
  it('excludes them from context ENTIRELY, not just from the render', async () => {
    // This is a PII/security boundary: a field in `context` is a field on an
    // agent's screen the moment anyone changes the render rules.
    const csv = 'Mobile,Name,RiskScore,SSN\n9876543210,Asha,880,AAAA-1111\n';
    const { summary, contacts } = await run(csv, {
      phoneColumn: 'Mobile',
      ignoreColumns: ['RiskScore', 'SSN'],
    });

    expect(contacts[0]!.context).toEqual({ Name: 'Asha' });
    expect(contacts[0]!.context).not.toHaveProperty('RiskScore');
    expect(contacts[0]!.context).not.toHaveProperty('SSN');
    expect(summary.context_columns).toEqual(['Name']);
  });

  it('keeps ignored columns out of rejection context too', async () => {
    // Otherwise the rejected-rows export becomes the PII leak the ignore was for.
    const csv = 'Mobile,Name,SSN\nnotaphone,Asha,AAAA-1111\n';
    const { rejections } = await run(csv, { phoneColumn: 'Mobile', ignoreColumns: ['SSN'] });
    expect(rejections[0]!.context).toEqual({ Name: 'Asha' });
  });
});

// ─── Timezone mapping ─────────────────────────────────────────────────

describe('timezone column', () => {
  it('carries a mapped timezone through and leaves it undefined when blank', async () => {
    const csv = 'Mobile,TZ\n9876543210,Asia/Kolkata\n9123456780,\n';
    const { contacts } = await run(csv, { phoneColumn: 'Mobile', timezoneColumn: 'TZ' });
    expect(contacts[0]!.timezone).toBe('Asia/Kolkata');
    // Blank ⇒ absent ⇒ campaign default applies. Never inferred from the number.
    expect(contacts[1]!.timezone).toBeUndefined();
  });

  it('leaves timezone undefined on every contact when no column is mapped', async () => {
    const csv = 'Mobile,TZ\n9876543210,Asia/Kolkata\n';
    const { contacts } = await run(csv, { phoneColumn: 'Mobile' });
    expect(contacts[0]!.timezone).toBeUndefined();
    // …and the column is still ordinary context data.
    expect(contacts[0]!.context['TZ']).toBe('Asia/Kolkata');
  });

  it('fails the file when the mapped timezone column is absent', async () => {
    await expect(
      run('Mobile\n9876543210\n', { phoneColumn: 'Mobile', timezoneColumn: 'TZ' }),
    ).rejects.toMatchObject({ code: 'timezone_column_missing' });
  });
});

// ─── Summary shape and error capping ───────────────────────────────────────

describe('summary', () => {
  it('groups rejections by reason for the summary UI', async () => {
    // Note the trailing comma on the empty-phone row: a wholly blank LINE is
    // skipped by the parser (see C19), so an empty phone has to be expressed as
    // a real row with an empty first cell.
    const csv = [
      'Mobile,Name',
      'abc,A',
      'def,B',
      ',C',
      '+919876543210,D',
      '+919876543210,E',
    ].join('\n');
    const { summary } = await run(csv, { phoneColumn: 'Mobile' });
    expect(summary.rejected_by_reason).toEqual({
      invalid_phone: 2,
      missing_phone_value: 1,
      duplicate_phone: 1,
    });
  });

  it('caps inline errors but streams every rejection to onRejected', async () => {
    const rows = Array.from({ length: 250 }, () => 'abc').join('\n');
    const { summary, rejections } = await run(`Mobile\n${rows}\n`, {
      phoneColumn: 'Mobile',
      maxErrors: 10,
    });

    expect(summary.rejected).toBe(250);
    expect(summary.errors).toHaveLength(10);
    expect(summary.errors_truncated).toBe(240);
    // The export path sees all of them — that is why it is a callback and not
    // an array on the summary.
    expect(rejections).toHaveLength(250);
  });

  it('fails the whole file above the row cap', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => `+91987654${String(3000 + i)}`).join('\n');
    await expect(run(`Mobile\n${rows}\n`, { phoneColumn: 'Mobile', maxRows: 10 })).rejects.toMatchObject({
      code: 'too_many_rows',
    });
  });
});

describe('rowLimit (powers preview and column sampling)', () => {
  it('stops early and flags the result as truncated', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    const { summary, contacts } = await run(`Mobile\n${rows}\n`, {
      phoneColumn: 'Mobile',
      rowLimit: 20,
    });
    expect(summary.rows_read).toBe(20);
    expect(contacts).toHaveLength(20);
    expect(summary.truncated).toBe(true);
  });

  it('is not truncated when the file is shorter than the limit', async () => {
    const { summary } = await run('Mobile\n+919876543210\n', { phoneColumn: 'Mobile', rowLimit: 20 });
    expect(summary.truncated).toBe(false);
  });
});

describe('batching', () => {
  it('delivers accepted contacts in batches of the configured size', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    const batches: number[] = [];
    await ingestAgencyCsv({
      source: streamOf(`Mobile\n${rows}\n`),
      phoneColumn: 'Mobile',
      batchSize: 10,
      onBatch: (b) => {
        batches.push(b.length);
      },
    });
    expect(batches).toEqual([10, 10, 5]);
  });

  it('reports progress alongside each batch for the determinate progress bar', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => `+9198765${String(40000 + i)}`).join('\n');
    let lastProgress = { rows_read: 0, bytes_read: 0 };
    await ingestAgencyCsv({
      source: streamOf(`Mobile\n${rows}\n`),
      phoneColumn: 'Mobile',
      batchSize: 5,
      onBatch: (_b, progress) => {
        lastProgress = progress;
      },
    });
    expect(lastProgress.rows_read).toBe(10);
    expect(lastProgress.bytes_read).toBeGreaterThan(0);
  });

  describe('an error from the CALLER is not a malformed file', () => {
    class CallerHalt extends Error {
      constructor() {
        super('the caller stopped this');
        this.name = 'CallerHalt';
      }
    }

    it('rethrows an onBatch error unchanged, so instanceof survives the boundary', async () => {
      /**
       * The final `catch` re-labels anything that is not an `AgencyIngestError` as
       * `malformed_csv`. That is right for parser and stream failures and wrong for
       * `onBatch`/`onRejected`, which are the caller's code travelling the same
       * path — the file is fine.
       *
       * Two live consequences before the fix, and the second is the instructive
       * one: the fail-closed DNC halt arrived at its caller as "Could
       * not read the CSV", and `agency-ingest.service.ts`'s
       * `err instanceof IngestCancelled` arm had **never** been reachable —
       * cancellation worked only via a separate boolean flag. Two mechanisms, one
       * decorative, and the decorative one is what a reader trusts.
       */
      const thrown = new CallerHalt();

      await expect(
        ingestAgencyCsv({
          source: streamOf('Mobile\n+919876543210\n'),
          phoneColumn: 'Mobile',
          onBatch: () => {
            throw thrown;
          },
        }),
      ).rejects.toBe(thrown);
    });

    it('rethrows an onRejected error unchanged too', async () => {
      const thrown = new CallerHalt();

      await expect(
        ingestAgencyCsv({
          source: streamOf('Mobile\nnotaphone\n'),
          phoneColumn: 'Mobile',
          onRejected: () => {
            throw thrown;
          },
        }),
      ).rejects.toBe(thrown);
    });

    it('still classifies a genuinely unreadable stream as malformed_csv', async () => {
      // The other half of the property: narrowing the catch must not stop it
      // catching what it was written for.
      const exploding = new Readable({
        read() {
          this.destroy(new Error('socket hang up'));
        },
      });

      await expect(
        ingestAgencyCsv({ source: exploding, phoneColumn: 'Mobile' }),
      ).rejects.toBeInstanceOf(AgencyIngestError);
    });

    it('does not swallow a non-object throw from a callback', async () => {
      // A thrown string cannot carry the marker property. It must still propagate
      // as something rather than being reported as a bad file — but this is the
      // one case where the marker cannot help, so the honest outcome is the
      // classified error, and the test says so rather than pretending otherwise.
      await expect(
        ingestAgencyCsv({
          source: streamOf('Mobile\n+919876543210\n'),
          phoneColumn: 'Mobile',
          onBatch: () => {
            throw 'a bare string';
          },
        }),
      ).rejects.toBeInstanceOf(AgencyIngestError);
    });
  });
});
