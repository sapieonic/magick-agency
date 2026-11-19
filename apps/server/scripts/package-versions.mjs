// The workspace packages the server bundle inlines, and their versions (build.mjs injects them as
// `__MAGICK_AGENCY_PACKAGE_VERSIONS__`; packages/observability/src/version.ts reads them).
//
// Only `dependencies`. A workspace devDependency is not in the bundle: the report renderer is
// loaded by a dynamic import whose specifier esbuild never resolves, and the image does not carry
// it (docker/Dockerfile), so its version would name code that is not in the process.

const PREFIX = '@magick-agency/';

/**
 * `{ contracts: '0.26.0', db: '0.24.0', … }`, sorted by name, from the server's package.json and
 * `readManifest(name)`, which returns that package's own package.json.
 *
 * @param {{ dependencies?: Record<string, string> }} pkg
 * @param {(name: string) => { version: string }} readManifest
 * @returns {Record<string, string>}
 */
export function bundledPackageVersions(pkg, readManifest) {
  return Object.fromEntries(
    Object.keys(pkg.dependencies ?? {})
      .filter((name) => name.startsWith(PREFIX))
      .sort()
      .map((name) => [name.slice(PREFIX.length), readManifest(name).version]),
  );
}
