import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';

/**
 * Floor assist's flag (LF11): `agency_floor_assist_enabled`, off by default, client-exposed. It
 * gates Need help and supervisors' messages; the console shows their controls from it. Checked
 * against the contracts (`satisfies`) so a renamed or withdrawn flag fails to compile. Its own
 * module, as the soft phone's and the inbound flags are, so pure tables can read it.
 */
export const FLOOR_ASSIST_FLAG = 'agency_floor_assist_enabled' satisfies ClientExposedAgencyFlagKey;
