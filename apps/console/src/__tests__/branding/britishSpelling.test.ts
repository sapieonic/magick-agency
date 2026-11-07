import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

function shipped(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') shipped(path, out);
    } else if (['.ts', '.tsx'].includes(extname(name)) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const JSX_TEXT = />([^<>{}]*[A-Za-z][^<>{}]*)</g;

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
  const files = shipped(srcRoot);

  it('scans the shipped sources', () => {
    expect(files.length).toBeGreaterThan(100);
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
