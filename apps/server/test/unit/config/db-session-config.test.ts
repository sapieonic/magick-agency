import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/load.js';
import { DB_APPLICATION_NAMES, dbSessionOptions } from '../../../src/db-session.js';

/**
 * The server pools' Postgres session settings (db-hygiene.md): the `DB_*_TIMEOUT_MS` keys, off
 * unless set, and the `application_name` each process connects with. Their effect on real
 * Postgres is pinned in packages/db (`pool-session-settings.test.ts`).
 */
const env = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

function parse(extra: Record<string, string> = {}) {
  const result = parseConfig({ ...env, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}

describe('DB_*_TIMEOUT_MS', () => {
  it('are all off (0) unless set, so an unchanged deployment sends no session settings', () => {
    const { db } = parse();
    expect([db.statementTimeoutMs, db.lockTimeoutMs, db.idleInTransactionTimeoutMs]).toEqual([0, 0, 0]);
    expect(parse({ DB_STATEMENT_TIMEOUT_MS: '', DB_LOCK_TIMEOUT_MS: ' ' }).db.statementTimeoutMs).toBe(0);
  });

  it('take milliseconds from the environment', () => {
    const { db } = parse({ DB_STATEMENT_TIMEOUT_MS: '300000', DB_LOCK_TIMEOUT_MS: '60000', DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '120000' });
    expect(db).toMatchObject({ statementTimeoutMs: 300_000, lockTimeoutMs: 60_000, idleInTransactionTimeoutMs: 120_000 });
  });

  it.each(['DB_STATEMENT_TIMEOUT_MS', 'DB_LOCK_TIMEOUT_MS', 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'])(
    '%s refuses a value under a second (a unit mistake), a negative, a fraction and over an hour', (key) => {
      for (const bad of ['5', '999', '-1', '1500.5', '3600001', 'sixty']) {
        expect(parseConfig({ ...env, [key]: bad }).ok, `${key}=${bad}`).toBe(false);
      }
      expect(parseConfig({ ...env, [key]: '1000' }).ok).toBe(true);
      expect(parseConfig({ ...env, [key]: '3600000' }).ok).toBe(true);
    });
});

describe('dbSessionOptions', () => {
  it("hands a server pool its name and the configured timeouts", () => {
    const config = parse({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '120000' });
    expect(dbSessionOptions(config, DB_APPLICATION_NAMES.primary)).toEqual({
      applicationName: 'magick-agency-server',
      sessionTimeouts: { statementTimeoutMs: 0, lockTimeoutMs: 0, idleInTransactionTimeoutMs: 120_000 },
    });
  });

  it('names each process distinctly, within the 63-byte limit for the largest slot', () => {
    const names = [
      DB_APPLICATION_NAMES.primary, DB_APPLICATION_NAMES.migrate, DB_APPLICATION_NAMES.cli,
      DB_APPLICATION_NAMES.media(0), DB_APPLICATION_NAMES.media(64),
      DB_APPLICATION_NAMES.analysis(0), DB_APPLICATION_NAMES.analysis(64),
    ];
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(Buffer.byteLength(n)).toBeLessThanOrEqual(63);
  });
});
