/*
 * NEW (magick-agency): no source test — the route replaces master's credit/fleet
 * usage (deleted with credits). Covers `GET /super-admin/usage`
 * (`apps/server/src/api/routes/super-admin-usage-counts.routes.ts`, contract
 * `UsageCountsQuery` / `UsageCountsResponse`): `usageCountsQuerySchema`
 * validation, the filters forwarded to `usageCountsRepository.countByAccount`,
 * and the tenant/total grouping. Runs through the REAL super-admin JWT middleware.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'test-super-admin-secret-at-least-16';
  return {
    superAdminRepository: { findById: vi.fn() },
    countByAccount: vi.fn(),
  };
});

vi.mock('@magick-agency/db/repositories/super-admin.repository', () => ({
  superAdminRepository: mocks.superAdminRepository,
}));
vi.mock('@magick-agency/db/repositories/usage-counts.repository', () => ({
  usageCountsRepository: { countByAccount: mocks.countByAccount },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { superAdminUsageCountsRoutes } from '../../../../src/api/routes/super-admin-usage-counts.routes.js';

const SECRET = 'test-super-admin-secret-at-least-16';
const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'root@magick.test', name: 'Root', status: 'active' };
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const A1 = '33333333-3333-4333-8333-333333333333';
const A2 = '44444444-4444-4444-8444-444444444444';
const A3 = '55555555-5555-4555-8555-555555555555';
const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-10-01T00:00:00.000Z';

const auth = () => ({
  authorization: `Bearer ${jwt.sign({ sub: ADMIN.id, email: ADMIN.email, type: 'super_admin' }, SECRET)}`,
});

function usageRow(tenantId: string, tenantName: string, accountId: string, accountName: string, n: number[]) {
  const [dials, answered_calls, connected_calls, talk_seconds, analysis_audio_seconds] = n as [number, number, number, number, number];
  return {
    tenant_id: tenantId, tenant_name: tenantName, account_id: accountId, account_name: accountName,
    dials, answered_calls, connected_calls, talk_seconds, analysis_audio_seconds,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.superAdminRepository.findById.mockImplementation(async (id: string) => (id === ADMIN.id ? ADMIN : null));
  mocks.countByAccount.mockResolvedValue([]);
  app = Fastify({ logger: false });
  await app.register(superAdminUsageCountsRoutes, { prefix: '/super-admin' });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function get(query: Record<string, string>, headers: Record<string, string> = auth()) {
  return app.inject({ method: 'GET', url: '/super-admin/usage', query, headers });
}

describe('GET /super-admin/usage — authentication', () => {
  it('401s without a super-admin JWT and reads nothing', async () => {
    const res = await get({ from: FROM, to: TO }, {});
    expect(res.statusCode).toBe(401);
    expect(mocks.countByAccount).not.toHaveBeenCalled();
  });

  it('401s a token signed with another secret', async () => {
    const bad = jwt.sign({ sub: ADMIN.id, email: ADMIN.email, type: 'super_admin' }, 'another-secret-16-chars-long');
    const res = await get({ from: FROM, to: TO }, { authorization: `Bearer ${bad}` });
    expect(res.statusCode).toBe(401);
    expect(mocks.countByAccount).not.toHaveBeenCalled();
  });
});

describe('GET /super-admin/usage — query validation (usageCountsQuerySchema)', () => {
  it.each<[string, Record<string, string>]>([
    ['from missing', { to: TO }],
    ['to missing', { from: FROM }],
    ['from not ISO (date only)', { from: '2026-09-01', to: TO }],
    ['to not ISO (garbage)', { from: FROM, to: 'next tuesday' }],
    ['from == to (empty window)', { from: FROM, to: FROM }],
    ['from after to', { from: TO, to: FROM }],
    ['account_id without tenant_id', { from: FROM, to: TO, account_id: A1 }],
    ['tenant_id not a UUID', { from: FROM, to: TO, tenant_id: 'acme' }],
    ['account_id not a UUID', { from: FROM, to: TO, tenant_id: T1, account_id: 'sales' }],
    ['an unknown filter (strict)', { from: FROM, to: TO, tenant: T1 }],
    ['the window spans more than 400 days', { from: '2026-01-01T00:00:00.000Z', to: '2027-02-06T00:00:00.000Z' }],
  ])('400s when %s, without reading', async (_label, query) => {
    const res = await get(query);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bad Request');
    expect(mocks.countByAccount).not.toHaveBeenCalled();
  });

  it('reports account_id-without-tenant_id on the account_id path', async () => {
    const res = await get({ from: FROM, to: TO, account_id: A1 });
    expect(res.json().details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['account_id'], message: 'account_id requires tenant_id' }),
    ]));
  });

  it('a non-ISO from is a 400, not a 500 (the window refinement guards the dirty parse)', async () => {
    const res = await get({ from: 'not-a-date', to: 'also-not' });
    expect(res.statusCode).toBe(400);
  });

  it('accepts an offset timestamp and echoes the window normalised to UTC', async () => {
    const res = await get({ from: '2026-09-01T05:30:00+05:30', to: TO });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ from: '2026-09-01T00:00:00.000Z', to: TO });
  });
});

describe('GET /super-admin/usage — filters forwarded to countByAccount', () => {
  it('window only: no tenant or account filter', async () => {
    await get({ from: FROM, to: TO });
    expect(mocks.countByAccount).toHaveBeenCalledTimes(1);
    const filter = mocks.countByAccount.mock.calls[0]![0];
    expect(filter.from).toEqual(new Date(FROM));
    expect(filter.to).toEqual(new Date(TO));
    expect(filter.tenantId).toBeUndefined();
    expect(filter.accountId).toBeUndefined();
  });

  it('tenant filter', async () => {
    await get({ from: FROM, to: TO, tenant_id: T1 });
    expect(mocks.countByAccount).toHaveBeenCalledWith({
      from: new Date(FROM), to: new Date(TO), tenantId: T1, accountId: undefined,
    });
  });

  it('tenant + account filter', async () => {
    await get({ from: FROM, to: TO, tenant_id: T1, account_id: A2 });
    expect(mocks.countByAccount).toHaveBeenCalledWith({
      from: new Date(FROM), to: new Date(TO), tenantId: T1, accountId: A2,
    });
  });
});

describe('GET /super-admin/usage — grouping', () => {
  it('no rows: zero totals and no tenants', async () => {
    const res = await get({ from: FROM, to: TO });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      from: FROM,
      to: TO,
      totals: { dials: 0, answered_calls: 0, connected_calls: 0, talk_seconds: 0, analysis_audio_seconds: 0 },
      tenants: [],
    });
  });

  it('tenant counts are the exact sum of their account rows, totals the sum of tenants, in first-seen order', async () => {
    // Deliberately T2 first: the response keeps the repository's order, it does not re-sort.
    mocks.countByAccount.mockResolvedValue([
      usageRow(T2, 'Zeta', A3, 'Ops', [7, 5, 4, 301, 280]),
      usageRow(T1, 'Acme', A1, 'Sales', [100, 60, 41, 12_345, 9_000]),
      usageRow(T1, 'Acme', A2, 'Support', [3, 2, 1, 59, 0]),
    ]);

    const res = await get({ from: FROM, to: TO });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenants.map((t: { tenant_id: string }) => t.tenant_id)).toEqual([T2, T1]);
    expect(body.tenants[0]).toEqual({
      tenant_id: T2,
      tenant_name: 'Zeta',
      counts: { dials: 7, answered_calls: 5, connected_calls: 4, talk_seconds: 301, analysis_audio_seconds: 280 },
      accounts: [
        {
          account_id: A3, account_name: 'Ops',
          counts: { dials: 7, answered_calls: 5, connected_calls: 4, talk_seconds: 301, analysis_audio_seconds: 280 },
        },
      ],
    });
    expect(body.tenants[1]).toEqual({
      tenant_id: T1,
      tenant_name: 'Acme',
      counts: { dials: 103, answered_calls: 62, connected_calls: 42, talk_seconds: 12_404, analysis_audio_seconds: 9_000 },
      accounts: [
        {
          account_id: A1, account_name: 'Sales',
          counts: { dials: 100, answered_calls: 60, connected_calls: 41, talk_seconds: 12_345, analysis_audio_seconds: 9_000 },
        },
        {
          account_id: A2, account_name: 'Support',
          counts: { dials: 3, answered_calls: 2, connected_calls: 1, talk_seconds: 59, analysis_audio_seconds: 0 },
        },
      ],
    });
    expect(body.totals).toEqual({
      dials: 110, answered_calls: 67, connected_calls: 46, talk_seconds: 12_705, analysis_audio_seconds: 9_280,
    });
  });

  it('an account row\'s counts are not aliased to the tenant accumulator', async () => {
    mocks.countByAccount.mockResolvedValue([
      usageRow(T1, 'Acme', A1, 'Sales', [1, 1, 1, 10, 10]),
      usageRow(T1, 'Acme', A2, 'Support', [2, 2, 2, 20, 20]),
    ]);
    const body = (await get({ from: FROM, to: TO })).json();
    expect(body.tenants[0].accounts[0].counts.dials).toBe(1);
    expect(body.tenants[0].counts.dials).toBe(3);
    expect(body.totals.dials).toBe(3);
  });
});
