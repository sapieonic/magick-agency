import { describe, it, expect } from 'vitest';
import { inviteUserSchema, updateRoleSchema } from '../../../../src/api/validators/user.validator.js';

describe('inviteUserSchema', () => {
  const valid = { email: 'user@example.com', role: 'operator' as const };

  it('should accept valid email and role', () => {
    expect(inviteUserSchema.parse(valid).email).toBe('user@example.com');
  });

  it('should reject invalid email format', () => {
    expect(() => inviteUserSchema.parse({ ...valid, email: 'not-an-email' })).toThrow();
  });

  it('should accept all valid invite roles', () => {
    for (const role of ['account_admin', 'operator', 'viewer'] as const) {
      expect(inviteUserSchema.parse({ ...valid, role })).toBeTruthy();
    }
  });

  it('should reject roles not in invite role set (tenant_owner, tenant_admin)', () => {
    expect(() => inviteUserSchema.parse({ ...valid, role: 'tenant_owner' })).toThrow();
    expect(() => inviteUserSchema.parse({ ...valid, role: 'tenant_admin' })).toThrow();
  });

  it('should reject unknown role', () => {
    expect(() => inviteUserSchema.parse({ ...valid, role: 'superuser' })).toThrow();
  });

  it('should accept optional valid UUID account_id', () => {
    const result = inviteUserSchema.parse({ ...valid, account_id: '123e4567-e89b-12d3-a456-426614174000' });
    expect(result.account_id).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('should be optional when account_id is omitted', () => {
    expect(inviteUserSchema.parse(valid).account_id).toBeUndefined();
  });

  it('should reject non-UUID account_id', () => {
    expect(() => inviteUserSchema.parse({ ...valid, account_id: 'not-a-uuid' })).toThrow();
  });
});

describe('updateRoleSchema', () => {
  it('should accept all valid update roles', () => {
    for (const role of ['tenant_admin', 'account_admin', 'operator', 'viewer'] as const) {
      expect(updateRoleSchema.parse({ role })).toBeTruthy();
    }
  });

  it('should reject tenant_owner role', () => {
    expect(() => updateRoleSchema.parse({ role: 'tenant_owner' })).toThrow();
  });

  it('should reject unknown role', () => {
    expect(() => updateRoleSchema.parse({ role: 'superuser' })).toThrow();
  });

  it('should reject missing role', () => {
    expect(() => updateRoleSchema.parse({})).toThrow();
  });
});
