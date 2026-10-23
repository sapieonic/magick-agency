/**
 * Guard for the release-please setup (docs/operations.md "Releases and versioning", B24).
 *
 * release-please assigns a commit to a component only by the files it touches, and the
 * node-workspace plugin bumps an app only when a workspace package it depends on is itself
 * a release-please component. So a workspace package missing from the config is silent:
 * its changes ship inside the server or UI bundles without moving their versions and
 * without a changelog line. A manifest that disagrees with a package.json is the other
 * quiet failure: release-please bumps from the manifest, the package.json drifts.
 *
 * Run: `pnpm test:release` (node:test, no dependencies).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

const config = readJson('release-please-config.json');
const manifest = readJson('.release-please-manifest.json');

/**
 * Workspace package directories, from the `packages:` list in pnpm-workspace.yaml. Only
 * `<dir>/*` globs are understood; any other entry fails the suite rather than being skipped,
 * so a package it cannot see cannot pass as configured.
 */
function workspacePackages() {
  const lines = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  assert.ok(start >= 0, 'pnpm-workspace.yaml has no `packages:` list');
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key
    const item = /^\s+-\s+['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
    if (item) entries.push(item[1]);
  }
  assert.ok(entries.length > 0, 'the `packages:` list in pnpm-workspace.yaml is empty');
  for (const entry of entries) {
    assert.match(entry, /^[\w.-]+\/\*$/, `pnpm-workspace.yaml entry "${entry}" is not a <dir>/* glob this guard understands`);
  }
  return entries
    .map((glob) => glob.slice(0, -2))
    .flatMap((dir) =>
      readdirSync(join(root, dir), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, dir, e.name, 'package.json')))
        .map((e) => `${dir}/${e.name}`),
    )
    .sort();
}

/**
 * The keys release-please reads, from `extractReleaserConfig` (per package, and as defaults at
 * the top level) and `parseConfig` (top level only) in release-please 17.6, which
 * googleapis/release-please-action@v5 bundles. release-please ignores any other key silently,
 * so a misspelt `bump-minor-pre-major` would let a breaking change on 0.x jump to 1.0.0.
 * A key a newer release-please adds belongs here once the action bundles that version.
 */
const RELEASER_KEYS = new Set([
  'always-link-local', 'always-update', 'bump-minor-pre-major', 'bump-patch-for-minor-pre-major',
  'changelog-host', 'changelog-path', 'changelog-sections', 'changelog-type', 'component',
  'component-no-space', 'date-format', 'draft', 'draft-pull-request', 'exclude-paths', 'extra-files',
  'extra-label', 'force-tag-creation', 'include-commit-authors', 'include-component-in-tag',
  'include-v-in-release-name', 'include-v-in-tag', 'initial-version', 'package-name',
  'prerelease', 'prerelease-type', 'pull-request-footer', 'pull-request-header',
  'pull-request-title-pattern', 'release-as', 'release-type', 'separate-pull-requests',
  'skip-changelog', 'skip-github-release', 'skip-snapshot', 'snapshot-label', 'tag-separator',
  'version-file', 'versioning',
]);
const TOP_LEVEL_KEYS = new Set([
  ...RELEASER_KEYS,
  '$schema', 'packages', 'plugins', 'bootstrap-sha', 'last-release-sha', 'label', 'release-label',
  'group-pull-request-title-pattern', 'signoff', 'commit-batch-size', 'commit-search-depth',
  'release-search-depth', 'sequential-calls',
]);

const configured = Object.keys(config.packages).sort();

test('every workspace package is a release-please component, and nothing else is', () => {
  assert.deepEqual(configured, workspacePackages());
});

test('every config key is one release-please reads (a misspelt key is ignored silently)', () => {
  for (const key of Object.keys(config)) {
    assert.ok(TOP_LEVEL_KEYS.has(key), `top-level key "${key}" is not a release-please option`);
  }
  for (const [path, pkg] of Object.entries(config.packages)) {
    for (const key of Object.keys(pkg)) {
      assert.ok(RELEASER_KEYS.has(key), `${path}: key "${key}" is not a release-please package option`);
    }
  }
});

test('each component is named after its directory, so tags read <dir>-v<version>', () => {
  for (const [path, pkg] of Object.entries(config.packages)) {
    assert.equal(pkg.component, path.split('/').pop(), `${path}: component`);
  }
  assert.equal(config['include-component-in-tag'], true);
});

test('every component is released as a node package', () => {
  for (const [path, pkg] of Object.entries(config.packages)) {
    assert.equal(pkg['release-type'] ?? config['release-type'], 'node', `${path}: release-type`);
  }
});

test('the node-workspace plugin is on, so a shared-package release bumps the apps using it', () => {
  assert.ok(
    (config.plugins ?? []).some((p) => (typeof p === 'string' ? p : p.type) === 'node-workspace'),
    'plugins must include node-workspace',
  );
});

test('while a version is 0.x, a breaking change bumps the minor and a feat the minor (operations.md)', () => {
  assert.equal(config['bump-minor-pre-major'], true);
  assert.equal(config['bump-patch-for-minor-pre-major'], false);
});

test('the manifest lists exactly the configured components', () => {
  assert.deepEqual(Object.keys(manifest).sort(), configured);
});

test('each manifest version equals the version in that package.json', () => {
  for (const path of configured) {
    const { version } = readJson(`${path}/package.json`);
    assert.match(manifest[path], /^\d+\.\d+\.\d+(-[\w.]+)?$/, `${path}: manifest version`);
    assert.equal(version, manifest[path], `${path}: package.json version vs manifest`);
  }
});

test('exclude-paths are existing directories inside their own component', () => {
  for (const [path, pkg] of Object.entries(config.packages)) {
    for (const excluded of pkg['exclude-paths'] ?? []) {
      assert.ok(excluded.startsWith(`${path}/`), `${path}: ${excluded} is outside the component`);
      assert.ok(existsSync(join(root, excluded)), `${path}: ${excluded} does not exist`);
    }
  }
});

test('bootstrap-sha is a full commit sha', () => {
  assert.match(config['bootstrap-sha'], /^[0-9a-f]{40}$/);
});
