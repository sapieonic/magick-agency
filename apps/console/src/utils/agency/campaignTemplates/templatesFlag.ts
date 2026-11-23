import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';

/**
 * Campaign templates' flag (`docs/campaign-templates.md`, CT17): `agency_campaign_templates_enabled`,
 * default off, client-exposed. Off, every template surface is hidden, New campaign starts as before
 * and the soft phone's outcomes read as they always did. Its own module, as the other flags are,
 * so the pure navigation tables can read it.
 */
export const CAMPAIGN_TEMPLATES_FLAG = 'agency_campaign_templates_enabled' satisfies ClientExposedAgencyFlagKey;
