// TEMPORARY DIAGNOSTIC (fix/flaky-integration): prints the real plans of the 10,000-contact
// random_split, without and with table statistics. Removed before the PR leaves draft.
import { afterAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertAccount, insertTenant, insertUser } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

const diag = vi.hoisted(() => ({ pool: null as pg.Pool | null, notices: [] as string[] }));

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => diag.pool!,
}));

const repo = await import('../../../src/db/repositories/agency.repository.js');
const { parseAssignmentOperation } = await import('../../../src/agency/assignment/operation.js');
const { callbackCodes } = await import('../../../src/db/repositories/agency/assignment-sql.js');

const CATALOG = [{ code: 'interested', label: 'Interested', is_success: true, terminal: true }];

function openPool(): pg.Pool {
  const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 3 });
  pool.on('connect', (client) => {
    client.on('notice', (n) => diag.notices.push(n.message ?? String(n)));
    void client.query(`LOAD 'auto_explain'`);
    void client.query(`SET auto_explain.log_min_duration = 300`);
    void client.query(`SET auto_explain.log_analyze = on`);
    void client.query(`SET auto_explain.log_nested_statements = on`);
    void client.query(`SET auto_explain.log_level = notice`);
  });
  return pool;
}

async function setup(): Promise<{ campaign: { id: string; tenant_id: string }; agents: string[] }> {
  await truncateAll();
  await insertTenant({ id: DEFAULTS.tenantId });
  await insertAccount({ id: DEFAULTS.accountId, tenant_id: DEFAULTS.tenantId });
  const campaign = await insertAgencyCampaign({ disposition_catalog: JSON.stringify(CATALOG) }) as { id: string; tenant_id: string };
  const agents: string[] = [];
  for (let i = 0; i < 5; i++) {
    const u = await insertUser() as { id: string };
    agents.push(u.id);
    await getTestPool().query(
      'INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)',
      [DEFAULTS.tenantId, DEFAULTS.accountId, campaign.id, u.id],
    );
  }
  const phones = Array.from({ length: 10_000 }, (_, i) => `+9190${String(i + 1).padStart(8, '0')}`);
  await getTestPool().query(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, csv_line_number, context, state)
     SELECT $1, $2, $3, p.phone, p.i, '{}'::jsonb, 'pending' FROM unnest($4::text[]) WITH ORDINALITY AS p(phone, i)`,
    [campaign.id, DEFAULTS.tenantId, DEFAULTS.accountId, phones],
  );
  return { campaign, agents };
}

async function run(label: string, analyze: boolean): Promise<void> {
  const { campaign, agents } = await setup();
  if (analyze) await getTestPool().query('ANALYZE agency_contacts');
  diag.pool = openPool();
  diag.notices = [];
  const scope = { campaignId: campaign.id, tenantId: campaign.tenant_id, callbackCodes: callbackCodes(CATALOG as never) };
  const parsed = parseAssignmentOperation({ kind: 'random_split', agent_user_ids: agents, seed: 'diag' }, 'commit');
  if (!parsed.ok) throw new Error('bad op');
  const t0 = Date.now();
  const preview = await repo.agencyAssignmentRepository.preview(parsed.op, scope);
  const t1 = Date.now();
  const outcome = await repo.agencyAssignmentRepository.commit({ op: parsed.op, scope, token: preview.preview_token, actorUserId: null });
  const t2 = Date.now();
  await diag.pool.end();
  diag.pool = null;
  const { rows } = await getTestPool().query<{ reltuples: number; last_analyze: string | null; last_autoanalyze: string | null }>(
    `SELECT c.reltuples, s.last_analyze, s.last_autoanalyze FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid WHERE c.relname = 'agency_contacts'`);
  process.stdout.write(
    `\n===== DIAG ${label}: preview ${t1 - t0} ms, commit ${t2 - t1} ms, ok=${outcome.ok}, stats=${JSON.stringify(rows[0])}\n`
    + diag.notices.map((n) => `----- plan -----\n${n}\n`).join('')
    + `===== END DIAG ${label}\n`,
  );
  expect(outcome.ok).toBe(true);
}

afterAll(closeTestPool);

describe('DIAG random_split 10k plans', () => {
  it('without statistics (as the test runs)', async () => { await run('no-stats', false); }, 120_000);
  it('after ANALYZE agency_contacts', async () => { await run('analyzed', true); }, 120_000);
});
