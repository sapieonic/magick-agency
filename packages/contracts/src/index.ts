/**
 * @magick-agency/contracts — the wire contract shared by the server and both UIs.
 *
 * ── Export convention ───────────────────────────────────────────────────────
 * The package is consumed as TypeScript source (no build step): the server is
 * bundled by esbuild, the console and super-admin by Vite. Nothing here may use
 * a Node-only or DOM-only API.
 *
 * ROOT (flat): the domain contract and the single sources of truth —
 *   - `./agency`  the dialer runtime's frozen agency contract (frames, payloads, unions);
 *   - `./errors`  every agency error vocabulary as union + `as const` list;
 *   - `./rbac`    roles, permissions, the permission matrix, `hasPermission`;
 *   - `./flags`   the three agency feature flags.
 *
 * NAMESPACED: the HTTP API layers, because they reuse names the root already
 * exports with a DIFFERENT shape (the console's `AgencyCampaignStats` is the public API layer's
 * enriched payload, not the dialer runtime's):
 *   - `AgencyApi`    console agency surfaces (`./api/agency/*`);
 *   - `PlatformApi`  auth/session, settings, team, invites, notifications, audit,
 *                    flags map, super-admin (`./api/platform/*`).
 *
 *     import { AgencyApi, hasPermission } from '@magick-agency/contracts';
 *     type Stats = AgencyApi.AgencyCampaignStats;
 *
 * SUBPATH: every file is also importable directly through the package's
 * `"./*": "./src/*.ts"` export, which is the form to prefer when a module needs
 * only one file and a flat name:
 *
 *     import type { AgencyRosterPage } from '@magick-agency/contracts/api/agency/agency-stats';
 *     import type { SessionResponse } from '@magick-agency/contracts/api/platform/auth';
 *
 * A name exported from the root must never be re-exported flat from an API file
 * into the root; that is what the namespaces are for.
 */

export * from './agency';
export * from './errors';
export * from './rbac';
export * from './flags';

export * as AgencyApi from './api/agency/index';
export * as PlatformApi from './api/platform/index';
