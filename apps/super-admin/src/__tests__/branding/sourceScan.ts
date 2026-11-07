import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * The source scanner the branding guards share (`noParentBrand.test.ts`,
 * `britishSpelling.test.ts`, `carrierNames.test.ts`): which files ship, and their code
 * with comments out. Test helpers stay within one app, so this is the console's
 * `src/__tests__/branding/sourceScan.ts` copied.
 */

type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';

/**
 * Remove `//` and slash-star comments (and HTML comments), keep string literals
 * and line numbers. Same state machine as `agencyShellBoundary.test.ts`; CSS has
 * no `//` comment, but a `//` outside a string in CSS is never product text.
 * A `//` inside a string is the string's, never a comment.
 */
export function stripComments(source: string): string {
  const noHtml = source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
  let out = '';
  let mode: Mode = 'code';
  let i = 0;
  while (i < noHtml.length) {
    const ch = noHtml[i]!;
    const pair = noHtml.slice(i, i + 2);
    if (mode === 'code') {
      // `://` is a URL scheme, not a comment — unquoted URLs live in JSX prose,
      // CSS `url(...)` and unquoted attributes, and must stay visible.
      if (pair === '//' && (i === 0 || noHtml[i - 1] !== ':')) { mode = 'line'; i += 2; continue; }
      if (pair === '/*') { mode = 'block'; i += 2; continue; }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'template';
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (pair === '*/') { mode = 'code'; i += 2; continue; }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    if (ch === '\\') { out += noHtml.slice(i, i + 2); i += 2; continue; }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    // A newline ends a quote that JSX prose opened ("don't"), so one apostrophe
    // cannot swallow the rest of the file; template literals may span lines.
    if (ch === closer || (ch === '\n' && mode !== 'template')) mode = 'code';
    out += ch;
    i += 1;
  }
  return out;
}

/** Every file under `dir` with one of `extensions`, skipping `__tests__` folders and test files. */
export function shippedFiles(dir: string, extensions: ReadonlySet<string>): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : shippedFiles(path, extensions);
    if (/\.test\.tsx?$/.test(entry)) return [];
    return extensions.has(extname(entry)) ? [path] : [];
  });
}
