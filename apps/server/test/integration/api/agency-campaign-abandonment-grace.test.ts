import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * The abandonment grace per campaign (decisions AG1–AG5), through the REAL app (`buildApp`) on
 * real Postgres, the way the console sends it: the public `/proxy/agency/campaigns` routes,
 * session middleware (Firebase's token check is the one stub), tenancy, RBAC, `callCore`, the
 * internal handlers and the repositories. Its twin for the ceiling is
 * `agency-campaign-abandonment-ceiling.test.ts`.
 *
 * Pinned here:
 *  - create stores and returns the grace it was given, and 3000 (the column DEFAULT) when it was
 *    given none;
 *  - PATCH changes it on a RUNNING campaign (an operator setting with no status gate), audited as
 *    `agency_campaign.config_changed` with `{ from, to }`;
 *  - anything but a whole number of seconds from 1 to 5, in ms, is a 400 naming the field, and
 *    nothing is written;
 *  - a retry campaign inherits it;
 *  - every attempt insert stamps the campaign's grace as it stands when the row is created (the
 *    paced and agent dial's `create`, the wrap-up redial's `beginWrapupRedial`), and a later change
 *    of the setting leaves the stamp on calls already made (AG3).
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
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { agencyAttemptRepository } from '../../../src/db/repositories/agency.repository.js';
import { ABANDONED_ATTEMPT_PREDICATE_SQL } from '@magick-agency/domain/abandonment-predicate';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

let app: FastifyInstance;
let w: { tenant: string; account: string; uid: string; userId: string };

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token.startsWith('tok:')) return { uid: token.slice(4), email: `${token.slice(4)}@example.com`, email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const tenant = await insertTenant();
  const account = await insertAccount({ tenant_id: tenant.id });
  const user = await insertUser({ display_name: 'Sam Supervisor' });
  await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: account.id, role: 'account_admin' });
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant.id],
  );
  w = { tenant: tenant.id, account: account.id, uid: user.firebase_uid, userId: user.id };
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

function headers(uid = w.uid): Record<string, string> {
  return { authorization: `Bearer tok:${uid}`, 'x-tenant-id': w.tenant, 'x-account-id': w.account };
}

function create(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/proxy/agency/campaigns', headers: headers(),
    payload: { name: 'Q4 Renewals', caller_ids: ['+919000000001'], ...payload },
  });
}

function patch(id: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/proxy/agency/campaigns/${id}`, headers: headers(), payload });
}

/** The column as STORED, read independently of any response. */
async function storedGrace(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ g: number }>(
    'SELECT abandonment_grace_ms AS g FROM agency_campaigns WHERE id = $1', [campaignId]);
  return rows[0]!.g;
}

async function campaignCount(): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM agency_campaigns WHERE tenant_id = $1', [w.tenant]);
  return rows[0]!.n;
}

async function campaignAt(status: string, o: Record<string, unknown> = {}): Promise<string> {
  const row = await insertAgencyCampaign({ tenant_id: w.tenant, account_id: w.account, status, ...o });
  return row.id as string;
}

async function configChangedRows(campaignId: string) {
  await platformAuditLogger.shutdown();
  const { rows } = await getTestPool().query<{ details: Record<string, unknown> }>(
    `SELECT details FROM platform_audit_log
      WHERE action = 'agency_campaign.config_changed' AND campaign_id = $1
      ORDER BY created_at`,
    [campaignId],
  );
  return rows;
}

const MESSAGE = 'abandonment_grace_ms must be a whole number of seconds from 1 to 5, in milliseconds (1000, 2000, … 5000).';

/** Every value the column CHECK or NOT NULL would refuse, plus one the API refuses first. */
const REFUSED: Array<[string, unknown]> = [
  ['2.5 s (not a whole second)', 2500],
  ['6 s (over 5)', 6000],
  ['0', 0],
  ['half a second', 500],
  ['seconds instead of ms', 3],
  ['a numeric string', '3000'],
  ['null (the column is NOT NULL; "unset" is sending the default)', null],
];

describe('POST /proxy/agency/campaigns — abandonment_grace_ms', () => {
  it('stores and returns a non-default grace', async () => {
    const res = await create({ abandonment_grace_ms: 2000 });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string; abandonment_grace_ms: unknown };
    expect(body.abandonment_grace_ms).toBe(2000);
    expect(await storedGrace(body.id)).toBe(2000);
    const read = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${body.id}`, headers: headers() });
    expect(read.json().abandonment_grace_ms).toBe(2000);
  });

  it('defaults to 3000 when the body carries none', async () => {
    const res = await create({});
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().abandonment_grace_ms).toBe(3000);
    expect(await storedGrace(res.json().id as string)).toBe(3000);
  });

  it.each(REFUSED)('refuses %s with a 400 naming the field, and creates nothing', async (_label, value) => {
    const res = await create({ abandonment_grace_ms: value });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details).toEqual({ abandonment_grace_ms: MESSAGE });
    expect(await campaignCount()).toBe(0);
  });
});

describe('PATCH /proxy/agency/campaigns/:id — abandonment_grace_ms', () => {
  it('changes it on a RUNNING campaign, keeps it running, and files the change', async () => {
    const id = await campaignAt('running');
    const res = await patch(id, { abandonment_grace_ms: 5000 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ abandonment_grace_ms: 5000, status: 'running' });
    expect(await storedGrace(id)).toBe(5000);
    const rows = await configChangedRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual({
      campaign_id: id,
      fields: ['abandonment_grace_ms'],
      changes: { abandonment_grace_ms: { from: 3000, to: 5000 } },
    });
  });

  it.each([1000, 2000, 3000, 4000, 5000])('accepts %i', async (value) => {
    const id = await campaignAt('draft');
    const res = await patch(id, { abandonment_grace_ms: value });
    expect(res.statusCode, res.body).toBe(200);
    expect(await storedGrace(id)).toBe(value);
  });

  it.each(REFUSED)('refuses %s with a 400 naming the field, and writes nothing', async (_label, value) => {
    const id = await campaignAt('running');
    const res = await patch(id, { abandonment_grace_ms: value });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details).toEqual({ abandonment_grace_ms: MESSAGE });
    expect(await storedGrace(id)).toBe(3000);
    expect(await configChangedRows(id)).toEqual([]);
  });
});

describe('retry campaigns inherit the grace', () => {
  it('a retry of a campaign set to 4 s is set to 4 s', async () => {
    const parent = await campaignAt('completed', { abandonment_grace_ms: 4000, abandonment_ceiling_pct: 2.5 });
    await insertAgencyContact(parent, {
      tenant_id: w.tenant, account_id: w.account, phone_e164: '+919000000002',
      state: 'completed', last_outcome: 'no_answer', attempt_count: 1,
    });
    const res = await app.inject({
      method: 'POST', url: `/proxy/agency/campaigns/${parent}/retry`, headers: headers(),
      payload: { selector: { last_outcome: ['no_answer'] } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const childId = (res.json() as { campaign: { id: string } }).campaign.id;
    expect(await storedGrace(childId)).toBe(4000);
  });
});

describe('each attempt is stamped with the campaign\'s grace when it is created (AG3)', () => {
  async function stampOf(attemptId: string): Promise<number> {
    const { rows } = await getTestPool().query<{ g: number }>(
      'SELECT bridge_grace_ms AS g FROM agency_call_attempts WHERE id = $1', [attemptId]);
    return rows[0]!.g;
  }

  it('a paced (or agent) dial stamps the setting as it stands, and a later change leaves the stamp', async () => {
    const campaignId = await campaignAt('running', { abandonment_grace_ms: 5000 });
    const session = await insertAgentSession(campaignId, { tenant_id: w.tenant, account_id: w.account });
    const first = await insertAgencyContact(campaignId, { tenant_id: w.tenant, account_id: w.account, state: 'in_flight' });
    const a = await agencyAttemptRepository.create({
      campaignId, contactId: first.id as string, tenantId: w.tenant, accountId: w.account,
      callerId: '+919000000001', reservedAgentId: session.id as string, consumeAgentReopen: true,
    });
    expect(a!.bridge_grace_ms).toBe(5000);

    // The supervisor moves it to 1 s: the next call takes 1 s; the call already made keeps 5 s.
    expect((await patch(campaignId, { abandonment_grace_ms: 1000 })).statusCode).toBe(200);
    const second = await insertAgencyContact(campaignId, {
      tenant_id: w.tenant, account_id: w.account, state: 'in_flight', phone_e164: '+919000000777',
    });
    const b = await agencyAttemptRepository.create({
      campaignId, contactId: second.id as string, tenantId: w.tenant, accountId: w.account,
      callerId: '+919000000001', reservedAgentId: session.id as string,
      agentManual: { overrideApplied: [], overrideNote: null },
    });
    expect(b!.bridge_grace_ms).toBe(1000);
    expect(await stampOf(a!.id)).toBe(5000);

    // And the compliance predicate judges each by its own: bridged 2 s after the answer, the
    // first (5 s) is in time and the second (1 s) is abandoned.
    for (const id of [a!.id, b!.id]) {
      await getTestPool().query(
        `UPDATE agency_call_attempts SET state = 'ended', outcome = 'connected',
                answered_at = now() - interval '10 seconds', bridged_at = now() - interval '8 seconds', ended_at = now()
          WHERE id = $1`, [id]);
    }
    const { rows } = await getTestPool().query<{ id: string; hit: boolean }>(
      `SELECT id, (${ABANDONED_ATTEMPT_PREDICATE_SQL}) AS hit FROM agency_call_attempts WHERE id = ANY($1::uuid[])`,
      [[a!.id, b!.id]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.hit]))).toEqual({ [a!.id]: false, [b!.id]: true });
  });

  it('a wrap-up redial stamps the setting as it stands now, not the redialled call\'s', async () => {
    const campaignId = await campaignAt('paused', {
      abandonment_grace_ms: 2000, allow_wrapup_redial: true,
      disposition_catalog: JSON.stringify([{ code: 'sale', label: 'Sale', is_success: true, terminal: true }]),
    });
    const session = await insertAgentSession(campaignId, { tenant_id: w.tenant, account_id: w.account, state: 'wrapup' });
    const contact = await insertAgencyContact(campaignId, { tenant_id: w.tenant, account_id: w.account, state: 'connected', attempt_count: 1 });
    const original = await insertAgencyAttempt(campaignId, contact.id as string, {
      tenant_id: w.tenant, account_id: w.account, attempt_number: 1, state: 'ended', outcome: 'connected',
      reserved_agent_id: session.id, bridge_grace_ms: 2000,
      dialed_at: new Date(), answered_at: new Date(), bridged_at: new Date(), ended_at: new Date(),
    });
    expect((await patch(campaignId, { abandonment_grace_ms: 4000 })).statusCode).toBe(200);

    const res = await agencyAttemptRepository.beginWrapupRedial({
      redialOfAttemptId: original.id as string, sessionId: session.id as string,
      actorUserId: session.agent_user_id as string, callerId: '+919000000001', disposition: 'redialed',
    });
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    expect(res.attempt.bridge_grace_ms).toBe(4000);
    expect(await stampOf(original.id as string)).toBe(2000);
  });
});
