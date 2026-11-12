import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── Home's board through the real app and real Postgres ───────────────────────
 *
 * `GET /proxy/agency/home` (decision B28a): session middleware with Firebase stubbed, tenant
 * context, RBAC, the account scope, the dialer flag, the campaign list (`listForHome`), each
 * campaign's stats through `callCore`, its staffing and allocation figures through the insights
 * allocation and its carrier failures and recording over the Health tab's "Today". The order and
 * the cap, that every number is the one the per-campaign route serves, who may read it (the
 * list's and `/stats`' floor, with the insights parts withheld below `agency.supervise`), and the
 * refusals.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'home-board-secret-0123456789abcdef';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import {
  attentionAllocation,
  attentionRangeFigures,
  attentionSettings,
  attentionStaffing,
  type AgencyHomeBoard,
} from '@magick-agency/contracts/api/agency/home';
import type { AgencyInsightsAllocation, AgencyInsightsHealth, AgencyInsightsSummary } from '@magick-agency/contracts/api/agency/insights';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { insightsCache } from '../../../src/agency/insights/cache.js';
import { resetHomeBoardMemosForTests } from '../../../src/agency/home-board.js';
import { todayRange } from '../../../src/agency/insights/health.js';

let loaded: LoadApp;
let floors: TenantFloor[];
const app = () => loaded.app;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

/** Tenant 0: 27 active campaigns and a draft. Tenant 1: drafts only. Tenant 2: none. Tenant 3: dialer off. */
const main = () => floors[0]!;
const sup = (f: TenantFloor = main()): Actor => f.supervisors[0]!;
const C = (i: number) => main().campaigns[i]!;
/** A viewer and an operator of tenant 0's account (the harness seeds agents and supervisors only). */
const readers: Partial<Record<'viewer' | 'operator', Actor>> = {};

/** A member of tenant 0's account with `role`, as the session middleware will resolve them. */
async function seedReader(role: 'viewer' | 'operator'): Promise<Actor> {
  const id = randomUUID();
  const uid = `home-${role}-${id.slice(0, 8)}`;
  await q(`INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
    [id, uid, `${uid}@load.example.com`, role]);
  await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
    [randomUUID(), id, main().tenant, main().account, role]);
  // `Actor['role']` names the harness's two seeded roles; the session reads the membership row.
  return { id, uid, tok: `tok:${uid}`, role: role as unknown as Actor['role'], ip: `10.9.${role === 'viewer' ? 1 : 2}.1` };
}

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
  // Running campaign 13: both agents assigned, one of them on the floor on a break.
  for (const agent of f.agents) {
    await q(`INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
      [f.tenant, f.account, C(13), agent.id]);
  }
  await q(`INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state) VALUES ($1, $2, $3, $4, 'break')`,
    [f.tenant, f.account, C(13), f.agents[0]!.id]);
  // Running campaign 13's rollup: today 2 carrier failures and 3 of 5 connected calls recorded;
  // three days ago 7 more failures and 10 unrecorded calls, which today's figures leave out.
  for (const [ago, connected, recorded, failed] of [['0 hours', 5, 3, 2], ['3 days', 10, 0, 7]] as const) {
    await q(
      `WITH b AS (
         INSERT INTO agency_insights_rollup_buckets (campaign_id, bucket_start, dials, connected, recorded_connected)
         VALUES ($1, date_bin('15 minutes', now() - $2::interval, '2000-01-01'), $5, $3, $4)
         RETURNING campaign_id, bucket_start)
       INSERT INTO agency_insights_rollup_facets (campaign_id, bucket_start, facet, key, n)
       SELECT campaign_id, bucket_start, 'outcome', 'failed', $5 FROM b`,
      [C(13), ago, connected, recorded, failed],
    );
  }
  readers.viewer = await seedReader('viewer');
  readers.operator = await seedReader('operator');
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

  it('never shows or counts another account’s campaigns in the same tenant', async () => {
    // A second account in tenant 0 with the newest running campaign of all: first on the board
    // and one more in the total if the account were not in the query.
    const other = randomUUID();
    await q(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Other account', $3)`,
      [other, main().tenant, `other-${other}`]);
    const { rows } = await q(
      `INSERT INTO agency_campaigns
       SELECT (jsonb_populate_record(NULL::agency_campaigns, to_jsonb(c) || jsonb_build_object(
                 'id', gen_random_uuid(), 'account_id', $2::uuid, 'name', 'Other account campaign',
                 'status', 'running', 'created_at', now()))).*
         FROM agency_campaigns c WHERE c.id = $1
       RETURNING id`,
      [C(13), other],
    );
    try {
      const board = await boardOf();
      expect(board.campaigns.map((c) => c.id)).not.toContain(rows[0]!.id);
      expect(board.active_total).toBe(27);
    } finally {
      await q('DELETE FROM agency_campaigns WHERE account_id = $1', [other]);
      await q('DELETE FROM accounts WHERE id = $1', [other]);
    }
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

  it('serves the insights allocation’s attention figures and staffing', async () => {
    const board = await boardOf();
    for (const i of [13, 14]) {
      const res = await call(app(), 'GET', `/proxy/agency/campaigns/${C(i)}/insights/allocation`, sup(), main());
      expect(res.statusCode, res.body).toBe(200);
      const allocation = res.json() as AgencyInsightsAllocation;
      const onBoard = board.campaigns.find((c) => c.id === C(i))!;
      expect(onBoard.allocation).toEqual(attentionAllocation(allocation));
      expect(onBoard.staffing).toEqual(attentionStaffing(allocation.agents));
    }
    const c13 = board.campaigns.find((c) => c.id === C(13))!;
    expect(c13.allocation!.callbacks_overdue).toBe(3);
    expect(c13.staffing).toEqual({ staffed: 2, online: 1 });
    expect(board.campaigns.find((c) => c.id === C(14))!.allocation!.callbacks_overdue).toBe(0);
    expect(board.campaigns.find((c) => c.id === C(14))!.staffing).toEqual({ staffed: 0, online: 0 });
  });

  it('serves today’s carrier failures and recording as the Health tab serves its Today range', async () => {
    const board = await boardOf();
    const { rows } = await q('SELECT * FROM agency_campaigns WHERE id = $1', [C(13)]);
    const range = todayRange(rows[0], new Date());
    const qs = `from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`;
    const res = await call(app(), 'GET', `/proxy/agency/campaigns/${C(13)}/insights/health?${qs}`, sup(), main());
    expect(res.statusCode, res.body).toBe(200);
    const health = res.json() as AgencyInsightsHealth;
    const onBoard = board.campaigns.find((c) => c.id === C(13))!;
    expect(onBoard.today).toEqual(attentionRangeFigures(health));
    expect(onBoard.today).toEqual({ carrier_failures: 2, recording: { connected: 5, recorded: 3 } });
  });

  it('serves the summary’s recording and calling-hours settings', async () => {
    const board = await boardOf();
    const res = await call(app(), 'GET', `/proxy/agency/campaigns/${C(13)}/insights/summary`, sup(), main());
    expect(res.statusCode, res.body).toBe(200);
    const summary = res.json() as AgencyInsightsSummary;
    expect(board.campaigns.find((c) => c.id === C(13))!.settings).toEqual(attentionSettings(summary.settings));
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

describe('who may read it', () => {
  it.each(['viewer', 'operator'] as const)(
    'serves a %s the supervisor’s campaigns and stats, with the insights parts withheld (null)',
    async (role) => {
      const theirs = await home(readers[role]!);
      expect(theirs.statusCode, theirs.body).toBe(200);
      const board = theirs.json() as AgencyHomeBoard;
      const supervisors = await boardOf();
      expect(board.active_total).toBe(supervisors.active_total);
      expect(board.campaigns.map((c) => c.id)).toEqual(supervisors.campaigns.map((c) => c.id));
      expect(board.campaigns.map((c) => c.stats)).toEqual(supervisors.campaigns.map((c) => c.stats));
      // Campaign 13 has three overdue callbacks, staff, today's figures and settings: the
      // supervisor's board says so, theirs carries none of it.
      const c13 = supervisors.campaigns.find((c) => c.id === C(13))!;
      expect(c13.allocation!.callbacks_overdue).toBe(3);
      expect(c13.staffing).toEqual({ staffed: 2, online: 1 });
      expect(c13.today).not.toBeNull();
      expect(c13.settings).not.toBeNull();
      for (const c of board.campaigns) {
        expect(c).toMatchObject({ staffing: null, allocation: null, today: null, settings: null });
      }
      // The insights reads those parts come from are refused to them on their own routes too.
      const allocation = await call(app(), 'GET', `/proxy/agency/campaigns/${C(13)}/insights/allocation`, readers[role]!, main());
      expect(allocation.statusCode).toBe(403);
      // And `/stats`, whose fields the board carries, is theirs.
      const stats = await call(app(), 'GET', `/proxy/agency/campaigns/${C(13)}/stats`, readers[role]!, main());
      expect(stats.statusCode, stats.body).toBe(200);
    },
  );

  it('a viewer’s board read first is never served to a supervisor, nor theirs to the viewer', async () => {
    const theirs = (await home(readers.viewer!)).json() as AgencyHomeBoard;
    expect(theirs.campaigns.every((c) => c.allocation === null)).toBe(true);
    const supervisors = await boardOf();
    expect(supervisors.campaigns.find((c) => c.id === C(13))!.allocation!.callbacks_overdue).toBe(3);
    const again = (await home(readers.viewer!)).json() as AgencyHomeBoard;
    expect(again.campaigns.every((c) => c.allocation === null && c.settings === null)).toBe(true);
  });
});

describe('a paused campaign’s floor', () => {
  it('an agent joining it shows on the next board, not a minute later (the still memo follows the floor)', async () => {
    const paused = C(0);
    const before = (await boardOf()).campaigns.find((c) => c.id === paused)!;
    expect(before.stats!.agents_live).toBe(0);
    // Past the account board's few seconds, well inside the still memo's minute.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 6_000);
      const { rows } = await q(
        `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state)
         VALUES ($1, $2, $3, $4, 'break') RETURNING id`,
        [main().tenant, main().account, paused, main().agents[1]!.id],
      );
      try {
        const after = (await boardOf()).campaigns.find((c) => c.id === paused)!;
        expect(after.stats!.agents_live).toBe(1);
        expect(after.stats!.agents_by_state!.break).toBe(1);
      } finally {
        await q('DELETE FROM agency_agent_sessions WHERE id = $1', [rows[0]!.id]);
      }
    } finally {
      vi.useRealTimers();
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
