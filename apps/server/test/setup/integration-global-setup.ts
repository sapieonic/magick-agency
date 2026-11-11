import Redis from 'ioredis';
import dbGlobalSetup from '../../../../packages/db/test/helpers/global-setup.js';
import { baseTestTargets, testWorkers, workerTestTargets } from '../../../../tooling/test-env.js';
import { assertSafeTestRedisUrl } from '../helpers/test-redis.js';

/**
 * The server's integration global setup: the shared database setup (migrate the base,
 * one copy per worker), then a check that no other run is using this run's Redis dbs.
 *
 * Worker N flushes Redis db `redisDb + N - 1` (`tooling/test-env.ts`), so a worktree owns
 * a RANGE of dbs, and a second worktree whose range overlaps (an older
 * `.test-env.local.json` naming one db, say) would have its keys flushed mid-run. Nothing
 * of this run is connected yet, so any client on a db of the range is another run's (or a
 * process left over from one): refuse, naming it, rather than flush under it.
 */
export async function assertRedisRangeFree(): Promise<void> {
  const base = baseTestTargets();
  const workers = testWorkers();
  const dbs = new Set<number>();
  for (let worker = 1; worker <= workers; worker++) {
    const { redisUrl } = workerTestTargets(base, worker, workers);
    assertSafeTestRedisUrl(redisUrl);
    dbs.add(Number(new URL(redisUrl).pathname.slice(1)));
  }
  const redis = new Redis(base.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await redis.connect();
    const own = String(await redis.client('ID'));
    const list = String(await redis.client('LIST'));
    const busy = list
      .split('\n')
      .filter(Boolean)
      .map((line) => Object.fromEntries(line.split(' ').map((kv) => kv.split('=', 2) as [string, string])))
      .filter((c) => c['id'] !== own && dbs.has(Number(c['db'])));
    if (busy.length > 0) {
      const who = busy.map((c) => `db ${c['db']} from ${c['addr']} (age ${c['age']} s${c['name'] ? `, ${c['name']}` : ''})`);
      throw new Error(
        `REFUSING TO RUN: Redis dbs ${[...dbs].join(', ')} belong to this run's workers, but other clients are connected: ` +
          `${who.join('; ')}. Another worktree's integration run (or a process left over from one) is using them. ` +
          'Give each worktree a range of its own ("redisDb" and "workers" in .test-env.local.json, tooling/test-env.ts).',
      );
    }
  } finally {
    redis.disconnect();
  }
}

export default async function setup(): Promise<void> {
  await assertRedisRangeFree();
  await dbGlobalSetup();
}
