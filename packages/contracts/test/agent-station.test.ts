import { describe, expect, it } from 'vitest';
import {
  AGENCY_ATTEMPT_CALLBACK_SOURCES,
  AGENCY_CONTEXT_FIELD_TYPES,
  AGENCY_CONTEXT_ROLES,
  AGENCY_FACT_FIELDS_MAX,
  AGENCY_FACT_KEY_MAX_CHARS,
  AGENCY_FACT_KEY_PATTERN,
  AGENCY_FACT_KEY_PATTERN_SOURCE,
  AGENCY_FACT_LABEL_MAX_CHARS,
  AGENCY_FACT_TILE_ROLES,
  AGENCY_PHONE_DISPLAYS,
  AGENCY_PHONE_DISPLAY_DEFAULT,
  AGENCY_SCRIPT_FIXED_PLACEHOLDERS,
  AGENCY_SCRIPT_OPENING_MAX_CHARS,
  AGENCY_SCRIPT_PLACEHOLDERS,
  AGENCY_SCRIPT_STEPS_MAX,
  AGENCY_SCRIPT_STEP_MAX_CHARS,
  AGENCY_TILE_ICONS,
  agencyTileIconOrNone,
  isAgencyTileIcon,
  type AgencyBreakReason,
  type AgencyContextDisplay,
  type AgencyDisposition,
  type AgencyFactField,
  type AgencyFactTile,
  type AgencyTileIcon,
} from '../src/agency';
import { AgencyApi } from '../src/index';
import type { Equals } from './type-equals';

/**
 * The agent station redesign's wire vocabularies and bounds (docs/agent-station.md, backend plan
 * §3 BE-1 to BE-13, AS9, AS16), as SNAPSHOTS written out by hand: the server's writes refuse by
 * them, the console and the app switch on them, and the Dart wire package mirrors them through
 * `fixtures/agent/literals.json`. A change here is a deliberate contract change.
 */
describe('agent station: tile icons (BE-13)', () => {
  it('lists the icons once, distinct, in the picker\'s order (SNAPSHOT)', () => {
    expect([...AGENCY_TILE_ICONS]).toEqual([
      'rupee', 'clock', 'calendar', 'stop', 'thumbs_up', 'thumbs_down', 'check', 'cross',
      'phone_missed', 'phone_busy', 'voicemail', 'wrong_number', 'language', 'question',
      'tea', 'lunch', 'washroom', 'meeting', 'training', 'prayer', 'headset', 'walk', 'person', 'dot',
    ]);
    expect(new Set(AGENCY_TILE_ICONS).size).toBe(AGENCY_TILE_ICONS.length);
  });

  it('is the type of the optional icon on an outcome and a break reason', () => {
    const onOutcome: Equals<NonNullable<AgencyDisposition['icon']>, AgencyTileIcon> = true;
    const onBreak: Equals<NonNullable<AgencyBreakReason['icon']>, AgencyTileIcon> = true;
    void [onOutcome, onBreak];
  });

  it('reads an unknown value as none, never as an error', () => {
    for (const icon of AGENCY_TILE_ICONS) {
      expect(isAgencyTileIcon(icon)).toBe(true);
      expect(agencyTileIconOrNone(icon)).toBe(icon);
    }
    for (const bad of ['sparkle', 'Rupee', '', ' rupee', null, undefined, 3, {}, ['rupee']]) {
      expect(isAgencyTileIcon(bad), String(bad)).toBe(false);
      expect(agencyTileIconOrNone(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('agent station: the panel, the bootstrap and the campaign', () => {
  it('declares the call-later sources, the fact roles and types, and the number display (SNAPSHOT)', () => {
    expect([...AGENCY_ATTEMPT_CALLBACK_SOURCES]).toEqual(['outcome', 'promise', 'inbound']);
    expect([...AGENCY_CONTEXT_ROLES]).toEqual(['name', 'place', 'amount_due', 'due_date']);
    expect([...AGENCY_CONTEXT_FIELD_TYPES]).toEqual(['text', 'money', 'date', 'number', 'phone', 'yes_no']);
    expect([...AGENCY_FACT_TILE_ROLES]).toEqual(['amount_due', 'due_date']);
    // Every tile role is a context role.
    for (const role of AGENCY_FACT_TILE_ROLES) expect(AGENCY_CONTEXT_ROLES).toContain(role);
    expect([...AGENCY_PHONE_DISPLAYS]).toEqual(['full', 'masked']);
    expect(AGENCY_PHONE_DISPLAY_DEFAULT).toBe('full');
  });

  it('bounds the script and names its placeholders (SNAPSHOT)', () => {
    expect([AGENCY_SCRIPT_STEPS_MAX, AGENCY_SCRIPT_STEP_MAX_CHARS, AGENCY_SCRIPT_OPENING_MAX_CHARS]).toEqual([12, 200, 300]);
    expect([...AGENCY_SCRIPT_PLACEHOLDERS]).toEqual(['name', 'place', 'amount_due', 'due_date', 'agent_name', 'campaign_name']);
    // The customer placeholders are exactly the context roles: the client fills them from `facts`.
    expect(AGENCY_SCRIPT_PLACEHOLDERS.filter((p) => (AGENCY_CONTEXT_ROLES as readonly string[]).includes(p))).toEqual([
      ...AGENCY_CONTEXT_ROLES,
    ]);
  });

  it('bounds the chosen facts and names the fixed placeholders (AS19, SNAPSHOT)', () => {
    expect([AGENCY_FACT_FIELDS_MAX, AGENCY_FACT_LABEL_MAX_CHARS, AGENCY_FACT_KEY_MAX_CHARS]).toEqual([4, 16, 32]);
    expect(AGENCY_FACT_KEY_PATTERN_SOURCE).toBe('^[a-z][a-z0-9_]*$');
    expect(AGENCY_FACT_KEY_PATTERN.source).toBe(AGENCY_FACT_KEY_PATTERN_SOURCE);
    expect(AGENCY_FACT_KEY_PATTERN.flags).toBe('');
    for (const ok of ['amount_due', 'a', 'emi2', 'loan_no_3']) expect(AGENCY_FACT_KEY_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', '2emi', '_x', 'Amount', 'amount-due', 'amount due', 'amount_due ']) {
      expect(AGENCY_FACT_KEY_PATTERN.test(bad), bad).toBe(false);
    }
    expect([...AGENCY_SCRIPT_FIXED_PLACEHOLDERS]).toEqual(['name', 'place', 'agent_name', 'campaign_name']);
    // The fixed ones are the legacy set minus the two tile roles, which become ordinary fact keys.
    expect(AGENCY_SCRIPT_PLACEHOLDERS.filter((p) => !(AGENCY_FACT_TILE_ROLES as readonly string[]).includes(p))).toEqual([
      ...AGENCY_SCRIPT_FIXED_PLACEHOLDERS,
    ]);
    // Every fixed placeholder is a valid key shape (so a client's key pattern matches them), and
    // reserved: the write refuses a fact keyed with one.
    for (const p of AGENCY_SCRIPT_FIXED_PLACEHOLDERS) expect(AGENCY_FACT_KEY_PATTERN.test(p)).toBe(true);
  });

  it('adds the chosen facts and the tile\'s name, key and highlight as optional fields (AS18, AS19)', () => {
    const facts: Equals<AgencyContextDisplay['facts'], AgencyFactField[] | undefined> = true;
    const label: Equals<AgencyFactTile['label'], string | undefined> = true;
    const key: Equals<AgencyFactTile['key'], string | undefined> = true;
    const highlight: Equals<AgencyFactTile['highlight'], boolean | undefined> = true;
    const fieldHighlight: Equals<AgencyFactField['highlight'], boolean | undefined> = true;
    const campaignDisplay: Equals<NonNullable<AgencyApi.AgencyCampaign['context_display']>['facts'], AgencyFactField[] | undefined> = true;
    void [facts, label, key, highlight, fieldHighlight, campaignDisplay];
    // A display without `facts` and a tile without the three still type-check: older rows and servers.
    const legacy: AgencyContextDisplay = { hero: ['Loan No'] };
    const tile: AgencyFactTile = { column: 'Loan No', type: 'text', raw: 'LN-1', value: null };
    expect([legacy.facts, tile.label]).toEqual([undefined, undefined]);
  });

  it('bounds the daily target (SNAPSHOT) and carries the station settings on the campaign wire type', () => {
    expect([AgencyApi.AGENCY_DAILY_TARGET_CALLS_MIN, AgencyApi.AGENCY_DAILY_TARGET_CALLS_MAX]).toEqual([1, 2000]);
    const target: Equals<AgencyApi.AgencyCampaign['daily_target_calls'], number | null | undefined> = true;
    const display: Equals<AgencyApi.AgencyCampaign['phone_display'], AgencyApi.AgencyPhoneDisplay | undefined> = true;
    const script: Equals<AgencyApi.AgencyCampaign['agent_script'], AgencyApi.AgencyAgentScript | undefined> = true;
    void [target, display, script];
  });

  it('re-exports the dialer\'s station vocabularies on the console side, not copies', () => {
    expect(AgencyApi.AGENCY_TILE_ICONS).toBe(AGENCY_TILE_ICONS);
    expect(AgencyApi.AGENCY_PHONE_DISPLAYS).toBe(AGENCY_PHONE_DISPLAYS);
    expect(AgencyApi.AGENCY_ATTEMPT_CALLBACK_SOURCES).toBe(AGENCY_ATTEMPT_CALLBACK_SOURCES);
    expect(AgencyApi.AGENCY_SCRIPT_PLACEHOLDERS).toBe(AGENCY_SCRIPT_PLACEHOLDERS);
    expect(AgencyApi.AGENCY_SCRIPT_FIXED_PLACEHOLDERS).toBe(AGENCY_SCRIPT_FIXED_PLACEHOLDERS);
    expect(AgencyApi.AGENCY_FACT_KEY_PATTERN).toBe(AGENCY_FACT_KEY_PATTERN);
    expect([AgencyApi.AGENCY_FACT_FIELDS_MAX, AgencyApi.AGENCY_FACT_LABEL_MAX_CHARS, AgencyApi.AGENCY_FACT_KEY_MAX_CHARS]).toEqual([
      AGENCY_FACT_FIELDS_MAX,
      AGENCY_FACT_LABEL_MAX_CHARS,
      AGENCY_FACT_KEY_MAX_CHARS,
    ]);
    const field: Equals<AgencyApi.AgencyFactField, AgencyFactField> = true;
    void field;
  });
});

describe('agent station: My day (BE-1) and the supervisor alerts (AS16)', () => {
  it('declares My day\'s query refusal, its row cap and its vocabularies (SNAPSHOT)', () => {
    expect(AgencyApi.AGENCY_MY_DAY_QUERY_ERROR_CODE).toBe('invalid_my_day_query');
    expect(AgencyApi.AGENCY_MY_CALL_LATER_ROWS_MAX).toBe(20);
    expect([...AgencyApi.AGENCY_MY_DAY_TARGET_METRICS]).toEqual(['calls']);
    expect([...AgencyApi.AGENCY_MY_CALL_LATER_LEFT_GOES_TO]).toEqual(['pool', 'waits_for_me']);
  });

  it('declares the alert kinds and the disconnected threshold (SNAPSHOT)', () => {
    expect([...AgencyApi.AGENCY_FLOOR_ALERT_KINDS]).toEqual(['help', 'break_over', 'disconnected']);
    expect(AgencyApi.AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS).toBe(20_000);
    // The union is discriminated by exactly the listed kinds.
    const kinds: Equals<AgencyApi.AgencyFloorAlert['kind'], (typeof AgencyApi.AGENCY_FLOOR_ALERT_KINDS)[number]> = true;
    // A help alert carries the floor's own request, `state_at_raise` included.
    const help: Equals<AgencyApi.AgencyFloorHelpAlert['help'], NonNullable<AgencyApi.AgencyFloorAgent['help']>> = true;
    const disconnected: Equals<AgencyApi.AgencyFloorAgent['disconnected_since'], string | null | undefined> = true;
    void [kinds, help, disconnected];
  });
});
