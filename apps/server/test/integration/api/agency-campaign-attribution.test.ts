import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Who made a campaign, through the REAL app (`buildApp`) on real Postgres (decision IN8).
 *
 * `agency_campaigns.created_by` and the dialer's `agency_campaign.created` audit row are
 * both filled from the originator `callCore` sends. No public route sent one, so every
 * campaign read `created_by = NULL` and its creation was filed under `system:api`. The
 * public create and retry routes now send the signed-in user's id.
 *
 * Real: the session middleware (Firebase's token check is the one stub), tenancy, RBAC,
 * the public handlers, `callCore`, the internal handlers and every repository. The last
 * case calls the internal handler directly with no originator, which must still work and
 * still read as the system.
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
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { callCore } from '../../../src/api/core-dispatch.js';
import { auditLogger } from '../../../src/audit/audit-logger.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

let app: FastifyInstance;
let w: { tenant: string; account: string; user: { id: string; firebase_uid: string } };

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token.startsWith('tok:')) return { uid: token.slice(4), email: 'creator@example.com', email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const tenant = await insertTenant();
  const account = await insertAccount({ tenant_id: tenant.id });
  const user = await insertUser({ display_name: 'Priya Creator' });
  await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: account.id, role: 'account_admin' });
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant.id],
  );
  w = { tenant: tenant.id, account: account.id, user: { id: user.id, firebase_uid: user.firebase_uid } };
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

function headers(): Record<string, string> {
  return {
    authorization: `Bearer tok:${w.user.firebase_uid}`,
    'x-tenant-id': w.tenant,
    'x-account-id': w.account,
  };
}

async function createdBy(campaignId: string): Promise<string | null> {
  const { rows } = await getTestPool().query<{ created_by: string | null }>(
    'SELECT created_by FROM agency_campaigns WHERE id = $1',
    [campaignId],
  );
  return rows[0]!.created_by;
}

/** The dialer-side creation rows for a campaign, after the buffered logger has flushed. */
async function createdAuditActors(campaignId: string): Promise<Array<string | null>> {
  await auditLogger.shutdown();
  const { rows } = await getTestPool().query<{ actor: string | null }>(
    `SELECT actor FROM audit_logs
      WHERE event_type = 'agency_campaign.created' AND event_data->>'campaign_id' = $1`,
    [campaignId],
  );
  return rows.map((r) => r.actor);
}

describe('the creator is recorded (IN8)', () => {
  it('a campaign created through the public route names the signed-in user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/proxy/agency/campaigns',
      headers: headers(),
      payload: { name: 'Q4 Renewals', caller_ids: ['+919000000001'] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { id: string }).id;

    expect(await createdBy(id)).toBe(w.user.id);
    expect(await createdAuditActors(id)).toEqual([w.user.id]);

    // And the Activity tab names the person rather than a uuid or `system:api`.
    const activity = await app.inject({
      method: 'GET', url: `/proxy/agency/campaigns/${id}/activity`, headers: headers(),
    });
    expect(activity.statusCode, activity.body).toBe(200);
    const created = (activity.json() as { rows: Array<{ action: string; actor: Record<string, unknown> }> })
      .rows.find((r) => r.action === 'agency_campaign.created');
    expect(created?.actor).toEqual({
      type: 'human', system: false, user_id: w.user.id, api_key_id: null, display: 'Priya Creator',
    });
  });

  it('a retry created through the public route names the signed-in user', async () => {
    const parent = await insertAgencyCampaign({
      tenant_id: w.tenant, account_id: w.account, name: 'Q3 Winback', status: 'completed',
    });
    await insertAgencyContact(parent.id, {
      tenant_id: w.tenant, account_id: w.account, phone_e164: '+919000000002',
      state: 'completed', last_outcome: 'no_answer', attempt_count: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/proxy/agency/campaigns/${parent.id}/retry`,
      headers: headers(),
      payload: { selector: { last_outcome: ['no_answer'] } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const childId = (res.json() as { campaign: { id: string } }).campaign.id;

    expect(await createdBy(childId)).toBe(w.user.id);
    expect(await createdAuditActors(childId)).toEqual([w.user.id]);
  });

  it('the internal handler without an originator still creates, and reads as the system', async () => {
    const res = await callCore({
      method: 'POST',
      path: '/agency-campaigns',
      body: { name: 'Scripted', caller_ids: ['+919000000003'] },
      tenantId: w.tenant,
      accountId: w.account,
    });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;

    expect(await createdBy(id)).toBeNull();
    expect(await createdAuditActors(id)).toEqual(['system:api']);
  });
});

/** The `agency_campaign.config_changed` rows for a campaign, after the logger has flushed. */
async function configChangedRows(campaignId: string) {
  await platformAuditLogger.shutdown();
  const { rows } = await getTestPool().query<{ actor_type: string; user_id: string | null; details: Record<string, unknown> }>(
    `SELECT actor_type, user_id, details FROM platform_audit_log
      WHERE action = 'agency_campaign.config_changed' AND campaign_id = $1
      ORDER BY created_at`,
    [campaignId],
  );
  return rows;
}

describe('a config change is in the activity log (IN8)', () => {
  async function create(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/proxy/agency/campaigns', headers: headers(),
      payload: { name: 'Q4 Renewals', caller_ids: ['+919000000001'] },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it('one row per PATCH that changed anything, with names and the small values', async () => {
    const id = await create();
    const res = await app.inject({
      method: 'PATCH', url: `/proxy/agency/campaigns/${id}`, headers: headers(),
      payload: {
        name: 'Q4 Renewals v2', calling_window_end: '21:00', wrapup_seconds: 45,
        // Sent unchanged: not named.
        calling_window_start: '09:00',
        disposition_catalog: [{ code: 'sale', label: 'Sale', is_success: true }],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    // The private change header never reaches the client.
    expect(res.headers['x-mgkvc-config-change']).toBeUndefined();

    const rows = await configChangedRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'human', user_id: w.user.id });
    expect(rows[0]!.details).toEqual({
      campaign_id: id,
      fields: ['name', 'calling_window_end', 'wrapup_seconds', 'disposition_catalog'],
      changes: {
        name: { from: 'Q4 Renewals', to: 'Q4 Renewals v2' },
        calling_window_end: { from: '20:00:00', to: '21:00:00' },
        wrapup_seconds: { from: 30, to: 45 },
      },
    });

    // And it is on the campaign's Activity tab, labelled by the served vocabulary.
    const activity = await app.inject({
      method: 'GET', url: `/proxy/agency/campaigns/${id}/activity`, headers: headers(),
    });
    const body = activity.json() as {
      rows: Array<{ action: string }>;
      available_actions?: Array<{ value: string; label: string }>;
    };
    expect(body.rows.filter((r) => r.action === 'agency_campaign.config_changed')).toHaveLength(1);
    expect(body.available_actions?.find((a) => a.value === 'agency_campaign.config_changed')?.label)
      .toBe('Settings changed');
  });

  it('a save of what is already stored files no row', async () => {
    const id = await create();
    const res = await app.inject({
      method: 'PATCH', url: `/proxy/agency/campaigns/${id}`, headers: headers(),
      payload: { name: 'Q4 Renewals', calling_window_end: '20:00' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await configChangedRows(id)).toEqual([]);
  });
});
