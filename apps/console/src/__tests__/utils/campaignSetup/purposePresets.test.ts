import { describe, expect, it } from 'vitest';
import { isAgencyTileIcon } from '@magick-agency/contracts/agency';
import {
  DEFAULT_DISPOSITIONS,
  emptyCampaignConfig,
  isBuiltInCode,
  validateConfig,
  type CampaignConfigState,
} from '../../../utils/agencyCampaignConfigForm';
import { collectionsStarterOutcomes, withCollectionsStarter } from '../../../utils/agency/collectionsStarter';
import {
  PURPOSE_PRESETS,
  isPurposePresetId,
  presetOf,
  purposePreset,
  withPreset,
} from '../../../utils/campaignSetup/purposePresets';

/** Step 3's starting points (CS2). */

/** The flag the server requires of each built-in code (its built-in mismatch rule). */
function builtInFlagHeld(entry: { code: string; retry?: unknown; requires_datetime?: boolean; suppress?: boolean }): boolean {
  if (entry.code === 'voicemail') return entry.retry != null;
  if (entry.code === 'callback') return entry.requires_datetime === true;
  if (entry.code === 'do_not_call') return entry.suppress === true;
  return true;
}

describe('the starting points', () => {
  it('are the five, in order, with their words', () => {
    expect(PURPOSE_PRESETS.map((p) => [p.id, p.title, p.description])).toEqual([
      ['payment', 'Payment reminder', 'Collections, EMI, chit dues'],
      ['sales', 'Sales / leads', 'Offers, follow-ups, demos'],
      ['survey', 'Survey / feedback', 'NPS, service feedback'],
      ['appointment', 'Appointment', 'Confirm, reschedule, remind'],
      ['blank', 'Start blank', 'Build your own buttons'],
    ]);
    expect(isPurposePresetId('sales')).toBe(true);
    expect(isPurposePresetId('collections')).toBe(false);
  });

  it('Payment reminder is the Collections set itself', () => {
    expect(purposePreset('payment').outcomes).toBe(collectionsStarterOutcomes);
    const config = { ...emptyCampaignConfig(), outcomeDispositions: { busy: 'voicemail', no_answer: 'callback' } };
    expect(withPreset(config, 'payment')).toEqual(withCollectionsStarter(config));
  });

  it('Start blank is the server’s default: the three built-ins', () => {
    expect(purposePreset('blank').outcomes()).toEqual(DEFAULT_DISPOSITIONS);
  });

  it.each(PURPOSE_PRESETS.map((p) => [p.id, p] as const))('%s passes validateConfig and the server’s built-in rule', (_id, preset) => {
    const dispositions = preset.outcomes();
    expect(validateConfig({ ...emptyCampaignConfig(), dispositions })).toEqual({});
    expect(dispositions.length).toBeLessThanOrEqual(6);
    expect(dispositions.every(builtInFlagHeld)).toBe(true);
    expect(new Set(dispositions.map((d) => d.code)).size).toBe(dispositions.length);
    for (const entry of dispositions) {
      if (entry.icon !== undefined) expect(isAgencyTileIcon(entry.icon), entry.code).toBe(true);
    }
  });

  it.each(['sales', 'survey', 'appointment'] as const)('%s has six pictured buttons, and keeps Callback and Do Not Call', (id) => {
    const dispositions = purposePreset(id).outcomes();
    expect(dispositions).toHaveLength(6);
    expect(dispositions.every((d) => d.icon !== undefined)).toBe(true);
    expect(dispositions.find((d) => d.code === 'callback')).toMatchObject({ requires_datetime: true });
    expect(dispositions.find((d) => d.code === 'do_not_call')).toMatchObject({ suppress: true });
    expect(dispositions.some((d) => d.is_success)).toBe(true);
    expect(dispositions.some((d) => d.retry && d.retry.max_attempts > 0)).toBe(true);
    // Only the built-ins keep a built-in's code.
    expect(dispositions.filter((d) => isBuiltInCode(d.code)).map((d) => d.code).sort()).toEqual(['callback', 'do_not_call']);
  });

  it('hands out a fresh copy each time', () => {
    for (const preset of PURPOSE_PRESETS) {
      const first = preset.outcomes();
      first[0]!.label = 'Changed';
      if (first[0]!.retry) first[0]!.retry.max_attempts = 9;
      const retried = first.find((d) => d.retry);
      if (retried) retried.retry!.delay_minutes = 1;
      expect(preset.outcomes()[0]!.label, preset.id).not.toBe('Changed');
      expect(preset.outcomes().find((d) => d.retry)?.retry?.delay_minutes ?? 240, preset.id).toBe(240);
    }
  });
});

describe('withPreset', () => {
  it('puts the buttons in place and keeps every other setting', () => {
    const config: CampaignConfigState = { ...emptyCampaignConfig(), wrapupSeconds: 45, autoReturn: false };
    const next = withPreset(config, 'sales');
    expect(next.dispositions).toEqual(purposePreset('sales').outcomes());
    expect({ ...next, dispositions: config.dispositions }).toEqual(config);
  });

  it('drops an automatic outcome the new buttons do not have or may not file, and keeps the rest', () => {
    const config: CampaignConfigState = {
      ...emptyCampaignConfig(),
      // `callback` stays; `voicemail` is gone from Sales; `do_not_call` stops calling.
      outcomeDispositions: { no_answer: 'callback', busy: 'voicemail', failed: 'do_not_call' },
    };
    expect(withPreset(config, 'sales').outcomeDispositions).toEqual({ no_answer: 'callback' });
    expect(withPreset(config, 'blank').outcomeDispositions).toEqual({ no_answer: 'callback', busy: 'voicemail' });
  });
});

describe('presetOf', () => {
  it('names each starting point while it is untouched', () => {
    for (const preset of PURPOSE_PRESETS) expect(presetOf(preset.outcomes())).toBe(preset.id);
    // A new campaign's form starts from the server's default, which is Start blank.
    expect(presetOf(emptyCampaignConfig().dispositions)).toBe('blank');
  });

  it('compares by meaning: key order, false flags and undefined keys do not matter', () => {
    const loaded = collectionsStarterOutcomes()
      .map((entry) => Object.fromEntries(Object.entries(entry).reverse()))
      .map((entry, i) => (i === 3 ? { ...entry, is_success: false, override: undefined } : entry));
    expect(presetOf(loaded as never)).toBe('payment');
  });

  it('is none once edited, reordered, or empty', () => {
    const renamed = purposePreset('survey').outcomes();
    renamed[0]!.label = 'Done';
    expect(presetOf(renamed)).toBeNull();
    const reordered = purposePreset('sales').outcomes().reverse();
    expect(presetOf(reordered)).toBeNull();
    const retried = collectionsStarterOutcomes();
    retried[2]!.retry = { delay_minutes: 60, max_attempts: 2 };
    expect(presetOf(retried)).toBeNull();
    expect(presetOf([])).toBeNull();
  });
});
