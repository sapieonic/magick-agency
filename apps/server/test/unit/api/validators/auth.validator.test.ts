// PORT NOTE (magick-agency): ported from master test/unit/api/validators/auth.validator.test.ts@a1f0756a — verbatim, import specifiers remapped only.
import { describe, it, expect } from 'vitest';
import { sessionRequestSchema } from '../../../../src/api/validators/auth.validator.js';

describe('sessionRequestSchema', () => {
  describe('id_token', () => {
    it('should accept a valid token string', () => {
      expect(sessionRequestSchema.parse({ id_token: 'valid.jwt.token' }).id_token).toBe('valid.jwt.token');
    });

    it('should reject empty string', () => {
      expect(() => sessionRequestSchema.parse({ id_token: '' })).toThrow();
    });

    it('should reject missing id_token', () => {
      expect(() => sessionRequestSchema.parse({})).toThrow();
    });
  });

  describe('phone_number', () => {
    it('should accept a valid phone number', () => {
      const result = sessionRequestSchema.parse({ id_token: 'tok', phone_number: '+1234567890' });
      expect(result.phone_number).toBe('+1234567890');
    });

    it('should be optional', () => {
      const result = sessionRequestSchema.parse({ id_token: 'tok' });
      expect(result.phone_number).toBeUndefined();
    });

    it('should reject phone number shorter than 10 characters', () => {
      expect(() => sessionRequestSchema.parse({ id_token: 'tok', phone_number: '12345' })).toThrow();
    });

    it('should accept exactly 10 character phone number', () => {
      expect(sessionRequestSchema.parse({ id_token: 'tok', phone_number: '1234567890' })).toBeTruthy();
    });
  });
});
