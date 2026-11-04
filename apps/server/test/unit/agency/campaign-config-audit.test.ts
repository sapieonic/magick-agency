import { describe, expect, it } from 'vitest';
import {
  CONFIG_AUDIT_MAX_LIST_VALUES,
  campaignConfigChange,
  decodeConfigChange,
  encodeConfigChange,
} from '../../../src/agency/campaign-config-audit.js';

/** The handler's serialisation of a campaign, before a PATCH. */
const BEFORE = {
  id: 'c1',
  name: 'Q4 Renewals',
  calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5],
  wrapup_seconds: 30,
  record_calls: false,
  analysis_profile_id: null,
  retry_policy: { no_answer: { max_attempts: 3, backoff_seconds: 600 } },
  disposition_catalog: [{ code: 'sale', label: 'Sale', is_success: true }],
  updated_at: '2026-11-01T10:00:00.000Z',
};

describe('campaignConfigChange (IN8)', () => {
  it('names every changed field and carries from/to for the small ones only', () => {
    const after = {
      ...BEFORE,
      calling_window_end: '21:00:00',
      calling_days: [1, 2, 3, 4, 5, 6],
      record_calls: true,
      retry_policy: { no_answer: { max_attempts: 2, backoff_seconds: 600 } },
      updated_at: '2026-11-04T10:00:00.000Z',
    };
    const body = {
      calling_window_end: '21:00', calling_days: [1, 2, 3, 4, 5, 6], record_calls: true,
      retry_policy: after.retry_policy, name: 'Q4 Renewals',
    };

    expect(campaignConfigChange(body, BEFORE, after)).toEqual({
      // Body order; `name` was sent but is unchanged, so it is not named.
      fields: ['calling_window_end', 'calling_days', 'record_calls', 'retry_policy'],
      changes: {
        // The stored values, not the body's `21:00`.
        calling_window_end: { from: '20:00:00', to: '21:00:00' },
        calling_days: { from: [1, 2, 3, 4, 5], to: [1, 2, 3, 4, 5, 6] },
        record_calls: { from: false, to: true },
        // retry_policy: a JSON field, a name only.
      },
    });
  });

  it('is null when nothing the body named changed — no row', () => {
    const body = { name: 'Q4 Renewals', calling_window_end: '20:00', retry_policy: BEFORE.retry_policy };
    expect(campaignConfigChange(body, BEFORE, { ...BEFORE, updated_at: 'later' })).toBeNull();
  });

  it('never names a field the handler stamps itself, nor one it does not serve', () => {
    const after = { ...BEFORE, updated_at: 'later' };
    expect(campaignConfigChange({ updated_at: 'x', nonsense: 1 }, BEFORE, after)).toBeNull();
  });

  it('carries a null on either side (a profile set or cleared)', () => {
    const after = { ...BEFORE, analysis_profile_id: 'p-1' };
    expect(campaignConfigChange({ analysis_profile_id: 'p-1' }, BEFORE, after)?.changes)
      .toEqual({ analysis_profile_id: { from: null, to: 'p-1' } });
  });

  it('names a long list without its values', () => {
    const long = Array.from({ length: CONFIG_AUDIT_MAX_LIST_VALUES + 1 }, (_, i) => `+9190000000${i}`);
    const before = { ...BEFORE, caller_ids: ['+919000000001'] };
    const change = campaignConfigChange({ caller_ids: long }, before, { ...before, caller_ids: long });
    expect(change).toEqual({ fields: ['caller_ids'], changes: {} });
  });

  it('is null on a body or side that is not an object', () => {
    expect(campaignConfigChange(null, BEFORE, BEFORE)).toBeNull();
    expect(campaignConfigChange({ name: 'x' }, null, BEFORE)).toBeNull();
  });
});

describe('the header encoding', () => {
  it('round-trips, a non-ASCII name included', () => {
    const change = { fields: ['name'], changes: { name: { from: 'नवीनीकरण', to: 'Renewals' } } };
    const encoded = encodeConfigChange(change);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeConfigChange(encoded)).toEqual(change);
  });

  it('reads absent or malformed as no change, never a throw', () => {
    expect(decodeConfigChange(null)).toBeNull();
    expect(decodeConfigChange(undefined)).toBeNull();
    expect(decodeConfigChange('%%%')).toBeNull();
    expect(decodeConfigChange(Buffer.from('{"fields":[]}').toString('base64url'))).toBeNull();
    expect(decodeConfigChange(Buffer.from('{"fields":[1]}').toString('base64url'))).toBeNull();
  });
});
