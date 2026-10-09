import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeTestPool, closeTestRedis, flushTestRedis, getTestPool, getTestRedis, truncateAll,
} from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContacts } from './agency-factories.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, uuidFor } from '../setup/factories.js';

/*
 * PORT NOTE (magick-agency, Phase 6): ported from core
 * test/integration/agency/agency-double-reservation.test.ts@4850d1d9 — 9 cases, all
 * kept, no assertion weakened. Modified:
 *  - ids: the tenant/account/agent ids are UUID columns now. `TENANT`/`ACCOUNT` are the
 *    shared defaults the factories stamp on rows (core: 'test-tenant'/'test-account');
 *    `ACCOUNT_2`, `AGENT`, 'agent-alice', 'agent-bob' are `uuidFor(<core's label>)`;
 *    'other-tenant'/'other-account' are the shared `OTHER_TENANT`/`OTHER_ACCOUNT`.
 *  - DNC (decision B8): `makeWorld` and the other-tenant case no longer publish an empty
 *    `applyReplace` baseline into a Redis set — the registry is `new DncRegistry()`, a
 *    read of `dnc_entries`, so a tenant with no row is authoritative by construction.
 *    `makeWorld` still asserts the gate's own `check()` answers `clear` (now with the
 *    scope the pre-dial gate passes), which is the half of the guard that mattered.
 *  - the connection mock (agency's `@magick-agency/db`).
 */

// PORT NOTE: core mocked `src/db/connection.js`; agency's pool lives in `@magick-agency/db`
// (the server's repositories import its root, packages/db's repositories `./connection`).
vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {}, // PORT NOTE: core stubbed `telephony.vobiz` (VoBiz deleted, plan §5)
  },
}));

const { PacingEngine } = await import('../../../src/agency/pacing-engine.js');
const { AgentStateMachine } = await import('../../../src/agency/agent-state-machine.js');
const { LocalDialDispatcher } = await import('../../../src/agency/dial-dispatcher.js');
const { DncRegistry } = await import('../../../src/agency/dnc-registry.js');
const { agencyAgentSessionRepository } = await import('../../../src/db/repositories/agency.repository.js');
type DialCommand = import('../../../src/agency/dial-dispatcher.js').DialCommand;

/**
 * ─── THE DOUBLE BRIDGE, DRIVEN THROUGH THE REAL RESERVATION PATH ────────────
 *
 * The defect migration 092 exists for, executed rather than reasoned about.
 *
 * `AgentStateMachine.reserve` compare-and-swaps on `agency:agent:{sessionId}:state`
 * — a key derived from the SESSION. Under 074's `uq_agency_agent_live
 * (campaign_id, agent_user_id)` one human could hold two live sessions on two
 * campaigns of the same tenant, so that human had TWO CAS keys, each perfect and
 * each independently winnable by the pacing tick of its own campaign. The CAS
 * protects a session; nothing protected the person. The result is two customers
 * bridged into one headset — an abandoned call manufactured by the mechanism that
 * exists to prevent abandonment.
 *
 * ── Why this file drives `PacingEngine` and not the index ──────────────────
 *
 * `agency-session-tenant-unique.test.ts` proves the index refuses the second row.
 * That is a claim about Postgres, and it is not the claim that matters to a
 * customer: what matters is that no code path can hand two dials to one pair of
 * ears. So everything here goes through the parts that actually reserve —
 * `joinOrRehydrate` (real Postgres) → `PacingEngine.tickOnce` → `planTick`'s
 * Redis read → `AgentStateMachine.reserve`'s real Lua → `LocalDialDispatcher` —
 * and the assertion is on the DIAL COMMANDS, one per bridge that would have been
 * placed.
 *
 * ── The counterfactual is a test, not a comment ────────────────────────────
 *
 * `reproduces the double bridge under 074's index` restores the pre-092 schema
 * and runs the identical sequence. It must dial the same human TWICE. Two things
 * follow from having it: the defect is documented as executable fact rather than
 * as a migration header's assertion, and every "exactly one dial" assertion in
 * this file is proven load-bearing — they are literally the assertions that fail
 * against the old schema, in the same file, on the same fixture.
 */

const TENANT = DEFAULTS.tenantId; // PORT NOTE: UUID (core: 'test-tenant')
/**
 * TWO ACCOUNTS, one tenant — and that is forced rather than chosen.
 *
 * `uq_agency_campaign_running (tenant_id, account_id) WHERE status = 'running'`
 * (D9, migration 072) allows one running campaign per ACCOUNT, so two campaigns
 * that can dial at the same moment are necessarily in two accounts of the tenant.
 * That is exactly the shape 092's header calls out: `account_id` is deliberately
 * absent from the uniqueness key because "an agent moving between two accounts of
 * the same tenant is exactly the double-bridge case". An account-scoped index
 * would have left the entire reachable population of this defect unprotected.
 */
const ACCOUNT = DEFAULTS.accountId; // PORT NOTE: UUID (core: 'test-account')
const ACCOUNT_2 = uuidFor('test-account-2'); // PORT NOTE: UUID
const AGENT = uuidFor('agent-one-pair-of-ears'); // PORT NOTE: UUID
const REPLICA = 'replica-A';

/**
 * Put the schema back to 092 whatever a counterfactual case did to it.
 *
 * The `UPDATE` is not incidental: a counterfactual has just created the rows 092
 * forbids, and `CREATE UNIQUE INDEX` cannot be built over them — which is the
 * whole reason the migration carries a dedupe step. Closing them wholesale is
 * teardown, not a dedupe: every case truncates in `beforeEach`, so no case ever
 * observes what this leaves behind.
 */
async function restore092(): Promise<void> {
  const pool = getTestPool();
  await pool.query('DROP INDEX IF EXISTS uq_agency_agent_live');
  await pool.query(`UPDATE agency_agent_sessions SET left_at = now() WHERE left_at IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_agent_live_tenant
                      ON agency_agent_sessions (tenant_id, agent_user_id)
                      WHERE left_at IS NULL`);
}

/** The pre-092 world: 074's per-campaign index, which permits the second session. */
const RESTORE_074 = `
  DROP INDEX IF EXISTS uq_agency_agent_live_tenant;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_agent_live
    ON agency_agent_sessions (campaign_id, agent_user_id)
    WHERE left_at IS NULL`;

interface World {
  agents: InstanceType<typeof AgentStateMachine>;
  pacing: InstanceType<typeof PacingEngine>;
  dialed: DialCommand[];
}

/**
 * One replica: real Redis state machine, real DNC registry, real pacing engine,
 * and a dispatcher that records instead of calling a carrier.
 *
 * The dispatcher is the REAL `LocalDialDispatcher` rather than `{ dispatch }` —
 * it is the component that refuses a dial without a pre-dial clearance and a dial
 * for an agent this replica does not own, and a stub would quietly excuse both.
 */
async function makeWorld(): Promise<World> {
  const redis = getTestRedis();
  const agents = new AgentStateMachine(redis, '');

  // Without an applied version every pre-dial check answers `unavailable`, the
  // gate halts, and nothing dials — which is indistinguishable from the fix
  // working. Asserted rather than assumed, exactly as the chaos harness does.
  // PORT NOTE (B8): no baseline to publish — the registry reads `dnc_entries`
  // (core: `new DncRegistry(redis, '')` + `applyReplace({ … members: [] })`).
  const dnc = new DncRegistry();
  if (await dnc.check(TENANT, '+919000000099', { accountId: null, campaignId: null }) !== 'clear') {
    throw new Error('the pre-dial gate still refuses this tenant — every case here would dial nothing');
  }

  const dialed: DialCommand[] = [];
  const dispatcher = new LocalDialDispatcher(REPLICA, async (cmd) => { dialed.push(cmd); });

  // Every session is locally owned by this replica: these cases are about one
  // replica's pacing ticks across two campaigns, not about ownership routing.
  const stations = {
    isLocallyOwned: () => true,
    ownerOf: async () => REPLICA,
    broadcast: () => 0,
    send: () => false,
    sessionIdsForCampaign: () => [] as string[],
  };

  const pacing = new PacingEngine(redis, '', REPLICA, stations as never, agents, dispatcher, dnc);
  return { agents, pacing, dialed };
}

/** A campaign that will actually dial: running, all-day window, contacts on the roster. */
async function dialableCampaign(name: string, accountId: string, contacts = 3) {
  const campaign = await insertAgencyCampaign({ name, status: 'running', account_id: accountId });
  await insertAgencyContacts(campaign.id, contacts, { account_id: accountId });
  return campaign;
}

/** Bring a joined session onto the floor: Redis lease + the durable mirror. */
async function goAvailable(world: World, sessionId: string): Promise<void> {
  await world.agents.set(sessionId, 'available');
  await getTestPool().query(
    `UPDATE agency_agent_sessions SET state = 'available' WHERE id = $1`, [sessionId],
  );
}

async function join(campaignId: string, accountId: string, agentUserId = AGENT) {
  return agencyAgentSessionRepository.joinOrRehydrate({
    tenantId: TENANT, accountId, campaignId, agentUserId, replicaId: REPLICA,
  });
}

/**
 * `joinOrRehydrate` **as it shipped with 074**, verbatim from the commit 092
 * replaces — the only difference is the ON CONFLICT arbiter's name.
 *
 * The counterfactual cases need it because the two halves of this change are
 * coupled through that name, which is the whole subject of the migration's DEPLOY
 * ORDERING note: today's method names `(tenant_id, agent_user_id)` and cannot run
 * against 074's schema at all (asserted below, `42P10`). Reproducing the defect
 * therefore means running the code that was live when the defect was live, not the
 * current code with a different index underneath it.
 */
async function joinPre092(campaignId: string, accountId: string, agentUserId = AGENT) {
  const { rows } = await getTestPool().query<{ id: string; campaign_id: string }>(
    `INSERT INTO agency_agent_sessions
       (tenant_id, account_id, campaign_id, agent_user_id, state, owner_replica, last_heartbeat)
     VALUES ($1, $2, $3, $4, 'break', $5, now())
     ON CONFLICT (campaign_id, agent_user_id) WHERE left_at IS NULL
     DO UPDATE SET owner_replica = EXCLUDED.owner_replica,
                   last_heartbeat = now(),
                   state = CASE WHEN agency_agent_sessions.state = 'offline'
                                THEN 'break' ELSE agency_agent_sessions.state END,
                   updated_at = now()
     RETURNING *`,
    [TENANT, accountId, campaignId, agentUserId, REPLICA],
  );
  return rows[0]!;
}

/** Which human each dial command was routed to — the question the defect is about. */
async function agentsDialedFor(dialed: DialCommand[]): Promise<string[]> {
  const out: string[] = [];
  for (const cmd of dialed) {
    const { rows } = await getTestPool().query<{ agent_user_id: string }>(
      'SELECT agent_user_id FROM agency_agent_sessions WHERE id = $1', [cmd.sessionId],
    );
    out.push(rows[0]!.agent_user_id);
  }
  return out;
}

describe('agency double reservation — one human, two campaigns (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
  });
  afterAll(async () => {
    await restore092();
    await closeTestRedis();
    await closeTestPool();
  });

  it('reproduces the double bridge under 074’s index — the defect, executed', async () => {
    // ── The counterfactual, and the reason every other case here means something.
    //
    // Nothing below is mocked into failing: this is the shipped join path, the
    // shipped pacing tick and the shipped CAS, run against the schema this
    // migration replaces. If it ever stops dialling twice, the rest of this file
    // is asserting a property that the fixture no longer has the power to break.
    const pool = getTestPool();
    await pool.query(RESTORE_074);
    try {
      const world = await makeWorld();
      const campA = await dialableCampaign('A', ACCOUNT);
      const campB = await dialableCampaign('B', ACCOUNT_2);

      const a = await joinPre092(campA.id, ACCOUNT);
      const b = await joinPre092(campB.id, ACCOUNT_2);
      // 074 admits both: the pair is unique within each campaign, and nothing in
      // the schema knows the two rows are the same human.
      expect(b.id, '074’s per-campaign index collapsed the two joins into one row — the counterfactual is no longer the pre-092 world').not.toBe(a.id);
      const { rows: live } = await pool.query(
        `SELECT id FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL`, [AGENT],
      );
      expect(live).toHaveLength(2);

      await goAvailable(world, a.id);
      await goAvailable(world, b.id);

      await world.pacing.tickOnce(campA.id);
      await world.pacing.tickOnce(campB.id);

      // TWO dials, on two attempts, to two customers — for one person.
      expect(world.dialed).toHaveLength(2);
      expect(new Set(world.dialed.map((c) => c.sessionId)).size).toBe(2);
      expect(new Set(world.dialed.map((c) => c.contactId)).size).toBe(2);
      expect(await agentsDialedFor(world.dialed)).toEqual([AGENT, AGENT]);

      // Two live attempt rows, one per bridge, both pointing at this one human.
      expect(new Set(world.dialed.map((c) => c.attemptId)).size).toBe(2);

      // And the mechanism, stated as the migration header states it: TWO CAS keys
      // are held, each won by a different campaign's tick, each perfectly correct
      // about the session it names and blind to the person behind it.
      expect(await world.agents.get(a.id)).toMatchObject({ state: 'reserved' });
      expect(await world.agents.get(b.id)).toMatchObject({ state: 'reserved' });
    } finally {
      await restore092();
    }
  });

  it('the reservation CAS cannot see the human — it is keyed on the session', async () => {
    // Why the fix is in the DATABASE and not in the state machine. Two live
    // sessions for one agent are two keys, and the Lua CAS is atomic on each of
    // them independently: it has no way to learn they are the same pair of ears.
    // Run on real Redis, so this is the script's behaviour rather than a summary
    // of it.
    const pool = getTestPool();
    await pool.query(RESTORE_074);
    try {
      const world = await makeWorld();
      const campA = await dialableCampaign('A', ACCOUNT, 0);
      const campB = await dialableCampaign('B', ACCOUNT_2, 0);
      const a = await joinPre092(campA.id, ACCOUNT);
      const b = await joinPre092(campB.id, ACCOUNT_2);

      await world.agents.set(a.id, 'available');
      await world.agents.set(b.id, 'available');

      expect(await world.agents.reserve(a.id, 'attempt-a')).toBe('reserved');
      expect(await world.agents.reserve(b.id, 'attempt-b')).toBe('reserved');
      // The second reservation of the same HUMAN succeeds; a second reservation
      // of the same SESSION is refused. That asymmetry is the whole defect.
      expect(await world.agents.reserve(a.id, 'attempt-c')).toBe('lost');
    } finally {
      await restore092();
    }
  });

  it('today’s join refuses to run against 074’s schema at all (DEPLOY ORDERING)', async () => {
    // The migration's DEPLOY ORDERING note, asserted: `joinOrRehydrate` names its
    // arbiter, so code and schema are coupled through that NAME and must ship —
    // and revert — together. The failure mode is worth pinning precisely because
    // it is the SAFE one: a loud `42P10` on every join, not a silent second live
    // session. It is also the reason the down migration in 092 is real SQL rather
    // than this repo's usual commented block.
    const pool = getTestPool();
    await pool.query(RESTORE_074);
    try {
      const campaign = await dialableCampaign('A', ACCOUNT, 0);
      await expect(join(campaign.id, ACCOUNT)).rejects.toMatchObject({
        code: '42P10',
      });
    } finally {
      await restore092();
    }
  });

  it('under 092 the same sequence dials the agent exactly ONCE', async () => {
    // The fix, on the fixture that just proved itself capable of failing.
    const world = await makeWorld();
    const campA = await dialableCampaign('A', ACCOUNT);
    const campB = await dialableCampaign('B', ACCOUNT_2);

    const a = await join(campA.id, ACCOUNT);
    const b = await join(campB.id, ACCOUNT_2);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!a.ok) throw new Error('unreachable — narrowing');

    await goAvailable(world, a.session.id);
    // The refusal did not create a row to bring online, and that is the point —
    // there is nothing on campaign B for a tick to find.
    await world.pacing.tickOnce(campA.id);
    await world.pacing.tickOnce(campB.id);

    expect(world.dialed).toHaveLength(1);
    expect(world.dialed[0]!.campaignId).toBe(campA.id);
    expect(await agentsDialedFor(world.dialed)).toEqual([AGENT]);

    // One live session, therefore one CAS key, therefore one reservable agent.
    const { rows } = await getTestPool().query<{ id: string }>(
      `SELECT id FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL`, [AGENT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a.session.id);
    expect(await world.agents.get(a.session.id)).toMatchObject({ state: 'reserved' });
  });

  it('campaign B’s tick finds no candidate while the agent is live on A', async () => {
    // `planTick` reads `findLiveForCampaign`, so the refusal has to be visible to
    // the OTHER campaign's controller and not merely to the join route. Ticked
    // repeatedly because a controller that dialled on, say, the third pass would
    // satisfy a single-tick assertion and still double-bridge in production, where
    // the tick runs at 4 Hz for the length of a shift.
    const world = await makeWorld();
    const campA = await dialableCampaign('A', ACCOUNT);
    const campB = await dialableCampaign('B', ACCOUNT_2);

    const a = await join(campA.id, ACCOUNT);
    if (!a.ok) throw new Error('unreachable');
    expect((await join(campB.id, ACCOUNT_2)).ok).toBe(false);
    await goAvailable(world, a.session.id);

    expect(await agencyAgentSessionRepository.findLiveForCampaign(campB.id)).toEqual([]);
    for (let i = 0; i < 5; i++) await world.pacing.tickOnce(campB.id);
    expect(world.dialed).toHaveLength(0);
  });

  it('leaving the first station lets the agent be dialled on the second', async () => {
    // The escape hatch the 409 points at, proven through the dial path rather
    // than through the row: a fix that made the second campaign permanently
    // undialable for this agent would satisfy every assertion above.
    const world = await makeWorld();
    const campA = await dialableCampaign('A', ACCOUNT);
    const campB = await dialableCampaign('B', ACCOUNT_2);

    const a = await join(campA.id, ACCOUNT);
    if (!a.ok) throw new Error('unreachable');
    await agencyAgentSessionRepository.leave(a.session.id);
    await world.agents.clear(a.session.id);

    const b = await join(campB.id, ACCOUNT_2);
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error('unreachable');
    await goAvailable(world, b.session.id);

    await world.pacing.tickOnce(campB.id);

    expect(world.dialed).toHaveLength(1);
    expect(world.dialed[0]!.campaignId).toBe(campB.id);
    expect(world.dialed[0]!.sessionId).toBe(b.session.id);
  });

  it('a LEFT session is invisible to the tick even while its Redis lease says `available`', async () => {
    // The silently-dead agent, which migration 092's dedupe turns from exotic into
    // routine: it closes sessions out from under agents whose consoles are still
    // open and still renewing. Redis says `available`, the console renders a ready
    // agent — and `findLiveForCampaign` excludes left rows, so the phone never
    // rings. This is the state the route guards and the ping recheck exist to end,
    // and it is asserted here so the reason they exist is executable.
    const world = await makeWorld();
    const campA = await dialableCampaign('A', ACCOUNT);

    const a = await join(campA.id, ACCOUNT);
    if (!a.ok) throw new Error('unreachable');
    await goAvailable(world, a.session.id);
    await agencyAgentSessionRepository.leave(a.session.id);

    // The lease is untouched by `leave` at the database layer — that is precisely
    // the asymmetry.
    expect(await world.agents.get(a.session.id)).toMatchObject({ state: 'available' });

    await world.pacing.tickOnce(campA.id);
    expect(world.dialed).toHaveLength(0);
  });

  it('two agents on two campaigns still dial in parallel', async () => {
    // The control. A constraint that scoped uniqueness to the tenant and the
    // AGENT would look identical to one that accidentally scoped it to the tenant
    // alone — and would idle every campaign but one, across the whole floor.
    const world = await makeWorld();
    const campA = await dialableCampaign('A', ACCOUNT);
    const campB = await dialableCampaign('B', ACCOUNT_2);

    const a = await join(campA.id, ACCOUNT, uuidFor('agent-alice')); // PORT NOTE: UUID
    const b = await join(campB.id, ACCOUNT_2, uuidFor('agent-bob')); // PORT NOTE: UUID
    if (!a.ok || !b.ok) throw new Error('unreachable — two different humans');
    await goAvailable(world, a.session.id);
    await goAvailable(world, b.session.id);

    await world.pacing.tickOnce(campA.id);
    await world.pacing.tickOnce(campB.id);

    expect(world.dialed).toHaveLength(2);
    expect(await agentsDialedFor(world.dialed)).toEqual([uuidFor('agent-alice'), uuidFor('agent-bob')]);
  });

  it('the same agent id in ANOTHER tenant is dialled independently', async () => {
    // The scope decision, driven through the dial path: a shared-services operator
    // id appearing under two tenants is two people as far as this system can tell,
    // and both must keep working. Global uniqueness would also have "fixed" the
    // double bridge — and silently taken one of these two off the floor.
    const world = await makeWorld();
    const ours = await dialableCampaign('ours', ACCOUNT);
    const theirs = await insertAgencyCampaign({
      name: 'theirs', status: 'running',
      tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT, // PORT NOTE: UUIDs
    });
    await insertAgencyContacts(theirs.id, 3, { tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT });

    // The other tenant needs its own DNC baseline — the gate is per tenant.
    // PORT NOTE (B8): no baseline to publish; the other tenant is authoritative with no
    // `dnc_entries` row. Asserted through the gate's own call instead.
    const dnc = new DncRegistry();
    expect(await dnc.check(OTHER_TENANT, '+919000000099', { accountId: OTHER_ACCOUNT, campaignId: theirs.id }))
      .toBe('clear');

    const a = await join(ours.id, ACCOUNT);
    const b = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: OTHER_TENANT, accountId: OTHER_ACCOUNT,
      campaignId: theirs.id, agentUserId: AGENT, replicaId: REPLICA,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');

    await goAvailable(world, a.session.id);
    await goAvailable(world, b.session.id);

    await world.pacing.tickOnce(ours.id);
    await world.pacing.tickOnce(theirs.id);

    expect(world.dialed).toHaveLength(2);
    expect(new Set(world.dialed.map((c) => c.tenantId))).toEqual(new Set([TENANT, OTHER_TENANT]));
  });
});
