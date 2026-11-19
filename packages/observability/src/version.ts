/**
 * Application version. Reading ../../package.json relative to __dirname would be wrong
 * once the server is an esbuild bundle (dist/index.js) and wrong again from a
 * workspace package. The build injects the server's package.json version as
 * `__MAGICK_AGENCY_VERSION__` (apps/server/scripts/build.mjs); tsx and Vitest
 * runs fall back to the sentinel, as for an unreadable package.json.
 */
declare const __MAGICK_AGENCY_VERSION__: string | undefined;

/**
 * The versions of the workspace packages bundled into the server (`contracts`, `db`,
 * `domain`, `observability`, `report-renderer`), keyed by the name after `@magick-agency/`.
 * Injected by the same build from each package's package.json; empty outside a build.
 * The server puts them on its OTel resource and its listening line, so a log line in
 * Grafana says which release of every package produced it, not only the server's.
 */
declare const __MAGICK_AGENCY_PACKAGE_VERSIONS__: Record<string, string> | undefined;

function readVersion(): string {
  try {
    if (typeof __MAGICK_AGENCY_VERSION__ === 'string' && __MAGICK_AGENCY_VERSION__.length > 0) {
      return __MAGICK_AGENCY_VERSION__;
    }
  } catch {
    /* fall through to sentinel */
  }
  return '0.0.0';
}

function readPackageVersions(): Readonly<Record<string, string>> {
  try {
    if (typeof __MAGICK_AGENCY_PACKAGE_VERSIONS__ === 'object' && __MAGICK_AGENCY_PACKAGE_VERSIONS__ !== null) {
      const out: Record<string, string> = {};
      for (const [name, version] of Object.entries(__MAGICK_AGENCY_PACKAGE_VERSIONS__)) {
        if (typeof version === 'string' && version.length > 0) out[name] = version;
      }
      return Object.freeze(out);
    }
  } catch {
    /* fall through to empty */
  }
  return Object.freeze({});
}

export const APP_VERSION = readVersion();
export const PACKAGE_VERSIONS = readPackageVersions();
