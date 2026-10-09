import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, uuidFor } from '../setup/factories.js';

/**
 * ─── ONE LIVE SESSION PER AGENT PER TENANT (migration 093) ──────────────────
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
 * instead of writing, and that a window function picks the right survivor. A
 * mocked pool cannot have an opinion about any of them — it would only replay
 * whatever this file asserted, which is the shape of test that let the original
 * defect ship.
 *
 * ── What the dedupe cases actually run ─────────────────────────────────────
 *
 * The migration file itself, read off disk and split on `-- Down Migration`
 * exactly as node-pg-migrate splits it. Not a transcription: a copy of the SQL in
 * a test proves the copy correct and says nothing about what will run on
 * production data. The index is dropped first because the schema under test now
 * forbids the very rows the dedupe exists to clean up — which is the point, since
 * production has been free to create them for the whole life of the feature.
 *
 * The up half is run inside an explicit transaction on ONE connection, because it
 * opens with `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` and that is only legal in a
 * transaction block. node-pg-migrate supplies one in production; a pooled
 * `pool.query` would not reliably be the same connection, so the harness below
 * mirrors what actually happens rather than what is convenient.
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

describe('agency agent sessions — one live session per tenant (integration)', () => {
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

  it('a different TENANT reusing the same agent id is unaffected', async () => {
    // The scope decision, pinned. Global uniqueness would also be "correct" for
    // the public API layer's ids and would break a shared-services structure that reuses an
    // operator id across tenants.
    const ours = await insertAgencyCampaign();
    const theirs = await insertAgencyCampaign({ tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT });

    const a = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT,
      campaignId: ours.id, agentUserId: uuidFor('agent-shared'), replicaId: REPLICA,
    });
    const b = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: OTHER_TENANT, accountId: OTHER_ACCOUNT,
      campaignId: theirs.id, agentUserId: uuidFor('agent-shared'), replicaId: REPLICA,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.session.id).not.toBe(a.session.id);
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

/*
 * Cases that would exercise
 * MIGRATION 093 — its dedupe UPDATE (window function over pre-093 duplicate
 * sessions), its `-- Up Migration` marker and its `down` — by reading
 * `093_agency_agent_session_tenant_unique.sql` off disk. The baseline carries the
 * END state (`uq_agency_agent_live_tenant`, no dedupe: data migrations are not
 * carried) and there is no 093 file, so they do not exist here (the dedupe keep-`on_call` rule, the
 * same-priority tie-break, the two-contending-`on_call` case, idempotent re-run, the
 * up-marker check and the down-reversal check). The five
 * join-path cases (the index's BEHAVIOUR) are what this file covers.
 */
