import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant } from '../setup/factories.js';

/**
 * ─── THE DO NOT CALL LIST'S NUMBER SEARCH, AGAINST REAL POSTGRES ─────────────
 *
 * `GET /dnc?phone=` used to compare the typed text with `phone_e164` exactly, so a supervisor who
 * typed a customer's ten digits was told the number was not on the list when it was. The text is
 * now read by `dncPhoneSearch` (the customer-history search's number rule, plus the digits typed
 * as an ending) and matched by `phoneSearchCondition`. These cases run the real statement on real
 * rows: what each typed form finds, that another tenant's rows never come back, and that both arms
 * are served by an index (0034's reversed-number index for the ending), never a scan of the
 * tenant's rows.
 *
 * The statement EXPLAINed is the one the repository really sent, captured from the pool, so there
 * is no copy of the SQL here to drift.
 */

/** Every statement the repository sends, with its values. */
const sent: Array<{ sql: string; params: unknown[] }> = [];

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({
    query: (sql: string, params?: unknown[]) => {
      sent.push({ sql, params: [...(params ?? [])] });
      return getTestPool().query(sql, params);
    },
  }),
}));

const { DncRepository } = await import('../../../src/dnc/dnc.repository.js');
const { dncPhoneSearch } = await import('../../../src/dnc/dnc.service.js');

const repo = new DncRepository();

const LISTED = '+919908815060';
const US_LISTED = '+15551234567';
const NEIGHBOUR = '+919908800000';
const UK_LISTED = '+442079460018';

let tenantId: string;
let otherTenantId: string;

async function insertDncRow(tenant: string, phone: string, accountId: string | null = null): Promise<void> {
  await getTestPool().query(
    `INSERT INTO dnc_entries (tenant_id, account_id, phone_e164, source) VALUES ($1, $2, $3, 'api')`,
    [tenant, accountId, phone],
  );
}

/** What the box finds for `typed`, India the platform default. */
async function search(typed: string, tenant = tenantId): Promise<string[]> {
  const { entries, total } = await repo.list({
    tenantId: tenant,
    phone: dncPhoneSearch(typed, '91'),
    limit: 50,
    offset: 0,
  });
  expect(total).toBe(entries.length);
  return entries.map((e) => e.phone_e164).sort();
}

afterAll(async () => {
  await getTestPool().query('TRUNCATE dnc_entries').catch(() => undefined);
  await closeTestPool();
});

describe('what each typed form of a listed number finds', () => {
  beforeAll(async () => {
    await truncateAll();
    tenantId = (await insertTenant()).id as string;
    otherTenantId = (await insertTenant()).id as string;
    const accountId = (await insertAccount({ tenant_id: tenantId })).id as string;
    await insertDncRow(tenantId, LISTED, accountId);
    await insertDncRow(tenantId, US_LISTED);
    await insertDncRow(tenantId, NEIGHBOUR);
    await insertDncRow(tenantId, UK_LISTED);
    // The same number on another tenant's list: never this tenant's answer.
    await insertDncRow(otherTenantId, LISTED);
  });

  it.each([
    ['+919908815060'],
    ['9908815060'],
    ['919908815060'],
    ['+91 99088 15060'],
    ['099088-15060'],
    ['0091 99088 15060'],
    ['15060'],
  ])('%s finds the entry', async (typed) => {
    expect(await search(typed)).toEqual([LISTED]);
  });

  it('a shorter ending finds every entry that ends in it', async () => {
    expect(await search('0')).toEqual([NEIGHBOUR, LISTED]);
  });

  it('a national number of another country is found by its ending', async () => {
    expect(await search('5551234567')).toEqual([US_LISTED]);
  });

  it('a whole number only the search rule can read is found by the exact arm', async () => {
    // The bracketed trunk `(0)` is dropped by the rule; its digits (4402079460018) are no ending.
    expect(await search('+44 (0)20 7946 0018')).toEqual([UK_LISTED]);
  });

  it('digits in the middle of a number are not an ending', async () => {
    expect(await search('99088')).toEqual([]);
  });

  it('letters match nothing, and a wildcard is data', async () => {
    expect(await search('abc')).toEqual([]);
    expect(await search('%')).toEqual([]);
  });

  it('never returns another tenant’s row', async () => {
    expect(await search('9908815060', otherTenantId)).toEqual([LISTED]);
    expect(await search('5551234567', otherTenantId)).toEqual([]);
  });
});

// ── The plan ───────────────────────────────────────────────────────────────

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/** Enough rows that the planner prefers an index on its own merits (see `dnc-index-usage.test.ts`). */
const SEEDED_ROWS = 50_000;
const SEEDED_TENANTS = 3;

/** EXPLAIN the page query the repository sent for `typed`. */
async function planFor(typed: string): Promise<{ indexNames: string[]; seqScans: number; json: string }> {
  sent.length = 0;
  await repo.list({ tenantId, phone: dncPhoneSearch(typed, '91'), limit: 50, offset: 0 });
  const page = sent.find((s) => s.sql.includes('ORDER BY created_at DESC'))!;
  const { rows } = await getTestPool().query(`EXPLAIN (FORMAT JSON) ${page.sql}`, page.params);
  const plan = (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  const nodes = flatten(plan);
  return {
    indexNames: nodes.map((n) => n['Index Name']).filter((n): n is string => Boolean(n)),
    seqScans: nodes.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'dnc_entries').length,
    json: JSON.stringify(rows[0]!['QUERY PLAN'], null, 2),
  };
}

describe(`at ${SEEDED_ROWS.toLocaleString('en-US')} rows the search is index-served`, () => {
  beforeAll(async () => {
    await truncateAll();
    const tenants: string[] = [];
    for (let i = 0; i < SEEDED_TENANTS; i++) tenants.push((await insertTenant()).id as string);
    tenantId = tenants[0]!;
    await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
       SELECT (ARRAY[$1::uuid, $2::uuid, $3::uuid])[1 + (g % $4::int)], NULL, NULL,
              '+91' || (9000000000 + g)::text, 'import'
         FROM generate_series(1, $5::int) g`,
      [tenants[0], tenants[1], tenants[2], SEEDED_TENANTS, SEEDED_ROWS],
    );
    await getTestPool().query('ANALYZE dnc_entries');
    const { rows } = await getTestPool().query<{ setting: string }>(
      `SELECT setting FROM pg_settings WHERE name = 'enable_seqscan'`,
    );
    // With sequential scans off, "it used an index" would be a tautology.
    expect(rows[0]!.setting).toBe('on');
  });

  it('a partial number uses the reversed-number index (0034)', async () => {
    const plan = await planFor('12345');
    expect(plan.indexNames, plan.json).toContain('idx_dnc_entries_tenant_phone_reversed');
    expect(plan.seqScans, plan.json).toBe(0);
  });

  it('a whole number uses both the exact index and the reversed one', async () => {
    const plan = await planFor('9000012345');
    expect(plan.indexNames, plan.json).toContain('idx_dnc_entries_tenant_phone');
    expect(plan.indexNames, plan.json).toContain('idx_dnc_entries_tenant_phone_reversed');
    expect(plan.seqScans, plan.json).toBe(0);
  });
});
