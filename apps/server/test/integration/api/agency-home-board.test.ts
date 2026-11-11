import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── Home's board through the real app and real Postgres ───────────────────────
 *
 * `GET /proxy/agency/home` (decision B28a): session middleware with Firebase stubbed, tenant
 * context, RBAC, the account scope, the dialer flag, the campaign list (`listForHome`), each
 * campaign's stats through `callCore` and the insights allocation through its cache. The order
 * and the cap, that every number is the one the per-campaign route serves, and the refusals.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'home-board-secret-0123456789abcdef';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import type { AgencyHomeBoard } from '@magick-agency/contracts/api/agency/home';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { insightsCache } from '../../../src/agency/insights/cache.js';
import { resetHomeBoardMemosForTests } from '../../../src/agency/home-board.js';

let loaded: LoadApp;
let floors: TenantFloor[];
const app = () => loaded.app;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

/** Tenant 0: 27 active campaigns and a draft. Tenant 1: drafts only. Tenant 2: none. Tenant 3: dialer off. */
const main = () => floors[0]!;
const sup = (f: TenantFloor = main()): Actor => f.supervisors[0]!;
const C = (i: number) => main().campaigns[i]!;

async function home(actor: Actor = sup(), f: TenantFloor = main()) {
  return call(app(), 'GET', '/proxy/agency/home', actor, f);
}

async function boardOf(f: TenantFloor = main()): Promise<AgencyHomeBoard> {
  const res = await home(sup(f), f);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AgencyHomeBoard;
}

// Tenant 0's statuses by campaign index; campaign i was created i minutes ago (0 newest).
const PAUSED = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const STOPPING = [10, 11, 12];
const RUNNING = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];
const DRAFT = 27;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floors = await seedFloor({ tenants: 4, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 28 });
  const f = main();
  for (let i = 0; i < f.campaigns.length; i++) {
    const status = PAUSED.includes(i) ? 'paused' : STOPPING.includes(i) ? 'stopping' : RUNNING.includes(i) ? 'running' : 'draft';
    await q(`UPDATE agency_campaigns SET status = $2, created_at = now() - ($3::int * interval '1 minute') WHERE id = $1`,
      [f.campaigns[i], status, i]);
  }
  // Tenant 2 has no campaign at all.
  await q('DELETE FROM agency_campaigns WHERE tenant_id = $1', [floors[2]!.tenant]);
  // Tenant 3 has the dialer off (before the first request: the flag service caches what it read).
  await q(`UPDATE feature_flag_overrides SET value = 'false'::jsonb WHERE flag_key = 'agency_dialer_enabled' AND tenant_id = $1`,
    [floors[3]!.tenant]);
  // Three overdue callbacks and one due later, on running campaign 13.
  await q(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state, next_attempt_at,
                                  attempt_count, dials_placed, last_outcome, last_disposition)
     SELECT $1, $2, $3, '+9191' || lpad(g::text, 8, '0'), '{}'::jsonb, 'pending',
            CASE WHEN g <= 3 THEN now() - interval '1 hour' ELSE now() + interval '30 minutes' END,
            1, 1, 'connected', 'callback'
       FROM generate_series(1, 4) g`,
    [C(13), f.tenant, f.account],
  );
}, 120_000);

beforeEach(() => {
  insightsCache.clear();
  resetHomeBoardMemosForTests();
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

describe('which campaigns, in what order', () => {
  it('lists the active campaigns running first, then stopping, then paused, newest first within each, the first 25', async () => {
    const board = await boardOf();
    expect(board.active_total).toBe(27);
    expect(board.any_campaign).toBe(true);
    expect(board.campaigns).toHaveLength(25);
    // Within a status, newest first: the lower index was created later.
    const expected = [...RUNNING, ...STOPPING, ...PAUSED].slice(0, 25).map(C);
    expect(board.campaigns.map((c) => c.id)).toEqual(expected);
    expect(board.campaigns.map((c) => c.status)).toEqual([
      ...RUNNING.map(() => 'running'), ...STOPPING.map(() => 'stopping'), ...PAUSED.slice(0, 8).map(() => 'paused'),
    ]);
    expect(board.campaigns.some((c) => c.id === C(DRAFT))).toBe(false);
    expect(board.campaigns[0]!.name).toBe('Load 0.13');
  });

  it('says there are campaigns when none is active', async () => {
    const board = await boardOf(floors[1]!);
    expect(board).toEqual({ campaigns: [], active_total: 0, any_campaign: true });
  });

  it('says there are none when the account has none', async () => {
    const board = await boardOf(floors[2]!);
    expect(board).toEqual({ campaigns: [], active_total: 0, any_campaign: false });
  });

  it('never shows another tenant’s campaigns', async () => {
    const board = await boardOf();
    const foreign = new Set(floors.slice(1).flatMap((f) => f.campaigns));
    expect(board.campaigns.filter((c) => foreign.has(c.id))).toEqual([]);
  });
});

describe('the numbers are the per-campaign routes’ own', () => {
  it('serves each campaign the stats route’s stall, abandonment and floor, and nothing else of it', async () => {
    const board = await boardOf();
    for (const i of [13, 10, 0]) {
      const onBoard = board.campaigns.find((c) => c.id === C(i))!;
      const res = await call(app(), 'GET', `/proxy/agency/campaigns/${C(i)}/stats`, sup(), main());
      expect(res.statusCode, res.body).toBe(200);
      const stats = res.json() as Record<string, unknown>;
      expect(onBoard.stats).toEqual({
        stall: stats['stall'],
        abandoned_24h: stats['abandoned_24h'],
        answered_24h: stats['answered_24h'],
        abandonment_ceiling_pct: stats['abandonment_ceiling_pct'],
        agents_live: stats['agents_live'],
        agents_by_state: stats['agents_by_state'],
      });
    }
  });

  it('serves the insights allocation’s overdue callbacks', async () => {
    const board = await boardOf();
    const res = await call(app(), 'GET', `/proxy/agency/campaigns/${C(13)}/insights/allocation`, sup(), main());
    expect(res.statusCode, res.body).toBe(200);
    const overdue = (res.json() as { totals: { callbacks_overdue: number } }).totals.callbacks_overdue;
    expect(overdue).toBe(3);
    expect(board.campaigns.find((c) => c.id === C(13))!.callbacks_overdue).toBe(3);
    expect(board.campaigns.find((c) => c.id === C(14))!.callbacks_overdue).toBe(0);
  });

  it('reads a status change at once (the memos are keyed by status and updated_at)', async () => {
    await boardOf();
    await q(`UPDATE agency_campaigns SET status = 'paused', updated_at = now() WHERE id = $1`, [C(26)]);
    try {
      const board = await boardOf();
      // Thirteen running now; campaign 26 is the oldest paused one, so it falls past the cap.
      expect(board.active_total).toBe(27);
      expect(board.campaigns.filter((c) => c.status === 'running').map((c) => c.id)).toEqual(RUNNING.slice(0, 13).map(C));
      expect(board.campaigns.some((c) => c.id === C(26))).toBe(false);
    } finally {
      await q(`UPDATE agency_campaigns SET status = 'running', updated_at = now() WHERE id = $1`, [C(26)]);
    }
  });
});

describe('guards', () => {
  it('refuses an agent (RBAC 403), and reads nothing for them', async () => {
    const res = await home(main().agents[0]!);
    expect(res.statusCode).toBe(403);
  });

  it('refuses a tenant without the dialer: 403 feature_disabled', async () => {
    const res = await home(sup(floors[3]!), floors[3]!);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'feature_disabled' });
  });

  it('refuses a request with no account: 400 account_scope_required, never a tenant-wide board', async () => {
    const headers = headersFor(sup(), main());
    delete headers['x-account-id'];
    const res = await app().inject({ method: 'GET', url: '/proxy/agency/home', headers });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'account_scope_required' });
  });

  it('refuses another tenant’s account', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/proxy/agency/home',
      headers: headersFor(sup(), main(), { 'x-account-id': floors[1]!.account }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('needs a session', async () => {
    const res = await app().inject({
      method: 'GET', url: '/proxy/agency/home', headers: { 'x-tenant-id': main().tenant, 'x-account-id': main().account },
    });
    expect(res.statusCode).toBe(401);
  });
});
