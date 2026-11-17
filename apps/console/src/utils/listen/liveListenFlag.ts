import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';

/**
 * Live call listening's flag (`docs/listening.md`, LS1): `agency_live_listen_enabled`, default
 * off, client-exposed. It is the consent gate: while it is off the account offers no Live calls
 * page, no Live view on a campaign's Calls tab, no listening bar and no standing line on the
 * agent's station. Its own module, as the soft phone's, inbound's and reports' flags are, so the
 * pure navigation tables (`consoleNav.ts`, `agencyCampaignTabs.ts`) can read it.
 */
export const LIVE_LISTEN_FLAG = 'agency_live_listen_enabled' satisfies ClientExposedAgencyFlagKey;

/**
 * Whether calls that are not recorded may be listened to (LS4; default on, a narrowing of
 * `agency_live_listen_enabled`). Client-exposed since LS20 for the account's Settings line only:
 * the server still computes each row's `listenable` and refuses the grant itself.
 */
export const LIVE_LISTEN_UNRECORDED_FLAG = 'agency_live_listen_unrecorded' satisfies ClientExposedAgencyFlagKey;
