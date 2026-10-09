import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { createContentionPool, insertAgencyCampaign, insertAgentSession } from './agency-factories.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, uuidFor } from '../setup/factories.js';

/**
 * ─── `joinOrRehydrate` AGAINST REAL POSTGRES ────────────────────────────────
 *
 * `test/unit/agency/agency-join-result.test.ts` proves the decision loop over a
 * scripted pool: which branch is taken when the upsert comes back empty. Nothing
 * there can be wrong about SQL, because nothing there runs any. This file is the
 * other half — every claim the method makes about the DATABASE:
 *
 *   * the `ON CONFLICT (tenant_id, agent_user_id) WHERE left_at IS NULL` arbiter
 *     really does match the PARTIAL index `uq_agency_agent_live_tenant`, and really does ignore left rows;
 *   * `DO UPDATE … WHERE campaign_id = EXCLUDED.campaign_id` returns zero rows on
 *     a cross-campaign conflict AND leaves the other campaign's row byte-for-byte
 *     as it was;
 *   * the rehydrate preserves a live state and promotes only `offline`;
 *   * two accounts of ONE tenant conflict (the case the tenant-wide index exists for) while two
 *     tenants do not (the case it deliberately permits);
 *   * genuinely concurrent joins settle to exactly one live session.
 *
 * ── The retry loop, raced on purpose ───────────────────────────────────────
 *
 * The last group drives the loop's three exits with real SQL. The pool is a thin
 * proxy that forwards every statement to the test database and mutates the world
 * BETWEEN the upsert and the follow-up read — which is the unsynchronised gap the
 * loop exists for and the one thing a normal integration test cannot schedule.
 * Every statement still executes against Postgres; only the interleaving is
 * arranged.
 */

const { hook } = vi.hoisted(() => ({
  hook: { after: null as null | ((sql: string) => Promise<void>) },
}));

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({
    query: async (text: unknown, values?: unknown[]) => {
      const sql = typeof text === 'string' ? text : String((text as { text: string }).text);
      const result = await getTestPool().query(sql, values as never);
      if (hook.after) await hook.after(sql);
      return result;
    },
  }),
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

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
const ACCOUNT_2 = uuidFor('test-account-2');
const REPLICA = 'replica-1';

function join(campaignId: string, agentUserId: string, opts: { accountId?: string; tenantId?: string; replicaId?: string } = {}) {
  return agencyAgentSessionRepository.joinOrRehydrate({
    tenantId: opts.tenantId ?? TENANT,
    accountId: opts.accountId ?? ACCOUNT,
    campaignId, agentUserId, replicaId: opts.replicaId ?? REPLICA,
  });
}

async function liveRows(agentUserId: string) {
  const { rows } = await getTestPool().query(
    `SELECT * FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL`,
    [agentUserId],
  );
  return rows;
}

const isUpsert = (sql: string) => sql.includes('INSERT INTO agency_agent_sessions');
const isLiveRead = (sql: string) => sql.includes('SELECT * FROM agency_agent_sessions');

describe('joinOrRehydrate against real Postgres (integration)', () => {
  beforeEach(async () => {
    hook.after = null;
    await truncateAll();
  });
  afterAll(async () => {
    hook.after = null;
    await closeTestPool();
  });

  // ── The arbiter and the partial predicate ─────────────────────────────────

  it('ignores LEFT rows — the arbiter matches the partial index, not a plain unique', async () => {
    // If the ON CONFLICT arbiter did not carry `WHERE left_at IS NULL` it would not
    // match that index at all and every join would 500 (`42P10`). If the INDEX lost
    // the predicate, this is what would break instead: an agent who has ever worked
    // in this tenant could never join again, because their closed sessions would
    // keep conflicting. Three of them, so "the newest closed row" is not what is
    // being tested.
    const campaign = await insertAgencyCampaign();
    for (const day of ['2026-08-13', '2026-08-14', '2026-08-15']) {
      await insertAgentSession(campaign.id, {
        agent_user_id: uuidFor('agent-returning'), state: 'offline', left_at: new Date(`${day}T18:00:00Z`),
      });
    }

    const joined = await join(campaign.id, uuidFor('agent-returning'));

    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('unreachable — narrowing');
    expect(joined.session.state).toBe('break');
    expect(joined.session.left_at).toBeNull();
    expect(await liveRows(uuidFor('agent-returning'))).toHaveLength(1);
    // The closed history is untouched — a rejoin is not a resurrection.
    const { rows } = await getTestPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agency_agent_sessions
        WHERE agent_user_id = '${uuidFor('agent-returning')}' AND left_at IS NOT NULL`,
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });

  it('refuses a second ACCOUNT of the same tenant — the case the tenant-wide index is scoped for', async () => {
    // `account_id` is deliberately absent from the uniqueness key. This is the
    // reachable population of the defect in a system that permits one RUNNING
    // campaign per account: the two campaigns an agent can be double-bridged
    // across are necessarily in two accounts. An account-scoped index would pass
    // every same-account case and protect nobody.
    const first = await insertAgencyCampaign({ name: 'Acct 1 campaign' });
    const second = await insertAgencyCampaign({ name: 'Acct 2 campaign', account_id: ACCOUNT_2 });

    const a = await join(first.id, uuidFor('agent-two-accounts'));
    expect(a.ok).toBe(true);

    const b = await join(second.id, uuidFor('agent-two-accounts'), { accountId: ACCOUNT_2 });

    expect(b.ok).toBe(false);
    if (b.ok) throw new Error('unreachable — narrowing');
    expect(b.reason).toBe('other_campaign');
    expect(b.session.campaign_id).toBe(first.id);
    expect(b.session.account_id).toBe(ACCOUNT);
    expect(await liveRows(uuidFor('agent-two-accounts'))).toHaveLength(1);
  });

  it('leaves the blocking row byte-for-byte unchanged', async () => {
    // The `DO UPDATE … WHERE`'s real job. An unconditional DO UPDATE would return a
    // row (so the caller would see success) after stamping this replica's
    // `owner_replica` and `last_heartbeat` onto a session that may be mid-
    // conversation on another campaign — quietly moving ownership of a live bridge
    // to a replica that holds no audio. Every column is compared rather than the
    // three anyone would think to check.
    const first = await insertAgencyCampaign({ name: 'A' });
    const second = await insertAgencyCampaign({ name: 'B', account_id: ACCOUNT_2 });
    const live = await insertAgentSession(first.id, {
      agent_user_id: uuidFor('agent-untouched'), state: 'on_call', owner_replica: 'replica-bridging',
    });

    const before = (await getTestPool().query('SELECT * FROM agency_agent_sessions WHERE id = $1', [live.id])).rows[0];

    const refused = await join(second.id, uuidFor('agent-untouched'), { accountId: ACCOUNT_2, replicaId: 'replica-thief' });
    expect(refused.ok).toBe(false);

    const after = (await getTestPool().query('SELECT * FROM agency_agent_sessions WHERE id = $1', [live.id])).rows[0];
    expect(after).toEqual(before);
    // And no row was inserted for the campaign that was refused.
    const { rows } = await getTestPool().query(
      'SELECT id FROM agency_agent_sessions WHERE campaign_id = $1', [second.id],
    );
    expect(rows).toEqual([]);
  });

  // ── The rehydrate ─────────────────────────────────────────────────────────

  for (const state of ['available', 'break', 'on_call', 'wrapup', 'reserved'] as const) {
    it(`rehydrating a \`${state}\` session preserves that state`, async () => {
      // A page reload mid-shift. Only `offline` is promoted; knocking a live agent
      // back to `break` would take a working station out of the pool for a refresh,
      // and knocking an `on_call` one back would desynchronise the console from a
      // conversation that is still on the wire.
      const campaign = await insertAgencyCampaign();
      const existing = await insertAgentSession(campaign.id, {
        agent_user_id: uuidFor(`agent-rehydrate-${state}`), state, owner_replica: 'replica-old',
        state_since: new Date('2026-08-16T09:00:00Z'),
      });

      const again = await join(campaign.id, uuidFor(`agent-rehydrate-${state}`), { replicaId: 'replica-new' });

      expect(again.ok).toBe(true);
      if (!again.ok) throw new Error('unreachable — narrowing');
      expect(again.session.id).toBe(existing.id);
      expect(again.session.state).toBe(state);
      expect(again.session.owner_replica).toBe('replica-new');
      // `state_since` is NOT restamped: it is the anchor the supervisor's
      // time-in-state panel and the tick's fairness ordering both read.
      expect(again.session.state_since.toISOString()).toBe('2026-08-16T09:00:00.000Z');
      expect(again.session.joined_at.getTime()).toBe(existing.joined_at.getTime());
      // NOW() is stable to the millisecond; insert + join in the same tick
      // can share a timestamp. owner_replica already proves the UPDATE ran.
      expect(again.session.last_heartbeat.getTime())
        .toBeGreaterThanOrEqual(existing.last_heartbeat.getTime());
    });
  }

  it('promotes an `offline` row to `break`, never straight to `available`', async () => {
    // The engine must not dial into a pool that has not demonstrably re-attached:
    // the agent clicks once to go available. `offline` is the only state the
    // rehydrate rewrites, which is why it gets its own case rather than a row in
    // the table above.
    const campaign = await insertAgencyCampaign();
    const existing = await insertAgentSession(campaign.id, {
      agent_user_id: uuidFor('agent-was-offline'), state: 'offline',
    });

    const again = await join(campaign.id, uuidFor('agent-was-offline'));

    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('unreachable — narrowing');
    expect(again.session.id).toBe(existing.id);
    expect(again.session.state).toBe('break');
  });

  // ── findLiveForAgent ──────────────────────────────────────────────────────

  it('findLiveForAgent is tenant-scoped and blind to left rows', async () => {
    // It is what names the campaign in the 409, so a leak here would put another
    // tenant's campaign name in an error body — and a left row here would tell an
    // agent to leave a station they left yesterday.
    const ours = await insertAgencyCampaign();
    const theirs = await insertAgencyCampaign({ tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT });
    await insertAgentSession(theirs.id, {
      agent_user_id: uuidFor('agent-scoped'), tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT, state: 'on_call',
    });
    const closed = await insertAgentSession(ours.id, {
      agent_user_id: uuidFor('agent-scoped'), state: 'offline', left_at: new Date('2026-08-15T18:00:00Z'),
    });

    expect(await agencyAgentSessionRepository.findLiveForAgent(TENANT, uuidFor('agent-scoped'))).toBeNull();

    const live = await insertAgentSession(ours.id, { agent_user_id: uuidFor('agent-scoped'), state: 'available' });
    const found = await agencyAgentSessionRepository.findLiveForAgent(TENANT, uuidFor('agent-scoped'));
    expect(found?.id).toBe(live.id);
    expect(found?.id).not.toBe(closed.id);
  });

  // ── Real concurrency ──────────────────────────────────────────────────────

  it('eight concurrent joins across eight campaigns settle to exactly one live session', async () => {
    // The race the single-statement upsert exists for: a check-then-insert passes
    // every sequential case in this file and fails here, because every caller reads
    // "nothing live" before any of them writes. Eight rather than two so a fix that
    // merely narrowed the window has to survive more of them.
    const campaigns = [];
    for (let i = 0; i < 8; i++) campaigns.push(await insertAgencyCampaign({ name: `C${i}`, account_id: uuidFor(`acct-${i}`) }));

    const results = await Promise.allSettled(campaigns.map((c, i) =>
      join(c.id, uuidFor('agent-race-8'), { accountId: uuidFor(`acct-${i}`), replicaId: `replica-${i}` })));

    // Every call must RESOLVE: a raw 23505 escaping to the route would be a 500
    // where the contract promises a typed 409.
    const settled = results.map((r) => {
      if (r.status === 'rejected') throw r.reason;
      return r.value;
    });
    expect(settled.filter((r) => r.ok)).toHaveLength(1);
    expect(settled.filter((r) => !r.ok)).toHaveLength(7);
    expect(await liveRows(uuidFor('agent-race-8'))).toHaveLength(1);

    // Every refusal names the SAME campaign — the one that won — rather than
    // whichever row each caller happened to read.
    const winner = settled.find((r) => r.ok)!;
    for (const refusal of settled.filter((r) => !r.ok)) {
      expect(refusal.session.id).toBe(winner.session.id);
    }
  });

  it('eight concurrent joins on ONE campaign all rehydrate the same row', async () => {
    // Two console tabs, or a reconnect racing a fresh join. This is the case that
    // must NOT produce a conflict: every caller is asking for the campaign they are
    // being refused for, and telling them to leave the station they are trying to
    // reach is an instruction that cannot be followed.
    const campaign = await insertAgencyCampaign();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => join(campaign.id, uuidFor('agent-rejoin-8'), { replicaId: `replica-${i}` })),
    );
    const settled = results.map((r) => {
      if (r.status === 'rejected') throw r.reason;
      return r.value;
    });

    expect(settled.every((r) => r.ok)).toBe(true);
    expect(new Set(settled.map((r) => r.session.id)).size).toBe(1);
    expect(await liveRows(uuidFor('agent-rejoin-8'))).toHaveLength(1);
  });

  it('the same agent id in five TENANTS joins five times concurrently', async () => {
    // The scoping decision, pinned as a POSITIVE: a shared-services operator id
    // reused across tenants must keep working, and a global index — which would
    // also have "fixed" the double bridge — would take four of these five off the
    // floor. Concurrent rather than sequential so it is the INDEX being tested and
    // not the order the rows happened to be written in.
    const tenants = [uuidFor('t-a'), uuidFor('t-b'), uuidFor('t-c'), uuidFor('t-d'), uuidFor('t-e')];
    const campaigns = [];
    for (const t of tenants) {
      campaigns.push(await insertAgencyCampaign({ tenant_id: t, account_id: uuidFor(`${t}-acct`) }));
    }

    const settled = await Promise.all(campaigns.map((c, i) =>
      join(c.id, uuidFor('agent-multi-tenant'), { tenantId: tenants[i], accountId: uuidFor(`${tenants[i]}-acct`) })));

    expect(settled.every((r) => r.ok)).toBe(true);
    expect(new Set(settled.map((r) => r.session.id)).size).toBe(5);
    expect(await liveRows(uuidFor('agent-multi-tenant'))).toHaveLength(5);
  });

  it('a genuinely concurrent join and leave leaves at most one live session', async () => {
    // The gap the retry loop is written for, raced rather than scheduled: an agent
    // clicking Leave on campaign A at the same instant a join for campaign B lands.
    // Both orders are legal outcomes — the join may be refused (it saw A) or admitted
    // (it did not) — and neither may produce two live rows or a raw 23505.
    const first = await insertAgencyCampaign({ name: 'A' });
    const second = await insertAgencyCampaign({ name: 'B', account_id: ACCOUNT_2 });
    const pool = createContentionPool(4);
    try {
      for (let round = 0; round < 20; round++) {
        await getTestPool().query('TRUNCATE agency_agent_sessions CASCADE');
        const live = await insertAgentSession(first.id, { agent_user_id: uuidFor('agent-flap'), state: 'break' });

        const [joined] = await Promise.all([
          join(second.id, uuidFor('agent-flap'), { accountId: ACCOUNT_2 }).catch((err: unknown) => err),
          pool.query(`UPDATE agency_agent_sessions SET left_at = now() WHERE id = $1`, [live.id]),
        ]);

        expect(joined, `round ${round}: the join threw instead of resolving`).not.toBeInstanceOf(Error);
        expect((await liveRows(uuidFor('agent-flap'))).length, `round ${round}`).toBeLessThanOrEqual(1);
      }
    } finally {
      await pool.end();
    }
  }, 30_000);

  // ── The retry loop, with the gap arranged ─────────────────────────────────

  it('retries when the blocker LEFT between the upsert and the read', async () => {
    // The agent clicked Leave on the old campaign at exactly the wrong moment. The
    // obstacle is gone by the time we look, so the join they asked for must succeed
    // rather than 409 against a station they have already left.
    const first = await insertAgencyCampaign({ name: 'A' });
    const second = await insertAgencyCampaign({ name: 'B', account_id: ACCOUNT_2 });
    const blocker = await insertAgentSession(first.id, { agent_user_id: uuidFor('agent-gap-left'), state: 'break' });

    let upserts = 0;
    hook.after = async (sql) => {
      if (!isUpsert(sql)) return;
      if (++upserts > 1) return;
      // Between the failed upsert and the follow-up read.
      await getTestPool().query(`UPDATE agency_agent_sessions SET left_at = now() WHERE id = $1`, [blocker.id]);
    };

    const joined = await join(second.id, uuidFor('agent-gap-left'), { accountId: ACCOUNT_2 });

    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('unreachable — narrowing');
    expect(joined.session.campaign_id).toBe(second.id);
    expect(upserts).toBe(2);
    expect(await liveRows(uuidFor('agent-gap-left'))).toHaveLength(1);
  });

  it('retries as a REHYDRATE when the row that landed in the gap is on the requested campaign', async () => {
    // A concurrent join for the same agent landed on the campaign we asked for. That
    // is a rehydrate, and reporting `other_campaign` for it would tell the agent to
    // leave the station they are trying to reach — the only error path the 1:1 rule
    // makes reachable, and the one that had no guard.
    const first = await insertAgencyCampaign({ name: 'A' });
    const second = await insertAgencyCampaign({ name: 'B', account_id: ACCOUNT_2 });
    const blocker = await insertAgentSession(first.id, { agent_user_id: uuidFor('agent-gap-same'), state: 'break' });

    let upserts = 0;
    let landed: string | null = null;
    hook.after = async (sql) => {
      if (!isUpsert(sql)) return;
      if (++upserts > 1) return;
      await getTestPool().query(`UPDATE agency_agent_sessions SET left_at = now() WHERE id = $1`, [blocker.id]);
      const other = await insertAgentSession(second.id, {
        agent_user_id: uuidFor('agent-gap-same'), state: 'available',
        account_id: ACCOUNT_2, owner_replica: 'replica-other',
      });
      landed = other.id;
    };

    const joined = await join(second.id, uuidFor('agent-gap-same'), { accountId: ACCOUNT_2, replicaId: 'replica-mine' });

    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('unreachable — narrowing');
    expect(joined.session.id).toBe(landed);
    // A rehydrate, so the live state survives and this replica takes ownership.
    expect(joined.session.state).toBe('available');
    expect(joined.session.owner_replica).toBe('replica-mine');
    expect(upserts).toBe(2);
    expect(await liveRows(uuidFor('agent-gap-same'))).toHaveLength(1);
  });

  it('gives up after three passes when the blocker keeps flapping', async () => {
    // The exit depends on ANOTHER actor, which is why the loop is bounded rather
    // than `while (true)`: a client flapping join/leave could otherwise hold this
    // request — and a connection — open indefinitely. Driven here by removing the
    // blocker before every read and restoring it before every upsert, which is that
    // pathological client with the timing made deterministic.
    const first = await insertAgencyCampaign({ name: 'A' });
    const second = await insertAgencyCampaign({ name: 'B', account_id: ACCOUNT_2 });
    const blocker = await insertAgentSession(first.id, { agent_user_id: uuidFor('agent-flapper'), state: 'break' });

    let upserts = 0;
    hook.after = async (sql) => {
      if (isUpsert(sql)) {
        upserts++;
        // Vanish, so the follow-up read finds nothing and the loop retries.
        await getTestPool().query(`UPDATE agency_agent_sessions SET left_at = now() WHERE id = $1`, [blocker.id]);
      } else if (isLiveRead(sql)) {
        // Back again, so the next upsert conflicts exactly as the first did.
        await getTestPool().query(`UPDATE agency_agent_sessions SET left_at = NULL WHERE id = $1`, [blocker.id]);
      }
    };

    await expect(join(second.id, uuidFor('agent-flapper'), { accountId: ACCOUNT_2 }))
      .rejects.toThrow(/could not settle/);
    expect(upserts).toBe(3);

    // And nothing was left half-written: the flapping row is still the only live
    // session, and no row was created for the campaign that was never admitted.
    hook.after = null;
    const live = await liveRows(uuidFor('agent-flapper'));
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(blocker.id);
  });
});
