import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * ─── The agent's own-contact actions, on the real app and real Postgres ──────────
 *
 * `POST /proxy/agency/my-contacts/retry` and `POST /proxy/agency/my-contacts/:contactId/call`
 * (contact assignment D7) through the session middleware (Firebase stubbed), tenant context,
 * RBAC (`agency.contacts.own`), the flag, the staffing check, `callCore` and the internal
 * handler. The dial itself, end to end with a carrier, is `agency/my-contact-call-e2e.test.ts`.
 *
 *  1. the flag off → 403 `assignment_disabled` on both;
 *  2. not staffed on the campaign → 403 `not_staffed` on both;
 *  3. retry with `allow_agent_retry` off → 403 `agent_retry_disabled`;
 *  4. retry reopens the caller's own not-reached contacts, ignores another agent's id, wakes
 *     nothing it should not, and writes one audit row;
 *  5. call: another agent's contact is the missing contact's 404; another agent's session is
 *     `agent_not_available`; a note out of bounds is `override_note_invalid`; a reached contact
 *     is `contact_not_retryable` with its block.
 *
 * Mutation-checked: dropping the owner predicate from the reopen reds 4; from
 * `evaluateForAgentDial` reds 5 (another agent's contact dials past the 404).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'my-contact-actions-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { randomUUID } from 'node:crypto';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, drainAudits, expectHealthy, scalar, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';

let loaded: LoadApp;
let floor: TenantFloor;
let dark: TenantFloor; // the flag is off here
const app = () => loaded.app;

const A = () => floor.agents[0]!;
const B = () => floor.agents[1]!;
const UNSTAFFED = () => floor.agents[2]!;
const CAMPAIGN = () => floor.campaigns[0]!;

async function contact(owner: Actor | null, o: Record<string, unknown> = {}, onFloor = floor): Promise<string> {
  const id = randomUUID();
  const cols = {
    id, campaign_id: onFloor.campaigns[0], tenant_id: onFloor.tenant, account_id: onFloor.account,
    phone_e164: `+9198${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`,
    context: '{}', state: 'exhausted', attempt_count: 3, last_outcome: 'no_answer',
    ...(owner ? { assigned_user_id: owner.id, assigned_at: new Date() } : {}),
    ...o,
  };
  const keys = Object.keys(cols);
  await getTestPool().query(
    `INSERT INTO agency_contacts (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(cols),
  );
  return id;
}
const stateOf = async (id: string) =>
  (await getTestPool().query<{ state: string }>('SELECT state FROM agency_contacts WHERE id = $1', [id])).rows[0]!.state;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, dark] = (await seedFloor({ tenants: 2, agentsPerTenant: 3, supervisorsPerTenant: 1, campaignsPerTenant: 1, campaignStatus: 'running' })) as [TenantFloor, TenantFloor];
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_contact_assignment_enabled', 'tenant', $1, 'true'::jsonb)`, [floor.tenant]);
  for (const f of [floor, dark]) {
    for (const agent of f === floor ? [f.agents[0]!, f.agents[1]!] : [f.agents[0]!]) {
      await getTestPool().query(
        'INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)',
        [f.tenant, f.account, f.campaigns[0], agent.id]);
    }
  }
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

const retry = (actor: Actor, body: unknown, f = floor) => call(app(), 'POST', '/proxy/agency/my-contacts/retry', actor, f, body);
const dial = (actor: Actor, contactId: string, body: unknown, f = floor) =>
  call(app(), 'POST', `/proxy/agency/my-contacts/${contactId}/call`, actor, f, body);

describe('the agent\'s own-contact actions (integration)', () => {
  it('1. the flag off: 403 assignment_disabled on both routes', async () => {
    const c = await contact(dark.agents[0]!, {}, dark);
    const r = await retry(dark.agents[0]!, { campaign_id: dark.campaigns[0], all: true }, dark);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().code).toBe('assignment_disabled');
    const d = await dial(dark.agents[0]!, c, { campaign_id: dark.campaigns[0], session_id: randomUUID() }, dark);
    expect(d.statusCode, d.body).toBe(403);
    expect(d.json().code).toBe('assignment_disabled');
  });

  it('2. not staffed on the campaign: 403 not_staffed on both routes', async () => {
    const c = await contact(UNSTAFFED());
    const r = await retry(UNSTAFFED(), { campaign_id: CAMPAIGN(), contact_ids: [c] });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: 'Forbidden', code: 'not_staffed' });
    const d = await dial(UNSTAFFED(), c, { campaign_id: CAMPAIGN(), session_id: randomUUID() });
    expect(d.statusCode, d.body).toBe(403);
    expect(d.json().code).toBe('not_staffed');
    // Another tenant's campaign id reads the same: nothing is confirmed.
    const foreign = await retry(A(), { campaign_id: dark.campaigns[0], all: true });
    expect(foreign.json().code).toBe('not_staffed');
    expect(await stateOf(c)).toBe('exhausted');
  });

  it('3. retry with allow_agent_retry off: 403 agent_retry_disabled', async () => {
    const c = await contact(A());
    const r = await retry(A(), { campaign_id: CAMPAIGN(), contact_ids: [c] });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().code).toBe('agent_retry_disabled');
    expect(await stateOf(c)).toBe('exhausted');
    // A malformed body is the agency surface's 400.
    const bad = await retry(A(), { campaign_id: CAMPAIGN(), contact_ids: [c], all: true });
    expect(bad.statusCode).toBe(400);
  });

  it('4. retry reopens the caller\'s own not-reached contacts and ignores another agent\'s, with one audit row', async () => {
    await getTestPool().query(
      'UPDATE agency_campaigns SET allow_agent_retry = true, agent_retry_cooldown_minutes = 0 WHERE id = $1', [CAMPAIGN()]);
    const mine = await contact(A());
    const reached = await contact(A(), { state: 'completed', last_outcome: 'connected' });
    const theirs = await contact(B());
    const before = await scalar(`SELECT count(*)::int AS n FROM platform_audit_log WHERE action = 'agency_contacts.agent_retry_reopened'`);

    const r = await retry(A(), { campaign_id: CAMPAIGN(), contact_ids: [mine, reached, theirs] });
    expectHealthy(r, 'retry');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ reopened: 1, skipped: [{ contact_id: reached, blocked: 'not_retryable' }], skipped_total: 1 });
    expect(r.body).not.toContain(theirs);
    expect(await stateOf(mine)).toBe('pending');
    expect(await stateOf(theirs)).toBe('exhausted');

    await drainAudits();
    expect(await scalar(`SELECT count(*)::int AS n FROM platform_audit_log WHERE action = 'agency_contacts.agent_retry_reopened'`)).toBe(before + 1);
    const { rows: [audit] } = await getTestPool().query(
      `SELECT user_id, campaign_id, resource_type, details FROM platform_audit_log
        WHERE action = 'agency_contacts.agent_retry_reopened' ORDER BY created_at DESC LIMIT 1`);
    expect(audit).toMatchObject({
      user_id: A().id, campaign_id: CAMPAIGN(), resource_type: 'agency_campaign',
      details: { campaign_id: CAMPAIGN(), reopened: 1, skipped_total: 1 },
    });
  });

  it('5. call: another agent\'s contact is a 404; another agent\'s session is agent_not_available; a bad note is a 400; a reached contact names its block', async () => {
    const joined = await call(app(), 'POST', '/proxy/agency/sessions', A(), floor, { campaign_id: CAMPAIGN() });
    expect(joined.statusCode, joined.body).toBe(201);
    const sessionId = joined.json().session_id as string;
    await getAgencyRuntime()!.agents.set(sessionId, 'available');
    const joinedB = await call(app(), 'POST', '/proxy/agency/sessions', B(), floor, { campaign_id: CAMPAIGN() });
    const sessionB = joinedB.json().session_id as string;

    const theirs = await contact(B(), { state: 'pending' });
    const notFound = await dial(A(), theirs, { campaign_id: CAMPAIGN(), session_id: sessionId });
    expect(notFound.statusCode, notFound.body).toBe(404);
    expect(notFound.json()).toEqual({ error: 'Not Found', code: 'contact_not_found', message: 'Contact not found.' });
    const missing = await dial(A(), randomUUID(), { campaign_id: CAMPAIGN(), session_id: sessionId });
    expect(missing.body).toBe(notFound.body);
    expect((await dial(A(), 'not-a-uuid', { campaign_id: CAMPAIGN(), session_id: sessionId })).statusCode).toBe(404);
    expect(await stateOf(theirs)).toBe('pending');

    const mine = await contact(A(), { state: 'completed', last_outcome: 'connected' });
    const notMySession = await dial(A(), mine, { campaign_id: CAMPAIGN(), session_id: sessionB });
    expect(notMySession.statusCode, notMySession.body).toBe(409);
    expect(notMySession.json().code).toBe('agent_not_available');

    const badNote = await dial(A(), mine, { campaign_id: CAMPAIGN(), session_id: sessionId, override_note: 'short' });
    expect(badNote.statusCode).toBe(400);
    expect(badNote.json()).toMatchObject({ code: 'override_note_invalid', details: { min: 10, max: 500 } });

    const reached = await dial(A(), mine, { campaign_id: CAMPAIGN(), session_id: sessionId });
    expect(reached.statusCode, reached.body).toBe(409);
    expect(reached.json()).toMatchObject({ code: 'contact_not_retryable', details: { blocked: 'not_retryable' } });
    expect((await getAgencyRuntime()!.agents.get(sessionId))?.state).toBe('available');
  });
});
