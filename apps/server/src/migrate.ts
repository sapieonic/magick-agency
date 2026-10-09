import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { buildSslOption } from '@magick-agency/db';
import { logger } from '@magick-agency/observability';
import { config } from './config/index.js';

/**
 * Applies pending migrations, then exits. `docker/entrypoint.sh` runs it before the server.
 *
 * PORT NOTE (magick-agency): core's `docker/entrypoint.sh:4-6`@4850d1d9 ran the
 * node-pg-migrate CLI (`npx node-pg-migrate up --migrations-dir src/db/migrations`). The CLI
 * takes its TLS from `DATABASE_URL`, and Q1 refuses TLS parameters there (they would override
 * the verified settings, `config/blocks/base.ts`), so under `NODE_ENV=production` the CLI could
 * not reach a TLS-only database with a verified certificate or a private CA. This runs the
 * same runner with the server's own Postgres settings: the same `ssl` decision as `index.ts`
 * (on in production) and the same `buildSslOption`, so migrations and the server connect
 * identically. Loading `config` also refuses an invalid environment before any DDL runs.
 *
 * Usage: `node dist/migrate.js <migrations dir>`.
 */
async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node dist/migrate.js <migrations dir>');
    process.exit(2);
  }
  const ssl = buildSslOption({
    ssl: config.server.env === 'production',
    sslRejectUnauthorized: config.db.sslRejectUnauthorized,
    ...(config.db.sslCa ? { sslCa: config.db.sslCa } : {}),
  });
  const applied = await runner({
    databaseUrl: { connectionString: config.db.url, ...(ssl ? { ssl } : {}) },
    dir: resolve(dir),
    direction: 'up',
    // packages/db `migrate:up` uses the same table; keep them in step.
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: (msg) => logger.info(msg),
  });
  logger.info({ applied: applied.map((m) => m.name) }, 'migrations complete');
}

main().catch((err) => {
  logger.fatal({ err }, 'migrations failed');
  process.exit(1);
});
