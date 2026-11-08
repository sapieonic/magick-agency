import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { postgresKnowsZone, resetKnownZonesForTests } from '../../../src/agency/reports/zone.js';

/**
 * The report routes' second zone check (`agency/reports/zone.ts`) against the real
 * `pg_timezone_names`: a zone Postgres knows (matched as `AT TIME ZONE` matches, ignoring case), and
 * names it does not hold.
 */

beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 2 }); });
afterAll(async () => { await closePool(); });
beforeEach(() => { resetKnownZonesForTests(); });

describe('postgresKnowsZone', () => {
  it('knows the IANA names Postgres can cut days in, ignoring case as AT TIME ZONE does', async () => {
    expect(await postgresKnowsZone('Europe/London')).toBe(true);
    expect(await postgresKnowsZone('UTC')).toBe(true);
    expect(await postgresKnowsZone('europe/london')).toBe(true);
    expect(await postgresKnowsZone('Asia/Kolkata')).toBe(true);
  });

  it('refuses names it does not hold', async () => {
    expect(await postgresKnowsZone('Mars/Olympus')).toBe(false);
    expect(await postgresKnowsZone('Europe/Atlantis')).toBe(false);
    expect(await postgresKnowsZone('EST5EDTX')).toBe(false);
  });
});
