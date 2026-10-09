import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The agent state-transition log (migration 105).
//
// ── What this file is really guarding ──────────────────────────────────────
//
// `agency_agent_sessions` keeps `state` and `state_since` — a SNAPSHOT that every
// transition overwrites — so time-in-state was unrecoverable: "how long was I
// available versus on break versus in wrap-up" had no answer anywhere in the
// schema, for any agent, for any shift. The log is what makes it answerable, and
// it is only as good as its exhaustiveness: **a missed transition does not lose
// one row, it silently corrupts every occupancy number downstream**, because the
// interval before the missing event is stretched to the next event that WAS
// written.
//
// Two properties therefore get assertions here rather than comments:
//
//   1. Every writer of `agency_agent_sessions.state` appends to the log. The four
//      methods below are the only writers in core — the callers are the three
//      session routes, the dialer's bridge and release paths, the wrap-up manager,
//      the two presence paths in `runtime.ts`, and the startup reaper, and every
//      one of them goes through one of these four.
//   2. **The append can NEVER fail the transition.** A dropped event costs one
//      occupancy row; a thrown error mid-transition takes an agent off the floor
//      or wedges a live call. That is why the insert is a second statement rather
//      than a CTE on the first, and it is the last test in this file.
//   3. **Each event carries the MUTATION's timestamp**, projected by the UPDATE
//      that performed it, rather than being stamped by migration 105's `DEFAULT
//      now()` when the log INSERT runs. Property 2 is what creates the gap the
//      timestamp has to close: two statements can complete in the opposite order
//      to the order the database applied them, and `lead(at)` then differences the
//      wrong pairs — the same silent corruption a missed transition causes.
// ---------------------------------------------------------------------------

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { agencyAgentSessionRepository } = await import('../../../src/db/repositories/agency.repository.js');

const EVENTS_TABLE = 'agency_agent_session_events';
const isEventInsert = (sql: unknown): boolean => String(sql).includes(EVENTS_TABLE);

const mutationSql = (): string =>
  String(pool.query.mock.calls.find((c) => !isEventInsert(c[0]))?.[0] ?? '');
const eventCall = (): unknown[] =>
  (pool.query.mock.calls.find((c) => isEventInsert(c[0])) ?? []) as unknown[];
const eventSql = (): string => String(eventCall()[0] ?? '');
const eventParams = (): unknown[][] => (eventCall()[1] ?? []) as unknown[][];
const eventCount = (): number => pool.query.mock.calls.filter((c) => isEventInsert(c[0])).length;

/** The instant the fixture's mutation happened. */
const MUTATED_AT = new Date('2026-08-19T09:00:00.000Z');

/**
 * One transition row, as the UPDATE's `RETURNING` produces it.
 *
 * `from_state` comes from the `FROM (SELECT …)` subquery — the row as it was
 * BEFORE the write, read in the SAME statement so there is no window in which
 * another replica could move the agent and make the log record a transition that
 * never happened.
 */
function transition(patch: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    tenant_id: 't1',
    account_id: 'a1',
    campaign_id: 'camp-1',
    agent_user_id: 'u-ravi',
    from_state: 'available',
    from_break_reason: null,
    to_state: 'on_call',
    break_reason: null,
    // `clock_timestamp()` projected by the UPDATE that performed the transition —
    // the instant the state actually changed, not the instant the log INSERT runs.
    at: MUTATED_AT,
    ...patch,
  };
}

/** Serve the mutation's RETURNING rows; the event insert always succeeds. */
function serve(rows: unknown[]): void {
  pool.query.mockImplementation((sql: unknown) =>
    Promise.resolve(isEventInsert(sql)
      ? { rows: [], rowCount: rows.length }
      : { rows, rowCount: rows.length }));
}

beforeEach(() => {
  pool.query.mockReset();
  warn.mockReset();
  serve([transition()]);
});

// ─── the write reads both sides of the transition ───────────────────────────

describe('setState records the transition it just performed', () => {
  it('reads the PREVIOUS state in the same statement as the write', async () => {
    await agencyAgentSessionRepository.setState('sess-1', 'on_call');
    const sql = mutationSql();
    // A `SELECT` before the `UPDATE` would have a window in it, so the pre-image
    // is read inside the same statement — and read `FOR UPDATE`, which is the part
    // that matters. A plain subquery reads the statement's OPENING snapshot, so a
    // writer that blocks on another's row lock still reports the value from before
    // the wait and logs a transition out of a state the agent had already left.
    // A locking read follows the update chain and sees what the winner committed.
    // The behaviour itself is pinned in test/integration/agency/
    // agent-transition-ordering.test.ts, which holds a real lock; this only guards
    // the clause from being dropped.
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toMatch(/WITH prev AS \(\s*SELECT id, state, break_reason FROM agency_agent_sessions WHERE id = \$1 FOR UPDATE/);
    expect(sql).toContain('prev.state AS from_state');
    expect(sql).toContain('s.state AS to_state');
    // The mirror's own behaviour is unchanged — the log is additive.
    expect(sql).toContain('state_since = now()');
  });

  it('appends one event carrying the identity the occupancy read needs', async () => {
    await agencyAgentSessionRepository.setState('sess-1', 'on_call');
    expect(eventCount()).toBe(1);
    expect(eventSql()).toContain('INSERT INTO agency_agent_session_events');
    // Denormalised deliberately (migration 105): the occupancy read is per PERSON
    // and cross-campaign, so carrying `agent_user_id`/`campaign_id` here is what
    // lets it avoid a join back to the session for two immutable strings.
    expect(eventSql()).toContain('agent_user_id');
    expect(eventSql()).toContain('campaign_id');
    expect(eventParams()).toEqual([
      ['sess-1'], ['t1'], ['a1'], ['camp-1'], ['u-ravi'],
      ['available'], ['on_call'], [null], [MUTATED_AT],
    ]);
  });

  it('carries break_reason only INTO break', async () => {
    serve([transition({ from_state: 'available', to_state: 'break', break_reason: 'lunch' })]);
    await agencyAgentSessionRepository.setState('sess-1', 'break', 'lunch');
    expect(eventParams()[7]).toEqual(['lunch']);

    // Returning from a break: the session COLUMN still holds the last reason, and
    // copying it onto the `available` event would label that interval with a
    // reason belonging to a different one.
    pool.query.mockReset();
    serve([transition({ from_state: 'break', from_break_reason: 'lunch', to_state: 'available', break_reason: 'lunch' })]);
    await agencyAgentSessionRepository.setState('sess-1', 'available');
    expect(eventParams()[6]).toEqual(['available']);
    expect(eventParams()[7]).toEqual([null]);
  });

  it('writes nothing when the transition moved nothing', async () => {
    // A double-click on Available, or a release into a pool the agent is already
    // in. A zero-length interval sums correctly and reads as noise.
    serve([transition({ from_state: 'available', to_state: 'available' })]);
    await agencyAgentSessionRepository.setState('sess-1', 'available');
    expect(eventCount()).toBe(0);
  });

  it('DOES write when only the break reason changed', async () => {
    // `break → break` with a different reason is a real transition: it is the
    // difference between "Lunch" and "Technical issue" on the same agent's shift.
    serve([transition({
      from_state: 'break', from_break_reason: 'lunch', to_state: 'break', break_reason: 'training',
    })]);
    await agencyAgentSessionRepository.setState('sess-1', 'break', 'training');
    expect(eventCount()).toBe(1);
    expect(eventParams()[7]).toEqual(['training']);
  });

  it('writes nothing when the session does not exist', async () => {
    serve([]);
    await agencyAgentSessionRepository.setState('sess-gone', 'available');
    expect(eventCount()).toBe(0);
  });
});

// ─── the event carries the MUTATION's instant, not the INSERT's ─────────────

describe('`at` comes from the statement that performed the transition', () => {
  it('projects clock_timestamp() from every mutation and inserts it verbatim', async () => {
    await agencyAgentSessionRepository.setState('sess-1', 'on_call');
    // Migration 105 gives `at` a `DEFAULT now()`. Leaning on it would stamp the
    // event when the LOG write ran — a different statement, a different round
    // trip. `clock_timestamp()` rather than `now()` because `now()` is the
    // TRANSACTION's start instant, so the loser of a row-lock race can hold the
    // earlier timestamp while having performed the later UPDATE.
    expect(mutationSql()).toContain('clock_timestamp() AS at');
    expect(eventSql()).toContain('break_reason, at)');
    expect(eventSql()).toContain('$9::timestamptz[]');
    expect(eventParams()[8]).toEqual([MUTATED_AT]);
  });

  it('survives the two log writes landing in the OPPOSITE order to the mutations', async () => {
    // ── The interleaving this timestamp exists to survive ────────────────────
    //
    // Two transitions on one session, from two replicas or two overlapping
    // requests. The database applies them in one order — that order is what the
    // row lock decides — but the log INSERT is a SECOND statement (deliberately:
    // it must never be able to fail the transition), so the two inserts race and
    // can land either way round.
    //
    // Stamped by the insert, the log would then read `on_call` AFTER `wrapup`.
    // `lead(at) OVER (PARTITION BY session_id ORDER BY at)` differences whatever
    // the timestamps say, so every interval after the inversion is attributed to
    // the wrong state and its duration is wrong by the gap between the two events.
    const dialledAt = new Date('2026-08-19T09:00:00.000000Z');
    const wrappedAt = new Date('2026-08-19T09:07:30.000000Z');
    const mutations = [
      [transition({ from_state: 'available', to_state: 'on_call', at: dialledAt })],
      [transition({ from_state: 'on_call', to_state: 'wrapup', at: wrappedAt })],
    ];
    const inserts: unknown[][][] = [];
    /** The order the rows actually reached the table. */
    const settled: string[] = [];
    let releaseFirstInsert: (() => void) | undefined;

    pool.query.mockImplementation((sql: unknown, params?: unknown) => {
      if (!isEventInsert(sql)) {
        const rows = mutations.shift() ?? [];
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      inserts.push(params as unknown[][]);
      const toState = ((params as unknown[][])[6] as string[])[0]!;
      // The EARLIER transition's insert is held open, so the LATER one reaches
      // the table first. This is the inversion, forced.
      if (inserts.length === 1) {
        return new Promise((resolve) => {
          releaseFirstInsert = (): void => {
            settled.push(toState);
            resolve({ rows: [], rowCount: 1 });
          };
        });
      }
      settled.push(toState);
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    // The statement must actually consume the value — a column list that stopped
    // naming `at` would fall back to the DEFAULT and reinstate the whole defect
    // while the params array below still looked right.
    const earlier = agencyAgentSessionRepository.setState('sess-1', 'on_call');
    const later = agencyAgentSessionRepository.setState('sess-1', 'wrapup');
    await later;
    expect(inserts).toHaveLength(2);
    // The inversion is the PRECONDITION, not the property: the inserts were issued
    // in mutation order (`on_call` then `wrapup`), and the LATER one is the one
    // that reached the table first because the earlier one is still held open.
    expect(inserts.map((p) => (p[6] as string[])[0])).toEqual(['on_call', 'wrapup']);
    expect(settled).toEqual(['wrapup']);
    expect(eventSql()).toContain('break_reason, at)');
    expect(eventSql()).toContain('$9::timestamptz[]');

    releaseFirstInsert?.();
    await earlier;
    expect(settled).toEqual(['wrapup', 'on_call']);

    // ...and each row nonetheless carries its OWN mutation's instant, so ordering
    // the table by `at` recovers the sequence the database actually applied.
    expect(inserts[0]![8]).toEqual([dialledAt]);
    expect(inserts[1]![8]).toEqual([wrappedAt]);
    const byAt = inserts
      .map((p) => ({ at: (p[8] as Date[])[0]!, to: (p[6] as string[])[0]! }))
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((e) => e.to);
    expect(byAt).toEqual(['on_call', 'wrapup']);
  });
});

// ─── the other three writers ────────────────────────────────────────────────

describe('leave', () => {
  it('logs the offline transition that CLOSES the agent\'s last interval', async () => {
    serve([transition({ from_state: 'wrapup', to_state: 'offline' })]);
    await agencyAgentSessionRepository.leave('sess-1');
    expect(mutationSql()).toContain('left_at = now()');
    // Without this event the last interval stays open and runs to the end of every
    // window it is read in.
    expect(eventParams()[5]).toEqual(['wrapup']);
    expect(eventParams()[6]).toEqual(['offline']);
  });

  it('logs nothing on a repeated leave', async () => {
    // `left_at IS NULL` on the UPDATE is what makes the second leave a no-op: it
    // matches no row, so RETURNING yields nothing and there is nothing to log.
    // Asserted against the statement AFTER it has been issued — the same check run
    // before the call reads the empty string and cannot fail.
    serve([]);
    await agencyAgentSessionRepository.leave('sess-1');
    const sql = mutationSql();
    expect(sql).toContain('s.left_at IS NULL');
    // A guard that ran the other way round would UPDATE the already-left row,
    // restamp `left_at`, and log a second `offline` event that closes an interval
    // which was closed hours ago.
    expect(sql).not.toContain('left_at IS NOT NULL');
    expect(eventCount()).toBe(0);
  });
});

describe('markAllOffline (the startup reaper)', () => {
  it('logs one event per swept session and returns the count it wrote', async () => {
    // This is the transition that closes every interval the CRASHED process left
    // open. Without it an agent who was `on_call` when the replica died has an
    // interval running to the end of the window — the whole outage charged to
    // their on-call time.
    const sweptAt2 = new Date('2026-08-19T09:00:00.000123Z');
    serve([
      transition({ session_id: 'sess-1', from_state: 'on_call', to_state: 'offline' }),
      transition({
        session_id: 'sess-2', agent_user_id: 'u-asha', from_state: 'break',
        from_break_reason: 'lunch', to_state: 'offline', at: sweptAt2,
      }),
    ]);
    const swept = await agencyAgentSessionRepository.markAllOffline();
    expect(swept).toBe(2);
    // One statement for the whole floor: a query per agent would make the boot
    // reaper's cost scale with the roster, on a path that runs before the pacing
    // supervisor may start.
    expect(eventCount()).toBe(1);
    expect(eventParams()[0]).toEqual(['sess-1', 'sess-2']);
    expect(eventParams()[4]).toEqual(['u-ravi', 'u-asha']);
    expect(eventParams()[5]).toEqual(['on_call', 'break']);
    expect(eventParams()[6]).toEqual(['offline', 'offline']);
    // The batch is ONE statement but the timestamps are per row — `clock_timestamp()`
    // in the RETURNING list, not one `now()` for the whole sweep — and each row's
    // own value is what reaches the log.
    expect(eventParams()[8]).toEqual([MUTATED_AT, sweptAt2]);
  });

  it('logs nothing when the floor was already offline', async () => {
    serve([]);
    expect(await agencyAgentSessionRepository.markAllOffline()).toBe(0);
    expect(eventCount()).toBe(0);
  });
});

describe('joinOrRehydrate', () => {
  const PARAMS = {
    tenantId: 't1', accountId: 'a1', campaignId: 'camp-1',
    agentUserId: 'u-ravi', replicaId: 'r1',
  };
  const session = (patch: Record<string, unknown> = {}) => ({
    id: 'sess-1', tenant_id: 't1', account_id: 'a1', campaign_id: 'camp-1',
    agent_user_id: 'u-ravi', state: 'break', break_reason: null, state_since: new Date(),
    owner_replica: 'r1', last_heartbeat: new Date(), joined_at: new Date(),
    left_at: null, created_at: new Date(), updated_at: new Date(),
    from_state: null, from_break_reason: null,
    ...patch,
  });

  it('reads the pre-upsert row through a CTE, because RETURNING gives the NEW one', async () => {
    serve([session()]);
    await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);
    const sql = mutationSql();
    expect(sql).toContain('WITH prev AS (');
    expect(sql).toContain('LEFT JOIN prev ON prev.id = upserted.id');
  });

  it('logs a FRESH join with from_state NULL — the session\'s first transition', async () => {
    serve([session({ from_state: null })]);
    const result = await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);
    expect(result.ok).toBe(true);
    // NULL, not an invented `offline`: the row did not exist, so there is no prior
    // state to name — and it doubles as the session-start marker for the
    // occupancy reader.
    expect(eventParams()[5]).toEqual([null]);
    expect(eventParams()[6]).toEqual(['break']);
  });

  it('logs a REHYDRATE as offline → break (D2)', async () => {
    serve([session({ from_state: 'offline', state: 'break' })]);
    await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);
    expect(eventParams()[5]).toEqual(['offline']);
    expect(eventParams()[6]).toEqual(['break']);
  });

  it('logs nothing when the upsert only refreshed ownership', async () => {
    // A reconnect while the session was already live in a working state moves
    // `owner_replica`/`last_heartbeat` and leaves `state` alone.
    serve([session({ from_state: 'available', state: 'available' })]);
    await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);
    expect(eventCount()).toBe(0);
  });

  it('never leaks the log-only columns onto the returned session record', async () => {
    // `AgencyAgentSessionRecord` is spread into the bootstrap payload, so an extra
    // field here becomes a contract nobody agreed to and one master would start
    // depending on.
    serve([session({ from_state: 'offline' })]);
    const result = await agencyAgentSessionRepository.joinOrRehydrate(PARAMS);
    if (!result.ok) throw new Error('unreachable — narrowing');
    expect(Object.keys(result.session)).not.toContain('from_state');
    expect(Object.keys(result.session)).not.toContain('from_break_reason');
  });
});

// ─── THE property: the log can never break the transition ───────────────────

describe('a failed event write never fails the transition', () => {
  const failEvents = (rows: unknown[]): void => {
    pool.query.mockImplementation((sql: unknown) => (isEventInsert(sql)
      // The realistic shapes: the table absent because migration 105 has not run
      // on this database yet, or its `to_state` CHECK refusing a state added to
      // migration 074 and not to 105.
      ? Promise.reject(new Error('relation "agency_agent_session_events" does not exist'))
      : Promise.resolve({ rows, rowCount: rows.length })));
  };

  it('setState resolves, and the state write still happened', async () => {
    failEvents([transition()]);
    await expect(agencyAgentSessionRepository.setState('sess-1', 'on_call')).resolves.toBeUndefined();
    // The transition reached the database — which is the whole point. Folding the
    // insert into the same statement would have rolled this back, and `on_call`
    // failing to land is an agent stuck off the floor or a call with no mirror.
    expect(mutationSql()).toContain('UPDATE agency_agent_sessions s');
  });

  it('leave, markAllOffline and joinOrRehydrate all survive it too', async () => {
    failEvents([transition({ to_state: 'offline' })]);
    await expect(agencyAgentSessionRepository.leave('sess-1')).resolves.toBeUndefined();
    await expect(agencyAgentSessionRepository.markAllOffline()).resolves.toBe(1);

    failEvents([{
      id: 'sess-1', tenant_id: 't1', account_id: 'a1', campaign_id: 'camp-1',
      agent_user_id: 'u-ravi', state: 'break', break_reason: null, state_since: new Date(),
      owner_replica: 'r1', last_heartbeat: new Date(), joined_at: new Date(),
      left_at: null, created_at: new Date(), updated_at: new Date(),
      from_state: null, from_break_reason: null,
    }]);
    const joined = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: 't1', accountId: 'a1', campaignId: 'camp-1', agentUserId: 'u-ravi', replicaId: 'r1',
    });
    expect(joined.ok).toBe(true);
  });

  it('says so at warn, naming the transition it could not record', async () => {
    // The swallowed error is the ONLY symptom, and a CHECK violation naming the
    // offending state is how the vocabulary drift in migration 105's header
    // becomes discoverable at all.
    failEvents([transition({ from_state: 'available', to_state: 'on_call' })]);
    await agencyAgentSessionRepository.setState('sess-1', 'on_call');
    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('occupancy');
    expect(context['transitions']).toEqual(['available->on_call']);
    expect(context['sessions']).toEqual(['sess-1']);
    expect(context['err']).toBeInstanceOf(Error);
  });
});
