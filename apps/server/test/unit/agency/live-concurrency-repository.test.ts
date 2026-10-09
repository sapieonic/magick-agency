import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The dialer's live-concurrency read (2026-09-08 pilot, finding 4).
//
// `calls_active_current` is fed from `CallManager`'s AI `activeSessions` map, so
// the agency dialer — whose legs are WebRTC bridge sessions — reads flat 0 there.
// This is the SQL half of the replacement family.
//
// Everything below is a **query-shape** assertion, and the codebase's warning
// about that applies in full: a mocked pool never parses SQL, so nothing here can
// prove the statement runs. What it can pin is the handful of properties that are
// invisible in review and expensive in production — one grouped aggregate rather
// than N+1, the predicate written as a literal so the partial index applies, and
// the predicate being the SAME one the pacing tick's `occupied` term uses. The
// query having no parameters at all is what keeps it out of reach of the `42P08`
// trap that took down `transitionStatus` and `claimTerminal`, both of which had
// passing mocked-SQL tests.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

import {
  AgencyLiveConcurrencyRepository,
  AgencyAttemptRepository,
} from '../../../src/db/repositories/agency.repository.js';
import { AGENCY_ATTEMPT_LIVE_STATES } from '../../../src/db/models/agency.model.js';

/** A grouped row as the SQL returns it — `live` is text, per the `::text` cast. */
function dbRow(over: Record<string, unknown> = {}) {
  return { tenant_id: 't1', campaign_id: 'camp-1', state: 'dialing', live: '3', ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [dbRow()] });
});

describe('AgencyLiveConcurrencyRepository.liveByState · the query shape', () => {
  it('is ONE grouped aggregate, not a query per campaign', async () => {
    // Campaigns are created per roster upload and are unbounded over an account's
    // life. This runs on a 15s timer, so an N+1 here would scale the poller's cost
    // with the thing most likely to grow — the exact reasoning `window24h` carries.
    pool.query.mockResolvedValue({
      rows: [dbRow(), dbRow({ campaign_id: 'camp-2' }), dbRow({ campaign_id: 'camp-3' })],
    });

    const rows = await new AgencyLiveConcurrencyRepository().liveByState();

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(3);
    const sql = pool.query.mock.calls[0]![0] as string;
    expect(sql).toContain('COUNT(*)');
  });

  it('groups on all three label dimensions: tenant, campaign AND state', async () => {
    // `state` is the dimension the metric exists for. Grouping without it would
    // publish one flat occupancy number, which is the collapse the pilot's
    // unreadable "33 bridged" figure came from — dials in flight and conversations
    // in progress are different quantities and a future over-dial factor is
    // applied to the first, not the second.
    await new AgencyLiveConcurrencyRepository().liveByState();
    const sql = pool.query.mock.calls[0]![0] as string;

    expect(sql).toContain('GROUP BY tenant_id, campaign_id, state');
  });

  it('filters on `state <> \'ended\'` as a LITERAL, with no bound parameters', async () => {
    await new AgencyLiveConcurrencyRepository().liveByState();
    const [sql, values] = pool.query.mock.calls[0]!;

    expect(sql).toContain("state <> 'ended'");
    // Two distinct properties collapse into this one assertion, and both are
    // failures a mocked pool cannot otherwise see:
    //
    // 1. The predicate must match `uq_agency_attempt_live`'s partial-index
    //    predicate (migration 075) byte for byte, or the planner cannot prove the
    //    index covers the query and this degrades to a scan of a table that grows
    //    for the life of the account. `$1` is opaque at plan time.
    // 2. A statement with no parameters cannot hit `42P08` — no `$n` exists to be
    //    deduced into two conflicting types. That defect has shipped twice here
    //    and killed every call to the statement, not just some.
    expect(sql).not.toMatch(/\$\d/);
    expect(values).toBeUndefined();
  });

  it('uses the SAME predicate the pacing tick counts `occupied` with', async () => {
    // The point of the whole family. `occupied` (the tick's concurrency term) comes
    // from `AgencyAttemptRepository.countLive`; if these two predicates drift, an
    // operator reads a gauge that disagrees with the number the dialer acted on and
    // nothing anywhere goes red. Asserted as a shared substring rather than a
    // comment claiming agreement.
    await new AgencyLiveConcurrencyRepository().liveByState();
    const gaugeSql = pool.query.mock.calls[0]![0] as string;

    pool.query.mockResolvedValue({ rows: [{ n: '7' }] });
    await new AgencyAttemptRepository().countLive('camp-1');
    const tickSql = pool.query.mock.calls[1]![0] as string;

    const predicate = "state <> 'ended'";
    expect(tickSql, 'countLive stopped using the predicate this gauge mirrors').toContain(predicate);
    expect(gaugeSql).toContain(predicate);
  });

  it('is fleet-wide, NOT tenant-scoped', async () => {
    // Deliberately the exception to "every resource read is scoped by both
    // headers": this is an operator read on a timer, like `window24h`. A replica
    // publishes what it can see of the whole floor and Prometheus does the
    // per-tenant split from the label. A `WHERE tenant_id = $1` here would need a
    // caller that knows which tenants exist, which a metrics timer does not.
    await new AgencyLiveConcurrencyRepository().liveByState();
    const sql = pool.query.mock.calls[0]![0] as string;

    expect(sql).not.toMatch(/tenant_id\s*=/);
    expect(sql).not.toMatch(/account_id/);
    expect(sql).toContain('tenant_id');
  });

  it('parses the text-cast count back to a number', async () => {
    // `::text` is deliberate (pg hands `int8` back as a string). Undone here rather
    // than in the publisher, so a gauge can never be `set` to a string — which
    // prom-client accepts and then exports as `NaN`.
    pool.query.mockResolvedValue({ rows: [dbRow({ live: '41' })] });

    const rows = await new AgencyLiveConcurrencyRepository().liveByState();

    expect(rows[0]).toEqual({ tenant_id: 't1', campaign_id: 'camp-1', state: 'dialing', live: 41 });
    expect(typeof rows[0]!.live).toBe('number');
  });

  it('never asks for `ended` rows, so the terminal spine cannot inflate the gauge', async () => {
    // The negative control on the predicate's direction. `state = 'ended'` (the
    // abandonment window's filter, one character away) would count the entire
    // history of the account as live concurrency.
    await new AgencyLiveConcurrencyRepository().liveByState();
    const sql = pool.query.mock.calls[0]![0] as string;

    expect(sql).not.toMatch(/state\s*=\s*'ended'/);
  });

  it('returns states drawn from the live vocabulary, never `ended`', () => {
    // Not a query assertion — a vocabulary one, kept in this file because it is the
    // repository's predicate that guarantees it. `ended` is excluded by the SQL, so
    // the label values the publisher can ever see are exactly these five.
    expect([...AGENCY_ATTEMPT_LIVE_STATES]).toEqual(['queued', 'dialing', 'ringing', 'answered', 'bridged']);
    expect(AGENCY_ATTEMPT_LIVE_STATES).not.toContain('ended');
  });
});
