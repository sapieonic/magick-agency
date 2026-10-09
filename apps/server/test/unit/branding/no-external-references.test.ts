import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Magick Agency is a self-contained application: no file in the repository — code,
 * comments, tests, docs or config — names another system or points at a document
 * outside the repository. This scans every text file in the tree (comments included)
 * for the names and references that would break that.
 */

const FORBIDDEN: Array<[label: string, pattern: RegExp]> = [
  ['another repository name', /magic-voice-core|magick-master|magick-comms-cusui|\bcusui\b/i],
  ['the previous product name', /magick[\s_-]?voice|magic[\s_-]?voice/i],
  ['a pinned source commit', /\b(4850d1d9|a1f0756a|ee5beb44)\b/],
  ['a porting ledger reference', /PORTING\.md|PORT NOTE|\bported from\b/i],
  ['an external design doc', /docs\/reference\/|docs\/history\/|\bservice-map\.md\b|(?<![\w/-])agency\.md\b/],
  ['an external planning document', /\bretry design\b|\btest[\s-]plan\b|\bUX spec\b|\bextraction plan\b/i],
  ['an external ticket id', /\bMAG-\d+\b/],
  ['an external plan item id', /\bAD-P\d/],
  ['an external design rule id', /\bDR-\d+\b/],
  ['a ClickUp task id', /\b86d[0-9a-z]{6,}\b/],
  ['another repository\'s migration number', /\bmigrations? 0?(0[2-9]\d|[1-9]\d\d)\b|\b0\d\d['’]s\b|\bpre-0\d\d\b/i],
  ['a file in another repository', /\b(core|master):(src|test)\//],
  ['a cross-service contract', /\bS2S\b|agency-s2s-contract|\b[Cc]ross-repo\b/],
  ['a multi-service framing', /\b(both|two) services\b|\beither service\b/i],
  ['the previous product split', /\bAI product\b|\bprimary (AI )?app(lication)?\b|\b(both|two) products\b/i],
];

/** For each pattern, text it must catch and look-alikes it must leave alone. */
const SELF_TEST: Record<string, { hits: string[]; misses: string[] }> = {
  'another repository name': {
    hits: ['see magick-master src', 'magic-voice-core/src', 'the cusui shell', 'magick-comms-cusui'],
    misses: ['magick-agency', 'the console'],
  },
  'the previous product name': {
    hits: ['MagickVoice', 'Magick Voice', 'magic_voice', 'magic-voice'],
    misses: ['Magick Agency', 'voice engine'],
  },
  'a pinned source commit': { hits: ['core@4850d1d9', 'a1f0756a', 'ee5beb44'], misses: ['4850d1d90abc'] },
  'a porting ledger reference': {
    hits: ['PORTING.md row', 'PORT NOTE (x)', 'ported from the old route', 'Ported from x'],
    misses: ['imported from ./x', 'exported from the barrel', 'reported from the worker', 'supported from v2'],
  },
  'an external design doc': {
    hits: ['docs/reference/x.md', 'docs/history/y.md', 'see service-map.md', 'see agency.md §6'],
    misses: ['docs/architecture.md', 'magick-agency.md', 'docs/agency.md'],
  },
  'an external planning document': {
    hits: ['the retry design says', 'per the test plan', 'test-plan row 4', 'the UX spec', 'the extraction plan'],
    misses: ['retry designer', 'test planner', 'a test planned for later'],
  },
  'an external ticket id': { hits: ['MAG-138', '(MAG-7)'], misses: ['IMAG-138', 'MAG-x'] },
  'an external plan item id': { hits: ['AD-P4-M-02', 'AD-P1'], misses: ['LOAD-P4', 'AD-PX'] },
  'an external design rule id': { hits: ['DR-3', '(DR-12)'], misses: ['ADDR-3', 'DR-x', 'DRY-3'] },
  'a ClickUp task id': { hits: ['86d2hme6q', 'ClickUp 86d0abcdef'], misses: ['0x86d2hme6q', '86d12', 'a86d2hme6q'] },
  "another repository's migration number": {
    hits: ['since migration 083', 'Migration 105 added', 'migrations 064 and 060', "072's DEFAULT", '074’s index', 'pre-083 rows', 'Pre-064'],
    misses: ['migration 0001', '0001_baseline.sql', "0001's header", 'migrations run at boot', 'port 5436', 'HTTP 404', 'a 503', 'pre-dial', 'migration 1'],
  },
  'a file in another repository': {
    hits: ['// core:test/integration/agency/x.test.ts', 'master:src/db/x.ts'],
    misses: ["id: 'core:c1'", '`master:${row.id}`', 'apps/server/test/x.ts'],
  },
  'a cross-service contract': {
    hits: ['the S2S fixture', 'agency-s2s-contract.fixture.json', 'a cross-repo check', 'Cross-repo'],
    misses: ['s2s', 'S2Sx', 'across the repo', 'cross-reference'],
  },
  'a multi-service framing': {
    hits: ['both services accept', 'on either service', 'Two services stamping'],
    misses: ['both service hooks', 'the services directory', 'two servicers'],
  },
  'the previous product split': {
    hits: ['the AI product', 'the primary app', 'the primary application', 'primary AI application', 'both products', 'two products'],
    misses: ['the AI provider', 'primary key', 'products table', 'primary applicant'],
  },
};

const repoRoot = dirname(dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.vite', '.turbo']);
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.sql', '.css', '.html', '.yml', '.yaml', '.sh', '.example', '.txt', '',
]);
/** Files that must spell the patterns out to enforce them. */
const ALLOWED = new Set([
  join('apps', 'server', 'test', 'unit', 'branding', 'no-external-references.test.ts'),
  join('apps', 'server', 'test', 'unit', 'branding', 'no-parent-brand.test.ts'),
  join('apps', 'console', 'src', '__tests__', 'branding', 'noParentBrand.test.ts'),
  join('apps', 'super-admin', 'src', '__tests__', 'branding', 'noParentBrand.test.ts'),
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (TEXT_EXT.has(extname(entry.name)) && !entry.name.startsWith('.env') && entry.name !== '.test-env.local.json') {
      out.push(join(dir, entry.name));
    } else if (entry.name === '.env.example') {
      out.push(join(dir, entry.name));
    }
  }
}

describe('the repository is self-contained', () => {
  const files: string[] = [];
  walk(repoRoot, files);

  it('scans the whole tree, not an empty directory', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith(`${sep}docs${sep}architecture.md`))).toBe(true);
    expect(files.some((f) => f.endsWith(`${sep}src${sep}index.ts`))).toBe(true);
  });

  it.each(FORBIDDEN)('no file contains %s', (_label, pattern) => {
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(repoRoot, file);
      if (ALLOWED.has(rel)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('has a self-test for every pattern', () => {
    expect(Object.keys(SELF_TEST).sort()).toEqual(FORBIDDEN.map(([label]) => label).sort());
  });

  it.each(FORBIDDEN)('the pattern for %s catches what it should and nothing else (self-test)', (label, pattern) => {
    const { hits, misses } = SELF_TEST[label]!;
    for (const s of hits) expect(pattern.test(s), s).toBe(true);
    for (const s of misses) expect(pattern.test(s), s).toBe(false);
  });
});
