import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant } from '../setup/factories.js';

/**
 * ─── MAG-102 · THE PER-NUMBER DNC LOOKUP USES THE PLAIN INDEX ────────────────
 *
 * `dnc.repository.ts`'s `findSuppressed` carries a doc comment asserting that it
 * is "**one query per batch, served by `idx_dnc_entries_tenant_phone`**", and
 * that "the `COALESCE` unique index cannot answer this — it is prefixed on the
 * scope expressions, so a per-number probe would seq-scan". That claim is the
 * entire justification for design §2.3 requiring a second, plain index on a table
 * that already has a unique one. Until this file, **nothing checked it.** It was
 * a comment.
 *
 * It is worth checking because the failure is silent and expensive. This is the
 * ingest hot path — one query per 500-contact CSV batch
 * (`agency-ingest.service.ts` → `dropSuppressed`) — and a plan that falls back to
 * a sequential scan of `dnc_entries` produces no error, no warning and no failed
 * test. It just gets slower in proportion to the tenant's suppression list, on
 * the code path a customer waits on while uploading a roster.
 *
 * ── WHY THE ROW COUNT IS PART OF THE ASSERTION ──────────────────────────────
 *
 * A plan proven on a handful of rows proves nothing: Postgres will sequentially
 * scan a table that fits in a page or two no matter what indexes exist, so a
 * five-row fixture would make the "uses the index" assertion **red on a correct
 * system** — and the natural way to make it pass would be `SET enable_seqscan =
 * off`, which converts the whole test into a tautology (with seq scans forbidden
 * the planner must use *some* index, and it would happily pick the wrong one).
 *
 * So this file does neither. It seeds {@link SEEDED_ROWS} rows, leaves
 * `enable_seqscan` at its default `on` throughout, and the first case below pins
 * the *contrast* — that at five rows the planner genuinely does prefer a
 * sequential scan. That case is what makes the seeding load-bearing rather than
 * decorative: if someone later trims the fixture to speed the suite up, they will
 * see exactly why they cannot.
 *
 * ── WHY THE ASSERTION IS ON THE INDEX NAME ──────────────────────────────────
 *
 * `dnc_entries` carries three indexes besides its primary key's, and **two of
 * them are plausible wrong answers** rather than hypothetical ones:
 *
 *   - `uq_dnc_scope` — UNIQUE, and it *leads with `tenant_id`* and *contains
 *     `phone_e164`*, just behind two `COALESCE(...)` scope expressions. It is the
 *     index the repository comment specifically says cannot serve this query.
 *   - `idx_dnc_entries_tenant_created` — also leads with `tenant_id`.
 *
 * A "some index was used" assertion, or one that merely checks the query returns
 * the right rows, is satisfied by either of those. So is an assertion on the node
 * *shape* (`Index Scan` / `Bitmap Index Scan`). The only assertion that separates
 * the correct plan from the two wrong ones is the index's **name**, which is why
 * that is what this file reads out of the plan — and why it also asserts the two
 * lookalikes are absent rather than only that the right one is present.
 */

/**
 * Enough rows that the planner prefers the index on its own merits, with margin.
 * Stated as a constant because it is an assertion input, not a fixture detail —
 * see the row-count note above.
 */
const SEEDED_ROWS = 50_000;

/** Distinct tenants the rows are spread across, so `tenant_id` is not a no-op predicate. */
const SEEDED_TENANTS = 3;

/** How many numbers a probe carries. Matches `AGENCY_INGEST_BATCH_SIZE`'s order of magnitude. */
const PROBE_PHONES = 100;

const TARGET_INDEX = 'idx_dnc_entries_tenant_phone';
/** Indexes that would satisfy a weaker assertion. Named so the failure says which one won. */
const WRONG_INDEXES = ['uq_dnc_scope', 'idx_dnc_entries_tenant_created'];

/**
 * `findSuppressed`'s statement, copied **byte-for-byte** out of
 * `src/dnc/dnc.repository.ts` (including the double spaces after `account_id`,
 * which are in the source).
 *
 * Reproduced rather than imported because the SQL is a template literal inline in
 * a private method — there is nothing to import, and `findSuppressed` returns a
 * `Set` of matches, not a plan. A copy can drift from its original, so the drift
 * is pinned by its own case below: the repository source is read and asserted to
 * still contain this exact text. Without that pin, a future rewrite of the real
 * query would leave this file cheerfully proving the index serves a statement
 * nothing issues any more.
 */
const FIND_SUPPRESSED_SQL = `SELECT DISTINCT phone_e164 FROM dnc_entries
        WHERE tenant_id = $1
          AND phone_e164 = ANY($2::varchar[])
          AND (account_id  IS NULL OR account_id  = $3::uuid)
          AND (campaign_id IS NULL OR campaign_id = $4::uuid)`;

// ── Plan reading ────────────────────────────────────────────────────────────

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

/** Every node in the plan tree, flattened. The scan can sit under an Aggregate/Unique. */
function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

interface Explained {
  nodes: PlanNode[];
  indexNames: string[];
  /** Node types of any sequential scan over `dnc_entries` specifically. */
  seqScansOnDnc: PlanNode[];
  json: string;
}

/**
 * `EXPLAIN (FORMAT JSON)` the statement, on a caller-supplied client.
 *
 * The client is a parameter because the drop-the-index case needs the EXPLAIN to
 * run inside the *same* transaction as the `DROP INDEX` — a different pooled
 * connection would not see the dropped index and the case would pass vacuously.
 */
async function explain(
  client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  sql: string,
  params: unknown[],
): Promise<Explained> {
  const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  const plan = (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  const nodes = flatten(plan);
  return {
    nodes,
    indexNames: nodes.map((n) => n['Index Name']).filter((n): n is string => Boolean(n)),
    seqScansOnDnc: nodes.filter(
      (n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'dnc_entries',
    ),
    json: JSON.stringify(rows[0]!['QUERY PLAN'], null, 2),
  };
}

// ── Fixture ─────────────────────────────────────────────────────────────────

let tenantIds: string[] = [];
let accountId: string;

/** The phone seeded for row ordinal `g`, matching the `lpad` in {@link seedDncEntries}. */
const phoneFor = (g: number): string => `+1${String(g).padStart(10, '0')}`;

/**
 * Phones that belong to `tenantIds[0]`, so a probe built from them is genuinely
 * selective on the tenant predicate rather than matching nothing at all.
 *
 * ── THE ARITHMETIC, BECAUSE IT IS EASY TO GET BACKWARDS ─────────────────────
 *
 * {@link seedDncEntries} assigns `(ARRAY[t0, t1, t2])[1 + (g % SEEDED_TENANTS)]`
 * over a **1-based** `generate_series`. Postgres arrays are 1-based, so ordinal
 * `g` lands on `tenantIds[k]` exactly when `g % SEEDED_TENANTS === k` — and the
 * probed tenant, `tenantIds[0]`, is therefore the `g` values divisible by
 * `SEEDED_TENANTS`, **not** the ones congruent to 1.
 *
 * An earlier revision of this file walked `i` from 0 and emitted `phoneFor(i + 1)`
 * for `i % SEEDED_TENANTS === 0`, which is the `g ≡ 1` set — every probe phone
 * belonged to `tenantIds[1]` while every `EXPLAIN` bound `tenantIds[0]`, so the
 * probe matched **zero** rows. It did not change which index the planner picked
 * (the estimate is 33 rows either way, so the plan and its costs are identical),
 * which is precisely why it survived: the suite was green and the assertion it
 * makes was still true, but the fixture was not doing what its own comment said.
 *
 * That is the failure mode this whole file exists to prevent, so the invariant is
 * now checked rather than described — see the `probeMatchCount` assertions below.
 */
function probePhones(count: number): string[] {
  const out: string[] = [];
  for (let g = 1; out.length < count; g++) {
    if (g % SEEDED_TENANTS === 0) out.push(phoneFor(g));
  }
  return out;
}

/**
 * Seed `count` rows and hand the planner fresh statistics.
 *
 * `ANALYZE` is not optional: on a table that has never been analysed the planner
 * works from a hardcoded default estimate, so the plan would reflect a guess
 * about the fixture rather than the fixture. One `generate_series` INSERT rather
 * than a loop — 50k awaited round trips would dominate the suite's runtime.
 */
async function seedDncEntries(count: number): Promise<void> {
  const pool = getTestPool();
  await pool.query('TRUNCATE dnc_entries');
  await pool.query(
    `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
     SELECT (ARRAY[$1::uuid, $2::uuid, $3::uuid])[1 + (g % $4::int)],
            NULL, NULL,
            '+1' || lpad(g::text, 10, '0'),
            'import'
       FROM generate_series(1, $5::int) g`,
    [tenantIds[0], tenantIds[1], tenantIds[2], SEEDED_TENANTS, count],
  );
  await pool.query('ANALYZE dnc_entries');
}

async function rowCount(): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>('SELECT COUNT(*)::text AS n FROM dnc_entries');
  return Number(rows[0]!.n);
}

/**
 * How many of `phones` actually exist **for the tenant the EXPLAINs bind**.
 *
 * The pin on {@link probePhones}. `EXPLAIN` without `ANALYZE` reports estimates,
 * never actual rows, so a probe that matches nothing produces a plan textually
 * indistinguishable from one that matches everything it should — same node, same
 * index, same costs. Nothing in a plan-shape assertion can notice. This can.
 */
async function probeMatchCount(phones: string[]): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM dnc_entries WHERE tenant_id = $1 AND phone_e164 = ANY($2::varchar[])`,
    [tenantIds[0], phones],
  );
  return Number(rows[0]!.n);
}

describe('MAG-102 · the per-number DNC lookup is served by the plain (tenant_id, phone_e164) index', () => {
  beforeAll(async () => {
    await truncateAll();
    tenantIds = [];
    for (let i = 0; i < SEEDED_TENANTS; i++) {
      tenantIds.push((await insertTenant()).id as string);
    }
    accountId = (await insertAccount({ tenant_id: tenantIds[0] })).id as string;
  });

  afterAll(async () => {
    // The fixture is large and this file does not truncate between cases, so it
    // would otherwise hand 50k rows to whichever file runs next. Every DB test
    // here truncates in `beforeEach`, so this is hygiene rather than correctness —
    // but a suite that leaves its fixture lying around is how one file's cost
    // quietly becomes another file's.
    await getTestPool().query('TRUNCATE dnc_entries').catch(() => undefined);
    await closeTestPool();
  });

  it('guards the guard — the three indexes this file reasons about actually exist', async () => {
    // Every assertion below is a claim about which of these won. If a rename
    // landed, `TARGET_INDEX` would simply never appear and the "no wrong index"
    // assertions would pass over an empty set — green, and meaningless.
    const { rows } = await getTestPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'dnc_entries' ORDER BY indexname`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain(TARGET_INDEX);
    for (const wrong of WRONG_INDEXES) expect(names).toContain(wrong);
    // `enable_seqscan` must be ON, or every "it used an index" assertion in this
    // file is a tautology.
    const { rows: gucRows } = await getTestPool().query<{ setting: string }>(
      `SELECT setting FROM pg_settings WHERE name = 'enable_seqscan'`,
    );
    expect(gucRows[0]!.setting).toBe('on');
  });

  it('the drift pin — the repository still issues exactly the statement explained below', () => {
    // The SQL above is a copy. This is what stops the copy from silently
    // outliving its original.
    //
    // ── WHAT THIS DOES AND DOES NOT POLICE ──────────────────────────────────
    //
    // A **containment check for that one statement**, and nothing else. It is
    // not a line range, not a whole-file hash, not the surrounding method. Edits
    // anywhere else in `dnc.repository.ts` — new methods, changed comments,
    // reordered imports — cannot red it, which matters because that file is
    // actively worked on by more than one change at a time.
    //
    // Whitespace is normalized on both sides deliberately. Byte-exact matching
    // would red on a reformat of the statement that cannot change its plan, and
    // a pin that fires on edits it was not meant to police is one people learn
    // to relax. Normalizing costs nothing: any *semantic* edit — a new
    // predicate, a renamed column, a dropped scope filter — still reds, and
    // those are exactly the edits that can move the plan onto another index.
    const source = readFileSync(
      new URL('../../../src/dnc/dnc.repository.ts', import.meta.url),
      'utf8',
    );
    const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
    expect(
      normalize(source).includes(normalize(FIND_SUPPRESSED_SQL)),
      'findSuppressed\'s SQL in src/dnc/dnc.repository.ts no longer matches the statement '
      + 'this file EXPLAINs. Re-copy it into FIND_SUPPRESSED_SQL and re-check the plan — '
      + 'the index that served the old query may not serve the new one.',
    ).toBe(true);
  });

  it('a five-row table genuinely prefers a sequential scan — which is why the fixture is large', async () => {
    // The contrast that makes `SEEDED_ROWS` load-bearing. Asserted rather than
    // asserted-about: with this case present, trimming the fixture to make the
    // suite faster reds here and says why.
    await seedDncEntries(5);
    expect(await rowCount()).toBe(5);

    const plan = await explain(getTestPool(), FIND_SUPPRESSED_SQL, [
      tenantIds[0], probePhones(3), accountId, randomUUID(),
    ]);
    expect(
      plan.seqScansOnDnc.length,
      'a 5-row dnc_entries did NOT seq-scan, so this suite\'s row count may no longer be '
      + `what earns the index scan. Plan:\n${plan.json}`,
    ).toBeGreaterThan(0);
    expect(plan.indexNames).not.toContain(TARGET_INDEX);
  });

  it(`at ${SEEDED_ROWS.toLocaleString('en-US')} rows the plan uses ${TARGET_INDEX} by name, and neither lookalike`, async () => {
    await seedDncEntries(SEEDED_ROWS);
    expect(await rowCount()).toBe(SEEDED_ROWS);

    const probe = probePhones(PROBE_PHONES);

    // The probe must actually hit the tenant the EXPLAIN below binds. Asserted
    // before the plan is read, because a probe that silently matches nothing
    // yields a plan identical to a correct one — see `probeMatchCount`.
    expect(
      await probeMatchCount(probe),
      'the probe phones do not belong to the tenant the EXPLAIN binds, so this case would '
      + 'read a plan for a lookup that matches no rows. Check probePhones() against the '
      + 'tenant arithmetic in seedDncEntries().',
    ).toBe(PROBE_PHONES);

    const plan = await explain(getTestPool(), FIND_SUPPRESSED_SQL, [
      tenantIds[0], probe, accountId, randomUUID(),
    ]);

    // The assertion of record: the NAME, because the two lookalikes below would
    // each satisfy any weaker form of this.
    expect(
      plan.indexNames,
      `the per-number DNC lookup is not using ${TARGET_INDEX}. This is the agency-ingest `
      + `hot path (one query per 500-contact batch) and it degrades silently. Plan:\n${plan.json}`,
    ).toContain(TARGET_INDEX);

    // Not the scope-prefixed unique index, and not the created_at one. Both lead
    // with `tenant_id`, so both are reachable plans rather than theoretical ones.
    for (const wrong of WRONG_INDEXES) {
      expect(
        plan.indexNames,
        `the plan used ${wrong} instead of ${TARGET_INDEX} — a status- or shape-only `
        + `assertion would have passed here. Plan:\n${plan.json}`,
      ).not.toContain(wrong);
    }

    // And it is not scanning the table. Kept separate from the line above: a plan
    // could in principle touch the index and still seq-scan elsewhere.
    expect(plan.seqScansOnDnc, `unexpected Seq Scan on dnc_entries. Plan:\n${plan.json}`).toEqual([]);
  }, 60_000);

  it('the assertion is load-bearing — dropping the index changes the plan, inside a rolled-back transaction', async () => {
    // The falsifier, kept IN the suite rather than performed once by hand.
    //
    // "This assertion would fail if the index were dropped" is the property that
    // makes the case above worth having, and it is exactly the property a one-off
    // manual check cannot keep true. Run inside a transaction on a dedicated
    // client so the DROP is visible to the planner and the ROLLBACK restores the
    // index with no DDL left behind — `DROP INDEX` is transactional in Postgres.
    await seedDncEntries(SEEDED_ROWS);
    const client = await getTestPool().connect();
    try {
      // Precondition on THIS connection, so the comparison below is like-for-like.
      const before = await explain(client, FIND_SUPPRESSED_SQL, [
        tenantIds[0], probePhones(PROBE_PHONES), accountId, randomUUID(),
      ]);
      expect(before.indexNames).toContain(TARGET_INDEX);

      await client.query('BEGIN');
      await client.query(`DROP INDEX ${TARGET_INDEX}`);

      const after = await explain(client, FIND_SUPPRESSED_SQL, [
        tenantIds[0], probePhones(PROBE_PHONES), accountId, randomUUID(),
      ]);
      // The whole point: the plan is now something else. Deliberately NOT asserted
      // as "a Seq Scan" — the planner may reasonably fall back to `uq_dnc_scope`,
      // and pinning which fallback it picks would make this case brittle without
      // making it stronger. What matters is that the assertion above stops holding.
      expect(
        after.indexNames,
        'dropping the index did not change the plan, so the main assertion above could '
        + `never have failed and proves nothing. Plan:\n${after.json}`,
      ).not.toContain(TARGET_INDEX);

      await client.query('ROLLBACK');

      // Restored, and proven restored — a leaked DROP would silently degrade every
      // later test in the run.
      const restored = await explain(client, FIND_SUPPRESSED_SQL, [
        tenantIds[0], probePhones(PROBE_PHONES), accountId, randomUUID(),
      ]);
      expect(restored.indexNames).toContain(TARGET_INDEX);
      const { rows } = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'dnc_entries' AND indexname = $1`,
        [TARGET_INDEX],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);
});
