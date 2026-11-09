import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The agency repository is a barrel (`src/db/repositories/agency.repository.ts`) over the files in
 * `src/db/repositories/agency/`, and callers and `vi.mock` go through the barrel path
 * (apps/server/CLAUDE.md). A repository file that imports a sibling `*.repository.js` directly
 * sidesteps that seam: a unit test mocking the barrel still runs the sibling's real SQL. SQL two
 * repository files share lives in a leaf module instead (`sql-fragments.ts`, `assignment-sql.ts`,
 * `contact-unclaim-sql.ts`). Source-level, as `campaign-insert-param-types.test.ts` reads the SQL.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FOLDER = resolve(__dirname, '../../../src/db/repositories/agency');
const SIBLING_REPOSITORY_IMPORT = /\bfrom\s+['"]\.\/[^'"]+\.repository\.js['"]|\bimport\(\s*['"]\.\/[^'"]+\.repository\.js['"]\s*\)/g;

describe('agency repository files', () => {
  const files = readdirSync(FOLDER).filter((f) => f.endsWith('.ts'));

  it('are found (the scan is not vacuous)', () => {
    expect(files).toContain('attempt.repository.ts');
    expect(files).toContain('contact.repository.ts');
    expect(files.length).toBeGreaterThan(20);
  });

  it('never import a sibling repository file directly', () => {
    const offenders = files.flatMap((f) =>
      [...readFileSync(resolve(FOLDER, f), 'utf8').matchAll(SIBLING_REPOSITORY_IMPORT)].map((m) => `${f}: ${m[0]}`));
    expect(offenders).toEqual([]);
  });

  it('the pattern catches the shape it guards', () => {
    expect("import { agencyContactRepository } from './contact.repository.js';".match(SIBLING_REPOSITORY_IMPORT)).not.toBeNull();
    expect("const m = await import('./contact.repository.js');".match(SIBLING_REPOSITORY_IMPORT)).not.toBeNull();
    expect("import { unclaimContactUncharged } from './contact-unclaim-sql.js';".match(SIBLING_REPOSITORY_IMPORT)).toBeNull();
  });
});
