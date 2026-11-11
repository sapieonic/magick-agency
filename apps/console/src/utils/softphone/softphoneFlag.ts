import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';

/**
 * The soft phone's flag (`docs/softphone.md`, SP4): `agency_softphone_enabled`, default off,
 * client-exposed. Checked against the contracts (`satisfies`, keeping the literal type the
 * analytics gate ids need) so a renamed or withdrawn flag fails to compile.
 * Its own module, as the inbound and reports flags are, so the pure navigation tables
 * (`consoleNav.ts`, `agencyCampaignTabs.ts`) can read it without a hook module.
 */
export const SOFTPHONE_FLAG = 'agency_softphone_enabled' satisfies ClientExposedAgencyFlagKey;
