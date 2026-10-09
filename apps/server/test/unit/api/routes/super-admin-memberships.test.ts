/*
 * NEW (magick-agency): no master source file. Master's super-admin add-user and
 * create-tenant were untested at the route layer; role change and revoke on a
 * membership are NEW routes (plan §3.4). Covers `POST /super-admin/tenants`,
 * `POST /super-admin/tenants/:id/users`, `PUT …/memberships/:membershipId/role`
 * and `DELETE …/memberships/:membershipId` in
 * `apps/server/src/api/routes/super-admin.routes.ts`, through the REAL
 * super-admin JWT middleware (signed with `SUPER_ADMIN_JWT_SECRET`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'test-super-admin-secret-at-least-16';
  /** Records any property read, so "never touched" is assertable on a whole repository. */
  const touched: string[] = [];
  const untouchable = (name: string) => new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      touched.push(`${name}.${String(prop)}`);
      return vi.fn();
    },
  });
  return {
    touched,
    untouchable,
    superAdminRepository: { findById: vi.fn() },
    tenantRepository: { findById: vi.fn() },
    accountRepository: { findByIdInTenant: vi.fn() },
    userRepository: { resolveByProvenEmail: vi.fn() },
    membershipRepository: {
      findByIdInTenant: vi.fn(),
      updateRoleGuardingLastOwner: vi.fn(),
      removeGuardingLastOwner: vi.fn(),
      findByUserAndTenant: vi.fn(),
      findAnyByUserAndTenant: vi.fn(),
    },
    closeAllForUser: vi.fn(),
    redisDel: vi.fn(),
    // Q5: what the revocation delete reports (true unless a case says the Redis DEL failed).
    revocation: { cleared: true },
    issueInvite: vi.fn(),
    auditLog: vi.fn(),
    client: { query: vi.fn(), release: vi.fn() },
    connect: vi.fn(),
  };
});

vi.mock('@magick-agency/db/repositories/super-admin.repository', () => ({
  superAdminRepository: mocks.superAdminRepository,
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: mocks.tenantRepository,
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: mocks.accountRepository,
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: mocks.userRepository,
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: mocks.membershipRepository,
}));
vi.mock('@magick-agency/db/repositories/super-admin-audit.repository', () => ({
  superAdminAuditRepository: { log: mocks.auditLog },
}));
vi.mock('@magick-agency/db/repositories/agency-campaign-agent.repository', () => ({
  agencyCampaignAgentRepository: { closeAllForUser: mocks.closeAllForUser },
}));
// Tenant create must not touch a number pool: any read of either repository is recorded.
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: mocks.untouchable('tenantPhoneAssignmentRepository'),
}));
vi.mock('@magick-agency/db/repositories/phone-number.repository', () => ({
  phoneNumberRepository: mocks.untouchable('phoneNumberRepository'),
}));
vi.mock('@magick-agency/db/repositories/provider-concurrency.repository', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  providerConcurrencyRepository: {},
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {},
}));
vi.mock('@magick-agency/db', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));
vi.mock('../../../../src/cache/redis-cache.js', () => ({
  // Q5 (Manas, 2026-10-09): revocation deletes go through `delForRevocation` (retried, reports
  // failure); this double forwards to the `del` mock and reports success, so the assertions on
  // `del` still observe the key.
  redisCache: { del: mocks.redisDel, delForRevocation: async (...k: string[]) => { await mocks.redisDel(...k); return mocks.revocation.cleared; } },
}));
vi.mock('../../../../src/invites/invite-issuer.js', () => ({
  issueInvite: mocks.issueInvite,
}));
vi.mock('../../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: vi.fn() },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { superAdminRoutes } from '../../../../src/api/routes/super-admin.routes.js';
import { UNVERIFIED_ADDRESS_HOLDER } from '../../../../src/auth/firebase-identity.js';

const SECRET = 'test-super-admin-secret-at-least-16';
const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'root@magick.test', name: 'Root', status: 'active' };
const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const OTHER_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const NEW_USER = '55555555-5555-4555-8555-555555555555';
const MEMBERSHIP = '66666666-6666-4666-8666-666666666666';
const LEFTOVER = '77777777-7777-4777-8777-777777777777';
const OTHER_MEMBERSHIP = '88888888-8888-4888-8888-888888888888';
const NEW_TENANT = '99999999-9999-4999-8999-999999999999';

function token(secret = SECRET): string {
  return jwt.sign({ sub: ADMIN.id, email: ADMIN.email, type: 'super_admin' }, secret, { expiresIn: '1h' });
}
const auth = () => ({ authorization: `Bearer ${token()}` });

/** The SQL a call ran, whitespace-collapsed. */
function sqlOf(call: unknown[]): string {
  return String(call[0]).replace(/\s+/g, ' ').trim();
}
function sqlCalls(): Array<{ sql: string; params: unknown[] | undefined }> {
  return mocks.client.query.mock.calls.map((c) => ({ sql: sqlOf(c), params: c[1] as unknown[] | undefined }));
}
function indexOfSql(fragment: string): number {
  return sqlCalls().findIndex((c) => c.sql.includes(fragment));
}

/**
 * The transaction client. Answers each statement the two routes issue; the rows
 * in `db` drive the branch under test.
 */
const db: {
  existingMemberships: Array<{ id: string; account_id: string | null; status: string }>;
  failOn?: string;
} = { existingMemberships: [] };

function installClient(): void {
  mocks.client.query.mockImplementation(async (text: string, params?: unknown[]) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (db.failOn && sql.includes(db.failOn)) throw new Error(`boom: ${db.failOn}`);
    if (sql.startsWith('INSERT INTO tenants')) {
      return { rows: [{ id: NEW_TENANT, name: params?.[0], slug: params?.[1], status: 'active' }] };
    }
    if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: NEW_USER }] };
    if (sql.startsWith('SELECT * FROM memberships')) return { rows: db.existingMemberships };
    if (sql.startsWith('INSERT INTO memberships (user_id, tenant_id, account_id, role)')) {
      return { rows: [{ id: MEMBERSHIP, user_id: params?.[0], tenant_id: params?.[1], account_id: params?.[2], role: params?.[3], status: 'active' }] };
    }
    if (sql.startsWith('INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)')) {
      return { rows: [{ id: MEMBERSHIP, user_id: params?.[0], tenant_id: params?.[1], account_id: null, role: params?.[2], status: 'active' }] };
    }
    if (sql.startsWith(`UPDATE memberships SET status = 'active'`)) {
      const row = db.existingMemberships.find((m) => m.id === params?.[1]);
      return { rows: [{ ...row, role: params?.[0], status: 'active' }] };
    }
    return { rows: [] };
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.touched.length = 0;
  db.existingMemberships = [];
  db.failOn = undefined;
  installClient();
  mocks.connect.mockResolvedValue(mocks.client);
  mocks.superAdminRepository.findById.mockImplementation(async (id: string) => (id === ADMIN.id ? ADMIN : null));
  mocks.tenantRepository.findById.mockImplementation(async (id: string) => (id === TENANT ? { id: TENANT, name: 'Acme' } : null));
  mocks.accountRepository.findByIdInTenant.mockImplementation(async (id: string, tenantId: string) =>
    (id === ACCOUNT && tenantId === TENANT ? { id: ACCOUNT, tenant_id: TENANT } : null));
  mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'none' });
  mocks.redisDel.mockResolvedValue(undefined);
  mocks.revocation.cleared = true;
  mocks.auditLog.mockResolvedValue(undefined);
  mocks.issueInvite.mockResolvedValue({
    invite: { id: 'invite-1' }, signInUrl: 'https://app.example.com/join?t=x', inviteEmail: { sent: true },
  });
  mocks.closeAllForUser.mockResolvedValue([]);
  app = Fastify({ logger: false });
  await app.register(superAdminRoutes, { prefix: '/super-admin' });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// ── Authentication ──────────────────────────────────────────────────────────

describe('every membership/tenant route requires a super-admin JWT', () => {
  const routes = [
    { method: 'POST' as const, url: '/super-admin/tenants', payload: { name: 'Acme', owner_email: 'o@acme.test' } },
    { method: 'POST' as const, url: `/super-admin/tenants/${TENANT}/users`, payload: { email: 'a@acme.test', role: 'agent' } },
    { method: 'PUT' as const, url: `/super-admin/tenants/${TENANT}/memberships/${MEMBERSHIP}/role`, payload: { role: 'viewer' } },
    { method: 'DELETE' as const, url: `/super-admin/tenants/${TENANT}/memberships/${MEMBERSHIP}`, payload: undefined },
  ];

  it.each(routes)('$method $url → 401 without a bearer token', async ({ method, url, payload }) => {
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(res.statusCode).toBe(401);
    expect(mocks.tenantRepository.findById).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(routes)('$method $url → 401 with a token signed by another secret', async ({ method, url, payload }) => {
    const res = await app.inject({
      method, url, headers: { authorization: `Bearer ${token('a-different-secret-of-16+chars')}` },
      ...(payload ? { payload } : {}),
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.tenantRepository.findById).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('401s a well-signed token whose type is not super_admin', async () => {
    const userToken = jwt.sign({ sub: ADMIN.id, email: ADMIN.email, type: 'user' }, SECRET);
    const res = await app.inject({
      method: 'DELETE', url: `/super-admin/tenants/${TENANT}/memberships/${MEMBERSHIP}`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.membershipRepository.removeGuardingLastOwner).not.toHaveBeenCalled();
  });
});

// ── POST /super-admin/tenants/:id/users ─────────────────────────────────────

describe('POST /super-admin/tenants/:id/users', () => {
  const url = `/super-admin/tenants/${TENANT}/users`;
  const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: auth(), payload });

  it('404s an unknown tenant before opening a transaction', async () => {
    const res = await app.inject({
      method: 'POST', url: `/super-admin/tenants/${NEW_TENANT}/users`, headers: auth(),
      payload: { email: 'a@acme.test', role: 'agent' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Tenant not found');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('400s an account_id that belongs to another tenant, looked up scoped to THIS tenant', async () => {
    const res = await post({ email: 'a@acme.test', role: 'agent', account_id: OTHER_ACCOUNT });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Bad Request', message: 'account_id does not belong to this tenant.' });
    expect(mocks.accountRepository.findByIdInTenant).toHaveBeenCalledWith(OTHER_ACCOUNT, TENANT);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.issueInvite).not.toHaveBeenCalled();
  });

  it('400s a malformed account_id (validator) without a lookup', async () => {
    const res = await post({ email: 'a@acme.test', role: 'agent', account_id: 'not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(mocks.accountRepository.findByIdInTenant).not.toHaveBeenCalled();
  });

  it('tenant-wide: creates a pending_ stub when no proven user holds the address, and a tenant-level membership', async () => {
    const res = await post({ email: 'new@acme.test', role: 'agent', name: 'New Agent' });

    expect(res.statusCode).toBe(201);
    expect(mocks.userRepository.resolveByProvenEmail).toHaveBeenCalledWith('new@acme.test', {
      client: mocks.client, lock: true,
    });
    const userInsert = sqlCalls().find((c) => c.sql.startsWith('INSERT INTO users'))!;
    expect(userInsert.params![0]).toMatch(/^pending_[0-9a-f-]{36}$/);
    expect(userInsert.params!.slice(1)).toEqual(['new@acme.test', 'New Agent']);
    const membershipInsert = sqlCalls().find((c) => c.sql.startsWith('INSERT INTO memberships'))!;
    expect(membershipInsert.sql).toContain('INSERT INTO memberships (user_id, tenant_id, role)');
    expect(membershipInsert.params).toEqual([NEW_USER, TENANT, 'agent']);
    expect(res.json().membership).toMatchObject({ id: MEMBERSHIP, account_id: null, role: 'agent' });
    expect(mocks.redisDel).toHaveBeenCalledWith(`cache:membership:${NEW_USER}:${TENANT}`);
  });

  it('with account_id: writes an account-scoped membership', async () => {
    const res = await post({ email: 'new@acme.test', role: 'agent', account_id: ACCOUNT });

    expect(res.statusCode).toBe(201);
    expect(mocks.accountRepository.findByIdInTenant).toHaveBeenCalledWith(ACCOUNT, TENANT);
    const membershipInsert = sqlCalls().find((c) => c.sql.startsWith('INSERT INTO memberships'))!;
    expect(membershipInsert.sql).toContain('INSERT INTO memberships (user_id, tenant_id, account_id, role)');
    expect(membershipInsert.params).toEqual([NEW_USER, TENANT, ACCOUNT, 'agent']);
    expect(res.json().membership).toMatchObject({ account_id: ACCOUNT });
  });

  it('reuses a proven user and writes no stub', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: USER } });
    const res = await post({ email: 'known@acme.test', role: 'operator' });

    expect(res.statusCode).toBe(201);
    expect(indexOfSql('INSERT INTO users')).toBe(-1);
    expect(sqlCalls().find((c) => c.sql.startsWith('SELECT * FROM memberships'))!.params).toEqual([USER, TENANT]);
    expect(sqlCalls().find((c) => c.sql.startsWith('INSERT INTO memberships'))!.params).toEqual([USER, TENANT, 'operator']);
  });

  it('409 UNVERIFIED_ADDRESS_HOLDER when only an unproven row holds the address; rolls back, writes nothing', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'unproven_conflict' });
    const res = await post({ email: 'claimed@acme.test', role: 'agent' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'Conflict', code: UNVERIFIED_ADDRESS_HOLDER });
    expect(res.json().message).toContain('then add them again');
    expect(indexOfSql('ROLLBACK')).toBeGreaterThan(-1);
    expect(indexOfSql('COMMIT')).toBe(-1);
    expect(indexOfSql('INSERT INTO users')).toBe(-1);
    expect(indexOfSql('INSERT INTO memberships')).toBe(-1);
    expect(mocks.client.release).toHaveBeenCalled();
    expect(mocks.issueInvite).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('tenant context: ANY active membership (even account-scoped) is a 409 "member of this tenant"', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: USER } });
    db.existingMemberships = [{ id: OTHER_MEMBERSHIP, account_id: ACCOUNT, status: 'active' }];
    const res = await post({ email: 'known@acme.test', role: 'agent' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Conflict', message: 'User is already a member of this tenant' });
    expect(indexOfSql('ROLLBACK')).toBeGreaterThan(-1);
    expect(indexOfSql('INSERT INTO memberships')).toBe(-1);
    expect(mocks.issueInvite).not.toHaveBeenCalled();
  });

  it('account context: an active membership on THAT account is a 409 "member of this account"', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: USER } });
    db.existingMemberships = [{ id: OTHER_MEMBERSHIP, account_id: ACCOUNT, status: 'active' }];
    const res = await post({ email: 'known@acme.test', role: 'agent', account_id: ACCOUNT });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Conflict', message: 'User is already a member of this account' });
    expect(indexOfSql('INSERT INTO memberships')).toBe(-1);
  });

  it('account context: an active TENANT-WIDE membership does not block an account-scoped add', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: USER } });
    db.existingMemberships = [{ id: OTHER_MEMBERSHIP, account_id: null, status: 'active' }];
    const res = await post({ email: 'known@acme.test', role: 'agent', account_id: ACCOUNT });

    expect(res.statusCode).toBe(201);
    expect(sqlCalls().find((c) => c.sql.startsWith('INSERT INTO memberships'))!.params).toEqual([USER, TENANT, ACCOUNT, 'agent']);
    // The tenant-wide row is left alone.
    expect(indexOfSql(`UPDATE memberships SET status = 'active'`)).toBe(-1);
  });

  it('tenant context: reactivates a revoked tenant-level leftover with the requested role instead of inserting', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: USER } });
    db.existingMemberships = [
      { id: OTHER_MEMBERSHIP, account_id: ACCOUNT, status: 'revoked' },
      { id: LEFTOVER, account_id: null, status: 'revoked' },
    ];
    const res = await post({ email: 'known@acme.test', role: 'viewer' });

    expect(res.statusCode).toBe(201);
    const update = sqlCalls().find((c) => c.sql.startsWith(`UPDATE memberships SET status = 'active'`))!;
    expect(update.params).toEqual(['viewer', LEFTOVER]);
    expect(indexOfSql('INSERT INTO memberships')).toBe(-1);
    expect(res.json().membership).toMatchObject({ id: LEFTOVER, role: 'viewer', status: 'active' });
  });

  it('account context: reactivates that account\'s leftover, never the tenant-level one', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: USER } });
    db.existingMemberships = [
      { id: OTHER_MEMBERSHIP, account_id: null, status: 'revoked' },
      { id: LEFTOVER, account_id: ACCOUNT, status: 'revoked' },
    ];
    const res = await post({ email: 'known@acme.test', role: 'agent', account_id: ACCOUNT });

    expect(res.statusCode).toBe(201);
    const update = sqlCalls().find((c) => c.sql.startsWith(`UPDATE memberships SET status = 'active'`))!;
    expect(update.params).toEqual(['agent', LEFTOVER]);
    expect(indexOfSql('INSERT INTO memberships')).toBe(-1);
  });

  it('locks the user\'s memberships in this tenant FOR UPDATE inside the transaction', async () => {
    await post({ email: 'new@acme.test', role: 'agent' });
    const select = sqlCalls().find((c) => c.sql.startsWith('SELECT * FROM memberships'))!;
    expect(select.sql).toContain('FOR UPDATE');
    expect(indexOfSql('BEGIN')).toBeLessThan(indexOfSql('SELECT * FROM memberships'));
  });

  it('revokes the membership\'s outstanding invites in the SAME transaction, before COMMIT', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: USER } });
    db.existingMemberships = [{ id: LEFTOVER, account_id: null, status: 'revoked' }];
    const res = await post({ email: 'known@acme.test', role: 'agent' });

    expect(res.statusCode).toBe(201);
    const revokeAt = indexOfSql('UPDATE membership_invites SET revoked_at = NOW()');
    expect(revokeAt).toBeGreaterThan(indexOfSql('BEGIN'));
    expect(revokeAt).toBeGreaterThan(indexOfSql(`UPDATE memberships SET status = 'active'`));
    expect(revokeAt).toBeLessThan(indexOfSql('COMMIT'));
    const revoke = sqlCalls()[revokeAt]!;
    expect(revoke.params).toEqual([LEFTOVER, TENANT]);
    expect(revoke.sql).toContain('claimed_at IS NULL');
    expect(revoke.sql).toContain('revoked_at IS NULL');
    // The new invitation is issued only after the commit.
    expect(mocks.issueInvite.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(mocks.client.query.mock.invocationCallOrder[indexOfSql('COMMIT')]!);
  });

  it('issues the invite with invitedBy: null (a super admin is not a users row)', async () => {
    const res = await post({ email: 'new@acme.test', role: 'agent', account_id: ACCOUNT });

    expect(res.statusCode).toBe(201);
    expect(mocks.issueInvite).toHaveBeenCalledTimes(1);
    expect(mocks.issueInvite).toHaveBeenCalledWith({
      membershipId: MEMBERSHIP,
      tenantId: TENANT,
      email: 'new@acme.test',
      role: 'agent',
      invitedBy: null,
    });
  });

  it('an issueInvite failure does not fail the 201; the audit row reports the mail unsent', async () => {
    mocks.issueInvite.mockRejectedValue(new Error('smtp down'));
    const res = await post({ email: 'new@acme.test', role: 'agent' });

    expect(res.statusCode).toBe(201);
    expect(res.json().membership).toMatchObject({ id: MEMBERSHIP });
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add_user_to_tenant',
      details: expect.objectContaining({ invite_id: null, email_sent: false, email_reason: 'failed' }),
    }));
  });

  it('writes the add_user_to_tenant audit row with the account context and invite outcome', async () => {
    const res = await post({ email: 'new@acme.test', role: 'agent', name: 'New Agent', account_id: ACCOUNT });

    expect(res.statusCode).toBe(201);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      admin_id: ADMIN.id,
      admin_email: ADMIN.email,
      action: 'add_user_to_tenant',
      resource_type: 'membership',
      resource_id: TENANT,
      details: {
        email: 'new@acme.test',
        role: 'agent',
        name: 'New Agent',
        account_id: ACCOUNT,
        membership_id: MEMBERSHIP,
        invite_id: 'invite-1',
        email_sent: true,
      },
    });
  });

  it('a role with no token invite records the mailer\'s reason and a null invite_id', async () => {
    mocks.issueInvite.mockResolvedValue({
      invite: null, signInUrl: 'https://app.example.com/login', inviteEmail: { sent: false, reason: 'not_implemented' },
    });
    await post({ email: 'new@acme.test', role: 'viewer' });

    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      details: {
        email: 'new@acme.test', role: 'viewer', name: null, account_id: null,
        membership_id: MEMBERSHIP, invite_id: null, email_sent: false, email_reason: 'not_implemented',
      },
    }));
  });

  it('rolls back and releases the client when a statement fails', async () => {
    db.failOn = 'INSERT INTO memberships';
    const res = await post({ email: 'new@acme.test', role: 'agent' });

    expect(res.statusCode).toBe(500);
    expect(indexOfSql('ROLLBACK')).toBeGreaterThan(-1);
    expect(indexOfSql('COMMIT')).toBe(-1);
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
    expect(mocks.issueInvite).not.toHaveBeenCalled();
  });
});

// ── PUT /super-admin/tenants/:id/memberships/:membershipId/role ─────────────

describe('PUT /super-admin/tenants/:id/memberships/:membershipId/role', () => {
  const url = `/super-admin/tenants/${TENANT}/memberships/${MEMBERSHIP}/role`;
  const put = (payload: Record<string, unknown>, target = url) =>
    app.inject({ method: 'PUT', url: target, headers: auth(), payload });
  const target = (role: string, extra: Record<string, unknown> = {}) => ({
    id: MEMBERSHIP, user_id: USER, tenant_id: TENANT, account_id: ACCOUNT, role, status: 'active', ...extra,
  });

  beforeEach(() => {
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(target('agent'));
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockImplementation(
      async (_id: string, _t: string, _expected: string, role: string) => ({ ok: true, value: target(role) }),
    );
    mocks.membershipRepository.findByUserAndTenant.mockImplementation(async () => [target('viewer')]);
  });

  // Q5 (Manas, 2026-10-09). NEW (magick-agency): idempotent on retry, so a failed revocation
  // delete is a 503 — after the role write, the staffing close and the audit row.
  it('Q5: a cache delete that still fails answers 503 cache_invalidation_failed, after every other effect', async () => {
    mocks.revocation.cleared = false;
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([target('viewer')]);
    const res = await put({ role: 'viewer' });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('cache_invalidation_failed');
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).toHaveBeenCalled();
    expect(mocks.closeAllForUser).toHaveBeenCalled();
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'change_membership_role' }));
  });

  it('400s an unknown role', async () => {
    const res = await put({ role: 'god' });
    expect(res.statusCode).toBe(400);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('404s an unknown tenant', async () => {
    const res = await put({ role: 'viewer' }, `/super-admin/tenants/${NEW_TENANT}/memberships/${MEMBERSHIP}/role`);
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Tenant not found');
    expect(mocks.membershipRepository.findByIdInTenant).not.toHaveBeenCalled();
  });

  it('404s a membership not active in THIS tenant (scoped lookup)', async () => {
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(null);
    const res = await put({ role: 'viewer' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('User membership not found');
    expect(mocks.membershipRepository.findByIdInTenant).toHaveBeenCalledWith(MEMBERSHIP, TENANT);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('400s demoting the last tenant owner', async () => {
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(target('tenant_owner'));
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockResolvedValue({ ok: false, reason: 'last_owner' });
    const res = await put({ role: 'tenant_admin' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Bad Request', message: 'Cannot demote the last tenant owner' });
    expect(mocks.redisDel).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('409s when the role changed under the request (compare-and-swap lost)', async () => {
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockResolvedValue({ ok: false, reason: 'role_changed' });
    const res = await put({ role: 'viewer' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('This member’s role changed while the request was in flight. Reload and try again.');
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
  });

  it('404s when the guarded write finds the row gone', async () => {
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await put({ role: 'viewer' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('User membership not found');
  });

  it('writes through the last-owner CAS with the role it read, drops the membership cache, returns the row', async () => {
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(target('operator'));
    const res = await put({ role: 'viewer' });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).toHaveBeenCalledWith(MEMBERSHIP, TENANT, 'operator', 'viewer');
    expect(mocks.redisDel).toHaveBeenCalledWith(`cache:membership:${USER}:${TENANT}`);
    expect(res.json().membership).toMatchObject({ id: MEMBERSHIP, role: 'viewer' });
  });

  it('closes staffing tenant-wide on a demotion out of agent when no other agent membership remains', async () => {
    mocks.closeAllForUser.mockResolvedValue([
      { id: 'asg-1', campaign_id: 'camp-1', account_id: ACCOUNT },
      { id: 'asg-2', campaign_id: 'camp-2', account_id: OTHER_ACCOUNT },
    ]);
    const res = await put({ role: 'viewer', reason: 'moved to QA' });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.findByUserAndTenant).toHaveBeenCalledWith(USER, TENANT);
    expect(mocks.closeAllForUser).toHaveBeenCalledWith(TENANT, USER);
    // After the role write and the cache drop, never before.
    expect(mocks.closeAllForUser.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(mocks.redisDel.mock.invocationCallOrder[0]!);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      admin_id: ADMIN.id,
      admin_email: ADMIN.email,
      action: 'change_membership_role',
      resource_type: 'membership',
      resource_id: MEMBERSHIP,
      details: {
        tenant_id: TENANT,
        user_id: USER,
        account_id: ACCOUNT,
        from_role: 'agent',
        to_role: 'viewer',
        reason: 'moved to QA',
        staffing_closed: [
          { id: 'asg-1', campaign_id: 'camp-1' },
          { id: 'asg-2', campaign_id: 'camp-2' },
        ],
      },
    });
  });

  it('does NOT close staffing when the user is still an agent through another membership in the tenant', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      target('viewer'),
      { ...target('agent'), id: OTHER_MEMBERSHIP, account_id: OTHER_ACCOUNT },
    ]);
    const res = await put({ role: 'viewer' });

    expect(res.statusCode).toBe(200);
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ staffing_closed: [], reason: null }),
    }));
  });

  it.each([
    ['into agent', 'viewer', 'agent'],
    ['between two non-agent roles', 'operator', 'viewer'],
    ['agent to agent', 'agent', 'agent'],
  ])('does NOT touch staffing on a change %s', async (_label, from, to) => {
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(target(from));
    const res = await put({ role: to });

    expect(res.statusCode).toBe(200);
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    expect(mocks.membershipRepository.findByUserAndTenant).not.toHaveBeenCalled();
  });

  it('a staffing close failure does not fail the role change', async () => {
    mocks.closeAllForUser.mockRejectedValue(new Error('db down'));
    const res = await put({ role: 'viewer' });

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ staffing_closed: [] }),
    }));
  });
});

// ── DELETE /super-admin/tenants/:id/memberships/:membershipId ───────────────

describe('DELETE /super-admin/tenants/:id/memberships/:membershipId', () => {
  const url = `/super-admin/tenants/${TENANT}/memberships/${MEMBERSHIP}`;
  const del = (target = url) => app.inject({ method: 'DELETE', url: target, headers: auth() });
  const row = (role: string, extra: Record<string, unknown> = {}) => ({
    id: MEMBERSHIP, user_id: USER, tenant_id: TENANT, account_id: null, role, status: 'active', ...extra,
  });

  beforeEach(() => {
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(row('viewer'));
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: true, value: true });
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([
      { ...row('agent'), id: OTHER_MEMBERSHIP, status: 'revoked' },
      row('viewer', { status: 'revoked' }),
    ]);
  });

  // Q5 (Manas, 2026-10-09). NEW (magick-agency): not idempotent on retry (the revoked row is
  // gone from `findByIdInTenant`), so the 200 is kept and the failure is only logged.
  it('Q5: a cache delete that still fails keeps the 200', async () => {
    mocks.revocation.cleared = false;
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(mocks.redisDel).toHaveBeenCalledWith(`cache:membership:${USER}:${TENANT}`);
  });

  it('404s an unknown tenant', async () => {
    const res = await del(`/super-admin/tenants/${NEW_TENANT}/memberships/${MEMBERSHIP}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Tenant not found');
    expect(mocks.membershipRepository.removeGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('404s a membership not active in THIS tenant', async () => {
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(null);
    const res = await del();
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('User membership not found');
    expect(mocks.membershipRepository.findByIdInTenant).toHaveBeenCalledWith(MEMBERSHIP, TENANT);
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
  });

  it('400s removing the last tenant owner and closes no staffing', async () => {
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(row('tenant_owner'));
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: false, reason: 'last_owner' });
    const res = await del();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Bad Request', message: 'Cannot remove the last tenant owner' });
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    expect(mocks.redisDel).not.toHaveBeenCalled();
  });

  it('409s when the role changed under the request', async () => {
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: false, reason: 'role_changed' });
    const res = await del();
    expect(res.statusCode).toBe(409);
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
  });

  it('404s when the guarded write finds the row gone', async () => {
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await del();
    expect(res.statusCode).toBe(404);
  });

  it('revokes through the guard, drops the cache, closes staffing UNCONDITIONALLY (non-agent role), returns the revoked row and the count', async () => {
    mocks.closeAllForUser.mockResolvedValue([
      { id: 'asg-1', campaign_id: 'camp-1', account_id: null },
      { id: 'asg-2', campaign_id: 'camp-2', account_id: ACCOUNT },
    ]);
    const res = await del();

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.removeGuardingLastOwner).toHaveBeenCalledWith(MEMBERSHIP, TENANT, 'viewer');
    expect(mocks.redisDel).toHaveBeenCalledWith(`cache:membership:${USER}:${TENANT}`);
    expect(mocks.closeAllForUser).toHaveBeenCalledWith(TENANT, USER);
    expect(mocks.closeAllForUser.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(mocks.redisDel.mock.invocationCallOrder[0]!);
    expect(res.json()).toEqual({
      membership: expect.objectContaining({ id: MEMBERSHIP, status: 'revoked' }),
      staffing_closed: 2,
    });
    expect(mocks.auditLog).toHaveBeenCalledWith({
      admin_id: ADMIN.id,
      admin_email: ADMIN.email,
      action: 'revoke_membership',
      resource_type: 'membership',
      resource_id: MEMBERSHIP,
      details: {
        tenant_id: TENANT,
        user_id: USER,
        account_id: null,
        role: 'viewer',
        staffing_closed: [
          { id: 'asg-1', campaign_id: 'camp-1' },
          { id: 'asg-2', campaign_id: 'camp-2' },
        ],
      },
    });
  });

  it('a staffing close failure does not fail the revoke: 200, staffing_closed 0', async () => {
    mocks.closeAllForUser.mockRejectedValue(new Error('db down'));
    const res = await del();

    expect(res.statusCode).toBe(200);
    expect(res.json().staffing_closed).toBe(0);
    expect(res.json().membership).toMatchObject({ id: MEMBERSHIP, status: 'revoked' });
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke_membership',
      details: expect.objectContaining({ staffing_closed: [] }),
    }));
  });

  it('falls back to the target marked revoked when the read-back does not find it', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([]);
    const res = await del();

    expect(res.statusCode).toBe(200);
    expect(res.json().membership).toEqual({ ...row('viewer'), status: 'revoked' });
  });
});

// ── POST /super-admin/tenants ───────────────────────────────────────────────

describe('POST /super-admin/tenants', () => {
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/super-admin/tenants', headers: auth(), payload });

  it('creates tenant, default account, pending_ owner stub and tenant_owner membership in one transaction', async () => {
    const res = await post({ name: 'Acme Corp', owner_email: 'owner@acme.test', owner_name: 'Olive' });

    expect(res.statusCode).toBe(201);
    expect(mocks.userRepository.resolveByProvenEmail).toHaveBeenCalledWith('owner@acme.test', {
      client: mocks.client, lock: true,
    });
    const calls = sqlCalls();
    expect(calls[0]!.sql).toBe('BEGIN');
    const tenantInsert = calls.find((c) => c.sql.startsWith('INSERT INTO tenants'))!;
    expect(tenantInsert.params![0]).toBe('Acme Corp');
    expect(tenantInsert.params![1]).toMatch(/^acme-corp-[a-z0-9]{1,6}$/);
    expect(calls.find((c) => c.sql.startsWith('INSERT INTO accounts'))!.params).toEqual([NEW_TENANT]);
    const userInsert = calls.find((c) => c.sql.startsWith('INSERT INTO users'))!;
    expect(userInsert.params![0]).toMatch(/^pending_[0-9a-f-]{36}$/);
    expect(userInsert.params!.slice(1)).toEqual(['owner@acme.test', 'Olive']);
    const membershipInsert = calls.find((c) => c.sql.startsWith('INSERT INTO memberships'))!;
    expect(membershipInsert.sql).toContain(`'tenant_owner'`);
    expect(membershipInsert.params).toEqual([NEW_USER, NEW_TENANT]);
    expect(calls[calls.length - 1]!.sql).toBe('COMMIT');
    expect(mocks.client.release).toHaveBeenCalledTimes(1);

    expect(res.json()).toEqual({
      tenant: expect.objectContaining({ id: NEW_TENANT, name: 'Acme Corp' }),
      owner_email: 'owner@acme.test',
    });
    expect(mocks.auditLog).toHaveBeenCalledWith({
      admin_id: ADMIN.id,
      admin_email: ADMIN.email,
      action: 'create_tenant',
      resource_type: 'tenant',
      resource_id: NEW_TENANT,
      details: { tenant_name: 'Acme Corp', owner_email: 'owner@acme.test' },
    });
  });

  it('assigns NO pooled number and writes no credit balance or core key', async () => {
    const res = await post({ name: 'Acme', owner_email: 'owner@acme.test' });

    expect(res.statusCode).toBe(201);
    expect(mocks.touched).toEqual([]);
    for (const { sql } of sqlCalls()) {
      expect(sql).not.toMatch(/phone|credit|core_credential/i);
    }
    expect(res.json()).not.toHaveProperty('phone_auto_assigned');
    expect(res.json()).not.toHaveProperty('core_key_provisioned');
  });

  it('reuses a proven owner and writes no stub', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: USER } });
    const res = await post({ name: 'Acme', owner_email: 'owner@acme.test' });

    expect(res.statusCode).toBe(201);
    expect(indexOfSql('INSERT INTO users')).toBe(-1);
    expect(sqlCalls().find((c) => c.sql.startsWith('INSERT INTO memberships'))!.params).toEqual([USER, NEW_TENANT]);
  });

  it('409 UNVERIFIED_ADDRESS_HOLDER on an unproven owner address; rolls back the tenant', async () => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'unproven_conflict' });
    const res = await post({ name: 'Acme', owner_email: 'claimed@acme.test' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'Conflict', code: UNVERIFIED_ADDRESS_HOLDER });
    expect(res.json().message).toContain('then create the workspace again');
    expect(indexOfSql('ROLLBACK')).toBeGreaterThan(-1);
    expect(indexOfSql('COMMIT')).toBe(-1);
    expect(indexOfSql('INSERT INTO users')).toBe(-1);
    expect(indexOfSql('INSERT INTO memberships')).toBe(-1);
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('ROLLBACK (no COMMIT) and release when a statement fails', async () => {
    db.failOn = 'INSERT INTO memberships';
    const res = await post({ name: 'Acme', owner_email: 'owner@acme.test' });

    expect(res.statusCode).toBe(500);
    expect(indexOfSql('ROLLBACK')).toBeGreaterThan(indexOfSql('INSERT INTO memberships'));
    expect(indexOfSql('COMMIT')).toBe(-1);
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('400s an invalid body without opening a transaction', async () => {
    const res = await post({ name: '', owner_email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
