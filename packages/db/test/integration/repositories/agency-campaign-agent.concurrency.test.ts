import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant, insertUser } from '../setup/factories.js';

/**
 * ─── TWO SUPERVISORS, ONE AGENT, REAL POSTGRES ──────────────────────────────
 *
 * ── What migration 064 did to this file's subject ──────────────────────────
 * Until 064, `assign()` was a MOVE: a transaction that closed the agent's
 * existing row and inserted the new one, with a bounded retry for the case where
 * a concurrent supervisor moved the same person first. Most of this file existed
 * to prove that retry converged against real Postgres — the deterministic
 * interleavings drove a second connection to commit between our CLOSE and our
 * INSERT, and the genuine races asserted "exactly one active row, however they
 * interleave".
 *
 * The index is now `(tenant_id, user_id, campaign_id)`, so an agent may hold
 * several assignments and there is no move: no other row to close, no transaction,
 * and no lost update to lose. Those tests are gone because the behaviour they
 * proved is behaviour this release deliberately removes — a second active row is
 * now the CORRECT outcome, and a test demanding one would be demanding the bug.
 *
 * ── What is still genuinely concurrent, and therefore still here ────────────
 * Three things, and each needs real Postgres for a reason a fake cannot supply:
 *
 *  1. **Idempotence under a real race.** Two supervisors assigning the same person
 *     to the same campaign must produce ONE row. That rests on the partial unique
 *     index actually serialising two concurrent inserts — one wins, one is absorbed
 *     by `ON CONFLICT … DO NOTHING` — and on the loser's read-back finding the
 *     winner's committed row.
 *  2. **Independence.** Two supervisors assigning the same person to DIFFERENT
 *     campaigns must both succeed. Under 060 that was a race with a winner; it is
 *     now two non-conflicting inserts, and asserting so is what would catch a
 *     re-added close.
 *  3. **The one remaining retry path.** Our insert conflicts with a live row, and a
 *     concurrent UNASSIGN closes that row before our read-back sees it — so
 *     nothing is inserted and nothing is found. `assign` must retry rather than
 *     return `undefined` as a record.
 *
 * ── Two kinds of test here, and both are needed ────────────────────────────
 * **Deterministic interleavings** drive a real second connection to commit at a
 * chosen point between `assign`'s real statements. Only the *scheduling* is
 * test-controlled; the locks and the index are Postgres's. They can assert an
 * exact outcome, including how many attempts it took.
 *
 * **Genuine races** run several `assign()` calls in parallel with no hooks at all
 * and assert the invariants that must hold however the scheduler interleaves them.
 * They cannot assert a specific winner — that is the point — so they are repeated,
 * and they are the only thing here that would catch a failure mode nobody thought
 * to script.
 */

// The agency harness's guarded URL is used, never another stack's port.
import { TEST_DB_URL } from '../../helpers/test-db.js';

interface Interleave {
  /** Runs immediately before `assign`'s INSERT, with the 1-based attempt number. */
  beforeInsert?: (attempt: number) => Promise<void>;
  /** Runs immediately before `assign`'s read-back SELECT. */
  beforeSelect?: (attempt: number) => Promise<void>;
}

const hoisted = vi.hoisted(() => ({
  interleave: null as Interleave | null,
  attempts: 0,
}));

/**
 * A pool wrapper that runs REAL statements against the test database and only
 * inserts a scheduling point before two of `assign`'s. Nothing about the
 * isolation level or the index is simulated.
 *
 * It hooks `query` rather than `connect` because `assign` no longer takes a
 * client: with no move there is nothing to make atomic, so it issues two
 * independent statements straight at the pool.
 */
vi.mock('../../../src/connection.js', async () => {
  const utils = await import('../setup/test-utils.js');
  const sqlOf = (arg: unknown): string =>
    typeof arg === 'string' ? arg : ((arg as { text?: string })?.text ?? '');

  return {
    getPool: () => {
      const real = utils.getTestPool();
      return {
        query: async (...args: unknown[]) => {
          const sql = sqlOf(args[0]);
          if (/INSERT INTO agency_campaign_agents/.test(sql)) {
            hoisted.attempts += 1;
            await hoisted.interleave?.beforeInsert?.(hoisted.attempts);
          } else if (
            /SELECT \* FROM agency_campaign_agents/.test(sql) &&
            /AND campaign_id = \$3/.test(sql)
          ) {
            // `assign`'s read-back — the one SELECT scoped to a single campaign.
            await hoisted.interleave?.beforeSelect?.(hoisted.attempts);
          }
          return (real.query as (...a: unknown[]) => unknown)(...args);
        },
        connect: async () => real.connect(),
      };
    },
  };
});

const { AgencyCampaignAgentRepository } = await import(
  '../../../src/repositories/agency-campaign-agent.repository.js'
);

const repo = new AgencyCampaignAgentRepository();

/** Genuinely separate connections — this is "the other supervisor's request". */
let interloperPool: pg.Pool;

describe('agency staffing under real concurrency (integration)', () => {
  let tenant: { id: string };
  let account: { id: string };
  let user: { id: string };
  const CAMPAIGN_A = '22222222-2222-4222-8222-222222222222';
  const CAMPAIGN_B = '33333333-3333-4333-8333-333333333333';
  const CAMPAIGN_C = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    hoisted.interleave = null;
    hoisted.attempts = 0;
    await truncateAll();
    tenant = await insertTenant();
    account = await insertAccount({ tenant_id: tenant.id });
    user = await insertUser();
    interloperPool ??= new pg.Pool({ connectionString: TEST_DB_URL, max: 4 });
  });

  afterEach(() => {
    hoisted.interleave = null;
  });

  afterAll(async () => {
    await interloperPool?.end();
    await closeTestPool();
  });

  function input(campaignId: string, userId = user.id) {
    return {
      tenant_id: tenant.id,
      account_id: account.id,
      campaign_id: campaignId,
      user_id: userId,
      assigned_by: null,
    };
  }

  /** The other supervisor's INSERT, committed on its own connection. */
  async function interloperInsert(campaignId: string, userId = user.id): Promise<string> {
    const { rows } = await interloperPool.query<{ id: string }>(
      `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.id, account.id, campaignId, userId],
    );
    return rows[0]!.id;
  }

  /** The other supervisor's unassign, committed on its own connection. */
  async function interloperClose(campaignId: string, userId = user.id): Promise<void> {
    await interloperPool.query(
      `UPDATE agency_campaign_agents SET unassigned_at = NOW()
        WHERE tenant_id = $1 AND user_id = $2 AND campaign_id = $3 AND unassigned_at IS NULL`,
      [tenant.id, userId, campaignId],
    );
  }

  async function allRows(userId = user.id) {
    const { rows } = await getTestPool().query(
      `SELECT * FROM agency_campaign_agents WHERE tenant_id = $1 AND user_id = $2
        ORDER BY assigned_at ASC, id ASC`,
      [tenant.id, userId],
    );
    return rows;
  }

  async function activeRows(userId = user.id) {
    return (await allRows(userId)).filter((r) => r.unassigned_at === null);
  }

  function activeOn(rows: Array<{ campaign_id: string }>): string[] {
    return rows.map((r) => r.campaign_id).sort();
  }

  // ══ Deterministic interleavings ════════════════════════════════════════════

  describe('a second supervisor commits the SAME assignment before ours', () => {
    it('absorbs their work rather than duplicating it — one row, and it is theirs', async () => {
      /**
       * `ON CONFLICT … DO NOTHING` makes the loser's insert return zero rows
       * instead of raising, and the read-back then finds the row that actually
       * won. The outcome the caller asked for is the outcome in the database, so
       * this is a success and not a retry.
       */
      let theirId = '';
      hoisted.interleave = {
        beforeInsert: async (attempt) => {
          if (attempt !== 1) return;
          theirId = await interloperInsert(CAMPAIGN_A);
        },
      };

      const result = await repo.assign(input(CAMPAIGN_A));

      expect(result.id).toBe(theirId);
      expect(await allRows()).toHaveLength(1);
      // One attempt: nothing here needs retrying.
      expect(hoisted.attempts).toBe(1);
    });

    it('does not conflict at all when they asked for a DIFFERENT campaign', async () => {
      /**
       * Under migration 060 this was the lost-update case: their row blocked our
       * insert, we retried, and the second pass closed theirs. Now both rows are
       * legitimate and the insert simply succeeds — which is the single clearest
       * statement of what 064 changed.
       */
      hoisted.interleave = {
        beforeInsert: async (attempt) => {
          if (attempt !== 1) return;
          await interloperInsert(CAMPAIGN_B);
        },
      };

      const result = await repo.assign(input(CAMPAIGN_A));

      expect(result.campaign_id).toBe(CAMPAIGN_A);
      expect(activeOn(await activeRows())).toEqual([CAMPAIGN_A, CAMPAIGN_B].sort());
      expect(hoisted.attempts).toBe(1);
    });
  });

  describe('an unassign closing the row our insert just conflicted with', () => {
    it('retries, and the second pass inserts', async () => {
      /**
       * The only interleaving that can still consume an attempt. Their row blocks
       * our insert; before our read-back runs, a supervisor unstaffs them. Nothing
       * was inserted and nothing is found — which must not be returned as a
       * record, or the caller reports a staffing change that never happened.
       *
       * This is also the READ COMMITTED dependency, still live: our read-back is a
       * new statement with a new snapshot, so it sees their COMMITTED close.
       */
      await interloperInsert(CAMPAIGN_A);
      hoisted.interleave = {
        beforeSelect: async (attempt) => {
          if (attempt !== 1) return;
          await interloperClose(CAMPAIGN_A);
        },
      };

      const result = await repo.assign(input(CAMPAIGN_A));

      expect(result.campaign_id).toBe(CAMPAIGN_A);
      expect(result.unassigned_at).toBeNull();
      expect(hoisted.attempts).toBe(2);
      expect(await activeRows()).toHaveLength(1);
    });

    it('retries for a MULTI-STAFFED agent, against the real catalog', async () => {
      /**
       * ── Cursor Bugbot, PR #218 — end to end ────────────────────────────────
       * The ambiguous case: our insert conflicts, the same-campaign read-back comes
       * back empty, and the agent holds OTHER live assignments. Under migration 064
       * that is an ordinary concurrent unassign of the target row, and the other
       * campaigns are irrelevant to it — but an earlier revision read that state as
       * "migration 064 is missing" and answered a misleading 409.
       *
       * It is separated from the single-assignment case above because only this one
       * exercises the index probe on a real `pg_indexes`: with the wide index in
       * place the probe must answer true and the branch must not be entered at all.
       */
      await repo.assign(input(CAMPAIGN_B));
      await interloperInsert(CAMPAIGN_A, user.id);
      hoisted.interleave = {
        beforeSelect: async (attempt) => {
          if (attempt !== 1) return;
          await interloperClose(CAMPAIGN_A);
        },
      };

      const result = await repo.assign(input(CAMPAIGN_A));

      expect(result.campaign_id).toBe(CAMPAIGN_A);
      expect(result.unassigned_at).toBeNull();
      expect(hoisted.attempts).toBe(2);
      // The unrelated assignment was never touched.
      expect(activeOn(await activeRows())).toEqual([CAMPAIGN_A, CAMPAIGN_B].sort());
    });

    it('exhausts the bounded retry and THROWS rather than reporting a phantom row', async () => {
      /**
       * A pathological interloper that re-blocks and re-closes on every pass. The
       * loop must terminate — an unbounded retry here is a spin against the
       * database — and it must throw, because there is genuinely no row to return.
       */
      hoisted.interleave = {
        beforeInsert: async () => {
          await interloperInsert(CAMPAIGN_A);
        },
        beforeSelect: async () => {
          await interloperClose(CAMPAIGN_A);
        },
      };

      await expect(repo.assign(input(CAMPAIGN_A))).rejects.toThrow(/after 3 attempts/);
      expect(hoisted.attempts).toBe(3);
    });
  });

  // ══ Genuine races ══════════════════════════════════════════════════════════

  describe('two supervisors racing, for real', () => {
    const RUNS = 8;

    it('converges on ONE row when both ask for the same campaign', async () => {
      // Repeated because the interleaving is the scheduler's choice, and a single
      // run proves nothing about the one that goes the other way.
      for (let i = 0; i < RUNS; i += 1) {
        await truncateAll();
        tenant = await insertTenant();
        account = await insertAccount({ tenant_id: tenant.id });
        user = await insertUser();

        const [a, b] = await Promise.all([
          repo.assign(input(CAMPAIGN_A)),
          repo.assign(input(CAMPAIGN_A)),
        ]);

        // Both callers are told about the same row, and it is the only one.
        expect(a.id).toBe(b.id);
        expect(await allRows()).toHaveLength(1);
      }
    });

    it('keeps BOTH when they ask for different campaigns', async () => {
      for (let i = 0; i < RUNS; i += 1) {
        await truncateAll();
        tenant = await insertTenant();
        account = await insertAccount({ tenant_id: tenant.id });
        user = await insertUser();

        await Promise.all([repo.assign(input(CAMPAIGN_A)), repo.assign(input(CAMPAIGN_B))]);

        expect(activeOn(await activeRows())).toEqual([CAMPAIGN_A, CAMPAIGN_B].sort());
      }
    });

    it('never duplicates, however five supervisors interleave', async () => {
      /**
       * Five concurrent assigns across three campaigns, with repeats. The
       * invariant is per-campaign uniqueness — the property the index still owes —
       * rather than "one active row", which is exactly the rule 064 removed.
       */
      const campaigns = [CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_A, CAMPAIGN_C, CAMPAIGN_B];

      await Promise.all(campaigns.map((c) => repo.assign(input(c))));

      const active = await activeRows();
      expect(activeOn(active)).toEqual([CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_C]);
      // No duplicate rows at all, closed ones included: nothing was inserted and
      // then tidied away.
      expect(await allRows()).toHaveLength(3);
    });
  });

  describe('two supervisors unassigning the same person at once', () => {
    it('exactly one call reports a closed row, so exactly one audit row is written', async () => {
      // The route writes its audit entry only when a row actually closed, so a
      // second reporter would double-count a single act in the trail.
      await repo.assign(input(CAMPAIGN_A));

      const results = await Promise.all([
        repo.unassign(tenant.id, CAMPAIGN_A, user.id),
        repo.unassign(tenant.id, CAMPAIGN_A, user.id),
      ]);

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await activeRows()).toHaveLength(0);
    });

    it('closes only its own campaign when two run on different ones', async () => {
      await repo.assign(input(CAMPAIGN_A));
      await repo.assign(input(CAMPAIGN_B));

      const results = await Promise.all([
        repo.unassign(tenant.id, CAMPAIGN_A, user.id),
        repo.unassign(tenant.id, CAMPAIGN_B, user.id),
      ]);

      // Both did real work — they were never competing for the same row.
      expect(results.filter((r) => r !== null)).toHaveLength(2);
      expect(await activeRows()).toHaveLength(0);
    });
  });

  describe('an unassign racing an assign', () => {
    it('leaves at most one active row for that campaign, and never a duplicate', async () => {
      // Whichever lands first, the per-campaign index must hold: either the row is
      // open or it is closed, but there are never two open ones.
      await repo.assign(input(CAMPAIGN_A));

      await Promise.all([
        repo.unassign(tenant.id, CAMPAIGN_A, user.id),
        repo.assign(input(CAMPAIGN_A)).catch(() => null),
      ]);

      const active = await activeRows();
      expect(active.length).toBeLessThanOrEqual(1);
      expect(activeOn(active).length).toBe(new Set(activeOn(active)).size);
    });
  });
});
