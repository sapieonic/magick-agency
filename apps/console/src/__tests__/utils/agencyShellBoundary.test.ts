import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Nothing in the console links to the old `/app/<page>` URLs, and agency code does not name
 * `/app` at all.
 *
 * ── What this guards now ───────────────────────────────────────────────────
 * There were two shells: the agency workspace (`/agency`) and a "Team & settings" zone at
 * `/app`, and links that crossed between them stranded the reader outside the context they
 * were working in (the concrete leak was campaign attempt rows pointing at
 * `/app/calls/dialer/history/:id`). Decision B28 made one shell: the `/app` pages moved to the
 * Settings hub (`/settings/<page>`), and `/app/<page>` survives only as a redirect for old
 * bookmarks and emails (`LegacyAppRedirect`). So:
 *
 *  1. **No source file but `App.tsx` names an `/app/<page>` path.** A link to one is a link
 *     to a redirect, at best one extra hop and at worst (a path that was never a settings
 *     page) a bounce to the home decision. Settings pages are linked by their `/settings`
 *     URL.
 *  2. **Agency code names no `/app` at all**, not even the bare home: it links to the page it
 *     means, in the shell it is already in. (Bare `/app` is still the console's home
 *     decision, which the invite door, the session expiry and the catch-all use.)
 *
 * ── Why this is a source-scanning test and not a rendering one ─────────────
 * Every one of these links renders and navigates; the redirect hides the mistake. There is
 * no assertion to make at the DOM about a link that is wrong for a reason no renderer can
 * see, so assert the wiring in the source.
 *
 * ── Comments are stripped first, and that is load-bearing ─────────────────
 * Comment prose mentions `/app` to explain the history above. A test that fires on its own
 * documentation gets deleted by the third person who hits it, so `stripComments` removes
 * `//` line comments, slash-star block comments and the brace-wrapped JSX form of the same
 * before anything is matched. It is a small state machine rather than a regex because it
 * must also track string literals: a `//` inside `'https://…'` is not a comment. Newlines are
 * preserved so reported line numbers point at the real source.
 */

/** `…/src`, since this file is `src/__tests__/utils/`. */
const srcRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repoRoot = dirname(srcRoot);

/**
 * Every root that is agency code, relative to `src/`. `pages/campaigns/agency` is the agency
 * campaign builder, despite the path.
 */
const AGENCY_ROOTS = ['pages/agency', 'components/agency', 'pages/campaigns/agency'];

/** The route table, where the legacy `/app` routes are declared. Full path, not a basename. */
const ROUTE_TABLE = 'src/App.tsx';

/** `/app` as a route literal, not as a prefix of some longer word (`/apps`, `/appointments`). */
const APP_ROUTE_LITERAL = /\/app(?![\w-])/;

/** `/app/<segment>`: one of the old pages. */
const APP_PAGE_LITERAL = /\/app\/[\w:-]/;

type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';

/**
 * Remove comments, keep code, keep line numbering.
 *
 * String literals are tracked so a `//` or a `/*` inside one is left intact;
 * escapes are consumed in pairs so `'\\'` does not read as an unterminated
 * string. Regex literals and division are not modelled — a `//` cannot appear in
 * either, so the only cost is a hypothetical `/…/` regex that opens with `*`,
 * which no source here contains.
 */
function stripComments(source: string): string {
  let out = '';
  let mode: Mode = 'code';
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;
    const pair = source.slice(i, i + 2);

    if (mode === 'code') {
      if (pair === '//') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (pair === '/*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'template';
      out += ch;
      i += 1;
      continue;
    }

    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }

    if (mode === 'block') {
      if (pair === '*/') {
        mode = 'code';
        i += 2;
        continue;
      }
      // Kept so a stripped block comment does not shift the lines beneath it.
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }

    // Inside a string literal of some kind.
    if (ch === '\\') {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (ch === closer) mode = 'code';
    out += ch;
    i += 1;
  }

  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

function offenders(files: string[], pattern: RegExp, exempt: string[] = []): string[] {
  return files.flatMap((path) => {
    const rel = relative(repoRoot, path);
    if (exempt.includes(rel)) return [];
    return stripComments(readFileSync(path, 'utf8'))
      .split('\n')
      .flatMap((line, index) => (pattern.test(line) ? [`${rel}:${index + 1}`] : []));
  });
}

const nonTestSources = () => walk(srcRoot).filter((p) => !relative(srcRoot, p).startsWith('__tests__'));

describe('the legacy /app URLs', () => {
  it('are named by no source file but the route table', () => {
    expect(offenders(nonTestSources(), APP_PAGE_LITERAL, [ROUTE_TABLE])).toEqual([]);
  });

  it('are not named at all, not even the bare home, in agency code', () => {
    const agency = AGENCY_ROOTS.flatMap((root) => walk(join(srcRoot, root)));
    expect(agency.length).toBeGreaterThan(50);
    expect(offenders(agency, APP_ROUTE_LITERAL)).toEqual([]);
  });

  it('are still declared in the route table, so old links keep working', () => {
    const app = stripComments(readFileSync(join(repoRoot, ROUTE_TABLE), 'utf8'));
    expect(app).toContain('<Route path="/app">');
    expect(app).toContain('<Route path="*" element={<LegacyAppRedirect />} />');
  });

  it('ignores /app mentioned in comment prose', () => {
    const jsdoc = ['/**', ' * a plain `/app/team` would resolve it', ' */', 'const x = 1;'].join('\n');
    const jsx = ['{/* every route back (`/app`, `/`) returns here */}', '<div />'].join('\n');
    const line = '// every `/app/*` path an agent could reach';

    expect(APP_ROUTE_LITERAL.test(stripComments(jsdoc))).toBe(false);
    expect(APP_ROUTE_LITERAL.test(stripComments(jsx))).toBe(false);
    expect(APP_ROUTE_LITERAL.test(stripComments(line))).toBe(false);

    // And still sees code, including a `//` that is a URL rather than a comment.
    expect(APP_PAGE_LITERAL.test(stripComments('<Link to="/app/team" />'))).toBe(true);
    expect(APP_PAGE_LITERAL.test(stripComments('const u = "https://x"; to(`/app/inbound/${id}`);'))).toBe(true);
    expect(APP_PAGE_LITERAL.test(stripComments('navigate("/app")'))).toBe(false);
    // A longer word starting with `app` is not a route literal.
    expect(APP_ROUTE_LITERAL.test(stripComments('to("/appointments")'))).toBe(false);
  });
});
