import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { judgeDbConnectionBudget, readDbConnectionBudget } from '../../../src/cluster/db-connection-budget.js';

/* The boot check's query against a real Postgres: it reads the settings the server enforces. */
describe('readDbConnectionBudget against Postgres', () => {
  afterAll(async () => { await closeTestPool(); });

  it('reads max_connections and superuser_reserved_connections as the server reports them', async () => {
    const pool = getTestPool();
    const { rows } = await pool.query<{ max_connections: string; superuser_reserved_connections: string }>(
      "SELECT current_setting('max_connections') AS max_connections, current_setting('superuser_reserved_connections') AS superuser_reserved_connections");
    const plan = { primary: 30, mediaWorkers: 2, perMediaWorker: 10, analysisWorkers: 0, perAnalysisWorker: 0, total: 50 };
    const budget = await readDbConnectionBudget((sql) => pool.query(sql), plan);
    expect(budget).toEqual(judgeDbConnectionBudget(plan, Number(rows[0]!.max_connections), Number(rows[0]!.superuser_reserved_connections)));
    expect(budget!.maxConnections).toBeGreaterThan(0);
  });
});
