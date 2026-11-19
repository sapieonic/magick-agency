/**
 * Application version. Reading ../../package.json relative to __dirname would be wrong
 * once the server is an esbuild bundle (dist/index.js) and wrong again from a
 * workspace package. The build injects the server's package.json version as
 * `__MAGICK_AGENCY_VERSION__` (apps/server/scripts/build.mjs); tsx and Vitest
 * runs fall back to the sentinel, as for an unreadable package.json.
 */
declare const __MAGICK_AGENCY_VERSION__: string | undefined;

/**
 * The bundled workspace packages' versions (`{ contracts: '0.26.0', … }`), injected by the same
 * build (apps/server/scripts/package-versions.mjs, which validates them); empty outside a build.
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

export const APP_VERSION = readVersion();
export const PACKAGE_VERSIONS: Readonly<Record<string, string>> =
  typeof __MAGICK_AGENCY_PACKAGE_VERSIONS__ === 'undefined' ? {} : __MAGICK_AGENCY_PACKAGE_VERSIONS__;
