import { describe, it, expect } from 'vitest';
import { ApiError } from '../../api/client';
import { sessionRefusalCode } from '../../utils/sessionRefusal';

/** NEW (magick-agency): the classifier for agency's path-4 refusal (plan §3.1). */
describe('sessionRefusalCode', () => {
  it('reads `no_membership` off a 403', () => {
    expect(
      sessionRefusalCode(new ApiError(403, { error: 'Forbidden', code: 'no_membership', message: 'm' })),
    ).toBe('no_membership');
  });

  it('reads `email_unverified` off a 403', () => {
    expect(
      sessionRefusalCode(new ApiError(403, { error: 'Forbidden', code: 'email_unverified', message: 'm' })),
    ).toBe('email_unverified');
  });

  it('is null for a 403 with no code, or a code it does not know', () => {
    expect(sessionRefusalCode(new ApiError(403, { error: 'Forbidden', message: 'm' }))).toBeNull();
    expect(sessionRefusalCode(new ApiError(403, { code: 'capability_disabled' }))).toBeNull();
  });

  it('is null for the right code on the wrong status', () => {
    expect(sessionRefusalCode(new ApiError(401, { code: 'no_membership' }))).toBeNull();
    expect(sessionRefusalCode(new ApiError(500, { code: 'no_membership' }))).toBeNull();
  });

  it('is null for anything that is not an ApiError', () => {
    expect(sessionRefusalCode(new Error('no_membership'))).toBeNull();
    expect(sessionRefusalCode({ statusCode: 403, details: { code: 'no_membership' } })).toBeNull();
    expect(sessionRefusalCode(undefined)).toBeNull();
  });
});
