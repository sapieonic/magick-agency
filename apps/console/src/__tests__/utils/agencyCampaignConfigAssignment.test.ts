import { describe, expect, it } from 'vitest';
import { AGENCY_CONTACT_ASSIGNMENT_DEFAULTS } from '@magick-agency/contracts/agency';
import {
  DEFAULT_ASSIGNMENT_CONFIG,
  EMPTY_CAMPAIGN_CONFIG,
  buildConfigPayload,
  configFromCampaign,
  dispositionSummary,
  editCatalog,
  emptyCampaignConfig,
  overrideSummary,
  resetAssignmentConfig,
  storedAssignmentLeftovers,
  validateConfig,
  type CampaignConfigState,
  type CatalogEditState,
} from '../../utils/agencyCampaignConfigForm';
import type { AgencyCampaign, AgencyDispositionEntry } from '../../types/agency-campaign';

/**
 * Contact assignment in the campaign form: the Assignment settings round-trip
 * through load → save with the contract's bounds, and each outcome's override is
 * edited, cloned, validated and summarised.
 */

const CAMPAIGN: AgencyCampaign = {
  id: 'camp-1',
  name: 'Collections',
  status: 'paused',
  assignment_mode: 'strict',
  on_unstaff: 'keep',
  callback_owner_grace_minutes: 90,
  callback_fallback: 'wait',
  allow_agent_retry: true,
  agent_retry_rounds: 3,
  agent_retry_cooldown_minutes: 45,
  disposition_catalog: [
    { code: 'ptp', label: 'Promise to pay', override: { extra_attempts: 2, calling_hours: true } },
  ],
};

function config(over: Partial<CampaignConfigState> = {}): CampaignConfigState {
  return { ...emptyCampaignConfig(), ...over };
}

describe('assignment settings round trip', () => {
  it('defaults to the 0009 column defaults (a campaign that says nothing behaves as before)', () => {
    expect(EMPTY_CAMPAIGN_CONFIG.assignment).toEqual(DEFAULT_ASSIGNMENT_CONFIG);
    expect(DEFAULT_ASSIGNMENT_CONFIG.mode).toBe(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS.assignment_mode);
    expect(configFromCampaign({ id: 'c', name: 'n', status: 'draft' }).assignment).toEqual(DEFAULT_ASSIGNMENT_CONFIG);
  });

  it('loads every setting and saves it back unchanged', () => {
    const payload = buildConfigPayload(configFromCampaign(CAMPAIGN));
    expect(payload).toMatchObject({
      assignment_mode: 'strict',
      on_unstaff: 'keep',
      callback_owner_grace_minutes: 90,
      callback_fallback: 'wait',
      allow_agent_retry: true,
      agent_retry_rounds: 3,
      agent_retry_cooldown_minutes: 45,
    });
    expect(payload.disposition_catalog![0]!.override).toEqual({ extra_attempts: 2, calling_hours: true });
  });

  it('always sends the values, defaults included, so turning one back to its default saves', () => {
    const payload = buildConfigPayload(config());
    expect(payload.assignment_mode).toBe('pool');
    expect(payload.allow_agent_retry).toBe(false);
    expect(payload.agent_retry_rounds).toBe(1);
  });

  it('leaves the mode out when it is locked, and every setting out when the flag is off', () => {
    const locked = buildConfigPayload(configFromCampaign(CAMPAIGN), 'settings_only');
    expect(locked).not.toHaveProperty('assignment_mode');
    expect(locked.on_unstaff).toBe('keep');
    const off = buildConfigPayload(configFromCampaign(CAMPAIGN), 'none');
    for (const key of [
      'assignment_mode', 'on_unstaff', 'callback_owner_grace_minutes', 'callback_fallback',
      'allow_agent_retry', 'agent_retry_rounds', 'agent_retry_cooldown_minutes',
    ]) {
      expect(off).not.toHaveProperty(key);
    }
  });

  it('copies rather than shares the assignment and the override objects', () => {
    const state = configFromCampaign(CAMPAIGN);
    expect(state.dispositions[0]!.override).not.toBe(CAMPAIGN.disposition_catalog![0]!.override);
    const payload = buildConfigPayload(state);
    expect(payload.disposition_catalog![0]!.override).not.toBe(state.dispositions[0]!.override);
    expect(emptyCampaignConfig().assignment).not.toBe(EMPTY_CAMPAIGN_CONFIG.assignment);
  });
});

describe('validateConfig: assignment bounds from the contract', () => {
  const assignment = (over: Partial<CampaignConfigState['assignment']>) =>
    config({ assignment: { ...DEFAULT_ASSIGNMENT_CONFIG, ...over } });

  it('accepts the defaults and the edges', () => {
    expect(validateConfig(config())).toEqual({});
    expect(validateConfig(assignment({ callbackGraceMinutes: 10080, agentRetryRounds: 10, agentRetryCooldownMinutes: 0 })))
      .toEqual({});
  });

  it('keys each bound by its body field', () => {
    const errors = validateConfig(assignment({
      callbackGraceMinutes: 10081,
      agentRetryRounds: 0,
      agentRetryCooldownMinutes: 1.5,
    }));
    expect(errors['callback_owner_grace_minutes']).toBeTruthy();
    expect(errors['agent_retry_rounds']).toBe('Rounds are 1 to 10.');
    expect(errors['agent_retry_cooldown_minutes']).toBeTruthy();
    expect(validateConfig(assignment({ agentRetryRounds: 11 }))['agent_retry_rounds']).toBeTruthy();
  });
});

describe('editCatalog: the override patches', () => {
  const start = (entry: Partial<AgencyDispositionEntry> = {}): CatalogEditState => ({
    dispositions: [{ code: 'ptp', label: 'Promise to pay', ...entry }],
    autoCodeRows: new Set(),
  });

  it('switches a part on and keeps only the parts that are on', () => {
    const on = editCatalog(start(), { type: 'setOverride', index: 0, patch: { extra_attempts: 1 } });
    expect(on.dispositions[0]!.override).toEqual({ extra_attempts: 1 });
    const more = editCatalog(on, { type: 'setOverride', index: 0, patch: { retry_delay: true } });
    expect(more.dispositions[0]!.override).toEqual({ extra_attempts: 1, retry_delay: true });
    const less = editCatalog(more, { type: 'setOverride', index: 0, patch: { extra_attempts: undefined } });
    expect(less.dispositions[0]!.override).toEqual({ retry_delay: true });
  });

  it('removes the override when its last part goes off, never saving {}', () => {
    const on = editCatalog(start(), { type: 'setOverride', index: 0, patch: { calling_hours: true } });
    const off = editCatalog(on, { type: 'setOverride', index: 0, patch: { calling_hours: false } });
    expect(off.dispositions[0]).not.toHaveProperty('override');
  });

  it('does not write into the row it was given', () => {
    const before = start({ override: { retry_delay: true } });
    const original = before.dispositions[0]!.override;
    editCatalog(before, { type: 'setOverride', index: 0, patch: { calling_hours: true } });
    expect(original).toEqual({ retry_delay: true });
  });

  it('drops the override when the outcome is made to suppress or end the contact', () => {
    const held = start({ override: { retry_delay: true } });
    expect(editCatalog(held, { type: 'update', index: 0, patch: { suppress: true } }).dispositions[0])
      .not.toHaveProperty('override');
    expect(editCatalog(held, { type: 'update', index: 0, patch: { terminal: true } }).dispositions[0])
      .not.toHaveProperty('override');
    expect(editCatalog(held, { type: 'update', index: 0, patch: { is_success: true } }).dispositions[0]!.override)
      .toEqual({ retry_delay: true });
  });

  it('ignores an index that is not a row', () => {
    const state = start();
    expect(editCatalog(state, { type: 'setOverride', index: 4, patch: { retry_delay: true } })).toBe(state);
  });
});

describe('validateConfig: overrides keyed disposition_catalog[i].override.*', () => {
  it('bounds extra attempts to 1–5', () => {
    const errors = validateConfig(config({
      dispositions: [{ code: 'ptp', label: 'PTP', override: { extra_attempts: 6 } }],
    }));
    expect(errors['disposition_catalog[0].override.extra_attempts']).toBe('Extra attempts are 1 to 5.');
  });

  it('refuses an override on an outcome that suppresses or ends the contact, or that grants nothing', () => {
    expect(validateConfig(config({
      dispositions: [{ code: 'gone', label: 'Gone', terminal: true, override: { retry_delay: true } }],
    }))['disposition_catalog[0].override']).toBeTruthy();
    expect(validateConfig(config({
      dispositions: [{ code: 'ptp', label: 'PTP', override: {} }],
    }))['disposition_catalog[0].override']).toBeTruthy();
  });
});

describe('the summary line mentions the override', () => {
  it('states what the agent may then do', () => {
    const entry: AgencyDispositionEntry = {
      code: 'ptp', label: 'PTP', override: { extra_attempts: 2, retry_delay: true, calling_hours: true },
    };
    expect(overrideSummary(entry)).toBe(
      'The agent may then make 2 extra attempts past the limit, a call before the next scheduled time and a call outside calling hours, with a note.',
    );
    expect(dispositionSummary(entry)).toContain('The agent may then make');
  });

  it('says nothing about an override nothing would read', () => {
    expect(overrideSummary({ code: 'x', label: 'X' })).toBeNull();
    expect(overrideSummary({ code: 'x', label: 'X', suppress: true, override: { retry_delay: true } })).toBeNull();
  });
});

describe('the way back after the flag is turned off', () => {
  it('lists what a stored campaign holds beyond the defaults, and nothing for one at the defaults', () => {
    expect(storedAssignmentLeftovers(CAMPAIGN)).toEqual([
      'the “Own contacts only” assignment mode',
      'agent retry',
      'keeping contacts with agents taken off it',
      'changed callback or retry timings',
      '1 outcome override',
    ]);
    expect(storedAssignmentLeftovers({ id: 'c', name: 'n', status: 'running' })).toEqual([]);
  });

  it('resets to the defaults and drops every override, and the payload sends the defaults', () => {
    const reset = resetAssignmentConfig(configFromCampaign(CAMPAIGN));
    expect(reset.assignment).toEqual(DEFAULT_ASSIGNMENT_CONFIG);
    expect(reset.dispositions.some((entry) => 'override' in entry)).toBe(false);
    expect(buildConfigPayload(reset, 'all')).toMatchObject({
      assignment_mode: AGENCY_CONTACT_ASSIGNMENT_DEFAULTS.assignment_mode,
      allow_agent_retry: AGENCY_CONTACT_ASSIGNMENT_DEFAULTS.allow_agent_retry,
      on_unstaff: AGENCY_CONTACT_ASSIGNMENT_DEFAULTS.on_unstaff,
    });
  });

  it('with the flag off (scope none) re-sends the stored overrides unchanged', () => {
    const payload = buildConfigPayload(configFromCampaign(CAMPAIGN), 'none');
    expect(payload).not.toHaveProperty('assignment_mode');
    expect(payload).not.toHaveProperty('allow_agent_retry');
    expect(payload.disposition_catalog![0]!.override).toEqual({ extra_attempts: 2, calling_hours: true });
  });
});
