import packageJson from '../package.json';

/** The renderer's own version, echoed in every callback (`renderer_version`). */
export const RENDERER_VERSION: string = packageJson.version;
