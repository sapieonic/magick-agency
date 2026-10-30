import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgentSession, insertSoftphoneSession } from './agency-factories.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

/**
 * ─── THE SOFT-PHONE SESSION AGAINST REAL POSTGRES ───────────────────────────
 *
 * docs/softphone.md §2: a soft-phone session is `kind = 'softphone'`,
 * `campaign_id` NULL, created in `break/soft_phone`, and it is the agent's ONE
 * live session in the tenant (`uq_agency_agent_live_tenant`), exactly as a
 * campaign session is. Everything here is a claim about the upsert's SQL on the
 * partial index, so it runs on the database:
 *
 *   * `joinSoftphone` creates the row in the right shape and logs it with a NULL
 *     campaign;
 *   * a rehydrate of a soft-phone session settles (the old `campaign_id =
 *     EXCLUDED.campaign_id` arm never matched NULL, so the retry loop threw: a 500
 *     on every soft-phone reconnect);
 *   * soft phone vs campaign is refused both ways, leaving the blocker untouched;
 *   * concurrent joins settle to exactly one live session.
 */

vi.mock('@magick-agency/db', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { agencyAgentSessionRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { isCampaignSession } = await import('../../../src/db/models/agency.model.js');

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;

function joinSoftphone(agentUserId: string, replicaId = 'replica-1') {
  return agencyAgentSessionRepository.joinSoftphone({ tenantId: TENANT, accountId: ACCOUNT, agentUserId, replicaId });
}

function joinCampaign(campaignId: string, agentUserId: string, replicaId = 'replica-1') {
  return agencyAgentSessionRepository.joinOrRehydrate({
    tenantId: TENANT, accountId: ACCOUNT, campaignId, agentUserId, replicaId,
  });
}

async function liveRows(agentUserId: string) {
  const { rows } = await getTestPool().query(
    'SELECT * FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL',
    [agentUserId],
  );
  return rows;
}

async function events(sessionId: string) {
  const { rows } = await getTestPool().query<{
    from_state: string | null; to_state: string; break_reason: string | null; campaign_id: string | null;
  }>(
    'SELECT from_state, to_state, break_reason, campaign_id FROM agency_agent_session_events WHERE session_id = $1 ORDER BY at',
    [sessionId],
  );
  return rows;
}

describe('soft-phone sessions (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('joinSoftphone creates a softphone session in break/soft_phone with no campaign, and logs it', async () => {
    const agent = uuidFor('sp-agent-create');
    const joined = await joinSoftphone(agent);

    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('unreachable — narrowing');
    expect(joined.created).toBe(true);
    expect(joined.session).toMatchObject({
      kind: 'softphone', campaign_id: null, state: 'break', break_reason: 'soft_phone',
      tenant_id: TENANT, account_id: ACCOUNT, agent_user_id: agent, left_at: null,
    });
    expect(isCampaignSession(joined.session)).toBe(false);
    // The session event carries the NULL campaign (0005 made the column nullable).
    expect(await events(joined.session.id)).toEqual([
      { from_state: null, to_state: 'break', break_reason: 'soft_phone', campaign_id: null },
    ]);
  });

  it('REHYDRATES a live soft-phone session (the old 500 path): same row, created false, no new event', async () => {
    const agent = uuidFor('sp-agent-rehydrate');
    const first = await joinSoftphone(agent, 'replica-1');
    const second = await joinSoftphone(agent, 'replica-2');

    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable — narrowing');
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.owner_replica).toBe('replica-2');
    expect(await liveRows(agent)).toHaveLength(1);
    expect(await events(first.session.id)).toHaveLength(1);
  });

  it('rehydrates an OFFLINE soft-phone session (after the startup reaper) back to break/soft_phone, logged', async () => {
    const agent = uuidFor('sp-agent-offline');
    const session = await insertSoftphoneSession({ agent_user_id: agent, state: 'offline', break_reason: null });

    const joined = await joinSoftphone(agent);

    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('unreachable — narrowing');
    expect(joined.created).toBe(false);
    expect(joined.session.id).toBe(session.id);
    expect(joined.session.state).toBe('break');
    expect(joined.session.break_reason).toBe('soft_phone');
    expect(await events(session.id)).toEqual([
      { from_state: 'offline', to_state: 'break', break_reason: 'soft_phone', campaign_id: null },
    ]);
  });

  it('refuses joinSoftphone `on_campaign` while live on a campaign, with that session, untouched', async () => {
    const campaign = await insertAgencyCampaign();
    const agent = uuidFor('sp-agent-on-campaign');
    const live = await insertAgentSession(campaign.id, {
      agent_user_id: agent, state: 'on_call', owner_replica: 'replica-old',
    });

    const joined = await joinSoftphone(agent, 'replica-new');

    expect(joined.ok).toBe(false);
    if (joined.ok) throw new Error('unreachable — narrowing');
    expect(joined.reason).toBe('on_campaign');
    expect(joined.session.id).toBe(live.id);
    expect(joined.session.campaign_id).toBe(campaign.id);
    // The DO UPDATE's WHERE matched nothing: the live campaign session is as it was.
    const [row] = await liveRows(agent);
    expect(row.owner_replica).toBe('replica-old');
    expect(row.state).toBe('on_call');
    expect(row.updated_at.getTime()).toBe(live.updated_at.getTime());
  });

  it('refuses a campaign join `on_softphone` while on a soft-phone session, untouched', async () => {
    const campaign = await insertAgencyCampaign();
    const agent = uuidFor('sp-agent-campaign-join');
    const sp = await insertSoftphoneSession({ agent_user_id: agent, owner_replica: 'replica-old' });

    const joined = await joinCampaign(campaign.id, agent, 'replica-new');

    expect(joined.ok).toBe(false);
    if (joined.ok) throw new Error('unreachable — narrowing');
    expect(joined.reason).toBe('on_softphone');
    expect(joined.session.id).toBe(sp.id);
    expect(isCampaignSession(joined.session)).toBe(false);
    const [row] = await liveRows(agent);
    expect(row.owner_replica).toBe('replica-old');
    expect(row.kind).toBe('softphone');
  });

  it('a campaign rehydrate is unchanged: same campaign rejoins, another campaign is `other_campaign`', async () => {
    const a = await insertAgencyCampaign();
    const b = await insertAgencyCampaign();
    const agent = uuidFor('sp-agent-campaign-rehydrate');

    const first = await joinCampaign(a.id, agent);
    const again = await joinCampaign(a.id, agent);
    const other = await joinCampaign(b.id, agent);

    if (!first.ok || !again.ok) throw new Error('campaign rehydrate should succeed');
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.session.id).toBe(first.session.id);
    expect(again.session.kind).toBe('campaign');
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error('unreachable — narrowing');
    expect(other.reason).toBe('other_campaign');
    expect(other.session.campaign_id).toBe(a.id);
  });

  it('after leaving the soft phone, the agent can join a campaign', async () => {
    const campaign = await insertAgencyCampaign();
    const agent = uuidFor('sp-agent-leave');
    const sp = await joinSoftphone(agent);
    if (!sp.ok) throw new Error('soft-phone join should succeed');
    await agencyAgentSessionRepository.leave(sp.session.id);

    const joined = await joinCampaign(campaign.id, agent);

    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('unreachable — narrowing');
    expect(joined.session.kind).toBe('campaign');
    expect(joined.session.id).not.toBe(sp.session.id);
    expect(await events(sp.session.id)).toEqual([
      { from_state: null, to_state: 'break', break_reason: 'soft_phone', campaign_id: null },
      { from_state: 'break', to_state: 'offline', break_reason: null, campaign_id: null },
    ]);
  });

  it('two concurrent soft-phone joins settle to ONE live session and one start event', async () => {
    const agent = uuidFor('sp-agent-race');
    const [a, b] = await Promise.all([joinSoftphone(agent, 'replica-a'), joinSoftphone(agent, 'replica-b')]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable — narrowing');
    expect(a.session.id).toBe(b.session.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await liveRows(agent)).toHaveLength(1);
    expect(await events(a.session.id)).toHaveLength(1);
  });

  it('a soft-phone join racing a campaign join: exactly one wins, the other is refused', async () => {
    const campaign = await insertAgencyCampaign();
    const agent = uuidFor('sp-agent-race-kinds');
    const [sp, camp] = await Promise.all([joinSoftphone(agent), joinCampaign(campaign.id, agent)]);

    expect([sp.ok, camp.ok].filter(Boolean)).toHaveLength(1);
    const rows = await liveRows(agent);
    expect(rows).toHaveLength(1);
    if (sp.ok) {
      expect(rows[0].kind).toBe('softphone');
      expect(!camp.ok && camp.reason).toBe('on_softphone');
    } else {
      expect(rows[0].kind).toBe('campaign');
      expect(sp.reason).toBe('on_campaign');
    }
  });
});
