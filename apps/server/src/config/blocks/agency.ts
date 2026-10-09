import { z } from 'zod';
import { envBoolean, type Env } from '../env.js';

/**
 * Owned by lane B. Add this lane's top-level config keys here and nowhere
 * else, so parallel lanes never edit the same config file. Keep core's /
 * master's key names where the ported code reads them.
 */

/**
 * master `src/config/schema.ts:537-576`@a1f0756a (`agencySchema`), the half agency keeps.
 *
 * `rosterReplaceEnabled` (`AGENCY_ROSTER_REPLACE_ENABLED`) gates the two DESTRUCTIVE roster
 * paths — `mode: 'replace'` on an ingest, and the roster-clear endpoint. **Defaults OFF**
 * (master's reason, kept): every replace fails at the in-process supersede (decision B15:
 * there is no supersede primitive), so a surface that is visible and always fails is a
 * support ticket per operator, while a surface that is not registered is a feature that has
 * not shipped. Enable it only once a real supersede exists.
 *
 * PORT NOTE (magick-agency, Phase 8): master's `creditsLowConnectsThreshold` is not carried —
 * the `credits_low` stall arm it fed is removed with credits (plan §3.3).
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
