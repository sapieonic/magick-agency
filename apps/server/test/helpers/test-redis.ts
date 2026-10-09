import Redis from 'ioredis';
import { DEFAULT_TEST_REDIS_URL } from '../../../../tooling/test-env.js';

/**
 * Agency test Redis: port 6383, a NON-ZERO db (1 by default; per-worktree via
 * tooling/test-env.ts). db 0 is dev. `flushTestRedis` refuses anything else.
 * FLUSHDB ignores key prefixes, so the guard is the only protection a dev
 * Redis has; core's suite once wiped master's this way.
 */
export const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? DEFAULT_TEST_REDIS_URL;

export function assertSafeTestRedisUrl(url: string = TEST_REDIS_URL): void {
  const parsed = new URL(url);
  const port = parsed.port || '6379';
  const db = parsed.pathname.replace(/^\//, '') || '0';
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (!/^([1-9]|1[0-5])$/.test(db) || (local && port !== '6383')) {
    throw new Error(
      `REFUSING TO RUN: test Redis must be db 1-15 on port 6383, got db ${db} on ${parsed.hostname}:${port}.`,
    );
  }
}

let client: Redis | null = null;

export function getTestRedis(): Redis {
  assertSafeTestRedisUrl();
  if (!client) client = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  return client;
}

export async function flushTestRedis(): Promise<void> {
  assertSafeTestRedisUrl();
  await getTestRedis().flushdb();
}

export async function closeTestRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
