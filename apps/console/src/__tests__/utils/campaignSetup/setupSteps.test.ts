import { describe, expect, it } from 'vitest';
import { setupStepOfField } from '../../../utils/campaignSetup/setupSteps';
import { emptyCampaignConfig, validateConfig } from '../../../utils/agencyCampaignConfigForm';

/*
  Which setup step shows a finding (CS1): one rule for New campaign's steps and campaign Settings'
  tabs. The customer card's facts are chosen on Customers (CS9), so its findings land there.
*/

describe('setupStepOfField', () => {
  it.each([
    ['name', 'basics'],
    ['caller_ids', 'basics'],
    ['telephony_credential_id', 'basics'],
    ['context_display.facts.0.label', 'contacts'],
    ['context_display.roles.place', 'contacts'],
    ['disposition_catalog[2].code', 'purpose'],
    ['outcome_dispositions.no_answer', 'purpose'],
    ['agent_script.steps[1].text', 'purpose'],
    ['calling_window_end', 'agents'],
    ['retry_policy.busy.max_attempts', 'agents'],
    ['abandonment_ceiling_pct', 'agents'],
    ['record_calls', 'agents'],
    ['analysis_profile_id', 'agents'],
    ['assignment_mode', 'agents'],
    ['break_reasons[1].icon', 'agents'],
    ['daily_target_calls', 'agents'],
    ['phone_display', 'agents'],
    ['telephony_provider', 'basics'],
    ['disposition_catalog', 'purpose'],
    ['agent_script.opening', 'purpose'],
    ['calling_days', 'agents'],
    ['default_timezone', 'agents'],
    ['wrapup_seconds', 'agents'],
    ['agent_retry_rounds', 'agents'],
    ['inbound_sticky_enabled', 'agents'],
    ['break_reasons', 'agents'],
  ])('a finding on %s is on %s', (field, step) => {
    expect(setupStepOfField(field)).toBe(step);
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
      expect(setupStepOfField(key), key).toBe(row![1]);
    }
  });
});
