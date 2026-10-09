import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

/*
 * The "D10: concurrency is super-admin only" source guards:
 *
 *  - "super-admin account concurrency already writes super_admin_audit" runs
 *    against `src/api/routes/super-admin.routes.ts`.
 *  - "the agency campaign proxy has no concurrency write path": the three
 *    regexes run over EVERY agency route and module (`src/api/routes/*agency*.ts`,
 *    `src/agency/**`), so they bind whatever the files are called. The positive
 *    `/D10: there is no concurrency setter/` comment check belongs with the
 *    campaign proxy route file. Made non-vacuous by the last case below.
 *  - "agency campaign config validation has no concurrency field": the same
 *    regex over every file under `src/agency/` whose name contains `campaign-config`.
 *  - The repository calls that WRITE the limit
 *    (`providerConcurrencyRepository.replaceProviderBreakdown` / `switchToLegacy`,
 *    the two writers) appear in `super-admin.routes.ts` and nowhere else under
 *    `src/`, and `accountSettingsRepository.upsert` (which also writes
 *    `max_concurrent_calls`) nowhere: the super-admin settings route writes its
 *    toggles through the toggles-only `setRecordingAnalysisToggles`.
 *    Everything runs in one process, so the repository call IS the write; this
 *    is the guard that actually holds D10.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(ROOT, path).split('\\').join('/');

/** Strip `//` and block comments so a comment naming a method is not a call. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const SRC = walk(resolve(ROOT, 'src'));
const AGENCY_SURFACE = SRC.filter((path) => {
  const r = rel(path);
  return r.startsWith('src/agency/') || /^src\/api\/routes\/[^/]*agency[^/]*\.ts$/.test(r);
});

describe('D10: concurrency is super-admin only', () => {
  it('the agency campaign proxy has no concurrency write path', () => {
    for (const path of AGENCY_SURFACE) {
      const source = code(path);
      expect(source, rel(path)).not.toMatch(/app\.(put|post|patch)(?:<[^>]*>)?\([^)]*concurrency/);
      // Payload field, not just the URL: a concurrency cap must not land as an unaudited
      // campaign body key.
      expect(source, rel(path)).not.toMatch(/max_concurrent_calls:\s/);
    }
  });

  it('agency campaign config validation has no concurrency field', () => {
    for (const path of AGENCY_SURFACE.filter((p) => rel(p).includes('campaign-config'))) {
      expect(code(path), rel(path)).not.toMatch(/max_concurrent|concurrency/);
    }
  });

  it('super-admin account concurrency already writes super_admin_audit', () => {
    const source = readFileSync(resolve(ROOT, 'src/api/routes/super-admin.routes.ts'), 'utf8');
    expect(source).toMatch(/action: 'update_account_concurrency'/);
    expect(source).toMatch(/superAdminAuditRepository\.log/);
  });

  it('the limit is written only by the super-admin routes (the repository writers have exactly these callers)', () => {
    const callers = (pattern: RegExp) => SRC.filter((path) => pattern.test(code(path))).map(rel).sort();

    expect(callers(/providerConcurrencyRepository\s*\.\s*(replaceProviderBreakdown|switchToLegacy)\s*\(/))
      .toEqual(['src/api/routes/super-admin.routes.ts']);
    // `upsert` also writes `max_concurrent_calls` (and bumps the allocation
    // version in legacy mode): nothing in the server may call it. The settings
    // route writes its toggles through the toggles-only writer instead.
    expect(callers(/accountSettingsRepository\s*\.\s*upsert\s*\(/)).toEqual([]);
    expect(callers(/accountSettingsRepository\s*\.\s*setRecordingAnalysisToggles\s*\(/))
      .toEqual(['src/api/routes/super-admin-account-settings.routes.ts']);
  });
});
