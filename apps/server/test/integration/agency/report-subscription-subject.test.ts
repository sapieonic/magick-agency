import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, insertAccount, insertTenant, insertUser } from '../setup/factories.js';
import { probeSubscriptionSubject } from '../../../src/agency/reports/subscription-subject.js';

/**
 * The reports tick's subject probe (`agency/reports/subscription-subject.ts`) on real Postgres:
 * the rule the dataset builders fail `subject_unavailable` on, read at each claim, so a
 * subscription whose subject is gone is disabled and one whose run would succeed never is. A
 * campaign's current `default_timezone` comes back with it (RP3).
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const sub = (kind: 'agent' | 'campaign' | 'account', subjectId: string, accountId: string | null = A) =>
  ({ tenant_id: T, account_id: accountId, kind, subject_id: subjectId });

async function campaign(accountId: string, timezone: string): Promise<string> {
  const id = randomUUID();
  await pool().query(
    `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids, default_timezone)
     VALUES ($1, $2, $3, 'Spring renewals', '{+911}', $4)`,
    [id, T, accountId, timezone],
  );
  return id;
}

async function member(accountId: string | null, status: 'active' | 'revoked'): Promise<string> {
  const user = await insertUser();
  await pool().query(
    `INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, 'agent', $5)`,
    [randomUUID(), user.id, T, accountId, status],
  );
  return user.id as string;
}

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: T });
  await insertAccount({ id: A, tenant_id: T });
  await insertAccount({ id: OTHER_ACCOUNT, tenant_id: T });
});

// The probe reads through the shared repositories (`@magick-agency/db`'s own pool).
beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 }); });
afterAll(async () => { await closePool(); await closeTestPool(); });

describe('probeSubscriptionSubject', () => {
  it('a campaign of the account is there, with its CURRENT zone; deleted or moved to another account it is gone', async () => {
    const id = await campaign(A, 'Europe/London');
    expect(await probeSubscriptionSubject(sub('campaign', id))).toEqual({ available: true, timezone: 'Europe/London' });
    await pool().query(`UPDATE agency_campaigns SET default_timezone = 'America/New_York' WHERE id = $1`, [id]);
    expect(await probeSubscriptionSubject(sub('campaign', id))).toEqual({ available: true, timezone: 'America/New_York' });

    await pool().query('UPDATE agency_campaigns SET account_id = $2 WHERE id = $1', [id, OTHER_ACCOUNT]);
    expect(await probeSubscriptionSubject(sub('campaign', id))).toMatchObject({ available: false });
    expect(await probeSubscriptionSubject(sub('campaign', randomUUID()))).toMatchObject({ available: false });
  });

  it('an agent: any membership reaching the account (a departed agent included); none, or another account only, is gone', async () => {
    expect(await probeSubscriptionSubject(sub('agent', await member(A, 'active')))).toEqual({ available: true, timezone: null });
    expect(await probeSubscriptionSubject(sub('agent', await member(null, 'active')))).toEqual({ available: true, timezone: null });
    expect(await probeSubscriptionSubject(sub('agent', await member(A, 'revoked')))).toEqual({ available: true, timezone: null });
    expect(await probeSubscriptionSubject(sub('agent', await member(OTHER_ACCOUNT, 'active')))).toMatchObject({ available: false });
    expect(await probeSubscriptionSubject(sub('agent', randomUUID()))).toMatchObject({ available: false });
  });

  it('an account report is about its own account; a deleted account takes every kind with it', async () => {
    expect(await probeSubscriptionSubject(sub('account', A))).toEqual({ available: true, timezone: null });
    expect(await probeSubscriptionSubject(sub('account', OTHER_ACCOUNT))).toMatchObject({ available: false });
    const id = await campaign(A, 'UTC');
    await pool().query(`UPDATE accounts SET status = 'deleted' WHERE id = $1`, [A]);
    expect(await probeSubscriptionSubject(sub('account', A))).toMatchObject({ available: false });
    expect(await probeSubscriptionSubject(sub('campaign', id))).toMatchObject({ available: false });
    expect(await probeSubscriptionSubject(sub('account', A, null))).toMatchObject({ available: false });
  });
});
