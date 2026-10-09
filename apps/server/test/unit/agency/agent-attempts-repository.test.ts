import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// `GET /agency-agents/:agentUserId/attempts` — the agent-scoped attempt spine.
//
// THE POOL IS MOCKED, so the fixtures supply the column names and no assertion
// here can catch a renamed SQL column. Same split, and the same reason, as
// `agent-stats-repository.test.ts`: the rules this route is built out of live in
// the WHERE clause, not in the mapping, and the mapping is the sibling campaign
// spine's, already covered.
//
// ── Why this file exists at all ────────────────────────────────────────────
//
// The route has no campaign in its path, so there is nothing to run
// `requireOwned` against: `agent_user_id` is master's user id, opaque to core
// (D3), and core cannot tell a real one from a guess. The tenant/account scope is
// therefore a PREDICATE on the session and nothing else enforces it — delete
// `s.tenant_id` and `s.account_id` from the query and any tenant holding an API
// key can read any other tenant's agent by supplying their user id: the whole
// cross-campaign history, phone numbers and dispositions included, returned as a
// 200. Every other read on this surface would fail loudly; this one answers.
//
// That predicate had no test. The assertions below pin it, and they pin the
// BOUND VALUES too — a scope that reads the right column from the wrong variable
// is the same hole with a passing SQL-text assertion over it.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { AgencyAttemptRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { parseAgentAttemptFilters } = await import('../../../src/agency/agent-record.js');

const SCOPE = { tenantId: 't1', accountId: 'a1', agentUserId: 'u-ravi' };
const CAMPAIGN = '11111111-2222-3333-4444-555555555555';

const sql = (): string => String(pool.query.mock.calls[0]?.[0] ?? '');
const values = (): unknown[] => (pool.query.mock.calls[0]?.[1] ?? []) as unknown[];

/**
 * The statement with its `--` comments stripped.
 *
 * Every NEGATIVE assertion runs against this. The query is commented and the
 * comments NAME the columns it deliberately does not use, so `not.toContain(…)`
 * against the raw text would fail on the sentence explaining the choice — and
 * would keep failing until someone deleted the explanation. Same helper, same
 * reason, as `agent-stats-repository.test.ts`.
 */
const executable = (text: string): string => text.replace(/--[^\n]*/g, '');

/** The `$n` a value was bound to, or `undefined` if it was never bound. */
const placeholderOf = (value: unknown): string | undefined => {
  const index = values().indexOf(value);
  return index === -1 ? undefined : `$${index + 1}`;
};

const ATTEMPT_ROW = {
  id: 'att-1', campaign_id: 'camp-1', contact_id: 'con-1', attempt_number: 2,
  phone_e164: '+919876543210', caller_id: '+911111111111',
  agent_user_id: 'u-ravi', reserved_agent_id: 'sess-1',
  state: 'ended', outcome: 'connected', disposition_code: 'sale', notes: null,
  callback_at: null, dispositioned_by_user_id: 'u-ravi', dispositioned_at: new Date(),
  dispositioned_on_behalf: false, webrtc_call_id: null,
  dialed_at: new Date(), answered_at: new Date(), bridged_at: new Date(), ended_at: new Date(),
  talk_seconds: 120, wrapup_seconds: 30, created_at: new Date(),
  cursor_at: '2026-08-18T09:00:00.000000Z',
};

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [ATTEMPT_ROW] });
});

const list = (filters: Record<string, unknown> = {}): Promise<unknown> => {
  const parsed = parseAgentAttemptFilters(filters);
  if (!parsed.ok) throw new Error(`fixture filters were refused: ${JSON.stringify(parsed.issues)}`);
  return new AgencyAttemptRepository().listForAgent({ ...SCOPE, filters: parsed.filters, limit: 50 });
};

// ─── the scope ──────────────────────────────────────────────────────────────

describe('the tenant/account scope is a predicate, and nothing else enforces it', () => {
  it('scopes on the SESSION\'s tenant AND account, both bound to the caller\'s values', async () => {
    await list();
    const text = sql();
    expect(text).toContain('s.tenant_id = ');
    expect(text).toContain('s.account_id = ');
    // Pinned to the VALUES, not just the columns: `s.tenant_id = $n` reading the
    // agent id, or the account predicate reading the tenant, is the same hole
    // with a passing text assertion over it.
    expect(text).toContain(`s.tenant_id = ${placeholderOf(SCOPE.tenantId)}`);
    expect(text).toContain(`s.account_id = ${placeholderOf(SCOPE.accountId)}`);
    expect(text).toContain(`s.agent_user_id = ${placeholderOf(SCOPE.agentUserId)}`);
    // Three distinct placeholders — the caller's three inputs, in the order the
    // conditions are built.
    expect(values().slice(0, 3)).toEqual(['u-ravi', 't1', 'a1']);
  });

  it('scopes on the SESSION rather than the attempt, and joins it INNER', async () => {
    await list();
    const text = executable(sql());
    // The session is what makes the attempt this person's work. Both rows are
    // stamped from the same campaign, so they cannot disagree.
    expect(text).toContain('JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id');
    // ⚠️ INNER, and that is load-bearing rather than incidental. A LEFT JOIN would
    // keep every attempt whose `reserved_agent_id` is NULL — an unreserved dial,
    // which is most of them on a progressive campaign — and NULL columns do not
    // satisfy `s.tenant_id = $2`, so the scope would still hold... until someone
    // moved a predicate into the ON clause, at which point the whole platform's
    // unreserved attempts land on one agent's page. There is no reason to hold a
    // row whose session is absent: the session IS the reason the row belongs here.
    expect(text).not.toContain('LEFT JOIN agency_agent_sessions');
    expect(text).not.toContain('LEFT OUTER JOIN agency_agent_sessions');
  });

  it('every condition is ANDed — no branch can widen the result set', async () => {
    await list({ campaign_id: CAMPAIGN, state: 'ended' });
    const where = executable(sql()).split('WHERE')[1]?.split('ORDER BY')[0] ?? '';
    expect(where).toContain('s.tenant_id');
    expect(where).toContain('s.account_id');
    expect(where).not.toContain(' OR ');
  });
});

// ─── the filters ────────────────────────────────────────────────────────────

describe('the filters', () => {
  it('ignores `filters.agentUserId` and uses the PATH\'s agent', async () => {
    // `agent_user_id` is part of the imported filter vocabulary (the campaign
    // spine has a real use for it) and is deliberately dead here: honouring it
    // would let `?agent_user_id=` contradict `:agentUserId`, and the only thing a
    // contradiction can express on this route is an attempt to read someone else.
    await list({ agent_user_id: 'u-someone-else' });
    expect(values()).not.toContain('u-someone-else');
    expect(sql()).toContain(`s.agent_user_id = ${placeholderOf(SCOPE.agentUserId)}`);
    // ...and the query carries exactly ONE predicate on the column, so the filter
    // cannot have been ANDed in beside the path's.
    expect(executable(sql()).match(/agent_user_id = \$/g)).toHaveLength(1);
  });

  it('filters `campaign_id` WITHOUT relaxing the scope', async () => {
    await list({ campaign_id: CAMPAIGN });
    const text = sql();
    // Cross-campaign is the point of this route, so `campaign_id` is a real filter
    // here rather than the contradictable duplicate it would be on the campaign
    // spine. It NARROWS: the session scope is still what decides whose attempts
    // these are, so a campaign id belonging to another tenant resolves to an empty
    // page rather than to that tenant's rows.
    expect(text).toContain(`a.campaign_id = ${placeholderOf(CAMPAIGN)}::uuid`);
    expect(text).toContain(`s.tenant_id = ${placeholderOf(SCOPE.tenantId)}`);
    expect(text).toContain(`s.account_id = ${placeholderOf(SCOPE.accountId)}`);
    // The cast is on the parameter, so a non-uuid cannot reach `22P02` — but the
    // route's parser refuses one first, which is where the 400 comes from.
    expect(parseAgentAttemptFilters({ campaign_id: 'nope' }).ok).toBe(false);
  });

  it('bounds on `created_at`, and `to` is INCLUSIVE', async () => {
    await list({ from: '2026-08-01', to: '2026-08-08' });
    const text = executable(sql());
    // `dialed_at` is NULL on an attempt that never left the building, so bounding
    // a LIST on it would drop exactly the rows someone chasing a missing dial came
    // to find. Note this is the opposite of the STATS route, which buckets on
    // `dialed_at` precisely because it aggregates dials.
    expect(text).toContain('a.created_at >= ');
    expect(text).toContain('a.created_at <= ');
    // `a.dialed_at` is projected (it is on the row) but must never be a PREDICATE.
    expect(text).not.toContain('a.dialed_at >');
    expect(text).not.toContain('a.dialed_at <');
    // ⚠️ INCLUSIVE, deliberately, and NOT the half-open `<` the stats route uses:
    // this is a "show me up to here" filter, and `?to=2026-08-08` returning
    // nothing from the 8th is the shape a user reads as a bug. `<` would pass a
    // `toContain('a.created_at <')` assertion, so the space is part of the string.
    expect(text).not.toContain('a.created_at < $');
  });

  it('binds the window bounds as parsed Dates, in the order the conditions are built', async () => {
    await list({ from: '2026-08-01', to: '2026-08-08' });
    const text = sql();
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-08T00:00:00.000Z');
    const bound = values().filter((v): v is Date => v instanceof Date);
    expect(bound.map((d) => d.toISOString())).toEqual([from.toISOString(), to.toISOString()]);
    // Matched by identity through the bound list, so a query that swapped the two
    // bounds — answering a window nobody asked for, silently and with rows in it —
    // fails here rather than reading as a passing `>=`/`<=` pair.
    expect(text).toContain(`a.created_at >= ${placeholderOf(bound[0])}`);
    expect(text).toContain(`a.created_at <= ${placeholderOf(bound[1])}`);
  });
});

// ─── the page ───────────────────────────────────────────────────────────────

describe('the page', () => {
  it('orders by the keyset and fetches one extra row to decide `next_cursor`', async () => {
    await list();
    const text = sql();
    expect(text).toContain('ORDER BY a.created_at DESC, a.id DESC');
    // limit + 1: the extra row is how "there is more" is answered without a second
    // query and without a COUNT.
    expect(values()[values().length - 1]).toBe(51);
    expect(text).toContain(`LIMIT $${values().length}`);
  });

  it('projects the agent id from the SESSION, which is the only place it lives', async () => {
    // `agency_call_attempts` has no `agent_user_id` column — it points at a
    // session — so this is the one join that can answer "whose attempt was this".
    const page = await list() as { rows: { agent_user_id: string | null }[] };
    expect(sql()).toContain('s.agent_user_id,');
    expect(page.rows[0]?.agent_user_id).toBe('u-ravi');
  });
});
