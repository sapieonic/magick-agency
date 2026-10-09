/*
 * Covers `apps/server/src/api/routes/super-admin-account-settings.routes.ts`
 * (GET/PUT `/super-admin/tenants/:tenantId/accounts/:accountId/settings`, contract
 * `AgencyAccountSettingsResponse` / `UpdateAgencyAccountSettingsBody`), which
 * sets the account toggles and the `webrtc_max_duration_seconds` limit. Runs through the REAL
 * super-admin JWT middleware and the real `loadAgencyAccountSettings`; the repositories and the
 * concurrency-control seam are doubled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'test-super-admin-secret-at-least-16';
  return {
    superAdminRepository: { findById: vi.fn() },
    tenantRepository: { findById: vi.fn() },
    accountRepository: { findByIdInTenant: vi.fn() },
    accountSettingsRepository: {
      findByTenantAndAccount: vi.fn(),
      getMaxConcurrentCalls: vi.fn(),
      upsert: vi.fn(),
      setRecordingAnalysisToggles: vi.fn(),
      setWebrtcMaxDurationSeconds: vi.fn(),
    },
    auditLog: vi.fn(),
    control: {
      invalidateAccountLimit: vi.fn(),
      invalidateProviderLimits: vi.fn(),
      getAccountProviderCounts: vi.fn(),
      getAccountCount: vi.fn(),
      getDistributedAccountCount: vi.fn(),
    },
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
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: mocks.accountSettingsRepository,
}));
vi.mock('@magick-agency/db/repositories/super-admin-audit.repository', () => ({
  superAdminAuditRepository: { log: mocks.auditLog },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { superAdminAccountSettingsRoutes } from '../../../../src/api/routes/super-admin-account-settings.routes.js';
import { setConcurrencyControl, resetConcurrencyControl } from '../../../../src/seams/concurrency-control.js';

const SECRET = 'test-super-admin-secret-at-least-16';
const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'root@magick.test', name: 'Root', status: 'active' };
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_UPDATED_AT = '2026-01-01T00:00:00.000Z';
const ROW_UPDATED_AT = '2026-02-02T00:00:00.000Z';
const url = `/super-admin/tenants/${TENANT}/accounts/${ACCOUNT}/settings`;

const auth = () => ({
  authorization: `Bearer ${jwt.sign({ sub: ADMIN.id, email: ADMIN.email, type: 'super_admin' }, SECRET)}`,
});

/** The settings row as stored; the CACHED read returns it. */
let row: Record<string, unknown> | null;

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  row = {
    tenant_id: TENANT, account_id: ACCOUNT,
    max_concurrent_calls: 5, allow_recording: true, analyze_calls: false,
    webrtc_max_duration_seconds: 900, updated_at: ROW_UPDATED_AT,
  };
  mocks.superAdminRepository.findById.mockImplementation(async (id: string) => (id === ADMIN.id ? ADMIN : null));
  mocks.tenantRepository.findById.mockImplementation(async (id: string) => (id === TENANT || id === OTHER_TENANT ? { id } : null));
  mocks.accountRepository.findByIdInTenant.mockImplementation(async (id: string, tenantId: string) =>
    (id === ACCOUNT && tenantId === TENANT ? { id: ACCOUNT, tenant_id: TENANT, updated_at: ACCOUNT_UPDATED_AT } : null));
  mocks.accountSettingsRepository.findByTenantAndAccount.mockImplementation(async () => row);
  mocks.accountSettingsRepository.getMaxConcurrentCalls.mockResolvedValue(5);
  mocks.accountSettingsRepository.upsert.mockImplementation(async (input: Record<string, unknown>) => {
    row = {
      ...row,
      max_concurrent_calls: input['max_concurrent_calls'],
      ...(input['allow_recording'] !== undefined ? { allow_recording: input['allow_recording'] } : {}),
      ...(input['analyze_calls'] !== undefined ? { analyze_calls: input['analyze_calls'] } : {}),
    };
    return row;
  });
  mocks.accountSettingsRepository.setRecordingAnalysisToggles.mockImplementation(
    async (_t: string, _a: string, toggles: Record<string, unknown>) => {
      row = {
        ...row,
        ...(toggles['allow_recording'] !== undefined ? { allow_recording: toggles['allow_recording'] } : {}),
        ...(toggles['analyze_calls'] !== undefined ? { analyze_calls: toggles['analyze_calls'] } : {}),
      };
      return row;
    },
  );
  mocks.accountSettingsRepository.setWebrtcMaxDurationSeconds.mockImplementation(
    async (_t: string, _a: string, seconds: number) => {
      row = { ...row, webrtc_max_duration_seconds: seconds };
      return row;
    },
  );
  mocks.auditLog.mockResolvedValue(undefined);
  mocks.control.invalidateAccountLimit.mockResolvedValue(undefined);
  setConcurrencyControl(mocks.control);
  app = Fastify({ logger: false });
  await app.register(superAdminAccountSettingsRoutes, { prefix: '/super-admin' });
  await app.ready();
});

afterEach(async () => {
  resetConcurrencyControl();
  await app.close();
});

function noWrites(): void {
  expect(mocks.accountSettingsRepository.upsert).not.toHaveBeenCalled();
  expect(mocks.accountSettingsRepository.setRecordingAnalysisToggles).not.toHaveBeenCalled();
  expect(mocks.accountSettingsRepository.setWebrtcMaxDurationSeconds).not.toHaveBeenCalled();
  expect(mocks.control.invalidateAccountLimit).not.toHaveBeenCalled();
  expect(mocks.auditLog).not.toHaveBeenCalled();
}

describe('authentication', () => {
  it.each(['GET', 'PUT'] as const)('%s 401s without a super-admin JWT', async (method) => {
    const res = await app.inject({ method, url, ...(method === 'PUT' ? { payload: { allow_recording: true } } : {}) });
    expect(res.statusCode).toBe(401);
    expect(mocks.tenantRepository.findById).not.toHaveBeenCalled();
    noWrites();
  });
});

describe('GET /super-admin/tenants/:tenantId/accounts/:accountId/settings', () => {
  it('returns the EFFECTIVE settings for the account', async () => {
    const res = await app.inject({ method: 'GET', url, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      settings: {
        tenant_id: TENANT, account_id: ACCOUNT,
        allow_recording: true, analyze_calls: false, max_concurrent_calls: 5,
        webrtc_max_duration_seconds: 900, updated_at: ROW_UPDATED_AT,
      },
    });
  });

  it('resolves defaults when the account has no settings row', async () => {
    row = null;
    const res = await app.inject({ method: 'GET', url, headers: auth() });
    expect(res.json().settings).toEqual({
      tenant_id: TENANT, account_id: ACCOUNT,
      allow_recording: false, analyze_calls: false, max_concurrent_calls: 5,
      webrtc_max_duration_seconds: 1800, updated_at: ACCOUNT_UPDATED_AT,
    });
  });

  it('404s an account that belongs to another tenant (scoped lookup)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/super-admin/tenants/${OTHER_TENANT}/accounts/${ACCOUNT}/settings`, headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found', message: 'Tenant or account not found' });
    expect(mocks.accountRepository.findByIdInTenant).toHaveBeenCalledWith(ACCOUNT, OTHER_TENANT);
    expect(mocks.accountSettingsRepository.findByTenantAndAccount).not.toHaveBeenCalled();
  });

  it('404s an unknown tenant', async () => {
    const res = await app.inject({
      method: 'GET', url: `/super-admin/tenants/44444444-4444-4444-8444-444444444444/accounts/${ACCOUNT}/settings`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(mocks.accountRepository.findByIdInTenant).not.toHaveBeenCalled();
  });
});

describe('PUT /super-admin/tenants/:tenantId/accounts/:accountId/settings', () => {
  const put = (payload: unknown, target = url) => app.inject({ method: 'PUT', url: target, headers: auth(), payload: payload as any });

  it('404s an account that belongs to another tenant and writes nothing', async () => {
    const res = await put({ allow_recording: false }, `/super-admin/tenants/${OTHER_TENANT}/accounts/${ACCOUNT}/settings`);
    expect(res.statusCode).toBe(404);
    expect(mocks.accountRepository.findByIdInTenant).toHaveBeenCalledWith(ACCOUNT, OTHER_TENANT);
    noWrites();
  });

  it('is a PATCH: an omitted toggle is passed as undefined (kept), and the webrtc writer is not called', async () => {
    const res = await put({ analyze_calls: true });

    expect(res.statusCode).toBe(200);
    expect(mocks.accountSettingsRepository.setRecordingAnalysisToggles).toHaveBeenCalledTimes(1);
    expect(mocks.accountSettingsRepository.setRecordingAnalysisToggles).toHaveBeenCalledWith(
      TENANT, ACCOUNT, { analyze_calls: true, allow_recording: undefined },
    );
    expect(mocks.accountSettingsRepository.upsert).not.toHaveBeenCalled();
    expect(mocks.accountSettingsRepository.setWebrtcMaxDurationSeconds).not.toHaveBeenCalled();
    // The omitted fields keep their values in the effective response.
    expect(res.json().settings).toMatchObject({
      allow_recording: true, analyze_calls: true, webrtc_max_duration_seconds: 900,
    });
  });

  it('is a PATCH: a webrtc-only body never touches the toggles or the concurrency read', async () => {
    const res = await put({ webrtc_max_duration_seconds: 600 });

    expect(res.statusCode).toBe(200);
    expect(mocks.accountSettingsRepository.setWebrtcMaxDurationSeconds).toHaveBeenCalledWith(TENANT, ACCOUNT, 600);
    expect(mocks.accountSettingsRepository.setRecordingAnalysisToggles).not.toHaveBeenCalled();
    expect(mocks.accountSettingsRepository.getMaxConcurrentCalls).not.toHaveBeenCalled();
    expect(res.json().settings).toMatchObject({
      allow_recording: true, analyze_calls: false, webrtc_max_duration_seconds: 600,
    });
  });

  it.each([59, 14401, 60.5, 0])('400s webrtc_max_duration_seconds = %s and writes nothing', async (seconds) => {
    const res = await put({ webrtc_max_duration_seconds: seconds });
    expect(res.statusCode).toBe(400);
    noWrites();
  });

  it.each([60, 14400])('accepts webrtc_max_duration_seconds = %s (inclusive bound)', async (seconds) => {
    const res = await put({ webrtc_max_duration_seconds: seconds });
    expect(res.statusCode).toBe(200);
    expect(mocks.accountSettingsRepository.setWebrtcMaxDurationSeconds).toHaveBeenCalledWith(TENANT, ACCOUNT, seconds);
  });

  it.each([
    ['alone', { max_concurrent_calls: 10 }],
    ['beside a valid field', { allow_recording: true, max_concurrent_calls: 5 }],
  ])('400s max_concurrent_calls in the body (%s) — the concurrency route is its one writer', async (_label, body) => {
    const res = await put(body);
    expect(res.statusCode).toBe(400);
    expect(mocks.accountSettingsRepository.getMaxConcurrentCalls).not.toHaveBeenCalled();
    noWrites();
  });

  it('400s an empty body (nothing to change, nothing to audit)', async () => {
    const res = await put({});
    expect(res.statusCode).toBe(400);
    noWrites();
  });

  it('400s a reason-only body', async () => {
    const res = await put({ reason: 'just because' });
    expect(res.statusCode).toBe(400);
    noWrites();
  });

  it('writes toggles through the toggles-only writer and never reads or writes concurrency', async () => {
    // A writer that read the concurrency and passed it back through `upsert` would undo a
    // concurrency write landing between the two. The toggles-only writer has no
    // concurrency to pass back.
    const res = await put({ allow_recording: false, analyze_calls: true });

    expect(res.statusCode).toBe(200);
    expect(mocks.accountSettingsRepository.setRecordingAnalysisToggles).toHaveBeenCalledWith(
      TENANT, ACCOUNT, { allow_recording: false, analyze_calls: true },
    );
    expect(mocks.accountSettingsRepository.getMaxConcurrentCalls).not.toHaveBeenCalled();
    expect(mocks.accountSettingsRepository.upsert).not.toHaveBeenCalled();
  });

  it('invalidates the account guard\'s limit after the write', async () => {
    const res = await put({ allow_recording: false });

    expect(res.statusCode).toBe(200);
    expect(mocks.control.invalidateAccountLimit).toHaveBeenCalledWith(TENANT, ACCOUNT);
    expect(mocks.control.invalidateAccountLimit.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(mocks.accountSettingsRepository.setRecordingAnalysisToggles.mock.invocationCallOrder[0]!);
    expect(mocks.control.invalidateProviderLimits).not.toHaveBeenCalled();
  });

  it('writes the update_account_settings audit row with before, the changes actually sent, and the reason', async () => {
    const res = await put({ allow_recording: false, webrtc_max_duration_seconds: 3600, reason: 'customer request' });

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      admin_id: ADMIN.id,
      admin_email: ADMIN.email,
      action: 'update_account_settings',
      resource_type: 'account',
      resource_id: ACCOUNT,
      details: {
        tenant_id: TENANT,
        changes: { allow_recording: false, webrtc_max_duration_seconds: 3600 },
        before: { allow_recording: true, analyze_calls: false, webrtc_max_duration_seconds: 900 },
        reason: 'customer request',
      },
    });
  });

  it('records reason: null when none is given', async () => {
    await put({ analyze_calls: true });
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ changes: { analyze_calls: true }, reason: null }),
    }));
  });

  it('responds with the reloaded EFFECTIVE settings', async () => {
    const res = await put({ allow_recording: false, webrtc_max_duration_seconds: 120 });
    expect(res.json()).toEqual({
      settings: {
        tenant_id: TENANT, account_id: ACCOUNT,
        allow_recording: false, analyze_calls: false, max_concurrent_calls: 5,
        webrtc_max_duration_seconds: 120, updated_at: ROW_UPDATED_AT,
      },
    });
  });
});
