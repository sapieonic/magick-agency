import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shippedFiles, stripComments } from './sourceScan';

/**
 * User-facing copy is British English (root CLAUDE.md): dialled, dialling, dialler,
 * cancelled, recognise, organisation, utilisation. A source scan over the text the app
 * shows: string literals that read as prose (they contain a space, or start with a
 * capital) and JSX text, with comments stripped and `${…}` expressions removed. Wire
 * codes and identifiers are single lower-case tokens and are never matched
 * (`'dialing'`, `canceled`, `/dialer`). "Agency Dialer" is the product's name (B17)
 * and stays as it is.
 */

const srcRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const AMERICAN = /\b(dialing|dialed|dialer|dialers|redialing|redialed|canceled|canceling|utilization|recognize|recognized|organization|organizations|behavior)\b/i;
const PRODUCT = /agency dialer/gi;
const SCANNED_EXT = new Set(['.ts', '.tsx']);

const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const JSX_TEXT = />([^<>{}]*[A-Za-z][^<>{}]*)</g;

/** The copy in `code` (comments already stripped): prose-like string literals, and JSX text. */
function prose(code: string, tsx: boolean): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(LITERAL)) {
    const body = m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, ' ');
    if (body.startsWith('/')) continue; // a route or URL path, not copy
    if (/\s/.test(body.trim()) || /^[A-Z]/.test(body)) out.push(body);
  }
  if (tsx) for (const m of code.matchAll(JSX_TEXT)) out.push(m[1]!);
  return out;
}

describe('user-facing copy is British English', () => {
  const files = shippedFiles(srcRoot, SCANNED_EXT);

  it('scans the shipped sources', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('sees a string that holds `//`, and not a comment', () => {
    const americanIn = (source: string) => prose(stripComments(source), true).some((t) => AMERICAN.test(t));
    expect(americanIn("const s = 'Skipped // the dialer will retry';")).toBe(true);
    expect(americanIn("const s = 'See https://example.com, then the dialer retries';")).toBe(true);
    expect(americanIn('const s = 1; // the dialer retries')).toBe(false);
    expect(americanIn('/* the dialer retries */ const s = 1;')).toBe(false);
  });

  it('no American spelling in a string or JSX text', () => {
    const offenders: string[] = [];
    for (const path of files) {
      const code = stripComments(readFileSync(path, 'utf8'));
      for (const text of prose(code, path.endsWith('.tsx'))) {
        const m = text.replace(PRODUCT, '').match(AMERICAN);
        if (m) offenders.push(`${relative(srcRoot, path)}: "${m[0]}" in ${JSON.stringify(text.trim().slice(0, 80))}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
