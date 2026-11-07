import { describe, expect, it } from 'vitest';
import { AGENCY_AUTO_DISPOSITION_OUTCOMES, type AgencyAttemptOutcome } from '@magick-agency/contracts/agency';
import { resolveAutoDisposition } from '../../../src/agency/auto-disposition.js';
import { isAutoDispositionOutcome } from '@magick-agency/domain/auto-disposition';
import { CAMPAIGN_CONFIG_COLUMN_DEFAULTS, validateOutcomeDispositions } from '../../../src/agency/campaign-config.js';
import { validateAgencyCampaignConfig as validatePublic } from '../../../src/agency/agency-campaign-config.js';

/**
 * Automatic outcomes for unanswered calls (decisions OD1–OD8): the pure rule the settle
 * path stamps with (`resolveAutoDisposition`) and the write-time rule both validators
 * share (`validateOutcomeDispositions`). The settle path and the routes are pinned on a
 * real database (`test/integration/agency/auto-disposition-settle.test.ts`,
 * `campaign-outcome-dispositions-setting.test.ts`).
 */

const CATALOG = [
  { code: 'retry_later', label: 'Retry later' },
  { code: 'callback', label: 'Callback', requires_datetime: true },
  { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 240, max_attempts: 2 } },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
  { code: 'sale', label: 'Sale', terminal: true, is_success: true },
];

const ALL_OUTCOMES: AgencyAttemptOutcome[] = [
  'connected', 'no_answer', 'busy', 'failed', 'machine', 'invalid', 'abandoned',
  'agent_disconnected', 'orphaned', 'canceled',
];

describe('isAutoDispositionOutcome — the five unanswered outcomes, nothing else (OD2)', () => {
  it('accepts exactly AGENCY_AUTO_DISPOSITION_OUTCOMES', () => {
    expect(ALL_OUTCOMES.filter(isAutoDispositionOutcome)).toEqual(['no_answer', 'busy', 'failed', 'invalid', 'abandoned']);
    expect([...AGENCY_AUTO_DISPOSITION_OUTCOMES]).toEqual(['no_answer', 'busy', 'failed', 'invalid', 'abandoned']);
  });
});

describe('resolveAutoDisposition', () => {
  const campaign = (outcome_dispositions: unknown, disposition_catalog: unknown = CATALOG) =>
    ({ outcome_dispositions, disposition_catalog }) as Parameters<typeof resolveAutoDisposition>[0];

  it('returns the mapped code for a mapped unanswered outcome', () => {
    const c = campaign({ busy: 'retry_later', no_answer: 'callback', invalid: 'voicemail' });
    expect(resolveAutoDisposition(c, 'busy')).toBe('retry_later');
    // A `requires_datetime` or `retry` entry is a label like any other: its callback time
    // and its retry are not applied (OD1), so mapping it is allowed.
    expect(resolveAutoDisposition(c, 'no_answer')).toBe('callback');
    expect(resolveAutoDisposition(c, 'invalid')).toBe('voicemail');
  });

  it('returns null for an unmapped outcome, an empty map, and every outcome that is not unanswered', () => {
    expect(resolveAutoDisposition(campaign({ busy: 'retry_later' }), 'failed')).toBeNull();
    expect(resolveAutoDisposition(campaign({}), 'busy')).toBeNull();
    // A map that somehow carries a non-mappable key still stamps nothing for it.
    const c = campaign({ connected: 'retry_later', canceled: 'retry_later', agent_disconnected: 'retry_later' });
    for (const outcome of ['connected', 'canceled', 'agent_disconnected', 'orphaned', 'machine'] as const) {
      expect(resolveAutoDisposition(c, outcome)).toBeNull();
    }
  });

  it('stamps nothing when the stored code is no longer in the catalog, or now suppresses or is terminal', () => {
    expect(resolveAutoDisposition(campaign({ busy: 'gone' }), 'busy')).toBeNull();
    expect(resolveAutoDisposition(campaign({ busy: 'do_not_call' }), 'busy')).toBeNull();
    expect(resolveAutoDisposition(campaign({ busy: 'sale' }), 'busy')).toBeNull();
  });

  it('is safe on a malformed row (no map, an array, a non-string code, no catalog)', () => {
    expect(resolveAutoDisposition(campaign(undefined), 'busy')).toBeNull();
    expect(resolveAutoDisposition(campaign(['busy']), 'busy')).toBeNull();
    expect(resolveAutoDisposition(campaign({ busy: 7 }), 'busy')).toBeNull();
    expect(resolveAutoDisposition(campaign({ busy: '' }), 'busy')).toBeNull();
    expect(resolveAutoDisposition(campaign({ busy: 'retry_later' }, null), 'busy')).toBeNull();
    // An inherited property is not a mapping.
    expect(resolveAutoDisposition(campaign(Object.create({ busy: 'retry_later' })), 'busy')).toBeNull();
  });
});

describe('validateOutcomeDispositions — the internal handler (body over the stored campaign)', () => {
  const fields = (record: Record<string, unknown>, base = {}) =>
    Object.fromEntries(validateOutcomeDispositions(record, base).map((i) => [i.field, i.message]));

  it('accepts a body with neither key, and a valid map against the body catalog', () => {
    expect(validateOutcomeDispositions({ wrapup_seconds: 30 })).toEqual([]);
    expect(fields({ disposition_catalog: CATALOG, outcome_dispositions: { busy: 'retry_later', no_answer: 'callback' } })).toEqual({});
    expect(fields({ disposition_catalog: CATALOG, outcome_dispositions: {} })).toEqual({});
  });

  it('refuses a map that is not an object', () => {
    for (const bad of [null, [], 'busy', 3]) {
      expect(fields({ outcome_dispositions: bad }, { disposition_catalog: CATALOG }))
        .toEqual({ outcome_dispositions: 'outcome_dispositions must be an object keyed by outcome.' });
    }
  });

  it('refuses an outcome that cannot be mapped, saying why', () => {
    const out = fields({ outcome_dispositions: { connected: 'retry_later', canceled: 'retry_later', machine: 'retry_later', ringing: 'x' } }, { disposition_catalog: CATALOG });
    expect(out['outcome_dispositions.connected']).toMatch(/agent spoke to the customer/);
    expect(out['outcome_dispositions.canceled']).toMatch(/dial we stopped ourselves/);
    expect(out['outcome_dispositions.machine']).toMatch(/answering-machine detection is off/);
    expect(out['outcome_dispositions.ringing']).toBe(
      "'ringing' is not an unanswered-call outcome. Valid keys: no_answer, busy, failed, invalid, abandoned.");
  });

  it('refuses a value that is not a code string', () => {
    for (const bad of [null, 3, '', 'Retry Later', {}]) {
      expect(Object.keys(fields({ outcome_dispositions: { busy: bad } }, { disposition_catalog: CATALOG })))
        .toEqual(['outcome_dispositions.busy']);
    }
  });

  it('checks a map-only PATCH against the STORED catalog', () => {
    expect(fields({ outcome_dispositions: { busy: 'retry_later' } }, { disposition_catalog: CATALOG })).toEqual({});
    expect(fields({ outcome_dispositions: { busy: 'missing' } }, { disposition_catalog: CATALOG })).toEqual({
      'outcome_dispositions.busy': "'missing' is not in this campaign's outcome list. Pick an outcome from the list for “Busy” calls.",
    });
  });

  it('refuses a code that suppresses or is terminal (OD3)', () => {
    const out = fields({ outcome_dispositions: { busy: 'do_not_call', no_answer: 'sale' } }, { disposition_catalog: CATALOG });
    expect(out['outcome_dispositions.busy']).toMatch(/stops the number being called/);
    expect(out['outcome_dispositions.no_answer']).toMatch(/closes the contact/);
  });

  it('refuses a catalog-only PATCH that takes away or changes a STORED mapped code, keyed on the mapping (OD6)', () => {
    const base = { disposition_catalog: CATALOG, outcome_dispositions: { busy: 'retry_later', failed: 'callback' } };
    const without = CATALOG.filter((e) => e.code !== 'retry_later');
    expect(fields({ disposition_catalog: without }, base)).toEqual({
      'outcome_dispositions.busy':
        "The outcome list no longer has 'retry_later', the automatic outcome for “Busy” calls. Choose another automatic outcome for them first.",
    });
    const nowTerminal = CATALOG.map((e) => (e.code === 'callback' ? { ...e, terminal: true } : e));
    expect(Object.keys(fields({ disposition_catalog: nowTerminal }, base))).toEqual(['outcome_dispositions.failed']);
    // The same edit with the mapping cleared in the same body is fine.
    expect(fields({ disposition_catalog: without, outcome_dispositions: { failed: 'callback' } }, base)).toEqual({});
  });

  it('on a create (base: the column defaults), a map needs the catalog in the body', () => {
    expect(Object.keys(fields({ outcome_dispositions: { busy: 'retry_later' } }, CAMPAIGN_CONFIG_COLUMN_DEFAULTS)))
      .toEqual(['outcome_dispositions.busy']);
    expect(fields({ disposition_catalog: CATALOG, outcome_dispositions: { busy: 'retry_later' } }, CAMPAIGN_CONFIG_COLUMN_DEFAULTS))
      .toEqual({});
  });

  it('with no base, an absent side is unknown: the cross-field check waits for a body carrying both', () => {
    expect(fields({ outcome_dispositions: { busy: 'retry_later' } })).toEqual({});
    expect(fields({ disposition_catalog: [] })).toEqual({});
    // The shape is still checked on its own.
    expect(Object.keys(fields({ outcome_dispositions: { connected: 'x' } }))).toEqual(['outcome_dispositions.connected']);
  });

  it('runs inside validateAgencyCampaignConfig (internal) and validateAgencyCampaignConfig (public)', async () => {
    const { validateAgencyCampaignConfig: validateInternal } = await import('../../../src/agency/campaign-config.js');
    const body = { disposition_catalog: CATALOG, outcome_dispositions: { busy: 'do_not_call' } };
    expect(validateInternal(body).map((i) => i.field)).toContain('outcome_dispositions.busy');
    expect(validatePublic(body).map((i) => i.field)).toContain('outcome_dispositions.busy');
  });
});

describe('the public layer: shape always, the catalog cross-check only when the body carries both', () => {
  it('refuses a bad shape on its own', () => {
    expect(validatePublic({ outcome_dispositions: { connected: 'retry_later' } }).map((i) => i.field))
      .toEqual(['outcome_dispositions.connected']);
  });

  it('does not judge a map-only body (it does not hold the stored catalog: the internal handler does)', () => {
    expect(validatePublic({ outcome_dispositions: { busy: 'retry_later' } })).toEqual([]);
  });

  it('does not judge a catalog-only body either', () => {
    expect(validatePublic({ disposition_catalog: CATALOG })).toEqual([]);
  });
});
