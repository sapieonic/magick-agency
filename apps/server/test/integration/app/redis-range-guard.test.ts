// Real Redis 6383: the integration global setup's refusal to flush another run's Redis dbs
// (test/setup/integration-global-setup.ts, tooling/test-env.ts). A worktree's workers own a range
// of Redis dbs, and a run started while another client is on one of them must refuse, naming it.
// Exercised on this worker's own db, which nothing but this file uses while it runs.
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { assertRedisDbsFree } from '../../setup/integration-global-setup.js';

const OWN_DB = Number(new URL(TEST_REDIS_URL).pathname.slice(1));

let holder: Redis | null = null;
afterEach(() => {
  holder?.disconnect();
  holder = null;
});

describe('the integration Redis range guard', () => {
  it('refuses while another client is connected to a db of the range, naming the db', async () => {
    holder = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
    await holder.ping();
    await expect(assertRedisDbsFree(TEST_REDIS_URL, new Set([OWN_DB]))).rejects.toThrow(
      new RegExp(`REFUSING TO RUN: .*db ${OWN_DB} from 127\\.0\\.0\\.1`),
    );
  });

  it('passes when the only client on the range is its own probe', async () => {
    await expect(assertRedisDbsFree(TEST_REDIS_URL, new Set([OWN_DB]))).resolves.toBeUndefined();
  });

  it('ignores clients on dbs outside the range', async () => {
    holder = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
    await holder.ping();
    // An empty range: the holder (and every other client on the server: other workers, a dev
    // server on db 0) is outside it, so nothing may count against it.
    await expect(assertRedisDbsFree(TEST_REDIS_URL, new Set())).resolves.toBeUndefined();
  });
});
