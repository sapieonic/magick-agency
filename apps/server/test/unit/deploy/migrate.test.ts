import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { RunnerOption } from 'node-pg-migrate';
import { dbTlsOptions } from '../../../src/db-tls.js';
import { runMigrations, type MigrateConfig } from '../../../src/migrate.js';

/**
 * NEW (magick-agency): the pre-boot migration step (`dist/migrate.js`, run by
 * `docker/entrypoint.sh`) and the TLS decision it shares with the server (`db-tls.ts`).
 * The point of the step is that migrations connect with exactly the server's Postgres TLS:
 * on and VERIFIED under production (Q1), with `DB_SSL_CA` as the trust root, and plain
 * otherwise. node-pg-migrate's CLI could not do that (TLS only from `DATABASE_URL`, which
 * config refuses). These pin the options handed to node-pg-migrate's runner.
 */

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const URL = 'postgresql://u:p@db.example.com:5432/magick_agency';

function cfg(env: MigrateConfig['server']['env'], db: Partial<MigrateConfig['db']> = {}): MigrateConfig {
  return { server: { env }, db: { url: URL, sslRejectUnauthorized: true, ...db } };
}

async function optionsFor(config: MigrateConfig, dir = 'migrations'): Promise<RunnerOption> {
  const runner = vi.fn(async (_options: RunnerOption) => [{ name: '0001_baseline' }]);
  await runMigrations(config, dir, runner);
  expect(runner).toHaveBeenCalledTimes(1);
  return runner.mock.calls[0]![0];
}

describe('dbTlsOptions — one TLS decision for the server, migrations and the super-admin CLI', () => {
  it('turns TLS on only in production', () => {
    expect(dbTlsOptions(cfg('production')).ssl).toBe(true);
    expect(dbTlsOptions(cfg('development')).ssl).toBe(false);
    expect(dbTlsOptions(cfg('test')).ssl).toBe(false);
  });

  it('carries the verification flag and the CA through unchanged', () => {
    expect(dbTlsOptions(cfg('production', { sslCa: PEM }))).toEqual({ ssl: true, sslRejectUnauthorized: true, sslCa: PEM });
    expect(dbTlsOptions(cfg('production', { sslRejectUnauthorized: false }))).toEqual({ ssl: true, sslRejectUnauthorized: false });
  });
});

describe('runMigrations', () => {
  it('connects with verified TLS in production, against DB_SSL_CA when set', async () => {
    const opts = await optionsFor(cfg('production', { sslCa: PEM }));
    expect((opts as { databaseUrl?: unknown }).databaseUrl).toEqual({ connectionString: URL, ssl: { rejectUnauthorized: true, ca: PEM } });
  });

  it('verifies against Node roots in production when no CA is set', async () => {
    const opts = await optionsFor(cfg('production'));
    expect((opts as { databaseUrl?: unknown }).databaseUrl).toEqual({ connectionString: URL, ssl: { rejectUnauthorized: true } });
  });

  it('turns verification off only on the explicit opt-out', async () => {
    const opts = await optionsFor(cfg('production', { sslRejectUnauthorized: false }));
    expect((opts as { databaseUrl?: unknown }).databaseUrl).toEqual({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  });

  it('connects without TLS outside production', async () => {
    const opts = await optionsFor(cfg('development', { sslCa: PEM }));
    expect((opts as { databaseUrl?: unknown }).databaseUrl).toEqual({ connectionString: URL });
  });

  it("applies every pending up migration from the given dir into packages/db's ledger table", async () => {
    const opts = await optionsFor(cfg('test'), 'some/migrations');
    expect(opts).toMatchObject({
      dir: resolve('some/migrations'),
      direction: 'up',
      count: Infinity,
      migrationsTable: 'pgmigrations',
    });
  });

  it("hands node-pg-migrate a logger with an error level (a failed connect is not an info line)", async () => {
    const opts = await optionsFor(cfg('test'));
    expect(opts.logger).toBeDefined();
    expect(typeof opts.logger?.error).toBe('function');
    expect(typeof opts.logger?.warn).toBe('function');
    expect(opts.log).toBeUndefined();
  });

  it('resolves to the names applied, and rejects when the runner fails (the entrypoint then exits 1)', async () => {
    await expect(runMigrations(cfg('test'), 'm', async () => [{ name: 'a' }, { name: 'b' }])).resolves.toEqual(['a', 'b']);
    await expect(runMigrations(cfg('test'), 'm', async () => { throw new Error('unable to verify the first certificate'); }))
      .rejects.toThrow('unable to verify the first certificate');
  });
});
