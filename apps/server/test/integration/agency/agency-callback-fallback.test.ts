import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact, insertAgentSession } from './agency-factories.js';
import { DEFAULTS, insertAccount, insertTenant, insertUser } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
const { audit } = vi.hoisted(() => ({ audit: { log: vi.fn() } }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: audit }));

const { sweepCallbackFallback, sweepUnstaffedOwners } = await import('../../../src/agency/pacing/callback-fallback.js');
const { agencyAssignmentRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * The callback grace/fallback (CA5) on real Postgres: a running owner-mode campaign's DUE
 * callbacks, past the grace, whose owner has no live session on the campaign, lose their
 * owner (`callback_fallback = 'pool'`), each with a history row, under one batch id per
 * sweep, and one audit row per batch. `wait` moves nothing, a live owner keeps them, and a
 * live (`in_flight` / `connected`) contact is never touched.
 */

const OWNER = randomUUID();
const OTHER = randomUUID();
const CATALOG = [
  { code: 'interested', label: 'Interested' },
  { code: 'call_back', label: 'Call back', requires_datetime: true },
];

async function campaign(overrides: Record<string, unknown> = {}) {
  return insertAgencyCampaign({
    status: 'running', assignment_mode: 'strict', callback_fallback: 'pool', callback_owner_grace_minutes: 30,
    disposition_catalog: JSON.stringify(CATALOG), ...overrides,
  });
}

/** A callback owned by `owner`, due `minutesAgo` minutes ago. */
async function callback(campaignId: string, owner: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  return insertAgencyContact(campaignId, {
    assigned_user_id: owner, assigned_at: new Date(Date.now() - 86_400_000),
    attempt_count: 1, last_outcome: 'connected', last_disposition: 'call_back',
    next_attempt_at: new Date(Date.now() - minutesAgo * 60_000), ...extra,
  });
}

async function ownerOf(id: string): Promise<string | null> {
  const { rows } = await getTestPool().query<{ assigned_user_id: string | null }>(
    'SELECT assigned_user_id FROM agency_contacts WHERE id = $1', [id],
  );
  return rows[0]!.assigned_user_id;
}

async function events(campaignId: string) {
  const { rows } = await getTestPool().query(
    `SELECT contact_id, from_user_id, to_user_id, actor_user_id, reason, batch_id
       FROM agency_contact_assignment_events WHERE campaign_id = $1 ORDER BY contact_id`, [campaignId],
  );
  return rows;
}

describe('callback grace/fallback sweep', () => {
  beforeEach(async () => {
    audit.log.mockClear();
    await truncateAll();
  });
  afterAll(closeTestPool);

  it("past the grace, with the owner absent: the callback goes to the pool, with its history and one audit row", async () => {
    const c = await campaign();
    const overdue = await callback(c.id, OWNER, 45);
    const overdue2 = await callback(c.id, OTHER, 120);

    expect(await sweepCallbackFallback(c)).toBe(2);

    expect(await ownerOf(overdue.id)).toBeNull();
    expect(await ownerOf(overdue2.id)).toBeNull();
    const { rows: [row] } = await getTestPool().query(
      'SELECT assigned_at, assigned_by_user_id, state FROM agency_contacts WHERE id = $1', [overdue.id],
    );
    expect(row).toMatchObject({ assigned_at: null, assigned_by_user_id: null, state: 'pending' });

    const history = await events(c.id);
    expect(history).toHaveLength(2);
    expect(new Set(history.map((e) => e.batch_id)).size).toBe(1);
    for (const e of history) expect(e).toMatchObject({ to_user_id: null, actor_user_id: null, reason: 'callback_fallback' });
    expect(history.map((e) => e.from_user_id).sort()).toEqual([OWNER, OTHER].sort());

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0]![0]).toMatchObject({
      actor_type: 'system',
      tenant_id: c.tenant_id,
      account_id: c.account_id,
      action: 'agency_contacts.callback_fallback',
      resource_type: 'agency_campaign',
      resource_id: c.id,
      campaign_id: c.id,
      details: { batch_id: history[0]!.batch_id, moved: 2, grace_minutes: 30, per_agent: { [OWNER]: 1, [OTHER]: 1 } },
    });

    // Idempotent: nothing left to move, nothing written.
    expect(await sweepCallbackFallback(c)).toBe(0);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('within the grace, nothing moves', async () => {
    const c = await campaign();
    const fresh = await callback(c.id, OWNER, 10);

    expect(await sweepCallbackFallback(c)).toBe(0);
    expect(await ownerOf(fresh.id)).toBe(OWNER);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('an owner live on the campaign keeps their callbacks; one whose station is gone, or who left, does not', async () => {
    const c = await campaign();
    const live = await callback(c.id, OWNER, 60);
    await insertAgentSession(c.id, { agent_user_id: OWNER, state: 'break' });
    const offlineOwner = randomUUID();
    const ofOffline = await callback(c.id, offlineOwner, 60);
    await insertAgentSession(c.id, { agent_user_id: offlineOwner, state: 'offline' });
    const leftOwner = randomUUID();
    const ofLeft = await callback(c.id, leftOwner, 60);
    await insertAgentSession(c.id, { agent_user_id: leftOwner, state: 'offline', left_at: new Date() });
    // Live on ANOTHER campaign is not live on this one.
    const elsewhere = await campaign({ status: 'paused' });
    const ofElsewhere = await callback(c.id, OTHER, 60);
    await insertAgentSession(elsewhere.id, { agent_user_id: OTHER, state: 'available' });

    expect(await sweepCallbackFallback(c)).toBe(3);
    expect(await ownerOf(live.id)).toBe(OWNER);
    expect(await ownerOf(ofOffline.id)).toBeNull();
    expect(await ownerOf(ofLeft.id)).toBeNull();
    expect(await ownerOf(ofElsewhere.id)).toBeNull();
  });

  it('never touches a live contact: an in-flight or connected callback keeps its owner', async () => {
    const c = await campaign();
    const inFlight = await callback(c.id, OWNER, 60, { state: 'in_flight' });
    const connected = await callback(c.id, OWNER, 60, { state: 'connected' });

    expect(await sweepCallbackFallback(c)).toBe(0);
    expect(await ownerOf(inFlight.id)).toBe(OWNER);
    expect(await ownerOf(connected.id)).toBe(OWNER);
    expect(await events(c.id)).toEqual([]);
  });

  it('only callbacks: a not-reached retry or a fresh contact past the grace stays with its owner', async () => {
    const c = await campaign();
    const retry = await callback(c.id, OWNER, 60, { last_outcome: 'no_answer', last_disposition: null });
    const fresh = await callback(c.id, OWNER, 60, { attempt_count: 0, last_outcome: null, last_disposition: null });
    const dnc = await callback(c.id, OWNER, 60, { suppressed_reason: 'dnc' });

    expect(await sweepCallbackFallback(c)).toBe(0);
    for (const id of [retry.id, fresh.id, dnc.id]) expect(await ownerOf(id)).toBe(OWNER);
  });

  it("`wait`, a pool campaign, or a campaign that is not running moves nothing", async () => {
    for (const overrides of [
      { callback_fallback: 'wait' },
      { assignment_mode: 'pool' },
      { status: 'paused' },
    ]) {
      await truncateAll(); // a fresh world per case
      const c = await campaign(overrides);
      const cb = await callback(c.id, OWNER, 600);
      expect(await sweepCallbackFallback(c)).toBe(0);
      expect(await ownerOf(cb.id)).toBe(OWNER);
    }
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('preferred: a fallen-back callback is then claimable from the pool by any agent', async () => {
    const c = await campaign({ assignment_mode: 'preferred' });
    const cb = await callback(c.id, OWNER, 60);
    const { agencyContactRepository } = await import('../../../src/db/repositories/agency.repository.js');

    expect(await agencyContactRepository.claimForAgents(c.id, [OTHER], 'preferred')).toEqual([]);
    expect(await sweepCallbackFallback(c)).toBe(1);
    const claims = await agencyContactRepository.claimForAgents(c.id, [OTHER], 'preferred');
    expect(claims.map((x) => [x.agentUserId, x.contact.id])).toEqual([[OTHER, cb.id]]);
  });
});

/**
 * CA6's catch-up (`sweepUnstaffedOwners`): the unstaff moves only what is `pending` then; a
 * contact on a call at that moment settles back to `pending` still owned by the unstaffed
 * agent, who can no longer join, and a strict campaign would never dial it again. The leader's
 * sweep returns it to the pool.
 */
describe('unstaffed-owner sweep (CA6 catch-up)', () => {
  let staffedUser: string;
  let goneUser: string;

  beforeEach(async () => {
    audit.log.mockClear();
    await truncateAll();
    await insertTenant({ id: DEFAULTS.tenantId });
    await insertAccount({ id: DEFAULTS.accountId, tenant_id: DEFAULTS.tenantId });
    staffedUser = (await insertUser() as { id: string }).id;
    goneUser = (await insertUser() as { id: string }).id;
  });

  async function staff(c: { id: string; tenant_id: string; account_id: string }, userId: string, active = true) {
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id, unassigned_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [c.tenant_id, c.account_id, c.id, userId, active ? null : new Date()]);
  }

  it('a contact live at the unstaff, settled since, goes to the pool; a staffed owner keeps theirs', async () => {
    const c = await campaign({ on_unstaff: 'return_to_pool' }) as { id: string; tenant_id: string; account_id: string };
    await staff(c, staffedUser);
    await staff(c, goneUser);
    const live = await insertAgencyContact(c.id, { assigned_user_id: goneUser, assigned_at: new Date(), state: 'in_flight' });
    const kept = await insertAgencyContact(c.id, { assigned_user_id: staffedUser, assigned_at: new Date() });

    // The unstaff: the staffing row closes, the live contact is skipped.
    await getTestPool().query(
      'UPDATE agency_campaign_agents SET unassigned_at = now() WHERE campaign_id = $1 AND user_id = $2', [c.id, goneUser]);
    const [unstaffed] = await agencyAssignmentRepository.returnOnUnstaff({
      tenantId: c.tenant_id, userId: goneUser, campaignIds: [c.id], actorUserId: null,
    });
    expect(unstaffed).toMatchObject({ moved: 0, skipped_live: 1 });
    // The call settles: back to pending, still the former agent's.
    await getTestPool().query(`UPDATE agency_contacts SET state = 'pending' WHERE id = $1`, [live.id]);
    expect(await ownerOf(live.id)).toBe(goneUser);

    expect(await sweepUnstaffedOwners(c as never)).toBe(1);
    expect(await ownerOf(live.id)).toBeNull();
    expect(await ownerOf(kept.id)).toBe(staffedUser);
    const history = await events(c.id);
    expect(history).toEqual([expect.objectContaining({
      contact_id: live.id, from_user_id: goneUser, to_user_id: null, actor_user_id: null, reason: 'unstaffed',
    })]);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0]![0]).toMatchObject({
      action: 'agency_contacts.unassigned_on_unstaff', actor_type: 'system',
      details: { moved: 1, per_agent: { [goneUser]: 1 }, cause: 'sweep' },
    });
    // Nothing left: a second sweep is silent.
    expect(await sweepUnstaffedOwners(c as never)).toBe(0);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('an owner never staffed on the campaign (an inherited owner) loses open contacts; a live one is never touched', async () => {
    const c = await campaign({ on_unstaff: 'return_to_pool' }) as { id: string; tenant_id: string; account_id: string };
    const open = await insertAgencyContact(c.id, { assigned_user_id: goneUser, assigned_at: new Date() });
    const onCall = await insertAgencyContact(c.id, { assigned_user_id: goneUser, assigned_at: new Date(), state: 'connected' });
    const closed = await insertAgencyContact(c.id, { assigned_user_id: goneUser, assigned_at: new Date(), state: 'completed' });
    expect(await sweepUnstaffedOwners(c as never)).toBe(1);
    expect(await ownerOf(open.id)).toBeNull();
    expect(await ownerOf(onCall.id)).toBe(goneUser);
    expect(await ownerOf(closed.id)).toBe(goneUser);
  });

  it('`keep`, a pool campaign, or a campaign that is not running moves nothing', async () => {
    for (const overrides of [
      { on_unstaff: 'keep' },
      { on_unstaff: 'return_to_pool', assignment_mode: 'pool' },
      { on_unstaff: 'return_to_pool', status: 'paused' },
    ]) {
      await truncateAll(); // a fresh world per case
      const c = await campaign(overrides);
      const held = await insertAgencyContact(c.id, { assigned_user_id: goneUser, assigned_at: new Date() });
      expect(await sweepUnstaffedOwners(c as never)).toBe(0);
      expect(await ownerOf(held.id)).toBe(goneUser);
    }
    expect(audit.log).not.toHaveBeenCalled();
  });
});

