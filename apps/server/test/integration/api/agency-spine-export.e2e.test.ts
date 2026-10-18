import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * The spine CSV exports (`GET /proxy/agency/campaigns/:id/{attempts,contacts}.csv`)
 * drained across SEVERAL pages, through the real app on real Postgres: the public route,
 * `callCore`, the internal page reads and the repositories.
 *
 * The export proves ownership once (`requireOwnedCampaign`) and then reads up to 100
 * pages with `provenCampaignId`, so each page skips the handler's flag read and campaign
 * read (`spinePageCampaignId`). These cases pin what that must not change: every row
 * exactly once across page boundaries, the row-count and truncation
 * headers, the filename, the preamble — and that a campaign the caller does not own is
 * still refused before any page is read.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
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
import { SPINE_EXPORT_PAGE_SIZE } from '../../../src/agency/agency-spine.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

/** More than two full pages, so the drain crosses two page boundaries. */
const CONTACTS = SPINE_EXPORT_PAGE_SIZE * 2 + 37;
/** More than one full page of attempts. */
const ATTEMPTS = SPINE_EXPORT_PAGE_SIZE + 11;

let app: FastifyInstance;
let w: { tenant: string; account: string; sibling: string; uid: string; campaign: string; siblingCampaign: string };

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token.startsWith('tok:')) return { uid: token.slice(4), email: 'export@example.com', email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const tenant = await insertTenant();
  const account = await insertAccount({ tenant_id: tenant.id });
  const sibling = await insertAccount({ tenant_id: tenant.id });
  const user = await insertUser({ display_name: 'Export Admin' });
  await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: account.id, role: 'account_admin' });
  const campaign = await insertAgencyCampaign({ tenant_id: tenant.id, account_id: account.id, name: 'Q3 Renewals' });
  const siblingCampaign = await insertAgencyCampaign({ tenant_id: tenant.id, account_id: sibling.id, name: 'Sibling' });
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant.id],
  );
  for (const c of [campaign.id, siblingCampaign.id]) {
    const owner = c === campaign.id ? account.id : sibling.id;
    await getTestPool().query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state, source_row_number)
       SELECT $1, $2, $3, '+9198' || lpad(g::text, 8, '0'), '{"name":"Test Person"}'::jsonb, 'pending', g
         FROM generate_series(1, $4::int) AS g`,
      [c, tenant.id, owner, CONTACTS],
    );
  }
  await getTestPool().query(
    `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state)
     SELECT campaign_id, id, tenant_id, account_id, 1, '+919000000001', 'queued'
       FROM agency_contacts WHERE campaign_id = $1 ORDER BY source_row_number LIMIT $2`,
    [campaign.id, ATTEMPTS],
  );
  w = {
    tenant: tenant.id, account: account.id, sibling: sibling.id, uid: user.firebase_uid,
    campaign: campaign.id as string, siblingCampaign: siblingCampaign.id as string,
  };
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

function get(url: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer tok:${w.uid}`, 'x-tenant-id': w.tenant, 'x-account-id': w.account },
  });
}

/** The data lines of a preamble-less CSV body (header dropped). */
function dataLines(body: string): string[] {
  return body.split('\n').filter((line) => line.length > 0).slice(1);
}

describe('spine CSV export across several pages (e2e)', () => {
  it('contacts.csv carries every contact exactly once, with the export headers', async () => {
    const res = await get(`/proxy/agency/campaigns/${w.campaign}/contacts.csv?preamble=false`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="contacts-Q3 Renewals.csv"; filename*=UTF-8\'\'contacts-Q3%20Renewals.csv',
    );
    expect(res.headers['x-export-rows']).toBe(String(CONTACTS));
    expect(res.headers['x-export-truncated']).toBeUndefined();

    const ids = dataLines(res.body).map((line) => line.split(',')[0]);
    expect(ids).toHaveLength(CONTACTS);
    expect(new Set(ids).size).toBe(CONTACTS);
    // The interactive list's own order, read straight from the table it pages.
    const { rows } = await getTestPool().query<{ id: string }>(
      `SELECT id FROM agency_contacts WHERE campaign_id = $1 ORDER BY created_at DESC, id DESC`,
      [w.campaign],
    );
    expect(new Set(ids)).toEqual(new Set(rows.map((r) => r.id)));
  });

  it('attempts.csv crosses its page boundary without dropping or repeating a row', async () => {
    const res = await get(`/proxy/agency/campaigns/${w.campaign}/attempts.csv?preamble=false`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="attempts-Q3 Renewals.csv"; filename*=UTF-8\'\'attempts-Q3%20Renewals.csv',
    );
    expect(res.headers['x-export-rows']).toBe(String(ATTEMPTS));
    const ids = dataLines(res.body).map((line) => line.split(',')[0]);
    expect(ids).toHaveLength(ATTEMPTS);
    expect(new Set(ids).size).toBe(ATTEMPTS);
  });

  it('the preamble states the row count the file holds', async () => {
    const res = await get(`/proxy/agency/campaigns/${w.campaign}/contacts.csv`);

    expect(res.statusCode).toBe(200);
    expect(res.body.startsWith('#')).toBe(true);
    expect(res.body).toContain(String(CONTACTS));
  });

  it('a sibling account\'s campaign is refused before any page is read, with none of its rows', async () => {
    for (const kind of ['contacts', 'attempts']) {
      const res = await get(`/proxy/agency/campaigns/${w.siblingCampaign}/${kind}.csv?preamble=false`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('campaign_not_found');
      expect(res.body).not.toContain('+9198');
    }
  });
});
