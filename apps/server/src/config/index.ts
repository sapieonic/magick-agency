import 'dotenv/config';
import { parseConfig } from './load.js';
import type { AppConfig } from './schema.js';

export type { AppConfig } from './schema.js';
export { parseConfig } from './load.js';

/**
 * Exits on invalid config, like core and master: a half-configured process
 * that boots is worse than one that refuses to. Every issue is printed with
 * its path so the operator can fix them all in one pass.
 */
function loadConfig(): AppConfig {
  const result = parseConfig(process.env);
  if (!result.ok) {
    for (const issue of result.issues) {
      console.error(`Invalid config: ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.config;
}

export const config: AppConfig = loadConfig();
