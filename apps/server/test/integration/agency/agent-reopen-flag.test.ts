import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession } = await import('./agency-factories.js');
const {
  agencyAgentRetryRepository,
  agencyAttemptRepository,
} = await import('../../../src/db/repositories/agency.repository.js');
const { PacingEngine } = await import('../../../src/agency/pacing-engine.js');
const { PacingHistoryAccumulator } = await import('../../../src/agency/pacing/pacing-history.js');
const { InProcessPacingInvalidationBus } = await import('../../../src/agency/pacing/invalidation-bus.js');

/**
 * The reopen flag end to end, on real Postgres (IN2): an agent's "Retry not reached" marks the
 * contact (`agent_reopen_pending`), the FIRST paced dial after it consumes the marker and is
 * stamped `agency_call_attempts.agent_reopened`, and no other dial is: not the next paced one,
 * not the agent's own (`agent_manual`), and a paced attempt abandoned before its dial gives the
 * marker back. The real pacing engine runs the tick over the real repositories (claim, probe,
 * attempt insert); the agents, stations, DNC and dispatcher are doubles.
 */

const AGENT = randomUUID();
const SETTINGS = { allowed: true, rounds: 5, cooldownMinutes: 30, callbackCodes: ['callback'] };

async function setup() {
  const campaign = await insertAgencyCampaign({
    status: 'running', assignment_mode: 'strict', allow_agent_retry: true, agent_retry_rounds: 5,
    // The agent is not staffed in this fixture; `keep` stops the unstaffed-owner sweep handing
    // their contact to the pool under the tick.
    on_unstaff: 'keep',
  });
  const contact = await insertAgencyContact(campaign.id, {
    assigned_user_id: AGENT, assigned_at: new Date(),
    state: 'exhausted', attempt_count: 3, last_outcome: 'no_answer',
  });
  const at = new Date(Date.now() - 60 * 60_000);
  await insertAgencyAttempt(campaign.id, contact.id, {
    attempt_number: 1, state: 'ended', outcome: 'no_answer', created_at: at, ended_at: at, dialed_at: at,
  });
  const session = await insertAgentSession(campaign.id, { agent_user_id: AGENT });
  return { campaign, contact, session };
}

function engineFor(sessionId: string) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const agents = {
    getMany: vi.fn(async (ids: readonly string[]) => ids.map(() => ({ state: 'available', attemptId: null, since: 1 }))),
    get: vi.fn(async () => ({ state: 'available', attemptId: null, since: 1 })),
    reserve: vi.fn(async () => 'reserved'),
    set: vi.fn(async () => 'ok'),
  };
  const stations = {
    isLocallyOwned: (id: string) => id === sessionId,
    ownerOf: async (id: string) => (id === sessionId ? 'r1' : null),
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

async function attempts(contactId: string) {
  const { rows } = await getTestPool().query<{ id: string; attempt_number: number; agent_reopened: boolean; agent_manual: boolean; state: string }>(
    'SELECT id, attempt_number, agent_reopened, agent_manual, state FROM agency_call_attempts WHERE contact_id = $1 ORDER BY attempt_number',
    [contactId]);
  return rows;
}

async function marker(contactId: string): Promise<boolean> {
  const { rows } = await getTestPool().query<{ p: boolean }>('SELECT agent_reopen_pending AS p FROM agency_contacts WHERE id = $1', [contactId]);
  return rows[0]!.p;
}

/** The dial ended not reached: the attempt ends, the contact is open and due again. */
async function endNotReached(attemptId: string, contactId: string): Promise<void> {
  await getTestPool().query(
    `UPDATE agency_call_attempts SET state = 'ended', outcome = 'no_answer', dialed_at = COALESCE(dialed_at, now()), ended_at = now() WHERE id = $1`,
    [attemptId]);
  await getTestPool().query(
    `UPDATE agency_contacts SET state = 'pending', next_attempt_at = now() - interval '1 second', last_outcome = 'no_answer' WHERE id = $1`,
    [contactId]);
}

async function reopen(campaignId: string, contactId: string): Promise<void> {
  const out = await agencyAgentRetryRepository.reopenForAgent({ campaignId, userId: AGENT, contactIds: [contactId], settings: SETTINGS });
  expect(out.reopened).toEqual([contactId]);
}

beforeEach(truncateAll);
afterAll(closeTestPool);

describe('the reopen flag', () => {
  it('the first paced dial after a reopen is flagged, and the next paced dial is not', async () => {
    const { campaign, contact, session } = await setup();
    await reopen(campaign.id, contact.id);
    expect(await marker(contact.id)).toBe(true);

    const { engine, dispatch } = engineFor(session.id);
    await engine.tickOnce(campaign.id);
    expect(dispatch).toHaveBeenCalledTimes(1);
    let rows = await attempts(contact.id);
    expect(rows.map((r) => [r.attempt_number, r.agent_reopened])).toEqual([[1, false], [2, true]]);
    expect(await marker(contact.id)).toBe(false);

    // Not reached again; pacing dials it on its own (no reopen in between): not flagged.
    await endNotReached(rows[1]!.id, contact.id);
    await engine.tickOnce(campaign.id);
    expect(dispatch).toHaveBeenCalledTimes(2);
    rows = await attempts(contact.id);
    expect(rows.map((r) => [r.attempt_number, r.agent_reopened])).toEqual([[1, false], [2, true], [3, false]]);
  });

  it('a paced attempt abandoned before its dial gives the marker back; the dial that does go out is flagged', async () => {
    const { campaign, contact, session } = await setup();
    await reopen(campaign.id, contact.id);
    const { engine, dispatch } = engineFor(session.id);
    dispatch.mockRejectedValueOnce(new Error('dialer refused the command'));

    await engine.tickOnce(campaign.id);
    let rows = await attempts(contact.id);
    expect(rows[1]).toMatchObject({ attempt_number: 2, state: 'ended', agent_reopened: true });
    expect(await marker(contact.id)).toBe(true);

    await engine.tickOnce(campaign.id);
    rows = await attempts(contact.id);
    expect(rows.map((r) => [r.attempt_number, r.agent_reopened])).toEqual([[1, false], [2, true], [3, true]]);
    expect(await marker(contact.id)).toBe(false);
  });

  it('the agent\'s own dial is never flagged, and it uses the reopen up: the paced dial after it is not flagged', async () => {
    const { campaign, contact, session } = await setup();
    await reopen(campaign.id, contact.id);

    const claim = await agencyAgentRetryRepository.claimForAgentDial({
      contactId: contact.id, campaignId: campaign.id, userId: AGENT, basis: 'due', spendCallingHours: false, settings: SETTINGS,
    });
    expect(claim?.spent.agentReopen).toBe(true);
    expect(await marker(contact.id)).toBe(false);
    const manual = await agencyAttemptRepository.create({
      campaignId: campaign.id, contactId: contact.id, tenantId: campaign.tenant_id, accountId: campaign.account_id,
      callerId: '+919000000001', reservedAgentId: session.id,
      agentManual: { overrideApplied: [], overrideNote: null },
      // Even asked to: an agent's own dial never consumes nor carries the flag.
      consumeAgentReopen: true,
    });
    expect(manual).toMatchObject({ agent_manual: true, agent_reopened: false });

    await endNotReached(manual!.id, contact.id);
    const { engine } = engineFor(session.id);
    await engine.tickOnce(campaign.id);
    const rows = await attempts(contact.id);
    expect(rows.map((r) => [r.agent_manual, r.agent_reopened])).toEqual([[false, false], [true, false], [false, false]]);
  });

  it('an agent dial claim that is undone gives the marker back with the rest', async () => {
    const { campaign, contact } = await setup();
    await reopen(campaign.id, contact.id);
    const claim = await agencyAgentRetryRepository.claimForAgentDial({
      contactId: contact.id, campaignId: campaign.id, userId: AGENT, basis: 'due', spendCallingHours: false, settings: SETTINGS,
    });
    expect(await agencyAgentRetryRepository.releaseAgentDialClaim(contact.id, claim!)).toBe(true);
    expect(await marker(contact.id)).toBe(true);

    const again = await agencyAgentRetryRepository.claimForAgentDial({
      contactId: contact.id, campaignId: campaign.id, userId: AGENT, basis: 'due', spendCallingHours: false, settings: SETTINGS,
    });
    expect(await agencyAgentRetryRepository.releaseRefusedAgentDialClaim(contact.id, again!)).toBe(true);
    expect(await marker(contact.id)).toBe(true);
  });

  it('an attempt insert refused by the live-attempt index consumes nothing', async () => {
    const { campaign, contact, session } = await setup();
    await reopen(campaign.id, contact.id);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [contact.id]);
    await insertAgencyAttempt(campaign.id, contact.id, { attempt_number: 2, state: 'dialing' });
    const refused = await agencyAttemptRepository.create({
      campaignId: campaign.id, contactId: contact.id, tenantId: campaign.tenant_id, accountId: campaign.account_id,
      callerId: '+919000000001', reservedAgentId: session.id, consumeAgentReopen: true,
    });
    expect(refused).toBeNull();
    expect(await marker(contact.id)).toBe(true);
  });

  it('an insert that does not ask to consume (every non-paced caller) leaves the marker alone', async () => {
    const { campaign, contact, session } = await setup();
    await reopen(campaign.id, contact.id);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [contact.id]);
    const plain = await agencyAttemptRepository.create({
      campaignId: campaign.id, contactId: contact.id, tenantId: campaign.tenant_id, accountId: campaign.account_id,
      callerId: '+919000000001', reservedAgentId: session.id,
    });
    expect(plain?.agent_reopened).toBe(false);
    expect(await marker(contact.id)).toBe(true);
  });
});
