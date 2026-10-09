/**
 * Application version. Reading ../../package.json relative to __dirname would be wrong
 * once the server is an esbuild bundle (dist/index.js) and wrong again from a
 * workspace package. The build injects the server's package.json version as
 * `__MAGICK_AGENCY_VERSION__` (apps/server/scripts/build.mjs); tsx and Vitest
 * runs fall back to the sentinel, as for an unreadable package.json.
 */
declare const __MAGICK_AGENCY_VERSION__: string | undefined;

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
