import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The answered inbound call's public routes (docs/inbound.md §6, P2) through the whole stack: the
 * session and tenant context, RBAC (`agency.inbound.read`; `agency.supervise` on behalf and for the
 * queue tiles), the public routes, `callCore`, the internal handlers, the runtime's
 * `inboundCalls` and the repositories on real Postgres:
 *
 *  1. the agent who took a call reads it, saves its notes and its outcome; another agent cannot
 *     see it (`inbound_call_not_found`), a supervisor acts on behalf; a malformed id is the 404;
 *  2. the outcome against the matched campaign's catalog: an unknown code is
 *     `inbound_disposition_invalid` with the allowed codes, a callback without a time
 *     `datetime_required`; a live call `inbound_call_not_dispositionable`; the same code again a
 *     replay, another code `inbound_outcome_already_saved`; the contact settled forward only;
 *  3. Mark DNC at the matched campaign's scope; a suppress outcome lists the number too;
 *  4. NOT behind `agency_inbound_enabled` (the finish routes), while the queue tiles are;
 *  5. the audit rows: `agency_inbound_call.dispositioned` / `.dnc_marked` / `.hung_up` (only when
 *     this request hung it up), `dnc_entry.created`, with `on_behalf` and the campaign, no notes.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'inbound-calls-routes-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  drainAudits, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { agencyInboundCallRepository } from '../../../src/db/repositories/agency.repository.js';
import { insertAgencyContact } from '../agency/agency-factories.js';

const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

let loaded: LoadApp;
let floor: TenantFloor;
let credential: string;
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;

function call(method: 'GET' | 'POST' | 'PATCH', url: string, actor: Actor, body?: unknown) {
  return loaded.app.inject({
    method,
    url: `/proxy/agency/inbound${url}`,
    headers: headersFor(actor, floor, body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function setFlag(on: boolean): Promise<void> {
  await q(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_inbound_enabled' AND tenant_id = $1`, [floor.tenant]);
  await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value) VALUES ('agency_inbound_enabled', 'tenant', $1, NULL, $2::jsonb)`,
    [floor.tenant, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: floor.tenant });
}

async function audits(action: string, resourceId: string) {
  await drainAudits();
  const { rows } = await q(`SELECT user_id, campaign_id, details FROM platform_audit_log WHERE action = $1 AND resource_id = $2`, [action, resourceId]);
  return rows as Array<{ user_id: string; campaign_id: string | null; details: Record<string, unknown> }>;
}

let phoneSeq = 0;
/**
 * A call `taker` took on a session of theirs: `ended` (answered, outcome owed) or `connected`.
 * Matched to the floor's campaign and a roster contact unless `matched` is false.
 */
async function takenCall(taker: Actor, opts: { state?: 'ended' | 'connected'; matched?: boolean } = {}) {
  const phone = `+4477009${String(30_000 + ++phoneSeq)}`;
  const campaignId = floor.campaigns[0]!;
  const contactId = opts.matched === false ? null : (await insertAgencyContact(campaignId, {
    tenant_id: floor.tenant, account_id: floor.account, phone_e164: phone, source_row_number: phoneSeq, state: 'exhausted', attempt_count: 3,
  })).id as string;
  const session = (await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, left_at)
     VALUES ($1, $2, $3, $4, 'wrapup', now()) RETURNING id`, [floor.tenant, floor.account, campaignId, taker.id])).rows[0]!.id as string;
  const { call: row } = await agencyInboundCallRepository.insertArrival({
    tenantId: floor.tenant, accountId: floor.account, routeId: null, phoneNumberId: null, provider: 'plivo',
    telephonyCredentialId: credential, providerCallId: `CA-${randomUUID()}`, fromE164: phone, toE164: '+14155550100',
    identification: { match: contactId ? { contactId, campaignId } : null, callerDnc: false, sticky: null },
    answered: true, recordingRequested: false, analysisProfileId: null,
  });
  await agencyInboundCallRepository.transition(row!.id, 'queued');
  await agencyInboundCallRepository.offer(row!.id, session);
  await agencyInboundCallRepository.connect(row!.id, { sessionId: session, answeredByUserId: taker.id });
  if (opts.state !== 'connected') {
    await agencyInboundCallRepository.end(row!.id, { outcome: 'answered', talkSeconds: 40, followUp: null, callbackDueAt: null, voicemailKey: null });
  }
  return { id: row!.id, contactId, phone, session, campaignId };
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor] = (await seedFloor({ tenants: 1, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 1 })) as [TenantFloor];
  await q(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo') ON CONFLICT DO NOTHING`);
  credential = (await q(`INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MA00000000000000IBCR') RETURNING id`,
    [floor.tenant])).rows[0]!.id as string;
  await setFlag(true);
});

afterAll(async () => {
  await truncateAll();
  await stopLoadApp(loaded);
});

describe('the answered inbound call`s routes', () => {
  it('the agent who took it reads it and saves notes; another agent cannot see it; a supervisor can; a malformed id is the 404', async () => {
    const c = await takenCall(agent(0));
    const read = await call('GET', `/calls/${c.id}`, agent(0));
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().call).toMatchObject({
      id: c.id, session_id: c.session, state: 'ended', outcome: 'answered', catalog_source: 'campaign',
      match: { contact_id: c.contactId, campaign_id: c.campaignId, contact_state: 'exhausted' },
    });
    expect(read.json().call.outcome_due_at).not.toBeNull();
    expect((await call('GET', `/calls/${c.id}`, agent(1))).json()).toMatchObject({ code: 'inbound_call_not_found' });
    expect((await call('GET', `/calls/${c.id}`, agent(1))).statusCode).toBe(404);
    expect((await call('GET', `/calls/${c.id}`, sup())).statusCode).toBe(200);
    expect((await call('GET', '/calls/not-a-uuid', agent(0))).json()).toMatchObject({ code: 'inbound_call_not_found' });

    const notes = await call('PATCH', `/calls/${c.id}`, agent(0), { notes: 'asked about the bill' });
    expect(notes.statusCode).toBe(200);
    expect(notes.json().call.notes).toBe('asked about the bill');
    expect((await call('PATCH', `/calls/${c.id}`, agent(0), { notes: '' })).json().call.notes).toBeNull();
  });

  it('the outcome: validated against the matched campaign`s catalog, a replay, then refused; the contact settled forward only; audited', async () => {
    const live = await takenCall(agent(0), { state: 'connected' });
    expect((await call('POST', `/calls/${live.id}/disposition`, agent(0), { code: 'interested' })).json()).toMatchObject({ code: 'inbound_call_not_dispositionable' });

    const c = await takenCall(agent(0));
    const unknown = await call('POST', `/calls/${c.id}/disposition`, agent(0), { code: 'nope' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: 'inbound_disposition_invalid', reason: 'unknown_code', allowed_codes: expect.arrayContaining(['interested', 'callback']) });
    expect((await call('POST', `/calls/${c.id}/disposition`, agent(0), { code: 'callback' })).json()).toMatchObject({ code: 'inbound_disposition_invalid', reason: 'datetime_required' });

    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const saved = await call('POST', `/calls/${c.id}/disposition`, agent(0), { code: 'callback', callback_at: at, notes: 'secret note' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ call: { disposition_code: 'callback', settled_at: expect.any(String) }, contact_state: 'pending', callback_requested_at: at });
    // An exhausted contact reopened by the callback (IQ9), never charged.
    const { rows } = await q('SELECT state, attempt_count FROM agency_contacts WHERE id = $1', [c.contactId]);
    expect(rows[0]).toMatchObject({ state: 'pending', attempt_count: 3 });
    // The same code again: a replay; another code: refused.
    expect((await call('POST', `/calls/${c.id}/disposition`, agent(0), { code: 'callback', callback_at: at })).statusCode).toBe(200);
    expect((await call('POST', `/calls/${c.id}/disposition`, agent(0), { code: 'interested' })).json()).toMatchObject({ code: 'inbound_outcome_already_saved' });
    expect((await call('PATCH', `/calls/${c.id}`, agent(0), { notes: 'late' })).json()).toMatchObject({ code: 'inbound_outcome_already_saved' });

    const rowsAudit = await audits('agency_inbound_call.dispositioned', c.id);
    expect(rowsAudit).toHaveLength(2);
    expect(rowsAudit.map((r) => r.details)).toEqual(expect.arrayContaining([{ disposition_code: 'callback' }, { disposition_code: 'callback', replay: true }]));
    expect(rowsAudit[0]).toMatchObject({ user_id: agent(0).id, campaign_id: c.campaignId });
    expect(JSON.stringify(rowsAudit)).not.toContain('secret note');
  });

  it('a supervisor saves it on behalf; a suppress outcome lists the number at the campaign`s scope (dnc_entry.created)', async () => {
    const c = await takenCall(agent(0));
    const saved = await call('POST', `/calls/${c.id}/disposition`, sup(), { code: 'do_not_call' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ call: { dispositioned_on_behalf: true, dispositioned_by_user_id: sup().id }, contact_state: 'suppressed' });
    const { rows } = await q('SELECT campaign_id, account_id FROM dnc_entries WHERE phone_e164 = $1', [c.phone]);
    expect(rows).toEqual([{ campaign_id: c.campaignId, account_id: null }]);
    expect((await audits('agency_inbound_call.dispositioned', c.id))[0]!.details).toEqual({ disposition_code: 'do_not_call', on_behalf: true });
    await drainAudits();
    const created = await q(`SELECT details FROM platform_audit_log WHERE action = 'dnc_entry.created' AND details->>'inbound_call_id' = $1`, [c.id]);
    expect(created.rows).toHaveLength(1);
  });

  it('Mark DNC: the matched campaign`s scope, else the account`s; audited', async () => {
    const c = await takenCall(agent(0), { matched: false });
    const marked = await call('POST', `/calls/${c.id}/dnc`, agent(0), {});
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json()).toMatchObject({ call_id: c.id, phone_e164: c.phone, scope: 'account', dnc_recorded: true, contact_state: null });
    const { rows } = await q('SELECT campaign_id, account_id FROM dnc_entries WHERE phone_e164 = $1', [c.phone]);
    expect(rows).toEqual([{ campaign_id: null, account_id: floor.account }]);
    expect((await audits('agency_inbound_call.dnc_marked', c.id))[0]!.details).toEqual({ scope: 'account', dnc_recorded: true });
  });

  it('hang-up of a call already ended: idempotent, not audited', async () => {
    const c = await takenCall(agent(0));
    const res = await call('POST', `/calls/${c.id}/hangup`, agent(0), {});
    expect(res.statusCode).toBe(200);
    expect(res.json().call).toMatchObject({ id: c.id, state: 'ended' });
    expect(await audits('agency_inbound_call.hung_up', c.id)).toEqual([]);
  });

  it('the finish routes are not behind agency_inbound_enabled; the queue tiles are, and are a supervisor`s', async () => {
    await setFlag(false);
    try {
      const c = await takenCall(agent(0));
      expect((await call('GET', `/calls/${c.id}`, agent(0))).statusCode).toBe(200);
      expect((await call('POST', `/calls/${c.id}/disposition`, agent(0), { code: 'interested' })).statusCode).toBe(200);
      expect((await call('GET', '/queue', sup())).json()).toMatchObject({ code: 'inbound_disabled' });
    } finally {
      await setFlag(true);
    }
    expect((await call('GET', '/queue', agent(0))).statusCode).toBe(403);
    const tiles = await call('GET', '/queue', sup());
    expect(tiles.statusCode, tiles.body).toBe(200);
    expect(tiles.json()).toEqual({ tiles: [] });
  });
});
