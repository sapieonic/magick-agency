import { describe, it, expect } from 'vitest';
import {
  findingsByStep,
  firstOtherStepWithFindings,
  goToStepLabel,
  reviewFindings,
  reviewRowForConfigField,
  saveBlockCopy,
  stepForConfigField,
} from '../../pages/campaigns/agency/builderErrors';
import { focusFirstFieldError } from '../../pages/campaigns/agency/configFieldErrors';
import { emptyCampaignConfig, validateConfig } from '../../utils/agencyCampaignConfigForm';

/*
  Where a config finding belongs in the campaign builder. The builder disables Save on any
  finding, so a finding the operator cannot locate is a campaign that cannot be saved: every
  key `validateConfig` produces has to land on a step and a Review row.
*/

describe('stepForConfigField', () => {
  it('puts the calling window on Hours, the basics on Basics, and the rest on How agents work', () => {
    expect(stepForConfigField('calling_window_start')).toBe('hours');
    expect(stepForConfigField('calling_window_end')).toBe('hours');
    expect(stepForConfigField('calling_days')).toBe('hours');
    expect(stepForConfigField('default_timezone')).toBe('hours');
    expect(stepForConfigField('name')).toBe('basics');
    expect(stepForConfigField('caller_ids')).toBe('basics');
    expect(stepForConfigField('disposition_catalog[4].requires_promise')).toBe('behaviour');
    expect(stepForConfigField('retry_policy.busy.max_attempts')).toBe('behaviour');
    expect(stepForConfigField('outcome_dispositions.invalid')).toBe('behaviour');
    expect(stepForConfigField('abandonment_ceiling_pct')).toBe('behaviour');
    expect(stepForConfigField('agent_retry_rounds')).toBe('behaviour');
  });
});

describe('reviewRowForConfigField', () => {
  it('names the Review row that summarises each setting', () => {
    expect(reviewRowForConfigField('calling_days')).toBe('hours');
    expect(reviewRowForConfigField('disposition_catalog[0].label')).toBe('outcomes');
    expect(reviewRowForConfigField('retry_policy.no_answer.delay_minutes')).toBe('unanswered');
    expect(reviewRowForConfigField('outcome_dispositions.busy')).toBe('unanswered');
    expect(reviewRowForConfigField('wrapup_seconds')).toBe('wrapup');
    expect(reviewRowForConfigField('callback_fallback')).toBe('assignment');
    expect(reviewRowForConfigField('abandonment_ceiling_pct')).toBe('abandonment');
    expect(reviewRowForConfigField('record_calls')).toBe('recording');
    expect(reviewRowForConfigField('name')).toBe('name');
    expect(reviewRowForConfigField('caller_ids')).toBe('callFrom');
  });
});

describe('saveBlockCopy', () => {
  it('says nothing when nothing holds the save', () => {
    expect(saveBlockCopy(new Map(), 'review')).toBeNull();
  });

  it('points at the highlighted fields only on the step that has them all', () => {
    expect(saveBlockCopy(new Map([['behaviour', 1]]), 'behaviour')).toBe('Fix the highlighted field to save.');
    expect(saveBlockCopy(new Map([['behaviour', 3]]), 'behaviour')).toBe('Fix the 3 highlighted fields to save.');
  });

  it('names the step anywhere else, so nobody is told to fix a field they cannot see', () => {
    expect(saveBlockCopy(new Map([['behaviour', 1]]), 'review')).toBe(
      'Can’t save yet: 1 setting on How agents work needs fixing.',
    );
    expect(saveBlockCopy(new Map([['hours', 1], ['behaviour', 2]]), 'review')).toBe(
      'Can’t save yet: 3 settings on When to call and How agents work need fixing.',
    );
    expect(saveBlockCopy(new Map([['hours', 1], ['behaviour', 2]]), 'behaviour')).toBe(
      'Can’t save yet: 3 settings on When to call and this step need fixing.',
    );
  });
});

describe('findingsByStep and firstOtherStepWithFindings', () => {
  it('counts findings per step in step order, and offers the first step that is not on screen', () => {
    const byStep = findingsByStep({
      'disposition_catalog[1].label': 'x',
      calling_window_end: 'y',
      wrapup_seconds: 'z',
    });
    expect([...byStep.entries()]).toEqual([['hours', 1], ['behaviour', 2]]);
    expect(firstOtherStepWithFindings(byStep, 'review')).toBe('hours');
    expect(firstOtherStepWithFindings(byStep, 'hours')).toBe('behaviour');
    expect(firstOtherStepWithFindings(new Map([['behaviour', 1]]), 'behaviour')).toBeNull();
    expect(goToStepLabel('behaviour')).toBe('Go to How agents work');
  });
});

describe('reviewFindings', () => {
  it('says which outcome a catalog finding is about, by label, code or place', () => {
    const config = emptyCampaignConfig();
    config.dispositions = [
      ...config.dispositions,
      { code: 'ptp', label: 'Promise to pay', requires_promise: true, requires_datetime: true },
      { code: '', label: '' },
    ];
    const promiseIndex = config.dispositions.length - 2;
    const blankIndex = config.dispositions.length - 1;
    const rows = reviewFindings(validateConfig(config), config);
    const outcomes = rows.get('outcomes') ?? [];
    expect(outcomes.some((line) => line.startsWith('Promise to pay: An outcome cannot ask for both'))).toBe(true);
    expect(outcomes.some((line) => line.startsWith(`Outcome ${blankIndex + 1}: Every outcome needs a label`))).toBe(true);
    expect(promiseIndex).toBeGreaterThan(0);
  });

  it('names the unanswered call a retry rule or an automatic outcome is for', () => {
    const config = emptyCampaignConfig();
    const rows = reviewFindings(
      {
        'retry_policy.busy.max_attempts': 'Set how many attempts — a whole number from 0 to 20.',
        'outcome_dispositions.invalid': '“Do not call” stops calling the contact.',
      },
      config,
    );
    expect(rows.get('unanswered')).toEqual([
      'Busy retries: Set how many attempts — a whole number from 0 to 20.',
      'Invalid number: “Do not call” stops calling the contact.',
    ]);
  });

  it('places every finding a broken config can produce on a Review row', () => {
    const config = emptyCampaignConfig();
    config.window = { ...config.window, start: '09:00', end: '09:00', days: [] };
    config.wrapupSeconds = 9999;
    config.abandonmentCeilingPct = 50;
    config.dispositions = [...config.dispositions, { code: 'Bad Code', label: '' }];
    const errors = validateConfig(config);
    const rows = reviewFindings(errors, config);
    const placed = [...rows.values()].reduce((sum, lines) => sum + lines.length, 0);
    expect(placed).toBe(Object.keys(errors).length);
    expect(rows.has('hours')).toBe(true);
    expect(rows.has('wrapup')).toBe(true);
    expect(rows.has('abandonment')).toBe(true);
    expect(rows.has('outcomes')).toBe(true);
  });
});

describe('focusFirstFieldError', () => {
  it('focuses the control that names the first error, and reports when there is none', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <input id="ok" />
      <input id="bad" aria-describedby="lead err-1" />
      <p class="error-text" id="err-1" role="alert">Wrong</p>
    `;
    document.body.appendChild(container);
    expect(focusFirstFieldError(container)).toBe(true);
    expect(document.activeElement?.id).toBe('bad');
    container.remove();

    const clean = document.createElement('div');
    clean.innerHTML = '<input />';
    expect(focusFirstFieldError(clean)).toBe(false);
  });
});
