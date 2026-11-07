import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { insertAgencyCampaign, insertAgencyContact, insertAgentSession } = await import('./agency-factories.js');
const { DEFAULTS, insertTenant, insertUser } = await import('../../../../../packages/db/test/integration/setup/factories.js');
const { agencyAssignmentRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { parseAssignmentOperation } = await import('../../../src/agency/assignment/operation.js');
const { PacingEngine } = await import('../../../src/agency/pacing-engine.js');
const { PacingHistoryAccumulator } = await import('../../../src/agency/pacing/pacing-history.js');
const { InProcessPacingInvalidationBus } = await import('../../../src/agency/pacing/invalidation-bus.js');

/**
 * Dedicated caller IDs in the paced dial, on real Postgres (decisions DN2–DN4, DN8): the real
 * pacing engine runs the tick over the real repositories (claim, the dedicated map read, attempt
 * insert); agents, stations, DNC and the dispatcher are doubles, as in `agent-reopen-flag.test.ts`.
 *
 *  - an owned contact dials from its OWNER's dedicated number, an unowned one from the rotation
 *    (the pool minus every dedicated number);
 *  - in `pool` mode the owner still decides, whoever's session takes the call;
 *  - a dedicated number the campaign no longer has is not used (the rotation instead);
 *  - a contact reassigned from A to B dials from B's number (callbacks and reassignment follow
 *    the owner; no code of their own).
 *
 *  - a dedication its agent's unstaff left behind (released by nothing) counts nowhere, even
 *    once the agent is staffed again: the number is back in the rotation.
 *
 * Mutation-checked: making `resolveCallerId` pick from the rotation for every contact (ignoring
 * the owner) reds the owner cases; making `rotationCallerIds` return the whole pool reds the
 * rotation case; dropping the staffing clauses of `EFFECTIVE_DEDICATION_SQL` reds the stale
 * row case.
 */

const X = '+918041000001';
const Y = '+918041000002';
const Z = '+918041000003';
const POOL = [X, Y, Z];

let phoneSeq = 0;
const phone = () => `+9198123${String(++phoneSeq).padStart(5, '0')}`;

async function setup(mode: 'pool' | 'strict' | 'preferred') {
  await insertTenant({ id: DEFAULTS.tenantId });
  const a = (await insertUser()).id as string;
  const b = (await insertUser()).id as string;
  const campaign = await insertAgencyCampaign({
    status: 'running', assignment_mode: mode, caller_ids: POOL,
    // An agent is staffed only once a number is dedicated to them (`dedicate`); `keep` stops
    // the unstaffed-owner sweep handing the others' contacts to the pool under the tick.
    on_unstaff: 'keep',
  }) as { id: string; tenant_id: string; account_id: string; disposition_catalog: unknown };
  const sessionA = await insertAgentSession(campaign.id, { agent_user_id: a });
  const sessionB = await insertAgentSession(campaign.id, { agent_user_id: b });
  return { campaign, a, b, sessionA: sessionA.id as string, sessionB: sessionB.id as string };
}

/** Staff the agent (a dedication counts only while they are, DN1), then dedicate the number. */
async function dedicate(campaign: { id: string; tenant_id: string; account_id: string }, userId: string, callerId: string) {
  await getTestPool().query(
    `INSERT INTO agency_campaign_agents (tenant_id, campaign_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [campaign.tenant_id, campaign.id, userId]);
  await getTestPool().query(
    `INSERT INTO agency_campaign_agent_caller_ids (tenant_id, account_id, campaign_id, user_id, caller_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [campaign.tenant_id, campaign.account_id, campaign.id, userId, callerId]);
}

async function contact(campaignId: string, owner: string | null, dueInMs = -1_000) {
  const row = await insertAgencyContact(campaignId, {
    phone_e164: phone(), state: 'pending', next_attempt_at: new Date(Date.now() + dueInMs),
    ...(owner ? { assigned_user_id: owner, assigned_at: new Date() } : {}),
  });
  return row.id as string;
}

/** The engine over `sessions` (each available, each owned by this replica). */
function engineFor(sessions: readonly string[]) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const agents = {
    getMany: vi.fn(async (ids: readonly string[]) => ids.map((id) => (sessions.includes(id) ? { state: 'available', attemptId: null, since: 1 } : null))),
    get: vi.fn(async (id: string) => (sessions.includes(id) ? { state: 'available', attemptId: null, since: 1 } : null)),
    reserve: vi.fn(async (id: string) => (sessions.includes(id) ? 'reserved' : 'lost')),
    set: vi.fn(async () => 'ok'),
  };
  const stations = {
    isLocallyOwned: (id: string) => sessions.includes(id),
    ownerOf: async (id: string) => (sessions.includes(id) ? 'r1' : null),
    get: () => undefined,
    broadcast: () => 0,
    send: () => true,
  };
  const engine = new PacingEngine(
    null, '', 'r1', stations as never, agents as never, { dispatch } as never,
    { check: vi.fn(async () => 'clear') } as never,
    { bus: new InProcessPacingInvalidationBus(), history: new PacingHistoryAccumulator({ sink: { upsertMinutes: async () => 0 } }) },
  );
  engine.setAutoRounds(false);
  return { engine, dispatch };
}

async function dials(campaignId: string): Promise<Map<string, { caller_id: string; reserved_agent_id: string }>> {
  const { rows } = await getTestPool().query<{ contact_id: string; caller_id: string; reserved_agent_id: string }>(
    'SELECT contact_id, caller_id, reserved_agent_id FROM agency_call_attempts WHERE campaign_id = $1', [campaignId]);
  return new Map(rows.map((r) => [r.contact_id, { caller_id: r.caller_id, reserved_agent_id: r.reserved_agent_id }]));
}

beforeEach(truncateAll);
afterAll(closeTestPool);

describe('pacing: the contact\'s owner decides the caller ID', () => {
  it('preferred: an owned contact dials from its owner\'s number; a pool contact from the rotation', async () => {
    const { campaign, a, sessionA, sessionB } = await setup('preferred');
    await dedicate(campaign, a, Y);
    const own = await contact(campaign.id, a);
    const pooled = await contact(campaign.id, null);
    const { engine, dispatch } = engineFor([sessionA, sessionB]);

    await engine.tickOnce(campaign.id);

    expect(dispatch).toHaveBeenCalledTimes(2);
    const byContact = await dials(campaign.id);
    expect(byContact.get(own)).toEqual({ caller_id: Y, reserved_agent_id: sessionA });
    expect(byContact.get(pooled)!.reserved_agent_id).toBe(sessionB);
    // The rotation leaves Y out (dedicated), whoever's contact it is not.
    expect([X, Z]).toContain(byContact.get(pooled)!.caller_id);
  });

  it('the rotation never uses a dedicated number, over many dials', async () => {
    const { campaign, a, b, sessionA, sessionB } = await setup('pool');
    await dedicate(campaign, a, Y);
    await dedicate(campaign, b, Z);
    const c = (await insertUser()).id as string;
    const sessionC = (await insertAgentSession(campaign.id, { agent_user_id: c })).id as string;
    const { engine, dispatch } = engineFor([sessionA, sessionB, sessionC]);
    // Three unowned contacts per tick, so one tick's dials take offsets 0, 1 and 2: over the
    // whole pool they would cover every number; over the rotation they are all X.
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 3; k++) await contact(campaign.id, null);
      await engine.tickOnce(campaign.id);
      // Settle the dials so the sessions are free for the next tick.
      await getTestPool().query(
        `UPDATE agency_call_attempts SET state = 'ended', outcome = 'no_answer', ended_at = now() WHERE campaign_id = $1 AND state <> 'ended'`,
        [campaign.id]);
      await getTestPool().query(`UPDATE agency_contacts SET state = 'completed' WHERE campaign_id = $1 AND state = 'in_flight'`, [campaign.id]);
    }
    expect(dispatch).toHaveBeenCalledTimes(9);
    const used = new Set([...(await dials(campaign.id)).values()].map((d) => d.caller_id));
    expect([...used]).toEqual([X]);
  });

  it('a dedication left behind by an unstaff (agent staffed again since) is ignored: its number is back in the rotation', async () => {
    const { campaign, a, b, sessionB } = await setup('pool');
    await dedicate(campaign, a, Y);
    await dedicate(campaign, b, X);
    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [campaign.id, [X, Y]]);
    // a is unstaffed with the row left behind (a release that failed), then staffed again.
    await getTestPool().query(
      'UPDATE agency_campaign_agents SET unassigned_at = now() WHERE campaign_id = $1 AND user_id = $2', [campaign.id, a]);
    await new Promise((r) => setTimeout(r, 5));
    await getTestPool().query(
      'INSERT INTO agency_campaign_agents (tenant_id, campaign_id, user_id) VALUES ($1, $2, $3)', [campaign.tenant_id, campaign.id, a]);
    const c = (await insertUser()).id as string;
    const sessionC = (await insertAgentSession(campaign.id, { agent_user_id: c })).id as string;
    const { engine, dispatch } = engineFor([sessionB, sessionC]);
    // The rotation is the pool minus b's X: Y, every time. Counting a's stale row would make
    // every number dedicated, and the rotation the whole pool (X as often as Y).
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 2; k++) await contact(campaign.id, null);
      await engine.tickOnce(campaign.id);
      await getTestPool().query(
        `UPDATE agency_call_attempts SET state = 'ended', outcome = 'no_answer', ended_at = now() WHERE campaign_id = $1 AND state <> 'ended'`,
        [campaign.id]);
      await getTestPool().query(`UPDATE agency_contacts SET state = 'completed' WHERE campaign_id = $1 AND state = 'in_flight'`, [campaign.id]);
    }
    expect(dispatch).toHaveBeenCalledTimes(6);
    expect([...new Set([...(await dials(campaign.id)).values()].map((d) => d.caller_id))]).toEqual([Y]);
  });

  it('pool mode: an owned contact goes out from its owner\'s number though another agent takes it', async () => {
    const { campaign, a, sessionB } = await setup('pool');
    await dedicate(campaign, a, Y);
    const own = await contact(campaign.id, a);
    const { engine, dispatch } = engineFor([sessionB]);

    await engine.tickOnce(campaign.id);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await dials(campaign.id)).get(own)).toEqual({ caller_id: Y, reserved_agent_id: sessionB });
  });

  it('a dedicated number the campaign no longer has is not used: the rotation instead', async () => {
    const { campaign, a, sessionA } = await setup('strict');
    await dedicate(campaign, a, Y);
    // A direct write drops Y from the campaign (the PATCH refuses it, DN6).
    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [campaign.id, [X, Z]]);
    const own = await contact(campaign.id, a);
    const { engine } = engineFor([sessionA]);

    await engine.tickOnce(campaign.id);

    expect([X, Z]).toContain((await dials(campaign.id)).get(own)!.caller_id);
  });

  it('contacts reassigned from A to B dial from B\'s number (DN8: the owner, not the history)', async () => {
    const { campaign, a, b, sessionB } = await setup('strict');
    await dedicate(campaign, a, Y);
    await dedicate(campaign, b, Z);
    const moved = await contact(campaign.id, a);

    const parsed = parseAssignmentOperation({ kind: 'reassign', from_user_id: a, to_user_id: b }, 'preview');
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.details));
    const scope = { campaignId: campaign.id, tenantId: campaign.tenant_id, callbackCodes: [] };
    const preview = await agencyAssignmentRepository.preview(parsed.op, scope);
    const committed = await agencyAssignmentRepository.commit({ op: parsed.op, scope, token: preview.preview_token, actorUserId: null });
    expect(committed.ok).toBe(true);

    const { engine, dispatch } = engineFor([sessionB]);
    await engine.tickOnce(campaign.id);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await dials(campaign.id)).get(moved)).toEqual({ caller_id: Z, reserved_agent_id: sessionB });
  });
});
