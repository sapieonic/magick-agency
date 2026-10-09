import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The eleven supervisor fields on the stats payload.
//
// Two holes, and they need different assertions — the same split
// `campaign-stats-contract.test.ts` documents, applied to a payload where the
// arithmetic is now the interesting part:
//
//   1. **The producer not writing a declared field.** A compile error, because
//      `stats()` returns `Omit<AgencyCampaignStats, 'campaign_id' | 'status'>`.
//      Nothing here needs to assert it.
//   2. **The producer reading its own SQL by string key.** THE POOL IS MOCKED, so
//      the fixture below supplies the column names. A renamed or dropped SQL
//      column therefore CANNOT fail a mapper assertion — the mapper would read
//      `undefined` off a key the fixture still provides under its old name and
//      return a confident number.
//
// So every metric is asserted twice, and neither half is redundant:
//
//   * against the SQL TEXT, for the predicate that defines it — `bridged_at`
//     rather than `outcome`, `ended_at - bridged_at` rather than `talk_seconds`,
//     the three wrap-up resolutions rather than five, the imported abandonment
//     predicate rather than a second copy;
//   * against the MAPPED OUTPUT, from a fixture giving every column a DISTINCT
//     value, so reading the right count off the wrong key fails.
//
// A fixture of zeros or of repeated numbers would pass a mis-wired mapper, and a
// mapper assertion alone would pass a query that measures the wrong thing.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { AgencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { ABANDONED_ATTEMPT_PREDICATE_SQL } = await import('@magick-agency/domain/abandonment-predicate');
const { DEFAULT_ABANDONMENT_CEILING_PCT } = await import('../../../src/agency/campaign-config.js');

/** The scalar-aggregate statement — the one that must stay single. */
const aggregateSql = (): string => {
  const call = pool.query.mock.calls.find((c) => !String(c[0]).includes('agency_agent_sessions s'));
  return String(call?.[0] ?? '');
};
const aggregateParams = (): unknown[] => {
  const call = pool.query.mock.calls.find((c) => !String(c[0]).includes('agency_agent_sessions s'));
  return (call?.[1] ?? []) as unknown[];
};
/**
 * The statement with its `--` comments stripped.
 *
 * Every NEGATIVE assertion runs against this. The query is heavily commented, and
 * those comments name the columns the query deliberately does NOT read — so
 * `not.toContain('talk_seconds')` against the raw text fails on the sentence
 * explaining why `talk_seconds` is wrong, and would keep failing until someone
 * deleted the explanation.
 */
const executable = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/** The roster statement — the deliberate second round trip. */
const rosterSql = (): string => {
  const call = pool.query.mock.calls.find((c) => String(c[0]).includes('agency_agent_sessions s'));
  return String(call?.[0] ?? '');
};

/**
 * Every column distinct. pg returns `int8` as a string and `AVG` as a numeric
 * string, so the fixture is strings throughout — a fixture of numbers would let a
 * mapper that forgot `Number()` ship pg strings to the dashboard.
 */
const ROW: Record<string, string> = {
  contacts_total: '100',
  contacts_pending: '11',
  contacts_in_flight: '12',
  contacts_completed: '13',
  contacts_suppressed: '14',
  contacts_exhausted: '15',
  retries_pending: '16',
  attempts_live: '17',
  attempts_total: '80',
  attempts_connected: '19',
  agents_live: '20',
  answered_24h: '200',
  abandoned_24h: '6',

  human_connects: '31',
  machine_connects: '32',
  machine_connects_available: 'true',
  aht_seconds: '33.5',
  aht_seconds_including_machine: '34.5',
  avg_wrapup_seconds: '35.5',

};

const ROSTER = [
  {
    session_id: 'sess-1',
    agent_user_id: 'agent-on-call',
    state: 'on_call',
    state_since: new Date('2026-08-14T10:00:00.000Z'),
    break_reason: null,
    calls_handled: '7',
  },
  {
    session_id: 'sess-2',
    agent_user_id: 'agent-wrapup',
    state: 'wrapup',
    state_since: new Date('2026-08-14T10:05:00.000Z'),
    break_reason: null,
    calls_handled: '3',
  },
  {
    session_id: 'sess-3',
    agent_user_id: 'agent-lunch',
    state: 'break',
    state_since: new Date('2026-08-14T09:30:00.000Z'),
    break_reason: 'lunch',
    calls_handled: '0',
  },
  {
    session_id: 'sess-4',
    agent_user_id: 'agent-also-on-call',
    state: 'on_call',
    state_since: new Date('2026-08-14T10:07:00.000Z'),
    break_reason: null,
    calls_handled: '12',
  },
];

/** Serve the aggregates or the roster by which statement asked. */
const serve = (row: Record<string, string> | null, roster: unknown[] = ROSTER): void => {
  pool.query.mockImplementation((sql: unknown) =>
    Promise.resolve(
      String(sql).includes('agency_agent_sessions s')
        ? { rows: roster }
        : { rows: row === null ? [] : [row] },
    ),
  );
};

beforeEach(() => {
  pool.query.mockReset();
  serve(ROW);
});

const stats = () => new AgencyCampaignRepository().stats('camp-1');

// ─── how the query is shaped ────────────────────────────────────────────────

describe('the connect split is gated on the bridge, not on the outcome', () => {
  it('counts both connect halves on bridged_at, never on outcome', async () => {
    await stats();
    const sql = aggregateSql();

    // `bridged_at` is the instant media joined the two parties and is the same
    // gate `disposition.ts` uses to decide there was a conversation to write up.
    // `outcome = 'connected'` is a classification that can be absent, late, or
    // present on a call no agent ever heard — using it would count calls nobody
    // handled as handled.
    for (const alias of ['AS human_connects', 'AS machine_connects']) {
      const subquery = executable(
        sql.slice(sql.lastIndexOf('(SELECT', sql.indexOf(alias)), sql.indexOf(alias)),
      );
      expect(subquery, alias).toContain('bridged_at IS NOT NULL');
      expect(subquery, alias).not.toContain("outcome = 'connected'");
    }
  });

  it('splits the two halves on the voicemail disposition, bound as a parameter', async () => {
    await stats();

    // AMD is out of scope (D1), so an agent's own write-up is the ONLY signal that
    // a machine answered. The code is bound rather than inlined so the count, its
    // complement, both AHT variants and the previous-hour twins cannot come to
    // spell it differently.
    expect(aggregateSql()).toContain('disposition_code IS DISTINCT FROM $3');
    expect(aggregateSql()).toContain('disposition_code = $3');
    expect(aggregateParams()[2]).toBe('voicemail');
  });

  it('reports whether the campaign catalog even offers the code', async () => {
    await stats();
    const sql = aggregateSql();

    // Without a `voicemail` entry an agent cannot submit one, so `machine_connects`
    // is structurally 0 and measures nothing. The console has to be able to say so
    // rather than render a confident zero.
    expect(sql).toContain('disposition_catalog');
    expect(sql).toContain('jsonb_array_elements');
    expect(sql).toContain("e->>'code' = $3");
  });
});

describe('AHT measures the agent leg, not the persisted talk time', () => {
  it('averages ended_at - bridged_at and never reads talk_seconds', async () => {
    await stats();
    const sql = aggregateSql();

    // `talk_seconds` is anchored on `answered_at` — the CARRIER's answer — and is
    // nonzero even when no agent ever bridged, because an abandoned attempt settles
    // carrying the apology clip's talk time. Averaging it would fold
    // ring-to-bridge latency and abandoned calls into the one number whose whole
    // purpose is to describe agent work, and it would do so plausibly.
    expect(sql).toContain('AVG(EXTRACT(EPOCH FROM (ended_at - bridged_at)))');
    expect(executable(sql)).not.toContain('talk_seconds');
  });

  it('excludes voicemail from AHT and keeps a raw figure that includes it', async () => {
    await stats();
    const sql = aggregateSql();

    const excluding = executable(sql.slice(
      sql.lastIndexOf('(SELECT', sql.indexOf('AS aht_seconds,')),
      sql.indexOf('AS aht_seconds,'),
    ));
    const including = executable(sql.slice(
      sql.lastIndexOf('(SELECT', sql.indexOf('AS aht_seconds_including_machine')),
      sql.indexOf('AS aht_seconds_including_machine'),
    ));

    // The whole point of the split (D1): a voicemail an agent sat through
    // inflates AHT, so the headline excludes it and the hover figure does not.
    expect(excluding).toContain('disposition_code IS DISTINCT FROM $3');
    expect(including).not.toContain('disposition_code');
    // Both are agent-leg averages over terminal attempts.
    expect(excluding).toContain("state = 'ended'");
    expect(including).toContain("state = 'ended'");
  });
});

describe('average wrap-up is measured, and only from resolutions that mean it', () => {
  it('averages the stamped window, not the configured allotment', async () => {
    await stats();
    const sql = aggregateSql();

    // `wrapup_seconds` is what was OWED — copied from the campaign at wrap-up entry
    // (migration 088). Averaging it hands the operator their own setting back as
    // though it were measurement, which is worse than an absent tile because it
    // always agrees with them.
    expect(sql).toContain('AVG(EXTRACT(EPOCH FROM (wrapup_ended_at - wrapup_started_at)))');
    expect(sql).toContain('wrapup_started_at IS NOT NULL');
    expect(sql).toContain('wrapup_ended_at IS NOT NULL');
  });

  it('averages the three resolutions that measure the work and excludes the three that do not', async () => {
    await stats();
    const sql = aggregateSql();

    // `disposition_submitted` (finished and said so), `auto_return` (used the whole
    // window — the one that argues the allotment is too SHORT) and `agent_returned`
    // (finished early and went available; the fastest wrap-ups there are, and
    // omitting them would build the average only from agents who needed longer).
    expect(sql).toContain(
      "wrapup_resolution IN ('disposition_submitted','auto_return','agent_returned')",
    );
    // `forced` measures a supervisor's patience, `agent_left` an agent vanishing,
    // `campaign_stopped` the campaign ending. All three move the average toward
    // "shorten the allotment" — the opposite of what those events mean.
    for (const excluded of ['forced', 'agent_left', 'campaign_stopped']) {
      expect(executable(sql), `${excluded} must not be averaged`).not.toContain(excluded);
    }
  });
});


describe('the aggregates stay in one statement, the roster is the second', () => {
  it('reads every scalar aggregate in a single statement', async () => {
    await stats();
    const sql = aggregateSql();

    // `now()` is the STATEMENT timestamp in Postgres. Splitting these for
    // readability would let a numerator be measured against a window one tick
    // later than its denominator — which at a boundary is how a rate briefly
    // exceeds 100% and trips a guardrail on arithmetic alone.
    for (const alias of [
      'AS answered_24h', 'AS abandoned_24h',
      'AS human_connects', 'AS machine_connects', 'AS machine_connects_available',
      'AS aht_seconds', 'AS aht_seconds_including_machine', 'AS avg_wrapup_seconds',
    ]) {
      expect(sql, alias).toContain(alias);
    }
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('reads the floor from live sessions only, counting bridged attempts per session', async () => {
    await stats();
    const sql = rosterSql();

    // A LEFT JOIN, so an agent who has handled nothing is still on the floor — an
    // inner join would hide exactly the agent a supervisor is looking for.
    expect(sql).toContain('LEFT JOIN agency_call_attempts');
    expect(sql).toContain('a.reserved_agent_id = s.id');
    // Same bridge gate as the connect counts: an attempt the agent never heard is
    // not an attempt they handled.
    expect(sql).toContain('a.bridged_at IS NOT NULL');
    expect(sql).toContain('s.left_at IS NULL');
    // The break reason is served only while the agent is actually on a break — the
    // column keeps the last one afterwards, and a stale "Lunch" beside an available
    // agent reads as a live fact.
    expect(sql).toContain("CASE WHEN s.state = 'break' THEN s.break_reason END");
    // Unsorted: the console orders by RISK, and a server-side ORDER BY is a second
    // opinion it has to undo.
    expect(executable(sql)).not.toContain('ORDER BY');
  });
});

// ─── how the row is mapped ──────────────────────────────────────────────────

describe('every field is read off its OWN column', () => {
  it('maps the flow metrics from their own keys', async () => {
    const s = await stats();

    // Distinct values per column are what turn a swapped or renamed key into a
    // failure rather than a plausible number. The pool is mocked, so this is the
    // only arm the fixture can police.
    expect(s).toMatchObject({
      human_connects: 31,
      machine_connects: 32,
      machine_connects_available: true,
      aht_seconds: 33.5,
      aht_seconds_including_machine: 34.5,
      avg_wrapup_seconds: 35.5,
    });
    // 31 human connects over 80 attempts.
    expect(s.connect_rate_pct).toBeCloseTo(38.75);
  });


  it('serves the campaign ceiling from the shared constant', async () => {
    const s = await stats();

    // One definition, because the auto-pause fires on the same number.
    // A dashboard drawing its gauge against one threshold while the guardrail
    // enforces another is invisible until an audit.
    expect(s.abandonment_ceiling_pct).toBe(DEFAULT_ABANDONMENT_CEILING_PCT);
    expect(s.abandonment_ceiling_pct).toBe(3);
  });

  it('coerces pg strings to numbers on every numeric field', async () => {
    const s = await stats();

    // A string `'31'` renders as a string and compares as nonsense in a guardrail.
    // Both are silent.
    for (const value of [
      s.human_connects, s.machine_connects, s.aht_seconds, s.avg_wrapup_seconds,
    ]) {
      expect(typeof value).toBe('number');
    }
    expect(typeof s.machine_connects_available).toBe('boolean');
  });
});

describe('the floor, and the breakdown drawn from it', () => {
  it('maps each agent, with the state instant as an ISO string', async () => {
    const s = await stats();

    // The console derives time-in-state and ticks it live, so the server owes the
    // instant — a rendered "8m 41s" is wrong the moment it arrives.
    expect(s.agents).toHaveLength(4);
    expect(s.agents[0]).toEqual({
      // Strict `toEqual` on purpose: a field silently added to the roster row is a
      // wire-contract change that the public API layer proxies unchanged, so it should be a
      // decision here rather than a surprise in the console.
      session_id: 'sess-1',
      agent_user_id: 'agent-on-call',
      state: 'on_call',
      state_since: '2026-08-14T10:00:00.000Z',
      break_reason: null,
      calls_handled: 7,
    });
    expect(s.agents[2]).toMatchObject({ state: 'break', break_reason: 'lunch', calls_handled: 0 });
    // Distinct per agent, so a mapper reading one agent's count onto another fails.
    expect(s.agents.map((a) => a.calls_handled)).toEqual([7, 3, 0, 12]);
  });

  it('reports all six states, zeros included', async () => {
    const s = await stats();

    // A missing key is indistinguishable from zero to a consumer, and the console
    // renders all six. This is the assertion that stops a `GROUP BY`-shaped result
    // being passed through unchanged.
    expect(s.agents_by_state).toEqual({
      offline: 0,
      available: 0,
      reserved: 0,
      on_call: 2,
      wrapup: 1,
      break: 1,
    });
  });

  it('still reports all six states when nobody is on the floor', async () => {
    serve(ROW, []);

    const s = await stats();

    expect(s.agents).toEqual([]);
    expect(Object.values(s.agents_by_state)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('draws the breakdown from the roster it ships, so the two cannot disagree', async () => {
    const s = await stats();

    // Same rows, one observation. Read as its own statement the two could be taken
    // a moment apart, and a supervisor would see a floor of four agents beside a
    // breakdown summing to five.
    const total = Object.values(s.agents_by_state).reduce((a, b) => a + b, 0);
    expect(total).toBe(s.agents.length);
  });
});

// ─── null, never zero ───────────────────────────────────────────────────────

describe('no evidence reports null, not a reassuring zero', () => {
  it('reports null averages when no attempt qualifies', async () => {
    // `AVG` over an empty set is SQL NULL, which pg delivers as `null`.
    serve({
      ...ROW,
      aht_seconds: null as unknown as string,
      aht_seconds_including_machine: null as unknown as string,
      avg_wrapup_seconds: null as unknown as string,
    });

    const s = await stats();

    // "No wrap-up has concluded yet" and "wrap-ups take no time" are different
    // facts. A tile reading `AHT 0s` on a campaign that has connected nobody is a
    // measurement claim we have no basis for.
    expect(s.aht_seconds).toBeNull();
    expect(s.aht_seconds_including_machine).toBeNull();
    expect(s.avg_wrapup_seconds).toBeNull();
  });

  it('reports a null connect rate before the first attempt', async () => {
    serve({ ...ROW, attempts_total: '0', human_connects: '0' });

    const s = await stats();

    // 0% connect rate reads as "we are calling and nobody is answering", which is a
    // performance problem someone will go looking for. "We have not dialled yet" is
    // not that.
    expect(s.connect_rate_pct).toBeNull();
  });

  it('reports a null previous-hour abandonment rate when the window answered nothing', async () => {
    serve({ ...ROW });

    const s = await stats();

    // Same rule as the 24h figure, and the same reason: a campaign with no answered
    // calls has no abandonment rate, and rendering 0.0% is how a guardrail gets
    // trusted before it has measured anything.
  });

  it('says machine connects are unmeasurable when the catalog omits the code', async () => {
    serve({ ...ROW, machine_connects_available: 'false', machine_connects: '0' });

    const s = await stats();

    // `false` is the console's cue to say "not measured" instead of "0 voicemails".
    // An agent cannot submit a code the catalog does not offer, so the zero is a
    // property of the configuration, not of the calls.
    expect(s.machine_connects_available).toBe(false);
    expect(s.machine_connects).toBe(0);
  });

  it('degrades to nulls rather than NaN when the aggregate row is missing', async () => {
    serve(null, []);

    const s = await stats();

    // `NaN > ceiling` is false, so a NaN is the same silently-non-firing guardrail
    // one layer further in.
    expect(s.aht_seconds).toBeNull();
    expect(s.avg_wrapup_seconds).toBeNull();
    expect(s.connect_rate_pct).toBeNull();
    expect(Number.isNaN(s.human_connects)).toBe(false);
    expect(s.machine_connects_available).toBe(false);
  });
});

// ─── the roster must be addressable, not just renderable ────────────────────

describe('every roster row carries the id its controls are keyed on', () => {
  it('projects the SESSION id, distinct from the agent user id', async () => {
    const stats = await new AgencyCampaignRepository().stats('camp-1');

    // The drawer offers "Force-return to available" for the stuck-in-wrap-up
    // case, and the route for it is
    // `POST /agency/sessions/:id/force-available` — keyed on the SESSION, not the
    // person. The query already `GROUP BY s.id`, so this was one projection short
    // of the wire, and nothing here would have failed: the floor would have
    // rendered perfectly and every control on it would have been unwireable, which
    // only shows up in the console.
    expect(stats.agents.map((a) => a.session_id)).toEqual(['sess-1', 'sess-2', 'sess-3', 'sess-4']);

    // Distinct values per row, and distinct from `agent_user_id` — a session is one
    // shift on one campaign, the user id is the person. Controls act on the former,
    // identity resolution on the latter, and conflating them would send a
    // force-return at the wrong target the first time an agent works two campaigns.
    for (const agent of stats.agents) {
      expect(agent.session_id).not.toBe(agent.agent_user_id);
    }
  });

  it('selects the session id in SQL, not just in the mapper', async () => {
    await new AgencyCampaignRepository().stats('camp-1');
    const roster = pool.query.mock.calls.map((c) => String(c[0])).find((s) => s.includes('agency_agent_sessions s'));

    expect(roster).toContain('s.id AS session_id');
  });
});

// ─── what the adversarial review found ──────────────────────────────────────

describe('a call nobody wrote up is not a human connect', () => {
  it('splits bridged calls three ways, not two', async () => {
    serve({ ...ROW, human_connects: '31', machine_connects: '32', unclassified_connects: '9' });
    const s = await stats();

    // `IS DISTINCT FROM 'voicemail'` is true of NULL, so a two-way split books
    // every never-written-up call as a HUMAN connect at full duration. That
    // population is not small — the reaper stamps `no_disposition` on every lapsed
    // wrap-up — and it skews toward exactly the voicemails an agent walked away
    // from rather than label, which is the case the split exists to separate.
    expect(s.unclassified_connects).toBe(9);
    expect(s.human_connects).toBe(31);
  });

  it('excludes both the voicemail code and the reaper auto-stamp from human connects', async () => {
    await stats();
    const sql = executable(aggregateSql());
    const human = sql.slice(sql.lastIndexOf('(SELECT', sql.indexOf('AS human_connects')), sql.indexOf('AS human_connects'));

    // Bound as parameters, not inlined: `no_disposition` is the reaper's constant
    // and a local respelling would drift from the thing that writes it.
    expect(human).toContain('disposition_code IS NOT NULL');
    expect(human).toContain('disposition_code <> $3');
    expect(human).toContain('disposition_code <> $4');
    expect(aggregateParams()[3]).toBe('no_disposition');
  });
});

describe('a crash-orphaned attempt does not enter AHT', () => {
  it('excludes outcome = orphaned from both AHT variants', async () => {
    await stats();
    const sql = executable(aggregateSql());

    // The reaper settles a crash-orphaned attempt with `ended_at = now()` AT SWEEP
    // TIME, so a conversation whose replica died contributes its whole
    // time-until-sweep — minutes or hours — to an average measured in seconds. One
    // orphan visibly moves the tile on a low-volume campaign.
    for (const alias of ['AS aht_seconds', 'AS aht_seconds_including_machine']) {
      const subquery = sql.slice(sql.lastIndexOf('(SELECT', sql.indexOf(alias)), sql.indexOf(alias));
      expect(subquery, alias).toContain("outcome IS DISTINCT FROM 'orphaned'");
    }
  });
});
