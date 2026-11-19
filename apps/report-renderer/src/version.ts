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

export const BUNDLED_PACKAGE_VERSIONS: Readonly<Record<string, string>> =
  typeof __REPORT_RENDERER_PACKAGE_VERSIONS__ === 'undefined' ? {} : __REPORT_RENDERER_PACKAGE_VERSIONS__;
