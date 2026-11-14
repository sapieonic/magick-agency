import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { RunnerOption } from 'node-pg-migrate';
import { dbTlsOptions } from '../../../src/db-tls.js';
import type pg from 'pg';
import { runMigrations, type MigrateClient, type MigrateConfig } from '../../../src/migrate.js';

/**
 * The pre-boot migration step (`dist/migrate.js`, run by
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

function fakeClient() {
  const calls: string[] = [];
  const client = {
    connect: vi.fn(async () => { calls.push('connect'); }),
    query: vi.fn(async (sql: string) => { calls.push(sql); return { rows: [] }; }),
    end: vi.fn(async () => { calls.push('end'); }),
    on: vi.fn(),
  };
  return { client: client as unknown as MigrateClient, calls, raw: client };
}

/** Runs the step with a fake runner and client; returns the runner's options and the client's config. */
async function optionsFor(config: MigrateConfig, dir = 'migrations'): Promise<RunnerOption & { clientConfig: pg.ClientConfig }> {
  const runner = vi.fn(async (_options: RunnerOption) => [{ name: '0001_baseline' }]);
  const { client } = fakeClient();
  const newClient = vi.fn((_config: pg.ClientConfig) => client);
  await runMigrations(config, dir, runner, newClient);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(newClient).toHaveBeenCalledTimes(1);
  return { ...runner.mock.calls[0]![0], clientConfig: newClient.mock.calls[0]![0] };
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
    expect(opts.clientConfig).toEqual({ connectionString: URL, application_name: 'magick-agency-migrate', ssl: { rejectUnauthorized: true, ca: PEM } });
  });

  it('verifies against Node roots in production when no CA is set', async () => {
    const opts = await optionsFor(cfg('production'));
    expect(opts.clientConfig).toEqual({ connectionString: URL, application_name: 'magick-agency-migrate', ssl: { rejectUnauthorized: true } });
  });

  it('turns verification off only on the explicit opt-out', async () => {
    const opts = await optionsFor(cfg('production', { sslRejectUnauthorized: false }));
    expect(opts.clientConfig).toEqual({ connectionString: URL, application_name: 'magick-agency-migrate', ssl: { rejectUnauthorized: false } });
  });

  it('connects without TLS outside production', async () => {
    const opts = await optionsFor(cfg('development', { sslCa: PEM }));
    expect(opts.clientConfig).toEqual({ connectionString: URL, application_name: 'magick-agency-migrate' });
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

  it("hands node-pg-migrate a logger with an error level (a failed migration is not an info line)", async () => {
    const opts = await optionsFor(cfg('test'));
    expect(opts.logger).toBeDefined();
    expect(typeof opts.logger?.error).toBe('function');
    expect(typeof opts.logger?.warn).toBe('function');
    expect(opts.log).toBeUndefined();
  });

  it('resolves to the names applied, and rejects when the runner fails (the entrypoint then exits 1)', async () => {
    await expect(runMigrations(cfg('test'), 'm', async () => [{ name: 'a' }, { name: 'b' }], () => fakeClient().client))
      .resolves.toEqual(['a', 'b']);
    await expect(runMigrations(cfg('test'), 'm', async () => { throw new Error('unable to verify the first certificate'); }, () => fakeClient().client))
      .rejects.toThrow('unable to verify the first certificate');
  });

  it('names its session and resets the three timeouts before node-pg-migrate runs on that same connection', async () => {
    const { client, calls, raw } = fakeClient();
    let seenBy: unknown;
    await runMigrations(cfg('test'), 'm', async (options) => { seenBy = options.dbClient; calls.push('runner'); return []; }, () => client);
    expect(seenBy).toBe(client);
    expect(calls).toEqual([
      'connect',
      "SET application_name = 'magick-agency-migrate'; RESET statement_timeout; RESET lock_timeout; RESET idle_in_transaction_session_timeout",
      'runner',
      'end',
    ]);
    expect(raw.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('ends its connection when a migration fails, and fails without running any when it cannot connect', async () => {
    const failing = fakeClient();
    await expect(runMigrations(cfg('test'), 'm', async () => { throw new Error('lock timeout'); }, () => failing.client)).rejects.toThrow('lock timeout');
    expect(failing.calls.at(-1)).toBe('end');

    const runner = vi.fn(async () => []);
    const refused = fakeClient();
    refused.raw.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(runMigrations(cfg('test'), 'm', runner, () => refused.client)).rejects.toThrow('ECONNREFUSED');
    expect(runner).not.toHaveBeenCalled();
  });
});
