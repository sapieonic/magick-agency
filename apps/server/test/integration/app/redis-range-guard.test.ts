// Real Redis 6383: the integration global setup's claim on this run's Redis dbs
// (test/setup/integration-global-setup.ts, tooling/test-env.ts). A worktree's workers own a range
// of Redis dbs, and a run must refuse, naming them, while another client is on one of them.
// Clients are told apart by their Redis client id: the address a server sees differs between a
// native Redis (127.0.0.1) and a container (its network's gateway), and other clients (this run's
// own claim, other workers, a dev server) may be connected throughout.
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { assertRedisDbsFree, redisClientsOn } from '../../setup/integration-global-setup.js';

const OWN_DB = Number(new URL(TEST_REDIS_URL).pathname.slice(1));
const ANOTHER_DB = (OWN_DB % 15) + 1;

let holder: Redis | null = null;
afterEach(() => {
  holder?.disconnect();
  holder = null;
});

/** A connection on this worker's db, and its client id. */
async function hold(): Promise<string> {
  holder = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  return String(await holder.client('ID'));
}

describe('the integration Redis range claim', () => {
  it('refuses while another client is on a db of the range, naming the db', async () => {
    await hold();
    await expect(assertRedisDbsFree(TEST_REDIS_URL, new Set([OWN_DB]))).rejects.toThrow(
      new RegExp(`REFUSING TO RUN: .*db ${OWN_DB} from \\S+`),
    );
  });

  it('finds a client on a db of the range', async () => {
    const id = await hold();
    expect((await redisClientsOn(TEST_REDIS_URL, new Set([OWN_DB]))).map((c) => c.id)).toContain(id);
  });

  it('ignores a client on a db outside the range', async () => {
    const id = await hold();
    expect((await redisClientsOn(TEST_REDIS_URL, new Set([ANOTHER_DB]))).map((c) => c.id)).not.toContain(id);
  });

  it('ignores the clients it is told to (the run\'s own claim)', async () => {
    const id = await hold();
    expect((await redisClientsOn(TEST_REDIS_URL, new Set([OWN_DB]), new Set([id]))).map((c) => c.id)).not.toContain(id);
  });

  it('never counts its own listing connection', async () => {
    expect((await redisClientsOn(TEST_REDIS_URL, new Set([OWN_DB]))).map((c) => c.cmd)).not.toContain('client|list');
  });
});
