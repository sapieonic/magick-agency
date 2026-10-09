import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, uuidFor } from '../setup/factories.js';

/**
 * ─── THE GROUPED READ, AGAINST A REAL POSTGRES ──────────────────────────────
 *
 * `GET /agency-agents/grouped-stats` plus its
 * `resolved_timezone`. Until this file the whole read had no
 * integration coverage of any kind: `agent-grouped-repository.test.ts` mocks the
 * pool, so every assertion it makes is an assertion about a STRING, and the two
 * defects this file exists for are both invisible at that tier.
 *
 * ── The two review findings pinned here ─────────────────────────────────────
 *
 * **C5 — the session join.** `reserved_agent_id` is nullable and NULL on every
 * attempt that failed before an agent was on it. An INNER join drops those
 * attempts, so a campaign-shaped read (`hour_of_day`, `campaign`, `disposition`,
 * `day`) understated the very hour a supervisor rosters from, and disagreed with
 * billing — which counts on `dialed_at IS NOT NULL` and joins no session at all.
 * The join is now LEFT unless `agent` is grouped. A mocked pool can only see the
 * WORD; whether the row is counted is Postgres's answer, and it is the answer that
 * matters.
 *
 * **C2 — the zone lookup's snapshot.** `resolved_timezone` was fetched by a second
 * statement issued in PARALLEL on the pool: two connections, two READ COMMITTED
 * snapshots, so a `default_timezone` UPDATE committing between them made the page
 * report a zone its buckets were never cut in. That is the one thing the field
 * exists to rule out. Both statements now share one client in one REPEATABLE READ
 * transaction, and the test below COMMITS a zone change between them — from
 * another connection, at exactly the seam — and asserts the reported zone is still
 * the zone the buckets were cut in.
 *
 * ── Why the pool is wrapped rather than mocked ──────────────────────────────
 *
 * The interleaving above cannot be expressed from outside `groupedStats()`: it is
 * one method call, and the window it needs is BETWEEN its two statements. So the
 * pool the repository sees is a thin wrapper over the real test pool that runs a
 * hook after the transaction's first statement. Nothing else is stubbed — the
 * statements, the transaction and the isolation level are all the real ones, and
 * the hook's own UPDATE goes out on a DIFFERENT connection and commits, which is
 * precisely the concurrent writer being modelled.
 *
 * ⚠️ The hook is asserted to have RUN. A test whose interleave silently never
 * fired would pass while proving nothing, which is the same failure again.
 */

/** Set by a test; consumed ONCE, at the seam between the two statements. */
let interleave: (() => Promise<void>) | null = null;

/**
 * The seam: immediately after the GROUPED statement has returned, whatever
 * connection it went out on.
 *
 * Keyed on the statement's own text rather than on "the first statement of a
 * transaction", and that is deliberate. The property under test is that the zone is
 * read in the snapshot the BUCKETS were cut in, so the writer has to commit after
 * the grouped statement and before the zone lookup — and pinning the hook to the
 * grouped statement means a refactor that moves either read to a different
 * connection still has the writer land in the same window. Hooking "first statement
 * on a client" instead would silently move the seam with the code, which is how an
 * interleave test comes to pass against the very shape it was written to catch.
 */
async function afterGroupedStatement(statement: unknown): Promise<void> {
  if (!String(statement).includes('agency_call_attempts') || !interleave) return;
  const hook = interleave;
  interleave = null;
  await hook();
}

/**
 * The real test pool, with that seam in it. Both paths are wrapped — the pool's own
 * `query` and a client's — because which one carries the grouped statement is
 * exactly what a future edit might change.
 */
function hookedPool(): pg.Pool {
  const real = getTestPool();
  const run = async (
    target: { query: (...a: unknown[]) => Promise<unknown> },
    args: unknown[],
  ): Promise<unknown> => {
    const result = await target.query(...args);
    await afterGroupedStatement(args[0]);
    return result;
  };
  return {
    query: (...args: unknown[]) => run(real as never, args),
    connect: async () => {
      const client = await real.connect();
      return {
        query: (...args: unknown[]) => run(client as never, args),
        release: () => client.release(),
      };
    },
  } as unknown as pg.Pool;
}

vi.mock('@magick-agency/db', () => ({ getPool: () => hookedPool() }));

const { agencyAgentStatsRepository } = await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession,
} = await import('./agency-factories.js');
type AgentGroupedParams = import('../../../src/agency/agent-record.js').AgentGroupedParams;

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const AGENT = uuidFor('u-ravi');
const SCOPE = { tenantId: T, accountId: A };

/** The window every test reads over: one UTC day around the seeded dials. */
const WINDOW = {
  from: new Date('2026-08-18T00:00:00Z'),
  to: new Date('2026-08-19T00:00:00Z'),
  sort: 'key' as const,
  order: 'asc' as const,
  limit: 200,
};

const read = (over: Partial<AgentGroupedParams>) => agencyAgentStatsRepository.groupedStats(
  SCOPE,
  { ...WINDOW, groupBy: ['agent'], ...over } as AgentGroupedParams,
);

/**
 * One dialled attempt. `session` NULL is the case C5 is about — an attempt that
 * failed before any agent was reserved onto it, which `create()` does not produce
 * today (it always writes a reserved session) but which the column permits and the
 * campaign spine already treats as real.
 */
async function dialled(
  campaignId: string,
  session: string | null,
  dialedAt: Date,
  overrides: Record<string, unknown> = {},
) {
  const contact = await insertAgencyContact(campaignId, { state: 'completed' });
  return insertAgencyAttempt(campaignId, contact.id as string, {
    state: 'ended',
    outcome: 'connected',
    reserved_agent_id: session,
    dialed_at: dialedAt,
    bridged_at: dialedAt,
    ended_at: new Date(dialedAt.getTime() + 60_000),
    ...overrides,
  });
}

/** An attempt that was dialled and never bridged — no agent, no conversation. */
function unreserved(campaignId: string, dialedAt: Date) {
  return dialled(campaignId, null, dialedAt, {
    outcome: 'failed', bridged_at: null, ended_at: null,
  });
}

describe('the grouped read against Postgres (integration)', () => {
  beforeEach(async () => {
    interleave = null;
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── C5: the session join, in both directions ──────────────────────────────

  describe('an attempt with no reserved agent (C5)', () => {
    /**
     * Two dials in the same hour: one an agent handled, one that never reached an
     * agent. Every assertion below is about which of the two reads counts the
     * second one.
     */
    async function floor() {
      const campaign = await insertAgencyCampaign({ status: 'stopped' });
      const id = campaign.id as string;
      const session = await insertAgentSession(id, { agent_user_id: AGENT });
      await dialled(id, session.id as string, new Date('2026-08-18T10:00:00Z'));
      await unreserved(id, new Date('2026-08-18T10:30:00Z'));
      return id;
    }

    it('is COUNTED in an hour-grouped read', async () => {
      // The best-hours question is "when do dials connect", and a dial that failed
      // before an agent was on it happened in a real hour with a real outcome. Two
      // attempts, one connect — which is a 50% connect rate for the hour, where the
      // INNER join reported 100% off the one attempt it could attribute.
      const campaignId = await floor();
      const page = await read({ groupBy: ['hour_of_day'], campaignId });

      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]!.key).toEqual({ hour_of_day: 10 });
      expect(page.rows[0]!.attempts).toBe(2);
      expect(page.rows[0]!.connected).toBe(1);
      expect(page.rows[0]!.connect_rate_pct).toBe(50);
      expect(page.total_groups).toBe(1);
    });

    it('is ABSENT from an agent-grouped read', async () => {
      // Here the join IS the attribution: `s.agent_user_id` is the key, and an
      // attempt with no session belongs to no agent. A LEFT join here would emit a
      // null-keyed row — a person-shaped group that is not a person.
      const campaignId = await floor();
      const page = await read({ groupBy: ['agent'], campaignId });

      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]!.key).toEqual({ agent_user_id: AGENT });
      expect(page.rows[0]!.attempts).toBe(1);
      expect(page.total_groups).toBe(1);
    });

    it('makes the two readings differ by EXACTLY the unattributed attempts', async () => {
      // The asymmetry, asserted rather than left as a footnote: a campaign-shaped
      // total can exceed the sum of the agent-grouped rows, and the difference is
      // the unreserved dials. Both numbers are right; presenting them adjacent
      // without saying so is what would be wrong.
      const campaignId = await floor();
      const byCampaign = await read({ groupBy: ['campaign'], campaignId });
      const byAgent = await read({ groupBy: ['agent'], campaignId });

      const pooled = byCampaign.rows.reduce((sum, row) => sum + row.attempts, 0);
      const attributed = byAgent.rows.reduce((sum, row) => sum + row.attempts, 0);
      expect(pooled).toBe(2);
      expect(attributed).toBe(1);
      expect(pooled - attributed).toBe(1);
    });

    it('counts it on every campaign-shaped grouping, not just the hour', async () => {
      // `disposition` and `day` are the other two shapes a supervisor reads, and a
      // fix applied to one grouping and not the others would be worse than none.
      const campaignId = await floor();

      const byDisposition = await read({ groupBy: ['disposition'], campaignId });
      // Neither attempt was dispositioned, so both land in the SAME null group —
      // which is D3's "null is a real key value" holding in Postgres rather than in
      // a fixture, and it is only visible because `GROUP BY` folds NULLs together
      // where a join would not.
      expect(byDisposition.rows).toHaveLength(1);
      expect(byDisposition.rows[0]!.key).toEqual({ disposition_code: null });
      expect(byDisposition.rows[0]!.attempts).toBe(2);

      const byDay = await read({ groupBy: ['day'], campaignId });
      expect(byDay.rows).toHaveLength(1);
      expect(byDay.rows[0]!.key).toEqual({ day: '2026-08-18' });
      expect(byDay.rows[0]!.attempts).toBe(2);
    });

    it('still refuses another ACCOUNT\'s unreserved attempt', async () => {
      // The predicate that used to keep this out was `s.tenant_id`, off the session
      // — which a LEFT join cannot carry, so the scope moved onto the ATTEMPT. This
      // is the test that the move actually holds: with no session to scope through,
      // `a.tenant_id`/`a.account_id` are the ONLY thing separating the two accounts,
      // and an unreserved row is exactly the row that has nothing else.
      const mine = await floor();
      const theirs = await insertAgencyCampaign({
        status: 'stopped', tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT,
      });
      const theirContact = await insertAgencyContact(theirs.id as string, {
        state: 'completed', tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT,
      });
      await insertAgencyAttempt(theirs.id as string, theirContact.id as string, {
        tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT,
        state: 'ended', outcome: 'failed', reserved_agent_id: null,
        dialed_at: new Date('2026-08-18T10:15:00Z'),
      });

      // Unfiltered by campaign, so nothing but the scope predicate is doing the work.
      const page = await read({ groupBy: ['campaign'] });
      expect(page.rows.map((row) => row.key.campaign_id)).toEqual([mine]);
      expect(page.rows[0]!.attempts).toBe(2);
    });

    it('never attributes an attempt to a session in another account', async () => {
      // The session's own scope did not vanish with the WHERE clause — it moved into
      // the JOIN condition, so it holds under BOTH join words. A foreign session
      // drops the row where `agent` is grouped (as it always did) and reads as
      // unattributed where it is not; what must never happen is a foreign
      // `agent_user_id` appearing as a group key in this account's page.
      const campaign = await insertAgencyCampaign({ status: 'stopped' });
      const campaignId = campaign.id as string;
      const foreign = await insertAgentSession(campaignId, {
        agent_user_id: uuidFor('u-outsider'), tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT,
      });
      await dialled(campaignId, foreign.id as string, new Date('2026-08-18T10:00:00Z'));

      const byAgent = await read({ groupBy: ['agent'], campaignId });
      expect(byAgent.rows).toEqual([]);
      expect(byAgent.total_groups).toBe(0);

      // The attempt is still OURS, so the campaign-shaped read counts it.
      const byHour = await read({ groupBy: ['hour_of_day'], campaignId });
      expect(byHour.rows).toHaveLength(1);
      expect(byHour.rows[0]!.attempts).toBe(1);
    });
  });

  // ── C2: one snapshot for the buckets and the zone they are reported in ────

  describe('`resolved_timezone` and the snapshot it is read in (C2)', () => {
    const KOLKATA = 'Asia/Kolkata';
    const NEW_YORK = 'America/New_York';
    /** 18:00 in Kolkata (UTC+5:30), 08:00 in New York (UTC-4 in August). */
    const DIAL = new Date('2026-08-18T12:30:00Z');

    /**
     * `agentUserId` is a parameter because `uq_agency_agent_live_tenant` (migration
     * 093) makes one LIVE session per (tenant, agent) — so the two-campaign case
     * below needs two people, not one person twice.
     */
    async function zonedCampaign(zone: string, agentUserId = AGENT) {
      const campaign = await insertAgencyCampaign({ status: 'stopped', default_timezone: zone });
      const id = campaign.id as string;
      const session = await insertAgentSession(id, { agent_user_id: agentUserId });
      await dialled(id, session.id as string, DIAL);
      return id;
    }

    it('reports the zone the buckets were actually cut in', async () => {
      // The baseline the snapshot test rests on: the hour is the CAMPAIGN's local
      // hour, and the page names that zone. 18:00 IST rather than 12:00 UTC — the
      // six-column error D5 exists to prevent, here as an observation rather than as
      // a claim about a string.
      const campaignId = await zonedCampaign(KOLKATA);
      const page = await read({ groupBy: ['hour_of_day'], campaignId });

      expect(page.rows.map((row) => row.key.hour_of_day)).toEqual([18]);
      expect(page.resolved_timezone).toBe(KOLKATA);
    });

    it('holds the zone to the SNAPSHOT the buckets were cut in', async () => {
      // ── The C2 regression, and the only test that can see it ────────────────
      //
      // The zone change below COMMITS from another connection between the two
      // statements. On two pooled connections — or on one connection at READ
      // COMMITTED — the second statement takes a fresh snapshot and reports
      // `America/New_York` over buckets that were cut in `Asia/Kolkata`: a page
      // whose hour axis names a zone its own numbers were never in.
      //
      // MUTATION PROOF: change the BEGIN to a plain `BEGIN` (READ COMMITTED), or put
      // the two statements back on `getPool()`, and this test fails with
      // `resolved_timezone: 'America/New_York'` beside `hour_of_day: 18`.
      const campaignId = await zonedCampaign(KOLKATA);

      let interleaved = false;
      interleave = async () => {
        await getTestPool().query(
          'UPDATE agency_campaigns SET default_timezone = $1 WHERE id = $2',
          [NEW_YORK, campaignId],
        );
        interleaved = true;
      };

      const page = await read({ groupBy: ['hour_of_day'], campaignId });

      // The interleave really happened, at the seam, and really committed. Without
      // this the test would pass on a read that never met a concurrent writer.
      expect(interleaved).toBe(true);
      const { rows } = await getTestPool().query<{ default_timezone: string }>(
        'SELECT default_timezone FROM agency_campaigns WHERE id = $1', [campaignId],
      );
      expect(rows[0]!.default_timezone).toBe(NEW_YORK);

      // Both halves of the page describe the same instant in the same zone.
      expect(page.rows.map((row) => row.key.hour_of_day)).toEqual([18]);
      expect(page.resolved_timezone).toBe(KOLKATA);

      // And the change is not being ignored — the next read is cut in the new zone
      // and says so. 08:00 in New York is the same instant as 18:00 in Kolkata.
      const after = await read({ groupBy: ['hour_of_day'], campaignId });
      expect(after.rows.map((row) => row.key.hour_of_day)).toEqual([8]);
      expect(after.resolved_timezone).toBe(NEW_YORK);
    });

    it('labels the axis of an EMPTY zoned page', async () => {
      // Amendment 1's whole reason for a second statement: a zoned read whose window
      // holds no attempts returns zero rows, and a zone taken off those rows would be
      // null on precisely the page that most needs its axis labelled.
      const campaignId = await zonedCampaign(KOLKATA);
      const page = await read({
        groupBy: ['hour_of_day'],
        campaignId,
        from: new Date('2026-07-01T00:00:00Z'),
        to: new Date('2026-07-02T00:00:00Z'),
      });

      expect(page.rows).toEqual([]);
      expect(page.total_groups).toBe(0);
      expect(page.resolved_timezone).toBe(KOLKATA);
    });

    it('falls back to UTC on an unresolvable zone, and reports UTC not the garbage', async () => {
      // `default_timezone` is VARCHAR(64) with no constraint, and `ts AT TIME ZONE
      // 'Mars/Olympus'` raises 22023 — which nothing maps to a status. The LEFT
      // LATERAL join turns that into a per-row fallback, so the read answers instead
      // of 500ing, and the reported zone is the one the buckets USED. Reading
      // `c.default_timezone` back instead would print `Mars/Olympus` over columns
      // that are in fact UTC, on exactly the campaign whose zone is broken.
      const campaignId = await zonedCampaign('Mars/Olympus');
      const page = await read({ groupBy: ['hour_of_day'], campaignId });

      expect(page.resolved_timezone).toBe('UTC');
      expect(page.rows.map((row) => row.key.hour_of_day)).toEqual([12]);
    });

    it('is null on a page with no single zone, and asks Postgres nothing extra', async () => {
      // The cross-campaign remedy D5 names first: `campaign` + a time dimension with
      // no filter is a legal 200 spanning campaigns whose zones genuinely differ, so
      // there is no page-level label. Two campaigns in two zones, each row cut in its
      // own — which is also the property that makes a single label wrong.
      const kolkata = await zonedCampaign(KOLKATA, uuidFor('u-ravi'));
      const newYork = await zonedCampaign(NEW_YORK, uuidFor('u-asha'));

      const page = await read({ groupBy: ['campaign', 'hour_of_day'] });
      expect(page.resolved_timezone).toBeNull();
      expect(page.rows).toHaveLength(2);
      expect(new Map(page.rows.map((row) => [row.key.campaign_id, row.key.hour_of_day])))
        .toEqual(new Map([[kolkata, 18], [newYork, 8]]));
    });
  });

  // ── the statement itself, in every shape it can be asked for ──────────────

  describe('the statement executes in every legal grouping', () => {
    it('answers all six single dimensions and the best-hours pair', async () => {
      // The grouped statement had never run against Postgres at all: the ordinal
      // GROUP BY, the window-function `total_groups`, the numeric-then-text casts and
      // the ORDER BY are all things a mocked pool takes on trust. Two dials, one
      // attributed, so every shape has a row to produce and the sums are checkable.
      const campaign = await insertAgencyCampaign({
        status: 'stopped', default_timezone: 'Asia/Kolkata',
      });
      const campaignId = campaign.id as string;
      const session = await insertAgentSession(campaignId, { agent_user_id: AGENT });
      await dialled(campaignId, session.id as string, new Date('2026-08-18T12:30:00Z'));
      await unreserved(campaignId, new Date('2026-08-18T13:00:00Z'));

      const shapes: AgentGroupedParams['groupBy'][] = [
        ['agent'], ['campaign'], ['disposition'], ['day'], ['day_of_week'], ['hour_of_day'],
        ['day_of_week', 'hour_of_day'], ['agent', 'campaign'], ['campaign', 'disposition'],
      ];
      for (const groupBy of shapes) {
        const page = await read({ groupBy, campaignId });
        const label = groupBy.join(',');
        expect(page.rows.length, label).toBeGreaterThan(0);
        expect(page.total_groups, label).toBe(page.rows.length);
        expect(page.group_by, label).toEqual(groupBy);
        // `agent` is the only shape that drops the unattributed dial.
        const attempts = page.rows.reduce((sum, row) => sum + row.attempts, 0);
        expect(attempts, label).toBe(groupBy.includes('agent') ? 1 : 2);
      }
    });

    it('takes `total_groups` PRE-limit from the window function', async () => {
      // A window over an empty partition is evaluated before LIMIT, so the count
      // describes the CTE rather than the page. Three hours, `limit: 1`.
      const campaign = await insertAgencyCampaign({ status: 'stopped' });
      const campaignId = campaign.id as string;
      const session = await insertAgentSession(campaignId, { agent_user_id: AGENT });
      for (const hour of ['09', '10', '11']) {
        await dialled(campaignId, session.id as string, new Date(`2026-08-18T${hour}:00:00Z`));
      }

      const page = await read({ groupBy: ['hour_of_day'], campaignId, limit: 1 });
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]!.key).toEqual({ hour_of_day: 9 });
      expect(page.total_groups).toBe(3);
      expect(page.limit).toBe(1);
    });

    it('sorts a null disposition LAST in both directions', async () => {
      // `disposition_code` is the only dimension that can be null, which is what the
      // explicit `NULLS LAST` in every ORDER BY is for — Postgres defaults nulls last
      // only under ASC, so a descending key sort would otherwise open on the group
      // with no disposition.
      const campaign = await insertAgencyCampaign({ status: 'stopped' });
      const campaignId = campaign.id as string;
      const session = await insertAgentSession(campaignId, { agent_user_id: AGENT });
      await dialled(campaignId, session.id as string, new Date('2026-08-18T09:00:00Z'), {
        disposition_code: 'sale',
      });
      await dialled(campaignId, session.id as string, new Date('2026-08-18T10:00:00Z'));

      for (const order of ['asc', 'desc'] as const) {
        const page = await read({ groupBy: ['disposition'], campaignId, order });
        expect(page.rows.map((row) => row.key.disposition_code), order)
          .toEqual(['sale', null]);
      }
    });
  });
});
