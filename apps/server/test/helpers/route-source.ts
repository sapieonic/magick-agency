import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROUTES = fileURLToPath(new URL('../../src/api/routes/', import.meta.url));

/**
 * The files of one route family: `src/api/routes/<family>.routes.ts` (the exported plugin,
 * which keeps the family's hooks) and every `.ts` under `src/api/routes/<family>/` (the
 * route registrations it calls on the same instance), as paths relative to `src/`.
 *
 * Source-text guards read a FAMILY rather than one file, so splitting a family across
 * more files cannot quietly move a route out of a guard's sight: a new file in the
 * folder is read the moment it exists.
 */
export function routeFamilyFiles(family: string): string[] {
  const files = [`api/routes/${family}.routes.ts`];
  const dir = join(ROUTES, family);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts')).sort()) {
      files.push(`api/routes/${family}/${name}`);
    }
  }
  return files;
}

/** Every file of {@link routeFamilyFiles}, concatenated (each preceded by its path). */
export function routeFamilySource(family: string): string {
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  return routeFamilyFiles(family)
    .map((file) => `// ── ${file}\n${readFileSync(join(src, file), 'utf8')}`)
    .join('\n');
}
