import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';

/**
 * Inbound calls' console flag (`docs/inbound.md` §8.1): `agency_inbound_enabled`, default off,
 * client-exposed. Off, every inbound route answers `403 inbound_disabled` and the console shows
 * no inbound affordance (the routes in Settings, Missed calls). Calls on linked numbers are
 * answered whatever it says. Typed against the contracts so a renamed or withdrawn flag fails to
 * compile; its own module, as the reports flag's, so the nav can read it without a hook module.
 */
export const INBOUND_FLAG: ClientExposedAgencyFlagKey = 'agency_inbound_enabled';
