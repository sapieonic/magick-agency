import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// `joinOrRehydrate`'s decision loop — the half of it that is NOT SQL.
//
// The SQL is proven against a real Postgres in
// `test/integration/agency/agency-session-tenant-unique.test.ts`; a mocked pool
// cannot have an opinion about whether a partial index arbitrates an
// `ON CONFLICT`. What lives here is everything the method decides AFTER the
// upsert comes back empty, which is pure control flow over an unsynchronised
// second read — and every one of those branches exists because of a race that an
// integration test cannot schedule.
//
// ── The branch this file was added for ─────────────────────────────────────
//
// Zero rows from the upsert means "something live exists and it is not the row we
// proposed". The follow-up `SELECT` is a SEPARATE statement, so by the time it
// runs the world may have moved: the blocker may have left, or a concurrent join
// for the same agent may have landed on the REQUESTED campaign. The second case
// returned `other_campaign` naming the campaign the agent was trying to JOIN —
// an instruction that cannot be followed ("leave the station you are asking
// for"), on the only error path the 1:1 rule makes reachable.
//
// The route's mismatch assertion guards the mirror image on the `ok:true` path,
// and that one is documented as unreachable. This was the reachable half, and it
// had no guard at all.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@magick-agency/db', () => ({
  getPool: () => ({ query }),
  healthCheck: async () => true,
}));

const { agencyAgentSessionRepository } = await import('../../../src/db/repositories/agency.repository.js');

const PARAMS = {
  tenantId: 't1', accountId: 'a1',
  campaignId: 'camp-requested', agentUserId: 'u-agent', replicaId: 'r1',
};

function sessionRow(patch: Record<string, unknown> = {}) {
  return {
    id: 'sess-1', tenant_id: 't1', account_id: 'a1',
    campaign_id: 'camp-requested', agent_user_id: 'u-agent',
    state: 'break', break_reason: null, state_since: new Date(),
    owner_replica: 'r1', last_heartbeat: new Date(),
    joined_at: new Date(), left_at: null, created_at: new Date(), updated_at: new Date(),
    ...patch,
  };
}

/**
 * Script the pool by STATEMENT KIND rather than by call index.
 *
 * Call-index scripting would silently pass if the method stopped issuing one of
 * the two statements — the retry loop's whole subject is how many times each runs.
 */
function script(steps: Array<{ upsert: unknown[]; live?: unknown[] }>) {
  let step = 0;
  query.mockImplementation(async (sql: string) => {
    // The transition-log append. Best-effort, fire-and-continue,
    // and not part of the decision loop this file is about — but it IS a third
    // statement kind, so it is classified explicitly rather than falling into the
    // `live` branch and advancing the script by a step it does not own.
    if (sql.includes('agency_agent_session_events')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO agency_agent_sessions')) {
      const rows = steps[Math.min(step, steps.length - 1)]!.upsert;
      return { rows, rowCount: rows.length };
    }
    const rows = steps[Math.min(step, steps.length - 1)]!.live ?? [];
    step += 1;   // one pass = one upsert + one live read
    return { rows, rowCount: rows.length };
  });
}

const upsertCalls = () => query.mock.calls.filter(([sql]) =>
  String(sql).includes('INSERT INTO agency_agent_sessions')).length;
/** Statements belonging to the decision loop — i.e. not the transition-log append. */
const sessionCalls = () => query.mock.calls.filter(([sql]) =>
  !String(sql).includes('agency_agent_session_events')).length;

beforeEach(() => { vi.clearAllMocks(); });

describe('joinOrRehydrate — what the upsert returning zero rows means', () => {
  it('returns ok:true without a second read when the upsert wrote a row', async () => {
    // The overwhelmingly common path. The follow-up SELECT must not run at all —
    // it is a per-join round trip on the path an agent waits on.
    script([{ upsert: [sessionRow()] }]);

    const result = await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);

    expect(result.ok).toBe(true);
    // One statement in the loop. The transition-log append rides alongside it and
    // is excluded — it is not a round trip the agent's join depends on.
    expect(sessionCalls()).toBe(1);
  });

  it('reports `other_campaign` with the blocking session when the live row is elsewhere', async () => {
    const blocker = sessionRow({ id: 'sess-old', campaign_id: 'camp-other', state: 'on_call' });
    script([{ upsert: [], live: [blocker] }]);

    const result = await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — narrowing');
    expect(result.reason).toBe('other_campaign');
    expect(result.session.campaign_id).toBe('camp-other');
    // One pass: a conflict is a decision, not something to retry into.
    expect(upsertCalls()).toBe(1);
  });

  it('RETRIES rather than conflicting when the live row is on the REQUESTED campaign', async () => {
    // The race: a concurrent join for this agent landed on this campaign between
    // our upsert and our read. That is a rehydrate. Returning `other_campaign`
    // here would tell the agent to leave the station they are trying to reach —
    // the one wording the console's own test asserts can never appear.
    script([
      { upsert: [], live: [sessionRow({ id: 'sess-1', campaign_id: 'camp-requested' })] },
      { upsert: [sessionRow({ id: 'sess-1' })] },
    ]);

    const result = await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable — narrowing');
    expect(result.session.campaign_id).toBe('camp-requested');
    expect(upsertCalls()).toBe(2);
  });

  it('retries when the blocker left in the gap', async () => {
    // The other way to reach the same place: the agent clicked Leave on the old
    // campaign at exactly the wrong moment. Nothing is in the way now, so the
    // join they asked for should succeed rather than 409 against a station they
    // have already left.
    script([
      { upsert: [], live: [] },
      { upsert: [sessionRow()] },
    ]);

    const result = await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);

    expect(result.ok).toBe(true);
    expect(upsertCalls()).toBe(2);
  });

  it('gives up after a bounded number of passes rather than looping forever', async () => {
    // The exit depends on another actor, so the loop cannot be `while (true)`: a
    // client flapping join/leave would otherwise hold the request open.
    script([{ upsert: [], live: [] }]);

    await expect(agencyAgentSessionRepository.joinOrRehydrate(PARAMS)).rejects.toThrow(/could not settle/);
    expect(upsertCalls()).toBe(3);
  });

  it('puts no tenant or agent id in the thrown message', async () => {
    // Fastify serialises an uncaught error's `message` into the 500 body, so
    // anything interpolated here is returned to the caller. Identifiers belong in
    // the log line, not on the wire.
    script([{ upsert: [], live: [] }]);

    await expect(agencyAgentSessionRepository.joinOrRehydrate(PARAMS)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('t1'),
      }),
    );
    await expect(agencyAgentSessionRepository.joinOrRehydrate(PARAMS)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('u-agent'),
      }),
    );
  });
});

describe('joinOrRehydrate — the statement it issues', () => {
  it('arbitrates on the tenant-scoped index and only updates its own campaign', async () => {
    // Pinned as text because both clauses are load-bearing and neither is visible
    // in any return value: the arbiter must be the unique index on the agent's live session (naming a
    // dropped index would fail outright), and the `DO UPDATE … WHERE` is what
    // stops a different-campaign conflict from stamping this replica over a
    // session that may be mid-conversation.
    script([{ upsert: [sessionRow()] }]);

    await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);

    const sql = String(query.mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('ON CONFLICT (tenant_id, agent_user_id) WHERE left_at IS NULL');
    expect(sql).toContain('WHERE agency_agent_sessions.campaign_id = EXCLUDED.campaign_id');
  });
});
