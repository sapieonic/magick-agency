import { describe, it, expect } from 'vitest';
import { hasPermission, type Permission } from '../../utils/permissions';
import type { Role } from '../../types/auth';

/**
 * PORT NOTE (magick-agency): the console no longer HAS a mirror — `hasPermission`
 * is the contract's (`@magick-agency/contracts/rbac`), the one matrix the server
 * enforces with. The floors below still pin it against master's, transcribed,
 * which is now a check that the contract kept master's floors. Master's
 * `proxy.feature_flags.read` is the contract's `agency.flags.read` (same floor).
 *
 * cusui's `Permission` mirror, pinned against master's `PERMISSION_MATRIX`.
 *
 * The union's own comment claims a 1:1 correspondence with master's `roles.ts`,
 * and that claim was **false**: `agency.dnc.read` and `agency.dnc.manage` were
 * absent, which is precisely why no component could reference the DNC routes
 * even by accident (`MAG-116`). A comment asserting a correspondence that
 * nothing checks is how it drifted in the first place.
 *
 * ── Why the expected floors are literals rather than imported ────────────────
 * They cannot be imported. Master is a separate repository and is not a
 * dependency of this one; in CI only cusui is checked out. So this pins the
 * mirror against a transcribed copy, and the transcription is the thing a
 * reviewer must check against
 * `magick-master/src/rbac/roles.ts` → `PERMISSION_MATRIX`.
 *
 * That is a weaker guarantee than a shared module and it is stated plainly
 * rather than dressed up: this test catches cusui drifting from the values
 * below, not the two repositories drifting from each other. What it does buy is
 * that a silent deletion — the actual failure mode here — now fails loudly.
 */

/** Transcribed from master `src/rbac/roles.ts`. Seven agency permissions. */
const MASTER_AGENCY_FLOORS: Record<string, Role> = {
  'agency.station.connect': 'agent',
  'agency.attempts.handle': 'agent',
  'agency.attempts.dispose': 'agent',
  'agency.dnc.write': 'agent',
  'agency.supervise': 'account_admin',
  'agency.dnc.read': 'viewer',
  'agency.dnc.manage': 'account_admin',
  /**
   * Not an `agency.*` key, and included here anyway because it is now an agency
   * gate: `GET /proxy/agency/campaigns/:id/activity` and its CSV export carry
   * `audit.read` (MAG-158). MAG-157 settled the choice by DROPPING this floor
   * from `tenant_admin` to `account_admin` — the same floor as
   * `agency.supervise` — so the supervisor who controls a campaign can read its
   * trail, rather than minting a second permission that would then have to be
   * kept aligned with the first.
   *
   * That makes the floor load-bearing in a way it was not before: raised back to
   * `tenant_admin`, the route would be correct and unreachable by the role it
   * was built for, and the Activity link would simply stop rendering for the
   * person it is for.
   */
  'audit.read': 'account_admin',
  /**
   * Also not an `agency.*` key, and included for a sharper reason than
   * `audit.read` above: this is the permission whose floor decides whether the
   * Agency Dialer exists at all for the role it was built for.
   *
   * `GET /proxy/feature-flags` carried `proxy.stats.read` (floor `viewer`) until
   * MAG-181. An `agent` is level 5, so every dedicated agent 403'd on the flag
   * map — and `FeatureFlagsContext` is fail-safe closed, so that error resolved
   * every flag to `false` and `RequireFlag flag="agency_dialer_enabled"` refused
   * `/dialer`, `/station`, `/dialer/performance` and `/dialer/attempts` alike,
   * under `CapabilityUnavailable`'s billing-shaped copy. Nothing was red: the
   * agent-role tests all asserted what an agent must NOT reach, so a total
   * lockout looked like compliance.
   *
   * Raised back to `viewer` on either side, that returns exactly. Pinned here
   * because the floor is the whole fix.
   */
  'agency.flags.read': 'agent',
};

/** Ascending, so "the floor and everything above it" is a slice. */
const ROLES: Role[] = ['agent', 'viewer', 'operator', 'account_admin', 'tenant_admin', 'tenant_owner'];

describe('agency permission mirror', () => {
  it('carries every agency permission master defines', () => {
    // Sorted so the failure message names the missing key rather than showing
    // two unordered lists to diff by eye.
    const expected = Object.keys(MASTER_AGENCY_FLOORS).sort();
    const actual = expected.filter((key) => {
      // A permission absent from the union is a TYPE error at the call site, so
      // presence is probed behaviourally: an unknown key resolves to no role
      // being able to hold it.
      return ROLES.some((role) => hasPermission(role, key as Permission));
    });

    expect(actual).toEqual(expected);
  });

  it.each(Object.entries(MASTER_AGENCY_FLOORS))(
    '%s floors at %s — admitted at and above, refused below',
    (permission, floor) => {
      const floorIndex = ROLES.indexOf(floor);

      for (const [index, role] of ROLES.entries()) {
        const admitted = hasPermission(role, permission as Permission);
        // `toBe(index >= floorIndex)` alone would report "expected false to be
        // true" with no clue which role. The message carries the pair.
        expect(admitted, `${role} on ${permission}`).toBe(index >= floorIndex);
      }
    },
  );

  it('refuses an unknown role outright', () => {
    expect(hasPermission(undefined, 'agency.dnc.read')).toBe(false);
  });

  /**
   * The four `agent`-floored agency permissions, plus the flag map, are the whole
   * of an agent's reach — by design (D6) for the four, and by MAG-181 for the
   * fifth. An `agent` sits at level 5, below `viewer`, so a permission
   * accidentally floored at `agent` grants it to everyone — the opposite of the
   * intended restriction, and invisible unless counted.
   *
   * The list is spelled out rather than derived from `MASTER_AGENCY_FLOORS` so a
   * transcription error in the map above cannot make this assertion agree with
   * it. Adding a sixth entry should be argued for, not typed to make a test pass.
   */
  it('grants an agent exactly the four agency permissions plus the flag map, and no more', () => {
    const agentReachable = Object.keys(MASTER_AGENCY_FLOORS).filter((key) =>
      hasPermission('agent', key as Permission),
    );

    expect(agentReachable.sort()).toEqual([
      'agency.attempts.dispose',
      'agency.attempts.handle',
      'agency.dnc.write',
      // PORT NOTE (magick-agency): renamed from `proxy.feature_flags.read`, so it
      // sorts here rather than last.
      'agency.flags.read',
      'agency.station.connect',
    ]);
  });

  /**
   * The positive direction, which is what was missing when this shipped broken:
   * every assertion in this file was about what an agent must NOT reach, so an
   * agent who could reach nothing at all read as a pass.
   */
  it('lets an agent resolve the flag map, without the stats lane it borrowed', () => {
    expect(hasPermission('agent', 'agency.flags.read')).toBe(true);
    // PORT NOTE (magick-agency): `proxy.stats.read` does not exist in agency; the
    // viewer-floored statistics read is `agency.campaigns.read`.
    expect(hasPermission('agent', 'agency.campaigns.read')).toBe(false);
  });
});
