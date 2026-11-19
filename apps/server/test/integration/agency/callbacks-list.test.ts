import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertAccount, insertTenant } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgencyContact, insertAgentSession } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));

const { proxyAgencyCallbacksRoutes } = await import('../../../src/api/routes/proxy-agency-callbacks.routes.js');
const { agencyCallbacksRepository, callbacksPageStatement } = await import('../../../src/db/repositories/agency.repository.js');
const { callbackCodes } = await import('../../../src/db/repositories/agency/assignment-sql.js');
const { localDayEnd } = await import('../../../src/agency/calling-hours.js');

type Page = import('@magick-agency/contracts/api/agency/callbacks').AgencyCallbacksPage;
type Deps = import('../../../src/api/routes/proxy-agency-callbacks.routes.js').CallbacksRouteDeps;

/**
 * The account's callbacks list (decisions LF1, LF22) on a real Postgres, through its route with the
 * real repository (`proxy-agency-callbacks.routes.ts`, `callbacks.repository.ts`): the open callbacks
 * of the account's active campaigns only, overdue or due later today, ordered by due time across
 * campaigns, paged without a gap or a repeat; never another account's or another tenant's, never a
 * closed campaign's; the owner named and live by the CA5 rule; the customer's name, never the
 * number. Then the plan: each campaign's page on `idx_agency_contacts_callbacks` (the 0053
 * migration), never the dialable index over the undialled roster.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const MIN = 60_000;
const CATALOG = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'call_back', label: 'Call back', requires_datetime: true },
];

type Id = { id: string };
let c1: Id;
let c2: Id;
let app: FastifyInstance;
let caller: { tenantId: string; accountId: string } = { tenantId: T, accountId: A };
const LIVE_OWNER = randomUUID();
const AWAY_OWNER = randomUUID();
const ids: Record<string, string> = {};

/** A callback on `campaign` due `minutesFromNow` (negative: overdue). */
async function callback(name: string, campaign: Id, minutesFromNow: number, over: Record<string, unknown> = {}) {
  const row = await insertAgencyContact(campaign.id, {
    context: JSON.stringify({ name: `Customer ${name}` }), phone_e164: '+919811122233',
    attempt_count: 1, last_outcome: 'connected', last_disposition: 'call_back',
    next_attempt_at: new Date(Date.now() + minutesFromNow * MIN), ...over,
  }) as Id;
  ids[name] = row.id;
  return row;
}

const owned = (owner: string) => ({ assigned_user_id: owner, assigned_at: new Date() });

beforeAll(async () => {
  await truncateAll();
  await insertTenant({ id: T });
  await insertAccount({ id: A, tenant_id: T });
  await insertAccount({ id: OTHER_ACCOUNT, tenant_id: T });
  await insertTenant({ id: OTHER_TENANT });

  c1 = await insertAgencyCampaign({ status: 'running', name: 'Renewals', assignment_mode: 'strict', default_timezone: 'UTC', disposition_catalog: JSON.stringify(CATALOG) }) as Id;
  c2 = await insertAgencyCampaign({ status: 'paused', name: 'Winback', default_timezone: 'Asia/Kolkata', disposition_catalog: JSON.stringify(CATALOG) }) as Id;
  const done = await insertAgencyCampaign({ status: 'completed', name: 'Done', disposition_catalog: JSON.stringify(CATALOG) }) as Id;
  const otherAccount = await insertAgencyCampaign({ status: 'running', account_id: OTHER_ACCOUNT, disposition_catalog: JSON.stringify(CATALOG) }) as Id;
  const otherTenant = await insertAgencyCampaign({ status: 'running', tenant_id: OTHER_TENANT, account_id: randomUUID(), disposition_catalog: JSON.stringify(CATALOG) }) as Id;
  await insertAgentSession(c1.id, { agent_user_id: LIVE_OWNER, state: 'break' });

  // Today, in UTC (c1's zone): a callback due halfway between now and midnight, one after it.
  const dayEnd = localDayEnd('UTC', new Date())!;
  const toMidnight = (dayEnd.getTime() - Date.now()) / MIN;

  await callback('overdue50', c1, -50, owned(AWAY_OWNER));
  await callback('overdue40', c2, -40);
  await callback('overdue30', c1, -30, owned(LIVE_OWNER));
  await callback('inbound20', c1, -20, {
    last_outcome: null, last_disposition: null, attempt_count: 0, callback_source: 'inbound', callback_due_at: new Date(Date.now() - 20 * MIN),
  });
  await callback('overdue10', c1, -10, owned(AWAY_OWNER));
  await callback('today', c1, toMidnight / 2);
  await callback('tomorrow', c1, toMidnight + 60);
  // Not callbacks, or not open, or not this account's active campaigns.
  await callback('sale', c1, -15, { last_disposition: 'sale' });
  await callback('undialled', c1, -60 * 24, { attempt_count: 0, last_outcome: null, last_disposition: null });
  await callback('unreached', c1, -15, { last_outcome: 'no_answer' });
  await callback('inFlight', c1, -15, { state: 'in_flight' });
  await callback('reached', c1, -15, { state: 'completed' });
  await callback('closedCampaign', done, -15);
  await callback('otherAccount', otherAccount, -15, { account_id: OTHER_ACCOUNT });
  await callback('otherTenant', otherTenant, -15, { tenant_id: OTHER_TENANT, account_id: randomUUID() });

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = caller.tenantId;
    r['accountId'] = caller.accountId;
    r['user'] = { id: randomUUID() };
    r['membership'] = { role: 'account_admin', account_id: caller.accountId, status: 'active' };
  });
  const deps: Deps = {
    activeCampaigns: (t, a, c) => agencyCallbacksRepository.activeCampaigns(t, a, c),
    page: (input) => agencyCallbacksRepository.page(input),
    names: async (owners) => new Map([...owners].filter((o): o is string => !!o).map((o) => [o, o === LIVE_OWNER ? 'Priya M' : 'Naveen G'])),
    dialerEnabled: async () => true,
    now: () => new Date(),
  };
  await app.register(proxyAgencyCallbacksRoutes, { prefix: '/proxy/agency', deps });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeTestPool();
});

async function list(query = ''): Promise<Page> {
  const res = await app.inject({ method: 'GET', url: `/proxy/agency/callbacks${query ? `?${query}` : ''}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const names = (page: Page) => page.rows.map((r) => Object.entries(ids).find(([, id]) => id === r.contact_id)?.[0]);

describe('GET /callbacks on Postgres', () => {
  it('overdue: the open callbacks of the account\'s active campaigns, oldest due first, across campaigns', async () => {
    const page = await list();
    expect(names(page)).toEqual(['overdue50', 'overdue40', 'overdue30', 'inbound20', 'overdue10']);
    expect(page).toMatchObject({ due: 'overdue', next_cursor: null, limit: 50 });
    const byName = new Map(page.rows.map((r, i) => [names(page)[i], r]));
    expect(byName.get('overdue50')).toEqual({
      contact_id: ids['overdue50'], campaign_id: c1.id, campaign_name: 'Renewals', assignment_mode: 'strict',
      customer_name: 'Customer overdue50', due_at: expect.any(String),
      owner: { user_id: AWAY_OWNER, name: 'Naveen G', live: false }, source: 'outcome',
    });
    expect(byName.get('overdue30')!.owner).toEqual({ user_id: LIVE_OWNER, name: 'Priya M', live: true });
    expect(byName.get('overdue40')).toMatchObject({ campaign_id: c2.id, campaign_name: 'Winback', assignment_mode: 'pool', owner: null });
    expect(byName.get('inbound20')).toMatchObject({ source: 'inbound', owner: null });
    const dues = page.rows.map((r) => Date.parse(r.due_at));
    expect([...dues].sort((a, b) => a - b)).toEqual(dues);
  });

  it('never a number, in a row or in a cursor', async () => {
    const page = await list('limit=1');
    expect(JSON.stringify(page)).not.toMatch(/9811122233/);
    expect(Buffer.from(page.next_cursor!, 'base64url').toString('utf8')).not.toMatch(/9811122233/);
  });

  it('today: due from now until the campaign\'s own midnight, nothing overdue and nothing tomorrow', async () => {
    expect(names(await list('due=today'))).toEqual(['today']);
  });

  it('pages by due time without a gap or a repeat, whatever the page size', async () => {
    const all = names(await list());
    for (const limit of [1, 2, 3]) {
      const seen: Array<string | undefined> = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Page = await list(`limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.rows.length).toBeLessThanOrEqual(limit);
        seen.push(...names(page));
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(seen, `limit ${limit}`).toEqual(all);
    }
  });

  it('one campaign named: only its rows; a campaign not active or not the account\'s: none', async () => {
    expect(names(await list(`campaign_id=${c2.id}`))).toEqual(['overdue40']);
    const { rows } = await getTestPool().query<{ id: string }>(
      `SELECT campaign_id::text AS id FROM agency_contacts WHERE id = ANY($1::uuid[])`, [[ids['closedCampaign'], ids['otherAccount'], ids['otherTenant']]]);
    for (const r of rows) expect((await list(`campaign_id=${r.id}`)).rows).toEqual([]);
  });

  it('another account, and another tenant, see none of these', async () => {
    caller = { tenantId: T, accountId: OTHER_ACCOUNT };
    try {
      expect(names(await list())).toEqual(['otherAccount']);
    } finally {
      caller = { tenantId: T, accountId: A };
    }
    caller = { tenantId: OTHER_TENANT, accountId: A };
    try {
      expect((await list()).rows).toEqual([]);
    } finally {
      caller = { tenantId: T, accountId: A };
    }
  });
});

describe('the plan, on seeded rosters', () => {
  /** Every node of a JSON plan. */
  function nodes(plan: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (Array.isArray(plan)) for (const p of plan) nodes(p, out);
    else if (plan && typeof plan === 'object') {
      const node = plan as Record<string, unknown>;
      if (typeof node['Node Type'] === 'string') out.push(node);
      for (const v of Object.values(node)) if (v && typeof v === 'object') nodes(v, out);
    }
    return out;
  }

  beforeAll(async () => {
    // Each active campaign: 20,000 contacts never dialled (all due since their upload) and 200
    // callbacks (100 overdue). The roster is what the dialable index walked.
    for (const c of [c1, c2]) {
      await getTestPool().query(
        `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state, attempt_count,
                                      last_outcome, last_disposition, next_attempt_at)
         SELECT $1, $2, $3, '+9170' || lpad(g::text, 8, '0'), '{}'::jsonb, 'pending',
                CASE WHEN g <= 200 THEN 1 ELSE 0 END,
                CASE WHEN g <= 200 THEN 'connected' END,
                CASE WHEN g <= 200 THEN 'call_back' END,
                CASE WHEN g <= 100 THEN now() - g * interval '1 minute'
                     WHEN g <= 200 THEN now() + g * interval '1 minute'
                     ELSE now() - interval '2 days' END
           FROM generate_series(1, 20000) g`, [c.id, T, A]);
    }
    await getTestPool().query('ANALYZE agency_contacts');
  }, 120_000);

  async function plan(due: 'overdue' | 'today', analyze = false): Promise<Array<Record<string, unknown>>> {
    const now = new Date();
    const campaigns = await agencyCallbacksRepository.activeCampaigns(T, A, null);
    const { text, values } = callbacksPageStatement({
      tenantId: T, accountId: A, due, now, after: null, take: 51,
      campaigns: campaigns.map((c) => ({ id: c.id, callbackCodes: callbackCodes(c.disposition_catalog), dayEnd: localDayEnd(c.default_timezone, now)! })),
    });
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT JSON) ${text}`, values);
    return nodes(rows[0]!['QUERY PLAN']);
  }

  it.each(['overdue', 'today'] as const)('%s: each campaign\'s page on idx_agency_contacts_callbacks, never the roster', async (due) => {
    const p = await plan(due, true);
    const onContacts = p.filter((n) => n['Relation Name'] === 'agency_contacts' || String(n['Index Name'] ?? '').startsWith('idx_agency_contacts'));
    expect(p.filter((n) => n['Index Name'] === 'idx_agency_contacts_callbacks').length, JSON.stringify(onContacts.map((n) => [n['Node Type'], n['Index Name']]))).toBeGreaterThan(0);
    expect(p.some((n) => n['Index Name'] === 'idx_agency_contacts_dialable')).toBe(false);
    expect(p.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'agency_contacts')).toBe(false);
    // Read: the callbacks, a few hundred rows across both campaigns, never the 40,000 of the rosters.
    const read = onContacts
      .filter((n) => typeof n['Actual Rows'] === 'number' && String(n['Node Type']).includes('Scan'))
      .reduce((s, n) => s + (n['Actual Rows'] as number) * ((n['Actual Loops'] as number) ?? 1), 0);
    expect(read).toBeLessThan(1_000);
  });
});
