import type { Pool, PoolClient } from 'pg';

/**
 * One transaction on one checked-out client: `BEGIN`, the caller's statements,
 * `COMMIT` — or `ROLLBACK` on any throw — and the client released on every path.
 *
 * A deliberately IMPORT-FREE leaf module (type imports only), like `pg-errors.ts`:
 * the caller passes the pool it already holds, so a repository whose tests mock
 * `@magick-agency/db`'s `getPool` keeps that mock in charge of every connection,
 * and nothing here pulls `db/connection` (and through it the logger) into a test's
 * module graph.
 *
 * ── What the helper owns, and what it deliberately does not ──────────────────
 *
 *  - `BEGIN` carries the isolation level and access mode in ONE statement
 *    (`BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY`), so the snapshot rules
 *    are fixed before the first statement runs.
 *  - A throw from `fn` rolls back and is rethrown UNCHANGED. Error mapping (a
 *    23505 that means "replayed", a collision that means "someone else won") stays
 *    at the call site, AFTER the rollback, which is where every caller already
 *    did it.
 *  - A ROLLBACK that itself fails is swallowed — the connection is already broken
 *    and must not mask the error that broke it — and that client is DESTROYED
 *    (`release(true)`) rather than returned to the pool: it may still hold an open
 *    transaction, and the next borrower would run inside it.
 *  - `tx.rollback()` ends the transaction early WITHOUT throwing, for the paths
 *    that decide "write nothing" as an ordinary answer (an empty retry selection,
 *    a replayed ingest chunk). Statements after it run on the same client in
 *    autocommit, and the helper then neither commits nor rolls back again.
 *
 * ── `client`: join the CALLER's transaction (decision B8) ───────────────────
 *
 * With `client`, `fn` runs on that client and this helper issues nothing: no
 * BEGIN, no COMMIT, no ROLLBACK, no release, and `tx.rollback()` is a no-op. The
 * caller owns the transaction's whole life, so a failure anywhere in it takes these
 * writes with it — the agent's DNC mark writing `dnc_entries`, the roster
 * suppression and the disposition as one unit. `isolation` and `readOnly` are
 * ignored there: a transaction's level is set by its own BEGIN, which has already
 * happened.
 */
export type TransactionIsolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/** Where a transaction's client comes from: anything with pg's `connect()`. */
export type TransactionPool = Pick<Pool, 'connect'>;

export interface TransactionOptions {
  /** The pool to check a client out of. Unused when `client` joins an outer transaction. */
  pool: TransactionPool;
  /** Join this client's open transaction instead of opening one. See the module header. */
  client?: PoolClient | undefined;
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}

export interface TransactionControl {
  /**
   * Roll back now and finish the transaction without committing. Later statements
   * in `fn` run on the same client outside any transaction. A no-op when joined.
   */
  rollback(): Promise<void>;
  /** `true` when `fn` is running inside a transaction this helper opened. */
  readonly own: boolean;
}

/** The `BEGIN` text for these options — exported so tests can name it rather than respell it. */
export function beginStatement(options: Pick<TransactionOptions, 'isolation' | 'readOnly'> = {}): string {
  const modes: string[] = [];
  if (options.isolation) modes.push(`ISOLATION LEVEL ${options.isolation}`);
  if (options.readOnly) modes.push('READ ONLY');
  return modes.length === 0 ? 'BEGIN' : `BEGIN ${modes.join(', ')}`;
}

export async function withTransaction<T>(
  fn: (client: PoolClient, tx: TransactionControl) => Promise<T>,
  options: TransactionOptions,
): Promise<T> {
  if (options.client) {
    return fn(options.client, { rollback: async () => undefined, own: false });
  }

  const client = await options.pool.connect();
  // Set once the transaction has ended (a successful COMMIT or ROLLBACK), so a
  // throw after `tx.rollback()` does not issue a second ROLLBACK outside it.
  let finished = false;
  let rollbackFailed = false;
  const tx: TransactionControl = {
    own: true,
    async rollback() {
      if (finished) return;
      // `finished` only after the ROLLBACK succeeds: a failed one throws into the
      // catch below, which tries again and destroys the client if that fails too.
      await client.query('ROLLBACK');
      finished = true;
    },
  };
  try {
    await client.query(beginStatement(options));
    const result = await fn(client, tx);
    if (!finished) {
      await client.query('COMMIT');
      finished = true;
    }
    return result;
  } catch (err) {
    if (!finished) {
      try {
        await client.query('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
    }
    throw err;
  } finally {
    if (rollbackFailed) client.release(true);
    else client.release();
  }
}
