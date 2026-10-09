import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Migration 108 — `started_at`, `ended_at` and `last_transition_by` on the
// campaign row.
//
// ── The regression this suite exists to make un-shippable ──────────────────
//
// `started_at` has existed since 072 and was WRONG: the routes passed
// `{ started_at: new Date() }` on `/resume` as well as `/start`, and the UPDATE
// said `COALESCE($n, started_at)` — new value FIRST — so every resume overwrote
// it. A campaign that began at 09:00, paused for lunch and resumed at 14:05
// reported 14:05, and anything drawing elapsed time from it was short by the
// morning, silently, in the flattering direction.
//
// The fix moved all three stamps into the one statement that moves a status, so
// they are derived from the TARGET rather than from what a call site remembers to
// pass. This file asserts that in the two places it can be broken:
//
//   * the SQL TEXT — `COALESCE(started_at, now())`, not the other way round; the
//     terminal CASE; the actor written unconditionally except on the one
//     transition that inherits it;
//   * the WIRE FOLD — the two `last_transition_by_*` columns becoming one object,
//     and `null` keeping its documented meaning.
//
// The ROUTE half — that no lifecycle stamp is passed from there any more, and that
// the actor is read from the body and cannot refuse the transition — is in
// `campaign-lifecycle-route.test.ts`. Separate file, because the two halves need
// incompatible module graphs: that one mocks the repository, this one needs the
// real `AgencyCampaignRepository` over a mocked pool.
//
// THE POOL IS MOCKED. As `agent-stats-repository.test.ts` documents, that means a
// renamed column cannot be caught here — the argument-order rule lives in the
// query text and is asserted against it.
//
// ⚠️⚠️ AND SO A STATEMENT POSTGRES CANNOT PARSE PASSES EVERY ASSERTION IN THIS
// FILE. This is not a caveat about coverage; it has already happened once.
//
// The pool is a `vi.fn()`, so the SQL never reaches a database: these tests read
// the query as TEXT and assert substrings of it. Nothing here can observe a
// PARSE-time error, which is the class of failure `transitionStatus` shipped —
// `$3` was used both as the value assigned to `status` (deduced `character
// varying`) and in five untyped literal comparisons (deduced `text`), so Postgres
// answered `42P08 inconsistent types deduced for parameter $3` and refused the
// statement before touching a row. Every `toContain` below was green; all four
// lifecycle routes 500'd and `PacingEngine.maybeFinalize` threw on every tick. The
// fix is the `::varchar` cast now asserted in "the cast that makes the statement
// parsable"; the cast is the only reason that assertion exists, and it too is only
// a text assertion — it proves the cast is present, never that the statement
// parses.
//
// The INTEGRATION tier is the only gate on parsability, and it already holds one:
// `test/integration/agency/agency-campaign-stats.test.ts` calls `transitionStatus`
// against a real Postgres and would have failed on the first call. It did not run,
// because `npm test` excludes `test/integration/**` (`vitest.config.ts`), so that
// tier has to actually be run — `npm run test:integration`, Docker up — before a
// change to any of this SQL is believed. Do not try to make this file cover it: a
// pool-mocked suite structurally cannot, and a fake that could parse SQL would be
// a second Postgres.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { AgencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { formatAgencyCampaignResponse } = await import(
  '../../../src/api/responses/agency-campaign.response.js'
);

const sqlOf = (): string => String(pool.query.mock.calls[0]?.[0] ?? '');
const paramsOf = (): unknown[] => (pool.query.mock.calls[0]?.[1] ?? []) as unknown[];

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [] });
});

// ─── the statement ──────────────────────────────────────────────────────────

describe('the cast that makes the statement parsable', () => {
  it('assigns status through an explicit ::varchar', async () => {
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['draft'], 'running');
    const sql = sqlOf();

    // `$3` is the assignment target AND five untyped literal comparisons. Without a
    // cast on the assignment, Postgres deduces `character varying` from the column
    // and `text` from the comparisons and REFUSES to parse the statement (42P08),
    // which is a 500 on all four lifecycle routes and a throw on every
    // `maybeFinalize` tick. Verified against PostgreSQL 16.13: uncast it raises
    // 42P08 at position 48, cast it parses and updates the row.
    expect(sql).toContain('SET status = $3::varchar,');
    // Being explicit about the shape that does NOT work, because it is the natural
    // thing to try: casting the comparisons pins the parameter to text and the
    // assignment becomes the conflicting side.
    expect(sql).not.toContain("$3::text");
    // The comparisons must stay UNCAST — see above.
    expect(sql).toContain("CASE WHEN $3 = 'running'");
    expect(sql).toContain("$3 IN ('completed','stopped')");
    expect(sql).toContain("CASE WHEN $3 = 'stopped'");
    // ⚠️ All five of these are TEXT assertions. They prove the cast is written;
    // only the integration tier proves the statement parses.
  });
});

describe('started_at is FIRST-WRITE-WINS, so a resume cannot overwrite it', () => {
  it('writes COALESCE(started_at, now()) — the stored value FIRST', async () => {
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['paused'], 'running');
    const sql = sqlOf();

    // THE regression, in its most literal form. `COALESCE($n, started_at)` — the
    // argument order this replaced — is new-value-first, i.e. every resume stamps
    // over the original start.
    expect(sql).toContain('COALESCE(started_at, now())');
    expect(sql).not.toContain('COALESCE($4, started_at)');
    expect(sql).not.toMatch(/COALESCE\(\$\d+, started_at\)/);
  });

  it('only touches started_at on the way INTO running, and leaves it otherwise', async () => {
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['running'], 'paused');
    // Derived from the TARGET STATUS rather than from a caller's patch — which is
    // what makes first-write-wins a property of this statement instead of something
    // four call sites have to agree about. A pause must not restamp it at all.
    expect(sqlOf()).toContain("CASE WHEN $3 = 'running'");
    expect(sqlOf()).toContain('ELSE started_at END');
  });

  it('takes NO started_at / completed_at patch parameter at all', async () => {
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['draft'], 'running');
    // The bound list is the assertion that bites: with the stamps derived in SQL
    // there is nothing to pass, so a timestamp reappearing as a parameter would
    // lengthen it. Five values — id, from, to, actor id, actor name — plus the two
    // pause fields.
    expect(paramsOf()).toEqual(['camp-1', ['draft'], 'running', null, null, null, null]);
  });
});

describe('ended_at is stamped on entry to a TERMINAL status', () => {
  it('stamps both ended_at and its legacy twin from ONE condition', async () => {
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['running'], 'completed');
    const sql = sqlOf();

    // Two CASEs on the SAME predicate, which is what keeps the pair from
    // disagreeing about a status somebody adds to one list and not the other. Both
    // first-write-wins: terminal is absorbing, so this is belt-and-braces rather
    // than load-bearing, and it means a future re-open cannot restamp an end that
    // already happened.
    expect(sql).toContain("ended_at = CASE WHEN $3 IN ('completed','stopped')");
    expect(sql).toContain('COALESCE(ended_at, now())');
    expect(sql).toContain("completed_at = CASE WHEN $3 IN ('completed','stopped')");
    expect(sql).toContain('COALESCE(completed_at, now())');
  });

  it('does NOT stamp it for `stopping`, which is a drain and not an end', async () => {
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['running'], 'stopping');
    // A 200 from `/stop` means "accepted and draining", NOT "stopped": the pacing
    // leader writes `stopping → stopped` on its next idle tick, and THAT is the
    // instant the campaign ended. `stopping` is deliberately absent from the list.
    expect(sqlOf()).not.toContain("$3 IN ('completed','stopped','stopping')");
    expect(sqlOf()).toContain("$3 IN ('completed','stopped')");
  });

  it('uses now() rather than a JS clock, so the stamps and updated_at agree exactly', async () => {
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['stopping'], 'stopped');
    // One statement timestamp, so `ended_at` and `updated_at` are the same instant
    // by construction instead of two clocks that agree approximately.
    expect(sqlOf()).toContain('updated_at = now()');
    for (const value of paramsOf()) expect(value).not.toBeInstanceOf(Date);
  });
});

describe('last_transition_by answers "who caused the CURRENT status"', () => {
  it('writes the actor when one is supplied', async () => {
    await new AgencyCampaignRepository().transitionStatus(
      'camp-1', ['draft'], 'running',
      { last_transition_by: { user_id: 'u-manas', name: 'Manas N' } },
    );
    expect(paramsOf()[3]).toBe('u-manas');
    expect(paramsOf()[4]).toBe('Manas N');
  });

  it('writes NULL — never leaves the old actor — when none is supplied', async () => {
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['running'], 'completed');
    // Unconditional, the same rule the pause metadata follows: the columns answer
    // "who caused the CURRENT status", so leaving whatever was there would report
    // the supervisor who STARTED the campaign as the cause of a completion the
    // list's exhaustion caused.
    expect(paramsOf()[3]).toBeNull();
    expect(paramsOf()[4]).toBeNull();
    expect(sqlOf()).toContain('ELSE $4 END');
    expect(sqlOf()).toContain('ELSE $5 END');
  });

  it('an id-only actor stores a NULL name rather than an empty string', async () => {
    await new AgencyCampaignRepository().transitionStatus(
      'camp-1', ['draft'], 'running',
      { last_transition_by: { user_id: 'u-manas', name: null } },
    );
    // Core has no user table (D3), so a name is only ever what master sent. NULL is
    // a real state — an id-only actor — and it is a different fact from "nobody
    // caused this".
    expect(paramsOf()[3]).toBe('u-manas');
    expect(paramsOf()[4]).toBeNull();
  });

  it('`stopping → stopped` INHERITS the actor already on the row', async () => {
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['stopping'], 'stopped');
    // This transition is performed by the pacing leader and has no HTTP actor, so
    // the unconditional write would store NULL. But `stopped` is reachable only from
    // `stopping`, and `stopping` only from an operator pressing Stop — so the cause
    // of a stopped campaign IS that operator, and clearing it would lose the single
    // most useful attribution on the payload to a bookkeeping transition AND report
    // the stop as automatic, which is exactly what NULL is documented to deny.
    expect(sqlOf()).toContain("CASE WHEN $3 = 'stopped'");
    expect(sqlOf()).toContain('THEN last_transition_by_user_id');
    expect(sqlOf()).toContain('THEN last_transition_by_name');
  });
});

describe('the abandonment auto-pause is genuinely unattributed', () => {
  it('CLEARS the actor, so `null` really does mean "no human did this"', async () => {
    await new AgencyCampaignRepository().pauseForAbandonment('camp-1', 4.2);
    const sql = sqlOf();
    // The one transition with no human behind it at all. Preserving whatever was
    // there would leave the supervisor who started the campaign attributed to a
    // pause the guardrail imposed on them — a confident wrong answer on the row a
    // console renders beside "paused: abandonment ceiling breached".
    expect(sql).toContain('last_transition_by_user_id = NULL');
    expect(sql).toContain('last_transition_by_name = NULL');
    // And it is still the conditional claim it always was, so only one replica wins.
    expect(sql).toContain("WHERE id = $1 AND status = 'running'");
  });
});

/*
 * PORT NOTE (magick-agency, Phase 8): the source file's last describe (7 cases), which
 * lane B1 deferred because the formatter belongs to the campaign routes. Verbatim; the
 * formatter is core `src/api/responses/agency-campaign.response.ts`@4850d1d9, ported to
 * the same path with only its contracts import re-pointed.
 */
// ─── the wire fold ──────────────────────────────────────────────────────────

describe('the two actor columns become ONE wire object', () => {
  const row = (patch: Record<string, unknown> = {}) => ({
    id: 'camp-1', tenant_id: 't1', account_id: 'a1', name: 'Q3', status: 'running',
    started_at: new Date('2026-08-11T09:00:00.000Z'),
    ended_at: null,
    completed_at: null,
    last_transition_by_user_id: 'u-manas',
    last_transition_by_name: 'Manas N',
    ...patch,
  } as never);

  it('folds an attributed transition into { user_id, name }', () => {
    const wire = formatAgencyCampaignResponse(row());
    expect(wire.last_transition_by).toEqual({ user_id: 'u-manas', name: 'Manas N' });
    // The flat columns must not ALSO be on the wire: two nullable siblings is three
    // states for one fact, one of which is nonsense.
    expect(wire).not.toHaveProperty('last_transition_by_user_id');
    expect(wire).not.toHaveProperty('last_transition_by_name');
  });

  it('serves null for an unattributed transition', () => {
    const wire = formatAgencyCampaignResponse(row({
      last_transition_by_user_id: null, last_transition_by_name: null,
    }));
    expect(wire.last_transition_by).toBeNull();
  });

  it('serves an id-only actor rather than dropping it', () => {
    const wire = formatAgencyCampaignResponse(row({ last_transition_by_name: null }));
    // Half the actor is still an actor a console can link to a user. Dropping it
    // because the display name is missing would lose information the row is holding.
    expect(wire.last_transition_by).toEqual({ user_id: 'u-manas', name: null });
  });

  it('refuses a name with no id, because the id IS the identity', () => {
    const wire = formatAgencyCampaignResponse(row({ last_transition_by_user_id: null }));
    // Unreachable through the API (the pair is written together), and `null` is the
    // only answer that cannot mislead: an actor object nobody can resolve is worse
    // than an honest absence.
    expect(wire.last_transition_by).toBeNull();
  });

  it('strips retry_idempotency_key, which is an internal replay token', () => {
    // `SELECT *` and `RETURNING *` put this column on every campaign row the
    // repository returns, and this formatter SPREADS the row — so without an
    // explicit strip it rides out on `GET /:id`, on the create response, and as
    // `retry_idempotency_key: null` on every ordinary campaign, none of which is
    // in the frozen wire contract.
    //
    // It is not a fact about the campaign: it is the whole of the at-most-once
    // check. A reader who learns another caller's key can present it back and be
    // refused their own retry while being handed the campaign it already made.
    const wire = formatAgencyCampaignResponse(row({
      retry_idempotency_key: 'b3f1c0de-0000-4000-8000-000000000001',
    }));
    expect(wire).not.toHaveProperty('retry_idempotency_key');
    // Absent, not nulled — a `null` on the payload still tells a reader the
    // field exists and still widens the contract.
    expect(Object.keys(wire)).not.toContain('retry_idempotency_key');
    // And it is gone through serialisation too, which is what actually ships.
    expect(JSON.stringify(wire)).not.toContain('b3f1c0de');
  });

  it('carries ended_at BESIDE the legacy completed_at, both untouched', () => {
    const ended = new Date('2026-08-11T18:30:00.000Z');
    const wire = formatAgencyCampaignResponse(row({ ended_at: ended, completed_at: ended }));
    // Nothing here computes either one — they come off the row, written by the
    // single CASE in `transitionStatus`, so this function cannot be where they drift.
    expect(wire.ended_at).toBe(ended);
    expect(wire.completed_at).toBe(ended);
    expect(wire.started_at).toEqual(new Date('2026-08-11T09:00:00.000Z'));
  });

  it('serialises the timestamps as ISO-8601 instants through Fastify\'s own JSON', () => {
    const wire = formatAgencyCampaignResponse(row({
      ended_at: new Date('2026-08-11T18:30:00.000Z'),
    }));
    const json = JSON.parse(JSON.stringify(wire));
    // `Date` reaches the wire via `toISOString()`, which is what the contract
    // promises. Converting in the formatter would be a second serialisation rule for
    // these three while `created_at`/`paused_at` kept the first one.
    expect(json.started_at).toBe('2026-08-11T09:00:00.000Z');
    expect(json.ended_at).toBe('2026-08-11T18:30:00.000Z');
  });
});
