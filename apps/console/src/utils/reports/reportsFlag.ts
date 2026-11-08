import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';

/**
 * The reports flag (`docs/reports.md` RP10): `agency_reports_enabled`, default off,
 * client-exposed. Off, every report route answers `403 feature_disabled` and the
 * console shows no reports affordance. Typed against the contracts so a renamed or
 * withdrawn flag fails to compile. Its own module so a page can read it without
 * pulling in the auth context.
 */
export const REPORTS_FLAG: ClientExposedAgencyFlagKey = 'agency_reports_enabled';
