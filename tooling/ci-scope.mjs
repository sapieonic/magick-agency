#!/usr/bin/env node
/**
 * What a pull request's CI runs, from the files it changes (docs/operations.md "What CI runs").
 *
 * A pull request runs the checks of the workspace packages it changes and of every package
 * that depends on them, and the integration suites only when a backend package (the server,
 * the db package or anything they depend on) is among them. The label `full-ci`, a manual
 * run and every push to main run everything.
 *
 *   node tooling/ci-scope.mjs --base <sha> [--head <sha>] [--full]
 *
 * Prints the scope; under GitHub Actions it also writes the step outputs and a step summary.
 * Pure Node, no dependencies: the `changes` job runs it before `pnpm install`.
 *
 * Tests: tooling/ci-scope.test.mjs (`pnpm test:tooling`).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Adding this label to a pull request runs every check, as on main. */
export const FULL_LABEL = 'full-ci';

/**
 * Files every package builds or installs from, and CI's own definition: a change to one runs
 * everything in CI. (pnpm-workspace.yaml can add or drop a package; the lockfile moves every
 * dependency; a change to ci.yml or to the scope rules is proved by the full run, not by a
 * scope it may itself have narrowed.)
 */
export const GLOBAL_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  '.npmrc',
  '.nvmrc',
  '.github/workflows/ci.yml',
  'tooling/ci-scope.mjs',
]);

/**
 * Files outside a package that a package's own suites read: changing one counts as changing
 * the package (so it reaches the integration lanes too, when the package is a backend one).
 * tooling/ci-scope.test.mjs finds these reads in every package and fails on one not listed
 * here, in GLOBAL_FILES, in a dependency or in SERVER_REPO_GUARDS.
 */
export const READ_BY = [
  { prefix: 'tooling/test-env.ts', packages: ['packages/db', 'apps/server'] },
  { prefix: 'tooling/vitest-decorator-transform.ts', packages: ['packages/db', 'apps/server'] },
  { prefix: 'tooling/contracts-literals.', packages: ['packages/contracts'] },
  // insightsDrilldowns.test.tsx holds the console to the server's drill-down fixture.
  { prefix: 'apps/server/test/fixtures/', packages: ['apps/console'] },
  // saRoutes.test.ts holds SA_ROUTES to the server's super-admin route files, both ways.
  { prefix: 'apps/server/src/api/routes/', packages: ['apps/super-admin'] },
  // brandAssets.test.ts holds the super-admin logo and favicon to the console's, byte for byte.
  { prefix: 'apps/console/brands/', packages: ['apps/super-admin'] },
];

/** Whether a READ_BY rule covers a path (a directory read matches a rule for that directory). */
export const ruleCovers = (rule, path) => path.startsWith(rule.prefix) || `${path}/` === rule.prefix;

/**
 * Server unit tests that read files outside the server and its dependencies: the web UIs'
 * sources (the route tables, CORS), docker/ (the packaging), or the whole repository (the
 * branding guards, which also cover docs/). When the server's own suite is not in scope
 * these run on their own, on every pull request: they take seconds.
 */
export const SERVER_REPO_GUARDS = [
  'test/unit/branding/no-external-references.test.ts',
  'test/unit/branding/no-parent-brand.test.ts',
  'test/unit/api/middleware/cors.test.ts',
  'test/unit/api/agency-route-table.test.ts',
  'test/unit/deploy/production-packaging.test.ts',
  'test/unit/deploy/mobile-app-links.test.ts',
  'test/unit/audio/decoder-toolchain-packaging.test.ts',
];

/** The integration lanes, by the package whose `test:integration` they run. */
export const INTEGRATION = { db: 'packages/db', server: 'apps/server' };

/**
 * The mobile workflow (apps/mobile is Flutter, not a pnpm package): the app, the contracts its
 * wire types are checked against, the literal extractor, and the number rule agency_wire ports.
 */
export const MOBILE_PREFIXES = [
  'apps/mobile/',
  'packages/contracts/',
  'tooling/contracts-literals.',
  'packages/domain/src/customer-search-number.ts',
  '.github/workflows/mobile.yml',
];

/**
 * `pnpm test:grafana` reads grafana/, the metric declarations and the server's OTel setup, and
 * scans `apps/server/src` and every `packages/<name>/src` for a stray instrument.
 */
const isGrafanaInput = (f) =>
  f.startsWith('grafana/')
  || f.startsWith('apps/server/src/')
  || /^packages\/[^/]+\/src\//.test(f)
  || f.startsWith('packages/observability/');

/** `pnpm test:release` reads the release-please config, the manifest and every version. */
const isReleaseInput = (f) =>
  f === 'release-please-config.json'
  || f === '.release-please-manifest.json'
  || f === 'tooling/release-please.test.mjs'
  || /^(apps|packages)\/[^/]+\/(package\.json|pubspec\.yaml)$/.test(f);

/** Prose inside a package does not change what its suites run (the branding guards read it). */
const isProse = (f) => f.endsWith('.md');

/**
 * The workspace packages, from the `<dir>/*` globs in pnpm-workspace.yaml, with the workspace
 * packages each depends on (dependencies and devDependencies).
 */
export function readWorkspace(dir = root) {
  const lines = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start < 0) throw new Error('pnpm-workspace.yaml has no `packages:` list');
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const item = /^\s+-\s+['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
    if (!item) continue;
    if (!/^[\w.-]+\/\*$/.test(item[1])) throw new Error(`pnpm-workspace.yaml entry "${item[1]}" is not a <dir>/* glob`);
    globs.push(item[1].slice(0, -2));
  }
  const found = globs.flatMap((g) =>
    readdirSync(join(dir, g), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, g, e.name, 'package.json')))
      .map((e) => {
        const path = `${g}/${e.name}`;
        const pkg = JSON.parse(readFileSync(join(dir, path, 'package.json'), 'utf8'));
        return { path, name: pkg.name, deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }) };
      }),
  );
  const names = new Set(found.map((p) => p.name));
  return found
    .map((p) => ({ ...p, deps: p.deps.filter((d) => names.has(d)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The scope of a change.
 *
 * @param {{ files: string[], full?: boolean, workspace: ReturnType<typeof readWorkspace> }} input
 * @returns {{
 *   full: boolean, reason: string, packages: string[], names: string[],
 *   integration: { db: boolean, server: boolean }, serverGuards: boolean,
 *   grafana: boolean, release: boolean, mobile: boolean,
 * }}
 */
export function computeScope({ files, full = false, workspace }) {
  const all = workspace.map((p) => p.path);
  // Flutter builds from none of the shared root files: only a full run forces it.
  const mobile = full || files.some((f) => MOBILE_PREFIXES.some((p) => f.startsWith(p)));
  const globals = files.filter((f) => GLOBAL_FILES.has(f));
  if (full || globals.length > 0) {
    return {
      full: true,
      reason: full ? 'full run requested' : `shared root file changed: ${globals.join(', ')}`,
      packages: all,
      names: workspace.map((p) => p.name),
      integration: { db: true, server: true },
      serverGuards: false,
      grafana: true,
      release: true,
      mobile,
    };
  }

  // Packages whose own files (or files their suites read) changed.
  const changed = new Set();
  for (const f of files) {
    const owner = all.find((p) => f.startsWith(`${p}/`));
    if (owner && !isProse(f)) changed.add(owner);
    for (const rule of READ_BY) if (ruleCovers(rule, f)) rule.packages.forEach((p) => changed.add(p));
  }

  // Every package that depends on one of them, transitively.
  const byName = new Map(workspace.map((p) => [p.name, p]));
  const affected = new Set(changed);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of workspace) {
      if (!affected.has(p.path) && p.deps.some((d) => affected.has(byName.get(d).path))) {
        affected.add(p.path);
        grew = true;
      }
    }
  }

  const packages = all.filter((p) => affected.has(p));
  return {
    full: false,
    reason: packages.length ? `changed: ${[...changed].sort().join(', ')}` : 'no workspace package changed',
    packages,
    names: workspace.filter((p) => affected.has(p.path)).map((p) => p.name),
    integration: { db: affected.has(INTEGRATION.db), server: affected.has(INTEGRATION.server) },
    serverGuards: files.length > 0 && !affected.has(INTEGRATION.server),
    grafana: files.some(isGrafanaInput),
    release: files.some(isReleaseInput),
    mobile,
  };
}

/** Files changed on `head` since it left `base` (the merge base, as a pull request's diff). */
export function changedFiles(base, head = 'HEAD', cwd = root) {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}...${head}`], { cwd, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function parseArgs(argv) {
  const args = { full: false, base: undefined, head: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--head') args.head = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = readWorkspace();
  // No base (or GitHub's all-zero "no previous commit") cannot be diffed: run everything.
  const full = args.full || !args.base || /^0+$/.test(args.base);
  const files = full ? [] : changedFiles(args.base, args.head);
  const scope = computeScope({ files, full, workspace });

  const outputs = {
    full: String(scope.full),
    // pnpm selectors, one per package: `pnpm $FILTERS run lint`. Empty when nothing is in scope.
    filters: scope.names.map((n) => `--filter ${n}`).join(' '),
    any: String(scope.packages.length > 0),
    server: String(scope.packages.includes(INTEGRATION.server)),
    integration: JSON.stringify(scope.integration),
    server_guards: String(scope.serverGuards),
    server_guard_files: SERVER_REPO_GUARDS.join(' '),
    grafana: String(scope.grafana),
    release: String(scope.release),
    mobile: String(scope.mobile),
  };

  const lines = [
    `### CI scope${scope.full ? ': everything' : ''}`,
    '',
    `${scope.reason}${scope.full ? '' : ` (${files.length} file${files.length === 1 ? '' : 's'}; add the \`${FULL_LABEL}\` label to run everything)`}`,
    '',
    `- Lint, unit tests, build: ${scope.packages.length ? scope.packages.join(', ') : 'none'}`,
    `- Integration: ${Object.entries(scope.integration).filter(([, on]) => on).map(([k]) => k).join(', ') || 'none'}`,
    `- Server repository guards on their own: ${scope.serverGuards ? 'yes' : 'no'}`,
    `- Grafana rules: ${scope.grafana ? 'yes' : 'no'}; release-please config: ${scope.release ? 'yes' : 'no'}; mobile: ${scope.mobile ? 'yes' : 'no'}`,
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
