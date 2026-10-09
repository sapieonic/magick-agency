import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { insertAccount, insertTenant, insertUser } from '../setup/factories.js';

/**
 * ─── `agencyCampaignAgentRepository` AGAINST REAL POSTGRES ───────────────────
 *
 * `test/unit/agency/agency-campaign-agent.repository.test.ts` drives this same
 * repository against a hand-written fake. That fake now derives its conflict key
 * from the SQL it is handed rather than from a hard-coded helper, so it does catch
 * a mis-named arbiter — but it still **cannot tell you whether Postgres agrees**,
 * and the properties `assign()` leans on are properties of Postgres specifically.
 * A fake written from the same understanding as the code would confirm them even
 * if that understanding were wrong.
 *
 * Two such claims, and both are pinned below by *contrast* — the wrong version of
 * the statement is executed and shown to fail — because "the right one works" is
 * also satisfied by a database with no index on the table at all:
 *
 *  1. **A bare `ON CONFLICT DO NOTHING` matches any unique index**, which is what
 *     makes `assign()` correct under migration 060's `(tenant_id, user_id)` index
 *     AND under 064's `(tenant_id, user_id, campaign_id)`. Naming an arbiter
 *     couples the statement to one shape and raises `42P10` against the other —
 *     a 500 on every staffing write, and exactly what a code rollback past 064
 *     would reintroduce.
 *  2. **A partial index needs its predicate restated to be inferable at all.**
 *     Not what the code relies on any more, but it is the property that makes a
 *     named arbiter fragile, so it stays pinned.
 *
 * ── What this file no longer tests ─────────────────────────────────────────
 * A previous revision proved that unique indexes are checked PER STATEMENT rather
 * than deferred to COMMIT, "the entire reason the close must precede the insert".
 * Migration 064 removed the close: there is no move, no transaction and no
 * ordering to get wrong. Those cases were deleted rather than adapted, because the
 * behaviour they protected is behaviour this release deliberately removes.
 */

const hoisted = vi.hoisted(() => ({ poolOverride: null as pg.Pool | null }));

vi.mock('../../../src/connection.js', async () => {
  const utils = await import('../setup/test-utils.js');
  return { getPool: () => hoisted.poolOverride ?? utils.getTestPool() };
});

const { AgencyCampaignAgentRepository } = await import(
  '../../../src/repositories/agency-campaign-agent.repository.js'
);

const repo = new AgencyCampaignAgentRepository();

describe('AgencyCampaignAgentRepository (integration)', () => {
  let tenant: { id: string };
  let otherTenant: { id: string };
  let account: { id: string };
  let user: { id: string };
  let supervisor: { id: string };
  const CAMPAIGN_A = '22222222-2222-4222-8222-222222222222';
  const CAMPAIGN_B = '33333333-3333-4333-8333-333333333333';
  const CAMPAIGN_C = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    hoisted.poolOverride = null;
    await truncateAll();
    tenant = await insertTenant();
    otherTenant = await insertTenant();
    account = await insertAccount({ tenant_id: tenant.id });
    user = await insertUser();
    supervisor = await insertUser();
  });

  afterAll(closeTestPool);

  function assignInput(overrides: Record<string, unknown> = {}) {
    return {
      tenant_id: tenant.id,
      account_id: account.id,
      campaign_id: CAMPAIGN_A,
      user_id: user.id,
      assigned_by: supervisor.id,
      ...overrides,
    } as Parameters<typeof repo.assign>[0];
  }

  async function rows(tenantId = tenant.id, userId = user.id) {
    const { rows: r } = await getTestPool().query(
      `SELECT * FROM agency_campaign_agents
        WHERE tenant_id = $1 AND user_id = $2 ORDER BY assigned_at ASC, id ASC`,
      [tenantId, userId],
    );
    return r;
  }

  async function activeRows(tenantId = tenant.id, userId = user.id) {
    return (await rows(tenantId, userId)).filter((r) => r.unassigned_at === null);
  }

  // ══ The arbiter — the claim only Postgres can settle ═══════════════════════

  describe('the arbiter is unnamed, and that is what makes the code index-agnostic', () => {
    /**
     * ── What this block used to prove, and why it changed ────────────────────
     * `assign()` used to name its arbiter — `ON CONFLICT (tenant_id, user_id)
     * WHERE unassigned_at IS NULL` — and these cases proved that Postgres requires
     * a partial index's predicate to be restated for the index to be inferable.
     * True, and it stopped being the property that matters: naming ANY arbiter
     * couples the statement to one index's exact shape, and migration 064 changes
     * that shape. The named form raises `42P10` against the other index, which
     * surfaces as a 500 on every staffing write rather than as anything a reader
     * could diagnose.
     *
     * So the statement now names nothing, and what needs proving is that the bare
     * form works under BOTH indexes. Only Postgres can settle that, which is why it
     * is here and not in the unit fake.
     */
    it('the bare form matches the wide index — a duplicate is absorbed, not raised', async () => {
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));

      // Exactly the shape `assign()` relies on: a result to reason about rather
      // than a 23505 to interpret.
      const result = await getTestPool().query(
        `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [tenant.id, account.id, CAMPAIGN_A, user.id],
      );

      expect(result.rows).toHaveLength(0);
    });

    it('the bare form inserts a SECOND campaign — the wide index does not refuse it', async () => {
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));

      const result = await getTestPool().query(
        `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [tenant.id, account.id, CAMPAIGN_B, user.id],
      );

      expect(result.rows).toHaveLength(1);
    });

    it('the OLD two-column arbiter now fails to plan — the rollback hazard, pinned', async () => {
      /**
       * The reason `assign()` stopped naming an arbiter, demonstrated rather than
       * asserted in a comment. Any release whose `assign()` names 060's arbiter
       * breaks against this index — which is precisely what a code rollback past
       * migration 064 does, since `git checkout` does not roll back the database.
       *
       * Migration 064's header carries the remediation (run the down migration
       * first). This case is here so that if somebody ever reintroduces a named
       * arbiter, the suite tells them what they have coupled themselves to.
       */
      await expect(
        getTestPool().query(
          `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, user_id) WHERE unassigned_at IS NULL DO NOTHING`,
          [tenant.id, account.id, CAMPAIGN_A, user.id],
        ),
      ).rejects.toMatchObject({ code: '42P10' });
    });

    it('naming the wide index explicitly also works, predicate and all', async () => {
      // Not what the code does, but it pins WHY the bare form was chosen over this
      // one: both are valid here, and only the bare one is also valid under 060's
      // index. A future reader tempted to "tidy" the bare form into this one should
      // find the trade-off recorded rather than re-derive it.
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));

      const result = await getTestPool().query(
        `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, user_id, campaign_id) WHERE unassigned_at IS NULL DO NOTHING
         RETURNING *`,
        [tenant.id, account.id, CAMPAIGN_A, user.id],
      );

      expect(result.rows).toHaveLength(0);
    });

    it('a partial index still needs its predicate restated to be inferable', async () => {
      // Carried over from the previous revision: this is a property of Postgres
      // rather than of our schema, and it is the reason a named arbiter is fragile
      // in the first place.
      await expect(
        getTestPool().query(
          `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, user_id, campaign_id) DO NOTHING`,
          [tenant.id, account.id, CAMPAIGN_A, user.id],
        ),
      ).rejects.toMatchObject({ code: '42P10' });
    });
  });


  // ══ assign() ═══════════════════════════════════════════════════════════════

  describe('assign — the first assignment', () => {
    it('inserts one active row carrying every input field', async () => {
      const record = await repo.assign(assignInput());

      expect(record).toMatchObject({
        tenant_id: tenant.id,
        account_id: account.id,
        campaign_id: CAMPAIGN_A,
        user_id: user.id,
        assigned_by: supervisor.id,
        unassigned_at: null,
      });
      expect(await rows()).toHaveLength(1);
    });

    it('accepts a null account and a null assigner', async () => {
      // A tenant-level supervisor (`account_id IS NULL`) and a platform-key
      // caller (no acting user) are both real callers of this method.
      const record = await repo.assign(
        assignInput({ account_id: null, assigned_by: null }),
      );
      expect(record.account_id).toBeNull();
      expect(record.assigned_by).toBeNull();
    });

    it('accepts a campaign id core knows and master does not', async () => {
      await expect(repo.assign(assignInput({ campaign_id: randomUUID() }))).resolves.toBeTruthy();
    });
  });

  describe('assign — staffing someone onto a SECOND campaign', () => {
    /**
     * ── Against real Postgres, the behaviour migration 064 changed ───────────
     * These assertions used to read "MOVES: the old row is closed, a new one is
     * inserted, exactly one is active". Under migration 060's per-tenant index
     * that was the rule; staffing somebody onto an afternoon campaign closed
     * their morning row, so an ordinary handover destroyed a supervisor's earlier
     * decision and the agent's landing page could only ever name one campaign.
     *
     * Being live on one campaign at a time is unchanged — that is core's session
     * index, not this table.
     */
    it('KEEPS both: two rows, both active', async () => {
      const first = await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      const second = await repo.assign(assignInput({ campaign_id: CAMPAIGN_B }));

      const all = await rows();
      expect(all).toHaveLength(2);
      expect(second.id).not.toBe(first.id);

      const active = await activeRows();
      expect(active).toHaveLength(2);
      expect(active.map((r) => r.campaign_id).sort()).toEqual([CAMPAIGN_A, CAMPAIGN_B].sort());
    });

    it('closes nothing — the earlier row keeps its NULL unassigned_at', async () => {
      // Stronger than counting: it pins that the close is gone, so a re-added
      // "tidy up the old assignment" cannot pass by closing a row the count
      // happens to tolerate.
      const first = await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_B }));

      const kept = (await rows()).find((r) => r.id === first.id);
      expect(kept.unassigned_at).toBeNull();
      expect(kept.campaign_id).toBe(CAMPAIGN_A);
    });

    it('accumulates across three campaigns — nothing about the rule is pairwise', async () => {
      for (const campaign of [CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_C]) {
        await repo.assign(assignInput({ campaign_id: campaign }));
      }

      expect(await activeRows()).toHaveLength(3);
      expect(await rows()).toHaveLength(3);
    });

    it('does not reach across tenants', async () => {
      // The same person, staffed in two tenants. Both sets of rows are legitimate
      // and neither may affect the other — the shared-services case migration 060's
      // header calls out and 064 preserves.
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      await repo.assign(
        assignInput({ tenant_id: otherTenant.id, account_id: null, campaign_id: CAMPAIGN_C }),
      );

      await repo.assign(assignInput({ campaign_id: CAMPAIGN_B }));

      expect(await activeRows(otherTenant.id)).toMatchObject([{ campaign_id: CAMPAIGN_C }]);
      expect((await activeRows()).map((r) => r.campaign_id).sort()).toEqual(
        [CAMPAIGN_A, CAMPAIGN_B].sort(),
      );
    });

    it('does not touch a DIFFERENT person', async () => {
      const colleague = await insertUser();
      await repo.assign(assignInput({ user_id: colleague.id, campaign_id: CAMPAIGN_A }));
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));

      await repo.assign(assignInput({ campaign_id: CAMPAIGN_B }));

      expect(await activeRows(tenant.id, colleague.id)).toMatchObject([
        { campaign_id: CAMPAIGN_A },
      ]);
    });
  });

  describe('assign — re-assigning to the campaign they are already on', () => {
    it('is a no-op that returns the SAME row and does not churn assigned_at', async () => {
      const first = await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      // A supervisor double-clicking Assign must not rewrite the history of when
      // this person was staffed.
      await new Promise((r) => setTimeout(r, 15));
      const again = await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));

      expect(again.id).toBe(first.id);
      expect(new Date(again.assigned_at).getTime()).toBe(new Date(first.assigned_at).getTime());
      expect(await rows()).toHaveLength(1);
    });

    it('does not write a second row even after several repeats', async () => {
      for (let i = 0; i < 5; i += 1) await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      expect(await rows()).toHaveLength(1);
    });

    it('still reports the row when the acting supervisor differs', async () => {
      // Two supervisors both deciding this person belongs on A. The second gets
      // the existing row, so `assigned_by` records who actually staffed them.
      const first = await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      const other = await insertUser();
      const again = await repo.assign(
        assignInput({ campaign_id: CAMPAIGN_A, assigned_by: other.id }),
      );
      expect(again.id).toBe(first.id);
      expect(again.assigned_by).toBe(supervisor.id);
    });
  });

  describe('assign — connection hygiene', () => {
    it('returns every client to the pool, so a pool of 2 serves many assignments', async () => {
      // A leaked client is invisible in a 5-connection pool and fatal in
      // production. With max: 2, the sixth `assign` simply hangs if any of the
      // first five failed to release — which is what the timeout would report.
      const smallPool = new pg.Pool({
        // PORT NOTE (magick-agency): master's 5434 URL replaced by the agency
        // harness's guarded TEST_DB_URL.
        connectionString: TEST_DB_URL,
        max: 2,
      });
      hoisted.poolOverride = smallPool;
      try {
        for (const campaign of [CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_C, CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_C]) {
          await repo.assign(assignInput({ campaign_id: campaign }));
        }
        expect(smallPool.idleCount).toBeGreaterThan(0);
        expect(smallPool.waitingCount).toBe(0);
      } finally {
        hoisted.poolOverride = null;
        await smallPool.end();
      }
    });
  });

  // ══ unassign() ═════════════════════════════════════════════════════════════

  describe('unassign', () => {
    it("returns the CLOSED ROW'S id — what the audit row references", async () => {
      const record = await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));

      const closedId = await repo.unassign(tenant.id, CAMPAIGN_A, user.id);

      expect(closedId).toBe(record.id);
      expect(await activeRows()).toHaveLength(0);
      expect(await rows()).toHaveLength(1); // closed, not deleted
    });

    it('returns null when there was nothing to close, so the route skips its audit row', async () => {
      expect(await repo.unassign(tenant.id, CAMPAIGN_A, user.id)).toBeNull();
    });

    it('is idempotent at the data layer: a second call closes nothing more', async () => {
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      const first = await repo.unassign(tenant.id, CAMPAIGN_A, user.id);
      const second = await repo.unassign(tenant.id, CAMPAIGN_A, user.id);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(await rows()).toHaveLength(1);
    });

    it('closes ONLY the named campaign, leaving their other assignments alone', async () => {
      /**
       * The campaign predicate used to be a guard against a stale console
       * unstaffing somebody from the campaign they had since been MOVED to. Since
       * migration 064 it does ordinary work on the ordinary path: an agent
       * genuinely holds several assignments, so unstaffing them from one must not
       * disturb the rest.
       */
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_B }));

      expect(await repo.unassign(tenant.id, CAMPAIGN_A, user.id)).not.toBeNull();
      expect(await activeRows()).toMatchObject([{ campaign_id: CAMPAIGN_B }]);
    });

    it('returns null for a campaign they were never staffed on', async () => {
      // Idempotent: the requested state — "not staffed on CAMPAIGN_C" — already
      // holds, and the route turns this null into a 204 with no audit row.
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));

      expect(await repo.unassign(tenant.id, CAMPAIGN_C, user.id)).toBeNull();
      expect(await activeRows()).toHaveLength(1);
    });

    it('is tenant-scoped', async () => {
      await repo.assign(
        assignInput({ tenant_id: otherTenant.id, account_id: null, campaign_id: CAMPAIGN_A }),
      );

      expect(await repo.unassign(tenant.id, CAMPAIGN_A, user.id)).toBeNull();
      expect(await activeRows(otherTenant.id)).toHaveLength(1);
    });

    it('is user-scoped: it does not unstaff the whole campaign', async () => {
      const colleague = await insertUser();
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      await repo.assign(assignInput({ user_id: colleague.id, campaign_id: CAMPAIGN_A }));

      await repo.unassign(tenant.id, CAMPAIGN_A, user.id);

      expect(await activeRows(tenant.id, colleague.id)).toHaveLength(1);
    });

    it('leaves the person assignable again afterwards', async () => {
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      await repo.unassign(tenant.id, CAMPAIGN_A, user.id);

      await expect(repo.assign(assignInput({ campaign_id: CAMPAIGN_A }))).resolves.toBeTruthy();
      expect(await activeRows()).toHaveLength(1);
    });
  });

  // ══ reads ══════════════════════════════════════════════════════════════════

  describe('listActiveForUser', () => {
    it('returns every campaign the agent is staffed on, oldest first', async () => {
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_B }));

      const found = await repo.listActiveForUser(tenant.id, user.id);

      expect(found.map((r) => r.campaign_id)).toEqual([CAMPAIGN_A, CAMPAIGN_B]);
    });

    it('omits closed rows', async () => {
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_B }));
      await repo.unassign(tenant.id, CAMPAIGN_A, user.id);

      expect((await repo.listActiveForUser(tenant.id, user.id)).map((r) => r.campaign_id)).toEqual([
        CAMPAIGN_B,
      ]);
    });

    it('is empty rather than null for an unstaffed agent', async () => {
      // The route maps this straight onto `{ assignments: [] }` — the collection's
      // representation of "nobody has staffed me".
      expect(await repo.listActiveForUser(tenant.id, user.id)).toEqual([]);
    });

    it('does not see another tenant’s assignments for the same person', async () => {
      await repo.assign(
        assignInput({ tenant_id: otherTenant.id, account_id: null, campaign_id: CAMPAIGN_A }),
      );

      expect(await repo.listActiveForUser(tenant.id, user.id)).toEqual([]);
    });

    it('does not see a colleague’s assignments', async () => {
      const colleague = await insertUser();
      await repo.assign(assignInput({ user_id: colleague.id, campaign_id: CAMPAIGN_A }));

      expect(await repo.listActiveForUser(tenant.id, user.id)).toEqual([]);
    });
  });

  describe('findActiveForUser — the deprecated singular read', () => {
    it('answers the OLDEST of several, so a stale console keeps its yesterday', async () => {
      /**
       * Oldest rather than newest, deliberately: a browser tab loaded before this
       * release calls `GET /my-assignment`, which cannot mention a second
       * campaign. Sending it to the longest-standing assignment keeps it pointing
       * where it pointed yesterday, rather than silently following staffing edits
       * it has no UI to explain.
       */
      const first = await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_B }));

      expect((await repo.findActiveForUser(tenant.id, user.id))?.id).toBe(first.id);
    });

    it('finds the live assignment', async () => {
      const record = await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      const found = await repo.findActiveForUser(tenant.id, user.id);
      expect(found?.id).toBe(record.id);
    });

    it('returns null once the row is closed', async () => {
      await repo.assign(assignInput({ campaign_id: CAMPAIGN_A }));
      await repo.unassign(tenant.id, CAMPAIGN_A, user.id);
      expect(await repo.findActiveForUser(tenant.id, user.id)).toBeNull();
    });

    it('does not see another tenant’s assignment for the same person', async () => {
      await repo.assign(
        assignInput({ tenant_id: otherTenant.id, account_id: null, campaign_id: CAMPAIGN_A }),
      );
      expect(await repo.findActiveForUser(tenant.id, user.id)).toBeNull();
    });
  });

  describe('listActiveForCampaign', () => {
    it('lists live rows for the campaign, oldest first', async () => {
      const a = await insertUser();
      const b = await insertUser();
      const c = await insertUser();
      const first = await repo.assign(assignInput({ user_id: a.id, campaign_id: CAMPAIGN_A }));
      await new Promise((r) => setTimeout(r, 5));
      const second = await repo.assign(assignInput({ user_id: b.id, campaign_id: CAMPAIGN_A }));
      await new Promise((r) => setTimeout(r, 5));
      const third = await repo.assign(assignInput({ user_id: c.id, campaign_id: CAMPAIGN_A }));

      const list = await repo.listActiveForCampaign(CAMPAIGN_A, tenant.id);
      expect(list.map((r) => r.id)).toEqual([first.id, second.id, third.id]);
    });

    it('omits closed rows', async () => {
      const a = await insertUser();
      await repo.assign(assignInput({ user_id: a.id, campaign_id: CAMPAIGN_A }));
      await repo.unassign(tenant.id, CAMPAIGN_A, a.id);

      expect(await repo.listActiveForCampaign(CAMPAIGN_A, tenant.id)).toHaveLength(0);
    });

    it('is tenant-scoped — the security property, not a filter', async () => {
      // `campaign_id` arrives from the URL and carries no FK. Without the tenant
      // predicate a supervisor naming another tenant's campaign id would read
      // back that tenant's staffing list, names and emails included.
      await repo.assign(
        assignInput({ tenant_id: otherTenant.id, account_id: null, campaign_id: CAMPAIGN_A }),
      );

      expect(await repo.listActiveForCampaign(CAMPAIGN_A, tenant.id)).toHaveLength(0);
      expect(await repo.listActiveForCampaign(CAMPAIGN_A, otherTenant.id)).toHaveLength(1);
    });

    it('returns an empty list for a campaign nobody is staffed on', async () => {
      expect(await repo.listActiveForCampaign(randomUUID(), tenant.id)).toEqual([]);
    });
  });
});
