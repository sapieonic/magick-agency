import { describe, it, expect } from 'vitest';
import { sessionLinkEmail } from '../../../src/auth/session-email.js';

describe('sessionLinkEmail', () => {
  it('is verified only when email_verified is the boolean true', () => {
    expect(sessionLinkEmail({
      uid: 'fb-1', email: 'owner@customer.com', email_verified: true,
    })).toEqual({ status: 'verified', email: 'owner@customer.com' });
  });

  it('trims a verified address so a padded token still matches the stub', () => {
    expect(sessionLinkEmail({
      uid: 'fb-1', email: '  owner@customer.com  ', email_verified: true,
    })).toEqual({ status: 'verified', email: 'owner@customer.com' });
  });

  it('is unverified when the flag is false', () => {
    expect(sessionLinkEmail({
      uid: 'fb-1', email: 'owner@customer.com', email_verified: false,
    })).toEqual({ status: 'unverified' });
  });

  it('is unverified when the flag is missing — fail closed, not "treat as Google"', () => {
    // Firebase email/password tokens carry the flag as false; a decoder that
    // dropped it must not become an adopt. `!== true` is the whole rule.
    expect(sessionLinkEmail({ uid: 'fb-1', email: 'owner@customer.com' }))
      .toEqual({ status: 'unverified' });
  });

  it('is unverified for a truthy non-boolean flag', () => {
    // `if (email_verified)` would treat these as verified. The predicate is
    // `=== true`; anything else with an email present is a refusal.
    for (const email_verified of ['true', 1, {}] as unknown as boolean[]) {
      expect(sessionLinkEmail({
        uid: 'fb-1', email: 'owner@customer.com', email_verified,
      })).toEqual({ status: 'unverified' });
    }
  });

  it('is none when there is no email, including whitespace-only', () => {
    expect(sessionLinkEmail({ uid: 'fb-1' })).toEqual({ status: 'none' });
    expect(sessionLinkEmail({ uid: 'fb-1', email: '', email_verified: true }))
      .toEqual({ status: 'none' });
    expect(sessionLinkEmail({ uid: 'fb-1', email: '   ', email_verified: false }))
      .toEqual({ status: 'none' });
  });
});
