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
  validation, 0011 insights foundation, 0012 insights rollup, 0013 pacing history, 0014 the rollup's connect-rate measures and carrier errors, 0015 several running campaigns per account: drops `uq_agency_campaign_running`, adds the account-wide live-number index, 0016 the customer-history soft-phone destination index, 0017 the customer-history roster index, 0018 dedicated caller IDs per agent per campaign, 0019 Plivo numbers and the `carrier_auth` pause, 0020 the `carrier_account_unavailable` pause, 0021 the `carrier_refusing_calls` pause, 0022 automatic outcomes for unanswered calls, 0023 report runs and subscriptions plus an agent-first sessions index, 0024 inbound calls: routes, route numbers, the inbound spine, inbound legs, contact callbacks, credential and number inbound state, 0025 the validation of 0024's big-table CHECKs, 0026 the per-account live inbound calls index pacing counts, the inbound callbacks index and `callback_source` in the insights roster index, 0027 the agent side of inbound calls: the session offered or connected, the outcome, settlement, one unsettled call per session, the inbound arm of the busy probe, 0028 the Missed inbound row's `handled_reason`, the triggers that close it when the customer is reached, and the inbound summary's index, 0029 `callback_reopened` on contacts (a reached inbound call puts a contact its callback reopened back to exhausted) and the inbound spine's `carrier_seconds`, 0030 those triggers on an outbound call's person-reached outcome rather than its bridge, the number matched by its digits, and `closed_cause`, 0031 ingest `dedupe_columns`, up to three columns combined into one duplicate key, 0032 the inbound route's wrap-up window and the window captured on each inbound call, 0033 the answered inbound calls by caller, an inbound sticky signal, 0034 the Do Not Call list searched by the end of a number, 0035 one station per agent:
  one live session per agent across tenants and the device that holds the station, 0036 Mode B's
  ring: the agent app's push devices, the ring on the inbound spine, and the away break's misses
  and start on the session, 0037 the partial index of the sessions on that away break, 0038 per-table autovacuum thresholds
  and fillfactor, 0039 the retention purge's time indexes, 0040 seven duplicate indexes dropped, 0041
  promise to pay: the promise on each call table and the contact's latest one, 0042 the
  roster import's check-then-import and skipped rows, 0043 no schema change: the Insights buckets of
  calls holding a recording they did not ask for are recounted, 0044 validates 0041's CHECKs, 0045
  the Contacts list's promise index, built out of 0041's lock, 0046 the retention purge's index of
  calls holding a recording link they did not ask for, 0047 live call listening's session rows, 0048
  their `access_unverified` end reason and `live_at`, 0049 the listening history's index of an
  account's live sessions by start, 0050 the promises summary's indexes of each call table's promises
  by when their outcome was written, 0051 the campaign's `stopping_at`, when Stop was pressed, 0052 floor assist: the session's Need help
  columns and the supervisor messages table, 0053 the account's callbacks list's index of
  the pending contacts that may be callbacks, by due time, 0054 the analysis job's `vendor_refused_at`
  and `completed_at`, 0055 their partial indexes, the summary delay's two sides, 0056 the agent station's campaign
  settings (`daily_target_calls`, `agent_script`, `phone_display`), 0057 who booked a contact's
  call-later, 0058 its index and CHECK validation, 0059 the state Need help was raised in, 0060 a
  break over its limit on the event that ended it, 0061 its limit's column comment corrected: the
  limit as the catalog stood when the break ended, 0062 the start of a break a station drop
  suspended, 0063 archived campaigns: `archived_at` and who archived it, and the CHECK that only a
  draft or stopped campaign is archived, 0064 Compare agents' saved views, 0065 a session's offline
  boundaries by session, for Compare agents' trend days, 0066 the events that ended a break over its
  limit by campaign, for Compare agents' breaks over their limit, 0067 one call log per campaign: the campaign an
  inbound call is filed under (`campaign_id`, `campaign_source`, backfilled from the match) and the
  missed call a soft-phone call rang back (`callback_of_inbound_call_id`), 0068 their two indexes, 0069
  the account's call settings ("Every call must belong to a campaign") and the campaign an inbound
  route files its unknown callers under (`default_campaign_id`), with its index, 0070 an account's
  dialler attempts by when they were created, for the account's All calls and the agent's My calls).
  node-pg-migrate,

  one file per migration, one transaction, exactly one `-- up migration` and one
  `-- down migration` marker (a test asserts it).
- **Never edit or renumber an applied migration; add a new one.** A migration is a shared file:
  ship it with its contract changes, its consumers and its tests in the same commit.
- **Locks:** a migration that takes a strong lock on a table the live server writes starts its Up
  with `SET LOCAL lock_timeout = '10s';`, so a migration blocked by a straggler connection fails
  fast instead of queueing every query behind it (`db-hygiene.md`). An index on a large table is
  `CREATE INDEX IF NOT EXISTS`, so a deployment can build it `CONCURRENTLY` before the deploy.
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

Run from this directory. `pnpm test` (unit), `pnpm test:integration` (real Postgres 5436, files
in parallel). `test/helpers/global-setup.ts` drops and re-migrates the test database on every
run; before each file, `test/helpers/worker-env.ts` copies it afresh to the worker's own
database (`<db>_w<N>`, `test/helpers/worker-db.ts`), so a plan test never sees what an earlier
file left. The server's integration suite uses the same setup: never run two integration runs
on one database (per-worktree DB and worker count: root `CLAUDE.md`, `tooling/test-env.ts`).
`test/helpers/test-db.ts` holds the guards.
