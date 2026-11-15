import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * `POST /proxy/agency/ingest/jobs/:id/import` (IM2), `GET …/skipped.csv` (IM3) and the
 * one-live-import rule on `POST /proxy/agency/ingest/jobs` (IM7), through the real app
 * (`buildApp`) on real Postgres: session (Firebase's token check stubbed), tenant context,
 * RBAC, the public routes, the campaign ownership probe through `callCore`. The detached
 * ingest run is stubbed, so each job row stays as the route wrote it and a test sets the
 * check's outcome itself.
 *
 * What it pins: the import copies the CHECK's file and mapping (the client cannot change
 * them in between); a check is imported once (a second click answers with the first
 * import); an expired, unfinished, failed or non-check job is refused with a code; a check
 * made for one campaign cannot be imported into another; a sibling account's check id, its
 * poll and its downloads are the same 404 as a missing one; an agent cannot import.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn(), run: vi.fn(), getFile: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));
vi.mock('../../../src/agency/agency-ingest.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/agency/agency-ingest.service.js')>()),
  agencyIngestService: { run: mocks.run },
}));
vi.mock('../../../src/storage/s3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/storage/s3.js')>()),
  getFile: mocks.getFile,
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
let token: string;
let siblingToken: string;
let agentToken: string;
let own: string;
let ownOther: string;
let siblings: string;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (t: string) => ({ uid: t.slice(4), email: 'i@example.com', email_verified: true }));
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  mocks.run.mockReset().mockResolvedValue(undefined);
  mocks.getFile.mockReset();
  await truncateAll();
  tenant = (await insertTenant()).id;
  account = (await insertAccount({ tenant_id: tenant })).id;
  sibling = (await insertAccount({ tenant_id: tenant })).id;
  const admin = await insertUser();
  await insertMembership({ user_id: admin.id, tenant_id: tenant, account_id: account, role: 'account_admin' });
  token = `tok:${admin.firebase_uid}`;
  const siblingAdmin = await insertUser();
  await insertMembership({ user_id: siblingAdmin.id, tenant_id: tenant, account_id: sibling, role: 'account_admin' });
  siblingToken = `tok:${siblingAdmin.firebase_uid}`;
  const agent = await insertUser();
  await insertMembership({ user_id: agent.id, tenant_id: tenant, account_id: account, role: 'agent' });
  agentToken = `tok:${agent.firebase_uid}`;
  own = (await insertAgencyCampaign({ tenant_id: tenant, account_id: account })).id;
  ownOther = (await insertAgencyCampaign({ tenant_id: tenant, account_id: account })).id;
  siblings = (await insertAgencyCampaign({ tenant_id: tenant, account_id: sibling })).id;
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant],
  );
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

function call(method: 'GET' | 'POST', url: string, body?: Record<string, unknown>, as = token, accountId = account) {
  return app.inject({
    method,
    url: `/proxy/agency${url}`,
    headers: {
      authorization: `Bearer ${as}`,
      'x-tenant-id': tenant,
      'x-account-id': accountId,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
}

const MAPPING = {
  s3_key: '',
  file_name: 'loans.csv',
  phone_column: 'Mobile',
  ignore_columns: ['Score'],
  default_country_code: '+1',
  dedupe_columns: ['Loan No', 'Branch'],
};

/** A check, finished as the stubbed run would have finished it (`finished_at` moved by `age`). */
async function check(campaignId: string | null, status = 'completed', ageHours = 0): Promise<string> {
  const res = await call('POST', '/ingest/jobs', {
    ...MAPPING, s3_key: `agency-ingest/${tenant}/u-1/loans.csv`, dry_run: true, ...(campaignId ? { campaign_id: campaignId } : {}),
  });
  expect(res.statusCode, res.body).toBe(202);
  const id = res.json().job_id as string;
  await getTestPool().query(
    `UPDATE agency_ingest_jobs SET status = $2, finished_at = NOW() - make_interval(hours => $3::int) WHERE id = $1`,
    [id, status, ageHours],
  );
  // The check's own (stubbed) run is not what these cases count.
  mocks.run.mockClear();
  return id;
}

const jobRow = async (id: string) =>
  (await getTestPool().query('SELECT * FROM agency_ingest_jobs WHERE id = $1', [id])).rows[0] as Record<string, unknown>;

describe('POST /ingest/jobs/:id/import (integration)', () => {
  it('imports exactly the checked file and mapping, once', async () => {
    const checkId = await check(own);
    // The body may not change anything but the campaign, which must be the check's.
    const res = await call('POST', `/ingest/jobs/${checkId}/import`, { campaign_id: own, phone_column: 'Other' });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ check_job_id: checkId, already_started: false, mode: 'append' });

    const imported = await jobRow(body.job_id);
    expect(imported).toMatchObject({
      dry_run: false, campaign_id: own, account_id: account, check_job_id: checkId,
      s3_key: `agency-ingest/${tenant}/u-1/loans.csv`, file_name: 'loans.csv', phone_column: 'Mobile',
      ignore_columns: ['Score'], default_country_code: '1', dedupe_columns: ['Loan No', 'Branch'],
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);

    // A second click (or a second tab) gets the same import back, and starts nothing.
    const again = await call('POST', `/ingest/jobs/${checkId}/import`, {});
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ job_id: body.job_id, already_started: true });
    expect(mocks.run).toHaveBeenCalledTimes(1);

    // The check names its import; the import names its check.
    expect((await call('GET', `/ingest/jobs/${checkId}`)).json()).toMatchObject({ import_job_id: body.job_id, check_expires_at: expect.any(String) });
    expect((await call('GET', `/ingest/jobs/${body.job_id}`)).json()).toMatchObject({ check_job_id: checkId, import_job_id: null, skipped: 0 });
  });

  it('a check made before the campaign existed is imported into the campaign named now', async () => {
    const checkId = await check(null);
    expect((await call('POST', `/ingest/jobs/${checkId}/import`, {})).statusCode).toBe(400);
    const res = await call('POST', `/ingest/jobs/${checkId}/import`, { campaign_id: own });
    expect(res.statusCode, res.body).toBe(202);
    expect(await jobRow(res.json().job_id)).toMatchObject({ campaign_id: own, check_job_id: checkId });
  });

  it('refuses a check made for another campaign, and a campaign of a sibling account', async () => {
    const checkId = await check(own);
    const other = await call('POST', `/ingest/jobs/${checkId}/import`, { campaign_id: ownOther });
    expect(other.statusCode).toBe(400);
    expect(other.json().message).toContain('another campaign');

    const unscoped = await check(null);
    expect((await call('POST', `/ingest/jobs/${unscoped}/import`, { campaign_id: siblings })).statusCode).toBe(404);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', 0, 409, 'check_not_finished'],
    ['running', 0, 409, 'check_not_finished'],
    ['failed', 0, 409, 'check_failed'],
    ['cancelled', 0, 409, 'check_failed'],
    ['completed', 25, 410, 'check_expired'],
  ])('a check that is %s (%i h old) is refused %i %s', async (status, age, code, errorCode) => {
    const checkId = await check(own, status, age);
    const res = await call('POST', `/ingest/jobs/${checkId}/import`, {});
    expect(res.statusCode, res.body).toBe(code);
    expect(res.json().code).toBe(errorCode);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('an import is not a check', async () => {
    const res = await call('POST', '/ingest/jobs', { ...MAPPING, s3_key: `agency-ingest/${tenant}/u-1/loans.csv`, campaign_id: own });
    const imported = await call('POST', `/ingest/jobs/${res.json().job_id}/import`, {});
    expect(imported.statusCode).toBe(409);
    expect(imported.json().code).toBe('not_a_check');
  });

  it('refuses while another import into the campaign is running, and says which', async () => {
    const running = await call('POST', '/ingest/jobs', { ...MAPPING, s3_key: `agency-ingest/${tenant}/u-2/other.csv`, file_name: 'other.csv', campaign_id: own });
    expect(running.statusCode).toBe(202);
    const checkId = await check(own);
    const res = await call('POST', `/ingest/jobs/${checkId}/import`, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'import_in_progress', live_job_id: running.json().job_id });
    expect(res.json().message).toContain('other.csv');
    // A check still runs: it writes nothing.
    expect((await call('POST', '/ingest/jobs', { ...MAPPING, s3_key: `agency-ingest/${tenant}/u-1/loans.csv`, dry_run: true, campaign_id: own })).statusCode).toBe(202);
  });

  it("a sibling account's check is a 404 everywhere, exactly like a missing one; an agent cannot import", async () => {
    const checkId = await check(own);
    for (const [method, url] of [
      ['POST', `/ingest/jobs/${checkId}/import`],
      ['GET', `/ingest/jobs/${checkId}`],
      ['GET', `/ingest/jobs/${checkId}/skipped.csv`],
      ['GET', `/ingest/jobs/${checkId}/rejected.csv`],
    ] as const) {
      const res = await call(method, url, method === 'POST' ? { campaign_id: siblings } : undefined, siblingToken, sibling);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().message).toBe('Import not found.');
    }
    expect((await call('POST', `/ingest/jobs/${checkId}/import`, {}, agentToken)).statusCode).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.getFile).not.toHaveBeenCalled();
  });
});

describe('GET /ingest/jobs/:id/skipped.csv (integration)', () => {
  it('serves the skipped rows, 404 when there were none, 410 when storage has expired them', async () => {
    const checkId = await check(own);
    expect((await call('GET', `/ingest/jobs/${checkId}/skipped.csv`)).statusCode).toBe(404);

    await getTestPool().query('UPDATE agency_ingest_jobs SET skipped_s3_key = $2, skipped = 1 WHERE id = $1', [checkId, `agency-ingest/${tenant}/${checkId}/skipped-rows.csv`]);
    mocks.getFile.mockResolvedValueOnce(Buffer.from('_row,Mobile,_reason\n2,98,Already in this campaign\n'));
    const ok = await call('GET', `/ingest/jobs/${checkId}/skipped.csv`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-disposition']).toContain('loans-skipped-rows');
    expect(ok.body).toContain('Already in this campaign');

    mocks.getFile.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));
    const gone = await call('GET', `/ingest/jobs/${checkId}/skipped.csv`);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().code).toBe('export_expired');
  });
});
