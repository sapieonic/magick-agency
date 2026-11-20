import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { assertBundled, bundledPackageVersions, readWorkspaceManifest } from '../../../scripts/package-versions.mjs';

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
    const versions = bundledPackageVersions(serverPkg);
    expect(versions).not.toHaveProperty('report-renderer');
    expect(versions).toEqual(Object.fromEntries(
      ['contracts', 'db', 'domain', 'observability'].map((n) => [n, readWorkspaceManifest(`@magick-agency/${n}`).version]),
    ));
  });

  it('refuses a version that is not one, so nothing downstream re-checks it', () => {
    const pkg = { dependencies: { '@magick-agency/db': 'workspace:*' } };
    expect(() => bundledPackageVersions(pkg, () => ({ version: '' }))).toThrow(/@magick-agency\/db/);
    expect(() => bundledPackageVersions(pkg, () => ({ version: undefined }))).toThrow(/@magick-agency\/db/);
  });
});

describe('assertBundled', () => {
  const metafile = { inputs: { 'src/index.ts': {}, '../../packages/db/src/pool.ts': {}, '../../packages/contracts/src/a.ts': {} } };

  it('passes when the list is exactly what esbuild inlined', () => {
    expect(() => assertBundled(metafile, { contracts: '1', db: '2' })).not.toThrow();
  });

  it('fails the build on drift either way', () => {
    expect(() => assertBundled(metafile, { db: '2' })).toThrow(/bundled but not listed \[contracts\]/);
    expect(() => assertBundled(metafile, { contracts: '1', db: '2', domain: '3' })).toThrow(/listed but not bundled \[domain\]/);
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

  it('reads the build\'s values', () => {
    expect(load({
      __MAGICK_AGENCY_VERSION__: JSON.stringify('9.9.9'),
      __MAGICK_AGENCY_PACKAGE_VERSIONS__: JSON.stringify({ contracts: '1.0.0', db: '2.0.0' }),
    })).toEqual({ APP_VERSION: '9.9.9', PACKAGE_VERSIONS: { contracts: '1.0.0', db: '2.0.0' } });
  });

  it('falls back to the sentinel and no packages without a build', () => {
    expect(load({})).toEqual({ APP_VERSION: '0.0.0', PACKAGE_VERSIONS: {} });
  });
});
