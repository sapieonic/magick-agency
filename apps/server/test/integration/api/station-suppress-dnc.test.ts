import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A station outcome that `suppress`es writes the campaign's Do Not Call entry (decision DS8),
 * through the REAL app: `buildApp` with the agency runtime, real Redis and Postgres, the real
 * session → tenant → RBAC chain (Firebase's token check is the one stub), the public
 * disposition route and the internal handler behind `callCore`, then the real dial-time check
 * (`DncRegistry.check`, B8) on the rows that landed.
 *
 * Before DS8 the outcome suppressed the one contact and wrote no `dnc_entries` row, so another
 * contact on the same number stayed dialable and a re-upload brought the number back, while
 * the agent app told the agent the number was on the list. The soft phone and inbound already
 * wrote a campaign entry for the same outcome; the station now does too.
 *
 * The entry is written with the outcome's FIRST write, in one transaction with it: a replay
 * never puts back a number an admin removed, and a failed entry records no outcome, so the
 * agent's retry writes both.
 *
 * Mutation-checked: never writing the entry reds the first, replay-free cases; writing it on
 * every write (replays too) reds "a replay after an admin removed the entry".
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'station-suppress-dnc-0123456789';
  return { verifyIdToken: vi.fn() };
});

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession } from '../agency/agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { resetAgencyRuntimeForTests } from '../../../src/bootstrap/agency.js';
import { resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { DncRegistry } from '../../../src/agency/dnc-registry.js';

const CATALOG = JSON.stringify([
  { code: 'do_not_call', label: 'Do not call', suppress: true },
  { code: 'reached', label: 'Reached', terminal: true },
]);
const PHONE = '+919812300231';
const registry = new DncRegistry();

let app: FastifyInstance;
let tenant: string;
let account: string;
let agent: { id: string; tok: string };
let supervisor: { id: string; tok: string };

async function user(role: string) {
  const u = await insertUser();
  await insertMembership({ user_id: u.id, tenant_id: tenant, account_id: account, role });
  return { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };
}

const post = (url: string, who: { tok: string }, body: unknown) => app.inject({
  method: 'POST',
  url,
  headers: {
    authorization: `Bearer ${who.tok}`, 'x-tenant-id': tenant, 'x-account-id': account, 'content-type': 'application/json',
  },
  payload: JSON.stringify(body),
});

interface Call { campaign: string; contact: string; attempt: string }

/** A campaign, a contact on {@link PHONE} and an ended, bridged attempt parked in the agent's wrap-up. */
async function parked(campaignId?: string): Promise<Call> {
  const campaign = campaignId ?? (await insertAgencyCampaign({
    status: 'running', disposition_catalog: CATALOG, tenant_id: tenant, account_id: account,
  })).id as string;
  const contact = (await insertAgencyContact(campaign, {
    tenant_id: tenant, account_id: account, phone_e164: PHONE, state: 'connected', attempt_count: 1, last_outcome: 'connected',
  })).id as string;
  const session = (await insertAgentSession(campaign, {
    tenant_id: tenant, account_id: account, agent_user_id: agent.id, state: 'wrapup',
  })).id as string;
  const attempt = (await insertAgencyAttempt(campaign, contact, {
    tenant_id: tenant, account_id: account, state: 'ended', outcome: 'connected', attempt_number: 1,
    reserved_agent_id: session, bridged_at: new Date(Date.now() - 60_000), ended_at: new Date(),
  })).id as string;
  return { campaign, contact, attempt };
}

const dispose = (c: Call, body: Record<string, unknown>, who = agent) =>
  post(`/proxy/agency/attempts/${c.attempt}/disposition`, who, body);

async function dncRows() {
  const { rows } = await getTestPool().query(
    `SELECT account_id, campaign_id, source, reason, added_by, phone_e164 FROM dnc_entries WHERE tenant_id = $1`, [tenant]);
  return rows;
}

beforeAll(async () => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 });
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    return { uid: token.slice(4), email: 'ds8@example.com', email_verified: true };
  });
  await flushTestRedis();
  resetVoiceEngineForTests();
  await resetAgencyRuntimeForTests();
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  app = await buildApp({ ctx });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  tenant = (await insertTenant()).id as string;
  account = (await insertAccount({ tenant_id: tenant })).id as string;
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`, [tenant]);
  agent = await user('agent');
  supervisor = await user('account_admin');
});

afterAll(async () => {
  await app?.close();
  await resetAgencyRuntimeForTests();
  resetVoiceEngineForTests();
  await closePool();
  await closeTestPool();
  await closeTestRedis();
});

describe('a station outcome that suppresses puts the number on the campaign\'s Do Not Call list (DS8)', () => {
  it('writes one campaign-scoped entry by the agent, and the dial-time check blocks that campaign only', async () => {
    const c = await parked();
    const sibling = (await insertAgencyCampaign({
      status: 'running', disposition_catalog: CATALOG, tenant_id: tenant, account_id: account,
    })).id as string;

    const res = await dispose(c, { disposition_code: 'do_not_call' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ contact_state: 'suppressed' });

    expect(await dncRows()).toEqual([{
      account_id: null, campaign_id: c.campaign, source: 'agent', reason: 'disposition:do_not_call',
      added_by: agent.id, phone_e164: PHONE,
    }]);
    expect(await registry.check(tenant, PHONE, { accountId: account, campaignId: c.campaign })).toBe('suppressed');
    // Campaign scope, never the escalation: another campaign of the account may still call.
    expect(await registry.check(tenant, PHONE, { accountId: account, campaignId: sibling })).not.toBe('suppressed');
  });

  it('a same-code replay writes nothing more', async () => {
    const c = await parked();
    expect((await dispose(c, { disposition_code: 'do_not_call' })).statusCode).toBe(200);
    expect((await dispose(c, { disposition_code: 'do_not_call' })).statusCode).toBe(200);
    expect(await dncRows()).toHaveLength(1);
  });

  it('a replay after an admin removed the entry does not put the number back', async () => {
    const c = await parked();
    expect((await dispose(c, { disposition_code: 'do_not_call' })).statusCode).toBe(200);
    // The customer later consented and an admin removed the entry from the list.
    await getTestPool().query('DELETE FROM dnc_entries WHERE tenant_id = $1', [tenant]);
    // A queued retry, or a supervisor re-filing the same code from the history, lands.
    const replay = await dispose(c, { disposition_code: 'do_not_call' });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(await dncRows()).toEqual([]);
  });

  it('the outcome and its entry land together: a failed entry records no outcome, and the retry writes both', async () => {
    const c = await parked();
    await getTestPool().query('ALTER TABLE dnc_entries RENAME TO dnc_entries_away');
    try {
      const failed = await dispose(c, { disposition_code: 'do_not_call' });
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await getTestPool().query('ALTER TABLE dnc_entries_away RENAME TO dnc_entries');
    }
    const { rows } = await getTestPool().query('SELECT disposition_code FROM agency_call_attempts WHERE id = $1', [c.attempt]);
    expect(rows[0]!.disposition_code).toBeNull();
    // The retry is a first write again, so it writes the entry as well as the outcome.
    const retried = await dispose(c, { disposition_code: 'do_not_call' });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(await dncRows()).toHaveLength(1);
  });

  it('a supervisor filing on the agent\'s behalf is the entry\'s author', async () => {
    const c = await parked();
    const res = await dispose(c, { disposition_code: 'do_not_call', agent_user_id: agent.id }, supervisor);
    expect(res.statusCode, res.body).toBe(200);
    expect(await dncRows()).toEqual([expect.objectContaining({ campaign_id: c.campaign, added_by: supervisor.id })]);
  });

  it('an outcome that does not suppress writes no entry', async () => {
    const c = await parked();
    expect((await dispose(c, { disposition_code: 'reached' })).statusCode).toBe(200);
    expect(await dncRows()).toEqual([]);
  });
});
