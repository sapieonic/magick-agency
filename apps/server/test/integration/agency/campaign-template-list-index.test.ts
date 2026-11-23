import { afterAll, describe, expect, it } from 'vitest';

/**
 * The campaign template list is read on its scope's partial index (docs/campaign-templates.md
 * CT14): the repository's OWN statement (`campaignTemplateListSql`) is planned here on many tenants'
 * templates, the live list on 0067's `idx_agency_campaign_templates_scope` and the Archived list on
 * 0068's `idx_agency_campaign_templates_archived`, never a scan of every tenant's templates. A
 * partial index is usable only when the planner can prove the statement's predicate implies the
 * index's, so a statement whose archive predicate drifts from the indexes' turns this red. (The db
 * package's migration test pins the index itself; it cannot import the server's statement.)
 */

import { closeTestPool, getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { campaignTemplateListSql } from '../../../src/db/repositories/agency/campaign-template.repository.js';

afterAll(closeTestPool);

describe('the campaign template list and its indexes', () => {
  it('plans the live list on 0067\'s index and the archived list on 0068\'s', async () => {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      // 400 tenants with 3 accounts each, 4 templates per scope, half of them archived.
      await client.query(
        `INSERT INTO agency_campaign_templates (tenant_id, account_id, name, archived_at)
         SELECT t.id, a.id, 'T ' || n, CASE WHEN n % 2 = 0 THEN now() END
           FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 400)) t
           CROSS JOIN LATERAL (SELECT NULL::uuid AS id UNION ALL SELECT gen_random_uuid() FROM generate_series(1, 3)) a
           CROSS JOIN generate_series(1, 4) n`,
      );
      const { rows: [one] } = await client.query<{ tenant_id: string; account_id: string }>(
        `SELECT tenant_id, account_id FROM agency_campaign_templates WHERE account_id IS NOT NULL LIMIT 1`);
      await client.query('ANALYZE agency_campaign_templates');
      const plan = async (archived: boolean): Promise<string> => {
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN ${campaignTemplateListSql(archived)}`, [one!.tenant_id, one!.account_id]);
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      };
      const live = await plan(false);
      expect(live).toContain('idx_agency_campaign_templates_scope');
      expect(live).not.toMatch(/Seq Scan/);
      const archived = await plan(true);
      expect(archived).toContain('idx_agency_campaign_templates_archived');
      expect(archived).not.toMatch(/Seq Scan/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
