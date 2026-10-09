/*
 * PORT NOTE (magick-agency): ported from master test/unit/api/validators/phone-number.validator.test.ts@a1f0756a
 * (8 cases → 6: 0 verbatim, 8 deleted, 6 NEW). Every source case exercises
 * `updateTelephonyProviderSchema` (migration 074's `live_transfer_enabled`), which
 * is deleted with the telephony-provider CRUD routes (see the validator's PORT
 * NOTE) — deleted: 'accepts a live_transfer_enabled toggle on its own',
 * 'accepts live_transfer_enabled alongside the existing fields',
 * 'leaves live_transfer_enabled absent when omitted (no implicit default)', and the
 * 5 `it.each` rows of 'rejects a non-boolean live_transfer_enabled (%j)'
 * ("true", 1, 0, null, "yes").
 * NEW: equivalence tests for the port's changes to this module — the deleted
 * schemas are gone, and `pool_eligible` is stripped (not refused) by the create and
 * update schemas.
 */
import { describe, it, expect } from 'vitest';
import * as validators from '../../../../src/api/validators/phone-number.validator.js';
import {
  createPhoneNumberSchema,
  updatePhoneNumberSchema,
} from '../../../../src/api/validators/phone-number.validator.js';

describe('phone-number.validator — deleted schemas (NEW)', () => {
  it('exports no telephony-provider or tagging schema', () => {
    expect(Object.keys(validators).sort()).toEqual([
      'assignPhoneNumberSchema',
      'createPhoneNumberSchema',
      'updatePhoneNumberSchema',
    ]);
  });
});

describe('createPhoneNumberSchema — pool_eligible removed (NEW)', () => {
  const valid = {
    phone_number: '+12025550100',
    provider_id: '11111111-1111-1111-1111-111111111111',
    max_concurrent_calls: 1,
  };

  it('accepts a valid number without pool_eligible', () => {
    expect(createPhoneNumberSchema.parse(valid)).toEqual(valid);
  });

  it('strips pool_eligible rather than refusing it (an old client is ignored)', () => {
    const parsed = createPhoneNumberSchema.safeParse({ ...valid, pool_eligible: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('pool_eligible' in parsed.data).toBe(false);
  });

  it('still refuses a non-E.164 number', () => {
    expect(createPhoneNumberSchema.safeParse({ ...valid, phone_number: '2025550100' }).success).toBe(false);
  });
});

describe('updatePhoneNumberSchema — pool_eligible removed (NEW)', () => {
  it('strips pool_eligible, leaving only the fields agency writes', () => {
    expect(updatePhoneNumberSchema.parse({ pool_eligible: true, label: 'Main' })).toEqual({ label: 'Main' });
  });

  it('a pool_eligible-only body parses to an empty update', () => {
    expect(updatePhoneNumberSchema.parse({ pool_eligible: false })).toEqual({});
  });
});
