// The workspace packages the server bundle inlines, and their versions (build.mjs injects them as
// `__MAGICK_AGENCY_PACKAGE_VERSIONS__`; packages/observability/src/version.ts reads them).
// apps/report-renderer/scripts/build-lambda.mjs does the same for the Lambda; the image has no
// tooling/ to share one helper from, and the renderer may not depend on the server.
//
// Only `dependencies`. A workspace devDependency is not in the bundle: the report renderer is
// loaded by a dynamic import whose specifier esbuild never resolves, and the image does not carry
// it (docker/Dockerfile). `assertBundled` checks the list against what esbuild really inlined.
import { readFileSync } from 'node:fs';

export const WORKSPACE = /^@magick-agency\//;

/** A package's own package.json, as installed beside the server. */
export function readWorkspaceManifest(name) {
  return JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
}

/**
 * `{ contracts: '0.26.0', db: '0.24.0', … }`, sorted by name. Throws on a name or version that
 * could not be an attribute or a release, so nothing downstream has to check them again.
 */
export function bundledPackageVersions(pkg, readManifest = readWorkspaceManifest) {
  return Object.fromEntries(
    Object.keys(pkg.dependencies ?? {})
      .filter((name) => WORKSPACE.test(name))
      .sort()
      .map((name) => {
        const short = name.replace(WORKSPACE, '');
        const { version } = readManifest(name);
        if (!/^[a-z][a-z0-9-]*$/.test(short) || typeof version !== 'string' || !version) {
          throw new Error(`${name}: cannot report version ${JSON.stringify(version)}`);
        }
        return [short, version];
      }),
  );
}

/**
 * Throws unless the workspace packages esbuild inlined (`metafile.inputs` under
 * `packages/<name>/src` or `apps/<name>/src`, outside the server's own) are exactly `versions`.
 */
export function assertBundled(metafile, versions) {
  const bundled = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /^(?:\.\.\/)+(?:packages|apps)\/([^/]+)\/src\//.exec(input);
    if (m) bundled.add(m[1]);
  }
  const listed = Object.keys(versions);
  const missing = [...bundled].filter((n) => !listed.includes(n)).sort();
  const extra = listed.filter((n) => !bundled.has(n));
  if (missing.length || extra.length) {
    throw new Error(
      `package versions do not match the bundle: bundled but not listed [${missing}], listed but not bundled [${extra}]` +
        ' (a bundled workspace package must be a server dependency)',
    );
  }
}
