/**
 * The console-facing agency HTTP/WS wire shapes (ported from cusui), as one
 * module. Re-exported from the package root as the `AgencyApi` namespace; also
 * importable per file, e.g. `@magick-agency/contracts/api/agency/agency-stats`.
 *
 * These are what the merged server must RETURN to the console — not the same as
 * the core contract at the package root (`../../agency`), even where a name is
 * shared. `./CONTRACT-DIFF.md` lists every difference.
 */

export * from './agency';
export * from './agency-campaign';
export * from './agency-spine';
export * from './agency-stats';
export * from './agency-activity';
export * from './agency-campaign-series';
export * from './dnc';
export * from './call-analysis-profile';
export * from './webrtc-call';
export * from './attempt-call';
export * from './shared';

// Declared identically in cusui's `agency.ts` and `agency-campaign.ts`; the
// explicit re-export picks one so the two `export *` lines do not conflict.
export type { AgencyCampaignStatus } from './agency';
