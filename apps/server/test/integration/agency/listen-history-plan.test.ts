import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { LISTEN_HISTORY_SQL } = await import('../../../src/db/repositories/agency/listen-history.repository.js');
const { AGENCY_LISTEN_HISTORY_MERGE_GAP_MS } = await import('@magick-agency/contracts/api/agency/listen-history');

/**
 * The listening history's read is bounded per page (docs/listening.md §12, LS22 t): it walks the
 * account's live sessions newest first on `idx_agency_listen_sessions_account_started` (0049),
 * keyed by the tenant and the account, and stops once it has found the page's visits, rather than
 * windowing every session the account (or, without a supervisor filter, the tenant) has kept for
 * 85 days on every page; the CSV export drains up to 100 pages.
 *
 * Seeded with {@link SESSIONS} live sessions over two accounts (a few reconnects each, so visits
 * merge), then ANALYZE, `enable_seqscan` left on. The index's NAME and its CONDITION are asserted
 * (the partial index scanned whole, every tenant's sessions, would pass a name-only check), and the
 * rows the walk read, from EXPLAIN ANALYZE: a page of 50 reads about 50 sessions and their
 * reconnects, not the account's thousands.
 *
 * Mutation-checked: the old statement (the merge windowed over every session the filters keep,
 * the page cut after it) reads every one of the account's sessions and fails the row bound.
 */

const SESSIONS = 20_000;
const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const TARGET_INDEX = 'idx_agency_listen_sessions_account_started';

interface PlanNode { 'Node Type'?: string; 'Index Name'?: string; 'Index Cond'?: string; 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; Plans?: PlanNode[] }

function nodes(plan: unknown, out: PlanNode[] = []): PlanNode[] {
  if (Array.isArray(plan)) for (const p of plan) nodes(p, out);
  else if (plan && typeof plan === 'object') {
    const node = plan as PlanNode & Record<string, unknown>;
    if (typeof node['Node Type'] === 'string') out.push(node);
    for (const v of Object.values(node)) if (v && typeof v === 'object') nodes(v, out);
  }
  return out;
}

async function explain(params: unknown[]): Promise<PlanNode[]> {
  const { rows } = await getTestPool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${LISTEN_HISTORY_SQL}`, params);
  return nodes(rows[0]!['QUERY PLAN']);
}

const params = (o: { listener?: string | null; before?: { at: string; id: string } | null } = {}) => [
  T, A, o.listener ?? null, null, null, null, AGENCY_LISTEN_HISTORY_MERGE_GAP_MS, o.before?.at ?? null, 51, o.before?.id ?? null,
];

describe('the listening history\'s plan', () => {
  let middle: { at: string; id: string };

  beforeAll(async () => {
    await truncateAll();
    const pool = getTestPool();
    // 20,000 live sessions, a minute apart, over two accounts and 20 supervisors; every third one
    // a reconnect 10 s after the one before it on the same call (merged into its visit).
    await pool.query(
      `INSERT INTO agency_listen_sessions (id, tenant_id, account_id, call_id, origin, correlation_id, agent_session_id,
         agent_user_id, listener_user_id, started_at, ended_at, end_reason, replica_id, live_at)
       SELECT gen_random_uuid(), $1::uuid, CASE WHEN (g / 3) % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
              md5('call' || (g / 3))::uuid, 'manual', gen_random_uuid(), gen_random_uuid(),
              md5('agent' || (g % 7))::uuid, md5('listener' || (g / 3 % 20))::uuid,
              timestamptz '2026-09-01T00:00:00Z' + (g || ' minutes')::interval,
              timestamptz '2026-09-01T00:00:00Z' + (g || ' minutes')::interval + interval '50 seconds',
              'listener_stopped', 'r1',
              timestamptz '2026-09-01T00:00:00Z' + (g || ' minutes')::interval
         FROM generate_series(1, ${SESSIONS}) g`, [T, A, OTHER_ACCOUNT]);
    await pool.query('ANALYZE agency_listen_sessions');
    const { rows } = await pool.query<{ at: string; id: string }>(
      `SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, id::text FROM agency_listen_sessions
        WHERE account_id = $1 ORDER BY started_at DESC, id DESC OFFSET 5000 LIMIT 1`, [A]);
    middle = rows[0]!;
  }, 120_000);
  afterAll(closeTestPool);

  for (const [name, p] of [
    ['the first page', () => params()],
    ['a page from a cursor', () => params({ before: middle })],
  ] as const) {
    it(`${name}: walks ${TARGET_INDEX} by the tenant and the account, and reads about a page of sessions`, async () => {
      const plan = await explain(p());
      const walk = plan.find((n) => n['Index Name'] === TARGET_INDEX);
      expect(walk, JSON.stringify(plan.map((n) => [n['Node Type'], n['Index Name'] ?? n['Relation Name']]))).toBeDefined();
      expect(walk!['Index Cond']).toMatch(/tenant_id = .*account_id = /);
      expect(plan.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'agency_listen_sessions')).toEqual([]);
      // Every read of the table, across every loop: a page of 50 visits and their sessions, not
      // the account's 10,000.
      const read = plan
        .filter((n) => n['Relation Name'] === 'agency_listen_sessions')
        .reduce((sum, n) => sum + (n['Actual Rows'] ?? 0) * (n['Actual Loops'] ?? 1), 0);
      expect(read).toBeLessThan(1_000);
    });
  }
});
