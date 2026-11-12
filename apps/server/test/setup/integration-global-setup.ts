import Redis from 'ioredis';
import dbGlobalSetup from '../../../../packages/db/test/helpers/global-setup.js';
import { baseTestTargets, testWorkers, workerTestTargets } from '../../../../tooling/test-env.js';
import { assertSafeTestRedisUrl } from '../helpers/test-redis.js';

/**
 * The server's integration global setup: claim this run's Redis dbs, then the shared database
 * setup (migrate the base; `worker-env.ts` copies it per file).
 *
 * Worker N flushes Redis db `redisDb + N - 1` (`tooling/test-env.ts`), so a worktree owns a
 * RANGE of dbs, and a second worktree whose range overlaps (an older `.test-env.local.json`
 * naming one db, say) would have its keys flushed mid-run. So the setup opens one connection
 * on each db of the range and holds it until the run ends, and refuses to start while any
 * other client is on one of them: a run started later sees those connections and refuses in
 * turn, with no gap between the check and the workers connecting.
 */

export interface RedisClientInfo {
  id: string;
  db: number;
  addr: string;
  age: string;
  name: string;
  /** The command the client is running (`client|list` while it lists). */
  cmd: string;
}

/** The clients connected to `dbs`, but for the connection asking and the ids in `except`. */
export async function redisClientsOn(redisUrl: string, dbs: ReadonlySet<number>, except: ReadonlySet<string> = new Set()): Promise<RedisClientInfo[]> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await redis.connect();
    const own = String(await redis.client('ID'));
    const list = String(await redis.client('LIST'));
    return list
      .split('\n')
      .filter(Boolean)
      .map((line) => Object.fromEntries(line.split(' ').map((kv) => kv.split('=', 2) as [string, string])))
      .map((c) => ({ id: c['id'] ?? '', db: Number(c['db']), addr: c['addr'] ?? '', age: c['age'] ?? '', name: c['name'] ?? '', cmd: c['cmd'] ?? '' }))
      .filter((c) => c.id !== own && !except.has(c.id) && dbs.has(c.db));
  } finally {
    redis.disconnect();
  }
}

/** Throws, naming them, when {@link redisClientsOn} finds anyone on `dbs`. */
export async function assertRedisDbsFree(redisUrl: string, dbs: ReadonlySet<number>, except: ReadonlySet<string> = new Set()): Promise<void> {
  const busy = await redisClientsOn(redisUrl, dbs, except);
  if (busy.length === 0) return;
  const who = busy.map((c) => `db ${c.db} from ${c.addr} (age ${c.age} s${c.name ? `, ${c.name}` : ''})`);
  throw new Error(
    `REFUSING TO RUN: Redis dbs ${[...dbs].join(', ')} belong to this run's workers, but other clients are connected: ` +
      `${who.join('; ')}. Another worktree's integration run (or a process left over from one) is using them. ` +
      'Give each worktree a range of its own ("redisDb" and "workers" in .test-env.local.json, tooling/test-env.ts).',
  );
}

/** This run's Redis dbs, one per worker. */
function rangeDbs(): { baseUrl: string; dbs: number[] } {
  const base = baseTestTargets();
  const workers = testWorkers();
  const dbs: number[] = [];
  for (let worker = 1; worker <= workers; worker++) {
    const { redisUrl } = workerTestTargets(base, worker, workers);
    assertSafeTestRedisUrl(redisUrl);
    dbs.push(Number(new URL(redisUrl).pathname.slice(1)));
  }
  return { baseUrl: base.redisUrl, dbs };
}

/** Holds a connection on each db of the range (refusing first if anyone else is there); returns the release. */
async function claimRedisRange(): Promise<() => void> {
  const { baseUrl, dbs } = rangeDbs();
  const holders = dbs.map((db) => {
    const url = new URL(baseUrl);
    url.pathname = `/${db}`;
    return new Redis(url.toString(), { maxRetriesPerRequest: 2, connectionName: `magick-agency-integration-run-${process.pid}` });
  });
  const release = () => { for (const h of holders) h.disconnect(); };
  try {
    const ids = await Promise.all(holders.map(async (h) => String(await h.client('ID'))));
    await assertRedisDbsFree(baseUrl, new Set(dbs), new Set(ids));
    return release;
  } catch (err) {
    release();
    throw err;
  }
}

export default async function setup(): Promise<() => void> {
  const release = await claimRedisRange();
  try {
    await dbGlobalSetup();
  } catch (err) {
    release();
    throw err;
  }
  return release;
}
