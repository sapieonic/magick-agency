import { ROLE_HIERARCHY, PERMISSION_MATRIX, hasPermission, type Permission } from '@magick-agency/contracts/rbac';
import type { Role } from '../types/auth';

/**
 * PORT NOTE (magick-agency): cusui's `src/utils/permissions.ts` @ ee5beb44 was a
 * hand-maintained mirror of master's `ROLE_HIERARCHY` and `PERMISSION_MATRIX`,
 * and it had to be kept "in lockstep" with master (`docs/reference/magickvoice-platform/agency.md` §6.4) — the class
 * of bug where the UI shows a control the API 403s, or hides one it would allow.
 * Magick Agency has ONE matrix, `@magick-agency/contracts/rbac`, imported by the
 * server and by this console, so the mirror is gone and this module re-exports
 * it under the names the ported code imports.
 *
 * What changed for callers:
 *  - The permission SET is the contract's (extraction plan §3.1). Four of
 *    cusui's names are renamed to agency names with master's floors unchanged:
 *    `agency.campaigns.read|write` → `agency.campaigns.read|write`,
 *    `agency.analysis_profiles.read|write` → `agency.analysis_profiles.read|write`,
 *    `agency.flags.read` → `agency.flags.read`. Every AI, credits,
 *    API-key and tenant/account-admin permission is gone with its surface.
 *  - `hasPermission` is the contract's: it fails CLOSED on an `undefined` role,
 *    exactly as cusui's did (a console with no resolved membership shows nothing
 *    privileged).
 *
 * `agent` stays at 5, BELOW `viewer` — see `ROLE_HIERARCHY` in the contract.
 */
export { hasPermission };
export type { Permission };

/** cusui's name for the minimum-role table — the contract's `PERMISSION_MATRIX`. */
export const PERMISSION_MIN_ROLE = PERMISSION_MATRIX;

/** cusui's `getRoleLevel`, over the contract's hierarchy. */
export function getRoleLevel(role: Role): number {
  return ROLE_HIERARCHY[role] ?? 0;
}
