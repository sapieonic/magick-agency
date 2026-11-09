/**
 * Guard for tooling/ci-scope.mjs, which picks what a pull request's CI runs
 * (docs/operations.md "What CI runs"). A scope that is too narrow lets a change merge
 * without the tests that would have caught it, so besides the rules themselves this holds
 * the scope to what the suites actually read: every relative path a package's code, tests
 * or config resolves outside that package must be something the scope already ties to it.
 *
 * Run: `pnpm test:tooling` (node:test, no dependencies).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import {
  GLOBAL_FILES, READ_BY, SERVER_REPO_GUARDS, computeScope, readWorkspace, root, ruleCovers,
} from './ci-scope.mjs';

const workspace = readWorkspace();
const scope = (...files) => computeScope({ files, workspace });

test('reads every workspace package and the workspace packages it depends on', () => {
  const paths = workspace.map((p) => p.path);
  for (const p of ['apps/server', 'apps/console', 'apps/super-admin', 'packages/contracts', 'packages/db', 'packages/web-ui']) {
    assert.ok(paths.includes(p), `${p} missing from ${paths}`);
  }
  assert.ok(!paths.includes('apps/mobile'), 'apps/mobile is Flutter, not a pnpm package');
  const server = workspace.find((p) => p.path === 'apps/server');
  assert.ok(server.deps.includes('@magick-agency/db'));
  assert.ok(server.deps.every((d) => d.startsWith('@magick-agency/')), 'only workspace dependencies are kept');
});

test('a docs-only change runs no package suite, only the repository guards', () => {
  const s = scope('docs/status.md', 'README.md', 'aws/main.tf');
  assert.deepEqual(s.packages, []);
  assert.deepEqual(s.integration, { db: false, server: false });
  assert.equal(s.serverGuards, true);
  assert.equal(s.mobile, false);
  assert.equal(s.full, false);
});

test('prose inside a package does not run its suites', () => {
  const s = scope('apps/server/CLAUDE.md', 'apps/console/CHANGELOG.md');
  assert.deepEqual(s.packages, []);
  assert.equal(s.serverGuards, true);
});

test('a console change runs the console only: no server suite, no integration', () => {
  const s = scope('apps/console/src/pages/Foo.tsx');
  assert.deepEqual(s.packages, ['apps/console']);
  assert.deepEqual(s.integration, { db: false, server: false });
  assert.equal(s.serverGuards, true, 'the server tests that read the console still run');
});

test('a shared UI change runs both web UIs, still no integration', () => {
  const s = scope('packages/web-ui/src/Button.tsx');
  assert.deepEqual(s.packages, ['apps/console', 'apps/super-admin', 'packages/web-ui']);
  assert.deepEqual(s.integration, { db: false, server: false });
});

test('a server change runs the server and its integration lanes, not the db lane', () => {
  const s = scope('apps/server/src/app.ts');
  assert.deepEqual(s.packages, ['apps/server']);
  assert.deepEqual(s.integration, { db: false, server: true });
  assert.equal(s.serverGuards, false, 'the guards run inside the full server suite');
  assert.equal(s.grafana, true, 'test:grafana reads the server OTel setup');
});

test('a db change runs its dependents and both integration lanes', () => {
  const s = scope('packages/db/src/pool.ts');
  assert.deepEqual(s.packages, ['apps/server', 'packages/db']);
  assert.deepEqual(s.integration, { db: true, server: true });
});

test('a contracts change reaches every consumer, the integration lanes and the mobile app', () => {
  const s = scope('packages/contracts/src/index.ts');
  for (const p of ['apps/console', 'apps/super-admin', 'apps/server', 'apps/report-renderer', 'packages/db', 'packages/domain', 'packages/contracts']) {
    assert.ok(s.packages.includes(p), `${p} not in ${s.packages}`);
  }
  assert.deepEqual(s.integration, { db: true, server: true });
  assert.equal(s.mobile, true);
});

test('tooling the suites import counts as a change to those packages', () => {
  assert.deepEqual(scope('tooling/test-env.ts').integration, { db: true, server: true });
  assert.deepEqual(scope('tooling/contracts-literals.mjs').packages.includes('packages/contracts'), true);
  assert.deepEqual(scope('apps/server/test/fixtures/console-paths.json').packages, ['apps/console', 'apps/server']);
});

test("files that another package's suites read pull that package in", () => {
  // saRoutes.test.ts holds SA_ROUTES to the server's super-admin routes.
  assert.deepEqual(scope('apps/server/src/api/routes/super-admin/tenants.ts').packages, ['apps/server', 'apps/super-admin']);
  // brandAssets.test.ts holds the super-admin artwork to the console's.
  assert.deepEqual(scope('apps/console/brands/magick-agency/public/logo.svg').packages, ['apps/console', 'apps/super-admin']);
  assert.deepEqual(scope('apps/server/src/agency/pacing.ts').packages, ['apps/server'], 'other server source does not');
});

test('docker/ runs the server packaging guards, not the server suite', () => {
  const s = scope('docker/nginx.conf');
  assert.deepEqual(s.packages, []);
  assert.equal(s.serverGuards, true);
});

test('a shared root file, or a full run, runs everything', () => {
  for (const f of ['.github/workflows/ci.yml', 'tooling/ci-scope.mjs']) assert.ok(GLOBAL_FILES.has(f), `${f} is proved by a full run`);
  for (const f of GLOBAL_FILES) {
    const s = scope(f);
    assert.equal(s.full, true, f);
    assert.deepEqual(s.packages, workspace.map((p) => p.path));
    assert.deepEqual(s.integration, { db: true, server: true });
    assert.equal(s.mobile, false, `${f}: Flutter builds from none of them`);
  }
  const s = computeScope({ files: ['docs/status.md'], full: true, workspace });
  assert.equal(s.full, true);
  assert.equal(s.mobile, true);
  assert.equal(s.grafana, true);
  assert.equal(s.release, true);
});

test('release-please and grafana checks run on their inputs only', () => {
  assert.equal(scope('release-please-config.json').release, true);
  assert.equal(scope('apps/console/package.json').release, true);
  assert.equal(scope('apps/mobile/pubspec.yaml').release, true);
  assert.equal(scope('apps/console/src/x.ts').release, false);
  assert.equal(scope('grafana/terraform/alerting.tf').grafana, true);
  // The stray-instrument scan reads every package's src, not only observability's.
  assert.equal(scope('packages/db/src/pool.ts').grafana, true);
  assert.equal(scope('packages/db/test/pool.test.ts').grafana, false);
  assert.equal(scope('apps/console/src/x.ts').grafana, false);
});

test('the mobile workflow runs on the app and on what its wire types are checked against', () => {
  for (const f of ['apps/mobile/lib/main.dart', 'packages/contracts/src/x.ts', 'tooling/contracts-literals.mjs', 'packages/domain/src/customer-search-number.ts']) {
    assert.equal(scope(f).mobile, true, f);
  }
  assert.equal(scope('apps/server/src/app.ts').mobile, false);
  assert.equal(scope('packages/domain/src/pacing.ts').mobile, false);
});

test('every server repository guard exists', () => {
  for (const f of SERVER_REPO_GUARDS) assert.ok(existsSync(join(root, 'apps/server', f)), f);
});

/** Every file of a package that can read another (code, tests, config), skipping build output. */
function* sourceFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', 'build'].includes(e.name) || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (/\.(m?[jt]sx?|mts|json)$/.test(e.name)) yield p;
  }
}

/**
 * The paths a file names relative to itself or to its package, each as the absolute paths it
 * may mean:
 * - a `'../x'` literal (an import, `new URL(...)`, a tsconfig `extends`), from the file's folder;
 * - `join(base, '..', 'x', ...)` or `resolve(...)` with literal segments: from the file's folder
 *   when `base` is `__dirname`, from the package when it is `process.cwd()` (suites run from
 *   inside the package), and from either for any other name (a root the file computed).
 */
function* namedPaths(file, pkgDir) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/['"`]((?:\.\.\/)+[^'"`$\s]*)/g)) {
    yield { literal: m[1], candidates: [resolve(dirname(file), m[1])] };
  }
  for (const m of text.matchAll(/\b(?:join|resolve)\(\s*(process\.cwd\(\)|[A-Za-z_$][\w$]*)\s*((?:,\s*'[^'\n]*'\s*)+),?\s*\)/g)) {
    const segments = [...m[2].matchAll(/'([^'\n]*)'/g)].map((s) => s[1]);
    if (!segments.includes('..')) continue;
    const bases = m[1] === '__dirname' ? [dirname(file)] : m[1] === 'process.cwd()' ? [pkgDir] : [dirname(file), pkgDir];
    yield { literal: m[0], candidates: bases.map((b) => resolve(b, ...segments)) };
  }
}

/** The file a named path means, reading a TypeScript `.js` import specifier as its source; or null. */
function onDisk(abs) {
  if (existsSync(abs)) return abs;
  const swaps = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.jsx': ['.tsx'] };
  for (const [ext, to] of Object.entries(swaps)) {
    if (!abs.endsWith(ext)) continue;
    const found = to.map((t) => abs.slice(0, -ext.length) + t).find((f) => existsSync(f));
    if (found) return found;
  }
  return null;
}

test('every file outside a package that the package reads is tied to it by the scope', () => {
  const problems = [];
  for (const pkg of workspace) {
    const pkgDir = join(root, pkg.path);
    const deps = workspace.filter((p) => pkg.deps.includes(p.name)).map((p) => p.path);
    for (const file of sourceFiles(pkgDir)) {
      const own = relative(pkgDir, file);
      for (const { literal, candidates } of namedPaths(file, pkgDir)) {
        for (const named of candidates) {
          const abs = onDisk(named);
          if (!abs) continue; // not a file (a fixture string, or a candidate base that does not apply)
          const target = relative(root, abs);
          if (target === pkg.path || target.startsWith(`${pkg.path}/`)) continue; // inside the package
          if (target.startsWith('..')) continue; // outside the repository
          if (deps.some((d) => target === d || target.startsWith(`${d}/`))) continue; // a dependency: its changes reach here
          if (GLOBAL_FILES.has(target)) continue; // runs everything
          if (READ_BY.some((r) => ruleCovers(r, target) && r.packages.includes(pkg.path))) continue;
          if (pkg.path === 'apps/server' && SERVER_REPO_GUARDS.includes(own)) continue; // runs on every pull request
          problems.push(`${pkg.path}/${own} reads ${target || '(the repository root)'} via ${literal}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], `reads the CI scope does not know about (add a READ_BY rule or a server repository guard):\n  ${problems.join('\n  ')}`);
});
