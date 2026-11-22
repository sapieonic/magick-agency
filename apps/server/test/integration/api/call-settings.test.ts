import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Every call must belong to a campaign" (docs/call-log.md §5, rulings CL2–CL6, CL17–CL23) through
 * the whole stack: the session and tenant context, RBAC, the public routes, `callCore`, the
 * internal handlers, the runtime's `inboundCalls` and the repositories on real Postgres. The soft
 * phone's dial (`placeCall`) is in `softphone-routes.test.ts`, which has a station to dial from.
 *
 * What it pins:
 *  1. the settings routes: the floor (`agency.calls.manage`), the defaults, what stands in the way
 *     (routes with no campaign for unknown callers, agents on no running campaign, the calls not
 *     filed lately), the audit row, and that the switch is REFUSED (422, naming the routes) while a
 *     live route has no default;
 *  2. an inbound route's default campaign: one of the account's that is not archived, and
 *     REQUIRED on a create and on a change while the setting is on (`default_campaign_required`);
 *  3. arrival: an unknown caller is filed under the route's campaign (`route`), a matched one
 *     under their own (`contact`), setting or no setting;
 *  4. the outcome of an inbound call: REFUSED `campaign_required` while the call is under no
 *     campaign and the setting applies to it; `campaign_id` files an unknown caller's call
 *     (`agent`, or `supervisor` on behalf) under a campaign the actor may log to and no other; a
 *     matched caller's campaign is fixed; a call that arrived before the switch finishes as it is;
 *  5. "Change" at wrap-up: the campaigns offered, the new campaign's outcomes (without those that
 *     ask for a promise), the audit row;
 *  6. Do Not Call from a call that is only FILED under a campaign is written for the account.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'call-settings-routes-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  CATALOG, drainAudits, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { getPacingInvalidationBus } from '../../../src/agency/pacing/invalidation-bus.js';
import { agencyCallSettingsRepository, agencyInboundCallRepository } from '../../../src/db/repositories/agency.repository.js';
import { insertAgencyContact } from '../agency/agency-factories.js';

const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
let credential: string;
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;
/** The floor's campaigns: `staffed` (running, agent 0 is on it), `unstaffed` (running), `paused`, `draft`. */
let staffed: string;
let unstaffed: string;
let paused: string;
let draft: string;

function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, actor: Actor, body?: unknown, on: TenantFloor = floor) {
  return loaded.app.inject({
    method,
    url: `/proxy/agency${url}`,
    headers: headersFor(actor, on, body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function audits(action: string) {
  await drainAudits();
  const { rows } = await q(
    `SELECT user_id, campaign_id, resource_id, details FROM platform_audit_log WHERE action = $1 AND tenant_id = $2 ORDER BY created_at`,
    [action, floor.tenant]);
  return rows as Array<{ user_id: string; campaign_id: string | null; resource_id: string | null; details: Record<string, unknown> }>;
}

/** The switch, straight on the table (the routes are what the tests of the switch itself use). */
async function setRule(on: boolean): Promise<void> {
  await agencyCallSettingsRepository.setRequireCampaign(
    { tenantId: floor.tenant, accountId: floor.account, on, userId: sup().id }, async () => null);
}

async function createRoute(name: string, extra: Record<string, unknown> = {}) {
  return request('POST', '/inbound/routes', sup(), { name, timezone: 'Asia/Kolkata', ...extra });
}

let phoneSeq = 0;
/**
 * A call `taker` took on a session of theirs: ended and owing its outcome (or `connected`).
 * `match`: the caller is on `staffed`'s list. `routeDefault`: the route's campaign for unknown
 * callers, as the router passes it at arrival.
 */
async function takenCall(taker: Actor, opts: { state?: 'ended' | 'connected'; match?: boolean; routeDefault?: string | null } = {}) {
  const phone = `+4477119${String(40_000 + ++phoneSeq)}`;
  const contactId = opts.match ? (await insertAgencyContact(staffed, {
    tenant_id: floor.tenant, account_id: floor.account, phone_e164: phone, source_row_number: phoneSeq, state: 'exhausted', attempt_count: 3,
  })).id as string : null;
  const session = (await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, left_at)
     VALUES ($1, $2, $3, $4, 'wrapup', now()) RETURNING id`, [floor.tenant, floor.account, staffed, taker.id])).rows[0]!.id as string;
  const { call: row } = await agencyInboundCallRepository.insertArrival({
    tenantId: floor.tenant, accountId: floor.account, routeId: null, phoneNumberId: null, provider: 'plivo',
    telephonyCredentialId: credential, providerCallId: `CA-${randomUUID()}`, fromE164: phone, toE164: '+14155550100',
    identification: { match: contactId ? { contactId, campaignId: staffed } : null, callerDnc: false, sticky: null },
    answered: true, recordingRequested: false, analysisProfileId: null,
    routeDefaultCampaignId: opts.routeDefault ?? null,
  });
  await agencyInboundCallRepository.transition(row!.id, 'queued');
  await agencyInboundCallRepository.offer(row!.id, session);
  await agencyInboundCallRepository.connect(row!.id, { sessionId: session, answeredByUserId: taker.id });
  if (opts.state !== 'connected') {
    await agencyInboundCallRepository.end(row!.id, { outcome: 'answered', talkSeconds: 40, followUp: null, callbackDueAt: null, voicemailKey: null });
  }
  return { id: row!.id, contactId, phone };
}

const filing = async (id: string) => (await q(
  'SELECT campaign_id, campaign_source, matched_campaign_id, disposition_code, disposition_source, settled_at FROM agency_inbound_calls WHERE id = $1', [id])).rows[0]!;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = (await seedFloor({ tenants: 2, agentsPerTenant: 3, supervisorsPerTenant: 1, campaignsPerTenant: 4 })) as [TenantFloor, TenantFloor];
  [staffed, unstaffed, paused, draft] = floor.campaigns as [string, string, string, string];
  await q(`UPDATE agency_campaigns SET status = 'running', name = 'Staffed' WHERE id = $1`, [staffed]);
  await q(`UPDATE agency_campaigns SET status = 'running', name = 'General enquiries' WHERE id = $1`, [unstaffed]);
  await q(`UPDATE agency_campaigns SET status = 'paused', name = 'Paused' WHERE id = $1`, [paused]);
  await q(`UPDATE agency_campaigns SET name = 'Draft' WHERE id = $1`, [draft]);
  await q(`INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
    [floor.tenant, floor.account, staffed, agent(0).id]);
  // Agent 1 is on a campaign too, but one nobody can log a call to (a draft).
  await q(`INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
    [floor.tenant, floor.account, draft, agent(1).id]);
  await q(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo') ON CONFLICT DO NOTHING`);
  credential = (await q(`INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MA00000000000000CSET') RETURNING id`,
    [floor.tenant])).rows[0]!.id as string;
  for (const f of [floor, other]) {
    await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value) VALUES ('agency_inbound_enabled', 'tenant', $1, NULL, 'true'::jsonb)`, [f.tenant]);
    await getFeatureFlagService().invalidate({ tenantId: f.tenant });
  }
});

beforeEach(async () => {
  await q('DELETE FROM agency_call_settings');
  await q('DELETE FROM agency_inbound_routes');
  // Each test counts its own switch's audit rows.
  await drainAudits();
  await q(`DELETE FROM platform_audit_log WHERE action = 'agency_call_settings.updated'`);
});

afterAll(async () => {
  await truncateAll();
  await stopLoadApp(loaded);
});

describe('Settings › Calls: the setting and what stands in its way', () => {
  it('is an account admin`s: an agent is refused the read and the write; off by default', async () => {
    // The refusal names the permission each route asks for: its own, not `agency.supervise`
    // (the two share a floor today, so only the name tells them apart).
    const read403 = await request('GET', '/call-settings', agent(0));
    expect(read403.statusCode).toBe(403);
    expect(read403.json().message).toBe('Insufficient permissions. Required: agency.calls.manage');
    const write403 = await request('PUT', '/call-settings', agent(0), { require_campaign: true });
    expect(write403.statusCode).toBe(403);
    expect(write403.json().message).toBe('Insufficient permissions. Required: agency.calls.manage');
    expect(await agencyCallSettingsRepository.find(floor.tenant, floor.account)).toBeNull();

    const read = await request('GET', '/call-settings', sup());
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().settings).toEqual({ require_campaign: false, require_campaign_since: null, updated_at: null });
    expect(read.headers['cache-control']).toContain('no-store');
    expect((await request('PUT', '/call-settings', sup(), { require_campaign: 'yes' })).statusCode).toBe(400);
  });

  it('says who could not dial and how many calls were not filed; neither blocks the switch', async () => {
    // Soft-phone calls: one dialled with no campaign (counted), one that never dialled, one
    // logged to a campaign, one too old. Inbound: one served with no campaign (counted), one
    // turned away, one filed, one still live.
    const session = (await q(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, agent_user_id, kind, state, left_at)
       VALUES ($1, $2, $3, 'softphone', 'offline', now()) RETURNING id`, [floor.tenant, floor.account, agent(0).id])).rows[0]!.id as string;
    const manual = (campaign: string | null, dialled: boolean, age = '1 day') => q(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, destination_e164, caller_id,
              state, outcome, dialed_at, ended_at, settled_at, created_at, disposition_code, disposition_source)
       VALUES ($1, $2, $3, $4, $5, '+919811200001', '+919000000001', 'ended', 'no_answer',
               CASE WHEN $6::boolean THEN now() - $7::interval END, now() - $7::interval, now() - $7::interval, now() - $7::interval, NULL, NULL)`,
      [floor.tenant, floor.account, session, agent(0).id, campaign, dialled, age]);
    await manual(null, true);
    await manual(null, false);
    await manual(staffed, true);
    await manual(null, true, '31 days');
    const inbound = (state: string, outcome: string | null, campaign: string | null) => q(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider, provider_call_id, from_e164, to_e164, state, outcome,
              arrived_at, ended_at, settled_at, campaign_id, campaign_source)
       VALUES ($1, $2, 'plivo', $3, '+919811200002', '+14155550100', $4::varchar, $5, now() - interval '2 days',
               CASE WHEN $4::varchar = 'ended' THEN now() - interval '2 days' END, CASE WHEN $4::varchar = 'ended' THEN now() - interval '2 days' END,
               $6::uuid, CASE WHEN $6::uuid IS NOT NULL THEN 'route' END)`,
      [floor.tenant, floor.account, `CA-${randomUUID()}`, state, outcome, campaign]);
    await inbound('ended', 'closed', null);
    await inbound('ended', 'rejected', null);
    await inbound('ended', 'closed', unstaffed);
    await inbound('queued', null, null);

    const read = await request('GET', '/call-settings', sup());
    expect(read.statusCode, read.body).toBe(200);
    const { readiness } = read.json();
    expect(readiness.routes_missing_default).toEqual([]);
    expect(readiness.unfiled_calls).toBe(2);
    // Agent 0 is on a running campaign; agent 1 only on a draft; agent 2 on none. The supervisor
    // may log a call to any campaign, so is never listed.
    expect(readiness.agents_without_campaign_total).toBe(2);
    expect(readiness.agents_without_campaign.map((a: { user_id: string }) => a.user_id).sort()).toEqual([agent(1).id, agent(2).id].sort());
    expect(readiness.agents_without_campaign[0].name).toMatch(/^agent /);

    // Agents with nothing to log to do not block it (information only).
    const on = await request('PUT', '/call-settings', sup(), { require_campaign: true });
    expect(on.statusCode, on.body).toBe(200);
    await q('DELETE FROM agency_manual_calls WHERE tenant_id = $1', [floor.tenant]);
    await q('DELETE FROM agency_inbound_calls WHERE tenant_id = $1', [floor.tenant]);
  });

  it('refuses to switch on while a live inbound route has no campaign for unknown callers, naming it; then switches, audited once', async () => {
    const bare = await createRoute('Sales line');
    expect(bare.statusCode, bare.body).toBe(201);
    const ready = await createRoute('Support line', { default_campaign_id: unstaffed });
    expect(ready.statusCode, ready.body).toBe(201);
    const deleted = await createRoute('Old line');
    expect((await loaded.app.inject({
      method: 'DELETE', url: `/proxy/agency/inbound/routes/${deleted.json().route.id}`, headers: headersFor(sup(), floor),
    })).statusCode).toBeLessThan(300);

    expect((await request('GET', '/call-settings', sup())).json().readiness.routes_missing_default)
      .toEqual([{ route_id: bare.json().route.id, name: 'Sales line' }]);
    const refused = await request('PUT', '/call-settings', sup(), { require_campaign: true });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({
      code: 'default_campaign_required',
      routes: [{ route_id: bare.json().route.id, name: 'Sales line' }],
    });
    // Nothing was written: the setting is still off for every reader.
    expect((await agencyCallSettingsRepository.requireCampaign(floor.tenant, floor.account)).on).toBe(false);
    expect(await audits('agency_call_settings.updated')).toEqual([]);
    // Switching OFF is never refused, routes or no routes.
    expect((await request('PUT', '/call-settings', sup(), { require_campaign: false })).statusCode).toBe(200);

    const fixed = await request('PATCH', `/inbound/routes/${bare.json().route.id}`, sup(), { default_campaign_id: unstaffed });
    expect(fixed.statusCode, fixed.body).toBe(200);
    const on = await request('PUT', '/call-settings', sup(), { require_campaign: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().settings).toMatchObject({ require_campaign: true, require_campaign_since: expect.any(String) });
    expect(on.json().readiness.routes_missing_default).toEqual([]);

    // Saved again as it is: the same "since", and no second audit row.
    const again = await request('PUT', '/call-settings', sup(), { require_campaign: true });
    expect(again.json().settings.require_campaign_since).toBe(on.json().settings.require_campaign_since);
    const rows = await audits('agency_call_settings.updated');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: sup().id, details: { require_campaign: true } });

    const off = await request('PUT', '/call-settings', sup(), { require_campaign: false });
    expect(off.json().settings).toMatchObject({ require_campaign: false, require_campaign_since: null });
    // Another tenant's account never saw any of it.
    expect((await request('GET', '/call-settings', other.supervisors[0]!, undefined, other)).json().settings.require_campaign).toBe(false);
  });
});

describe('what counts as a route in the way (CL18)', () => {
  it('a route whose campaign was archived since counts as missing, and is not saved again until another is chosen', async () => {
    const route = await createRoute('Sales line', { default_campaign_id: draft });
    expect(route.statusCode, route.body).toBe(201);
    const id = route.json().route.id as string;
    expect((await request('GET', '/call-settings', sup())).json().readiness.routes_missing_default).toEqual([]);

    await q(`UPDATE agency_campaigns SET archived_at = now() WHERE id = $1`, [draft]);
    try {
      expect((await request('GET', '/call-settings', sup())).json().readiness.routes_missing_default)
        .toEqual([{ route_id: id, name: 'Sales line' }]);
      const refused = await request('PUT', '/call-settings', sup(), { require_campaign: true });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json()).toMatchObject({ code: 'default_campaign_required', routes: [{ route_id: id, name: 'Sales line' }] });

      // A save that leaves the campaign alone is refused too: the route would keep an archived one.
      const renamed = await request('PATCH', `/inbound/routes/${id}`, sup(), { name: 'Sales' });
      expect(renamed.statusCode, renamed.body).toBe(400);
      expect(renamed.json()).toMatchObject({
        code: 'inbound_route_invalid', details: [{ path: 'default_campaign_id', message: expect.stringMatching(/archived/) }],
      });
      expect((await request('PATCH', `/inbound/routes/${id}`, sup(), { name: 'Sales', default_campaign_id: unstaffed })).statusCode).toBe(200);
      expect((await request('PUT', '/call-settings', sup(), { require_campaign: true })).statusCode).toBe(200);
    } finally {
      await q(`UPDATE agency_campaigns SET archived_at = NULL WHERE id = $1`, [draft]);
    }
  });

  it('with inbound off for the account its routes do not count: the switch goes on; with inbound on they do', async () => {
    const bare = await createRoute('Leftover line');
    expect(bare.statusCode, bare.body).toBe(201);
    const inbound = async (on: boolean) => {
      await q(`UPDATE feature_flag_overrides SET value = $2::jsonb WHERE flag_key = 'agency_inbound_enabled' AND tenant_id = $1`, [floor.tenant, JSON.stringify(on)]);
      await getFeatureFlagService().invalidate({ tenantId: floor.tenant });
    };
    await inbound(false);
    try {
      // The route editor is closed, so the route could not be given a campaign.
      expect((await request('GET', '/inbound/routes', sup())).statusCode).toBe(403);
      expect((await request('GET', '/call-settings', sup())).json().readiness.routes_missing_default).toEqual([]);
      const on = await request('PUT', '/call-settings', sup(), { require_campaign: true });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json().settings.require_campaign).toBe(true);
    } finally {
      await inbound(true);
    }
    // Inbound back on, the setting still on: the page names the route, and it is saved only with a campaign.
    expect((await request('GET', '/call-settings', sup())).json().readiness.routes_missing_default)
      .toEqual([{ route_id: bare.json().route.id, name: 'Leftover line' }]);
    expect((await request('PATCH', `/inbound/routes/${bare.json().route.id}`, sup(), { name: 'Leftover' })).json())
      .toMatchObject({ code: 'default_campaign_required' });
    // And a call that arrives on it under no campaign is still refused its outcome.
    const c = await takenCall(agent(0));
    expect((await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'voicemail' })).json()).toMatchObject({ code: 'campaign_required' });

    // Switched off and on again with inbound on: refused, naming it.
    await setRule(false);
    const refused = await request('PUT', '/call-settings', sup(), { require_campaign: true });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().routes).toEqual([{ route_id: bare.json().route.id, name: 'Leftover line' }]);
  });
});

describe('the switch-on and a route save wait for each other (the account`s lock)', () => {
  const pending = async (p: Promise<unknown>, ms = 400) => {
    let done = false;
    void p.then(() => { done = true; }, () => { done = true; });
    await new Promise((r) => setTimeout(r, ms));
    return !done;
  };

  it('a route save waits for a switch-on that has not committed, and is refused once it has', async () => {
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await agencyCallSettingsRepository.lockAccount(holder, floor.tenant, floor.account);
      // The switch-on, as `setRequireCampaign` writes it, not committed yet.
      await holder.query(
        `INSERT INTO agency_call_settings (tenant_id, account_id, require_campaign, require_campaign_since, updated_by)
         VALUES ($1, $2, true, now(), $3)`, [floor.tenant, floor.account, sup().id]);

      const create = createRoute('Raced line');
      // Without the lock it would read the setting as off and be saved with no campaign.
      expect(await pending(create)).toBe(true);
      await holder.query('COMMIT');
      const res = await create;
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ code: 'default_campaign_required' });
      expect((await q(`SELECT count(*)::int AS n FROM agency_inbound_routes WHERE name = 'Raced line'`)).rows[0]!.n).toBe(0);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('a route change waits the same way', async () => {
    const kept = await createRoute('Kept line', { default_campaign_id: unstaffed });
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await agencyCallSettingsRepository.lockAccount(holder, floor.tenant, floor.account);
      await holder.query(
        `INSERT INTO agency_call_settings (tenant_id, account_id, require_campaign, require_campaign_since, updated_by)
         VALUES ($1, $2, true, now(), $3)`, [floor.tenant, floor.account, sup().id]);
      const patch = request('PATCH', `/inbound/routes/${kept.json().route.id}`, sup(), { default_campaign_id: null });
      expect(await pending(patch)).toBe(true);
      await holder.query('COMMIT');
      const res = await patch;
      expect(res.statusCode, res.body).toBe(422);
      expect((await q('SELECT default_campaign_id FROM agency_inbound_routes WHERE id = $1', [kept.json().route.id])).rows[0]!.default_campaign_id).toBe(unstaffed);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('a switch-on waits for a route save that has not committed, and is refused once it has, naming the route', async () => {
    const kept = await createRoute('Kept line', { default_campaign_id: unstaffed });
    const id = kept.json().route.id as string;
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await agencyCallSettingsRepository.lockAccount(holder, floor.tenant, floor.account);
      // A route save that takes the campaign off, not committed yet.
      await holder.query('UPDATE agency_inbound_routes SET default_campaign_id = NULL WHERE id = $1', [id]);

      const put = request('PUT', '/call-settings', sup(), { require_campaign: true });
      // Without the lock it would see the route with its campaign and switch on.
      expect(await pending(put)).toBe(true);
      await holder.query('COMMIT');
      const res = await put;
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ code: 'default_campaign_required', routes: [{ route_id: id, name: 'Kept line' }] });
      expect((await agencyCallSettingsRepository.requireCampaign(floor.tenant, floor.account)).on).toBe(false);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});

describe('an inbound route`s campaign for unknown callers', () => {
  it('is one of the account`s campaigns that is not archived, in any status', async () => {
    const foreign = await createRoute('Foreign', { default_campaign_id: other.campaigns[0] });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ code: 'inbound_route_invalid', details: [{ path: 'default_campaign_id' }] });
    expect((await createRoute('Unknown', { default_campaign_id: randomUUID() })).json()).toMatchObject({ code: 'inbound_route_invalid' });
    expect((await createRoute('Malformed', { default_campaign_id: 'general' })).json()).toMatchObject({ code: 'inbound_route_invalid' });

    await q(`UPDATE agency_campaigns SET archived_at = now() WHERE id = $1`, [draft]);
    try {
      const archived = await createRoute('Archived', { default_campaign_id: draft });
      expect(archived.json()).toMatchObject({ code: 'inbound_route_invalid', details: [{ path: 'default_campaign_id', message: expect.stringMatching(/archived/) }] });
    } finally {
      await q(`UPDATE agency_campaigns SET archived_at = NULL WHERE id = $1`, [draft]);
    }

    // A draft, a paused and a running campaign are all fine: a call is filed under it whatever it is doing.
    for (const [name, id] of [['A', draft], ['B', paused], ['C', unstaffed]] as const) {
      const made = await createRoute(name, { default_campaign_id: id });
      expect(made.statusCode, made.body).toBe(201);
      expect(made.json().route.default_campaign_id).toBe(id);
    }
    const none = await createRoute('D');
    expect(none.json().route.default_campaign_id).toBeNull();
    const list = await request('GET', '/inbound/routes', sup());
    expect(list.json().campaign_required).toBe(false);
    expect(list.json().routes.map((r: { default_campaign_id: string | null }) => r.default_campaign_id)).toEqual([draft, paused, unstaffed, null]);

    // The routes that file callers under a campaign, by name, for the stop / archive warning.
    const routes = await request('GET', `/campaigns/${unstaffed}/inbound-default-routes`, sup());
    expect(routes.statusCode, routes.body).toBe(200);
    expect(routes.json()).toEqual({ routes: [{ route_id: expect.any(String), name: 'C' }] });
    expect((await request('GET', `/campaigns/${staffed}/inbound-default-routes`, sup())).json()).toEqual({ routes: [] });
    expect((await request('GET', `/campaigns/${unstaffed}/inbound-default-routes`, agent(0))).statusCode).toBe(403);
    expect((await request('GET', `/campaigns/${other.campaigns[0]}/inbound-default-routes`, sup())).statusCode).toBe(404);
    expect((await request('GET', '/campaigns/not-an-id/inbound-default-routes', sup())).statusCode).toBe(404);
  });

  // CL8: a drained campaign held open as a route's default is parked in pacing until an event;
  // a route taking or dropping it is one, so it is looked at again on the next round.
  it('tells pacing when a route takes or drops a campaign as its default', async () => {
    const woken: string[] = [];
    const unsubscribe = getPacingInvalidationBus().subscribe((event) => {
      if (event.type === 'campaign_changed') woken.push(event.campaignId);
    });
    const take = () => woken.splice(0).sort();
    try {
      const made = await createRoute('Sales line', { default_campaign_id: unstaffed });
      const id = made.json().route.id as string;
      expect(take()).toEqual([unstaffed]);
      expect((await request('PATCH', `/inbound/routes/${id}`, sup(), { name: 'Sales' })).statusCode).toBe(200);
      expect(take()).toEqual([]);
      expect((await request('PATCH', `/inbound/routes/${id}`, sup(), { default_campaign_id: paused })).statusCode).toBe(200);
      expect(take()).toEqual([paused, unstaffed].sort());
      expect((await loaded.app.inject({ method: 'DELETE', url: `/proxy/agency/inbound/routes/${id}`, headers: headersFor(sup(), floor) })).statusCode).toBeLessThan(300);
      expect(take()).toEqual([paused]);
      expect((await createRoute('No default')).statusCode).toBe(201);
      expect(take()).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('is REQUIRED on a create and on a change while the setting is on, and not while it is off', async () => {
    const kept = await createRoute('Sales line', { default_campaign_id: unstaffed });
    expect(kept.statusCode, kept.body).toBe(201);
    await setRule(true);
    expect((await request('GET', '/inbound/routes', sup())).json().campaign_required).toBe(true);

    const bare = await createRoute('Support line');
    expect(bare.statusCode, bare.body).toBe(422);
    expect(bare.json()).toMatchObject({ code: 'default_campaign_required' });
    expect((await q(`SELECT count(*)::int AS n FROM agency_inbound_routes WHERE name = 'Support line'`)).rows[0]!.n).toBe(0);
    expect((await createRoute('Support line', { default_campaign_id: paused })).statusCode).toBe(201);

    // Taking the campaign off a route is refused; a change that leaves it alone is not.
    const cleared = await request('PATCH', `/inbound/routes/${kept.json().route.id}`, sup(), { default_campaign_id: null });
    expect(cleared.statusCode, cleared.body).toBe(422);
    expect(cleared.json()).toMatchObject({ code: 'default_campaign_required' });
    expect((await q('SELECT default_campaign_id FROM agency_inbound_routes WHERE id = $1', [kept.json().route.id])).rows[0]!.default_campaign_id).toBe(unstaffed);
    const renamed = await request('PATCH', `/inbound/routes/${kept.json().route.id}`, sup(), { name: 'Sales' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().route.default_campaign_id).toBe(unstaffed);
    expect((await request('PATCH', `/inbound/routes/${kept.json().route.id}`, sup(), { default_campaign_id: paused })).statusCode).toBe(200);

    await setRule(false);
    expect((await createRoute('No rule')).statusCode).toBe(201);
    expect((await request('PATCH', `/inbound/routes/${kept.json().route.id}`, sup(), { default_campaign_id: null })).statusCode).toBe(200);
  });
});

describe('arrival: the campaign a call is filed under', () => {
  it('an unknown caller under the route`s campaign, a matched one under their own, with the setting off', async () => {
    const unknown = await takenCall(agent(0), { routeDefault: unstaffed });
    expect(await filing(unknown.id)).toMatchObject({ campaign_id: unstaffed, campaign_source: 'route', matched_campaign_id: null });
    const matched = await takenCall(agent(0), { match: true, routeDefault: unstaffed });
    expect(await filing(matched.id)).toMatchObject({ campaign_id: staffed, campaign_source: 'contact', matched_campaign_id: staffed });
    const nowhere = await takenCall(agent(0));
    expect(await filing(nowhere.id)).toMatchObject({ campaign_id: null, campaign_source: null });

    // The panel: where it is filed, that an unknown caller's can be moved, and the campaign's own outcomes.
    const read = await request('GET', `/inbound/calls/${unknown.id}`, agent(0));
    expect(read.json().call).toMatchObject({
      campaign: { campaign_id: unstaffed, campaign_name: 'General enquiries', source: 'route' },
      campaign_changeable: true, campaign_required: false, catalog_source: 'campaign', match: null,
    });
    expect((await request('GET', `/inbound/calls/${matched.id}`, agent(0))).json().call).toMatchObject({
      campaign: { campaign_id: staffed, source: 'contact' }, campaign_changeable: false,
    });
    expect((await request('GET', `/inbound/calls/${nowhere.id}`, agent(0))).json().call).toMatchObject({
      campaign: null, campaign_changeable: true, catalog_source: 'builtin',
    });
  });
});

describe('the Missed list names the campaign a call is filed under', () => {
  it('an unknown caller`s missed call carries the route`s campaign, which Call back logs to; the match stays empty', async () => {
    const id = (await q(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider, provider_call_id, from_e164, to_e164, state, outcome,
              arrived_at, ended_at, settled_at, follow_up_status, follow_up_reason, campaign_id, campaign_source)
       VALUES ($1, $2, 'plivo', $3, '+447711990001', '+14155550100', 'ended', 'overflow', now(), now(), now(), 'open', 'overflow', $4, 'route')
       RETURNING id`, [floor.tenant, floor.account, `CA-${randomUUID()}`, unstaffed])).rows[0]!.id as string;
    try {
      const list = await request('GET', '/inbound/missed', sup());
      expect(list.statusCode, list.body).toBe(200);
      const row = list.json().rows.find((r: { id: string }) => r.id === id);
      expect(row).toMatchObject({
        campaign_id: unstaffed, campaign_name: 'General enquiries', matched_campaign_id: null, matched_campaign_name: null,
      });
    } finally {
      await q('DELETE FROM agency_inbound_calls WHERE id = $1', [id]);
    }
  });
});

describe('the outcome of an inbound call while every call must belong to a campaign', () => {
  it('is REFUSED campaign_required for a call under no campaign, and saved once the request names one', async () => {
    await setRule(true);
    const c = await takenCall(agent(0));
    expect((await request('GET', `/inbound/calls/${c.id}`, agent(0))).json().call).toMatchObject({ campaign: null, campaign_required: true });

    const refused = await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'interested' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'campaign_required',
      message: 'Choose a campaign before you save the outcome. Every call in this account must belong to a campaign.',
    });
    expect(await filing(c.id)).toMatchObject({ campaign_id: null, disposition_code: null, settled_at: null });

    // A supervisor is not exempt.
    expect((await request('POST', `/inbound/calls/${c.id}/disposition`, sup(), { code: 'interested' })).json()).toMatchObject({ code: 'campaign_required' });

    const saved = await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'interested', campaign_id: staffed });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().call).toMatchObject({
      disposition_code: 'interested', campaign: { campaign_id: staffed, campaign_name: 'Staffed', source: 'agent' }, campaign_changeable: false,
    });
    // Stored `route`: `campaign` says the caller was on the campaign's list, and they were not.
    expect(await filing(c.id)).toMatchObject({ campaign_id: staffed, campaign_source: 'agent', matched_campaign_id: null, disposition_source: 'route' });
    expect((await audits('agency_inbound_call.dispositioned')).at(-1)).toMatchObject({ resource_id: c.id, campaign_id: staffed });
    // The same save again is a replay, with or without the campaign.
    expect((await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'interested' })).statusCode).toBe(200);
  });

  it('files only under a campaign the actor may log to; a supervisor any running or paused one, as `supervisor`', async () => {
    await setRule(true);
    const c = await takenCall(agent(0));
    for (const id of [unstaffed, draft, other.campaigns[0]!, randomUUID()]) {
      const refused = await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'interested', campaign_id: id });
      expect(refused.statusCode, `${id}: ${refused.body}`).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'inbound_campaign_not_allowed' });
    }
    expect((await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'interested', campaign_id: 'general' })).statusCode).toBe(400);
    expect(await filing(c.id)).toMatchObject({ campaign_id: null, disposition_code: null });
    // A code that is not in the chosen campaign's catalog is refused, and the filing with it.
    const unknown = await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'nope', campaign_id: staffed });
    expect(unknown.json()).toMatchObject({ code: 'inbound_disposition_invalid', reason: 'unknown_code' });
    expect(await filing(c.id)).toMatchObject({ campaign_id: null });

    expect((await request('POST', `/inbound/calls/${c.id}/disposition`, sup(), { code: 'interested', campaign_id: draft })).json())
      .toMatchObject({ code: 'inbound_campaign_not_allowed' });
    const saved = await request('POST', `/inbound/calls/${c.id}/disposition`, sup(), { code: 'interested', campaign_id: unstaffed });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await filing(c.id)).toMatchObject({ campaign_id: unstaffed, campaign_source: 'supervisor', disposition_code: 'interested' });
  });

  it('a matched caller`s campaign is fixed; naming their own is accepted', async () => {
    await setRule(true);
    const c = await takenCall(agent(0), { match: true });
    const moved = await request('POST', `/inbound/calls/${c.id}/disposition`, sup(), { code: 'interested', campaign_id: unstaffed });
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json()).toMatchObject({ code: 'inbound_campaign_fixed' });
    expect((await request('POST', `/inbound/calls/${c.id}/campaign`, sup(), { campaign_id: unstaffed })).json()).toMatchObject({ code: 'inbound_campaign_fixed' });
    expect(await filing(c.id)).toMatchObject({ campaign_id: staffed, campaign_source: 'contact', disposition_code: null });
    const saved = await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'interested', campaign_id: staffed });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await filing(c.id)).toMatchObject({ campaign_id: staffed, campaign_source: 'contact', disposition_source: 'campaign' });
  });

  it('a call that arrived before the switch finishes as it is; one that arrives after does not', async () => {
    const before = await takenCall(agent(0));
    await new Promise((r) => setTimeout(r, 20));
    await setRule(true);
    expect((await request('GET', `/inbound/calls/${before.id}`, agent(0))).json().call.campaign_required).toBe(false);
    // Under no campaign, so against the built-in catalog (the call has no route either).
    const saved = await request('POST', `/inbound/calls/${before.id}/disposition`, agent(0), { code: 'voicemail' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await filing(before.id)).toMatchObject({ campaign_id: null, disposition_code: 'voicemail' });

    const after = await takenCall(agent(0));
    expect((await request('POST', `/inbound/calls/${after.id}/disposition`, agent(0), { code: 'voicemail' })).json()).toMatchObject({ code: 'campaign_required' });
    // With the setting off again, a call under no campaign is saved against the route's own catalog as before.
    await setRule(false);
    expect((await request('POST', `/inbound/calls/${after.id}/disposition`, agent(0), { code: 'voicemail' })).statusCode).toBe(200);
  });
});

describe('filing and the outcome save under each other (the repository`s guards)', () => {
  it('fileUnderCampaign never moves a matched caller`s call, nor one whose outcome is saved', async () => {
    const matched = await takenCall(agent(0), { match: true });
    expect(await agencyInboundCallRepository.fileUnderCampaign(
      { id: matched.id, tenantId: floor.tenant, campaignId: unstaffed, source: 'supervisor' })).toBeNull();
    expect(await filing(matched.id)).toMatchObject({ campaign_id: staffed, campaign_source: 'contact' });

    const settled = await takenCall(agent(0), { routeDefault: staffed });
    expect((await request('POST', `/inbound/calls/${settled.id}/disposition`, agent(0), { code: 'interested' })).statusCode).toBe(200);
    expect(await agencyInboundCallRepository.fileUnderCampaign(
      { id: settled.id, tenantId: floor.tenant, campaignId: unstaffed, source: 'supervisor' })).toBeNull();
    expect(await filing(settled.id)).toMatchObject({ campaign_id: staffed, campaign_source: 'route', disposition_code: 'interested' });

    // Another tenant's id names no call; an open unknown caller's call is filed.
    const open = await takenCall(agent(0), { routeDefault: staffed });
    expect(await agencyInboundCallRepository.fileUnderCampaign(
      { id: open.id, tenantId: other.tenant, campaignId: unstaffed, source: 'supervisor' })).toBeNull();
    expect(await agencyInboundCallRepository.fileUnderCampaign(
      { id: open.id, tenantId: floor.tenant, campaignId: unstaffed, source: 'supervisor' })).toMatchObject({ campaign_id: unstaffed, campaign_source: 'supervisor' });
  });

  it('saveDisposition refuses `campaign_changed` when the call is no longer under the campaign the code was judged against', async () => {
    const c = await takenCall(agent(0), { routeDefault: staffed });
    const save = (expectedCampaignId: string | null | undefined) => agencyInboundCallRepository.saveDisposition({
      id: c.id, code: 'interested', source: 'route', notes: null, callbackAt: null, actorUserId: agent(0).id, onBehalf: false,
      ...(expectedCampaignId !== undefined ? { expectedCampaignId } : {}),
    });
    expect(await save(unstaffed)).toMatchObject({ ok: false, reason: 'campaign_changed' });
    expect(await save(null)).toMatchObject({ ok: false, reason: 'campaign_changed' });
    expect(await filing(c.id)).toMatchObject({ disposition_code: null, settled_at: null });
    expect(await save(staffed)).toMatchObject({ ok: true, replay: false });
  });

  // A supervisor's Change lands between the agent's Save reading the call and writing it.
  const refileUnderTheSave = (callId: string, to: string) => {
    const real = agencyInboundCallRepository.saveDisposition.bind(agencyInboundCallRepository);
    return vi.spyOn(agencyInboundCallRepository, 'saveDisposition').mockImplementationOnce(async (input, deps) => {
      const moved = await agencyInboundCallRepository.fileUnderCampaign({ id: callId, tenantId: floor.tenant, campaignId: to, source: 'supervisor' });
      expect(moved).not.toBeNull();
      return real(input, deps);
    });
  };

  it('a code of the old campaign`s catalog is not kept on a call refiled under the save: refused with the new campaign`s codes', async () => {
    await q(`UPDATE agency_campaigns SET disposition_catalog = $2::jsonb WHERE id = $1`, [paused, JSON.stringify([
      { code: 'query', label: 'Query', terminal: true },
    ])]);
    const c = await takenCall(agent(0), { routeDefault: staffed });
    const spy = refileUnderTheSave(c.id, paused);
    try {
      const res = await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'interested' });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ code: 'inbound_disposition_invalid', reason: 'unknown_code', allowed_codes: ['query'] });
      expect(await filing(c.id)).toMatchObject({ campaign_id: paused, campaign_source: 'supervisor', disposition_code: null, settled_at: null });
      // The new campaign's own code is then saved.
      expect((await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'query' })).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
      await q(`UPDATE agency_campaigns SET disposition_catalog = $2::jsonb WHERE id = $1`, [paused, JSON.stringify(CATALOG)]);
    }
  });

  it('a code both campaigns have is saved under the campaign the call is under now', async () => {
    const c = await takenCall(agent(0), { routeDefault: staffed });
    const spy = refileUnderTheSave(c.id, unstaffed);
    try {
      const res = await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'interested' });
      expect(res.statusCode, res.body).toBe(200);
      expect(await filing(c.id)).toMatchObject({ campaign_id: unstaffed, campaign_source: 'supervisor', disposition_code: 'interested' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('"Change" at wrap-up: filing an unknown caller`s call under another campaign', () => {
  it('offers the campaigns the actor may log to, reloads the outcomes, and is audited', async () => {
    await q(`UPDATE agency_campaigns SET disposition_catalog = $2::jsonb WHERE id = $1`, [paused, JSON.stringify([
      { code: 'query', label: 'Query', terminal: true },
      { code: 'will_pay', label: 'Will pay', requires_promise: true },
    ])]);
    await q(`INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
      [floor.tenant, floor.account, paused, agent(0).id]);
    try {
      await setRule(true);
      const c = await takenCall(agent(0), { routeDefault: staffed });

      // An agent's own staffed campaigns that can be logged to; a supervisor every such campaign.
      const mine = await request('GET', `/inbound/calls/${c.id}/campaigns`, agent(0));
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.json().campaigns.map((x: { campaign_id: string }) => x.campaign_id).sort()).toEqual([staffed, paused].sort());
      expect((await request('GET', `/inbound/calls/${c.id}/campaigns`, sup())).json().campaigns.map((x: { campaign_name: string }) => x.campaign_name).sort())
        .toEqual(['General enquiries', 'Paused', 'Staffed']);
      // Not another agent's call.
      expect((await request('GET', `/inbound/calls/${c.id}/campaigns`, agent(1))).statusCode).toBe(404);
      expect((await request('POST', `/inbound/calls/${c.id}/campaign`, agent(1), { campaign_id: staffed })).statusCode).toBe(404);

      const changed = await request('POST', `/inbound/calls/${c.id}/campaign`, agent(0), { campaign_id: paused });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().call).toMatchObject({
        campaign: { campaign_id: paused, campaign_name: 'Paused', source: 'agent' }, campaign_changeable: true, catalog_source: 'campaign',
      });
      // The new campaign's outcomes, without the one that asks for a promise (no contact to keep it on).
      expect(changed.json().call.disposition_catalog.map((d: { code: string }) => d.code)).toEqual(['query']);
      expect(await filing(c.id)).toMatchObject({ campaign_id: paused, campaign_source: 'agent', settled_at: null });
      const audit = (await audits('agency_inbound_call.campaign_changed')).filter((r) => r.resource_id === c.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ user_id: agent(0).id, campaign_id: paused, details: { from_campaign_id: staffed } });

      // The same campaign again changes nothing and is not audited.
      expect((await request('POST', `/inbound/calls/${c.id}/campaign`, agent(0), { campaign_id: paused })).statusCode).toBe(200);
      expect((await audits('agency_inbound_call.campaign_changed')).filter((r) => r.resource_id === c.id)).toHaveLength(1);
      // One the agent is not on is refused; the old campaign's outcomes no longer save; the promise outcome never does.
      expect((await request('POST', `/inbound/calls/${c.id}/campaign`, agent(0), { campaign_id: unstaffed })).json()).toMatchObject({ code: 'inbound_campaign_not_allowed' });
      for (const code of ['interested', 'will_pay']) {
        expect((await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code })).json(), code)
          .toMatchObject({ code: 'inbound_disposition_invalid', reason: 'unknown_code', allowed_codes: ['query'] });
      }
      expect((await request('POST', `/inbound/calls/${c.id}/disposition`, agent(0), { code: 'query' })).statusCode).toBe(200);
      // Once saved, it stays where it is.
      expect((await request('POST', `/inbound/calls/${c.id}/campaign`, sup(), { campaign_id: staffed })).json()).toMatchObject({ code: 'inbound_outcome_already_saved' });
      expect(await filing(c.id)).toMatchObject({ campaign_id: paused });

      // A call still on the line is not at wrap-up.
      const live = await takenCall(agent(0), { state: 'connected', routeDefault: staffed });
      expect((await request('POST', `/inbound/calls/${live.id}/campaign`, agent(0), { campaign_id: paused })).json()).toMatchObject({ code: 'inbound_call_not_dispositionable' });
      expect((await request('POST', `/inbound/calls/${live.id}/campaign`, agent(0), {})).statusCode).toBe(400);
    } finally {
      await q(`UPDATE agency_campaigns SET disposition_catalog = $2::jsonb WHERE id = $1`, [paused, JSON.stringify(CATALOG)]);
      await q(`DELETE FROM agency_campaign_agents WHERE campaign_id = $1 AND user_id = $2`, [paused, agent(0).id]);
    }
  });
});

describe('Do Not Call from a call that is only filed under a campaign (CL6)', () => {
  it('a suppress outcome and Mark DNC write the entry for the ACCOUNT, by route, by agent and by supervisor', async () => {
    await setRule(true);
    const dnc = async (phone: string) => (await q('SELECT campaign_id, account_id FROM dnc_entries WHERE phone_e164 = $1', [phone])).rows;

    // Filed by the route.
    const routed = await takenCall(agent(0), { routeDefault: staffed });
    const saved = await request('POST', `/inbound/calls/${routed.id}/disposition`, agent(0), { code: 'do_not_call' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await dnc(routed.phone)).toEqual([{ campaign_id: null, account_id: floor.account }]);
    await drainAudits();
    const created = await q(`SELECT details FROM platform_audit_log WHERE action = 'dnc_entry.created' AND details->>'inbound_call_id' = $1`, [routed.id]);
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]!.details).toMatchObject({ scope: 'account' });

    // Filed by the agent, with the outcome.
    const chosen = await takenCall(agent(0));
    expect((await request('POST', `/inbound/calls/${chosen.id}/disposition`, agent(0), { code: 'do_not_call', campaign_id: staffed })).statusCode).toBe(200);
    expect(await dnc(chosen.phone)).toEqual([{ campaign_id: null, account_id: floor.account }]);

    // Filed by a supervisor, then marked with the button.
    const marked = await takenCall(agent(0));
    expect((await request('POST', `/inbound/calls/${marked.id}/campaign`, sup(), { campaign_id: unstaffed })).statusCode).toBe(200);
    const mark = await request('POST', `/inbound/calls/${marked.id}/dnc`, agent(0), {});
    expect(mark.statusCode, mark.body).toBe(200);
    expect(mark.json()).toMatchObject({ scope: 'account', dnc_recorded: true });
    expect(await dnc(marked.phone)).toEqual([{ campaign_id: null, account_id: floor.account }]);

    // A caller on the campaign's own list still stops that campaign alone.
    const matched = await takenCall(agent(0), { match: true });
    expect((await request('POST', `/inbound/calls/${matched.id}/disposition`, agent(0), { code: 'do_not_call' })).statusCode).toBe(200);
    expect(await dnc(matched.phone)).toEqual([{ campaign_id: staffed, account_id: null }]);
  });
});
