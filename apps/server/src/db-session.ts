import type { DbPoolOptions } from '@magick-agency/db';

/**
 * Postgres `application_name` per kind of connection, so `pg_stat_activity` and
 * `pg_stat_statements` say which process ran a statement (`db-hygiene.md`). Each fits the
 * 63-byte limit: a slot is at most two digits (`MEDIA_WORKERS` ≤ 64).
 */
export const DB_APPLICATION_NAMES = {
  primary: 'magick-agency-server',
  media: (slot: number) => `magick-agency-media${slot}`,
  analysis: (slot: number) => `magick-agency-analysis${slot}`,
  migrate: 'magick-agency-migrate',
  cli: 'magick-agency-cli',
} as const;

/** The parsed config fields the server's pools read for their session (`config/blocks/base.ts`). */
export interface DbSessionConfig {
  db: { statementTimeoutMs: number; lockTimeoutMs: number; idleInTransactionTimeoutMs: number };
}

/**
 * The session options of one of the server's own pools (the primary's and each worker's):
 * its `application_name`, and the session timeouts from `DB_STATEMENT_TIMEOUT_MS`,
 * `DB_LOCK_TIMEOUT_MS` and `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (all off by default). The
 * migration step and the super-admin CLI take only a name: a migration must never be cut short
 * by a limit sized for the server's statements.
 */
export function dbSessionOptions(cfg: DbSessionConfig, applicationName: string): Pick<DbPoolOptions, 'applicationName' | 'sessionTimeouts'> {
  return {
    applicationName,
    sessionTimeouts: {
      statementTimeoutMs: cfg.db.statementTimeoutMs,
      lockTimeoutMs: cfg.db.lockTimeoutMs,
      idleInTransactionTimeoutMs: cfg.db.idleInTransactionTimeoutMs,
    },
  };
}
