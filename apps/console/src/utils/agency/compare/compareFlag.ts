import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';

/**
 * Compare agents' flag (`docs/compare-agents.md` §8): `agency_compare_enabled`, default off,
 * client-exposed. Off, every compare route answers `403 feature_disabled` and the console offers
 * no Compare agents tab. Its own module, as the other flags are, so the pure navigation tables
 * (`consoleNav.ts`) can read it without pulling in a context.
 */
export const COMPARE_FLAG = 'agency_compare_enabled' satisfies ClientExposedAgencyFlagKey;

/** The page's path, under the Reports section (B28). */
export const COMPARE_PATH = '/agency/compare';
