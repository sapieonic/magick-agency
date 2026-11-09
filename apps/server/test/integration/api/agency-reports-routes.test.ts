import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── The report routes' limits and lookups on real Postgres, through the real app ─────────────
 *
 * `buildApp` with the real session (Firebase stubbed), tenant context, RBAC, flag and the report
 * routes with their production dependencies (the campaign probe through the internal handler,
 * the membership reads, the repositories); S3's presign is stubbed. What the unit suite's fakes
 * cannot show:
 *
 *  1. the per-user rate holds under concurrent requests: it is counted inside the insert's
 *     transaction under the tenant's lock, so a burst cannot all read the same count;
 *  2. `X-Account-Id` in upper case (the tenant middleware keeps it as sent, and a tenant-wide member
 *     passes it; an upper-case `X-Tenant-Id` with an account it refuses itself): the campaign probe, a supervisor's review of an
 *     account-scoped agent, the campaign download and the campaign subscription all work;
 *  3. re-enabling a subscription resolves its subject as POST does (a deleted campaign is
 *     `report_subject_not_found`) and cuts `next_run_at` in the campaign's CURRENT zone, which it
 *     stores (RP3).
 *
 * Mutation-checked: counting the rate before `create`'s transaction (the old check-then-insert)
 * lets the burst past the limit; comparing the raw header ids in the campaign probe refuses every
 * upper-case campaign request; dropping the subject resolution from PATCH lets the deleted
 * campaign's subscription back on and keeps the stale zone.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'agency-reports-routes-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
vi.mock('../../../src/storage/s3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/storage/s3.js')>()),
  getPresignedUrl: async (key: string) => `https://bucket.example/${key}?X-Amz-Signature=test`,
}));

import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';

const USER_PER_MINUTE = 3;

let loaded: LoadApp;
let floor: TenantFloor;
const sup = () => floor.supervisors[0]!;
const agent = () => floor.agents[0]!;
/** Tenant-wide supervisors (no account on the membership): they pass the middleware with any case of `X-Account-Id`. */
let tenantWide: Actor[];

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const review = (subject: string) => ({
  kind: 'agent', subject_id: subject, from: daysAgo(6), to: daysAgo(1), timezone: 'UTC', formats: ['pdf'],
});
const campaignReport = (campaign: string) => ({
  kind: 'campaign', subject_id: campaign, from: daysAgo(6), to: daysAgo(1), formats: ['pdf'],
});

/** `call`, with `X-Account-Id` in upper case (and `X-Tenant-Id` too with `tenantToo`). */
function callUpper(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, actor: Actor, body?: unknown, tenantToo = false) {
  return loaded.app.inject({
    method,
    url,
    headers: headersFor(actor, floor, {
      ...(tenantToo ? { 'x-tenant-id': floor.tenant.toUpperCase() } : {}),
      'x-account-id': floor.account.toUpperCase(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }),
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function tenantWideSupervisor(n: number): Promise<Actor> {
  const id = randomUUID();
  const uid = `reports-tenant-wide-${n}-${id.slice(0, 8)}`;
  await getTestPool().query(
    `INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
    [id, uid, `${uid}@load.example.com`, `Tenant-wide ${n}`],
  );
  await getTestPool().query(
    `INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, NULL, 'tenant_admin', 'active')`,
    [randomUUID(), id, floor.tenant],
  );
  return { id, uid, tok: `tok:${uid}`, role: 'account_admin', ip: `10.9.9.${n + 1}` };
}

/** The local wall-clock time of `iso` in `zone`, `HH:MM`. */
const localTime = (iso: string, zone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp({
    configure: (c) => ({
      ...c,
      agency: { ...c.agency, reports: { ...c.agency.reports, userPerMinute: USER_PER_MINUTE, tenantPendingLimit: 100 } },
    }),
  });
  // The integration files share one database: start from no runs or subscriptions.
  await getTestPool().query('DELETE FROM report_runs');
  await getTestPool().query('DELETE FROM report_subscriptions');
  [floor] = await seedFloor({ tenants: 1, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 3 }) as [TenantFloor];
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_reports_enabled', 'tenant', $1, 'true'::jsonb)`,
    [floor.tenant],
  );
  tenantWide = [await tenantWideSupervisor(0), await tenantWideSupervisor(1), await tenantWideSupervisor(2)];
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

describe('the per-user rate under concurrent requests', () => {
  it(`two runs already this minute, then ten POST /reports at once with a limit of ${USER_PER_MINUTE}: exactly one more is queued`, async () => {
    for (let i = 0; i < 2; i++) {
      const res = await call(loaded.app, 'POST', '/proxy/agency/reports', sup(), floor, review(agent().id));
      expect(res.statusCode, res.body).toBe(202);
    }
    const burst = await Promise.all(Array.from({ length: 10 }, () =>
      call(loaded.app, 'POST', '/proxy/agency/reports', sup(), floor, review(agent().id))));
    const statuses = burst.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([202, ...Array.from({ length: 9 }, () => 429)]);
    for (const refused of burst.filter((r) => r.statusCode === 429)) {
      expect(refused.json()).toMatchObject({ code: 'report_rate_limited' });
    }
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM report_runs WHERE requested_by = $1 AND created_at > now() - interval '1 minute'`,
      [sup().id],
    );
    expect(rows[0]!.n).toBe(USER_PER_MINUTE);
  });
});

describe('the account header in upper case (a tenant-wide supervisor)', () => {
  it('the tenant header in upper case never reaches the routes with an account: the tenant middleware refuses it', async () => {
    const res = await callUpper('POST', '/proxy/agency/reports', tenantWide[0]!, campaignReport(floor.campaigns[0]!), true);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ message: 'X-Account-Id does not belong to this tenant' });
  });

  it('a campaign report is created, and its download answers; a review of an account-scoped agent is created', async () => {
    const actor = tenantWide[0]!;
    const created = await callUpper('POST', '/proxy/agency/reports', actor, campaignReport(floor.campaigns[0]!));
    expect(created.statusCode, created.body).toBe(202);
    expect(created.json()).toMatchObject({ kind: 'campaign', account_id: floor.account, subject: { id: floor.campaigns[0] } });
    const runId = created.json().id as string;

    const key = `reports/${floor.tenant}/${floor.account}/${runId}/report.pdf`;
    await getTestPool().query(
      `UPDATE report_runs SET status = 'ready', finished_at = now(), expires_at = now() + interval '1 day',
              files = $2::jsonb WHERE id = $1`,
      [runId, JSON.stringify([{ format: 'pdf', key, bytes: 10 }])],
    );
    const download = await callUpper('GET', `/proxy/agency/reports/${runId}/files/pdf`, actor);
    expect(download.statusCode, download.body).toBe(200);
    expect(download.json().url).toContain(key);

    // The agent's membership names the account in lower case; the header does not.
    const agentReview = await callUpper('POST', '/proxy/agency/reports', actor, review(agent().id));
    expect(agentReview.statusCode, agentReview.body).toBe(202);
    expect(agentReview.json()).toMatchObject({ kind: 'agent', audience: 'supervisor', account_id: floor.account });
  });

  it('a campaign subscription is created, re-enabled and run now', async () => {
    const actor = tenantWide[1]!;
    const created = await callUpper('POST', '/proxy/agency/report-subscriptions', actor, {
      kind: 'campaign', subject_id: floor.campaigns[0], cadence: 'daily', send_local_time: '08:00', formats: ['pdf'],
      recipient_user_ids: [actor.id], enabled: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const enabled = await callUpper('PATCH', `/proxy/agency/report-subscriptions/${id}`, actor, { enabled: true });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, next_run_at: expect.any(String) });
    const runNow = await callUpper('POST', `/proxy/agency/report-subscriptions/${id}/run-now`, actor);
    expect(runNow.statusCode, runNow.body).toBe(202);
    expect(runNow.json()).toMatchObject({ kind: 'campaign', account_id: floor.account, subscription_id: null });
  });
});

describe('re-enabling a subscription (PATCH { enabled: true })', () => {
  const create = async (actor: Actor, campaign: string) => {
    const res = await call(loaded.app, 'POST', '/proxy/agency/report-subscriptions', actor, floor, {
      kind: 'campaign', subject_id: campaign, cadence: 'daily', send_local_time: '09:00', formats: ['pdf'],
      recipient_user_ids: [actor.id],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; timezone: string };
  };
  /** What the tick does when it disables one: `enabled` off and no next send. */
  const disableAsTheTick = (id: string) =>
    getTestPool().query(`UPDATE report_subscriptions SET enabled = false, next_run_at = NULL WHERE id = $1`, [id]);

  it('whose campaign was deleted since the tick disabled it: 404 report_subject_not_found, still disabled', async () => {
    const actor = tenantWide[2]!;
    const sub = await create(actor, floor.campaigns[2]!);
    await disableAsTheTick(sub.id);
    await getTestPool().query('DELETE FROM agency_campaigns WHERE id = $1', [floor.campaigns[2]]);

    const res = await call(loaded.app, 'PATCH', `/proxy/agency/report-subscriptions/${sub.id}`, actor, floor, { enabled: true });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toMatchObject({ code: 'report_subject_not_found' });
    const { rows } = await getTestPool().query<{ enabled: boolean; next_run_at: Date | null }>(
      'SELECT enabled, next_run_at FROM report_subscriptions WHERE id = $1', [sub.id]);
    expect(rows[0]).toEqual({ enabled: false, next_run_at: null });
  });

  it('whose campaign moved from Asia/Kolkata to America/New_York: the next send is 09:00 New York, and the row stores New York', async () => {
    const actor = tenantWide[2]!;
    await getTestPool().query(`UPDATE agency_campaigns SET default_timezone = 'Asia/Kolkata' WHERE id = $1`, [floor.campaigns[1]]);
    const sub = await create(actor, floor.campaigns[1]!);
    expect(sub.timezone).toBe('Asia/Kolkata');
    await disableAsTheTick(sub.id);
    await getTestPool().query(`UPDATE agency_campaigns SET default_timezone = 'America/New_York' WHERE id = $1`, [floor.campaigns[1]]);

    const res = await call(loaded.app, 'PATCH', `/proxy/agency/report-subscriptions/${sub.id}`, actor, floor, { enabled: true });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { timezone: string; next_run_at: string; enabled: boolean };
    expect(body).toMatchObject({ enabled: true, timezone: 'America/New_York' });
    expect(localTime(body.next_run_at, 'America/New_York')).toBe('09:00');
    const next = new Date(body.next_run_at).getTime();
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThanOrEqual(Date.now() + 25 * 3_600_000);
    const { rows } = await getTestPool().query<{ timezone: string; enabled: boolean }>(
      'SELECT timezone, enabled FROM report_subscriptions WHERE id = $1', [sub.id]);
    expect(rows[0]).toEqual({ timezone: 'America/New_York', enabled: true });
  });
});
