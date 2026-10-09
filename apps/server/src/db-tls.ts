import type { DbPoolOptions } from '@magick-agency/db';

/** The parsed config fields the Postgres TLS decision reads (`config/blocks/base.ts`). */
export interface DbTlsConfig {
  server: { env: 'development' | 'test' | 'production' };
  db: { sslRejectUnauthorized: boolean; sslCa?: string | undefined };
}

/**
 * The Postgres TLS options for a parsed config: TLS on only under `NODE_ENV=production`, the
 * server certificate verified unless `DB_SSL_REJECT_UNAUTHORIZED=false` (Q1), `DB_SSL_CA` as
 * the trust root when set. One decision for every process that connects (the server, the
 * pre-boot migration step, the super-admin CLI), so a migration can never connect with
 * different TLS than the server it runs before.
 */
export function dbTlsOptions(cfg: DbTlsConfig): Pick<DbPoolOptions, 'ssl' | 'sslRejectUnauthorized' | 'sslCa'> {
  return {
    ssl: cfg.server.env === 'production',
    // Q1 (Manas, 2026-10-09): verify the server certificate unless explicitly opted out.
    sslRejectUnauthorized: cfg.db.sslRejectUnauthorized,
    ...(cfg.db.sslCa ? { sslCa: cfg.db.sslCa } : {}),
  };
}
