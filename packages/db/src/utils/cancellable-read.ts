import type { PoolClient, QueryResult } from 'pg';
import { beginStatement, type TransactionIsolation, type TransactionPool } from './transaction.js';

/**
 * One read-only transaction on a connection of its own that its caller can STOP: a statement
 * running when `signal` aborts is cancelled, by the backend's own pid, on a connection of its own.
 * The two readers that stop a statement when their caller goes away (Compare agents' read,
 * `apps/server/src/agency/compare/read.ts`; the report cursor, `report-dataset-reads.ts`) both run
 * through here, so the rules below live in one place. A deliberately IMPORT-FREE leaf (type imports
 * and `transaction.ts` only), like `transaction.ts`: the caller passes its pool and its cancel.
 *
 * ── What it owns ────────────────────────────────────────────────────────────
 *  - **BEGIN and the settings statement.** `BEGIN` with the isolation level and READ ONLY, then ONE
 *    statement that reads the backend's pid (`pg_backend_pid()`), bounds `statement_timeout` (and,
 *    with `idleInTransaction`, `idle_in_transaction_session_timeout`) for this transaction only,
 *    and applies the caller's other `settings`. A bound is never 0 (no limit) and never above the
 *    `ceiling` the session already has (see {@link CancellableReadCeiling}).
 *  - **A deadline**, when `timeout` names one: before each later statement `statement_timeout` is
 *    lowered to what is left (`deadlineAt - now - marginMs`) when that is lower than the value set
 *    by more than `slackMs`, so Postgres ends a slow statement just before the caller's deadline
 *    (`57014`, the transaction rolled back, the connection reused) and the client's cancel is only
 *    the backstop. A fast read sends no extra statement.
 *  - **The cancel, once.** When `signal` aborts while one of the transaction's statements runs (and
 *    the pid is known: before it only BEGIN and the settings statement can run, and neither needs a
 *    cancel), `cancel(pid)` is called once. It must never throw (a throw or a rejection counts as
 *    not sent). No further statement is sent once `signal` has aborted, and a statement that fails
 *    after it throws the abort's reason, not its own error (a cancelled statement reports the stop,
 *    not `57014`).
 *  - **The release.** A cancel is AWAITED before the connection is given up, and a connection that
 *    was sent one is DESTROYED, never returned to the pool: `pg_cancel_backend` has returned once
 *    the backend is signalled, but the backend acts on it at its next interrupt check, which may
 *    still be pending, and a cancel that landed after the release would stop the next borrower's
 *    statement (a dialler write). Otherwise the transaction is rolled back and the connection
 *    released to be reused; a ROLLBACK that fails destroys it (it may still hold the transaction).
 *  - **Abandoning a statement** (`graceMs`): a cancelled statement that has not ended `graceMs`
 *    after its cancel was sent is given up with its connection, so the caller's slot comes back.
 *    When the cancel could not be sent, the statement runs on until its own `statement_timeout`,
 *    so the wait is until that bound has passed, plus the grace.
 *
 * ── Which pid ───────────────────────────────────────────────────────────────
 * The backend's own, from `pg_backend_pid()` in the settings statement, never `client.processID`:
 * behind the Supabase session pooler (the deployment default) `processID` is the pooler's number,
 * so a cancel by it signals nothing or, by chance, another backend of the same role
 * (`cancel-backend.ts`, "Which pid").
 */

/**
 * Where a timeout's ceiling comes from: the lower of the caller's bound and this, when it is set.
 *  - `session`: the value the session runs under now (`pg_settings.setting`), the pool's own
 *    `DB_STATEMENT_TIMEOUT_MS` included: a read that must stay inside every limit the pool sets.
 *  - `role`: the value before the pool's own `SET` (`reset_val`: the role's or the database's), so
 *    the transaction is OUT from under the pool's session timeouts but never above a ceiling the
 *    operator put on every session.
 */
export type CancellableReadCeiling = 'session' | 'role';

/** How long a statement may run. */
export type CancellableReadTimeout =
  /** One bound for the whole transaction, in milliseconds (at least 1). */
  | { boundMs: number }
  /**
   * The caller's deadline (`performance.now()` time): each statement under what is left of it less
   * `marginMs`, lowered before a statement when lower by more than `slackMs` (module note).
   */
  | { deadlineAt: number; marginMs: number; slackMs: number };

export interface CancellableReadOptions {
  /** Stops the read: the statement running is cancelled and no further one is sent. */
  signal?: AbortSignal | undefined;
  /** Default `REPEATABLE READ`: one snapshot for every statement. Always READ ONLY. */
  isolation?: TransactionIsolation;
  /** `pg_cancel_backend(pid)` on a connection of its own (`cancelBackend`); never throws. */
  cancel(pid: number): Promise<boolean>;
  timeout: CancellableReadTimeout;
  ceiling: CancellableReadCeiling;
  /** Bound `idle_in_transaction_session_timeout` too, the same way (a reader that idles between statements). */
  idleInTransaction?: boolean;
  /** Further settings for this transaction only (`set_config(name, value, true)`), in the settings statement. */
  settings?: Readonly<Record<string, string | number>>;
  /** Give up a cancelled statement this long after its cancel (module note); unset: wait for it to end. */
  graceMs?: number;
  /** Destroy the connection after any failure, not only after a cancel or a failed ROLLBACK. */
  destroyAfterFailure?: boolean;
}

/** A transaction {@link openCancellableRead} opened. */
export interface CancellableRead {
  /** One statement of the transaction, under the rules above. */
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  /** The connection with its `query` routed through {@link CancellableRead.query}, for code that takes a client. */
  readonly client: PoolClient;
  /** The backend's own pid. */
  readonly pid: number;
  /**
   * End it: await a cancel sent and destroy the connection, else ROLLBACK and release (destroyed
   * when the ROLLBACK fails, or `failed` with `destroyAfterFailure`). Idempotent.
   */
  close(failed?: boolean): Promise<void>;
}

const SETTING_NAME = /^[a-z_]+$/;
const noop = (): void => undefined;

/** The settings statement for these options (exported so tests can name it rather than respell it). */
export function cancellableReadSettingsSql(o: Pick<CancellableReadOptions, 'ceiling' | 'idleInTransaction' | 'settings'>): string {
  const timeouts = o.idleInTransaction ? ['idle_in_transaction_session_timeout', 'statement_timeout'] : ['statement_timeout'];
  const extra = Object.keys(o.settings ?? {});
  for (const name of extra) if (!SETTING_NAME.test(name)) throw new RangeError(`cancellable read: bad setting name ${name}`);
  const source = o.ceiling === 'role' ? 'reset_val' : 'setting';
  // The ceiling is read before any set_config (pg_settings is read whole first); `applied_ms` once.
  return `SELECT s.name, pg_backend_pid() AS pid, s.ceiling_ms, s.applied_ms,
         set_config(s.name, s.applied_ms::text, true) AS applied${extra.map((name, i) => `,
         set_config('${name}', $${i + 2}::text, true) AS ${name}`).join('')}
    FROM (SELECT name, ${source}::bigint AS ceiling_ms,
                 CASE WHEN ${source}::bigint > 0 THEN LEAST(${source}::bigint, $1::bigint) ELSE $1::bigint END AS applied_ms
            FROM pg_settings WHERE name IN (${timeouts.map((t) => `'${t}'`).join(', ')})) s`;
}

/** Lower this transaction's `statement_timeout` to `$1` milliseconds (a deadline's later statements). */
export const LOWER_STATEMENT_TIMEOUT_SQL = `SELECT set_config('statement_timeout', $1::text, true)`;

/**
 * Open the transaction on a connection from `pool` (BEGIN and the settings statement). A failure
 * there closes it and throws. The caller must `close()` it in a `finally`.
 */
export async function openCancellableRead(pool: TransactionPool, o: CancellableReadOptions): Promise<CancellableRead> {
  o.signal?.throwIfAborted();
  const client = await pool.connect();
  const signal = o.signal;
  let pid: number | null = null;
  /** The session's ceiling in ms (none: infinite), and the `statement_timeout` set now. */
  let ceilingMs = Number.POSITIVE_INFINITY;
  let appliedMs: number | null = null;
  /** When the statement running was sent, and the `statement_timeout` it runs under. */
  let runningSince = 0;
  let runningBoundMs: number | null = null;
  let running = false;
  let cancelling: Promise<boolean> | null = null;
  let abandon: () => void = noop;
  const abandoned = new Promise<never>((_, reject) => {
    abandon = () => reject(signal?.reason ?? new Error('cancellable read abandoned'));
  });
  abandoned.catch(noop);

  const onAbort = (): void => {
    if (!running || pid === null || cancelling !== null) return;
    const target = pid;
    const since = runningSince;
    const bound = runningBoundMs;
    // Never rejects: a cancel that throws or rejects is one that was not sent.
    const sent: Promise<boolean> = Promise.resolve()
      .then(() => o.cancel(target))
      .then((ok) => ok === true, () => false);
    cancelling = sent;
    const graceMs = o.graceMs;
    if (graceMs === undefined) return;
    void sent.then((ok) => {
      // Signalled: the statement ends at its next interrupt check. Not signalled: it runs on until
      // its own statement_timeout, so it is waited for until that bound has passed.
      const waitMs = ok || bound === null ? graceMs : Math.max(graceMs, since + bound - performance.now() + graceMs);
      setTimeout(abandon, waitMs).unref();
    });
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const send = async (text: string, values?: unknown[]): Promise<QueryResult> => {
    signal?.throwIfAborted();
    const sent = client.query(text, values) as unknown as Promise<QueryResult>;
    sent.catch(noop);
    running = true;
    runningSince = performance.now();
    runningBoundMs = appliedMs;
    try {
      return await Promise.race([sent, abandoned]);
    } catch (err) {
      // A statement stopped by the signal reports the stop, not its own error.
      signal?.throwIfAborted();
      throw err;
    } finally {
      running = false;
    }
  };

  const timeout = o.timeout;
  /** What is left of the deadline for the next statement, never 0 (0 would be no limit at all). */
  const budgetMs = (): number => 'boundMs' in timeout
    ? Math.max(1, timeout.boundMs)
    : Math.max(1, Math.min(ceilingMs, Math.floor(timeout.deadlineAt - performance.now() - timeout.marginMs)));

  const query = async (text: string, values?: unknown[]): Promise<QueryResult> => {
    if (appliedMs !== null && 'deadlineAt' in timeout) {
      const wanted = budgetMs();
      if (appliedMs - wanted > timeout.slackMs) {
        await send(LOWER_STATEMENT_TIMEOUT_SQL, [wanted]);
        appliedMs = wanted;
      }
    }
    return send(text, values);
  };

  let closed: Promise<void> | null = null;
  const close = (failed = false): Promise<void> => {
    closed ??= (async () => {
      signal?.removeEventListener('abort', onAbort);
      let destroy = failed && o.destroyAfterFailure === true;
      try {
        if (cancelling !== null) {
          await cancelling;
          destroy = true;
        } else {
          try {
            await client.query('ROLLBACK');
          } catch {
            destroy = true;
          }
        }
      } finally {
        client.release(destroy ? true : undefined);
      }
    })();
    return closed;
  };

  try {
    await send(beginStatement({ isolation: o.isolation ?? 'REPEATABLE READ', readOnly: true }));
    const extra = Object.values(o.settings ?? {}).map(String);
    const { rows } = await send(cancellableReadSettingsSql(o), [budgetMs(), ...extra]);
    const row = (rows as Array<{ name?: string; pid: unknown; ceiling_ms: unknown; applied_ms: unknown }>)
      .find((r) => r.name === undefined || r.name === 'statement_timeout');
    const backend = Number(row?.pid);
    if (row === undefined || !Number.isInteger(backend)) throw new Error('cancellable read: the settings statement answered no pid');
    pid = backend;
    const ceiling = Number(row.ceiling_ms);
    if (ceiling > 0) ceilingMs = ceiling;
    appliedMs = Number(row.applied_ms);
  } catch (err) {
    await close(true);
    throw err;
  }
  const guarded = new Proxy(client, {
    get: (target, prop, receiver) => (prop === 'query' ? query : Reflect.get(target, prop, receiver)),
  });
  return { query, client: guarded, pid, close };
}

/** `fn` in a transaction {@link openCancellableRead} opens, closed however `fn` ends. */
export async function withCancellableRead<T>(
  pool: TransactionPool,
  o: CancellableReadOptions,
  fn: (tx: CancellableRead) => Promise<T>,
): Promise<T> {
  const tx = await openCancellableRead(pool, o);
  let failed = true;
  try {
    const out = await fn(tx);
    failed = false;
    return out;
  } finally {
    await tx.close(failed);
  }
}
