import packageJson from '../package.json';

/** The renderer's own version, echoed in every callback (`renderer_version`) and on every Lambda log line. */
export const RENDERER_VERSION: string = packageJson.version;

/**
 * The versions of the workspace packages bundled into the Lambda (`contracts`), keyed by the
 * name after `@magick-agency/`. `scripts/build-lambda.mjs` injects them as
 * `__REPORT_RENDERER_PACKAGE_VERSIONS__`; empty outside that build (tests, and the server's
 * inline renderer, whose own lines carry the server's bundled versions).
 */
declare const __REPORT_RENDERER_PACKAGE_VERSIONS__: Record<string, string> | undefined;

function readPackageVersions(): Readonly<Record<string, string>> {
  try {
    if (typeof __REPORT_RENDERER_PACKAGE_VERSIONS__ === 'object' && __REPORT_RENDERER_PACKAGE_VERSIONS__ !== null) {
      return Object.freeze({ ...__REPORT_RENDERER_PACKAGE_VERSIONS__ });
    }
  } catch {
    /* fall through to empty */
  }
  return Object.freeze({});
}

export const BUNDLED_PACKAGE_VERSIONS = readPackageVersions();
