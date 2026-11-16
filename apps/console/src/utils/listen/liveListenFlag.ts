import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';

/**
 * Live call listening's flag (`docs/listening.md`, LS1): `agency_live_listen_enabled`, default
 * off, client-exposed. It is the consent gate: while it is off the account offers no Live calls
 * page, no Live view on a campaign's Calls tab, no listening bar and no standing line on the
 * agent's station. Its own module, as the soft phone's, inbound's and reports' flags are, so the
 * pure navigation tables (`consoleNav.ts`, `agencyCampaignTabs.ts`) can read it.
 */
export const LIVE_LISTEN_FLAG = 'agency_live_listen_enabled' satisfies ClientExposedAgencyFlagKey;
