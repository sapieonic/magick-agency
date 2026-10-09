/*
 * Phone-number validators. There is no telephony-provider update schema (the telephony-provider
 * CRUD routes are not registered), so the tests cover that the deleted schemas are gone, and
 * that `pool_eligible` is stripped (not refused) by the create and update schemas.
 */
import { describe, it, expect } from 'vitest';
import * as validators from '../../../../src/api/validators/phone-number.validator.js';
import {
  createPhoneNumberSchema,
  updatePhoneNumberSchema,
} from '../../../../src/api/validators/phone-number.validator.js';

describe('phone-number.validator — deleted schemas', () => {
  it('exports no telephony-provider or tagging schema', () => {
    expect(Object.keys(validators).sort()).toEqual([
      'assignPhoneNumberSchema',
      'createPhoneNumberSchema',
      'updatePhoneNumberSchema',
    ]);
  });
});

describe('createPhoneNumberSchema — pool_eligible removed', () => {
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

describe('updatePhoneNumberSchema — pool_eligible removed', () => {
  it('strips pool_eligible, leaving only the fields agency writes', () => {
    expect(updatePhoneNumberSchema.parse({ pool_eligible: true, label: 'Main' })).toEqual({ label: 'Main' });
  });

  it('a pool_eligible-only body parses to an empty update', () => {
    expect(updatePhoneNumberSchema.parse({ pool_eligible: false })).toEqual({});
  });
});
