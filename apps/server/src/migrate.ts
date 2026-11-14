import { resolve } from 'node:path';
import pg from 'pg';
import { runner as pgMigrateRunner, type RunnerOption } from 'node-pg-migrate';
import { buildSslOption, sessionSettingsSql } from '@magick-agency/db';
import { logger } from '@magick-agency/observability';
import { dbTlsOptions, type DbTlsConfig } from './db-tls.js';
import { DB_APPLICATION_NAMES } from './db-session.js';

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

/** The connection the migrations run on; a test passes a fake. */
export type MigrateClient = Pick<pg.Client, 'connect' | 'query' | 'end' | 'on'>;

/**
 * Runs every pending `up` migration in `dir`; resolves to the names applied.
 *
 * The step opens its own connection and hands it to node-pg-migrate (`dbClient`), so that before
 * any DDL it can name itself and RESET the three session timeouts (`sessionSettingsSql`). Through
 * a session-mode pooler that does not clear session state, the Postgres connection it gets may be
 * one the server's pool used, still carrying the server's `DB_*_TIMEOUT_MS`; those are sized for
 * the server's statements, not a migration's DDL (`db-hygiene.md`, "5. Timeouts").
 */
export async function runMigrations(
  cfg: MigrateConfig,
  dir: string,
  runner: (options: RunnerOption) => Promise<Array<{ name: string }>> = pgMigrateRunner,
  newClient: (config: pg.ClientConfig) => MigrateClient = (config) => new pg.Client(config),
): Promise<string[]> {
  const ssl = buildSslOption(dbTlsOptions(cfg));
  const client = newClient({ connectionString: cfg.db.url, application_name: DB_APPLICATION_NAMES.migrate, ...(ssl ? { ssl } : {}) });
  // A connection lost between statements fails the next one (and so the step) instead of
  // surfacing as an unhandled 'error' event.
  client.on('error', (err) => logger.error({ err }, 'migration connection error'));
  await client.connect();
  try {
    await client.query(sessionSettingsSql(DB_APPLICATION_NAMES.migrate, undefined));
    const applied = await runner({
      dbClient: client as pg.Client,
      dir: resolve(dir),
      direction: 'up',
      // packages/db `migrate:up` uses the same table; keep them in step.
      migrationsTable: 'pgmigrations',
      count: Infinity,
      // Each level kept: a migration failure is node-pg-migrate's `error`, not an `info` line.
      logger: {
        debug: (msg: string) => logger.debug(msg),
        info: (msg: string) => logger.info(msg),
        warn: (msg: string) => logger.warn(msg),
        error: (msg: string) => logger.error(msg),
      },
    });
    return applied.map((m) => m.name);
  } finally {
    await client.end();
  }
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
