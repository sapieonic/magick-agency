import { z } from 'zod';
import { envBoolean, type Env } from '../env.js';

/**
 * Agency config (decision B4: one config block per area, so blocks never collide).
 */

/**
 * `rosterReplaceEnabled` (`AGENCY_ROSTER_REPLACE_ENABLED`) gates the two DESTRUCTIVE roster
 * paths — `mode: 'replace'` on an ingest, and the roster-clear endpoint. **Defaults OFF**:
 * every replace fails at the in-process supersede (decision B15:
 * there is no supersede primitive), so a surface that is visible and always fails is a
 * support ticket per operator, while a surface that is not registered is a feature that has
 * not shipped. Enable it only once a real supersede exists.
 *
 * There is no credits threshold: the app has no credits (decision S6).
 */
const agencySchema = z.object({
  rosterReplaceEnabled: envBoolean.default(false),
});

export const agencyConfigSchema = z.object({
  agency: agencySchema.default({}),
});

export function readAgencyEnv(env: Env): Record<string, unknown> {
  return {
    agency: {
      rosterReplaceEnabled: env['AGENCY_ROSTER_REPLACE_ENABLED'],
    },
  };
}
