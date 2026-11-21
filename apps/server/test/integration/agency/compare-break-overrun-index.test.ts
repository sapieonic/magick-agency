import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Compare agents' breaks over their limit are read on 0066's partial index
 * (`idx_agency_session_events_break_overrun`, docs/compare-agents.md §7): the read's OWN statement,
 * `COMPARE_BREAK_OVERRUNS_SQL`, is planned here on a campaign with many state changes and few
 * overruns, and the index must be in the plan (not the campaign's every-event index). A partial
 * index is only usable when the planner can prove the statement's predicate implies the index's, so
 * a statement that drifts from 0066's predicate turns this red. (The db package's migration test pins
 * the index itself; it cannot import the server's statement.)
 */

import { closeTestPool, getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { COMPARE_BREAK_OVERRUNS_SQL } from '../../../src/db/repositories/agency/compare-reads.js';

afterAll(closeTestPool);

describe('the breaks over their limit statement and 0066', () => {
  it('plans on idx_agency_session_events_break_overrun', async () => {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      const tenant = randomUUID();
      const account = randomUUID();
      const campaign = randomUUID();
      await client.query(`INSERT INTO tenants (id, name, slug, settings, status) VALUES ($1, 'T', $2, '{}', 'active')`, [tenant, `t-${tenant.slice(0, 8)}`]);
      await client.query(
        `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids, telephony_provider, status)
         VALUES ($1, $2, $3, 'C', ARRAY['+919000000001'], 'voicelink', 'running')`, [campaign, tenant, account]);
      // Fifty agents on the campaign, each with many state changes and one overrun in a hundred.
      const { rows: agents } = await client.query<{ agent_user_id: string }>(
        `WITH s AS (
           INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, kind, state, joined_at)
           SELECT gen_random_uuid(), $1, $2, $3, gen_random_uuid(), 'campaign', 'offline', now() - interval '30 days'
             FROM generate_series(1, 50) RETURNING id, tenant_id, account_id, campaign_id, agent_user_id),
         e AS (
           INSERT INTO agency_agent_session_events (session_id, tenant_id, account_id, campaign_id, agent_user_id, from_state, to_state, at,
                                                    break_limit_minutes, break_overrun_seconds)
           SELECT s.id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
                  CASE WHEN n % 100 = 0 THEN 'break' ELSE 'available' END, 'on_call',
                  now() - (n || ' minutes')::interval,
                  CASE WHEN n % 100 = 0 THEN 15 END, CASE WHEN n % 100 = 0 THEN 60 END
             FROM s, generate_series(1, 400) n)
         SELECT agent_user_id FROM s`,
        [tenant, account, campaign],
      );
      await client.query('ANALYZE agency_agent_session_events');
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86_400_000);
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${COMPARE_BREAK_OVERRUNS_SQL}`,
        [campaign, tenant, account, from, to, agents.map((a) => a.agent_user_id)],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('idx_agency_session_events_break_overrun');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
