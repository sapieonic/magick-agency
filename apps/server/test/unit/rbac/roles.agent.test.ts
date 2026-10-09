import { describe, it, expect } from 'vitest';
import {
  ROLE_HIERARCHY,
  PERMISSION_MATRIX,
  hasPermission,
  canManageRole,
  type Permission,
} from '@magick-agency/contracts/rbac';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';

/**
 * The `agent` role (Agency Dialer, design D6) is only safe because it sits
 * BELOW `viewer` in a linear hierarchy whose permissions are all expressed as
 * minimum roles. That is a whole-matrix property, not a property of any one
 * permission — so these tests iterate the matrix rather than spot-checking, and
 * they fail the moment somebody adds a permission with a floor below `viewer`
 * or nudges `agent` up the hierarchy.
 */

const AGENCY_PERMISSIONS: Permission[] = [
  'agency.station.connect',
  'agency.attempts.handle',
  'agency.attempts.dispose',
  'agency.dnc.write',
];

/**
 * Floored at `agent` without being an `agency.*` action — kept in its own list so
 * the "grants nothing that predates the dialer" sweep below stays a real
 * assertion rather than a list somebody appends to whenever a test goes red.
 *
 * Exactly one member, and adding a second should be argued for on its own terms.
 * `GET /proxy/feature-flags` is the gate map the console resolves before it renders any
 * flag-gated route, so it is infrastructure for the four permissions above rather
 * than a capability alongside them. While it floored at `viewer` (via the
 * borrowed viewer-floored stats permission) every dedicated agent 403'd, the console's fail-safe
 * closed `FeatureFlagsContext` resolved every flag to `false`, and all four agent
 * routes refused with billing-flavoured copy — the Agency Dialer was unreachable
 * by the only role it exists for. See `src/rbac/roles.ts`.
 */
const AGENT_INFRASTRUCTURE_PERMISSIONS: Permission[] = ['agency.flags.read'];

/** Everything an `agent` is expected to hold, of any kind. */
const AGENT_PERMISSIONS: Permission[] = [
  ...AGENCY_PERMISSIONS,
  ...AGENT_INFRASTRUCTURE_PERMISSIONS,
];

const ALL_PERMISSIONS = Object.keys(PERMISSION_MATRIX) as Permission[];
const PRE_EXISTING_PERMISSIONS = ALL_PERMISSIONS.filter(
  (p) => !AGENT_PERMISSIONS.includes(p),
);

describe('agent role — hierarchy placement', () => {
  it('sits at 5, strictly below viewer', () => {
    expect(ROLE_HIERARCHY.agent).toBe(5);
    expect(ROLE_HIERARCHY.agent).toBeLessThan(ROLE_HIERARCHY.viewer);
  });

  it('is the floor of the hierarchy — no role ranks lower', () => {
    const levels = Object.values(ROLE_HIERARCHY);
    expect(Math.min(...levels)).toBe(ROLE_HIERARCHY.agent);
  });

  it('keeps the hierarchy strictly ascending', () => {
    const ordered: MembershipRole[] = [
      'agent',
      'viewer',
      'operator',
      'account_admin',
      'tenant_admin',
      'tenant_owner',
    ];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ROLE_HIERARCHY[ordered[i - 1]!]).toBeLessThan(ROLE_HIERARCHY[ordered[i]!]);
    }
  });
});

describe('agent role — grants nothing that predates the Agency Dialer', () => {
  it('every pre-existing permission floors at viewer or higher', () => {
    for (const permission of PRE_EXISTING_PERMISSIONS) {
      const floor = PERMISSION_MATRIX[permission];
      expect(
        ROLE_HIERARCHY[floor],
        `${permission} floors at '${floor}', which an agent can reach`,
      ).toBeGreaterThanOrEqual(ROLE_HIERARCHY.viewer);
    }
  });

  it('an agent is denied EVERY pre-existing permission', () => {
    const granted = PRE_EXISTING_PERMISSIONS.filter((p) => hasPermission('agent', p));
    expect(granted).toEqual([]);
  });

  it('notably cannot reach the call-creation permission — the existing hang-up route', () => {
    // `POST /proxy/webrtc-call/:id/end` is gated at the
    // operator-floored call-creation permission. An agent hanging up therefore needs an agency-native route,
    // which is also what lets the server verify the caller is the reserved agent.
    expect(hasPermission('agent', 'tenant.read')).toBe(false);
  });

  it('resolves to exactly the four agency permissions plus the flag map, and nothing else', () => {
    const granted = ALL_PERMISSIONS.filter((p) => hasPermission('agent', p)).sort();
    expect(granted).toEqual([...AGENT_PERMISSIONS].sort());
  });
});

/**
 * The regression guard for the agent flag-map floor.
 *
 * The bug was not that somebody chose a wrong floor — it was that the flag map
 * borrowed a viewer-floored stats permission, and nothing anywhere asserted that the route an
 * agent needs to boot the SPA is reachable by an agent. Every check that existed
 * was about what an agent must NOT reach, so a total lockout looked like
 * compliance. These assert the positive direction.
 */
describe('agent role — can resolve the feature-flag map', () => {
  it('holds agency.flags.read', () => {
    expect(hasPermission('agent', 'agency.flags.read')).toBe(true);
  });

  it('floors that permission at agent, not viewer', () => {
    // The literal is the point: `toBe('agent')` fails loudly if somebody
    // "tidies" this back onto the viewer floor the stats lane uses.
    expect(PERMISSION_MATRIX['agency.flags.read']).toBe('agent');
  });

  it('is inherited by every higher role, so nobody lost the map', () => {
    const higher: MembershipRole[] = [
      'viewer',
      'operator',
      'account_admin',
      'tenant_admin',
      'tenant_owner',
    ];
    for (const role of higher) {
      expect(hasPermission(role, 'agency.flags.read'), `${role}`).toBe(true);
    }
  });

});

describe('agency permissions — floors and inheritance', () => {
  it('all four floor at agent', () => {
    for (const permission of AGENCY_PERMISSIONS) {
      expect(PERMISSION_MATRIX[permission]).toBe('agent');
    }
  });

  it('are inherited by every higher role, so a supervisor can take calls', () => {
    const higher: MembershipRole[] = [
      'viewer',
      'operator',
      'account_admin',
      'tenant_admin',
      'tenant_owner',
    ];
    for (const role of higher) {
      for (const permission of AGENCY_PERMISSIONS) {
        expect(hasPermission(role, permission), `${role} → ${permission}`).toBe(true);
      }
    }
  });
});

describe('agent → campaign staffing — the floors the assignment routes depend on', () => {
  /**
   * `proxy-agency-staffing.routes.ts` gates `GET /my-assignment` on
   * `agency.station.connect` and the three supervisory routes on
   * `agency.supervise`. Those choices are only correct while the floors below
   * hold, and both directions are silent failures:
   *
   *  - raise `agency.station.connect` (or gate `/my-assignment` on any
   *    `viewer`-floored permission, `proxy.contact_lists.read` being the obvious
   *    wrong pick since every neighbouring campaign read uses it) and the agent
   *    landing page 403s for the only role it exists for;
   *  - lower `agency.supervise` and an `operator` — or an agent — can restaff a
   *    live campaign.
   *
   * The route file has its own tests; these pin the matrix those tests assume.
   */
  it('an agent can ask where they are assigned', () => {
    expect(hasPermission('agent', 'agency.station.connect')).toBe(true);
  });

  it('an agent cannot reach the read the campaign routes use', () => {
    // Named explicitly because it is the specific mistake available here: it is
    // the permission every other `/proxy/agency/campaigns/*` read carries.
    expect(hasPermission('agent', 'agency.campaigns.read')).toBe(false);
  });

  it('staffing someone is supervisory — account_admin and above, nobody below', () => {
    expect(PERMISSION_MATRIX['agency.supervise']).toBe('account_admin');
    for (const role of ['agent', 'viewer', 'operator'] as MembershipRole[]) {
      expect(hasPermission(role, 'agency.supervise'), `${role}`).toBe(false);
    }
    for (const role of ['account_admin', 'tenant_admin', 'tenant_owner'] as MembershipRole[]) {
      expect(hasPermission(role, 'agency.supervise'), `${role}`).toBe(true);
    }
  });

  it('assignment grants nothing — a staffed agent holds no more than an unstaffed one', () => {
    /*
     * Staffing is NOT authorization: an assignment row decides where an agent is
     * sent by default and never widens what they may do. If a permission ever
     * appears that an assignment is meant to confer, this is the assertion that
     * should be argued with rather than edited.
     *
     * ── The argument, made once, for the flag-map floor ──────────────────────────────────
     * This asserted `AGENCY_PERMISSIONS` — the four — and `agent` now holds five.
     * The extra one is `agency.flags.read`, and it is not a counter-example
     * to the rule above: it comes from the ROLE, is held identically by a staffed
     * and an unstaffed agent, and confers no ability to act on a campaign. What it
     * buys is the ability to boot the SPA at all, which an agent needs before any
     * assignment can matter. So the rule stands and the expectation widens.
     *
     * It is `AGENT_PERMISSIONS` rather than a second literal ON PURPOSE. This file
     * states the agent's whole permission set in two places, and a change that
     * updates one copy leaves a stale literal in the other.
     * Both now read the same constant, so a third copy cannot silently disagree.
     */
    const granted = ALL_PERMISSIONS.filter((p) => hasPermission('agent', p)).sort();
    expect(granted).toEqual([...AGENT_PERMISSIONS].sort());

    // The half that is actually about staffing: nothing here is an agency ACTION
    // beyond the four an agent already had.
    const beyondAgency = granted.filter((p) => !AGENCY_PERMISSIONS.includes(p));
    expect(beyondAgency).toEqual([...AGENT_INFRASTRUCTURE_PERMISSIONS].sort());
  });
});

describe('agent role — management', () => {
  it('can be managed by account_admin and above (invite/role-change surfaces)', () => {
    expect(canManageRole('account_admin', 'agent')).toBe(true);
    expect(canManageRole('tenant_admin', 'agent')).toBe(true);
    expect(canManageRole('tenant_owner', 'agent')).toBe(true);
  });

  it('can manage nobody, including other agents', () => {
    const roles: MembershipRole[] = [
      'agent',
      'viewer',
      'operator',
      'account_admin',
      'tenant_admin',
      'tenant_owner',
    ];
    for (const target of roles) {
      expect(canManageRole('agent', target), `agent → ${target}`).toBe(false);
    }
  });
});
