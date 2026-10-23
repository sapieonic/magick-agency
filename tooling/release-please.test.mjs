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

/** Workspace package directories, from the `dir/*` globs in pnpm-workspace.yaml. */
function workspacePackages() {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...yaml.matchAll(/^\s+-\s+['"]?([\w./-]+)\/\*['"]?\s*$/gm)].map((m) => m[1]);
  assert.ok(globs.length > 0, 'no `<dir>/*` globs found in pnpm-workspace.yaml');
  return globs
    .flatMap((dir) =>
      readdirSync(join(root, dir), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, dir, e.name, 'package.json')))
        .map((e) => `${dir}/${e.name}`),
    )
    .sort();
}

const configured = Object.keys(config.packages).sort();

test('every workspace package is a release-please component, and nothing else is', () => {
  assert.deepEqual(configured, workspacePackages());
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
