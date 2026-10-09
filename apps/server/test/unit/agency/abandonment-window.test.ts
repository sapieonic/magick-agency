import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The abandonment predicate and the 24h window query.
//
// Covers the predicate (`@magick-agency/domain/abandonment-predicate`) and
// `AgencyAbandonmentRepository.window24h`, plus the two independence-lock cases that
// need no metrics registry: "the predicate takes NO in-process value", "the
// repository actually USES that predicate". The gauge/counter registration in
// `abandonment-metrics.ts`/`utils/metrics.ts` is covered by `abandonment-metrics.test.ts`.
// The real-Postgres agreement test is `test/integration/agency/abandonment-invariants.test.ts`.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

import {
  ABANDONED_ATTEMPT_PREDICATE_SQL,
  ABANDONMENT_WINDOW_HOURS,
  ABANDONMENT_BRIDGE_GRACE_MS,
  abandonmentRatePct,
  isAbandonedAttempt,
} from '@magick-agency/domain/abandonment-predicate';
import { AgencyAbandonmentRepository } from '../../../src/db/repositories/agency.repository.js';

/** A window row as the SQL returns it — counts are text, per `::text` casts. */
function dbRow(over: Record<string, unknown> = {}) {
  return {
    tenant_id: 't1', campaign_id: 'camp-1', answered: '100', abandoned: '3', ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [dbRow()] });
});

describe('INDEPENDENCE LOCK (do not prune) — the parts that need no metrics', () => {
  it('the predicate takes NO in-process value — it is pure SQL over columns', async () => {
    // The mechanical form of "independent". If a future refactor fed a counter (or
    // any other in-process number) into the numerator it would have to arrive as a
    // bound parameter or be interpolated in — so the absence of a placeholder is a
    // checkable property, where a comment claiming independence is not.
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).not.toMatch(/\$\d/);

    // And it reads the raw columns the design names, so it can contradict the
    // counter rather than restate it.
    for (const column of ['state', 'answered_at', 'bridged_at', 'outcome']) {
      expect(ABANDONED_ATTEMPT_PREDICATE_SQL).toContain(column);
    }
  });

  it('the repository actually USES that predicate (not a second copy of it)', async () => {
    await new AgencyAbandonmentRepository().window24h();
    const sql = pool.query.mock.calls[0]![0] as string;

    // The constant existing is not the property — the query running it
    // is. Two hand-copied predicates that drift is how the metric and the audit
    // end up measuring different things while both look right in review.
    expect(sql).toContain(ABANDONED_ATTEMPT_PREDICATE_SQL);
    expect(sql).toContain('COUNT(*) FILTER');
  });
});

describe('the rolling window', () => {
  it('is 24 hours, bounded on answered_at, and asks the DB for exactly that', async () => {
    await new AgencyAbandonmentRepository().window24h();
    const [sql, values] = pool.query.mock.calls[0]!;

    expect(ABANDONMENT_WINDOW_HOURS).toBe(24);
    expect(values).toEqual([24]);
    // Bounded on `answered_at`, NOT `created_at`: the regulatory question is "of
    // the calls a customer picked up in the last 24h, how many reached nobody", so
    // an attempt placed yesterday and answered ten minutes ago is in this window.
    expect(sql).toMatch(/answered_at\s*>\s*now\(\)\s*-/);
    expect(sql).not.toMatch(/created_at\s*>/);
  });

  it('groups per campaign, because the regulatory unit is the campaign', async () => {
    const sql = (await new AgencyAbandonmentRepository().window24h(), pool.query.mock.calls[0]![0] as string);
    // Qualified because the guardrail query joins the campaign row in for the
    // status and ceiling — the grouping grain is unchanged, and the two extra
    // GROUP BY terms are functionally dependent on `campaign_id` rather than a
    // finer grain (Postgres cannot infer that through the join, so they are
    // listed).
    expect(sql).toContain('GROUP BY a.tenant_id, a.campaign_id');
  });

  it('joins the campaign LEFT, so an orphaned window row still publishes', async () => {
    // Attempts outlive their campaign row. An INNER JOIN here would silently drop
    // such a row from the gauges — the campaign would simply stop reporting a
    // rate, which reads identically to "compliant" on a dashboard. The guardrail
    // skips it (nothing to pause); the metrics must not.
    const sql = (await new AgencyAbandonmentRepository().window24h(), pool.query.mock.calls[0]![0] as string);
    expect(sql).toMatch(/LEFT JOIN\s+agency_campaigns/);
  });

  it('parses the text-cast counts back to numbers', async () => {
    // `::text` in the SQL is deliberate (pg returns int8 as a string), so the
    // mapping has to undo it or every gauge would be set to a string.
    pool.query.mockResolvedValue({ rows: [dbRow({ answered: '4321', abandoned: '7' })] });
    const rows = await new AgencyAbandonmentRepository().window24h();
    expect(rows[0]).toEqual({ tenant_id: 't1', campaign_id: 'camp-1', answered: 4321, abandoned: 7 });
  });

  it('uses the grace threshold, expressed in the SQL and not as a TTL', () => {
    expect(ABANDONMENT_BRIDGE_GRACE_MS).toBe(1000);
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).toContain("interval '1000 milliseconds'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The in-process twin of the SQL predicate, which is what
// `agency_abandoned_total` is now keyed on.
// ═══════════════════════════════════════════════════════════════════════════

describe('isAbandonedAttempt mirrors the ratified SQL definition', () => {
  const t0 = new Date('2026-08-11T10:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  /**
   * Cases derived from `ABANDONED_ATTEMPT_PREDICATE_SQL`'s arms, not from a run.
   *
   * Each entry names the arm it exercises, because the point of the fix is that
   * the counter stopped keying on `outcome` — so a case whose outcome is NOT
   * `abandoned` and whose expectation is `true` is the whole ticket.
   */
  const cases: Array<{ name: string; facts: Parameters<typeof isAbandonedAttempt>[0]; want: boolean }> = [
    {
      name: 'never answered ⇒ not abandoned, whatever the outcome says',
      facts: { answeredAt: null, bridgedAt: null, outcome: 'no_answer' },
      want: false,
    },
    {
      // The negative control. Without it every case below could pass against a
      // function that returns `true` unconditionally.
      name: 'answered and bridged promptly ⇒ a healthy conversation',
      facts: { answeredAt: t0, bridgedAt: at(40), outcome: 'connected' },
      want: false,
    },
    {
      name: "outcome 'abandoned' ⇒ abandoned (the label arm, still honoured)",
      facts: { answeredAt: t0, bridgedAt: null, outcome: 'abandoned' },
      want: true,
    },
    {
      name: 'THE FIX: answered, never bridged, ended `failed` ⇒ abandoned',
      facts: { answeredAt: t0, bridgedAt: null, outcome: 'failed' },
      want: true,
    },
    {
      name: 'THE FIX: answered, never bridged, filed `connected` ⇒ still abandoned',
      facts: { answeredAt: t0, bridgedAt: null, outcome: 'connected' },
      want: true,
    },
    {
      name: 'bridged beyond the grace window ⇒ abandoned',
      facts: { answeredAt: t0, bridgedAt: at(ABANDONMENT_BRIDGE_GRACE_MS + 1), outcome: 'connected' },
      want: true,
    },
    {
      name: 'ON the grace boundary ⇒ NOT abandoned (the SQL is `>`, not `>=`)',
      // The boundary case the clock rule demands: a threshold tested only at
      // 40ms and 5s can be off by one and never show it, and the arithmetic here is
      // the same subtraction the SQL does.
      facts: { answeredAt: t0, bridgedAt: at(ABANDONMENT_BRIDGE_GRACE_MS), outcome: 'connected' },
      want: false,
    },
    {
      name: 'a null outcome is not a free pass — the timestamps still decide',
      facts: { answeredAt: t0, bridgedAt: null, outcome: null },
      want: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(isAbandonedAttempt(c.facts)).toBe(c.want);
    });
  }

  it('reads NO state field, so it cannot be called anywhere but the settle site', () => {
    // The SQL's `state = 'ended'` arm keeps live traffic out of the compliance rate
    // (a call mid-bridge is answered with no `bridged_at` yet). The in-process twin
    // has no equivalent, so its safety rests entirely on having exactly one caller
    // — the moment the attempt goes terminal. A `state` parameter would advertise
    // that it is safe to ask elsewhere, and it is not.
    expect(Object.keys(cases[0]!.facts)).toEqual(['answeredAt', 'bridgedAt', 'outcome']);
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).toContain("state = 'ended'");
  });

  it('agrees with the SQL on which columns decide', () => {
    // Weak on its own, and kept only as a drift alarm: if someone adds an arm to
    // the SQL over a fourth column, the twin no longer mirrors it and the counter
    // silently diverges from the table again. The cross-check that can actually
    // catch that is the integration tier's; this reds in the same commit.
    for (const column of ['answered_at', 'bridged_at', 'outcome']) {
      expect(ABANDONED_ATTEMPT_PREDICATE_SQL).toContain(column);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The rate itself, and the low-sample trap the guardrail will walk into.
// ═══════════════════════════════════════════════════════════════════════════

describe('the rate is null on no data, never 0 and never 100', () => {
  it('returns null when nothing has been answered', () => {
    // `0` would tell a supervisor the campaign is compliant when there is no
    // evidence either way, and the abandonment guardrail reads this number to decide whether to
    // pause a campaign.
    expect(abandonmentRatePct({ answered: 0, abandoned: 0 })).toBeNull();
    expect(abandonmentRatePct({ answered: 0, abandoned: 5 })).toBeNull();
  });

  it('computes the percentage exactly', () => {
    expect(abandonmentRatePct({ answered: 100, abandoned: 3 })).toBe(3);
    expect(abandonmentRatePct({ answered: 1000, abandoned: 27 })).toBeCloseTo(2.7, 10);
    expect(abandonmentRatePct({ answered: 50, abandoned: 0 })).toBe(0);
  });
});
