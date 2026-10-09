import { describe, it, expect } from 'vitest';
import {
  agencyPersona,
  agencyPersonaLabel,
  isAgencyAgent,
  isAgencySupervisor,
  isDedicatedAgent,
} from '../../utils/agencyPersona';
import { PERMISSION_MIN_ROLE } from '../../utils/permissions';
import type { Role } from '../../types/auth';

/**
 * Who someone is in the Agency Dialer.
 *
 * ── Why the mapping is asserted per role AND against the floors ────────────
 * The whole point of `agencyPersona` is that it DERIVES the split from the two
 * permissions that already define it, rather than restating the role hierarchy a
 * third time. So the per-role cases below pin the answers a reader expects, and
 * the floor assertions pin the reason those answers hold — because a per-role
 * table alone would keep passing after `agency.supervise`'s floor moved, silently
 * describing a mapping the product no longer has.
 */

const ALL_ROLES: Role[] = [
  'agent',
  'viewer',
  'operator',
  'account_admin',
  'tenant_admin',
  'tenant_owner',
];

describe('agencyPersona', () => {
  it.each(['account_admin', 'tenant_admin', 'tenant_owner'] as const)(
    '%s is a supervisor',
    (role) => {
      expect(agencyPersona(role)).toBe('supervisor');
    },
  );

  it.each(['agent', 'operator', 'viewer'] as const)('%s is an agent', (role) => {
    expect(agencyPersona(role)).toBe('agent');
  });

  /**
   * ── The case that was wrong before this function existed ──────────────────
   * Agency surfaces asked `role === 'agent'`, which made an `operator` a
   * supervisor by omission — and an operator holds no supervisory permission at
   * all, so they were sent to campaign-setup screens whose every control 403s.
   */
  it('does not treat an operator as a supervisor', () => {
    expect(agencyPersona('operator')).not.toBe('supervisor');
    expect(isAgencySupervisor('operator')).toBe(false);
    expect(isAgencyAgent('operator')).toBe(true);
  });

  /**
   * Supervisor is tested first, and the order is load-bearing: `agency.supervise`
   * floors above `agency.station.connect`, so every supervisor also HOLDS the agent
   * permissions and would match both arms. A supervisor covering a shift genuinely
   * can take calls — that inheritance is deliberate — but they must not LAND on the
   * agent home, where they would read "nobody has assigned you a campaign".
   */
  it('resolves a supervisor to supervisor even though they hold the agent permissions', () => {
    expect(agencyPersona('account_admin')).toBe('supervisor');
    expect(isAgencyAgent('account_admin')).toBe(false);
  });

  it('is null for an unresolved role, so callers can wait rather than guess', () => {
    // `role` is undefined for the moment `TenantContext` takes to resolve a
    // membership. Redirecting on that would navigate twice and flash a 403.
    expect(agencyPersona(undefined)).toBeNull();
  });

  it('is null for a role this mirror has never heard of', () => {
    // A role added in the API before it is mirrored here scores 0 in
    // `hasPermission`, so it reaches neither arm — which is the safe direction:
    // no persona means no landing decision, rather than a guessed one.
    expect(agencyPersona('galactic_overlord' as Role)).toBeNull();
  });

  it('gives every known role exactly one persona', () => {
    // No role may fall through: a role with no persona has no agency landing page
    // at all, and the symptom would be a spinner rather than an error.
    for (const role of ALL_ROLES) {
      expect(agencyPersona(role)).not.toBeNull();
    }
  });

  it('derives from the two floors, so a floor change moves the personas with it', () => {
    // The reason the per-role cases above hold. If either floor moves, this fails
    // and whoever moved it is told the personas moved too.
    expect(PERMISSION_MIN_ROLE['agency.supervise']).toBe('account_admin');
    expect(PERMISSION_MIN_ROLE['agency.station.connect']).toBe('agent');
  });
});

describe('agencyPersonaLabel', () => {
  it('names the two personas in the product’s voice', () => {
    expect(agencyPersonaLabel('tenant_owner')).toBe('Supervisor');
    expect(agencyPersonaLabel('operator')).toBe('Agent');
  });

  it('is null where there is no persona, so callers render nothing', () => {
    // Rather than a misleading default. A caller falls back to the platform role
    // label, which is the honest thing to show for a role we cannot place.
    expect(agencyPersonaLabel(undefined)).toBeNull();
    expect(agencyPersonaLabel('galactic_overlord' as Role)).toBeNull();
  });
});

describe('isDedicatedAgent — the predicate that may take navigation away', () => {
  /**
   * ── Why this is separate from `agencyPersona`, in one file ────────────────
   * A revision of `AgentLanding` used the persona to decide whether to redirect a
   * user out of `AppLayout`. Because the agent permissions floor at level 5, that
   * sent `viewer` and `operator` to `/dialer` as well — and with the `agency`
   * capability defaulting to off, both landed on a full-viewport capability screen
   * with no navigation and no sign-out, in every tenant without the dialer.
   *
   * These cases are the fence around that. `agencyPersona` answers "which agency
   * job"; this answers "is the dialer all they have". Only the second may evict
   * anybody.
   */
  it('is true for a dedicated agent — level 5 holds nothing else', () => {
    expect(isDedicatedAgent('agent')).toBe(true);
  });

  it.each(['viewer', 'operator'] as const)(
    'is FALSE for %s, even though their persona is agent',
    (role) => {
      // Both halves asserted together: this is exactly the pair the two
      // predicates must disagree about, and the disagreement is the fix.
      expect(agencyPersona(role)).toBe('agent');
      expect(isDedicatedAgent(role)).toBe(false);
    },
  );

  it.each(['account_admin', 'tenant_admin', 'tenant_owner'] as const)(
    'is false for %s',
    (role) => {
      expect(isDedicatedAgent(role)).toBe(false);
    },
  );

  it('is false for an unresolved role', () => {
    // Redirecting on an unresolved role would evict every user for one frame.
    expect(isDedicatedAgent(undefined)).toBe(false);
  });

  it('is false for a role this mirror has never heard of', () => {
    // An unknown role scores 0 in `hasPermission`, so it fails the station-permission
    // half. Failing CLOSED here is the safe direction: an unmirrored role keeps its
    // navigation rather than being evicted on a guess.
    expect(isDedicatedAgent('galactic_overlord' as Role)).toBe(false);
  });

  it('is expressed as the viewer floor, so a future sub-viewer role is handled', () => {
    /**
     * The property is "holds nothing that predates the dialer", and every such
     * permission floors at `viewer` (10) or above. Pinning the two floors here is
     * what makes the level comparison meaningful rather than incidental — if a
     * permission were ever floored below `viewer`, this predicate would start
     * evicting a role that has something to lose, and this case says so.
     */
    expect(PERMISSION_MIN_ROLE['agency.station.connect']).toBe('agent');
    // `tenant.read` — the team page's read — is agency's pre-dialer
    // viewer-floored permission.
    expect(PERMISSION_MIN_ROLE['tenant.read']).toBe('viewer');
    expect(PERMISSION_MIN_ROLE['account.read']).toBe('viewer');
  });
});
