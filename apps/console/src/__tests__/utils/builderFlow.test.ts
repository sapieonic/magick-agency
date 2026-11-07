import { describe, it, expect } from 'vitest';
import {
  BUILDER_STEPS,
  basicsBlockReason,
  canVisitStep,
  contactsContinueLabel,
  defaultBuilderCarrier,
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

describe('defaultBuilderCarrier', () => {
  const SERVICE = { telephony_provider: 'voicelink', telephony_credential_id: null };
  const OWN = { telephony_provider: 'plivo', telephony_credential_id: 'cred-a' };
  const OTHER = { telephony_provider: 'plivo', telephony_credential_id: 'cred-b' };
  const on = (c: { telephony_provider: string; telephony_credential_id: string | null }) =>
    ({ provider_name: c.telephony_provider, telephony_credential_id: c.telephony_credential_id });

  it('takes the first listed carrier account that has a number available', () => {
    expect(defaultBuilderCarrier([SERVICE, OWN, OTHER], [on(OTHER), on(OWN)])).toBe(OWN);
    expect(defaultBuilderCarrier([SERVICE, OWN], [on(SERVICE), on(OWN)])).toBe(SERVICE);
  });

  it('the first listed when none has numbers or they are not known; the service’s own without a list', () => {
    expect(defaultBuilderCarrier([OWN, OTHER], [])).toBe(OWN);
    expect(defaultBuilderCarrier([OWN, OTHER], null)).toBe(OWN);
    expect(defaultBuilderCarrier(null, [on(OWN)])).toEqual(SERVICE);
    expect(defaultBuilderCarrier([], [on(OWN)])).toEqual(SERVICE);
  });
});
