import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';

/**
 * Team performance's flag (`docs/team-performance.md` TP6): `agency_team_performance_enabled`,
 * default off, client-exposed. Off, the route answers `403 feature_disabled` and the console
 * offers no Team performance tab. Its own module, as Compare's is, so the pure navigation tables
 * (`consoleNav.ts`) can read it without pulling in a context.
 */
export const TEAM_PERFORMANCE_FLAG = 'agency_team_performance_enabled' satisfies ClientExposedAgencyFlagKey;

/**
 * The page's path, Reports' first tab (TP1). Not under `/agency/reports`: `reports/:runId` owns
 * that space.
 */
export const TEAM_PERFORMANCE_PATH = '/agency/team-performance';
