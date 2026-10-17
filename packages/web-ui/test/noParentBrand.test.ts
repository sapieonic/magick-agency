import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Magick Agency ships no link to, and no visible mention of, its parent product
 * (decision B17, Manas 2026-10-09: "this shouldn't have any linking present").
 *
 * The third twin of the apps' `src/__tests__/branding/noParentBrand.test.ts`.
 * Those scan only their own app's `src/`, and everything in this package ships
 * inside both apps' bundles, so it needs its own scan: a link or a name renders
 * perfectly, so only a source scan can tell it is wrong.
 *
 * What is scanned is everything that ships: every file under `src/` (code, CSS,
 * JSON) and `package.json`. Comments are stripped first — provenance notes are
 * documentation, not product, and a guard that fires on its own documentation
 * gets deleted. Tests are not scanned: their fixtures may name the parent
 * product's hosts.
 */

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcRoot = join(pkgRoot, 'src');

/** The parent product's name in any spacing or case, and its domains. */
const PARENT_BRAND = /magick[\s_-]?voice|magic[\s_-]?voice/i;

const SCANNED_EXT = new Set(['.ts', '.tsx', '.css', '.json', '.html']);

type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';

/**
 * Remove `//` and slash-star comments (and HTML comments), keep string literals
 * and line numbers. The same state machine as the apps' guards (copied: the
 * apps and this package share no test helpers).
 */
function stripComments(source: string): string {
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

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    if (/\.test\.tsx?$/.test(entry)) return [];
    return SCANNED_EXT.has(extname(entry)) ? [path] : [];
  });
}

function shippedFiles(): string[] {
  return [...walk(srcRoot), join(pkgRoot, 'package.json')];
}

/** `path:line` for every mention of the parent brand left after comments are stripped. */
function parentBrandMentions(): string[] {
  return shippedFiles().flatMap((path) => {
    const rel = relative(pkgRoot, path);
    return stripComments(readFileSync(path, 'utf8'))
      .split('\n')
      .flatMap((line, index) => (PARENT_BRAND.test(line) ? [`${rel}:${index + 1}: ${line.trim()}`] : []));
  });
}

describe('no parent-brand branding or links (B17)', () => {
  it('scans the shared components, contexts and global.css', () => {
    const rels = shippedFiles().map((p) => relative(pkgRoot, p));
    expect(rels).toContain('src/components/Modal.tsx');
    expect(rels).toContain('src/components/Toast.module.css');
    expect(rels).toContain('src/contexts/ToastContext.tsx');
    expect(rels).toContain('src/global.css');
  });

  it('names the parent brand nowhere in shipped source, outside comments', () => {
    expect(parentBrandMentions()).toEqual([]);
  });

  it('strips comments but still sees strings', () => {
    expect(PARENT_BRAND.test(stripComments('// ported from MagickVoice\nconst x = 1;'))).toBe(false);
    expect(PARENT_BRAND.test(stripComments('/** Magick Voice */\n{/* magick-voice */}<div />'))).toBe(false);
    expect(PARENT_BRAND.test(stripComments("const s = 'Back to MagickVoice';"))).toBe(true);
    expect(PARENT_BRAND.test(stripComments('<a href="https://docs.magickvoice.com">'))).toBe(true);
    expect(PARENT_BRAND.test(stripComments("<p>don't</p>\nconst u = 'magickvoice.com';"))).toBe(true);
  });

  it('sees unquoted URLs, where `//` follows a scheme rather than opening a comment', () => {
    expect(PARENT_BRAND.test(stripComments('.x { background: url(https://cdn.magickvoice.com/a.png) }'))).toBe(true);
    expect(PARENT_BRAND.test(stripComments('const x = 1; // see https://magickvoice.com'))).toBe(false);
  });
});
