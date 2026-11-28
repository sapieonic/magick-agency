import { describe, expect, it } from 'vitest';
import { AGENCY_FLAGS, AGENCY_FLAG_KEYS, type AgencyClientFlagMap } from '../src/flags';

/** The expected flag definitions. */
const EXPECTED = {
  agency_dialer_enabled: { default: false, envVar: 'FF_AGENCY_DIALER', clientExposed: true },
  agency_late_binding: { default: false, envVar: 'FF_AGENCY_LATE_BINDING', clientExposed: undefined },
  agency_call_analysis: { default: false, envVar: 'FF_AGENCY_CALL_ANALYSIS', clientExposed: true },
  agency_softphone_enabled: { default: false, envVar: 'FF_AGENCY_SOFTPHONE', clientExposed: true },
  // Default on: the way back to pcm16, not a capability (see flags.ts).
  agency_console_alaw8: { default: true, envVar: 'FF_AGENCY_CONSOLE_ALAW8', clientExposed: true },
  agency_contact_assignment_enabled: { default: false, envVar: 'FF_AGENCY_CONTACT_ASSIGNMENT', clientExposed: true },
  agency_reports_enabled: { default: false, envVar: 'FF_AGENCY_REPORTS', clientExposed: true },
  agency_inbound_enabled: { default: false, envVar: 'FF_AGENCY_INBOUND', clientExposed: true },
  // Not client-exposed: the app reads `account_allows_ring` from its push device's status.
  agency_inbound_ring_enabled: { default: false, envVar: 'FF_AGENCY_INBOUND_RING', clientExposed: undefined },
  // Live call listening (LS1): the consent gate, off until a tenant turns it on.
  agency_live_listen_enabled: { default: false, envVar: 'FF_AGENCY_LIVE_LISTEN', clientExposed: true },
  // On by default: a narrowing of listening (recorded calls only when off), not a capability (LS4).
  // Client-exposed since LS20: the account's Settings says whether unrecorded calls are included.
  agency_live_listen_unrecorded: { default: true, envVar: 'FF_AGENCY_LIVE_LISTEN_UNRECORDED', clientExposed: true },
  // Floor assist (LF11): off until a super admin turns it on; the console and the app read it.
  agency_floor_assist_enabled: { default: false, envVar: 'FF_AGENCY_FLOOR_ASSIST', clientExposed: true },
  // Compare agents: off until a super admin turns it on; the console shows the tab from it.
  agency_compare_enabled: { default: false, envVar: 'FF_AGENCY_COMPARE', clientExposed: true },
  // Team performance (TP6): off until a super admin turns it on; the console shows the tab from it.
  agency_team_performance_enabled: { default: false, envVar: 'FF_AGENCY_TEAM_PERFORMANCE', clientExposed: true },
  // Campaign templates (CT17): off until a super admin turns it on for a tenant; global and tenant
  // only, because organisation templates are shared by every account of the tenant.
  agency_campaign_templates_enabled: {
    default: false, envVar: 'FF_AGENCY_CAMPAIGN_TEMPLATES', clientExposed: true, scopes: ['global', 'tenant'],
  },
} as const;

const TRI_SCOPED = ['global', 'tenant', 'account'] as const;

describe('agency flags', () => {
  it('are exactly the fifteen keys', () => {
    expect(Object.keys(AGENCY_FLAGS).sort()).toEqual([...AGENCY_FLAG_KEYS].sort());
    expect(AGENCY_FLAG_KEYS).toHaveLength(15);
  });

  it.each(AGENCY_FLAG_KEYS)('%s keeps its key, type, default, scopes, envVar and exposure', (key) => {
    const def = AGENCY_FLAGS[key];
    expect(def.key).toBe(key);
    expect(def.type).toBe('boolean');
    expect(def.default).toBe(EXPECTED[key].default);
    const expected = EXPECTED[key];
    expect(def.scopes).toEqual([...('scopes' in expected ? expected.scopes : TRI_SCOPED)]);
    expect(def.envVar).toBe(EXPECTED[key].envVar);
    expect((def as { clientExposed?: boolean }).clientExposed).toBe(EXPECTED[key].clientExposed);
    expect(def.owner).toBe('voice');
  });

  it('keeps late binding off the client', () => {
    const map: AgencyClientFlagMap = {
      agency_dialer_enabled: true,
      agency_call_analysis: false,
      agency_softphone_enabled: false,
      agency_console_alaw8: true,
      agency_contact_assignment_enabled: false,
      agency_reports_enabled: false,
      agency_inbound_enabled: false,
      agency_live_listen_enabled: false,
      agency_live_listen_unrecorded: true,
      agency_floor_assist_enabled: false,
      agency_compare_enabled: false,
      agency_team_performance_enabled: false,
      agency_campaign_templates_enabled: false,
    };
    expect(Object.keys(map)).not.toContain('agency_late_binding');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(AGENCY_FLAGS)).toBe(true);
  });

  it('declares a handling policy only on boolean flags; the consent gate is never bulk and needs a reason', () => {
    const withPolicy = Object.values(AGENCY_FLAGS).filter((f) => 'policy' in f);
    expect(withPolicy.map((f) => f.key)).toEqual(['agency_live_listen_enabled']);
    for (const f of withPolicy) expect(f.type).toBe('boolean');
    expect(AGENCY_FLAGS.agency_live_listen_enabled.policy).toMatchObject({ bulk_allowed: false, reason_required_to_enable: true });
    expect(AGENCY_FLAGS.agency_live_listen_enabled.policy.warning).toMatch(/monitored/);
  });
});
