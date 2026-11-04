# packages/db

The pg pool, the repositories and models shared by more than one module area, and every
migration. The agency repository is not here: it lives in
`apps/server/src/db/repositories/agency.repository.ts` (B12). `BASELINE.md` is the schema
inventory (tables, unique indexes that carry invariants, triggers, open questions): read it
before writing a repository or a migration.

## Migrations

- `migrations/0001_baseline.sql` plus numbered migrations after it (0002 telephony credentials,
  0003 and 0004 dialer indexes, 0005 soft phone, 0006 session `client_kind`, 0007 ingest
  `dedupe_column`, 0008 wrap-up redial, 0009 contact assignment, 0010 its index and CHECK
  validation, 0011 insights foundation, 0013 pacing history). node-pg-migrate,
  one file per migration, one transaction, exactly one `-- up migration` and one
  `-- down migration` marker (a test asserts it).
- **Never edit or renumber an applied migration; add a new one.** A migration is a shared file:
  ship it with its contract changes, its consumers and its tests in the same commit.
- A new migration gets a section in `BASELINE.md` ("Later migrations") and a test pinning it
  (pattern: `test/integration/db/softphone-migration.test.ts`). Check its down too
  (`test/integration/baseline-down-up.test.ts`).
- `pnpm migrate:up` / `migrate:down` from this directory, `DATABASE_URL` from your shell.

## SQL rules

- Raw `pg`, no ORM. Repository tests run on real Postgres; never a mocked pool.
- Transactions go through `withTransaction` (`src/utils/transaction.ts`); pass `client` to join a
  caller's transaction.
- A parameter used in two SQL contexts must be typed at each use (`$1::uuid`), or `42P08`.
- An optional field on a create input plus an explicit INSERT column list typechecks and silently
  drops the value: add the column to the list.
- A non-UUID string reaching a `uuid` cast is `22P02`: callers validate ids at the edge.
- **Claiming rows:** pick with `WITH picked AS MATERIALIZED (SELECT … ORDER BY … LIMIT n FOR
  UPDATE SKIP LOCKED)`, never `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`. The
  planner can re-run the `IN` subquery per outer row and claim more than `n`.
  `test/helpers/rerun-plan.ts` forces that plan, so a claim test sees it every time.

## Tests

Run from this directory. `pnpm test` (unit), `pnpm test:integration` (real Postgres 5436,
file-serial). `test/helpers/global-setup.ts` drops and re-migrates the test database on every
run, and the server's integration suite uses the same setup: never run two integration runs on
one database (per-worktree DB: root `CLAUDE.md`). `test/helpers/test-db.ts` holds the guards.
