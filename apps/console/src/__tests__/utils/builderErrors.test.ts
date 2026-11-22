import { describe, it, expect } from 'vitest';
import {
  findingsByStep,
  firstOtherStepWithFindings,
  goToStepLabel,
  saveBlockCopy,
  stepForConfigField,
} from '../../pages/campaigns/agency/builderErrors';
import { emptyCampaignConfig, validateConfig } from '../../utils/agencyCampaignConfigForm';

/*
  Where a config finding belongs in New campaign. The page disables Save on any finding, so a
  finding the operator cannot locate is a campaign that cannot be saved: every key
  `validateConfig` produces has to land on the step that shows it.
*/

describe('stepForConfigField', () => {
  it('puts the buttons and the automatic outcomes on Purpose & buttons, the basics on Name & number, the rest on Agents & timing', () => {
    expect(stepForConfigField('name')).toBe('basics');
    expect(stepForConfigField('caller_ids')).toBe('basics');
    expect(stepForConfigField('telephony_credential_id')).toBe('basics');
    expect(stepForConfigField('disposition_catalog')).toBe('purpose');
    expect(stepForConfigField('disposition_catalog[4].requires_promise')).toBe('purpose');
    expect(stepForConfigField('outcome_dispositions.invalid')).toBe('purpose');
    expect(stepForConfigField('calling_window_start')).toBe('agents');
    expect(stepForConfigField('calling_window_end')).toBe('agents');
    expect(stepForConfigField('calling_days')).toBe('agents');
    expect(stepForConfigField('default_timezone')).toBe('agents');
    expect(stepForConfigField('retry_policy.busy.max_attempts')).toBe('agents');
    expect(stepForConfigField('wrapup_seconds')).toBe('agents');
    expect(stepForConfigField('agent_retry_rounds')).toBe('agents');
    expect(stepForConfigField('inbound_sticky_enabled')).toBe('agents');
    expect(stepForConfigField('abandonment_ceiling_pct')).toBe('agents');
    expect(stepForConfigField('record_calls')).toBe('agents');
    expect(stepForConfigField('analysis_profile_id')).toBe('agents');
    expect(stepForConfigField('daily_target_calls')).toBe('agents');
    expect(stepForConfigField('break_reasons')).toBe('agents');
  });

  /*
    Every kind of key `validateConfig` produces, from a config broken everywhere, with the step
    each one belongs on. The mapper has a catch-all; this pins that no real key reaches it by
    accident. A key this config produces whose prefix is not in the table fails here; a new rule
    is caught only if the config below is broken enough to trigger it, so extend the config with
    the rule.
  */
  const EXPECTED: ReadonlyArray<[RegExp, string]> = [
    [/^calling_window_(start|end)$|^calling_days$|^default_timezone$/, 'agents'],
    [/^disposition_catalog\[\d+\]/, 'purpose'],
    [/^retry_policy\./, 'agents'],
    [/^outcome_dispositions\./, 'purpose'],
    [/^wrapup_seconds$/, 'agents'],
    [/^abandonment_ceiling_pct$/, 'agents'],
    [/^(assignment_mode|on_unstaff|callback_owner_grace_minutes|callback_fallback|agent_retry_rounds|agent_retry_cooldown_minutes)$/, 'agents'],
  ];

  it('places every kind of finding on the step that shows it', () => {
    const config = emptyCampaignConfig();
    config.window = { start: '9am', end: '09:00', days: [], timezone: 'EST' };
    config.wrapupSeconds = 9999;
    config.abandonmentCeilingPct = 50;
    config.dispositions = [
      ...config.dispositions,
      { code: 'Bad Code', label: '', retry: { max_attempts: 99 } },
    ];
    config.retryPolicy = { busy: { max_attempts: -1 } };
    config.outcomeDispositions = { invalid: 'gone' };
    config.assignment = {
      ...config.assignment,
      mode: 'nonsense' as never,
      onUnstaff: 'nonsense' as never,
      callbackFallback: 'nonsense' as never,
      callbackGraceMinutes: -1,
      agentRetryRounds: 0,
      agentRetryCooldownMinutes: -1,
    };
    const errors = validateConfig(config);
    const keys = Object.keys(errors);
    // Every row of the table is exercised by this config.
    for (const [pattern] of EXPECTED) expect(keys.some((key) => pattern.test(key))).toBe(true);
    for (const key of keys) {
      const row = EXPECTED.find(([pattern]) => pattern.test(key));
      expect(row, `no expectation for ${key}`).toBeDefined();
      expect(stepForConfigField(key), key).toBe(row![1]);
    }
  });
});

describe('saveBlockCopy', () => {
  it('says nothing when nothing holds the save', () => {
    expect(saveBlockCopy(new Map(), 'agents')).toBeNull();
  });

  it('points at the highlighted fields only on the step that has them all', () => {
    expect(saveBlockCopy(new Map([['purpose', 1]]), 'purpose')).toBe('Fix the highlighted field to save.');
    expect(saveBlockCopy(new Map([['agents', 3]]), 'agents')).toBe('Fix the 3 highlighted fields to save.');
  });

  it('names the step anywhere else, so nobody is told to fix a field they cannot see', () => {
    expect(saveBlockCopy(new Map([['purpose', 1]]), 'agents')).toBe(
      'Can’t save yet: 1 setting on Purpose & buttons needs fixing.',
    );
    expect(saveBlockCopy(new Map([['purpose', 1], ['agents', 2]]), 'basics')).toBe(
      'Can’t save yet: 3 settings on Purpose & buttons and Agents & timing need fixing.',
    );
    expect(saveBlockCopy(new Map([['purpose', 1], ['agents', 2]]), 'agents')).toBe(
      'Can’t save yet: 3 settings on Purpose & buttons and this step need fixing.',
    );
  });
});

describe('findingsByStep and firstOtherStepWithFindings', () => {
  it('counts findings per step in step order, and offers the first step that is not on screen', () => {
    const byStep = findingsByStep({
      calling_window_end: 'y',
      'disposition_catalog[1].label': 'x',
      wrapup_seconds: 'z',
    });
    expect([...byStep.entries()]).toEqual([['purpose', 1], ['agents', 2]]);
    expect(firstOtherStepWithFindings(byStep, 'contacts')).toBe('purpose');
    expect(firstOtherStepWithFindings(byStep, 'purpose')).toBe('agents');
    expect(firstOtherStepWithFindings(new Map([['agents', 1]]), 'agents')).toBeNull();
    expect(goToStepLabel('purpose')).toBe('Go to Purpose & buttons');
    expect(goToStepLabel('agents')).toBe('Go to Agents & timing');
  });
});
