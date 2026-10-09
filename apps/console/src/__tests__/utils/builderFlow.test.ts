import { describe, it, expect } from 'vitest';
import {
  BUILDER_STEPS,
  basicsBlockReason,
  canVisitStep,
  contactsContinueLabel,
  nextStep,
  prevStep,
  stepIndex,
} from '../../pages/campaigns/agency/builderFlow';

describe('builderFlow', () => {
  it('orders the five setup decisions a first-time operator should meet', () => {
    expect(BUILDER_STEPS.map((step) => step.id)).toEqual([
      'basics',
      'contacts',
      'hours',
      'behaviour',
      'review',
    ]);
  });

  it('walks forward and back without wrapping', () => {
    expect(nextStep('basics')).toBe('contacts');
    expect(nextStep('review')).toBeNull();
    expect(prevStep('basics')).toBeNull();
    expect(prevStep('review')).toBe('behaviour');
    expect(stepIndex('hours')).toBe(2);
  });

  it('keeps later steps closed until the campaign can be created', () => {
    expect(canVisitStep('basics', false)).toBe(true);
    expect(canVisitStep('contacts', false)).toBe(false);
    expect(canVisitStep('review', false)).toBe(false);
    expect(canVisitStep('hours', true)).toBe(true);
    expect(canVisitStep('review', true)).toBe(true);
  });

  it('names the missing basic rather than a generic “not ready”', () => {
    expect(basicsBlockReason('', [])).toBe('Name the campaign first.');
    expect(basicsBlockReason('Collections', [])).toBe('Pick at least one number to call from.');
    expect(basicsBlockReason('Collections', ['+912200000001'])).toBeNull();
  });

  it('hides page-level continue while the contacts step already has a primary action', () => {
    expect(contactsContinueLabel('idle')).toBe('Skip for now');
    expect(contactsContinueLabel('mapping')).toBeNull();
    expect(contactsContinueLabel('ingesting')).toBeNull();
    expect(contactsContinueLabel('done')).toBe('Continue');
  });
});
