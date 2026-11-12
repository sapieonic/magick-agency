import { describe, expect, it } from 'vitest';
import { testWorkers, workerDbName, workerTestTargets } from '../../../../tooling/test-env.js';
import { TEST_DB_NAME_RE, assertSafeTestDbUrl } from '../helpers/test-db.js';

const BASE = {
  dbUrl: 'postgresql://magick_agency:magick_agency_password@localhost:5436/magick_agency_test',
  redisUrl: 'redis://localhost:6383/1',
};

describe('integration worker targets (tooling/test-env.ts)', () => {
  it('gives each worker its own database and Redis db, counted from the base', () => {
    const targets = [1, 2, 3, 4].map((w) => workerTestTargets(BASE, w, 4));
    expect(targets.map((t) => new URL(t.dbUrl).pathname)).toEqual([
      '/magick_agency_test_w1', '/magick_agency_test_w2', '/magick_agency_test_w3', '/magick_agency_test_w4',
    ]);
    expect(targets.map((t) => t.redisUrl)).toEqual([
      'redis://localhost:6383/1', 'redis://localhost:6383/2', 'redis://localhost:6383/3', 'redis://localhost:6383/4',
    ]);
  });

  it('keeps the credentials, host and port, and the worker database passes the test-database guard', () => {
    const { dbUrl } = workerTestTargets({ ...BASE, dbUrl: BASE.dbUrl.replace(/test$/, 'test_lane_a') }, 3, 4);
    expect(dbUrl).toBe('postgresql://magick_agency:magick_agency_password@localhost:5436/magick_agency_test_lane_a_w3');
    expect(() => assertSafeTestDbUrl(dbUrl)).not.toThrow();
    expect(TEST_DB_NAME_RE.test(workerDbName('magick_agency_test', 12))).toBe(true);
  });

  it('starts a worktree range at its own redisDb', () => {
    expect(workerTestTargets({ ...BASE, redisUrl: 'redis://localhost:6383/5' }, 4, 4).redisUrl).toBe('redis://localhost:6383/8');
  });

  it('refuses a range that would pass db 15 rather than wrap onto another db', () => {
    expect(() => workerTestTargets({ ...BASE, redisUrl: 'redis://localhost:6383/13' }, 1, 4)).toThrow(/dbs 13-16, past 15/);
    expect(() => workerTestTargets({ ...BASE, redisUrl: 'redis://localhost:6383/12' }, 4, 4)).not.toThrow();
  });

  it('refuses a base name that ends like a worker copy: copies are dropped WITH (FORCE)', () => {
    // A checkout named `…_w1` would be the main checkout's worker 1 copy, dropped under it.
    expect(() => workerDbName('magick_agency_test_w1', 1)).toThrow(/ends like a worker copy/);
    expect(() => workerTestTargets({ ...BASE, dbUrl: `${BASE.dbUrl}_w12` }, 1, 4)).toThrow(/ends like a worker copy/);
    expect(workerDbName('magick_agency_test_wt1', 2)).toBe('magick_agency_test_wt1_w2');
  });

  it('refuses a worker outside 1..workers (a --maxWorkers above TEST_WORKERS)', () => {
    expect(() => workerTestTargets(BASE, 5, 4)).toThrow(/outside 1\.\.4/);
    expect(() => workerTestTargets(BASE, 0, 4)).toThrow(/outside 1\.\.4/);
  });

  it('reads the worker count from TEST_WORKERS, then the local file, else at most 4', () => {
    expect(testWorkers({ TEST_WORKERS: '2' }, { workers: 6 })).toBe(2);
    expect(testWorkers({}, { workers: 6 })).toBe(6);
    const fallback = testWorkers({}, {});
    expect(fallback).toBeGreaterThanOrEqual(1);
    expect(fallback).toBeLessThanOrEqual(4);
    expect(() => testWorkers({ TEST_WORKERS: '0' }, {})).toThrow(/positive integer/);
    expect(() => testWorkers({ TEST_WORKERS: 'two' }, {})).toThrow(/positive integer/);
  });
});
