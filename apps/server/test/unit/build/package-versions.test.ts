import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { bundledPackageVersions } from '../../../scripts/package-versions.mjs';

/**
 * The versions the server build injects (`scripts/build.mjs`) and the observability package
 * reads back (`PACKAGE_VERSIONS`), which become every exported record's
 * `magick_agency.package.<name>.version`. Only what the bundle really inlines may be named:
 * a version for code that is not in the process would mislead whoever reads the record.
 */
const serverPkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const readManifest = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../node_modules/${name}/package.json`, import.meta.url), 'utf8')) as { version: string };

describe('bundledPackageVersions', () => {
  it('names each workspace dependency by its short name, sorted, with its own version', () => {
    const versions = bundledPackageVersions(
      { dependencies: { '@magick-agency/db': 'workspace:*', fastify: '^5', '@magick-agency/contracts': 'workspace:*' } },
      (name) => ({ version: name === '@magick-agency/db' ? '1.2.3' : '4.5.6' }),
    );
    expect(versions).toEqual({ contracts: '4.5.6', db: '1.2.3' });
    expect(Object.keys(versions)).toEqual(['contracts', 'db']);
  });

  it('leaves out devDependencies: the report renderer is loaded at runtime, never bundled', () => {
    // The premise: the renderer is a workspace devDependency of the server.
    expect(serverPkg.devDependencies['@magick-agency/report-renderer']).toBe('workspace:*');
    const versions = bundledPackageVersions(serverPkg, readManifest);
    expect(versions).not.toHaveProperty('report-renderer');
    expect(versions).toEqual({
      contracts: readManifest('@magick-agency/contracts').version,
      db: readManifest('@magick-agency/db').version,
      domain: readManifest('@magick-agency/domain').version,
      observability: readManifest('@magick-agency/observability').version,
    });
  });
});

describe('the injected versions, read back by @magick-agency/observability', () => {
  const versionSource = createRequire(import.meta.url).resolve('@magick-agency/observability/version');

  /** Bundle `version.ts` as the server build does, with or without the defines, and load it. */
  function load(define: Record<string, string>): { APP_VERSION: string; PACKAGE_VERSIONS: Record<string, string> } {
    const out = buildSync({ entryPoints: [versionSource], bundle: true, write: false, platform: 'node', format: 'cjs', define });
    const mod = { exports: {} as Record<string, unknown> };
    new Function('module', 'exports', out.outputFiles[0]!.text)(mod, mod.exports);
    return mod.exports as { APP_VERSION: string; PACKAGE_VERSIONS: Record<string, string> };
  }

  it('reads the build\'s values, frozen', () => {
    const { APP_VERSION, PACKAGE_VERSIONS } = load({
      __MAGICK_AGENCY_VERSION__: JSON.stringify('9.9.9'),
      __MAGICK_AGENCY_PACKAGE_VERSIONS__: JSON.stringify({ contracts: '1.0.0', db: '2.0.0' }),
    });
    expect(APP_VERSION).toBe('9.9.9');
    expect(PACKAGE_VERSIONS).toEqual({ contracts: '1.0.0', db: '2.0.0' });
    expect(Object.isFrozen(PACKAGE_VERSIONS)).toBe(true);
  });

  it('falls back to the sentinel and no packages without a build', () => {
    expect(load({})).toEqual({ APP_VERSION: '0.0.0', PACKAGE_VERSIONS: {} });
  });
});
