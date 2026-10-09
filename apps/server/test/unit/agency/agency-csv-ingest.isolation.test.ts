import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../../../src');

/**
 * T-CSV-R5 — the isolation between the new agency ingest and the existing
 * contact-list parser is the entire risk mitigation for this change, so it is a
 * test rather than a convention.
 *
 * The design's rule is "new module beside the old one, the old one does not
 * change". If the new module ever needs something from the old one, it copies
 * it — an import edge is how the old parser starts absorbing agency
 * requirements, and the old parser is what bulk dispatch runs on.
 *
 * Asserted on source text rather than by inspecting the module graph, following
 * the precedent set for other structural invariants in this repo: a runtime
 * check would pass on a lazily-imported edge that a reviewer would still call a
 * violation.
 */

function read(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf8');
}

/** Strip comments so a mention of the other module in prose is not a false positive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function importedPaths(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

describe('agency ingest ↔ contact-list parser isolation', () => {
  it('agency-csv-ingest.ts does not import csv-parser.ts', () => {
    const imports = importedPaths(read('agency/agency-csv-ingest.ts'));
    expect(imports.some((p) => p.includes('csv-parser'))).toBe(false);
    expect(imports.some((p) => p.includes('contact-lists/'))).toBe(false);
  });

  it('csv-parser.ts does not import anything from the agency module', () => {
    const imports = importedPaths(read('contact-lists/csv-parser.ts'));
    expect(imports.some((p) => p.includes('agency'))).toBe(false);
  });

  it('no file under contact-lists/ imports the agency ingest', () => {
    // The reverse edge is the more insidious one: it would make a change to the
    // agency module able to break bulk dispatch.
    const files = [
      'contact-lists/csv-parser.ts',
      'contact-lists/contact-list.service.ts',
      'contact-lists/chunked-dispatch.ts',
      'contact-lists/finalize-chunked-dispatch.ts',
      'contact-lists/contact-list.repository.ts',
      'contact-lists/contact-list-gate.ts',
      'contact-lists/template-generator.ts',
      'contact-lists/chunk-size.ts',
    ];
    // PORT NOTE: only csv-parser.ts exists in agency (bulk dispatch and the rest of
    // contact-lists/ are not ported), so the missing files are skipped, not read.
    for (const file of files.filter((f) => existsSync(resolve(SRC, f)))) {
      const imports = importedPaths(read(file));
      expect(
        imports.some((p) => p.includes('agency')),
        `${file} must not import the agency module`,
      ).toBe(false);
    }
  });

  it('the existing parser still carries the constants the agency path had to escape', () => {
    // A characterisation lock, not an endorsement. If someone "helpfully" raises
    // these in the shared parser, this fails and forces the conversation about
    // bulk dispatch rather than letting it happen silently.
    const source = read('contact-lists/csv-parser.ts');
    expect(source).toContain('const MAX_ROWS = 10_000');
    expect(source).toContain('const MAX_COLUMNS = 50');
    // Still no `bom` option — the BOM bug stays pinned here, and is fixed only
    // in the agency module.
    expect(source).not.toContain('bom:');
  });
});
