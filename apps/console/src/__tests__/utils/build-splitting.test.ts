import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function findFiles(dir: string, suffix: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return findFiles(path, suffix);
    return path.endsWith(suffix) ? [path] : [];
  });
}

describe('build splitting conventions', () => {
  it('does not dynamically import firebase auth from API modules', () => {
    const apiFiles = findFiles(join(repoRoot, 'api'), '.ts');
    const offenders = apiFiles.filter((file) => (
      readFileSync(file, 'utf8').includes("import('firebase/auth')")
    ));

    expect(offenders.map((file) => file.replace(`${repoRoot}/`, ''))).toEqual([]);
  });

  it('lazy-loads route pages instead of statically importing them in App', () => {
    const appSource = readFileSync(join(repoRoot, 'App.tsx'), 'utf8');
    const staticPageImports = appSource
      .split('\n')
      .filter((line) => /^import\s+.+\s+from\s+['"]\.\/pages\//.test(line));

    expect(staticPageImports).toEqual([]);
  });
});
