import type pg from 'pg';
import type Redis from 'ioredis';
import { floorPool } from './floor-pool.js';

/**
 * Counts what the product sends to Postgres and Redis, for the pacing statement
 * harness (`pacing-statements.test.ts`).
 *
 * Postgres: every `query` on the pool and on a client checked out of it (so a
 * transaction's `BEGIN` / `COMMIT` count as the statements they are), keyed by the
 * statement's first words. Redis: every command the client sends, keyed by name,
 * plus ROUND TRIPS — a standalone command is one, a pipeline is one however many
 * commands it carries.
 *
 * Its own module with nothing but `pg` behind it, like `floor-pool.ts`, because the
 * suite hands it to the product from a `vi.mock('@magick-agency/db', …)` factory.
 */
export class StatementCounter {
  readonly sql = new Map<string, number>();
  readonly redisCommands = new Map<string, number>();
  redisRoundTrips = 0;

  reset(): void {
    this.sql.clear();
    this.redisCommands.clear();
    this.redisRoundTrips = 0;
  }

  get sqlTotal(): number {
    return [...this.sql.values()].reduce((a, b) => a + b, 0);
  }

  get redisTotal(): number {
    return [...this.redisCommands.values()].reduce((a, b) => a + b, 0);
  }

  recordSql(q: unknown): void {
    const text = typeof q === 'string' ? q : (q as { text?: string } | null)?.text ?? '?';
    const key = text.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 72);
    this.sql.set(key, (this.sql.get(key) ?? 0) + 1);
  }

  /** Wrap a Redis client's command path. Idempotent. */
  instrumentRedis(redis: Redis): void {
    const r = redis as unknown as { sendCommand: (cmd: { name: string }, stream?: unknown) => unknown; __counted?: boolean };
    if (r.__counted) return;
    r.__counted = true;
    const send = r.sendCommand.bind(redis);
    r.sendCommand = (cmd, stream) => {
      this.redisCommands.set(cmd.name, (this.redisCommands.get(cmd.name) ?? 0) + 1);
      // A pipelined command is written with the pipeline's stream; the pipeline's
      // `exec` is counted as the round trip instead.
      if (stream === undefined) this.redisRoundTrips++;
      return send(cmd, stream);
    };
    const pipeline = (redis as unknown as { pipeline: (...a: unknown[]) => { exec: (...a: unknown[]) => unknown } }).pipeline.bind(redis);
    (redis as unknown as { pipeline: (...a: unknown[]) => unknown }).pipeline = (...args: unknown[]) => {
      const p = pipeline(...args);
      const exec = p.exec.bind(p);
      p.exec = (...a: unknown[]) => {
        this.redisRoundTrips++;
        return exec(...a);
      };
      return p;
    };
  }

  top(map: Map<string, number>, n = 12): Array<[string, number]> {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }
}

export const counter = new StatementCounter();

let counting: pg.Pool | null = null;

/** The floor pool, with every statement counted into {@link counter}. */
export function countingPool(): pg.Pool {
  if (counting) return counting;
  const pool = floorPool();
  // Counted only while checked out through `connect`: `pool.query` reuses pooled
  // clients internally and is counted at the pool, so a permanent patch would count
  // its statements twice.
  const wrapClient = (client: pg.PoolClient): pg.PoolClient => {
    const c = client as unknown as { query: (...a: unknown[]) => unknown; release: (...a: unknown[]) => unknown };
    const ownQuery = Object.prototype.hasOwnProperty.call(c, 'query') ? c.query : undefined;
    const ownRelease = Object.prototype.hasOwnProperty.call(c, 'release') ? c.release : undefined;
    const query = c.query.bind(c);
    const release = c.release.bind(c);
    c.query = (...args: unknown[]) => {
      counter.recordSql(args[0]);
      return query(...args);
    };
    c.release = (...args: unknown[]) => {
      if (ownQuery) c.query = ownQuery; else delete (c as { query?: unknown }).query;
      if (ownRelease) c.release = ownRelease; else delete (c as { release?: unknown }).release;
      return release(...args);
    };
    return client;
  };
  counting = new Proxy(pool, {
    get(target, prop) {
      if (prop === 'query') {
        return (...args: unknown[]) => {
          counter.recordSql(args[0]);
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      if (prop === 'connect') {
        return async (...args: unknown[]) => {
          const client = await (target.connect as (...a: unknown[]) => Promise<pg.PoolClient>)(...args);
          return wrapClient(client);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return counting;
}
