import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * The supervisor sets a campaign's abandonment ceiling, through the REAL app (`buildApp`)
 * on real Postgres, the way the console sends it: the public `/proxy/agency/campaigns`
 * routes, session middleware (Firebase's token check is the one stub), tenancy, RBAC,
 * `callCore`, the internal handlers and the repositories.
 *
 * Pinned here:
 *  - create stores and returns the ceiling it was given, and 3 (the column DEFAULT) when
 *    it was given none;
 *  - PATCH changes it on a draft and on a RUNNING campaign (it is an operator setting with
 *    no status gate), the response carries the new value, and a later read agrees;
 *  - every value the column CHECK or the NOT NULL would refuse is a 400 naming the field,
 *    and nothing is written;
 *  - a change is filed as `agency_campaign.config_changed` with `{ from, to }`;
 *  - only `agency.campaigns.write` (account_admin and up) may change it;
 *  - the auto-pause guardrail then acts on THAT value, read from the column through the
 *    24h window, not on the default.
 *
 * The public layer does not validate this field itself (`agency-campaign-config.ts` has no
 * rule for it): the 400 is the internal handler's (`configRejected`), forwarded unchanged.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import { closePool, initDbPool } from '@magick-agency/db';
import type { Role } from '@magick-agency/contracts/rbac';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { agencyAbandonmentRepository } from '../../../src/db/repositories/agency.repository.js';
import { enforceAbandonmentCeiling } from '../../../src/agency/abandonment-guardrail.js';

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

function patch(id: string, payload: unknown, uid?: string) {
  return app.inject({ method: 'PATCH', url: `/proxy/agency/campaigns/${id}`, headers: headers(uid), payload: payload as Record<string, unknown> });
}

/** The column as STORED, read independently of any response. */
async function storedCeiling(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ abandonment_ceiling_pct: number }>(
    'SELECT abandonment_ceiling_pct FROM agency_campaigns WHERE id = $1', [campaignId]);
  return rows[0]!.abandonment_ceiling_pct;
}

async function campaignCount(): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM agency_campaigns WHERE tenant_id = $1', [w.tenant]);
  return rows[0]!.n;
}

/** This tenant's campaign at `status`, as the dialer stored it (status is not patchable). */
async function campaignAt(status: string): Promise<string> {
  const row = await insertAgencyCampaign({ tenant_id: w.tenant, account_id: w.account, status });
  return row.id as string;
}

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

const NOT_A_NUMBER = 'abandonment_ceiling_pct must be a number.';
const OUT_OF_RANGE = 'abandonment_ceiling_pct must be greater than 0 and at most 100.';

/** Every value the console must not be able to store, and the message each earns. */
const REFUSED: Array<[string, unknown, string]> = [
  ['zero (a kill switch, not a setting)', 0, OUT_OF_RANGE],
  ['negative', -1, OUT_OF_RANGE],
  ['over 100', 100.5, OUT_OF_RANGE],
  ['a numeric string', '4.5', NOT_A_NUMBER],
  ['null (the column is NOT NULL; "unset" is sending the default)', null, NOT_A_NUMBER],
];

describe('POST /proxy/agency/campaigns — abandonment_ceiling_pct', () => {
  it('stores and returns a non-default ceiling', async () => {
    const res = await create({ abandonment_ceiling_pct: 4.5 });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string; abandonment_ceiling_pct: unknown };
    expect(body.abandonment_ceiling_pct).toBe(4.5);
    expect(await storedCeiling(body.id)).toBe(4.5);

    const read = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${body.id}`, headers: headers() });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().abandonment_ceiling_pct).toBe(4.5);
  });

  it('defaults to 3 when the body carries none', async () => {
    const res = await create({});
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string; abandonment_ceiling_pct: unknown };
    expect(body.abandonment_ceiling_pct).toBe(3);
    expect(await storedCeiling(body.id)).toBe(3);
  });

  it.each(REFUSED)('refuses %s with a 400 naming the field, and creates nothing', async (_label, value, message) => {
    const res = await create({ abandonment_ceiling_pct: value });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details).toEqual({ abandonment_ceiling_pct: message });
    expect(await campaignCount()).toBe(0);
  });
});

describe('PATCH /proxy/agency/campaigns/:id — abandonment_ceiling_pct', () => {
  it('changes it on a draft: the response carries it, it persists, and the change is audited', async () => {
    const created = await create({});
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;

    const res = await patch(id, { abandonment_ceiling_pct: 4.5 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().abandonment_ceiling_pct).toBe(4.5);
    expect(res.json().status).toBe('draft');
    expect(await storedCeiling(id)).toBe(4.5);
    const read = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${id}`, headers: headers() });
    expect(read.json().abandonment_ceiling_pct).toBe(4.5);

    // One row, the field named, the two numbers carried as numbers (DOUBLE PRECISION
    // serialises as a JSON number on both sides, so 3 → 4.5, not "3" → "4.5").
    const rows = await configChangedRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'human', user_id: w.userId });
    expect(rows[0]!.details).toEqual({
      campaign_id: id,
      fields: ['abandonment_ceiling_pct'],
      changes: { abandonment_ceiling_pct: { from: 3, to: 4.5 } },
    });
  });

  it('changes it on a RUNNING campaign: no status gate, and the campaign keeps running', async () => {
    const id = await campaignAt('running');

    const res = await patch(id, { abandonment_ceiling_pct: 7.25 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ abandonment_ceiling_pct: 7.25, status: 'running' });
    expect(await storedCeiling(id)).toBe(7.25);
  });

  it('a save of the stored value is a 200 that files no audit row', async () => {
    // The settings form re-sends every field on save; an unchanged ceiling is not a change.
    const id = await campaignAt('running');
    const res = await patch(id, { abandonment_ceiling_pct: 3 });
    expect(res.statusCode, res.body).toBe(200);
    expect(await configChangedRows(id)).toEqual([]);
  });

  it.each([
    ['the smallest positive value', 0.1],
    ['exactly 100 (the CHECK is <= 100)', 100],
  ])('accepts %s', async (_label, value) => {
    const id = await campaignAt('draft');
    const res = await patch(id, { abandonment_ceiling_pct: value });
    expect(res.statusCode, res.body).toBe(200);
    expect(await storedCeiling(id)).toBe(value);
  });

  it.each(REFUSED)('refuses %s with a 400 naming the field, and writes nothing', async (_label, value, message) => {
    const id = await campaignAt('running');
    const res = await patch(id, { abandonment_ceiling_pct: value });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details).toEqual({ abandonment_ceiling_pct: message });
    expect(await storedCeiling(id)).toBe(3);
    expect(await configChangedRows(id)).toEqual([]);
  });

  it.each<Role>(['agent', 'viewer', 'operator'])(
    'refuses a %s: changing it needs agency.campaigns.write (account_admin and up)',
    async (role) => {
      const id = await campaignAt('running');
      const other = await insertUser();
      await insertMembership({ user_id: other.id, tenant_id: w.tenant, account_id: w.account, role });

      const res = await patch(id, { abandonment_ceiling_pct: 10 }, other.firebase_uid);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toEqual({
        error: 'Forbidden', message: 'Insufficient permissions. Required: agency.campaigns.write',
      });
      expect(await storedCeiling(id)).toBe(3);
      expect(await configChangedRows(id)).toEqual([]);
    },
  );
});

describe('the guardrail pauses at the ceiling the supervisor set', () => {
  /**
   * `answered` ended attempts inside the 24h window, the first `abandoned` of them
   * answered and never bridged (abandoned by the shared predicate), the rest bridged
   * 200 ms after answer (inside the 1 s grace, so not abandoned).
   */
  async function seedWindow(campaignId: string, accountId: string, answered: number, abandoned: number): Promise<void> {
    const contact = await insertAgencyContact(campaignId, { tenant_id: w.tenant, account_id: accountId });
    await getTestPool().query(
      `INSERT INTO agency_call_attempts
         (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id,
          state, outcome, answered_at, bridged_at, ended_at)
       SELECT $1, $2, $3, $4, i, '+919000000001', 'ended', 'completed',
              now() - interval '10 minutes',
              CASE WHEN i <= $5::int THEN NULL
                   ELSE now() - interval '10 minutes' + interval '200 milliseconds' END,
              now() - interval '5 minutes'
         FROM generate_series(1, $6::int) AS i`,
      [campaignId, contact.id, w.tenant, accountId, abandoned, answered],
    );
  }

  async function statusOf(campaignId: string) {
    const { rows } = await getTestPool().query<{ status: string; pause_reason: string | null; pause_abandonment_rate_pct: number | null }>(
      'SELECT status, pause_reason, pause_abandonment_rate_pct FROM agency_campaigns WHERE id = $1', [campaignId]);
    return rows[0]!;
  }

  /** One metrics-refresh pass: the window the refresh reads, then the guardrail on it. */
  async function refresh() {
    return enforceAbandonmentCeiling(await agencyAbandonmentRepository.window24h());
  }

  it('a 5% ceiling set over PATCH holds at 4% (which pauses a default campaign) and pauses over 5%', async () => {
    const raised = await campaignAt('running');
    // The control runs on a second account of the same tenant. Forced while one account could
    // run one campaign (`uq_agency_campaign_running`, dropped by migration 0015); kept as is.
    const other = await insertAccount({ tenant_id: w.tenant });
    const atDefault = (await insertAgencyCampaign({ tenant_id: w.tenant, account_id: other.id, status: 'running' })).id as string;
    const res = await patch(raised, { abandonment_ceiling_pct: 5 });
    expect(res.statusCode, res.body).toBe(200);

    // 2 of 50 = 4% on both. Two abandons, so the single-abandon small-sample rule
    // (refusal 4) does not apply: this is a plain rate-versus-ceiling decision.
    await seedWindow(raised, w.account, 50, 2);
    await seedWindow(atDefault, other.id, 50, 2);

    const first = await refresh();
    expect(first).toEqual([
      { tenant_id: w.tenant, campaign_id: atDefault, measured_pct: 4, ceiling_pct: 3 },
    ]);
    expect(await statusOf(atDefault)).toEqual({ status: 'paused', pause_reason: 'abandonment_ceiling', pause_abandonment_rate_pct: 4 });
    expect(await statusOf(raised)).toEqual({ status: 'running', pause_reason: null, pause_abandonment_rate_pct: null });

    // One more of the 50 abandoned: 3 of 50 = 6%, over the 5% it was given.
    await getTestPool().query(
      `UPDATE agency_call_attempts SET bridged_at = NULL
        WHERE id = (SELECT id FROM agency_call_attempts
                     WHERE campaign_id = $1 AND bridged_at IS NOT NULL LIMIT 1)`,
      [raised],
    );
    const second = await refresh();
    expect(second).toEqual([
      { tenant_id: w.tenant, campaign_id: raised, measured_pct: 6, ceiling_pct: 5 },
    ]);
    expect(await statusOf(raised)).toEqual({ status: 'paused', pause_reason: 'abandonment_ceiling', pause_abandonment_rate_pct: 6 });
  });
});
