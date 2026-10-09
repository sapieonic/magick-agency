import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * ─── The 42804 that made `POST /api/v1/agency-campaigns` fail outright ───────
 *
 * Shipped in 1.73.1:
 *
 *   err_code=42804
 *   column "calling_window_start" is of type time without time zone
 *   but expression is of type text
 *
 * A bare `$n` in an `INSERT ... VALUES` takes its type from the target column.
 * A `$n` inside `COALESCE(...)` does not: COALESCE resolves its result type from
 * its own arguments, so an untyped placeholder beside an untyped quoted literal
 * resolves to `text` — and Postgres then refuses to assign `text` to any column
 * it has no assignment cast to. `TIME`, `SMALLINT[]`, `UUID`, and every enum are
 * such columns; `VARCHAR`/`TEXT` are not, which is why fourteen of the twenty
 * parameters in that INSERT were fine and three were not.
 *
 * ── Why this is a SOURCE-level test ───────────────────────────────────────────
 * The behaviour only appears against real Postgres, and is asserted at the
 * integration tier (`test/integration/agency/agency-campaign-create.test.ts`).
 * But the two blind spots that let this reach production were (a) the unit tier
 * mocks the pool, so the SQL string is never executed, and (b) nothing at any
 * tier had ever called `AgencyCampaignRepository.create()` against a database.
 * (b) is now closed. This file closes (a) — and it is the only half that reds in
 * a `npm test` run with no Docker, which is the run most people do.
 *
 * Reading the SQL and the migrations from a unit test follows the precedent set
 * by `roster-row-identity.test.ts` and `s2s-contract.test.ts`.
 *
 * ── It is a RULE, not three string matches ────────────────────────────────────
 * The assertion below is derived from migration 072's declared column types
 * rather than hard-coded, so a new `TIME`/array/`UUID`/enum column added to this
 * INSERT with the same `COALESCE($n,'literal')` shape reds here immediately.
 * Three explicit assertions ride alongside it as a backstop, so a parser that
 * silently stops finding anything cannot pass this file vacuously.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// PORT NOTE (magick-agency, lane B1): ported from core
// test/unit/agency/campaign-insert-param-types.test.ts@4850d1d9 (3 cases). The
// column types are read off the squashed BASELINE (one CREATE TABLE, no later
// ALTERs) instead of migration 072 + every `ALTER TABLE agency_campaigns`; the
// INSERT now has 20 columns (`sip_connection_id` is gone). The rule is unchanged.
const BASELINE = resolve(__dirname, '../../../../../packages/db/migrations/0001_baseline.sql');
const REPOSITORY = resolve(__dirname, '../../../src/db/repositories/agency.repository.ts');

const repoSource = readFileSync(REPOSITORY, 'utf8');

/** Strip `--` line comments; the headers in this repo are enormous. */
function withoutComments(sql: string): string {
  return sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
}

/** Index of the `)` matching the `(` at `open`, quote-aware. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  let inQuote = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Split on commas at paren-depth 0, outside quotes. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.map((s) => s.replace(/\s+/g, ' ')).filter((s) => s.length > 0);
}

// ── The declared shape of `agency_campaigns`, read off the migrations ────────

/**
 * `column -> declared SQL type`, from 072's CREATE TABLE plus every later
 * `ALTER TABLE agency_campaigns ... ADD COLUMN`.
 *
 * Scanning all migrations rather than naming 078/080 means a column added by a
 * migration that does not exist yet is still typed correctly here.
 */
function agencyCampaignColumnTypes(): Record<string, string> {
  const types: Record<string, string> = {};
  const TYPE = String.raw`[A-Za-z][A-Za-z ]*?(?:\(\s*\d+\s*\))?(?:\s*\[\s*\])?`;

  const create = withoutComments(readFileSync(BASELINE, 'utf8'));
  const open = create.indexOf('(', create.indexOf('CREATE TABLE agency_campaigns'));
  const body = create.slice(open + 1, matchParen(create, open));
  for (const line of body.split('\n')) {
    const m = new RegExp(String.raw`^\s*([a-z_]+)\s+(${TYPE})\s*(?:NOT NULL|NULL|DEFAULT|PRIMARY|REFERENCES|,|$)`).exec(line);
    if (!m) continue;
    const name = m[1]!;
    if (['constraint', 'primary', 'unique', 'check', 'foreign'].includes(name)) continue;
    types[name] = m[2]!.trim().toLowerCase().replace(/\s*\[\s*\]/, '[]');
  }
  return types;
}

/**
 * Types Postgres will accept a `text` expression into by ASSIGNMENT coercion.
 *
 * Deliberately short. There is no `text -> time`, `text -> smallint[]`,
 * `text -> uuid` or `text -> <enum>` assignment cast in `pg_cast`, which is the
 * whole of this defect.
 */
const TEXT_ASSIGNABLE = /^(text|varchar(\(\d+\))?|character varying(\(\d+\))?|char(\(\d+\))?)$/;

// ── The INSERT under test, parsed out of the repository source ───────────────

function createInsertPairs(): Array<{ column: string; expr: string }> {
  const at = repoSource.indexOf('INSERT INTO agency_campaigns');
  expect(at, 'the create() INSERT was not found — this parser is stale').toBeGreaterThan(-1);

  const colsOpen = repoSource.indexOf('(', at);
  const colsClose = matchParen(repoSource, colsOpen);
  const columns = splitTopLevel(repoSource.slice(colsOpen + 1, colsClose));

  const valuesAt = repoSource.indexOf('VALUES', colsClose);
  const vOpen = repoSource.indexOf('(', valuesAt);
  const exprs = splitTopLevel(repoSource.slice(vOpen + 1, matchParen(repoSource, vOpen)));

  expect(columns.length, 'column list and VALUES list disagree').toBe(exprs.length);
  return columns.map((column, i) => ({ column, expr: exprs[i]! }));
}

describe('AgencyCampaignRepository.create — parameter typing inside COALESCE', () => {
  const types = agencyCampaignColumnTypes();
  const pairs = createInsertPairs();

  it('parses the migration and the INSERT — the counts that make the rule non-vacuous', () => {
    // If either parser quietly stops matching, every assertion below passes over
    // an empty set. These two numbers are the proof that it ran.
    // 21 since `AD-P4-C-02` added `abandonment_ceiling_pct`. This number is
    // deliberately hard-coded and deliberately annoying to change: it is the only
    // thing standing between a silently-stale parser and a whole file of
    // assertions that pass over an empty set.
    expect(pairs).toHaveLength(20);
    expect(types['calling_window_start']).toBe('time');
    expect(types['calling_window_end']).toBe('time');
    expect(types['calling_days']).toBe('smallint[]');
    expect(types['telephony_provider']).toBe('varchar(20)');
    for (const { column } of pairs) {
      expect(types[column], `no declared type found for ${column}`).toBeTruthy();
    }
  });

  it('never COALESCEs an untyped placeholder with an untyped literal into a non-text column', () => {
    const offenders: string[] = [];

    for (const { column, expr } of pairs) {
      if (!expr.startsWith('COALESCE(')) continue;        // bare $n — column supplies the type
      const close = matchParen(expr, expr.indexOf('('));
      if (expr.slice(close + 1).trim().startsWith('::')) continue;  // whole expression is cast
      const args = splitTopLevel(expr.slice(expr.indexOf('(') + 1, close));
      if (args.length !== 2) continue;
      if (args[0]!.includes('::')) continue;              // placeholder carries its own type
      if (!args[1]!.startsWith("'")) continue;            // typed literal (30/true/false) pulls it

      // Both arguments are unknown-typed ⇒ COALESCE resolves to `text`.
      const declared = types[column] ?? '';
      if (!TEXT_ASSIGNABLE.test(declared)) {
        offenders.push(`${column} (${declared}) <- ${expr}`);
      }
    }

    expect(
      offenders,
      'These COALESCEs resolve to `text` and Postgres has no assignment cast into '
      + 'the target column, so every INSERT raises 42804. Cast the placeholder, '
      + 'e.g. COALESCE($6::time, \'09:00\').',
    ).toEqual([]);
  });

  it('casts the three placeholders the production failure named (belt and braces)', () => {
    // Explicit, so a parser regression above cannot make this file pass on nothing.
    const byColumn = Object.fromEntries(pairs.map((p) => [p.column, p.expr]));
    expect(byColumn['calling_window_start']).toBe("COALESCE($6::time,'09:00')");
    expect(byColumn['calling_window_end']).toBe("COALESCE($7::time,'20:00')");
    expect(byColumn['calling_days']).toBe("COALESCE($8::smallint[],'{1,2,3,4,5}')");
  });
});
