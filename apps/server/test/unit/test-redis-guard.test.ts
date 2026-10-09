import { describe, expect, it } from 'vitest';
import { assertSafeTestRedisUrl } from '../helpers/test-redis.js';

describe('test Redis guard', () => {
  it.each(['redis://localhost:6383/1', 'redis://localhost:6383/4'])('accepts agency test Redis %s', (url) => {
    expect(() => assertSafeTestRedisUrl(url)).not.toThrow();
  });
  it.each([
    ['another local stack on 6379', 'redis://localhost:6379/1'],
    ['another local stack on 6380', 'redis://localhost:6380/1'],
    ['another local stack on 6381', 'redis://localhost:6381/1'],
    ['agency dev db', 'redis://localhost:6383/0'],
    ['agency, no db', 'redis://localhost:6383'],
  ])('refuses %s', (_l, url) => {
    expect(() => assertSafeTestRedisUrl(url)).toThrow(/REFUSING TO RUN/);
  });
});
