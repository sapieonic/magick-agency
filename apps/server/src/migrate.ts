import { resolve } from 'node:path';
import { runner as pgMigrateRunner, type RunnerOption } from 'node-pg-migrate';
import { buildSslOption } from '@magick-agency/db';
import { logger } from '@magick-agency/observability';
import { dbTlsOptions, type DbTlsConfig } from './db-tls.js';

/**
 * Applies pending migrations, then exits. `docker/entrypoint.sh` runs it before the server.
 *
 * Why not the node-pg-migrate CLI: it takes its TLS from `DATABASE_URL`, and decision Q1
 * refuses TLS parameters there (they would override the verified settings,
 * `config/blocks/base.ts`), so under `NODE_ENV=production` the CLI could not reach a TLS-only
 * database with a verified certificate or a private CA. This runs node-pg-migrate's runner
 * with the server's own Postgres TLS decision (`dbTlsOptions`, shared with
 * `index.ts`), so migrations and the server connect identically. The entry point loads the
 * full config first, so an invalid environment fails before any DDL runs.
 *
 * Usage: `node dist/migrate.js <migrations dir>`.
 */

export interface MigrateConfig extends DbTlsConfig {
  db: DbTlsConfig['db'] & { url: string };
}

/** Runs every pending `up` migration in `dir`; resolves to the names applied. */
export async function runMigrations(
  cfg: MigrateConfig,
  dir: string,
  runner: (options: RunnerOption) => Promise<Array<{ name: string }>> = pgMigrateRunner,
): Promise<string[]> {
  const ssl = buildSslOption(dbTlsOptions(cfg));
  const applied = await runner({
    databaseUrl: { connectionString: cfg.db.url, ...(ssl ? { ssl } : {}) },
    dir: resolve(dir),
    direction: 'up',
    // packages/db `migrate:up` uses the same table; keep them in step.
    migrationsTable: 'pgmigrations',
    count: Infinity,
    // Each level kept: a connection failure is node-pg-migrate's `error`, not an `info` line.
    logger: {
      debug: (msg: string) => logger.debug(msg),
      info: (msg: string) => logger.info(msg),
      warn: (msg: string) => logger.warn(msg),
      error: (msg: string) => logger.error(msg),
    },
  });
  return applied.map((m) => m.name);
}

async function main(): Promise<number> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node dist/migrate.js <migrations dir>');
    return 2;
  }
  // Imported here, not at the top: loading config exits the process on an invalid
  // environment, which must not happen when a test imports `runMigrations`.
  const { config } = await import('./config/index.js');
  const applied = await runMigrations(config, dir);
  logger.info({ applied }, 'migrations complete');
  return 0;
}

if (process.argv[1]?.endsWith('migrate.js') || process.argv[1]?.endsWith('migrate.ts')) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      logger.fatal({ err }, 'migrations failed');
      process.exit(1);
    },
  );
}
