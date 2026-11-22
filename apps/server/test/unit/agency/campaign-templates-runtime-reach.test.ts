import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CT1 (docs/campaign-templates.md): a campaign stores a copy of its settings, and nothing that reads
 * a campaign at run time reads a template. Held structurally here: only the template modules may
 * name the template tables or the template repository. Pacing, the dialer, the station, wrap-up,
 * retries, reports and the campaign reads (`findById`, `findActive`) are outside the list, so a
 * read that overlaid a template's values on a campaign would have to name one and turns this red.
 * (The behaviour is pinned on real Postgres by `campaign-templates-create.test.ts`, "CT1: nothing
 * that reads a campaign at run time sees the template".)
 *
 * Comments and type-only imports are stripped: a module may say what it does not do, and a type
 * reads nothing.
 */

const serverRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const SRC = join(serverRoot, 'src');

/**
 * The template tables, the template repository, and a value import of the template modules
 * (`agency/campaign-templates/*`, which read them), by any name a reader would use. A type-only
 * import reads nothing.
 */
const NAMES_A_TEMPLATE = /\bagency_campaign_templates\b|\bagency_campaign_template_versions\b|\b[aA]gencyCampaignTemplateRepository\b|campaign-template\.repository|from '[./]*(agency\/)?campaign-templates\//;
const TYPE_IMPORT = /^import type [\s\S]*?from '[^']+';$/gm;

/** The modules that may, each with why. Paths relative to `src`; a trailing `/` is a directory. */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ['db/repositories/agency/campaign-template.repository.ts', 'the repository itself'],
  ['db/repositories/agency.repository.ts', 'the agency repository barrel (B12) re-exports it'],
  ['agency/campaign-templates/', 'the fill-in, the create fill and the record (CT8, CT9)'],
  ['agency/softphone/untagged-outcomes.ts', 'CT11: the soft phone reads the default chain live, by ruling'],
  ['api/routes/proxy-agency-campaigns/crud.ts', 'the campaign create fills in from a template (CT8), once, at the create'],
  ['api/routes/agency-campaigns/crud.ts', 'a settings PATCH recomputes the record (CT9), never the settings'],
  ['api/routes/proxy-agency-campaign-templates/', 'the template routes'],
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Block and line comments out (a `://` is a URL, not a comment). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const allowed = (file: string) => [...ALLOWED.keys()].some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

describe('CT1: only the template modules read templates', () => {
  it('no module outside the list names the template tables or the template repository', () => {
    const naming = walk(SRC)
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .filter((file) => NAMES_A_TEMPLATE.test(stripComments(readFileSync(join(SRC, file), 'utf8')).replace(TYPE_IMPORT, '')));
    expect(naming.filter((file) => !allowed(file))).toEqual([]);
    // Each entry still names something (a stale entry would let a new reader in under its name).
    for (const entry of ALLOWED.keys()) expect(naming.some((file) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry)), entry).toBe(true);
  });
});
