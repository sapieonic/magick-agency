import { describe, it, expect } from 'vitest';
import { AGENCY_REDIALED_DISPOSITION_CODE } from '@magick-agency/contracts/agency';
import {
  isSystemDispositionCode,
  reservedDispositionCodeMessage,
  systemDispositionLabel,
} from '../../utils/agency/systemDisposition';
import { dispositionLabel } from '../../utils/agencySpineCopy';
import { priorDispositionIsRaw, priorDispositionLabel } from '../../utils/agencyPriorAttempts';
import { EMPTY_CAMPAIGN_CONFIG, validateConfig } from '../../utils/agencyCampaignConfigForm';

/**
 * `redialed` is the disposition a wrap-up redial stamps on the call it redials.
 * No catalog carries it, so every view that names a disposition through the
 * catalog must name this one itself, and the builder must refuse it as a code.
 */
describe('the system-written disposition `redialed`', () => {
  const catalog = [{ code: 'sale', label: 'Sale' }];

  it('is the contract’s code, and named', () => {
    expect(AGENCY_REDIALED_DISPOSITION_CODE).toBe('redialed');
    expect(isSystemDispositionCode('redialed')).toBe(true);
    expect(systemDispositionLabel('redialed')).toBe('Redialled');
    expect(systemDispositionLabel('sale')).toBeNull();
    expect(systemDispositionLabel(null)).toBeNull();
    // Not a prototype key passed off as a code.
    expect(isSystemDispositionCode('toString')).toBe(false);
  });

  it('reads as a label on the spine views, never the raw code', () => {
    expect(dispositionLabel('redialed', catalog)).toBe('Redialled');
    expect(dispositionLabel('redialed', undefined)).toBe('Redialled');
    expect(dispositionLabel('sale', catalog)).toBe('Sale');
  });

  it('reads as a label in the agent’s prior attempts, not styled as an unlabelled code', () => {
    expect(priorDispositionLabel('redialed', undefined)).toBe('Redialled');
    expect(priorDispositionIsRaw('redialed', undefined)).toBe(false);
    expect(priorDispositionIsRaw('ptp', undefined)).toBe(true);
  });

  it('is refused as a catalog code by the builder, as the server refuses it', () => {
    const state = {
      ...EMPTY_CAMPAIGN_CONFIG,
      dispositions: [...EMPTY_CAMPAIGN_CONFIG.dispositions, { code: 'redialed', label: 'Redialled' }],
    };
    const at = `disposition_catalog[${state.dispositions.length - 1}].code`;
    expect(validateConfig(state)[at]).toBe(reservedDispositionCodeMessage('redialed'));
    expect(reservedDispositionCodeMessage('redialed')).toContain('reserved');
    expect(reservedDispositionCodeMessage('sale')).toBeNull();
    expect(validateConfig(EMPTY_CAMPAIGN_CONFIG)).toEqual({});
  });
});
