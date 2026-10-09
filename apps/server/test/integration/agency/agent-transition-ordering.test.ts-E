import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyAgentSessionRepository, agencyAgentStatsRepository } =
  await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyCampaign, insertAgentSession, insertAgentSessionEvent,
} = await import('./agency-factories.js');

/**
 * ─── THE TRANSITION LOG ORDERS BY THE MUTATION, NOT BY THE WRITE ────────────
 *
 * Modelled on `test/integration/agency/agency-agent-cas.test.ts` and
 * `agency-migration-093-dedupe.test.ts` — the connection mock and import order
 * from the former, the two-connection `client.query('BEGIN')` idiom from the
 * latter, which is the only way to hold a row lock across statements.
 *
 * ── The claim, and why it needs a real database ──────────────────────────────
 *
 * `recordTransitions` is a SECOND statement, not a CTE on the mutation, and that
 * is deliberate: folding the INSERT into the UPDATE would make any failure of the
 * log — the table absent because 105 has not run, the `to_state` CHECK refusing a
 * seventh state, a disk full — roll back the transition itself. **A dropped event
 * costs one occupancy row; a thrown error mid-transition takes an agent off the
 * floor or wedges a live call.**
 *
 * Being a second statement is exactly what creates the gap the timestamp has to
 * close. Two transitions on one session racing from two replicas take the row lock
 * in one order and reach the log INSERT in whatever order the two round trips
 * happen to complete. Inverted, `lead(at) OVER (PARTITION BY session_id ORDER BY
 * at)` differences the WRONG PAIRS: every state after the inversion is attributed
 * to the wrong interval, and the durations are wrong by the gap between the two
 * events. The log would say the agent went to `wrapup` and then back `on_call`
 * when they did the opposite.
 *
 * So each row carries `clock_timestamp()` projected by its own UPDATE — and
 * `clock_timestamp()` rather than `now()`, because **`now()` is the TRANSACTION's
 * start instant**: the loser of a row-lock race can have begun its transaction
 * first and still perform its UPDATE second, so `now()` can order two racing
 * transitions opposite to the order the database applied them.
 *
 * That last sentence is a claim about Postgres, it is the reason the whole design
 * hangs together, and the unit tier can only assert that the SQL string says
 * `clock_timestamp()`. The first test below proves it directly, with two
 * connections and a real lock.
 *
 * ── ⚠️ THIS FILE HAS NOT BEEN EXECUTED ──────────────────────────────────────
 *
 * No Docker daemon, so `npm run test:integration` could not be run. It type-checks
 * under `tsconfig.test.json` (gated by `npm run lint`). The lock-ordering test is
 * mechanical — it compares two timestamps read from the same rows — and the
 * reconstruction tests assert a chain property derived from the seeded events
 * rather than an absolute duration, so they do not depend on scheduling.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const AGENT = uuidFor('u-ravi');

const EVENTS = 'agency_agent_session_events';

interface EventRow {
  id: string;
  from_state: string | null;
  to_state: string;
  at: Date;
  ctid: string;
}

/**
 * Every event for a session, in PHYSICAL order and in `at` order.
 *
 * `ctid` is the row's physical location, so ordering by it approximates the order
 * the rows were inserted — which is precisely the order the reader must NOT
 * depend on. Reading both orders is what lets a test say "the rows landed one way
 * and reconstruct the other".
 */
async function events(sessionId: string): Promise<{ byInsert: EventRow[]; byAt: EventRow[] }> {
  const { rows } = await getTestPool().query<EventRow>(
    `SELECT id, from_state, to_state, at, ctid::text AS ctid FROM ${EVENTS}
      WHERE session_id = $1`,
    [sessionId],
  );
  // `ctid` is `(block,offset)`. Parsed numerically rather than compared as text,
  // because a lexicographic compare puts `(0,10)` before `(0,2)` — which would
  // silently mis-report the insertion order on any case with more than nine rows
  // and make the "the fixture really did land them backwards" guard below lie.
  const ctidKey = (row: EventRow): number => {
    const [block = '0', offset = '0'] = row.ctid.replace(/[()]/g, '').split(',');
    return Number(block) * 1_000_000 + Number(offset);
  };
  const byInsert = [...rows].sort((a, b) => ctidKey(a) - ctidKey(b));
  const byAt = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  return { byInsert, byAt };
}

/**
 * A session whose starting state is stated EXPLICITLY.
 *
 * `insertAgentSession` defaults to `state: 'available'`, which is right for the
 * dialing suites and wrong here: `recordTransitions` deliberately writes nothing
 * for a transition that moved nothing, so a `setState(id, 'available')` on such a
 * session is a silent no-op and a test that expected an event would be asserting
 * the opposite of the behaviour. `offline` is the honest starting point for a log
 * test — it is what the column itself defaults to in migration 074 — and every
 * case below names it rather than inheriting a fixture's choice.
 */
async function sessionStartingOffline(campaignId: string) {
  return insertAgentSession(campaignId, { agent_user_id: AGENT, state: 'offline' });
}

/** `from_state → to_state` links up when read in `at` order — the whole point. */
function isWellFormedChain(rows: readonly EventRow[]): boolean {
  return rows.every((row, i) => (i === 0 ? true : row.from_state === rows[i - 1]!.to_state));
}

describe('agent transition log ordering (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── The Postgres claim the design rests on ────────────────────────────────

  it('now() can order two lock-racing transactions OPPOSITE to the order applied', async () => {
    // ── The whole argument for `clock_timestamp()`, demonstrated ──────────────
    //
    // Two connections, and the one that begins FIRST is made to perform its UPDATE
    // SECOND by having it wait on the other's row lock. That is not a contrived
    // scenario: it is what happens whenever two replicas mirror a state change and
    // one of them is a fraction slower to reach the row.
    //
    //   A: BEGIN                       ← A's transaction timestamp is EARLIER
    //   B: BEGIN; UPDATE; (holds lock)
    //   A: UPDATE  → blocks on B's lock
    //   B: COMMIT                      ← B's UPDATE is applied FIRST
    //   A: (unblocks) UPDATE; COMMIT   ← A's UPDATE is applied SECOND
    //
    // So `now()` says A before B and the database says B before A. Ordering a log
    // by `now()` therefore reports the states in the wrong sequence, and `lead(at)`
    // differences the wrong pairs. `clock_timestamp()` is read after the row is
    // locked and updated, so it cannot invert.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });

    const a = await getTestPool().connect();
    const b = await getTestPool().connect();
    try {
      // A begins first — this is what fixes A's `now()` as the earlier one.
      await a.query('BEGIN');
      await a.query('SELECT now()');   // materialise A's transaction timestamp

      await b.query('BEGIN');
      // B takes the row lock and reads both clocks.
      // MICROSECONDS, not a timestamptz. node-postgres parses timestamptz into a
      // JS Date, which is millisecond-resolution, so Postgres's microsecond
      // precision is thrown away on the way out — and two lock-racing statements
      // land in the same millisecond often enough that `aWall > bWall` ties and
      // fails (~1 run in 5 locally). Widening it to `>=` is not an option: the
      // sign comparison below needs a STRICT wall ordering, and a tie makes both
      // signs 0. `::bigint` arrives as a string, hence Number().
      const CLOCKS = `now() AS tx, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint AS wall_us`;
      const bRow = await b.query<{ tx: Date; wall_us: string }>(
        `UPDATE agency_agent_sessions SET state = 'on_call', state_since = now()
          WHERE id = $1 RETURNING ${CLOCKS}`,
        [session.id],
      );

      // A's UPDATE now blocks on B's lock. Fired without awaiting so B can commit.
      const aPending = a.query<{ tx: Date; wall_us: string }>(
        `UPDATE agency_agent_sessions SET state = 'wrapup', state_since = now()
          WHERE id = $1 RETURNING ${CLOCKS}`,
        [session.id],
      );

      await b.query('COMMIT');
      const aRow = await aPending;
      await a.query('COMMIT');

      const aTx = aRow.rows[0]!.tx.getTime();
      const bTx = bRow.rows[0]!.tx.getTime();
      const aWall = Number(aRow.rows[0]!.wall_us);
      const bWall = Number(bRow.rows[0]!.wall_us);

      // The database applied B first, then A. `clock_timestamp()` agrees.
      expect(aWall).toBeGreaterThan(bWall);
      // `now()` does not: A's transaction began first, so it reports A as earlier
      // — the inversion. `<=` rather than `<` because two BEGINs within the same
      // clock tick would read equal, and equal is already wrong enough (a tie makes
      // the order non-reproducible, which `carried`'s `e.id DESC` tiebreak exists
      // to paper over and cannot fix).
      expect(aTx).toBeLessThanOrEqual(bTx);
      // Stated as the property rather than as two comparisons: the two clocks
      // disagree about the order, and only one of them matches the database.
      expect(Math.sign(aWall - bWall)).not.toBe(Math.sign(aTx - bTx));

      // The final state is A's, which is what "A applied second" means.
      const { rows } = await getTestPool().query<{ state: string }>(
        'SELECT state FROM agency_agent_sessions WHERE id = $1', [session.id],
      );
      expect(rows[0]?.state).toBe('wrapup');
    } finally {
      a.release();
      b.release();
    }
  });

  it('reads `prev` AFTER waiting on the row lock, not from its own opening snapshot', async () => {
    // ── The deterministic version of the concurrency test at the bottom ───────
    //
    // That one fires two `setState` calls at once and asserts the chain links up.
    // It is a true end-to-end check but it only fails when the two genuinely
    // overlap, so it passes on a warm pool and fails on a cold one — it went green
    // on a full-suite run and red on its own, which is the worst way to learn
    // about a bug. This pins the same property with a lock held by hand.
    //
    // The trap it guards: `prev` used to be a plain `FROM (SELECT …)` subquery, on
    // the reasoning that a subquery reads the statement's snapshot and therefore
    // the pre-UPDATE row. True — and the bug, because under READ COMMITTED that
    // snapshot is taken when the statement STARTS. A writer that then blocks on
    // another's row lock re-checks its own WHERE against the updated row when it
    // unblocks, but does NOT re-evaluate the joined subquery, so `prev` is the
    // value from before the wait. `FOR UPDATE` follows the update chain instead
    // and yields what the previous writer actually left behind.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await sessionStartingOffline(campaign.id as string);
    const id = session.id as string;

    const holder = await getTestPool().connect();
    try {
      // Someone else moves the agent offline → on_call and keeps the lock.
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE agency_agent_sessions SET state = 'on_call', state_since = now() WHERE id = $1`,
        [id],
      );

      // setState's UPDATE starts — taking its snapshot, in which the row still
      // reads `offline` — and then blocks. Not awaited, so the holder can commit.
      const pending = agencyAgentSessionRepository.setState(id, 'wrapup');
      await new Promise((resolve) => setTimeout(resolve, 150));

      await holder.query('COMMIT');
      await pending;
    } finally {
      holder.release();
    }

    const { byAt } = await events(id);
    expect(byAt).toHaveLength(1);
    // `on_call` — what the row actually held when the lock was released. `offline`
    // here is the stale snapshot, and it would name a state the agent had left.
    expect(byAt[0]!.from_state).toBe('on_call');
    expect(byAt[0]!.to_state).toBe('wrapup');
  });

  it('setState stamps `at` from clock_timestamp(), a hair AFTER its own state_since', async () => {
    // `state_since = now()` and `at = clock_timestamp()` are in the same statement
    // and answer different questions: `state_since` is a snapshot the console reads,
    // `at` has to SORT. So `at` is deliberately a hair later than `state_since`
    // rather than equal to it, and the difference is what proves the log is not
    // simply copying the transaction clock.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await sessionStartingOffline(campaign.id as string);

    await agencyAgentSessionRepository.setState(session.id as string, 'available');

    const { rows } = await getTestPool().query<{ at: Date; state_since: Date }>(
      `SELECT e.at, s.state_since FROM ${EVENTS} e
         JOIN agency_agent_sessions s ON s.id = e.session_id
        WHERE e.session_id = $1`,
      [session.id],
    );
    expect(rows).toHaveLength(1);
    // Never earlier. Equality is possible in principle if both read the same
    // microsecond, so this is `>=` — the assertion that matters is the direction.
    expect(rows[0]!.at.getTime()).toBeGreaterThanOrEqual(rows[0]!.state_since.getTime());
  });

  it('sequential transitions carry strictly increasing `at`, and the chain links up', async () => {
    // The baseline the concurrency cases are measured against. Each `setState` is a
    // separate transaction, so each `clock_timestamp()` is strictly later, and the
    // reconstructed chain must be `NULL → available → on_call → wrapup → available`.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await sessionStartingOffline(campaign.id as string);
    const id = session.id as string;

    for (const state of ['available', 'on_call', 'wrapup', 'available'] as const) {
      await agencyAgentSessionRepository.setState(id, state);
    }

    const { byAt } = await events(id);
    expect(byAt.map((r) => r.to_state)).toEqual(['available', 'on_call', 'wrapup', 'available']);
    expect(byAt.map((r) => r.from_state)).toEqual(['offline', 'available', 'on_call', 'wrapup']);
    expect(isWellFormedChain(byAt)).toBe(true);
    // Strictly increasing, so no pair is ambiguous.
    for (let i = 1; i < byAt.length; i++) {
      expect(byAt[i]!.at.getTime()).toBeGreaterThan(byAt[i - 1]!.at.getTime());
    }
  });

  // ── The reader reconstructs from `at`, whatever order rows landed in ───────

  it('reconstructs correctly when the rows land in the OPPOSITE order to the mutations', async () => {
    // ── Simulating the race's OUTCOME deterministically ──────────────────────
    //
    // Forcing two concurrent log INSERTs to land in a chosen physical order is not
    // something a test can do reliably — which is exactly why the design does not
    // depend on it. What CAN be pinned deterministically is the consequence: rows
    // inserted in reverse `at` order must still reconstruct correctly.
    //
    // So the events are seeded in reverse: the LATER transition is inserted first,
    // the earlier one second. Under `ORDER BY at` the chain is right; under any
    // dependence on insertion order — a `lead()` without an ORDER BY, an ordering
    // on `id`, an ordering on physical position — `on_call` and `wrapup` swap and
    // the two durations are exchanged.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-18T09:00:00Z'),
    });

    const onCallAt = new Date('2026-08-18T10:00:00Z');
    const wrapupAt = new Date('2026-08-18T10:45:00Z');
    const offlineAt = new Date('2026-08-18T11:00:00Z');

    // Inserted LAST-FIRST. Note `from_state` is still the truthful one for each
    // transition — the race inverts the WRITES, not the facts each row carries.
    await insertAgentSessionEvent(session, 'offline', offlineAt, { from_state: 'wrapup' });
    await insertAgentSessionEvent(session, 'wrapup', wrapupAt, { from_state: 'on_call' });
    await insertAgentSessionEvent(session, 'on_call', onCallAt, { from_state: null });

    const { byInsert, byAt } = await events(session.id as string);
    // The fixture really did land them backwards — otherwise this test proves
    // nothing and would silently become a duplicate of the sequential case.
    expect(byInsert.map((r) => r.to_state)).toEqual(['offline', 'wrapup', 'on_call']);
    expect(byAt.map((r) => r.to_state)).toEqual(['on_call', 'wrapup', 'offline']);
    expect(isWellFormedChain(byAt)).toBe(true);

    // And the occupancy read agrees: 45 minutes on call, 15 in wrap-up. Swapped,
    // it would be 15 and 45 — both plausible numbers, which is why this needs an
    // assertion rather than a comment.
    const stats = await agencyAgentStatsRepository.stats(
      { tenantId: T, accountId: A, agentUserId: AGENT },
      {
        from: new Date('2026-08-18T00:00:00Z'),
        to: new Date('2026-08-19T00:00:00Z'),
        bucket: 'day',
      },
    );
    expect(stats.totals.occupancy.by_state.on_call).toBe(45 * 60);
    expect(stats.totals.occupancy.by_state.wrapup).toBe(15 * 60);
    expect(stats.totals.occupancy.shift_seconds).toBe(60 * 60);
  });

  it('a tie on `at` is broken reproducibly by id, so `carried` is not a coin flip', async () => {
    // ── Why ties are real rather than theoretical ────────────────────────────
    //
    // `carried` is `DISTINCT ON (e.session_id) … ORDER BY e.session_id, e.at DESC,
    // e.id DESC`, and DISTINCT ON returns whichever row the executor reached first
    // among rows equal on the ORDER BY. Without the `e.id DESC` tiebreak, two events
    // on one session sharing a timestamp make the state carried into the window
    // NON-REPRODUCIBLE between two runs of the same query — one run reports the
    // agent went on break at 08:55, the next reports available.
    //
    // The ties are already in the table: before `at` was carried from the mutation,
    // the batch INSERT took migration 105's `DEFAULT now()`, which is the
    // TRANSACTION timestamp and therefore identical for every row of a
    // `markAllOffline` sweep of the whole floor.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-17T08:00:00Z'),
    });

    const tied = new Date('2026-08-17T08:55:00Z');
    // Two events with the SAME `at`, one `break` and one `available`, both before
    // the window — so exactly one of them is what `carried` hands in.
    const first = await insertAgentSessionEvent(session, 'break', tied, { from_state: null });
    const second = await insertAgentSessionEvent(session, 'available', tied, { from_state: 'break' });
    // Compared with `<` on the canonical lowercase form rather than with
    // `localeCompare`: Postgres orders `uuid` by BYTES, and codepoint order over
    // `[0-9a-f-]` matches that ('0'–'9' are 48–57, 'a'–'f' are 97–102, and the
    // dashes sit at identical positions). A locale collation is free to order
    // digits against letters differently and would make this tiebreak
    // prediction wrong on some hosts and right on others.
    const later = String(first.id) < String(second.id) ? second : first;

    const read = () => agencyAgentStatsRepository.stats(
      { tenantId: T, accountId: A, agentUserId: AGENT },
      {
        from: new Date('2026-08-18T00:00:00Z'),
        to: new Date('2026-08-19T00:00:00Z'),
        bucket: 'day',
      },
    );

    const runs = [await read(), await read(), await read()];
    // Reproducible: three reads of the same rows give the same answer. That is the
    // property, and it is the one a coin flip breaks.
    expect(runs[1]!.totals.occupancy).toEqual(runs[0]!.totals.occupancy);
    expect(runs[2]!.totals.occupancy).toEqual(runs[0]!.totals.occupancy);

    // And it is the higher `id` that wins, which is what `e.id DESC` selects.
    const carriedState = (later as { to_state: string }).to_state;
    const occ = runs[0]!.totals.occupancy;
    expect(occ.by_state[carriedState as 'break' | 'available']).toBe(24 * 3600);
    // The whole window went to exactly one of the two states, not to both.
    const stateSeconds = Object.values(occ.by_state).filter((n) => n > 0);
    expect(stateSeconds).toEqual([24 * 3600]);
  });

  it('two CONCURRENT setState calls produce two events that reconstruct as a chain', async () => {
    // The end-to-end version. The order the two land in is genuinely up to the
    // scheduler, so the assertion is the INVARIANT rather than a sequence: whatever
    // happened, reading by `at` yields a chain whose `from_state` links match, and
    // the session's final state is the last event's `to_state`.
    //
    // The mutation itself reads `prev` in the SAME statement as the write, so
    // neither event can record a transition that never happened — that is the
    // property being leaned on here, and it is why a chain check is a real
    // assertion and not a tautology.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await sessionStartingOffline(campaign.id as string);
    const id = session.id as string;

    await Promise.all([
      agencyAgentSessionRepository.setState(id, 'on_call'),
      agencyAgentSessionRepository.setState(id, 'wrapup'),
    ]);

    const { byAt } = await events(id);
    expect(byAt).toHaveLength(2);
    expect(isWellFormedChain(byAt)).toBe(true);
    // The first transition comes out of `offline`, the state the session was
    // seeded in — and the mutation reads `prev` in the same statement as the write,
    // so it cannot name a state the session was not actually in.
    expect(byAt[0]!.from_state).toBe('offline');
    expect(new Set(byAt.map((r) => r.to_state))).toEqual(new Set(['on_call', 'wrapup']));

    const { rows } = await getTestPool().query<{ state: string }>(
      'SELECT state FROM agency_agent_sessions WHERE id = $1', [id],
    );
    // The log's last word and the snapshot agree — the check that the log is a
    // record of what happened rather than of what was attempted.
    expect(rows[0]?.state).toBe(byAt[1]!.to_state);
  });

  it('a no-op setState writes no event, so an occupancy read sees no zero-length interval', async () => {
    // `recordTransitions` filters to rows that actually MOVED. A `setState` to the
    // state the session is already in — a double-click on Available, a release into
    // a pool the agent is already in — would otherwise log a zero-length interval,
    // which sums correctly and reads as noise. Proven against the table rather than
    // against the mock's call count.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await sessionStartingOffline(campaign.id as string);
    const id = session.id as string;

    // The first is a real move (offline → available); the next two are not.
    await agencyAgentSessionRepository.setState(id, 'available');
    await agencyAgentSessionRepository.setState(id, 'available');
    await agencyAgentSessionRepository.setState(id, 'available');

    const { byAt } = await events(id);
    expect(byAt.map((r) => r.to_state)).toEqual(['available']);
  });

  it('a break→break with a DIFFERENT reason IS a transition and is logged', async () => {
    // The other side of the same filter: the comparison includes the reason, so
    // moving from a `lunch` break to a `training` break is a real transition even
    // though the state did not change. Losing it would stretch the first break's
    // interval over the second and label the whole span with the wrong reason.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
    const id = session.id as string;

    await agencyAgentSessionRepository.setState(id, 'break', 'lunch');
    await agencyAgentSessionRepository.setState(id, 'break', 'lunch');     // no-op
    await agencyAgentSessionRepository.setState(id, 'break', 'training');  // a move

    const { rows } = await getTestPool().query<{ to_state: string; break_reason: string | null }>(
      `SELECT to_state, break_reason FROM ${EVENTS} WHERE session_id = $1 ORDER BY at`,
      [id],
    );
    expect(rows).toEqual([
      { to_state: 'break', break_reason: 'lunch' },
      { to_state: 'break', break_reason: 'training' },
    ]);
  });

  it('leave logs the offline transition that CLOSES the last interval, and only once', async () => {
    // An unlogged leave leaves the agent's final interval open, running to
    // `min(now, bucket_end)` forever — so a shift that ended at 17:00 keeps
    // accruing `on_call` all night. The repeated-leave guard is
    // `WHERE s.id = $1 AND s.left_at IS NULL`, which returns zero rows the second
    // time and therefore logs nothing.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
    const id = session.id as string;

    await agencyAgentSessionRepository.setState(id, 'on_call');
    await agencyAgentSessionRepository.leave(id);
    await agencyAgentSessionRepository.leave(id);

    const { byAt } = await events(id);
    expect(byAt.map((r) => r.to_state)).toEqual(['on_call', 'offline']);
    expect(byAt[1]!.from_state).toBe('on_call');
    expect(isWellFormedChain(byAt)).toBe(true);
  });

  it('a transition survives even when the log INSERT cannot run', async () => {
    // ── The asymmetry the whole design turns on ──────────────────────────────
    //
    // The insert is best-effort BECAUSE the consequences are not symmetric: a
    // dropped event costs one occupancy row, while a thrown error mid-transition
    // takes an agent off the floor or wedges a live call — `releaseAgent` would not
    // return them to the pool, `enter` would not put them in wrap-up, `leave` would
    // strand a session the tenant-unique index then blocks them from re-joining.
    //
    // The unit tier proves the catch by making a mock reject. This proves it
    // against the real failure the migration's header names: the events table
    // ABSENT because 105 has not run on this database yet. Dropping the table is the
    // only faithful way to reproduce that, and it is restored immediately.
    const campaign = await insertAgencyCampaign({ status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
    const id = session.id as string;

    await getTestPool().query(`ALTER TABLE ${EVENTS} RENAME TO ${EVENTS}_parked`);
    try {
      // Resolves. This is the assertion.
      await expect(agencyAgentSessionRepository.setState(id, 'on_call')).resolves.toBeUndefined();
      // And the state write really happened — the transition was not rolled back.
      const { rows } = await getTestPool().query<{ state: string }>(
        'SELECT state FROM agency_agent_sessions WHERE id = $1', [id],
      );
      expect(rows[0]?.state).toBe('on_call');
    } finally {
      await getTestPool().query(`ALTER TABLE ${EVENTS}_parked RENAME TO ${EVENTS}`);
    }

    // The occupancy read degrades to zeros rather than failing the whole record —
    // the read-side counterpart of the same decision. The interval is simply
    // missing, which is the documented cost.
    const { byAt } = await events(id);
    expect(byAt).toEqual([]);
  });
});
