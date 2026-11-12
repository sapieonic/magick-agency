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
  validation, 0011 insights foundation, 0012 insights rollup, 0013 pacing history, 0014 the rollup's connect-rate measures and carrier errors, 0015 several running campaigns per account: drops `uq_agency_campaign_running`, adds the account-wide live-number index, 0016 the customer-history soft-phone destination index, 0017 the customer-history roster index, 0018 dedicated caller IDs per agent per campaign, 0019 Plivo numbers and the `carrier_auth` pause, 0020 the `carrier_account_unavailable` pause, 0021 the `carrier_refusing_calls` pause, 0022 automatic outcomes for unanswered calls, 0023 report runs and subscriptions plus an agent-first sessions index, 0024 inbound calls: routes, route numbers, the inbound spine, inbound legs, contact callbacks, credential and number inbound state, 0025 the validation of 0024's big-table CHECKs, 0026 the per-account live inbound calls index pacing counts, the inbound callbacks index and `callback_source` in the insights roster index, 0027 the agent side of inbound calls: the session offered or connected, the outcome, settlement, one unsettled call per session, the inbound arm of the busy probe, 0028 the Missed inbound row's `handled_reason`, the triggers that close it when the customer is reached, and the inbound summary's index, 0029 `callback_reopened` on contacts (a reached inbound call puts a contact its callback reopened back to exhausted) and the inbound spine's `carrier_seconds`, 0030 those triggers on an outbound call's person-reached outcome rather than its bridge, the number matched by its digits, and `closed_cause`, 0031 ingest `dedupe_columns`, up to three columns combined into one duplicate key, 0032 the inbound route's wrap-up window and the window captured on each inbound call, 0033 the answered inbound calls by caller, an inbound sticky signal, 0034 the Do Not Call list searched by the end of a number). node-pg-migrate,
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
