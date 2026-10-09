/**
 * The platform API wire shapes the console and the super-admin console consume:
 * identity and session, per-account settings, team and invites, notification
 * preferences, the feature-flag map, audit reads, and the super-admin surface.
 * Re-exported from the package root as the `PlatformApi` namespace; also
 * importable per file, e.g. `@magick-agency/contracts/api/platform/super-admin`.
 */

export * from './auth';
export * from './settings';
export * from './team';
export * from './invite';
export * from './notifications';
export * from './feature-flags';
export * from './audit';
export * from './super-admin';
export * from './super-admin-usage';

// `auth.ts` (the console `types/auth.ts`) and `team.ts` (the console `types/team.ts`) both
// declare `TenantMember`; the console's team page uses the `team.ts` one, which adds
// `invite_state`. The explicit re-export wins over both `export *` lines.
export type { TenantMember } from './team';
