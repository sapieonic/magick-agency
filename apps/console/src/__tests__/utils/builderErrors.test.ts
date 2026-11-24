import { describe, it, expect } from 'vitest';
import {
  findingsByStep,
  firstOtherStepWithFindings,
  goToStepLabel,
  saveBlockCopy,
} from '../../pages/campaigns/agency/builderErrors';

/*
  What New campaign says about its findings: how many each step holds and the footer's words.
  Which step a finding is on is `setupStepOfField` (`campaignSetup/setupSteps.test.ts`, which
  also pins that every key `validateConfig` produces lands on the step that shows it).
*/

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
