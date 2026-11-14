# Database hygiene (phase 1)

What it takes to keep the production Postgres safe and measurable, and in what order. This is
phase 1 of a review of the schema (tables, indexes, foreign keys) and how the server uses it: no
product decisions, nothing deleted, nothing that changes the wire contract. Phase 2 depends on the
measurements this phase sets up; its list is section 7.

Part of it ships in code (section 1) and takes effect on the next deploy. The rest is settings an
operator applies to Supabase or to the server's environment (sections 2 to 6).

| Section | What | Who | When |
|---|---|---|---|
| 1 | What ships in code | the release | next deploy |
| 2 | Building an index before a deploy | operator | before the deploy |
| 3 | Backups, point-in-time recovery and a restore drill | operator | this week |
| 4 | Make the database observable | operator | this week |
| 5 | Timeouts: turn them on one at a time | operator | after section 4 has a week of data |
| 6 | Migration practice from now on | developers | every new migration |
| 7 | What to measure for phase 2 | operator + developers | after a month of data |

---

## 1. What ships in code

| Change | Where | Effect on deploy |
|---|---|---|
| Per-table autovacuum thresholds; `fillfactor` 80 on agent sessions and 85 on pacing minutes | `packages/db/migrations/0038_table_storage_settings.sql` | Catalog only, instant, no rewrite |
| Two partial indexes for the daily retention purge (the transcript step and the voicemail walk) | `0039_retention_purge_indexes.sql` | Builds 2 indexes; see section 2 for large tables. Fails if a pre-built one is invalid |
| Seven indexes that duplicated a unique index dropped | `0040_drop_duplicate_indexes.sql` | Instant (small tables) |
| `SET LOCAL lock_timeout = '10s'` in each new migration | the three files above | A migration blocked by a lock fails in 10 s instead of hanging the deploy (section 6 says what to do then) |
| Every connection carries an `application_name` (`magick-agency-server`, `-media<N>`, `-analysis<N>`, `-migrate`, `-cli`), sent at connect and set again as SQL | `packages/db/src/connection.ts`, `apps/server/src/db-session.ts` | `pg_stat_activity` shows which process holds each connection |
| TCP keepalive on pool connections, first probe after 30 s idle | `packages/db/src/connection.ts` | A connection dropped on the network path is found dead in minutes instead of hours |
| A connection that Postgres ends while a request holds it is logged and discarded | `packages/db/src/connection.ts` | Before, that ended the server process (no `'error'` listener on a checked-out client) |
| Optional session timeouts `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS` | `config/blocks/base.ts`, `connection.ts` | **Off by default.** Each new connection RESETs the ones that are off, so nothing changes until section 5 |
| The migration step resets the three timeouts on its own connection | `apps/server/src/migrate.ts` | A migration never runs under limits sized for the server's queries |
| The report cursor exempts its own transaction from the idle and statement timeouts | `report-dataset-reads.ts` | Report detail fetches keep working once section 5 is applied |
| Supervisor stats: the campaign-wide reads behind `GET /api/v1/agency-campaigns/:id/stats` are shared by every supervisor watching that campaign, for `AGENCY_CAMPAIGN_STATS_CACHE_MS` (2 s by default); the campaign's own writes and a force-available drop the shared read | `apps/server/src/agency/campaign-stats-reads.ts` | About one scan per 2 s per campaign, plus one after each such write, however many consoles poll; `agency_campaign_stats_reads_total{result}` shows scanned vs shared |

**Rolling back.** An older image runs unchanged against a database with
`0038_table_storage_settings` to `0040_drop_duplicate_indexes` applied (they change storage settings
and indexes only, and no code names a dropped index), so going back to the previous release needs
no `migrate:down`. Each migration still has a tested Down. The code changes are inert until a
variable is set, and unsetting it plus a restart undoes it.

**Reviewed and deliberately not changed.** These came up in the review and were checked against
the code; each turned out not to need a change now:

- *The `expireAwaitingRecording` claim without `MATERIALIZED`.* Postgres never inlines a CTE that
  takes row locks (`FOR UPDATE`), so it already behaves as `MATERIALIZED`;
  `packages/db/test/integration/repositories/claim-limit.test.ts` pins it under the re-running plan.
- *Switching `uuid_generate_v4()` defaults to `gen_random_uuid()`.* The Supabase `search_path` trap
  bites while 0001 runs on a fresh project; a later migration cannot remove it, and on a running
  database the stored default no longer depends on the search path.
- *Validating `ck_agency_attempt_auto_disposition`.* 0022 leaves it `NOT VALID` on purpose: every
  older row is NULL in the column, so validating would scan the largest table to prove nothing.
- *`updated_at` triggers on `account_settings` and `super_admins`.* Every writer of both tables
  already sets `updated_at` itself.
- *An index on `agency_agent_session_events.session_id`.* It would only speed up a cascade delete
  that never runs; the occupancy reads are tuned to the agent and campaign indexes. Phase 2's
  erasure procedure covers the delete.
- *A plain `(created_at)` index on `agency_calls` and `dialer_analysis_jobs` for the row purge.*
  The row purge is off (`AGENCY_RETENTION_DAYS`), and such an index invites reads that
  `ORDER BY created_at LIMIT n` with a filter (the analysis sweeps, the newest-first call lists) to
  walk it and filter most of the table whenever few rows match. It comes with the purge window,
  as BRIN (which cannot supply an ordering, so cannot cause that), in phase 2.

---

## 2. Building an index before a deploy

Migrations run while the server is stopped, and a plain `CREATE INDEX` blocks writes to its table
while it builds. On a small database this is seconds. If `agency_calls` holds more than about a
million rows, build `0039_retention_purge_indexes.sql`'s two indexes beforehand with
`CONCURRENTLY` (no write lock, the server keeps running). The migration's
`CREATE INDEX IF NOT EXISTS` then finds them (taking only a brief lock), adds their comments and
records itself.

Check the sizes first (Supabase SQL editor):

```sql
SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS size
  FROM pg_stat_user_tables
 WHERE relname IN ('agency_calls', 'agency_inbound_calls')
 ORDER BY n_live_tup DESC;
```

Then build them from `psql` over the session pooler (the SQL editor may time a long build out and
leave an invalid index). **Send each statement on its own**: several statements sent as one
query run as one transaction, and `CONCURRENTLY` refuses to run inside one.

```sql
SET statement_timeout = 0;
```

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agency_calls_transcript_pending
  ON agency_calls (created_at)
  WHERE conversation_log IS NOT NULL OR transcript_meta IS NOT NULL;
```

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agency_inbound_calls_voicemail
  ON agency_inbound_calls (arrived_at, id)
  WHERE voicemail_key IS NOT NULL;
```

Check what was built. `IF NOT EXISTS` checks the name only, so the definitions must match the
migration exactly, and a build that was cancelled or failed leaves an **invalid** index under the
name (the migration refuses to run on one):

```sql
SELECT c.relname, i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname IN ('idx_agency_calls_transcript_pending', 'idx_agency_inbound_calls_voicemail');
```

Every `indisvalid` must be `t`, and each definition must read as in
`packages/db/migrations/0039_retention_purge_indexes.sql` (Postgres adds `public.`, `USING btree`
and brackets). For a wrong or invalid one: `DROP INDEX CONCURRENTLY <name>;` and build it again.

As before every release with a migration, take a dump or a provider snapshot first
(`DEPLOYMENT.md` 3.3 and 12 "Logs, monitoring, backups").

---

## 3. Backups, point-in-time recovery and a restore drill

Today production relies on Supabase's daily backups (`DEPLOYMENT.md` 3.3). A bad migration, a
mistaken `UPDATE` or a provider incident late in the day loses every disposition, every booked
callback and every Do Not Call mark agents made since the last backup. DNC marks are a compliance
record (decision B8), so this is the first thing to fix.

1. **Turn on point-in-time recovery (PITR)** for the production project (Supabase dashboard,
   *Add-ons*). It continuously archives the write-ahead log, so the database can be restored to a
   chosen moment rather than to last night. Check the plan's stated restore granularity and
   retention period, and that the project's compute size meets the add-on's minimum.
2. **Write down the targets** and keep them beside this file once agreed. Suggested:
   - *Recovery point objective* (how much data may be lost): 5 minutes or less.
   - *Recovery time objective* (how long a restore may take, end to end): 1 hour.
3. **Run a restore drill**, then repeat it every quarter.
   - **Where to restore.** Never restore production in place for a drill. Restore to a new,
     separate project, to a timestamp from the last hour, if the plan offers that (check what
     Supabase offers for the plan: restoring to a new project is not available everywhere). If it
     does not, restore the latest pre-release `pg_dump` into a fresh project with `pg_restore`
     instead; that drills the dump, not PITR, so note it.
   - **Isolate the restored copy before any server touches it.** It holds production's running
     campaigns, report subscriptions, push devices and tenants' carrier credentials, and a server
     started on it would act on them. In the restored database first:

     ```sql
     UPDATE agency_campaigns SET status = 'paused', pause_reason = 'supervisor', updated_at = now()
      WHERE status = 'running';
     ```

     Then start a staging server with its own Redis, its own S3 bucket and credentials, and none
     of production's outward settings: `PLIVO_WEBHOOK_BASE_URL` unset (Plivo dials are then
     refused before anything is sent), dummy VoiceLink credentials, no `PUSH_*` keys, no mail or
     analytics keys, `AGENCY_RETENTION_DAYS` unset, analysis off
     (`POST_CALL_ANALYSIS_ENABLED=false`, `DIALER_ANALYSIS_ENABLED` unset), reports on `inline`.
   - Give it the same `DB_SSL_CA` and the **credential keyring**. The keyring
     (`TELEPHONY_CREDENTIAL_KEYS`) is deliberately backed up apart from the database
     (`DEPLOYMENT.md` 8.6): a restore without it cannot unseal carrier credentials, so the drill
     must include fetching it from where it is kept.
   - Check: the server boots, `GET /readyz` is ready, the latest dispositions and DNC entries
     before the chosen timestamp are present, and a tenant's carrier credential unseals (super
     admin *Verify* on it, `POST /super-admin/telephony-credentials/:id/verify`, which asks the
     carrier about the account and places no call).
   - Record how long each step took. That is the measured recovery time.
   - Delete the drill project, Redis and bucket afterwards.
4. **As tables grow**, replace the pre-release `pg_dump` with a provider snapshot: a dump of tens
   of gigabytes is too slow to be a pre-deploy step.

---

## 4. Make the database observable

Phase 2's decisions need numbers that nothing collects today: which statements take the time,
which indexes are used, how many updates are HOT, how many dead rows each table carries.

### 4.1 Settings

Apply in the Supabase SQL editor (or the dashboard's database settings where it offers them).
Some managed plans restrict which logging parameters can be changed; if a statement is refused,
use the dashboard or ask the provider.

```sql
-- Statement statistics: Supabase ships the extension (in its `extensions` schema); this is a
-- no-op if it is already on.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;

-- Log every statement that takes longer than 1 s, and every lock wait longer than
-- deadlock_timeout (1 s by default). Database-level, so they apply to every role.
ALTER DATABASE postgres SET log_min_duration_statement = '1s';
ALTER DATABASE postgres SET log_lock_waits = on;

-- Keep bind parameters (customers' numbers and names) out of those log lines.
ALTER DATABASE postgres SET log_parameter_max_length = 0;
```

These apply to new Postgres connections only, and the session pooler keeps its connections to
Postgres open, so restarting the server is not enough: restart the project (*Settings → General →
Restart project*, as `DEPLOYMENT.md` 3.3 does for a role setting), outside calling hours, then
confirm each with `SHOW <name>;` from a new connection.

After the release is deployed, confirm the connection names arrive: the "who is connected" query
in 4.2 must show `magick-agency-server` (and `-media<N>` with media workers).

### 4.2 Queries to keep

Saved as snippets in the Supabase SQL editor. Each is read-only. The two `pg_stat_statements`
queries keep to this database and leave out Supabase's own roles.

**Where the time goes** (top 20 statements by total time since the last stats reset):

```sql
SELECT round(s.total_exec_time) AS total_ms, s.calls, round(s.mean_exec_time::numeric, 1) AS mean_ms,
       round(s.max_exec_time) AS max_ms, s.rows, left(s.query, 160) AS query
  FROM pg_stat_statements s
  JOIN pg_roles r ON r.oid = s.userid
 WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
   AND r.rolname NOT LIKE 'supabase%'
 ORDER BY s.total_exec_time DESC
 LIMIT 20;
```

**The longest single statements** (what section 5's statement timeout must stay above):

```sql
SELECT round(s.max_exec_time) AS max_ms, s.calls, round(s.mean_exec_time::numeric, 1) AS mean_ms,
       left(s.query, 160) AS query
  FROM pg_stat_statements s
  JOIN pg_roles r ON r.oid = s.userid
 WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
   AND r.rolname NOT LIKE 'supabase%'
 ORDER BY s.max_exec_time DESC
 LIMIT 20;
```

**Since when** (record it with every reading):

```sql
SELECT stats_reset FROM pg_stat_statements_info;
```

**Table health** (size, dead rows, last vacuum, HOT update ratio):

```sql
SELECT relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_update_pct,
       last_autovacuum, last_autoanalyze
  FROM pg_stat_user_tables
 ORDER BY pg_total_relation_size(relid) DESC
 LIMIT 20;
```

**Index usage** (an index with `idx_scan = 0` over a whole business cycle, month-end reports
included, is a candidate to drop in phase 2; never drop one on this evidence alone without checking
the code that might need it):

```sql
SELECT s.relname AS table_name, s.indexrelname AS index_name, s.idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
 WHERE NOT i.indisunique
   AND s.relname IN ('agency_call_attempts', 'agency_contacts', 'agency_calls', 'agency_inbound_calls', 'agency_manual_calls')
 ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC;
```

**Who is connected, and the oldest open transaction:**

```sql
SELECT application_name, state, count(*) AS connections,
       max(now() - xact_start) FILTER (WHERE xact_start IS NOT NULL) AS oldest_transaction
  FROM pg_stat_activity
 WHERE datname = current_database()
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

Note the date of each reading: `pg_stat_statements` and the table counters accumulate since the
last reset or restart, so compare like with like.

### 4.3 Dashboards and alerts

The Grafana stack (`grafana/`) alerts on the server's own metrics (pool waits, rollup backlog) but
has no source for Postgres's statistics views. To graph them, add a Postgres data source to the
Grafana stack that reads from a monitoring role with `pg_monitor` (or Grafana Cloud's Postgres
integration), then add panels for the queries in 4.2 and these alerts. The project's Network
Restrictions allow only the VM (`DEPLOYMENT.md` 3.3), so the data source needs either Grafana's
egress addresses allowed there or an agent on the VM that queries Postgres and pushes the numbers.

| Alert | Condition | Why |
|---|---|---|
| Long open transaction | any transaction open longer than 11 minutes (`max(now() - xact_start)`) | Holds locks and stops vacuum. A report's own transaction is open for up to its 10-minute deadline (`REPORT_BUILD_TIMEOUT_MS`), so the threshold sits above that |
| Dead rows on attempts | `agency_call_attempts` dead rows above 10% | Autovacuum is not keeping up despite `0038_table_storage_settings` |
| Database size | above 70% of the plan's disk | Time to agree retention (phase 2) |
| Connections | total above 85% of `max_connections` | The planned budget (`docs/operations.md`, "Postgres connections") was exceeded |

Until that exists, run the 4.2 queries weekly and keep the results.

---

## 5. Timeouts: turn them on one at a time

Three environment variables on the server, applied by every server process (the primary, media
and analysis workers). Each is in milliseconds: `0` or unset is off, a non-zero value below 1000 is
refused at boot, and the most is 3,600,000 (one hour).

**Off means "as the database and role define it".** Each new pool connection RESETs the settings
that are off, so they take the role's and database's values. Check there are none before you
start (an empty result is what you want):

```sql
SELECT r.rolname, d.datname, s.setconfig
  FROM pg_db_role_setting s
  LEFT JOIN pg_roles r ON r.oid = s.setrole
  LEFT JOIN pg_database d ON d.oid = s.setdatabase
 WHERE array_to_string(s.setconfig, ',') ~ '(statement|lock|idle_in_transaction_session)_timeout';
```

**Never set these at the database or role level** (`ALTER ROLE … SET statement_timeout`): the
migrations and the super-admin CLI connect as the same role, and a migration's DDL must not be cut
off by a limit sized for the server's queries.

**Through the session pooler.** The values are set with plain SQL on each new connection, so they
hold whether or not the pooler forwards connection options. Whether Supabase's pooler clears a
session's settings when it hands a Postgres connection to its next client is not documented. The
code assumes it may not: the server's pools RESET what is off, and the migration step and the CLI
RESET all three on their own connections, so a value left behind is never inherited.

Turn them on in this order, one per deploy or restart, and watch the logs and the 4.2 queries for
a few days before the next. To undo any of them: unset the variable and restart the server.

**What any hit looks like.** The request that hit it fails with an error. For the idle limit,
Postgres ends the connection: the server logs `Database connection ended under its client` with
`terminating connection due to idle-in-transaction timeout`, discards that connection and opens a
new one; the process keeps running.

### Step 1: `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`

**What it stops.** A connection that opened a transaction and then waits on something else (a bug,
a hung network call) holds its row locks and stops vacuum for as long as it waits. With this set,
Postgres ends the connection after the limit and releases its locks.

**What sits idle inside a transaction on purpose.**

- The report cursor waits on the S3 upload between fetches. It exempts its own transaction (the
  report's 10-minute deadline bounds it instead), so it is unaffected by any value.
- The inbound operator actions in `apps/server/src/telephony/credentials/inbound-service.ts`
  (enable, disable, repoint, link and unlink) hold a row lock on the credential or the number
  while they call Plivo, by design, with no statement on the transaction in between. The idle gap
  is the sum of the Plivo calls in one action, each bounded by `PLIVO_REQUEST_TIMEOUT_MS` (15 s by
  default). The longest is a repoint whose Application is gone at Plivo: one update, up to 5 pages
  of listing, a create, then one call per linked number, so up to
  **(7 + N) × `PLIVO_REQUEST_TIMEOUT_MS`**, where N is the most inbound numbers linked to one
  credential:

  ```sql
  SELECT telephony_credential_id, count(*) AS linked
    FROM phone_numbers
   WHERE inbound_linked_at IS NOT NULL AND status = 'active'
   GROUP BY 1 ORDER BY 2 DESC LIMIT 1;
  ```

**The value.** At least that worst case, rounded up. With the 15 s default and up to 13 linked
numbers on one credential, `300000` (5 minutes). It is a backstop against a transaction left open
for ever, so erring high costs little. If `PLIVO_REQUEST_TIMEOUT_MS` is raised (its maximum is
120 s) or more numbers are linked, recompute it first.

### Step 2: `DB_LOCK_TIMEOUT_MS`

**Before setting it**, read a week of the lock-wait log from section 4.1 (`log_lock_waits`). Each
wait longer than `deadlock_timeout` (1 s) is logged with the waiting statement and the holder's
process ID (`Process holding the lock: N`), not the holder's statement; when the wait ends a second
line says `acquired … after N ms`. Read the longest waits from those lines, and the holder from
`pg_stat_activity` while it is happening. Set the limit well above the longest legitimate wait.

**What it stops.** A statement that waits for a lock longer than the limit fails with `55P03`
instead of waiting for ever. The others queued for the same lock still wait for whoever holds it,
each until its own limit.

**The trade on outbound calls.** Creating a call leg reads its carrier credential `FOR SHARE`
(`packages/db/src/repositories/agency-call.repository.ts`), which waits while an inbound enable or
repoint holds that credential `FOR UPDATE` across its Plivo calls, which can last as long as the
step 1 worst case when Plivo is slow. A limit below that fails those legs with `55P03` instead of
leaving them waiting; above it, they wait as they do today. `60000` (1 minute) is a reasonable
start if the log shows nothing longer: a dial that has waited a minute for a lock is already lost.
The contact reassignment sets its own 10 s limit for its transaction (`assignment.repository.ts`),
which takes precedence there.

### Step 3: `DB_STATEMENT_TIMEOUT_MS`, only after measuring

**Do not set this until `pg_stat_statements` has a month of data**, month-end reports included.
Many long reads run on the shared pool with no way to exempt themselves, and every one of them
must fit under the limit:

- the report builders' reads (`apps/server/src/agency/reports/`; only the cursor's detail fetches
  are exempt);
- the agent roster and grouped statistics (92-day windows) and per-agent statistics (366 days);
- campaign stats, the insights range reads, customer history;
- the retention and audit purges.

**Choosing the value.** Take the largest `max_exec_time` from the "longest single statements"
query in 4.2 among statements that did useful work, and set the limit to at least twice that.
Suggested starting point if nothing comes close: `300000` (5 minutes), as a backstop that stops a
runaway statement rather than a tuning tool.

**What a hit looks like.** The statement fails with `57014` (`canceling statement due to statement
timeout`); the request returns an error, a report run fails `assembly_failed`.

---

## 6. Migration practice from now on

Written into `packages/db/CLAUDE.md`; repeated here for operators reviewing a release.

- **Locks.** A migration that takes a strong lock on a table the live server writes starts its Up
  with `SET LOCAL lock_timeout = '10s';`. If something still holds a lock on the table (a worker
  that has not exited, an operator's open session, an anti-wraparound autovacuum), the migration
  fails in 10 s instead of waiting with no limit while every other query queues behind it.
- **When a migration fails on that timeout**, the server does not start, so the outage continues
  until it is retried. Find the holder:

  ```sql
  SELECT pid, application_name, state, xact_start, left(query, 120) AS query
    FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid()
   ORDER BY xact_start;
  ```

  End a stray session with `SELECT pg_terminate_backend(<pid>);` (never the pooler's own or an
  autovacuum: wait for that one), then start the server again
  (`docker compose -f docker/docker-compose.prod.yml up -d`). After a deploy, confirm what was
  applied: `SELECT name, run_on FROM pgmigrations ORDER BY id DESC LIMIT 3;`.
- **Indexes on large tables** are `CREATE INDEX IF NOT EXISTS`, so they can be built
  `CONCURRENTLY` before the deploy as in section 2. The pull request that adds one says so, and so
  does `DEPLOYMENT.md` 12 "Deploying a new version" for that release.
- **Backfills of large tables** belong in a batched script (update 10,000 rows, commit, repeat)
  run before or after the deploy, not inside the migration's transaction, which holds its locks
  for the whole backfill.
- **Never edit an applied migration**; add a new one.

---

## 7. What to measure for phase 2

After about a month of section 4's data, collect these for the phase 2 decisions:

| Question | Read it from | Decides |
|---|---|---|
| Is the supervisor stats read still among the top statements? | 4.2 "where the time goes" | Whether to rebuild campaign stats from the rollup buckets |
| Which non-unique indexes on attempts and contacts have `idx_scan = 0`? | 4.2 "index usage" | Which indexes to drop, one at a time |
| What is the HOT update ratio on attempts and contacts? | 4.2 "table health" | Whether `fillfactor` on those two is worth it |
| How fast is each big table growing, and how close is the disk limit? | 4.2 "table health", weekly | How urgent retention is |
| What is the longest legitimate statement? | 4.2 "longest single statements" | Section 5 step 3's value |
| What are the longest lock waits? | the lock-wait log (4.1) | Section 5 step 2's value |

Phase 2's work, for which these are the evidence:

- **Retention windows**: how long each kind of data is kept (call attempts, call records and
  transcripts, agent session events, pacing history). That is a decision, not a measurement; the
  UK GDPR retention question is already open in `docs/decisions.md`. The row purge's time index
  (BRIN on `created_at`, section 1) comes with it.
- **Campaign stats from the rollups**, if the stats read stays near the top.
- **Index clean-up** on the hot tables, from the index usage.
- **`fillfactor`** on attempts and contacts, from the HOT ratio.
- **Tenant-scoped foreign keys**, so a row cannot point at another tenant's row.
- **An erasure procedure** for one customer's data across tables.
- **The inbound actions' lock**: hold the credential or number lock only around the database
  writes, not across the Plivo calls, so neither timeout has to allow for Plivo.
- **`DB_STATEMENT_TIMEOUT_MS`**'s value.

---

## Checklist

- [ ] Section 2: index sizes checked; large ones built `CONCURRENTLY`, valid and matching; dump or snapshot taken
- [ ] Release deployed (`0038_table_storage_settings` to `0040_drop_duplicate_indexes` applied; `pgmigrations` checked)
- [ ] Connection names visible in `pg_stat_activity`
- [ ] Section 3: PITR on; recovery targets written down; first restore drill done, isolated and timed
- [ ] Section 4.1: `pg_stat_statements` on, slow-query and lock-wait logging on without parameters, project restarted
- [ ] Section 4.2: snippets saved; first weekly reading recorded with its `stats_reset`
- [ ] Section 4.3: Postgres data source and alerts in Grafana (or the weekly reading as a stopgap)
- [ ] Section 5: no role or database timeouts set (`pg_db_role_setting`)
- [ ] Section 5 step 1: `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` from the worst case, a few days watched
- [ ] Section 5 step 2: lock-wait log read; `DB_LOCK_TIMEOUT_MS` set above the longest legitimate wait
- [ ] Section 5 step 3: after a month of data, `DB_STATEMENT_TIMEOUT_MS` set from the measured maximum
- [ ] Section 7: readings collected; retention windows agreed
