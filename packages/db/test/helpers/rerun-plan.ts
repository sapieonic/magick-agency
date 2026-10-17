import type pg from 'pg';

/**
 * The plan that makes `WHERE id IN (SELECT … ORDER BY … LIMIT n FOR UPDATE SKIP
 * LOCKED)` claim more than `n` rows, set up so a case gets it every time.
 *
 * Postgres can join that subquery as the INNER side of a nested-loop semi join and
 * re-run it for every outer row. Each re-run skips the rows the statement has
 * already updated (a row this command modified is "self-modified", which LockRows
 * treats as gone), so the LIMIT hands out the next row, and the next, and the join
 * matches them one by one while the outer scan meets the rows in the subquery's
 * order. Postgres picks that plan when it expects about one outer row, so whether a
 * case saw it used to depend on the statistics, bloat and free space earlier test
 * files left in the table (`truncateAll` DELETEs; it does not TRUNCATE).
 *
 * The recipe, all three parts needed:
 *  1. {@link freshTables}: TRUNCATE the fixture tables, so heap, indexes and free
 *     space start empty and rows land in the heap in insertion order.
 *  2. Insert ONE fixture row, ANALYZE, then insert the rest (in the subquery's
 *     ORDER BY order): the statistics say one row on one page, so the planner
 *     expects one outer row.
 *  3. {@link withReRunningPlan}: a connection with hash and merge joins, hash
 *     aggregation and materialisation off, which leaves the re-running semi join
 *     cheaper than unique-ifying the subquery.
 * {@link assertReRunningPlan} then checks the plan is the re-running one.
 */
const SETTINGS = ['enable_hashjoin', 'enable_mergejoin', 'enable_hashagg', 'enable_material'] as const;

/** TRUNCATE (CASCADE) the tables a case's fixture lives in. */
export async function freshTables(pool: pg.Pool, tables: readonly string[]): Promise<void> {
  await pool.query(`TRUNCATE ${tables.join(', ')} CASCADE`);
}

/** Run `fn` on a dedicated connection with the settings above, reset afterwards. */
export async function withReRunningPlan<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    for (const setting of SETTINGS) await client.query(`SET ${setting} = off`);
    return await fn(client);
  } finally {
    await client.query('RESET ALL').catch(() => { /* connection already gone */ });
    client.release();
  }
}

/**
 * The precondition, asserted rather than assumed: on `client`, `sql` (the old
 * statement) plans as a nested-loop semi join whose OUTER side scans `table` and
 * whose INNER side is the locking subquery. Throws with the plan otherwise: a case
 * without that plan proves nothing about the claim.
 */
export async function assertReRunningPlan(
  client: pg.PoolClient, table: string, sql: string, params: unknown[],
): Promise<void> {
  const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
  const lines = rows.map((r) => r['QUERY PLAN']);
  const semi = lines.findIndex((l) => l.includes('Nested Loop Semi Join'));
  const outer = lines.findIndex((l, i) => i > semi && new RegExp(`Scan (using \\S+ )?on ${table}( |$)`).test(l)
    && !l.includes('Subquery Scan'));
  const inner = lines.findIndex((l, i) => i > semi && l.includes('Subquery Scan on "ANY_subquery"'));
  const locks = lines.findIndex((l, i) => i > inner && l.includes('LockRows'));
  if (semi < 0 || outer < 0 || inner < 0 || locks < 0 || outer > inner) {
    throw new Error(`expected a nested-loop semi join, ${table} outer and the locking subquery inner, got:\n${lines.join('\n')}`);
  }
}
