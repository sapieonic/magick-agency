import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Compare agents' trend days are read on 0065's partial index (`idx_agency_session_events_offline`,
 * docs/compare-agents.md §7): the read's OWN statement, `COMPARE_LOGGED_IN_DAYS_SQL` with the
 * server's `OFFLINE_BOUNDARY_EVENT_SQL` in it, is planned here and the index must be in the plan. A
 * partial index is only usable when the planner can prove the statement's predicate implies the
 * index's, so a constant that drifts from 0065's predicate turns this red. (The db package's
 * migration test pins the index itself; it cannot import the server's constant.)
 */

import { closeTestPool, getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { COMPARE_LOGGED_IN_DAYS_SQL } from '../../../src/db/repositories/agency/compare-reads.js';

afterAll(closeTestPool);

describe('the trend days\' statement and 0065', () => {
  it('plans its offline boundaries on idx_agency_session_events_offline', async () => {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      const tenant = randomUUID();
      const account = randomUUID();
      const campaign = randomUUID();
      const agentId = randomUUID();
      await client.query(`INSERT INTO tenants (id, name, slug, settings, status) VALUES ($1, 'T', $2, '{}', 'active')`, [tenant, `t-${tenant.slice(0, 8)}`]);
      await client.query(
        `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids, telephony_provider, status)
         VALUES ($1, $2, $3, 'C', ARRAY['+919000000001'], 'voicelink', 'running')`, [campaign, tenant, account]);
      // Fifty agents' sessions on the campaign, each with many state changes and few offline boundaries.
      await client.query(
        `WITH s AS (
           INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, kind, state, joined_at)
           SELECT gen_random_uuid(), $1, $2, $3, CASE WHEN g = 1 THEN $4::uuid ELSE gen_random_uuid() END, 'campaign', 'offline', now() - interval '30 days'
             FROM generate_series(1, 50) g RETURNING id, tenant_id, account_id, campaign_id, agent_user_id)
         INSERT INTO agency_agent_session_events (session_id, tenant_id, account_id, campaign_id, agent_user_id, from_state, to_state, at)
         SELECT s.id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
                CASE WHEN n % 100 = 0 THEN 'offline' ELSE 'available' END,
                CASE WHEN n % 100 = 1 THEN 'offline' ELSE 'on_call' END,
                now() - (n || ' minutes')::interval
           FROM s, generate_series(1, 400) n`,
        [tenant, account, campaign, agentId],
      );
      await client.query('ANALYZE agency_agent_sessions');
      await client.query('ANALYZE agency_agent_session_events');
      // Only the index paths are in play: what is left is whether the predicate lets this one serve.
      await client.query('SET LOCAL enable_seqscan = off');
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 86_400_000);
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${COMPARE_LOGGED_IN_DAYS_SQL}`,
        [campaign, tenant, account, from, to, [agentId], 'Asia/Kolkata'],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('idx_agency_session_events_offline');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
