import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, uuidFor } from '../setup/factories.js';

/**
 * ─── ONE LIVE SESSION PER AGENT (per tenant until 0034; across tenants since, OS1) ───
 *
 * The defect: `agency_agent_sessions` allowed one live session per (campaign,
 * agent), while the reservation CAS key in `src/agency/agent-state-machine.ts`
 * is `agency:agent:{sessionId}:state` — per SESSION. One human on two campaigns
 * was therefore two independently reservable agents attached to one pair of
 * ears, and both pacing ticks could bridge a customer at the same instant. The
 * CAS protected a session perfectly; nothing protected the person.
 *
 * ── Why this is an integration test and not a unit test ────────────────────
 *
 * Every claim here is a claim about **Postgres**: that a partial unique index
 * arbitrates an `ON CONFLICT`, that a `DO UPDATE … WHERE` returns zero rows
 * instead of writing, and that one statement claims the station for one device. A
 * mocked pool cannot have an opinion about any of them — it would only replay
 * whatever this file asserted, which is the shape of test that let the original
 * defect ship.
 *
 * The migration that ends duplicates (0034, an agent live in two tenants when it runs) is pinned
 * in `packages/db/test/integration/db/one-station-per-agent-migration.test.ts`, which runs it.
 */

vi.mock('@magick-agency/db', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));

// `agency.repository.ts` pulls the config graph transitively, and `loadConfig`
// would `process.exit(1)` on the repo's incomplete `.env` — taking the runner
// with it. Same mock, same reason, as the sibling agency integration files.
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { agencyAgentSessionRepository } = await import('../../../src/db/repositories/agency.repository.js');

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
const REPLICA = 'replica-1';

describe('agency agent sessions — one live session per agent (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  // ── The join path ─────────────────────────────────────────────────────────

  it('rejoining the SAME campaign rehydrates the existing row rather than creating a second', async () => {
    const campaign = await insertAgencyCampaign();

    const first = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT,
      campaignId: campaign.id, agentUserId: uuidFor('agent-rejoin'), replicaId: REPLICA,
    });
    expect(first.ok).toBe(true);
    expect(first.session.state).toBe('break');

    // A page reload mid-shift. The agent is `available` when it happens, and the
    // rehydrate must NOT knock them back to `break` — only an `offline` row is
    // promoted, because `break` on a live agent would take a working station out
    // of the pool for a refresh.
    await getTestPool().query(
      `UPDATE agency_agent_sessions SET state = 'available' WHERE id = $1`,
      [first.session.id],
    );

    const second = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT,
      campaignId: campaign.id, agentUserId: uuidFor('agent-rejoin'), replicaId: 'replica-2',
    });
    expect(second.ok).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.state).toBe('available');
    expect(second.session.owner_replica).toBe('replica-2');

    // The row count is the assertion that matters: "it returned a session" is
    // satisfied by an implementation that inserted a second live one.
    const { rows } = await getTestPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agency_agent_sessions WHERE agent_user_id = '${uuidFor('agent-rejoin')}'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('a SECOND campaign is refused, naming the campaign the agent is still on', async () => {
    const first = await insertAgencyCampaign({ name: 'Q3 Renewals' });
    const second = await insertAgencyCampaign({ name: 'Winback' });

    const joined = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT,
      campaignId: first.id, agentUserId: uuidFor('agent-two-campaigns'), replicaId: REPLICA,
    });
    expect(joined.ok).toBe(true);

    // Mid-conversation, which is the case that makes "do not touch the other
    // row" load-bearing rather than tidy.
    await getTestPool().query(
      `UPDATE agency_agent_sessions SET state = 'on_call' WHERE id = $1`,
      [joined.session.id],
    );

    const refused = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT,
      campaignId: second.id, agentUserId: uuidFor('agent-two-campaigns'), replicaId: 'replica-2',
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable — narrowing for the assertions below');
    expect(refused.reason).toBe('other_campaign');
    // The campaign they are STILL on, not the one they asked for. Returning the
    // requested campaign here would produce a 409 telling the agent to leave the
    // station they are trying to join.
    expect(refused.session.campaign_id).toBe(first.id);

    // The other campaign's row is untouched: still `on_call`, still owned by the
    // replica that is bridging the audio. An unconditional `DO UPDATE` would have
    // stamped `replica-2` over `owner_replica` and quietly moved ownership of a
    // live conversation to a replica holding no bridge.
    const { rows } = await getTestPool().query<{ state: string; owner_replica: string | null; n: string }>(
      `SELECT state, owner_replica, COUNT(*) OVER ()::text AS n
         FROM agency_agent_sessions
        WHERE agent_user_id = '${uuidFor('agent-two-campaigns')}' AND left_at IS NULL`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('on_call');
    expect(rows[0]!.owner_replica).toBe(REPLICA);
  });

  it('leaving the first campaign lets the same agent join the second', async () => {
    // The escape hatch the 409 points at. Without this the refusal above would be
    // a trap rather than a redirect, so it is asserted rather than assumed.
    const first = await insertAgencyCampaign({ name: 'Q3 Renewals' });
    const second = await insertAgencyCampaign({ name: 'Winback' });

    const joined = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT,
      campaignId: first.id, agentUserId: uuidFor('agent-moves'), replicaId: REPLICA,
    });
    expect(joined.ok).toBe(true);
    await agencyAgentSessionRepository.leave(joined.session.id);

    const moved = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT,
      campaignId: second.id, agentUserId: uuidFor('agent-moves'), replicaId: REPLICA,
    });
    expect(moved.ok).toBe(true);
    expect(moved.session.campaign_id).toBe(second.id);
    expect(moved.session.id).not.toBe(joined.session.id);
  });

  it('another TENANT is refused too (OS1): one live session per agent anywhere', async () => {
    // Amended by 0034 (Manas, 2026-11-11): an agent who belongs to two tenants is one person, so a
    // live session in one refuses a join in the other. Was: "a different tenant is unaffected".
    const ours = await insertAgencyCampaign();
    const theirs = await insertAgencyCampaign({ tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT });

    const a = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT,
      campaignId: ours.id, agentUserId: uuidFor('agent-shared'), replicaId: REPLICA,
    });
    await getTestPool().query(`UPDATE agency_agent_sessions SET state = 'on_call' WHERE id = $1`, [a.session.id]);
    const b = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: OTHER_TENANT, accountId: OTHER_ACCOUNT,
      campaignId: theirs.id, agentUserId: uuidFor('agent-shared'), replicaId: 'replica-2',
    });
    const phone = await agencyAgentSessionRepository.joinSoftphone({
      tenantId: OTHER_TENANT, accountId: OTHER_ACCOUNT, agentUserId: uuidFor('agent-shared'), replicaId: 'replica-2',
    });

    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, reason: 'other_tenant', session: { id: a.session.id, tenant_id: TENANT } });
    expect(phone).toMatchObject({ ok: false, reason: 'other_tenant', session: { id: a.session.id } });
    // The live row in the first tenant is untouched: not hijacked by replica-2, not knocked off its call.
    const { rows } = await getTestPool().query<{ state: string; owner_replica: string }>(
      'SELECT state, owner_replica FROM agency_agent_sessions WHERE id = $1', [a.session.id]);
    expect(rows[0]).toEqual({ state: 'on_call', owner_replica: REPLICA });

    // Leaving there frees the agent here.
    await agencyAgentSessionRepository.leave(a.session.id);
    const c = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: OTHER_TENANT, accountId: OTHER_ACCOUNT,
      campaignId: theirs.id, agentUserId: uuidFor('agent-shared'), replicaId: REPLICA,
    });
    expect(c.ok).toBe(true);
  });

  it('concurrent joins in two TENANTS settle to exactly one live session', async () => {
    const ours = await insertAgencyCampaign();
    const theirs = await insertAgencyCampaign({ tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT });
    const agent = uuidFor('agent-tenant-race');
    const results = await Promise.all([
      agencyAgentSessionRepository.joinOrRehydrate({
        tenantId: TENANT, accountId: ACCOUNT, campaignId: ours.id, agentUserId: agent, replicaId: REPLICA,
      }),
      agencyAgentSessionRepository.joinOrRehydrate({
        tenantId: OTHER_TENANT, accountId: OTHER_ACCOUNT, campaignId: theirs.id, agentUserId: agent, replicaId: REPLICA,
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ reason: 'other_tenant' })]);
    const { rows } = await getTestPool().query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL', [agent]);
    expect(rows[0]!.n).toBe(1);
  });

  it('concurrent joins on two campaigns settle to exactly one live session', async () => {
    // The race the single-statement upsert exists for. A check-then-insert passes
    // every sequential test in this file and fails here, because both callers read
    // "nothing live" before either writes.
    const first = await insertAgencyCampaign({ name: 'A' });
    const second = await insertAgencyCampaign({ name: 'B' });

    const results = await Promise.allSettled([
      agencyAgentSessionRepository.joinOrRehydrate({
        tenantId: TENANT, accountId: ACCOUNT,
        campaignId: first.id, agentUserId: uuidFor('agent-race'), replicaId: REPLICA,
      }),
      agencyAgentSessionRepository.joinOrRehydrate({
        tenantId: TENANT, accountId: ACCOUNT,
        campaignId: second.id, agentUserId: uuidFor('agent-race'), replicaId: 'replica-2',
      }),
    ]);

    // Both calls must RESOLVE — a raw 23505 escaping to the caller would be a 500
    // where the contract promises a typed 409. Which one wins is genuinely
    // undecided and deliberately not asserted.
    const settled = results.map((r) => {
      if (r.status === 'rejected') throw r.reason;
      return r.value;
    });
    expect(settled.filter((r) => r.ok)).toHaveLength(1);
    expect(settled.filter((r) => !r.ok)).toHaveLength(1);

    const { rows } = await getTestPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agency_agent_sessions
        WHERE agent_user_id = '${uuidFor('agent-race')}' AND left_at IS NULL`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

// ── The device that holds the station (OS3, 0034) ─────────────────────────────

describe('claimStationDevice — one device holds the station (integration)', () => {
  beforeEach(truncateAll);

  async function session() {
    const campaign = await insertAgencyCampaign();
    const joined = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT, campaignId: campaign.id, agentUserId: uuidFor('agent-device'), replicaId: REPLICA,
    });
    if (!joined.ok) throw new Error('join refused');
    return joined.session;
  }
  const holder = async (id: string) => (await getTestPool().query<{ d: string | null }>(
    'SELECT station_device_id AS d FROM agency_agent_sessions WHERE id = $1', [id])).rows[0]!.d;

  it('the first device claims; the same device reclaims; another is refused and changes nothing', async () => {
    const s = await session();
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-laptop-1', takeOver: false })).toEqual({ ok: true });
    expect(await holder(s.id)).toBe('device-laptop-1');
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-laptop-1', takeOver: false })).toEqual({ ok: true });
    await getTestPool().query(`UPDATE agency_agent_sessions SET client_kind = 'web' WHERE id = $1`, [s.id]);

    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-phone-01', takeOver: false }))
      .toEqual({ ok: false, reason: 'held_elsewhere', client_kind: 'web' });
    expect(await holder(s.id)).toBe('device-laptop-1');
  });

  it('take_over moves it; the old holder is then the one refused (no silent take-back)', async () => {
    const s = await session();
    await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-laptop-1', takeOver: false });
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-phone-01', takeOver: true })).toEqual({ ok: true });
    expect(await holder(s.id)).toBe('device-phone-01');
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-laptop-1', takeOver: false }))
      .toMatchObject({ ok: false, reason: 'held_elsewhere' });
  });

  it('no device id (an older client) is allowed and clears the holder, so the next device claims it', async () => {
    const s = await session();
    await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-laptop-1', takeOver: false });
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: null, takeOver: false })).toEqual({ ok: true });
    expect(await holder(s.id)).toBeNull();
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-phone-01', takeOver: false })).toEqual({ ok: true });
  });

  it('a mint naming no device (an older client) is refused while a device holds it; a join with none clears it', async () => {
    const s = await session();
    // No holder: an older client's mint is allowed, and leaves none.
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: null, takeOver: false }, { reconnect: true })).toEqual({ ok: true });
    expect(await holder(s.id)).toBeNull();
    await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-phone-01', takeOver: true });
    // Held: its reconnect cannot take it back, even asking to take over (take_over needs a device).
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: null, takeOver: false }, { reconnect: true }))
      .toMatchObject({ ok: false, reason: 'held_elsewhere' });
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: null, takeOver: true }, { reconnect: true }))
      .toMatchObject({ ok: false, reason: 'held_elsewhere' });
    expect(await holder(s.id)).toBe('device-phone-01');
    // Its join (the agent going on duty there) still clears it.
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: null, takeOver: false })).toEqual({ ok: true });
    expect(await holder(s.id)).toBeNull();
  });

  it('a left session is session_gone, whatever the device', async () => {
    const s = await session();
    await agencyAgentSessionRepository.leave(s.id);
    expect(await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-laptop-1', takeOver: true }))
      .toEqual({ ok: false, reason: 'session_gone' });
  });

  it('two devices racing without take_over: exactly one holds it', async () => {
    const s = await session();
    const results = await Promise.all([
      agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-laptop-1', takeOver: false }),
      agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-phone-01', takeOver: false }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = results[0]!.ok ? 'device-laptop-1' : 'device-phone-01';
    expect(await holder(s.id)).toBe(winner);
  });

  it('a rehydrating join keeps the holder; a new session after leaving starts with none', async () => {
    const s = await session();
    await agencyAgentSessionRepository.claimStationDevice(s.id, { deviceId: 'device-laptop-1', takeOver: false });
    const again = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT, campaignId: s.campaign_id!, agentUserId: uuidFor('agent-device'), replicaId: REPLICA,
    });
    expect(again.ok && again.session.station_device_id).toBe('device-laptop-1');
    await agencyAgentSessionRepository.leave(s.id);
    const fresh = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT, campaignId: s.campaign_id!, agentUserId: uuidFor('agent-device'), replicaId: REPLICA,
    });
    expect(fresh.ok && fresh.session.station_device_id).toBeNull();
  });
});
