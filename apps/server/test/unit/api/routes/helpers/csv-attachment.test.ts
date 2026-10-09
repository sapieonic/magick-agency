import { describe, it, expect } from 'vitest';
import { csvAttachmentHeader, asciiFallbackName } from '../../../../../src/api/routes/helpers/csv-attachment.js';

/**
 * The export routes interpolated a caller-supplied campaign name straight into
 * `Content-Disposition`. `bulk_dispatch_jobs.name` is a passthrough string with
 * no character restriction, so that had two failure modes: a quote closed the
 * value early, and a CR/LF made Node throw `ERR_INVALID_CHAR` -- a 500 that the
 * error mask then replaced with "contact support", leaving the export broken
 * for the life of the campaign with nothing naming the cause.
 */
describe('csvAttachmentHeader', () => {
  it('appends the extension itself so no call site can forget or double it', () => {
    expect(csvAttachmentHeader('March campaign')).toContain('filename="March campaign.csv"');
  });

  it('strips the quote that would close the header value early', () => {
    const header = csvAttachmentHeader('Q3 "priority" list');
    expect(header).toContain('filename="Q3 priority list.csv"');
    // One opening and one closing quote around the ASCII form, and no more.
    expect(header.match(/"/g)).toHaveLength(2);
  });

  it('removes CR and LF, which Node rejects outright', () => {
    const header = csvAttachmentHeader('Injected\r\nX-Evil: 1');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('filename="InjectedX-Evil: 1.csv"');
  });

  it('carries the real name in filename* so a non-ASCII campaign keeps its name', () => {
    const header = csvAttachmentHeader('अभियान');
    // The ASCII fallback cannot represent it and must not become ".csv".
    expect(header).toContain('filename="export.csv"');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('अभियान.csv')}`);
  });

  it("percent-encodes the apostrophe, which is a delimiter in the ext-value grammar", () => {
    const header = csvAttachmentHeader("Bob's list");
    const ext = header.split("filename*=UTF-8''")[1]!;
    expect(ext).not.toContain("'");
    expect(ext).toContain('%27');
  });

  it('bounds the length so a pasted essay cannot become a filename', () => {
    const header = csvAttachmentHeader('x'.repeat(500));
    const ascii = header.match(/filename="([^"]*)"/)![1]!;
    expect(ascii.length).toBeLessThanOrEqual(124); // 120 + '.csv'
  });

  it('does not split a surrogate pair at the length bound', () => {
    // `slice` counts UTF-16 code units, so a cut landing inside a surrogate
    // pair leaves a lone surrogate and `encodeURIComponent` throws
    // `URIError: URI malformed`. That throw escapes the export handler as a
    // 500 and errorMaskHook rewrites it into "contact support" -- the exact
    // failure this module exists to remove, one step along. 119 ASCII
    // characters plus one emoji is the shortest name that reaches it.
    const name = `${'x'.repeat(119)}\u{1F600}`;
    expect(() => csvAttachmentHeader(name)).not.toThrow();

    const header = csvAttachmentHeader(name);
    const ext = header.split("filename*=UTF-8''")[1]!;
    // Round-trips: no lone surrogate survived into the percent-encoding.
    expect(() => decodeURIComponent(ext)).not.toThrow();
    // 119 + 1 emoji is exactly the 120-code-point budget, so the name is kept
    // whole -- where a code-UNIT cut would have severed the emoji at 120.
    expect(decodeURIComponent(ext)).toBe(`${'x'.repeat(119)}\u{1F600}.csv`);
  });

  it('counts the budget in characters a person would recognise', () => {
    // 200 emoji is 400 UTF-16 code units. Cutting by code unit would keep 60
    // emoji (and risk splitting the 60th); cutting by code point keeps 120.
    const header = csvAttachmentHeader('\u{1F600}'.repeat(200));
    const decoded = decodeURIComponent(header.split("filename*=UTF-8''")[1]!);
    expect([...decoded]).toHaveLength(124); // 120 emoji + '.csv'
  });

  it('survives every cut position around a surrogate pair', () => {
    // The failure is one code unit wide, so a single fixture proves little.
    for (let pad = 110; pad <= 130; pad += 1) {
      const name = `${'x'.repeat(pad)}\u{1F600}${'y'.repeat(5)}`;
      expect(() => csvAttachmentHeader(name)).not.toThrow();
    }
  });
});

describe('asciiFallbackName', () => {
  it('never returns an empty string, which would render as a bare .csv', () => {
    expect(asciiFallbackName('')).toBe('export');
    expect(asciiFallbackName('   ')).toBe('export');
    expect(asciiFallbackName('日本語')).toBe('export');
    expect(asciiFallbackName('"\\')).toBe('export');
  });

  it('leaves an ordinary name alone', () => {
    expect(asciiFallbackName('March campaign (retry 1)')).toBe('March campaign (retry 1)');
  });
});
