/*
 * PORT NOTE (magick-agency): ported from master test/unit/api/validators/super-admin.validator.test.ts@a1f0756a
 * (37 cases → 54: 23 verbatim + 31 NEW). Deleted with `topupCreditsSchema` /
 * `deductCreditsSchema` (no credits in v1, plan §3.3 / Decided S6): the 7
 * `topupCreditsSchema` and 7 `deductCreditsSchema` cases, and their imports.
 * NEW (after the verbatim block): the agency schemas the port adds —
 * `addUserToTenantSchema.account_id`, `changeMembershipRoleSchema`,
 * `updateAgencyAccountSettingsSchema` and `usageCountsQuerySchema`.
 */
import { describe, it, expect } from 'vitest';
import {
  superAdminLoginSchema,
  createSuperAdminSchema,
  createTenantSchema,
  addUserToTenantSchema,
  superAdminAuditQuerySchema,
  changeMembershipRoleSchema,
  updateAgencyAccountSettingsSchema,
  usageCountsQuerySchema,
  USAGE_COUNTS_MAX_WINDOW_DAYS,
} from '../../../../src/api/validators/super-admin.validator.js';

describe('superAdminLoginSchema', () => {
  it('should accept valid email and password', () => {
    const result = superAdminLoginSchema.parse({ email: 'admin@example.com', password: 'secret' });
    expect(result.email).toBe('admin@example.com');
  });

  it('should reject invalid email', () => {
    expect(() => superAdminLoginSchema.parse({ email: 'not-email', password: 'secret' })).toThrow();
  });

  it('should reject empty password', () => {
    expect(() => superAdminLoginSchema.parse({ email: 'admin@example.com', password: '' })).toThrow();
  });
});

describe('createSuperAdminSchema', () => {
  const valid = { email: 'admin@example.com', password: 'password123', name: 'Admin' };

  it('should accept valid input', () => {
    expect(createSuperAdminSchema.parse(valid).email).toBe('admin@example.com');
  });

  it('should reject password shorter than 8 characters', () => {
    expect(() => createSuperAdminSchema.parse({ ...valid, password: 'short' })).toThrow();
  });

  it('should accept password exactly 8 characters', () => {
    expect(createSuperAdminSchema.parse({ ...valid, password: '12345678' })).toBeTruthy();
  });

  it('should reject empty name', () => {
    expect(() => createSuperAdminSchema.parse({ ...valid, name: '' })).toThrow();
  });

  it('should reject name exceeding 100 characters', () => {
    expect(() => createSuperAdminSchema.parse({ ...valid, name: 'a'.repeat(101) })).toThrow();
  });

  it('should reject invalid email', () => {
    expect(() => createSuperAdminSchema.parse({ ...valid, email: 'bad-email' })).toThrow();
  });
});

describe('createTenantSchema', () => {
  const valid = { name: 'Acme Corp', owner_email: 'owner@acme.com' };

  it('should accept valid name and owner_email', () => {
    expect(createTenantSchema.parse(valid).name).toBe('Acme Corp');
  });

  it('should reject empty name', () => {
    expect(() => createTenantSchema.parse({ ...valid, name: '' })).toThrow();
  });

  it('should reject name exceeding 200 characters', () => {
    expect(() => createTenantSchema.parse({ ...valid, name: 'a'.repeat(201) })).toThrow();
  });

  it('should reject invalid owner_email', () => {
    expect(() => createTenantSchema.parse({ ...valid, owner_email: 'not-email' })).toThrow();
  });

  it('should accept optional owner_name', () => {
    const result = createTenantSchema.parse({ ...valid, owner_name: 'Alice' });
    expect(result.owner_name).toBe('Alice');
  });

  it('should default owner_name to undefined when omitted', () => {
    expect(createTenantSchema.parse(valid).owner_name).toBeUndefined();
  });

  it('should reject owner_name exceeding 100 characters', () => {
    expect(() => createTenantSchema.parse({ ...valid, owner_name: 'a'.repeat(101) })).toThrow();
  });
});

describe('addUserToTenantSchema', () => {
  const valid = { email: 'user@example.com', role: 'operator' as const };

  it('should accept all valid roles', () => {
    for (const role of ['tenant_owner', 'tenant_admin', 'account_admin', 'operator', 'viewer'] as const) {
      expect(addUserToTenantSchema.parse({ ...valid, role })).toBeTruthy();
    }
  });

  it('should reject unknown role', () => {
    expect(() => addUserToTenantSchema.parse({ ...valid, role: 'superuser' })).toThrow();
  });

  it('should reject invalid email', () => {
    expect(() => addUserToTenantSchema.parse({ ...valid, email: 'bad' })).toThrow();
  });

  it('should accept optional name', () => {
    expect(addUserToTenantSchema.parse({ ...valid, name: 'Alice' }).name).toBe('Alice');
  });

  it('should reject name exceeding 100 characters', () => {
    expect(() => addUserToTenantSchema.parse({ ...valid, name: 'a'.repeat(101) })).toThrow();
  });
});

describe('superAdminAuditQuerySchema', () => {
  it('accepts an empty query and applies defaults', () => {
    const parsed = superAdminAuditQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it('rejects an unknown filter rather than stripping it', () => {
    const parsed = superAdminAuditQuerySchema.safeParse({ q: 'acme', search: 'acme' });
    expect(parsed.success).toBe(false);
  });
});

// ── PORT NOTE (magick-agency): NEW — the agency schemas ──────────────────────

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('addUserToTenantSchema — account_id (NEW)', () => {
  const valid = { email: 'user@example.com', role: 'agent' as const };

  it('leaves account_id undefined when omitted (a tenant-wide membership)', () => {
    expect(addUserToTenantSchema.parse(valid).account_id).toBeUndefined();
  });

  it('accepts a UUID account_id', () => {
    expect(addUserToTenantSchema.parse({ ...valid, account_id: UUID_A }).account_id).toBe(UUID_A);
  });

  it('rejects a non-UUID account_id (it would reach Postgres as 22P02)', () => {
    expect(addUserToTenantSchema.safeParse({ ...valid, account_id: 'acct-1' }).success).toBe(false);
  });

  it('accepts the agent role', () => {
    expect(addUserToTenantSchema.parse(valid).role).toBe('agent');
  });
});

describe('changeMembershipRoleSchema (NEW)', () => {
  it('accepts each of the six roles, tenant_owner included', () => {
    for (const role of ['tenant_owner', 'tenant_admin', 'account_admin', 'operator', 'viewer', 'agent'] as const) {
      expect(changeMembershipRoleSchema.parse({ role }).role).toBe(role);
    }
  });

  it('rejects an unknown role', () => {
    expect(changeMembershipRoleSchema.safeParse({ role: 'superuser' }).success).toBe(false);
  });

  it('requires role', () => {
    expect(changeMembershipRoleSchema.safeParse({ reason: 'promote' }).success).toBe(false);
  });

  it('accepts a reason of exactly 500 characters and rejects 501', () => {
    expect(changeMembershipRoleSchema.safeParse({ role: 'viewer', reason: 'a'.repeat(500) }).success).toBe(true);
    expect(changeMembershipRoleSchema.safeParse({ role: 'viewer', reason: 'a'.repeat(501) }).success).toBe(false);
  });
});

describe('updateAgencyAccountSettingsSchema (NEW)', () => {
  it('accepts webrtc_max_duration_seconds at both bounds (60 and 14400)', () => {
    expect(updateAgencyAccountSettingsSchema.parse({ webrtc_max_duration_seconds: 60 }).webrtc_max_duration_seconds).toBe(60);
    expect(updateAgencyAccountSettingsSchema.parse({ webrtc_max_duration_seconds: 14_400 }).webrtc_max_duration_seconds).toBe(14_400);
  });

  it.each([59, 14_401, 0, -1])('rejects webrtc_max_duration_seconds out of 60..14400 (%j)', (value) => {
    expect(updateAgencyAccountSettingsSchema.safeParse({ webrtc_max_duration_seconds: value }).success).toBe(false);
  });

  it('rejects a non-integer webrtc_max_duration_seconds', () => {
    expect(updateAgencyAccountSettingsSchema.safeParse({ webrtc_max_duration_seconds: 60.5 }).success).toBe(false);
  });

  it('accepts allow_recording or analyze_calls on its own (a PATCH)', () => {
    expect(updateAgencyAccountSettingsSchema.parse({ allow_recording: false })).toEqual({ allow_recording: false });
    expect(updateAgencyAccountSettingsSchema.parse({ analyze_calls: true })).toEqual({ analyze_calls: true });
  });

  it('is strict: max_concurrent_calls (the concurrency route\'s field) is a 400, not silently ignored', () => {
    const parsed = updateAgencyAccountSettingsSchema.safeParse({ allow_recording: true, max_concurrent_calls: 5 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty body and a reason-only body (nothing to write)', () => {
    expect(updateAgencyAccountSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateAgencyAccountSettingsSchema.safeParse({ reason: 'why not' }).success).toBe(false);
  });

  it('bounds reason at 500 characters', () => {
    expect(updateAgencyAccountSettingsSchema.safeParse({ analyze_calls: true, reason: 'a'.repeat(500) }).success).toBe(true);
    expect(updateAgencyAccountSettingsSchema.safeParse({ analyze_calls: true, reason: 'a'.repeat(501) }).success).toBe(false);
  });

  it('a dirty value reaching the .refine does not throw — it is a failed parse (400), not a 500', () => {
    for (const body of [
      { webrtc_max_duration_seconds: 59.5 },
      { webrtc_max_duration_seconds: 'abc' },
      { allow_recording: 'yes', extra: 1 },
      null,
    ]) {
      expect(() => updateAgencyAccountSettingsSchema.safeParse(body)).not.toThrow();
      expect(updateAgencyAccountSettingsSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('usageCountsQuerySchema (NEW)', () => {
  const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };

  it('accepts an ISO from/to window on its own', () => {
    expect(usageCountsQuerySchema.parse(window)).toEqual(window);
  });

  it('accepts from/to with an explicit offset', () => {
    expect(usageCountsQuerySchema.safeParse({ from: '2026-09-01T00:00:00+05:30', to: '2026-09-02T00:00:00+05:30' }).success).toBe(true);
  });

  it.each([
    ['from', '2026-09-01'],
    ['from', 'yesterday'],
    ['to', '1759276800000'],
  ])('rejects a non-ISO-datetime %s (%j)', (key, value) => {
    expect(usageCountsQuerySchema.safeParse({ ...window, [key]: value }).success).toBe(false);
  });

  it('requires both from and to', () => {
    expect(usageCountsQuerySchema.safeParse({ from: window.from }).success).toBe(false);
    expect(usageCountsQuerySchema.safeParse({ to: window.to }).success).toBe(false);
  });

  it('rejects from equal to or after to, on path to', () => {
    const equal = usageCountsQuerySchema.safeParse({ from: window.from, to: window.from });
    expect(equal.success).toBe(false);
    const reversed = usageCountsQuerySchema.safeParse({ from: window.to, to: window.from });
    expect(reversed.success).toBe(false);
    if (!reversed.success) expect(reversed.error.issues.map((i) => i.path.join('.'))).toContain('to');
  });

  it('accepts tenant_id alone and tenant_id with account_id', () => {
    expect(usageCountsQuerySchema.safeParse({ ...window, tenant_id: UUID_A }).success).toBe(true);
    expect(usageCountsQuerySchema.safeParse({ ...window, tenant_id: UUID_A, account_id: UUID_B }).success).toBe(true);
  });

  it('rejects account_id without tenant_id, on path account_id', () => {
    const parsed = usageCountsQuerySchema.safeParse({ ...window, account_id: UUID_B });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((i) => i.path.join('.'))).toContain('account_id');
  });

  it('rejects a non-UUID tenant_id or account_id', () => {
    expect(usageCountsQuerySchema.safeParse({ ...window, tenant_id: 'tenant-1' }).success).toBe(false);
    expect(usageCountsQuerySchema.safeParse({ ...window, tenant_id: UUID_A, account_id: 'acct-1' }).success).toBe(false);
  });

  it('is strict: rejects an unknown filter rather than stripping it', () => {
    expect(usageCountsQuerySchema.safeParse({ ...window, campaign_id: UUID_A }).success).toBe(false);
  });

  it('a dirty value reaching the .refine chain does not throw — it is a failed parse (400), not a 500', () => {
    for (const query of [
      { from: 'garbage', to: 'also-garbage' },
      { from: 'garbage', to: window.to, account_id: UUID_B },
      { from: 123, to: window.to },
      { ...window, tenant_id: 'nope', account_id: 'nope' },
      { ...window, unknown: 'x' },
      null,
    ]) {
      expect(() => usageCountsQuerySchema.safeParse(query)).not.toThrow();
      expect(usageCountsQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it('accepts a window of exactly USAGE_COUNTS_MAX_WINDOW_DAYS (400) days, and a whole leap year', () => {
    expect(USAGE_COUNTS_MAX_WINDOW_DAYS).toBe(400);
    expect(usageCountsQuerySchema.safeParse({
      from: '2026-01-01T00:00:00.000Z', to: '2027-02-05T00:00:00.000Z', // 400 days
    }).success).toBe(true);
    expect(usageCountsQuerySchema.safeParse({
      from: '2028-01-01T00:00:00.000Z', to: '2029-01-01T00:00:00.000Z', // 366 days
    }).success).toBe(true);
  });

  it('refuses a window longer than 400 days, with the issue on `to`', () => {
    const parsed = usageCountsQuerySchema.safeParse({
      from: '2026-01-01T00:00:00.000Z', to: '2027-02-05T00:00:00.001Z', // 400 days + 1 ms
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues).toEqual([
      expect.objectContaining({ path: ['to'], message: 'The window may span at most 400 days' }),
    ]);
  });
});
