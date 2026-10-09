import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

/*
 * PORT NOTE (magick-agency): the three "D10 / MAG-157: concurrency is super-admin
 * only" source guards from master test/unit/audit/catalog.test.ts@a1f0756a
 * (:60-80), deleted from the Phase 2b port of that file until the code they guard
 * existed, restored here by lane A (which owns the super-admin concurrency route).
 *
 *  - "super-admin account concurrency already writes super_admin_audit" —
 *    VERBATIM against `src/api/routes/super-admin.routes.ts`.
 *  - "the agency campaign proxy has no concurrency write path" — MODIFIED. Master
 *    read one file (`proxy-agency-campaigns.routes.ts`, lane B2's, not yet
 *    ported). Here the same three regexes run over EVERY agency route and module
 *    (`src/api/routes/*agency*.ts`, `src/agency/**`), so they bind the moment B2
 *    lands its files, whatever they are called. Master's positive
 *    `/D10: there is no concurrency setter/` comment check moves with that file
 *    (B2), because a guard requiring a comment in a file this lane does not own
 *    would fail until then. Made non-vacuous by the NEW case below.
 *  - "agency campaign config validation has no concurrency field" — MODIFIED the
 *    same way: master's `agency-campaign-config.ts` regex over every file under
 *    `src/agency/` whose name contains `campaign-config`.
 *  - NEW: the repository calls that WRITE the limit
 *    (`providerConcurrencyRepository.replaceProviderBreakdown` / `switchToLegacy`,
 *    core's two writers) appear in `super-admin.routes.ts` and nowhere else under
 *    `src/`, and `accountSettingsRepository.upsert` (which also writes
 *    `max_concurrent_calls`) nowhere: the super-admin settings route writes its
 *    toggles through the toggles-only `setRecordingAnalysisToggles`.
 *    In master the limit's single writer was core's
 *    internal route behind master's super-admin route; in one process the
 *    repository call IS the write, so this is the guard that actually holds D10.
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

/** Strip `//` and block comments so a PORT NOTE naming a method is not a call. */
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

describe('D10 / MAG-157: concurrency is super-admin only', () => {
  it('the agency campaign proxy has no concurrency write path', () => {
    for (const path of AGENCY_SURFACE) {
      const source = code(path);
      expect(source, rel(path)).not.toMatch(/app\.(put|post|patch)(?:<[^>]*>)?\([^)]*concurrency/);
      // Payload field, not just the URL: AD-P4-M-02 must not land as an unaudited
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
