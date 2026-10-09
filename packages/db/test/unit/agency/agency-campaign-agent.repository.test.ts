import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `agencyCampaignAgentRepository` — the staffing rule, as migration 064 leaves it.
 *
 * ── What changed, and why most of this file's ancestor is gone ───────────────
 * Migration 060 allowed ONE active assignment per person per tenant, so `assign`
 * was a MOVE: close the old row, insert the new, inside one transaction, with a
 * bounded retry around the case where a concurrent supervisor moved the same
 * person first. The previous version of this file was mostly a simulation of that
 * — a fake client modelling BEGIN/COMMIT/ROLLBACK undo logs and READ COMMITTED
 * visibility, because the property under test was "the index is never violated,
 * not even transiently, so the close must precede the insert".
 *
 * Migration 064 widened the index to `(tenant_id, user_id, campaign_id)`. There is
 * no other row to close, so there is no move, no transaction, and no race to lose.
 * Those tests are not deleted because they became inconvenient; the behaviour they
 * pinned is behaviour this release deliberately removes, and the headline case
 * below — staffing a second campaign KEEPS the first — is the exact assertion that
 * used to read "MOVES rather than duplicates".
 *
 * ── The fake INTERPRETS the SQL; it does not merely record it ───────────────
 * An earlier version of this fake decided conflicts from a hard-coded
 * `liveRow(tenant, user, campaign)` helper and inspected the statement only for the
 * substring `ON CONFLICT`. Its header claimed that an implementation "whose
 * `ON CONFLICT` named the wrong columns" would be caught. It would not have been:
 * mutation-testing this file found four changes that keep every case green while
 * breaking production —
 *
 *   - naming the 060 arbiter `(tenant_id, user_id)` → `42P10`, 500 on every assign;
 *   - naming the columns without the partial predicate → `42P10`, same;
 *   - `DO NOTHING` → `DO UPDATE SET assigned_at = NOW()` → churns `assigned_at`,
 *     the exact bug this file says it prevents;
 *   - dropping `tenant_id = $1` from `listActiveForUser` → CROSS-TENANT LEAK.
 *
 * So the fake now reads the statement it is handed:
 *
 *   - **`ON CONFLICT` targets are validated.** A named target must match the modeled
 *     index's columns AND its predicate, or the fake raises `42P10` exactly as
 *     Postgres does. A bare target (what the code uses) matches any index.
 *   - **`DO UPDATE` is executed**, so a churned `assigned_at` shows up as one.
 *   - **`WHERE` predicates are parsed and applied** rather than assumed, so removing
 *     a predicate from the code changes what the fake returns instead of being
 *     invisible.
 *
 * The remaining honest gap is unchanged: single-threaded, no locking, and it cannot
 * tell you whether Postgres agrees about anything. `test/integration/repositories/
 * agency-campaign-agent.*` is the authority for that.
 *
 * The honest gap, unchanged: single-threaded, so "concurrent" means "an injected
 * write at a chosen point" rather than genuine interleaving, and no locking is
 * modelled. `test/integration/repositories/agency-campaign-agent.*` against real
 * Postgres is the stronger check; this is the part that runs in the unit suite.
 */

interface Row {
  id: string;
  tenant_id: string;
  account_id: string | null;
  campaign_id: string;
  user_id: string;
  assigned_by: string | null;
  assigned_at: Date;
  unassigned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const USER = 'user-1';
const OTHER_USER = 'user-2';
const CAMPAIGN_A = 'campaign-a';
const CAMPAIGN_B = 'campaign-b';
const CAMPAIGN_C = 'campaign-c';

/** The committed store. Every statement reads it live. */
let rows: Row[] = [];
/** Every statement kind the repository issued, in order. */
let statements: string[] = [];
/** Fires immediately before an INSERT is evaluated — simulates a concurrent writer. */
let beforeInsert: (() => void) | null = null;
/**
 * Fires immediately before `assign`'s read-back SELECT.
 *
 * The only place a concurrent UNASSIGN can land to matter: after our INSERT has
 * conflicted with a live row and before we read that row back. `beforeInsert` is
 * too early to model it — closing the row there just lets the INSERT succeed.
 */
let beforeSelectOne: (() => void) | null = null;
/** How many further INSERTs raise `23505` regardless of the store's state. */
let forceUniqueViolations = 0;
/**
 * How the modeled database answers `assign()`'s `pg_indexes` probe.
 *
 * `'ok'` reports {@link perCampaignIndexApplied}. The other two are the failure
 * shapes the repository handles explicitly and nothing exercised:
 *
 *  - `'throws'` — the catalog read itself fails (a dead pool, a permission the
 *    role lacks on `pg_indexes`, a statement timeout).
 *  - `'empty'` — it succeeds and returns NO ROW, so `result.rows[0]?.exists` is
 *    `undefined`. Under `noUncheckedIndexedAccess` that is a real possibility the
 *    code writes `?? true` for; it is also what a `SELECT EXISTS` would degrade
 *    to if the statement were ever rewritten.
 */
let indexProbe: 'ok' | 'throws' | 'empty' = 'ok';
let nextId = 0;
/**
 * Monotonic clock for `assigned_at`. Distinct per row so `listActiveForUser`'s
 * ordering is deterministic without leaning on the id tiebreak — which gets its
 * own test, with equal timestamps, precisely so the tiebreak is not tested only
 * by accident.
 */
let clock = 0;

class UniqueViolation extends Error {
  code = '23505';
  constraint = 'uq_agency_campaign_agent_active_campaign';
}

/** The columns of the modeled partial index, in order — migration 064's. */
const INDEX_COLUMNS = ['tenant_id', 'user_id', 'campaign_id'] as const;
/**
 * Which migration's index the modeled database has.
 *
 * `assign()` probes `pg_indexes` for this rather than inferring it from rows, so the
 * fake has to answer that probe — and being able to flip it is what lets the
 * pre-064 branch be tested at all.
 */
let perCampaignIndexApplied = true;
/** Its predicate, which a named `ON CONFLICT` target must also restate. */
const INDEX_PREDICATE = /unassigned_at\s+IS\s+NULL/i;

class InvalidOnConflict extends Error {
  code = '42P10';
}

/**
 * Validate an `ON CONFLICT` clause the way Postgres infers an arbiter.
 *
 * A BARE `DO NOTHING`/`DO UPDATE` matches any unique index. A TARGETED one must name
 * the index's columns exactly and restate its partial predicate; anything else
 * raises `42P10` and never reaches the table. Modelling this is the whole point —
 * without it, a mis-named arbiter is a green suite and a 500 in production.
 */
function assertArbiterInferable(sql: string): void {
  const target = /ON\s+CONFLICT\s*\(([^)]*)\)([\s\S]*?)DO\s+(NOTHING|UPDATE)/i.exec(sql);
  if (!target) return; // bare — matches any index
  const named = target[1]!.split(',').map((c) => c.trim());
  const between = target[2] ?? '';
  const columnsMatch =
    named.length === INDEX_COLUMNS.length &&
    named.every((c, i) => c === INDEX_COLUMNS[i]);
  if (!columnsMatch || !INDEX_PREDICATE.test(between)) {
    throw new InvalidOnConflict(
      'there is no unique or exclusion constraint matching the ON CONFLICT specification',
    );
  }
}

/**
 * The partial index, applied. Per CAMPAIGN since migration 064 — this function IS
 * the behaviour change; under 060 it took no campaign.
 */
function liveRow(tenantId: string, userId: string, campaignId: string): Row | undefined {
  return rows.find(
    (r) =>
      r.tenant_id === tenantId &&
      r.user_id === userId &&
      r.unassigned_at === null &&
      // The 060 index ignores the campaign entirely, which is exactly what makes a
      // second assignment inexpressible under it.
      (perCampaignIndexApplied ? r.campaign_id === campaignId : true),
  );
}

/**
 * Parse `col = $n` equality predicates out of a WHERE clause and return a filter.
 *
 * Applied rather than assumed, so a predicate REMOVED from the code changes what the
 * fake returns. That is what turns "dropped `tenant_id = $1` from `listActiveForUser`"
 * from an invisible mutation into a failing tenant-isolation case.
 */
function whereFilter(sql: string, values: unknown[]): (r: Row) => boolean {
  const where = sql.slice(sql.search(/\bWHERE\b/i));
  const eq = [...where.matchAll(/(\w+)\s*=\s*\$(\d+)/g)].map(([, col, pos]) => ({
    col: col as keyof Row,
    value: values[Number(pos) - 1],
  }));
  /**
   * Range predicates, applied for the same reason the equalities are: the history
   * read's `from`/`to` window is what makes its row ceiling honest rather than
   * lossy, and a fake that ignored `assigned_at >= $n` would return every row for
   * every window — so an implementation that built the clause and never bound it
   * would pass.
   */
  const cmp = [...where.matchAll(/(\w+)\s*(>=|<)\s*\$(\d+)/g)].map(([, col, op, pos]) => ({
    col: col as keyof Row,
    op: op as '>=' | '<',
    value: values[Number(pos) - 1],
  }));
  const requiresActive = INDEX_PREDICATE.test(where);
  return (r) =>
    eq.every(({ col, value }) => r[col] === value) &&
    cmp.every(({ col, op, value }) => {
      const left = r[col];
      if (!(left instanceof Date) || !(value instanceof Date)) return true;
      return op === '>=' ? left.getTime() >= value.getTime() : left.getTime() < value.getTime();
    }) &&
    (!requiresActive || r.unassigned_at === null);
}

/**
 * Apply a `LIMIT $n`, if the statement has one.
 *
 * Applied rather than assumed, on the same principle as the WHERE and ORDER BY
 * helpers: the history read's ceiling is the only thing standing between an
 * `agent`'s console and a table that grows for the life of the account, and a fake
 * that returned every row regardless would let its removal pass in silence.
 */
function limitRows(sql: string, values: unknown[], ordered: Row[]): Row[] {
  const limit = /\bLIMIT\s+\$(\d+)/i.exec(sql);
  if (!limit) return ordered;
  const n = values[Number(limit[1]) - 1];
  return typeof n === 'number' ? ordered.slice(0, n) : ordered;
}

/**
 * Apply an `ORDER BY` list of `col [ASC|DESC]` terms.
 *
 * The DIRECTION is honoured, not just the column list. It has to be: the history
 * read (`listAllForUser`) orders DESC while its active-only sibling orders ASC, so
 * a fake that ignored the keyword would report both ascending — and an
 * implementation showing an agent their oldest closed assignment first would pass.
 */
function orderRows(sql: string, matched: Row[]): Row[] {
  const order = /ORDER\s+BY\s+([\s\S]*?)(?:LIMIT|$)/i.exec(sql);
  if (!order) return matched;
  const terms = order[1]!.split(',').map((term) => {
    const [col, direction] = term.trim().split(/\s+/);
    return { col: col as keyof Row, descending: /^desc$/i.test(direction ?? '') };
  });
  return [...matched].sort((a, b) => {
    for (const { col, descending } of terms) {
      const x = a[col];
      const y = b[col];
      if (x === y) continue;
      const cmp =
        x instanceof Date && y instanceof Date
          ? x.getTime() - y.getTime()
          : String(x).localeCompare(String(y));
      if (cmp !== 0) return descending ? -cmp : cmp;
    }
    return 0;
  });
}

/**
 * The columns a statement's `RETURNING` clause actually names, projected off a row.
 *
 * Applied rather than assumed, because the two closing statements return different
 * things and both are load-bearing: `unassign` returns `id` alone, while
 * `closeAllForUser` returns `id, campaign_id` so the offboarding can write one
 * audit row per closed assignment WITH the campaign on it. A fake that always
 * returned `{ id }` would let a `RETURNING id`-only bulk close pass while the
 * offboarding trail lost the campaign each row is about.
 */
function projectReturning(sql: string, row: Row): Record<string, unknown> {
  const returning = /RETURNING\s+([\s\S]*?)(?:;|$)/i.exec(sql);
  if (!returning) return {};
  const columns = returning[1]!.split(',').map((c) => c.trim() as keyof Row);
  return Object.fromEntries(columns.map((col) => [col, row[col]]));
}

vi.mock('../../../src/connection.js', () => ({
  getPool: () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (sql: string, values: unknown[] = []): Promise<any> => {
      const text = sql.trim();

      if (text.startsWith('INSERT INTO agency_campaign_agents')) {
        statements.push('INSERT');
        // Before anything touches the table, exactly as Postgres plans first.
        assertArbiterInferable(text);
        beforeInsert?.();
        const [tenantId, accountId, campaignId, userId, assignedBy] = values as [
          string,
          string | null,
          string,
          string,
          string | null,
        ];

        /**
         * A `23505` the arbiter did not absorb. Real sources: a conflicting row
         * committing between the index probe and the insert, or a second unique
         * constraint the statement does not name. Forced rather than derived,
         * because it is not reachable from the store's state alone.
         */
        if (forceUniqueViolations > 0) {
          forceUniqueViolations -= 1;
          throw new UniqueViolation('duplicate key value violates unique constraint');
        }

        const conflicting = liveRow(tenantId, userId, campaignId);
        if (conflicting) {
          if (!/ON\s+CONFLICT/i.test(text)) throw new UniqueViolation('duplicate key value');
          // `DO UPDATE` is EXECUTED, so a churned `assigned_at` is observable.
          const doUpdate = /DO\s+UPDATE\s+SET([\s\S]*)$/i.exec(text);
          if (doUpdate) {
            if (/assigned_at\s*=/i.test(doUpdate[1]!)) conflicting.assigned_at = new Date(++clock * 1000);
            if (/updated_at\s*=/i.test(doUpdate[1]!)) conflicting.updated_at = new Date(clock * 1000);
            return { rows: [conflicting], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }

        nextId += 1;
        clock += 1;
        const at = new Date(clock * 1000);
        const row: Row = {
          id: `row-${nextId}`,
          tenant_id: tenantId,
          account_id: accountId,
          campaign_id: campaignId,
          user_id: userId,
          assigned_by: assignedBy,
          assigned_at: at,
          unassigned_at: null,
          created_at: at,
          updated_at: at,
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }

      if (text.startsWith('UPDATE agency_campaign_agents')) {
        statements.push('CLOSE');
        const matches = whereFilter(text, values);
        const closed: Array<Record<string, unknown>> = [];
        for (const row of rows) {
          if (matches(row)) {
            row.unassigned_at = new Date();
            // Whatever the statement's `RETURNING` clause names — the closed row is
            // what the audit trail references, and the bulk close needs the campaign
            // beside the id. See `projectReturning`.
            closed.push(projectReturning(text, row));
          }
        }
        return { rows: closed, rowCount: closed.length };
      }

      // `assign()`'s index probe. Answered before the table statements, since it is
      // also a SELECT.
      if (text.includes('FROM pg_indexes')) {
        statements.push('PROBE_INDEX');
        // See {@link indexProbe}: the catalog read can fail or come back empty,
        // and the repository has a documented answer for both.
        if (indexProbe === 'throws') throw new Error('permission denied for view pg_indexes');
        if (indexProbe === 'empty') return { rows: [], rowCount: 0 };
        return { rows: [{ exists: perCampaignIndexApplied }], rowCount: 1 };
      }

      if (text.startsWith('SELECT')) {
        // Labelled by what the statement actually asks for, so the ordering
        // assertions stay readable.
        const scopedToCampaign = /campaign_id\s*=\s*\$3/.test(text);
        const scopedToOneCampaign = /WHERE\s+campaign_id\s*=\s*\$1/i.test(text);
        statements.push(
          scopedToCampaign ? 'SELECT_ONE' : scopedToOneCampaign ? 'SELECT_CAMPAIGN' : 'SELECT_USER',
        );
        if (scopedToCampaign) beforeSelectOne?.();
        const matched = rows.filter(whereFilter(text, values));
        const page = limitRows(text, values, orderRows(text, matched));
        return { rows: page, rowCount: page.length };
      }

      throw new Error(`unexpected statement: ${text}`);
    },
  }),
}));

import {
  agencyCampaignAgentRepository,
  HISTORY_LIMIT_MAX,
  resetPerCampaignIndexProbe,
} from '../../../src/repositories/agency-campaign-agent.repository.js';

beforeEach(() => {
  rows = [];
  statements = [];
  beforeInsert = null;
  beforeSelectOne = null;
  forceUniqueViolations = 0;
  nextId = 0;
  clock = 0;
  perCampaignIndexApplied = true;
  indexProbe = 'ok';
  // The repository memoizes its probe for the process, so it has to be forgotten
  // between cases or the first test's schema would decide every later one's.
  resetPerCampaignIndexProbe();
});

const base = { tenant_id: TENANT, account_id: 'account-1', user_id: USER, assigned_by: 'sup-1' };

/** Commit a row the way another session would. */
function concurrentAssignment(campaignId: string, id = 'row-concurrent'): Row {
  clock += 1;
  const at = new Date(clock * 1000);
  const row: Row = {
    id,
    tenant_id: TENANT,
    account_id: 'account-1',
    campaign_id: campaignId,
    user_id: USER,
    assigned_by: 'sup-2',
    assigned_at: at,
    unassigned_at: null,
    created_at: at,
    updated_at: at,
  };
  rows.push(row);
  return row;
}

const live = () => rows.filter((r) => r.unassigned_at === null);

describe('assign — the first assignment', () => {
  it('inserts one active row', async () => {
    const result = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(result.campaign_id).toBe(CAMPAIGN_A);
    expect(result.unassigned_at).toBeNull();
    expect(live()).toHaveLength(1);
  });

  it('writes NULL — not undefined — for an OMITTED account_id and assigned_by', async () => {
    /**
     * `AssignAgentInput` makes both optional and `assign` coalesces each with
     * `?? null`. Every other case here passes them explicitly, so the default arms
     * were unreached — and `undefined` reaching `pg` in a parameter array is not a
     * NULL, it is a `TypeError` on some driver paths and a silent empty string on
     * others.
     *
     * Both columns matter beyond tidiness, and differently:
     *
     *  - `account_id` is what `closeAllForUser` returns and what the offboarding
     *    audit row is STAMPED with. A NULL there is meaningful — it says "this
     *    assignment was made by a tenant-level member, so there is no account to
     *    file the trail under" — and `closeAgencyStaffing` reads exactly that to
     *    decide whether to omit `account_id` from the audit row. A non-NULL
     *    accident would file a tenant-level assignment under a made-up account.
     *  - `assigned_by` is who staffed them, which is the other half of the
     *    "who was staffed here in March" question migration 060 exists to answer.
     *
     * The omitted form is not hypothetical: `proxy-agency-staffing.routes.ts`
     * passes `assigned_by` from `request.user?.id`, and callers that hold no
     * account context omit `account_id` rather than passing null.
     */
    const row = await agencyCampaignAgentRepository.assign({
      tenant_id: TENANT,
      user_id: USER,
      campaign_id: CAMPAIGN_A,
    });

    expect(row.account_id).toBeNull();
    expect(row.assigned_by).toBeNull();
    // And in the stored row, not only in what was returned.
    expect(rows[0]!.account_id).toBeNull();
    expect(rows[0]!.assigned_by).toBeNull();
  });

  it('needs no transaction — one statement, no BEGIN/COMMIT', async () => {
    // The point of migration 064: with no row to close there is nothing to make
    // atomic. A reintroduced transaction here would be dead weight around a
    // single statement, and this is the assertion that would notice.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(statements).toEqual(['INSERT']);
  });
});

describe('assign — staffing someone onto a SECOND campaign', () => {
  /**
   * ── The headline behaviour change ─────────────────────────────────────────
   * This assertion used to read "MOVES rather than duplicates: one active row,
   * the old one closed". Under migration 060 an agency running Renewals in the
   * morning and Collections after lunch could not staff one person on both: the
   * second Assign silently closed the first, so an ordinary afternoon handover
   * destroyed a supervisor's morning decision and the agent's landing page had no
   * way to express "which of my campaigns now?".
   */
  it('KEEPS the first — both assignments stay active', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });

    expect(live().map((r) => r.campaign_id).sort()).toEqual([CAMPAIGN_A, CAMPAIGN_B]);
  });

  it('closes nothing — no UPDATE is issued at all', async () => {
    // Stronger than counting live rows: it pins that the close STATEMENT is gone,
    // so a re-added "tidy up the old assignment" cannot pass by closing a row
    // this test happens not to look at.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    statements = [];

    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });

    expect(statements).not.toContain('CLOSE');
  });

  it('scales past two, because nothing about the rule is pairwise', async () => {
    for (const campaign of [CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_C]) {
      await agencyCampaignAgentRepository.assign({ ...base, campaign_id: campaign });
    }

    expect(live()).toHaveLength(3);
  });

  it('does not reach across tenants', async () => {
    // The same person, staffed under two tenants. Both rows are legitimate and
    // neither may affect the other — the shared-services case migration 060's
    // header calls out and 064 preserves.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({
      ...base,
      tenant_id: OTHER_TENANT,
      campaign_id: CAMPAIGN_B,
    });

    expect(live()).toHaveLength(2);
    expect(live().map((r) => r.tenant_id).sort()).toEqual([TENANT, OTHER_TENANT].sort());
  });
});

describe('assign — re-assigning to the campaign they are already on', () => {
  it('is a no-op that returns the existing row, not a fresh one', async () => {
    const first = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    const again = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(again.id).toBe(first.id);
    expect(live()).toHaveLength(1);
  });

  it('does not churn assigned_at — a double-click has not restaffed anybody', async () => {
    // "Staffed since Tuesday" is a fact supervisors read off this table. This is
    // why the statement is `DO NOTHING` plus a read-back rather than `DO UPDATE`.
    const first = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    const again = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(again.assigned_at).toEqual(first.assigned_at);
  });

  it('accepts a concurrent supervisor’s identical work', async () => {
    // Two supervisors assigning the same person to the same campaign. The loser's
    // insert returns zero rows and it reads back the winner's — the outcome the
    // caller wanted is the outcome in the database.
    beforeInsert = () => {
      beforeInsert = null;
      concurrentAssignment(CAMPAIGN_A, 'row-theirs');
    };

    const result = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(result.id).toBe('row-theirs');
    expect(live()).toHaveLength(1);
  });
});

describe('assign — a concurrent unassign closing the row we conflicted with', () => {
  it('retries, and the second pass inserts', async () => {
    /**
     * The only way to consume an attempt since migration 064: our insert conflicts
     * with a live row, and by the time we read it back a supervisor has unstaffed
     * it. Nothing is inserted and nothing is found — which must not return
     * `undefined` as a record.
     */
    const theirs = concurrentAssignment(CAMPAIGN_A, 'row-theirs');
    beforeSelectOne = () => {
      beforeSelectOne = null;
      theirs.unassigned_at = new Date();
    };

    const result = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(result.id).not.toBe('row-theirs');
    expect(result.campaign_id).toBe(CAMPAIGN_A);
    expect(statements.filter((s) => s === 'INSERT')).toHaveLength(2);
  });

  it('retries for a MULTI-STAFFED agent instead of crying upgrade-pending', async () => {
    /**
     * ── Cursor Bugbot, PR #218 ────────────────────────────────────────────────
     * The pre-064 branch used to be entered whenever the read-back came back empty
     * AND any other live row existed for this person. Under 064 that combination is
     * ordinary: the insert conflicts only on the TARGET campaign, so an empty
     * read-back means that one row was just unassigned — and the agent's other
     * assignments are irrelevant to it.
     *
     * So a multi-staffed agent hitting the very race the retry loop exists for got
     * a misleading 409 instead of a completed assign. The index shape is now
     * checked directly rather than inferred from row state.
     */
    concurrentAssignment(CAMPAIGN_B, 'row-other-campaign');
    const target = concurrentAssignment(CAMPAIGN_A, 'row-target');
    beforeSelectOne = () => {
      beforeSelectOne = null;
      target.unassigned_at = new Date();
    };

    const result = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(result.campaign_id).toBe(CAMPAIGN_A);
    expect(result.unassigned_at).toBeNull();
    // Both assignments live: the unrelated one was never touched.
    expect(live().map((r) => r.campaign_id).sort()).toEqual([CAMPAIGN_A, CAMPAIGN_B].sort());
  });

  it('gives up after ASSIGN_MAX_ATTEMPTS rather than looping', async () => {
    // A pathological client must not turn this into a spin against the database.
    // It must THROW: a caller handed `undefined` as a record would report a
    // staffing change that never happened.
    const theirs = concurrentAssignment(CAMPAIGN_A, 'row-theirs');
    // Live for every index check, closed for every read-back — the retry can
    // never make progress.
    beforeInsert = () => {
      theirs.unassigned_at = null;
    };
    beforeSelectOne = () => {
      theirs.unassigned_at = new Date();
    };

    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A }),
    ).rejects.toThrow(/after 3 attempts/);
    expect(statements.filter((s) => s === 'INSERT')).toHaveLength(3);
  });
});

describe('assign — against a database that has NOT had migration 064', () => {
  /**
   * The pre-064 branch, which only became testable once the index shape was a
   * probe rather than an inference. Reachable in one situation: this code deployed
   * against a database where 064 has not been applied, or one where it was rolled
   * back with `migrate down`.
   */
  beforeEach(() => {
    perCampaignIndexApplied = false;
    resetPerCampaignIndexProbe();
  });

  it('still makes a FIRST assignment normally', async () => {
    // The narrow index refuses only a SECOND campaign. Nothing about this release
    // should change the ordinary case on an un-migrated database.
    const result = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(result.campaign_id).toBe(CAMPAIGN_A);
    expect(live()).toHaveLength(1);
  });

  it('is still idempotent on the campaign they are already on', async () => {
    const first = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    const again = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(again.id).toBe(first.id);
    expect(live()).toHaveLength(1);
  });

  it('refuses a SECOND campaign with a typed error rather than moving them', async () => {
    /**
     * The whole point of the branch. Under 060's index a second assignment cannot
     * exist, and the destructive alternative — closing the first row, which is what
     * this code used to do — would make the result of one request depend on which
     * migration had run. The route turns this into a 409 naming both remedies.
     */
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B }),
    ).rejects.toMatchObject({
      code: 'staffing_upgrade_pending',
      currentCampaignId: CAMPAIGN_A,
      requestedCampaignId: CAMPAIGN_B,
    });

    // And the existing assignment is untouched — nothing was "moved".
    expect(live().map((r) => r.campaign_id)).toEqual([CAMPAIGN_A]);
  });

  it('does not burn retries on a refusal it knows cannot succeed', async () => {
    // Retrying an inexpressible insert three times is three pointless round trips
    // before the same answer.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    statements = [];

    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B }),
    ).rejects.toThrow();

    expect(statements.filter((x) => x === 'INSERT')).toHaveLength(1);
  });
});

describe('assign — the index probe', () => {
  it('is asked once and memoized, not re-probed per assignment', async () => {
    // It answers a question about the schema, which cannot change under a running
    // process without a deployment.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });

    expect(statements.filter((x) => x === 'PROBE_INDEX').length).toBeLessThanOrEqual(1);
  });

  it('is not probed at all on the ordinary path', async () => {
    // Only the ambiguous conflict needs it, so a healthy assign pays nothing.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(statements).not.toContain('PROBE_INDEX');
  });

  /**
   * ── When the probe itself fails ───────────────────────────────────────────
   * `hasPerCampaignIndex` wraps the catalog read in a `.catch()` that returns
   * `true` — "assume 064 IS present" — and clears the memo so a bad answer is not
   * pinned. Neither half was reached by any case: coverage put
   * `agency-campaign-agent.repository.ts:139-140` (the two lines inside that
   * catch) among the file's only unexecuted lines.
   *
   * The DIRECTION is the whole point, and the docstring states it: failing open is
   * safe because 064 is the settled state of every deployment past that release,
   * and the cost of being wrong that way is a worse message for a rare case
   * (retry-exhaustion instead of the tailored 409). Failing the other way hands a
   * confident, wrong "finish upgrading" 409 to every racing assign on a perfectly
   * healthy database — a permanent 409 on an ordinary supervisor action, caused by
   * a catalog read that flaked once.
   *
   * Only expressible with the probe answering something other than a row, which is
   * why the harness gained {@link indexProbe}. Each case sets up a genuinely
   * PRE-064 database, because that is the only state where the two directions give
   * different answers.
   */
  it('assumes 064 IS applied when the catalog read THROWS', async () => {
    perCampaignIndexApplied = false;
    resetPerCampaignIndexProbe();
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    indexProbe = 'throws';

    // Retry-exhaustion — what "assume 064" leads to. Emphatically NOT the typed
    // upgrade-pending refusal, which is what a fail-CLOSED probe would produce
    // here and which would be a wrong, confident answer on a healthy database.
    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B }),
    ).rejects.toThrow(/after 3 attempts/);
    // The existing row is still untouched either way: no "move" happened.
    expect(live().map((r) => r.campaign_id)).toEqual([CAMPAIGN_A]);
  });

  it('assumes 064 IS applied when the catalog read comes back EMPTY', async () => {
    // `result.rows[0]?.exists ?? true` — the `?? true` arm. Same direction,
    // a different way of learning nothing: the read succeeds and says nothing.
    perCampaignIndexApplied = false;
    resetPerCampaignIndexProbe();
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    indexProbe = 'empty';

    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B }),
    ).rejects.toThrow(/after 3 attempts/);
  });

  it('does NOT pin a failed answer for the process — it re-probes', async () => {
    /**
     * The second half of the catch, and the line a reader is most likely to delete
     * as redundant: `perCampaignIndexProbe = null` before returning.
     *
     * Without it, ONE flaked catalog read — a statement timeout under load, a
     * failover, a role that briefly lacked the grant — makes every later `assign`
     * on this process take the memoized fail-open answer, for the lifetime of the
     * pod. On a genuinely pre-064 database that converts the tailored 409 into
     * permanent retry-exhaustion 500s recoverable only by a restart, and nothing
     * in the logs connects the two events.
     *
     * Counted rather than inferred: a memoized failure probes once across two
     * ambiguous assigns, a cleared one probes on each.
     */
    perCampaignIndexApplied = false;
    resetPerCampaignIndexProbe();
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    indexProbe = 'throws';

    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B }),
    ).rejects.toThrow();
    expect(statements).toContain('PROBE_INDEX');

    statements = [];
    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_C }),
    ).rejects.toThrow();

    // Asked AGAIN. A memoized failure would leave this empty.
    expect(statements).toContain('PROBE_INDEX');
  });

  it('DOES pin a successful answer, so the memo still earns its keep', async () => {
    /**
     * The contrast that makes the case above about the CATCH specifically rather
     * than about memoization in general. A probe that ANSWERS is asked once and
     * never again — the schema cannot change under a running process without a
     * deployment — so clearing the memo unconditionally would put a catalog read
     * on every ambiguous assign, which is the cost the memo exists to avoid.
     */
    perCampaignIndexApplied = false;
    resetPerCampaignIndexProbe();
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B }),
    ).rejects.toMatchObject({ code: 'staffing_upgrade_pending' });
    statements = [];
    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_C }),
    ).rejects.toMatchObject({ code: 'staffing_upgrade_pending' });

    expect(statements).not.toContain('PROBE_INDEX');
  });
});

describe('assign — a 23505 the arbiter did not absorb', () => {
  it('retries once and succeeds', async () => {
    forceUniqueViolations = 1;

    const result = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(result.campaign_id).toBe(CAMPAIGN_A);
    expect(statements.filter((s) => s === 'INSERT')).toHaveLength(2);
  });

  it('propagates on the final attempt rather than swallowing it', async () => {
    forceUniqueViolations = 99;

    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('does not retry an unrelated error', async () => {
    // Only `23505` is a retryable condition. Anything else — a dropped
    // connection, a permission error — must surface untouched and immediately.
    beforeInsert = () => {
      throw new Error('connection terminated unexpectedly');
    };

    await expect(
      agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A }),
    ).rejects.toThrow(/connection terminated/);
    expect(statements.filter((s) => s === 'INSERT')).toHaveLength(1);
  });
});

describe('unassign', () => {
  it('returns the CLOSED ROW’S ID, which is what the audit row references', async () => {
    const assigned = await agencyCampaignAgentRepository.assign({
      ...base,
      campaign_id: CAMPAIGN_A,
    });

    const closed = await agencyCampaignAgentRepository.unassign(TENANT, CAMPAIGN_A, USER);

    expect(closed).toBe(assigned.id);
    expect(live()).toHaveLength(0);
  });

  it('returns null when there was nothing to close, so the route skips the audit row', async () => {
    expect(await agencyCampaignAgentRepository.unassign(TENANT, CAMPAIGN_A, USER)).toBeNull();
  });

  it('closes only the named campaign, leaving their other assignments alone', async () => {
    // Campaign-scoped, and since 064 that scoping does real work on the ordinary
    // path rather than only guarding a stale console: an agent genuinely holds
    // several assignments, and unstaffing them from one must not touch the rest.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });

    await agencyCampaignAgentRepository.unassign(TENANT, CAMPAIGN_A, USER);

    expect(live().map((r) => r.campaign_id)).toEqual([CAMPAIGN_B]);
  });

  it('does not reach across tenants', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(
      await agencyCampaignAgentRepository.unassign(OTHER_TENANT, CAMPAIGN_A, USER),
    ).toBeNull();
    expect(live()).toHaveLength(1);
  });
});

describe('listActiveForUser', () => {
  it('returns every campaign the agent is staffed on, oldest first', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });

    const found = await agencyCampaignAgentRepository.listActiveForUser(TENANT, USER);

    expect(found.map((r) => r.campaign_id)).toEqual([CAMPAIGN_A, CAMPAIGN_B]);
  });

  it('omits closed rows', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });
    await agencyCampaignAgentRepository.unassign(TENANT, CAMPAIGN_A, USER);

    const found = await agencyCampaignAgentRepository.listActiveForUser(TENANT, USER);

    expect(found.map((r) => r.campaign_id)).toEqual([CAMPAIGN_B]);
  });

  it('is scoped to this tenant and this user', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({
      ...base,
      tenant_id: OTHER_TENANT,
      campaign_id: CAMPAIGN_B,
    });
    await agencyCampaignAgentRepository.assign({
      ...base,
      user_id: OTHER_USER,
      campaign_id: CAMPAIGN_C,
    });

    const found = await agencyCampaignAgentRepository.listActiveForUser(TENANT, USER);

    expect(found.map((r) => r.campaign_id)).toEqual([CAMPAIGN_A]);
  });

  it('returns an empty array for an unstaffed agent, not null', async () => {
    // The route maps this straight onto `{ assignments: [] }` — the collection's
    // representation of "nobody has staffed me".
    expect(await agencyCampaignAgentRepository.listActiveForUser(TENANT, USER)).toEqual([]);
  });

  it('breaks an assigned_at tie by id, so the order is stable across reads', async () => {
    /**
     * Two rows written in the same transaction — a supervisor staffing somebody
     * onto two campaigns at once — share a timestamp. Without the id tiebreak
     * Postgres may return them in either order on either read, and the agent's
     * picker would shuffle under their cursor.
     */
    const at = new Date(5000);
    // Inserted in the order that would come back WRONG if the id were ignored.
    concurrentAssignment(CAMPAIGN_B, 'row-b').assigned_at = at;
    concurrentAssignment(CAMPAIGN_A, 'row-a').assigned_at = at;

    const found = await agencyCampaignAgentRepository.listActiveForUser(TENANT, USER);

    expect(found.map((r) => r.id)).toEqual(['row-a', 'row-b']);
  });
});

describe('findActiveForUser — the deprecated singular read', () => {
  it('answers the OLDEST assignment, so a stale console keeps its yesterday', async () => {
    /**
     * Oldest rather than newest, deliberately: a browser tab loaded before this
     * release calls `GET /my-assignment`, which cannot mention a second campaign.
     * Sending it to the longest-standing assignment keeps it pointing where it
     * pointed yesterday, instead of silently following staffing edits it has no UI
     * to explain.
     */
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });

    const found = await agencyCampaignAgentRepository.findActiveForUser(TENANT, USER);

    expect(found?.campaign_id).toBe(CAMPAIGN_A);
  });

  it('is null for an unstaffed agent, which is the route’s 204', async () => {
    expect(await agencyCampaignAgentRepository.findActiveForUser(TENANT, USER)).toBeNull();
  });
});

describe('listActiveForCampaign', () => {
  it('lists only live rows for the campaign, and only within the tenant', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({
      ...base,
      user_id: OTHER_USER,
      campaign_id: CAMPAIGN_A,
    });
    await agencyCampaignAgentRepository.assign({
      ...base,
      tenant_id: OTHER_TENANT,
      campaign_id: CAMPAIGN_A,
    });
    await agencyCampaignAgentRepository.unassign(TENANT, CAMPAIGN_A, OTHER_USER);

    const found = await agencyCampaignAgentRepository.listActiveForCampaign(CAMPAIGN_A, TENANT);

    expect(found.map((r) => r.user_id)).toEqual([USER]);
  });
});

describe('listAllForUser — the HISTORY read, closed rows included', () => {
  /**
   * ── The property, and why it needed a second method ──────────────────────
   * Migration 060 closes rows rather than deleting them so *"who was staffed on
   * this campaign in March"* stays answerable. Until this method existed every
   * reader on the table carried `unassigned_at IS NULL`, so that history was
   * written and unreadable.
   *
   * The first case below is the whole point: an implementation built on
   * `listActiveForUser` returns the right SHAPE and simply never mentions a closed
   * assignment, which is a bug no shape assertion can see.
   */
  it('returns closed assignments as well as active ones', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });
    await agencyCampaignAgentRepository.unassign(TENANT, CAMPAIGN_A, USER);

    const all = await agencyCampaignAgentRepository.listAllForUser(TENANT, USER);

    expect(all.map((r) => r.campaign_id).sort()).toEqual([CAMPAIGN_A, CAMPAIGN_B]);
    // And the closed one is identifiable as closed, not silently indistinguishable.
    expect(all.find((r) => r.campaign_id === CAMPAIGN_A)!.unassigned_at).not.toBeNull();
    expect(all.find((r) => r.campaign_id === CAMPAIGN_B)!.unassigned_at).toBeNull();
  });

  it('does not carry the active-only predicate at all', async () => {
    // Asserted on the statement, because a route can only be as correct as the SQL:
    // the whole defect was that every reader had this predicate.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    statements = [];

    await agencyCampaignAgentRepository.listAllForUser(TENANT, USER);

    expect(statements).toEqual(['SELECT_USER']);
  });

  it('orders NEWEST first, unlike its active-only sibling', async () => {
    /**
     * A history's useful end is the recent one — an agent with two years of closed
     * rows should not scroll to find this month. `listActiveForUser` deliberately
     * sorts the other way because it feeds a stable picker, so the two directions
     * are a real difference and not an inconsistency.
     */
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_C });

    const all = await agencyCampaignAgentRepository.listAllForUser(TENANT, USER);
    const active = await agencyCampaignAgentRepository.listActiveForUser(TENANT, USER);

    expect(all.map((r) => r.campaign_id)).toEqual([CAMPAIGN_C, CAMPAIGN_B, CAMPAIGN_A]);
    expect(active.map((r) => r.campaign_id)).toEqual([CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_C]);
  });

  it('never returns another tenant’s rows', async () => {
    // The tenant predicate is in the same statement as the read, per rule 1 of
    // CLAUDE.md's RBAC section — a user id says nothing about which tenant is asking.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({
      ...base,
      tenant_id: OTHER_TENANT,
      campaign_id: CAMPAIGN_B,
    });

    const all = await agencyCampaignAgentRepository.listAllForUser(TENANT, USER);

    expect(all.map((r) => r.campaign_id)).toEqual([CAMPAIGN_A]);
  });

  it('never returns another person’s rows', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({
      ...base,
      user_id: OTHER_USER,
      campaign_id: CAMPAIGN_B,
    });

    const all = await agencyCampaignAgentRepository.listAllForUser(TENANT, USER);

    expect(all.every((r) => r.user_id === USER)).toBe(true);
  });

  it('answers with an empty array for someone never staffed', async () => {
    expect(await agencyCampaignAgentRepository.listAllForUser(TENANT, USER)).toEqual([]);
  });
});

describe('listAllForUser — the history is BOUNDED', () => {
  /**
   * The docstring used to say "deliberately UNBOUNDED … a handful per campaign per
   * year, not a growing log", and nominated the remedy in the same breath. The
   * assumption does not survive the table: this read returns CLOSED rows too, so
   * the count only ever grows — every reassignment adds one, `closeAllForUser`
   * manufactures one per campaign in a single statement, and nothing ever removes
   * one, which is exactly what migration 060 chose. Its only caller is a route an
   * `agent` hits on their own console, which then spends a core round trip per
   * distinct campaign.
   */
  async function staffOver(count: number) {
    for (let i = 0; i < count; i += 1) {
      await agencyCampaignAgentRepository.assign({ ...base, campaign_id: `campaign-${i}` });
    }
  }

  it('caps the page at the repository ceiling', async () => {
    await staffOver(HISTORY_LIMIT_MAX + 5);

    const page = await agencyCampaignAgentRepository.listAllForUser(TENANT, USER);

    expect(page).toHaveLength(HISTORY_LIMIT_MAX);
  });

  it('caps at the ceiling even when the caller asks for more', async () => {
    // A limit a route could raise is not a ceiling. Clamped here rather than
    // trusted, because the repository is only as bounded as its least careful
    // caller.
    await staffOver(HISTORY_LIMIT_MAX + 5);

    const page = await agencyCampaignAgentRepository.listAllForUser(TENANT, USER, {
      limit: 100_000,
    });

    expect(page).toHaveLength(HISTORY_LIMIT_MAX);
  });

  it('clamps a non-positive limit to ONE row, never to none', async () => {
    /**
     * The deliberate half of the clamp. `agency_campaign_agents` has already
     * produced a defect that rendered every agent's staffing empty, and an empty
     * page is indistinguishable from it — so a silly request gets a row and
     * something to notice rather than silence.
     */
    await staffOver(3);

    expect(await agencyCampaignAgentRepository.listAllForUser(TENANT, USER, { limit: 0 }))
      .toHaveLength(1);
    expect(await agencyCampaignAgentRepository.listAllForUser(TENANT, USER, { limit: -20 }))
      .toHaveLength(1);
  });

  it('keeps the page NEWEST-first, so the cap keeps the recent end', async () => {
    // The ordering and the ceiling are one feature: a cap on an ascending list
    // would hand an agent their oldest closed assignments and hide this month's.
    await staffOver(HISTORY_LIMIT_MAX + 3);

    const page = await agencyCampaignAgentRepository.listAllForUser(TENANT, USER);

    const times = page.map((r) => r.assigned_at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(page[0]!.campaign_id).toBe(`campaign-${HISTORY_LIMIT_MAX + 2}`);
  });

  it('windows on assigned_at, which is what makes the ceiling non-lossy', async () => {
    /**
     * `from`/`to` rather than a cursor — the shape the docstring nominated,
     * because the question a staffing history answers is always about a PERIOD.
     * The window bounds `assigned_at`, the column the ordering is on, so "newest
     * first, capped" and "this period" compose instead of fighting.
     *
     * The fake pg applies the range predicates, so a clause built and never bound
     * would fail here rather than pass quietly.
     */
    await staffOver(4);
    const [oldest, , , newest] = [...rows].sort(
      (a, b) => a.assigned_at.getTime() - b.assigned_at.getTime(),
    );

    const from = new Date(newest!.assigned_at.getTime());
    expect(
      (await agencyCampaignAgentRepository.listAllForUser(TENANT, USER, { from }))
        .map((r) => r.campaign_id),
    ).toEqual([newest!.campaign_id]);

    // `to` is EXCLUSIVE, so a window ending at a row's own timestamp omits it.
    const to = new Date(oldest!.assigned_at.getTime() + 1);
    expect(
      (await agencyCampaignAgentRepository.listAllForUser(TENANT, USER, { to }))
        .map((r) => r.campaign_id),
    ).toEqual([oldest!.campaign_id]);
  });

  it('keeps the tenant and user predicates alongside the window', async () => {
    // Rule 1 of CLAUDE.md's RBAC section: adding a window must not displace the
    // scoping that makes the read safe.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({
      ...base, tenant_id: OTHER_TENANT, campaign_id: CAMPAIGN_B,
    });
    await agencyCampaignAgentRepository.assign({
      ...base, user_id: OTHER_USER, campaign_id: CAMPAIGN_C,
    });

    const page = await agencyCampaignAgentRepository.listAllForUser(TENANT, USER, {
      from: new Date(0),
    });

    expect(page.map((r) => r.campaign_id)).toEqual([CAMPAIGN_A]);
  });
});

describe('closeAllForUser — the offboarding close', () => {
  /**
   * ── The leak it closes ──────────────────────────────────────────────────
   * Nothing in master called any bulk unassign — the staffing route was this
   * repository's only caller — so a removed member stayed on every supervisor's
   * staffing list forever.
   *
   * ── And what it must NOT do ─────────────────────────────────────────────
   * Reach beyond the (tenant, user) pair. A close that dropped either predicate
   * would unstaff a whole tenant, or the same person across every tenant they work
   * for — a shared-services agent contracted to several tenants is the case
   * migration 060 explicitly kept working.
   */
  it('closes every open assignment for that person in that tenant', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });

    const closed = await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

    expect(closed).toHaveLength(2);
    expect(live()).toHaveLength(0);
  });

  it('returns the ASSIGNMENT id, the campaign and the ACCOUNT for each closed row', async () => {
    /**
     * Not a count. The caller writes one `agency_campaign_agent.unassigned` audit
     * row per closed assignment, whose `resource_id` must be the assignment (filing
     * the campaign id there is the mistake the single-row `unassign` already made)
     * and whose `campaign_id` column needs the campaign. A count could express
     * neither.
     *
     * `account_id` is the third, and it is the one with a scoping consequence:
     * `GET /audit-log` confines an account-scoped membership to rows stamped with
     * its own account, so an audit row written under the ACTOR's account is
     * invisible to the `account_admin` whose roster actually changed.
     */
    const a = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    const b = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });

    const closed = await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

    expect([...closed].sort((x, y) => x.campaign_id.localeCompare(y.campaign_id))).toEqual([
      { id: a.id, campaign_id: CAMPAIGN_A, account_id: 'account-1' },
      { id: b.id, campaign_id: CAMPAIGN_B, account_id: 'account-1' },
    ]);
  });

  it('reports each row’s OWN account, across accounts and including a NULL', async () => {
    /**
     * The shape that makes a single actor-supplied account wrong: this closes
     * across every account in the tenant, so there is no one account the whole
     * batch belongs to. A tenant-level member (`account_id IS NULL`) writes NULL
     * into the column, and that comes back as NULL rather than being back-filled —
     * the caller must not invent an account for a row that never had one.
     */
    const a = await agencyCampaignAgentRepository.assign({
      ...base, account_id: 'account-1', campaign_id: CAMPAIGN_A,
    });
    const b = await agencyCampaignAgentRepository.assign({
      ...base, account_id: 'account-2', campaign_id: CAMPAIGN_B,
    });
    const c = await agencyCampaignAgentRepository.assign({
      ...base, account_id: null, campaign_id: CAMPAIGN_C,
    });

    const closed = await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

    expect(new Map(closed.map((r) => [r.id, r.account_id]))).toEqual(
      new Map([[a.id, 'account-1'], [b.id, 'account-2'], [c.id, null]]),
    );
  });

  it('leaves other people’s staffing alone', async () => {
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({
      ...base,
      user_id: OTHER_USER,
      campaign_id: CAMPAIGN_A,
    });

    await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

    expect(live().map((r) => r.user_id)).toEqual([OTHER_USER]);
  });

  it('leaves the same person’s staffing in ANOTHER tenant alone', async () => {
    // A shared-services agent contracted to several tenants: offboarding them from
    // one must not end their shift at the other.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({
      ...base,
      tenant_id: OTHER_TENANT,
      campaign_id: CAMPAIGN_B,
    });

    await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

    expect(live().map((r) => r.tenant_id)).toEqual([OTHER_TENANT]);
  });

  it('is idempotent: a second call closes nothing and reports nothing', async () => {
    // An offboarding can be retried, and a membership can be removed twice in two
    // tabs. Neither should produce a second round of audit rows claiming a staffing
    // change that already happened.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });

    expect(await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER)).toHaveLength(1);
    expect(await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER)).toEqual([]);
  });

  it('does not re-close an already-closed row', async () => {
    // `unassigned_at IS NULL` in the same statement, so a row closed in March keeps
    // its March timestamp — "when did they come off this campaign" is the question a
    // dispute asks, and rewriting it to today's date destroys the answer.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.unassign(TENANT, CAMPAIGN_A, USER);
    const closedAt = rows[0]!.unassigned_at;

    const closed = await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

    expect(closed).toEqual([]);
    expect(rows[0]!.unassigned_at).toBe(closedAt);
  });

  it('closes ONLY the open rows when the history is MIXED, and reports only those', async () => {
    /**
     * ── Why the all-closed case above is not sufficient ───────────────────────
     * That case proves the filter with ONE row, already closed, and the return is
     * `[]` either way it is written — an implementation that re-closed everything
     * would return one row, so it is caught. What it cannot show is the shape a
     * real offboarding actually meets: a person with YEARS of closed rows and two
     * live ones. `agency_campaign_agents` only ever grows (migration 060 closes
     * rather than deletes, `closeAllForUser` manufactures one row per assignment,
     * nothing removes any), so by the time somebody leaves, the closed rows
     * outnumber the open ones and the filter is doing real work.
     *
     * ── The consequence, which is about the AUDIT TRAIL, not the table ────────
     * The caller writes one `agency_campaign_agent.unassigned` audit row PER
     * RETURNED ROW. So a `closeAllForUser` that returned already-closed rows would
     * not merely be untidy: it would file an audit row today claiming a staffing
     * change that happened in March, against an assignment that has not moved.
     * The trail is what a dispute reads, and this is the surface justified by
     * disputes.
     *
     * Two properties, and neither follows from the other:
     *  - the two closed rows keep their ORIGINAL timestamps (nothing was rewritten);
     *  - only the two formerly-open assignments come back (nothing extra audited).
     */
    const staleA = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.unassign(TENANT, CAMPAIGN_A, USER);
    const staleB = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });
    await agencyCampaignAgentRepository.unassign(TENANT, CAMPAIGN_B, USER);
    // Re-staffed onto A, and freshly onto C: two OPEN rows against two closed.
    const openA = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    const openC = await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_C });
    const stampBefore = new Map(
      rows.filter((r) => r.unassigned_at !== null).map((r) => [r.id, r.unassigned_at]),
    );
    expect(stampBefore.size).toBe(2);

    const closed = await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

    // Exactly the two that were open. Note `openA` shares CAMPAIGN_A with a closed
    // row, so a filter keyed on the campaign instead of on `unassigned_at` would
    // return three.
    expect(new Set(closed.map((r) => r.id))).toEqual(new Set([openA.id, openC.id]));
    expect(closed).toHaveLength(2);
    // And the March rows still say March.
    for (const [id, at] of stampBefore) {
      expect(rows.find((r) => r.id === id)!.unassigned_at, `row ${id}`).toBe(at);
    }
    // Nothing is left open.
    expect(live()).toHaveLength(0);
    // Still one statement, even with a mixed history to sift.
    expect(statements.filter((x) => x === 'CLOSE')).toHaveLength(3);
  });

  it('returns each open row exactly once, so no assignment is audited twice', async () => {
    /**
     * The multiplicity, asserted on its own. The caller loops over this array and
     * writes an audit row per element, so a duplicated entry is a duplicated
     * trail entry for one staffing change — and `closeAllForUser` has no
     * `DISTINCT` and needs none, because a single `UPDATE … RETURNING` cannot
     * return a row twice. Pinned because that guarantee is a property of the
     * statement being one `UPDATE`, and the "closes in ONE statement" case next
     * door is what protects it.
     */
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_C });

    const closed = await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

    expect(closed).toHaveLength(3);
    expect(new Set(closed.map((r) => r.id)).size).toBe(3);
    // And one row per CAMPAIGN too — the audit row carries `campaign_id` as a
    // first-class column, so a duplicate there is a duplicate in the trail.
    expect(new Set(closed.map((r) => r.campaign_id)).size).toBe(3);
  });

  it('closes in ONE statement rather than a row at a time', async () => {
    // A read-then-close-each loop leaves an interrupted offboarding partly applied
    // with no way to tell which rows survived, and it is N round trips for one fact.
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_A });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_B });
    await agencyCampaignAgentRepository.assign({ ...base, campaign_id: CAMPAIGN_C });
    statements = [];

    await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

    expect(statements).toEqual(['CLOSE']);
  });

  it('answers with an empty array for someone who was never staffed', async () => {
    expect(await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER)).toEqual([]);
  });

  describe('an optional accountId narrows the close to that account', () => {
    /**
     * ── Why this exists ────────────────────────────────────────────────────
     * `user.routes.ts`'s account-scope guard confines WHICH membership an
     * account-scoped caller may change, but the offboarding side effect
     * (this method) used to ignore that scope entirely and close every open
     * assignment in the tenant regardless of caller. An account_admin
     * confined to account A could offboard a user out of A and, as an
     * unrequested side effect, close that user's staffing on a campaign in
     * sibling account B too. `accountId`, when passed, is exactly the fix:
     * equality, not `IS NULL OR =`, so it composes with the existing
     * tenant+user predicate rather than replacing it.
     */
    it('closes only the rows in that account when accountId is given', async () => {
      const inScope = await agencyCampaignAgentRepository.assign({
        ...base, account_id: 'account-a', campaign_id: CAMPAIGN_A,
      });
      await agencyCampaignAgentRepository.assign({
        ...base, account_id: 'account-b', campaign_id: CAMPAIGN_B,
      });

      const closed = await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER, 'account-a');

      expect(closed).toEqual([{ id: inScope.id, campaign_id: CAMPAIGN_A, account_id: 'account-a' }]);
      expect(live().map((r) => r.account_id)).toEqual(['account-b']);
    });

    it('never touches a TENANT-LEVEL assignment (account_id IS NULL) via a scoped close', async () => {
      // Equality, not `IS NULL OR =`: `NULL = $3` is never true in SQL, so a
      // tenant-wide assignment is correctly unreachable to a scoped close —
      // the same reasoning `dncRepository.deleteById`'s scoped branch applies.
      await agencyCampaignAgentRepository.assign({
        ...base, account_id: null, campaign_id: CAMPAIGN_A,
      });

      const closed = await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER, 'account-a');

      expect(closed).toEqual([]);
      expect(live()).toHaveLength(1);
    });

    it('omitting accountId still closes every account, unchanged', async () => {
      await agencyCampaignAgentRepository.assign({
        ...base, account_id: 'account-a', campaign_id: CAMPAIGN_A,
      });
      await agencyCampaignAgentRepository.assign({
        ...base, account_id: 'account-b', campaign_id: CAMPAIGN_B,
      });

      const closed = await agencyCampaignAgentRepository.closeAllForUser(TENANT, USER);

      expect(closed).toHaveLength(2);
      expect(live()).toHaveLength(0);
    });
  });
});
