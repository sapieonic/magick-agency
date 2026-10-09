import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * `POST /proxy/agency/ingest/jobs` stamps
 * `agency_ingest_jobs.account_id` from the PROVEN owner — the campaign row's account, read
 * in-process after the internal handler's `requireOwned` — whenever a campaign is named, because the
 * in-process roster hand-off compares the job's account to the campaign's and fails a
 * mismatched or NULL one. And no job row is written for a campaign the caller does not own.
 *
 * Through the real app (`buildApp`) on real Postgres (5436): the session (Firebase's token
 * check stubbed), tenant-context and RBAC, the public route, `callCore` → the internal
 * `GET /agency-campaigns/:id`. The detached ingest run is stubbed (it reads the CSV from S3,
 * which this suite is not about) so the job row stays as the route wrote it.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn(), run: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));
vi.mock('../../../src/agency/agency-ingest.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/agency/agency-ingest.service.js')>()),
  agencyIngestService: { run: mocks.run },
}));

import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { insertAgencyCampaign } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

let app: FastifyInstance;
let tenant: string;
let account: string;
let sibling: string;
let otherTenant: string;
let token: string;
let own: string;
let siblings: string;
let foreign: string;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (t: string) => ({ uid: t.slice(4), email: 'i@example.com', email_verified: true }));
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  mocks.run.mockReset().mockResolvedValue(undefined);
  await truncateAll();
  tenant = (await insertTenant()).id;
  account = (await insertAccount({ tenant_id: tenant })).id;
  sibling = (await insertAccount({ tenant_id: tenant })).id;
  otherTenant = (await insertTenant()).id;
  const otherAccount = (await insertAccount({ tenant_id: otherTenant })).id;
  const user = await insertUser();
  await insertMembership({ user_id: user.id, tenant_id: tenant, account_id: account, role: 'account_admin' });
  token = `tok:${user.firebase_uid}`;
  own = (await insertAgencyCampaign({ tenant_id: tenant, account_id: account })).id;
  siblings = (await insertAgencyCampaign({ tenant_id: tenant, account_id: sibling })).id;
  foreign = (await insertAgencyCampaign({ tenant_id: otherTenant, account_id: otherAccount })).id;
  for (const t of [tenant, otherTenant]) {
    await getTestPool().query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
       VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
      [t],
    );
  }
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

function start(body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/proxy/agency/ingest/jobs',
    headers: {
      authorization: `Bearer ${token}`,
      'x-tenant-id': tenant,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    payload: JSON.stringify({
      s3_key: `agency-ingest/${tenant}/u/roster.csv`,
      file_name: 'roster.csv',
      phone_column: 'Mobile',
      ...body,
    }),
  });
}

async function jobs(): Promise<Array<{ account_id: string | null; campaign_id: string | null }>> {
  return (await getTestPool().query('SELECT account_id, campaign_id FROM agency_ingest_jobs')).rows;
}

describe('POST /proxy/agency/ingest/jobs — the job is stamped with the proven owner (integration)', () => {
  it("a named campaign: the job carries the campaign row's account, header or no header", async () => {
    for (const headers of [{ 'x-account-id': account }, {}] as Array<Record<string, string>>) {
      const res = await start({ campaign_id: own }, headers);
      expect(res.statusCode, res.body).toBe(202);
    }
    expect(await jobs()).toEqual([
      { account_id: account, campaign_id: own },
      { account_id: account, campaign_id: own },
    ]);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another tenant', () => foreign],
    ['a sibling account', () => siblings],
  ])("a campaign of %s is a 404 and writes no job row (a dry run's included)", async (_label, id) => {
    for (const dry_run of [false, true]) {
      const res = await start({ campaign_id: id(), dry_run }, { 'x-account-id': account });
      expect(res.statusCode).toBe(404);
    }
    expect(await jobs()).toEqual([]);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("a dry run with no campaign keeps the existing rule: the caller's own account", async () => {
    const res = await start({ dry_run: true });
    expect(res.statusCode).toBe(202);
    expect(await jobs()).toEqual([{ account_id: account, campaign_id: null }]);
  });
});
