# Database hygiene (phase 1)

What it takes to keep the production Postgres safe and measurable, and in what order. This is
phase 1 of the database review: no product decisions, nothing deleted, nothing that changes the
wire contract. Phase 2 (retention windows, campaign stats from the rollups, index clean-up on the
hot tables, tenant-scoped foreign keys) depends on the measurements this phase sets up.

Part of it ships in code (section 1) and takes effect on the next deploy. The rest is settings an
operator applies to Supabase or to the server's environment (sections 2 to 6).

| Section | What | Who | When |
|---|---|---|---|
| 1 | What ships in code | the release | next deploy |
| 2 | Before deploying this release: build the new indexes without a lock | operator | before the deploy |
| 3 | Backups, point-in-time recovery and a restore drill | operator | this week |
| 4 | Make the database observable | operator | this week |
| 5 | Turn on the session timeouts, one at a time | operator | after section 4 has a week of data |
| 6 | Migration practice from now on | developers | every new migration |
| 7 | What to measure for phase 2 | operator + developers | after a month of data |

---

## 1. What ships in code

| Change | Where | Effect on deploy |
|---|---|---|
| Per-table autovacuum thresholds; `fillfactor` 80 on agent sessions and 85 on pacing minutes | `packages/db/migrations/0038_table_storage_settings.sql` | Catalog only, instant, no rewrite |
| Time indexes for the daily retention purge (4 indexes) | `0039_retention_purge_indexes.sql` | Builds 4 indexes; see section 2 for large tables |
| Seven indexes that duplicated a unique index dropped | `0040_drop_duplicate_indexes.sql` | Instant (small tables) |
| `SET LOCAL lock_timeout = '10s'` in each new migration | the three files above | A migration blocked by a lock fails in 10 s instead of hanging the deploy |
| Every connection carries an `application_name` (`magick-agency-server`, `-media<N>`, `-analysis<N>`, `-migrate`, `-cli`) | `packages/db/src/connection.ts`, `apps/server/src/db-session.ts` | `pg_stat_activity` and `pg_stat_statements` show which process ran what |
| TCP keepalive on pool connections | `packages/db/src/connection.ts` | A connection dropped on the network path errors instead of hanging |
| Optional session timeouts `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS` | `config/blocks/base.ts`, `connection.ts` | **Off by default.** Nothing changes until section 5 |
| The report cursor exempts its own transaction from the idle and statement timeouts | `report-dataset-reads.ts` | Reports keep working once section 5 is applied |

Rolling back any of it: the migrations each have a tested Down; the code changes are inert or
reversible by environment (unset a variable and restart).

**Reviewed and deliberately not changed.** These came up in the review and were checked against
the code; each turned out not to need a change:

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

---

## 2. Before deploying this release: build the new indexes without a lock

Migrations run while the server is stopped, and a plain `CREATE INDEX` blocks writes to its table
while it builds. On a small database this is seconds. If `agency_calls` holds more than about a
million rows, build 0039's indexes beforehand with `CONCURRENTLY` (no write lock, the server keeps
running); the migration's `CREATE INDEX IF NOT EXISTS` then finds them and only records itself.

Check the sizes first (Supabase SQL editor):

```sql
SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS size
  FROM pg_stat_user_tables
 WHERE relname IN ('agency_calls', 'dialer_analysis_jobs', 'agency_inbound_calls')
 ORDER BY n_live_tup DESC;
```

Then, one statement at a time (`CONCURRENTLY` cannot run inside a transaction block, so do not
wrap them):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agency_calls_transcript_pending
  ON agency_calls (created_at)
  WHERE conversation_log IS NOT NULL OR transcript_meta IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agency_calls_created
  ON agency_calls (created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dialer_analysis_jobs_created
  ON dialer_analysis_jobs (created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agency_inbound_calls_voicemail
  ON agency_inbound_calls (arrived_at, id)
  WHERE voicemail_key IS NOT NULL;
```

The definitions must match the migration exactly (copy them from
`packages/db/migrations/0039_retention_purge_indexes.sql`): `IF NOT EXISTS` checks the name only.

A concurrent build that is cancelled or fails leaves an **invalid** index behind under the same
name, which `IF NOT EXISTS` would then accept. Check before deploying:

```sql
SELECT c.relname, i.indisvalid
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname IN ('idx_agency_calls_transcript_pending', 'idx_agency_calls_created',
                     'idx_dialer_analysis_jobs_created', 'idx_agency_inbound_calls_voicemail');
```

Every row must say `t`. For any `f`: `DROP INDEX CONCURRENTLY <name>;` and build it again.

As before every release with a migration, take a dump or a provider snapshot first
(`DEPLOYMENT.md` 3.3 "Backups" and 12 "Deploying a new version").

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
3. **Run a restore drill**, then repeat it every quarter:
   - Restore to a **new, separate project** (never restore production in place for a drill),
     to a timestamp from the last hour.
   - Point a staging server at it with the same `DB_SSL_CA` and the **credential keyring**. The
     keyring (`TELEPHONY_CREDENTIAL_KEYS`) is deliberately backed up apart from the database
     (`DEPLOYMENT.md` 8.6): a restore without it cannot unseal carrier credentials, so the drill
     must include fetching it from where it is kept.
   - Check: the server boots, `GET /readyz` is ready, the latest dispositions and DNC entries
     before the chosen timestamp are present, and a tenant's carrier credential can be used (for
     example, a test call on a staging campaign that uses it).
   - Record how long each step took. That is the measured recovery time.
   - Delete the drill project afterwards.
4. **As tables grow**, replace the pre-release `pg_dump` with a provider snapshot: a dump of tens
   of gigabytes is too slow to be a pre-deploy step.

---

## 4. Make the database observable

Phase 2's decisions need numbers that nothing collects today: which statements take the time,
which indexes are used, how many updates are HOT, how many dead rows each table carries.

### 4.1 Settings

Apply in the Supabase SQL editor (or the dashboard's database settings where it offers them), then
confirm each with `SHOW <name>;` from a new connection. Some managed plans restrict which logging
parameters can be changed; if a statement is refused, use the dashboard or ask the provider.

```sql
-- Statement statistics: Supabase ships the extension; this is a no-op if it is already on.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Log every statement that takes longer than 1 s, and every lock wait longer than
-- deadlock_timeout (1 s by default). Database-level, so they apply to every role.
ALTER DATABASE postgres SET log_min_duration_statement = '1s';
ALTER DATABASE postgres SET log_lock_waits = on;
```

These apply to new connections only. The server's pool recycles idle connections after 30 s, but
a busy pool keeps its connections, so restart the server once after setting them.

### 4.2 Queries to keep

Saved as snippets in the Supabase SQL editor. Each is read-only.

**Where the time goes** (top 20 statements by total time since the last stats reset):

```sql
SELECT round(total_exec_time) AS total_ms, calls, round(mean_exec_time, 1) AS mean_ms,
       round(max_exec_time) AS max_ms, rows, left(query, 160) AS query
  FROM pg_stat_statements
 ORDER BY total_exec_time DESC
 LIMIT 20;
```

**The longest single statements** (what section 5's statement timeout must stay above):

```sql
SELECT round(max_exec_time) AS max_ms, calls, round(mean_exec_time, 1) AS mean_ms, left(query, 160) AS query
  FROM pg_stat_statements
 ORDER BY max_exec_time DESC
 LIMIT 20;
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
integration), then add panels for the queries in 4.2 and these alerts:

| Alert | Condition | Why |
|---|---|---|
| Long open transaction | any transaction open longer than 5 minutes (`max(now() - xact_start)`) | Holds locks and stops vacuum; section 5's idle timeout ends the idle ones |
| Dead rows on attempts | `agency_call_attempts` dead rows above 10% | Autovacuum is not keeping up despite 0038 |
| Database size | above 70% of the plan's disk | Time to agree retention (phase 2) |
| Connections | total above 85% of `max_connections` | The planned budget (`docs/operations.md`, "Postgres connections") was exceeded |

Until that exists, run the 4.2 queries weekly and keep the results.

---

## 5. Turn on the session timeouts, one at a time

Three environment variables on the server (all processes; migrations and the super-admin CLI are
not affected). Each is in milliseconds, `0` or unset is off, and a non-zero value below 1000 is
refused at boot. They are set on each pool connection with plain SQL, so they hold through
Supabase's session pooler.

**Never set these at the database or role level** (`ALTER ROLE … SET statement_timeout`): the
migrations and the super-admin CLI connect as the same role, and a migration's DDL must not be cut
off by a limit sized for the server's queries.

Turn them on in this order, one per deploy or restart, and watch the logs and the 4.2 queries for
a few days before the next. To undo any of them: unset the variable and restart the server.

### Step 1: `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=120000` (2 minutes)

**What it stops.** A connection that opened a transaction and then waits on something else (a bug,
a hung network call) holds its row locks and stops vacuum for as long as it waits. With this set,
Postgres ends the connection after the limit and releases its locks.

**Why 2 minutes and not less.** Two places legitimately sit idle inside a transaction:

- The report cursor waits on the S3 upload between fetches. It exempts its own transaction (the
  report's 10-minute deadline bounds it instead), so it is unaffected by any value.
- The inbound operator actions in `apps/server/src/telephony/credentials/inbound-service.ts`
  (enable, disable, repoint, link and unlink an inbound number) hold a row lock on the credential
  or the number while they call Plivo, by design. Each Plivo call is bounded by
  `PLIVO_REQUEST_TIMEOUT_MS` (15 s by default). **The idle limit must stay comfortably above
  `PLIVO_REQUEST_TIMEOUT_MS`.** If that is ever raised (its maximum is 120 s), raise this to at
  least 180000 first.

**What a hit looks like.** The server logs an error from the statement after the idle gap
(`terminating connection due to idle-in-transaction timeout`), the request fails, the connection
is replaced. Search the logs for it after enabling.

### Step 2: `DB_LOCK_TIMEOUT_MS=60000` (1 minute)

**Before setting it**, read a week of the lock-wait log from section 4.1 (`log_lock_waits`): every
wait longer than 1 s is logged with the statement that waited and the one holding the lock. Set the
limit well above the longest legitimate wait you see.

**What it stops.** A statement that waits for a lock longer than the limit fails with `55P03`
instead of waiting for ever, and everything queued behind it stops waiting too.

**Why 1 minute and not less.** Creating a call leg reads its carrier credential `FOR SHARE`
(`packages/db/src/repositories/agency-call.repository.ts`), which waits while an inbound enable or
repoint holds that credential `FOR UPDATE` across its Plivo calls. A repoint can make several Plivo
calls in a row (listing applications, then updating each linked number), each up to
`PLIVO_REQUEST_TIMEOUT_MS`. A low limit here would fail outbound call legs while an operator
repoints an inbound number. The contact reassignment already sets its own 10 s limit for its
transaction (`assignment.repository.ts`), which takes precedence there.

### Step 3: `DB_STATEMENT_TIMEOUT_MS`, only after measuring

**Do not set this until `pg_stat_statements` has a month of data**, month-end reports included.
Many long reads run on the shared pool with no way to exempt themselves: the report builders'
reads, the agent roster and grouped statistics (92-day windows), per-agent statistics (366 days),
campaign stats, the insights range reads, customer history, and the retention and audit purges.

**Choosing the value.** Take the largest `max_exec_time` from the "longest single statements"
query in 4.2 among statements that did useful work, and set the limit to at least twice that.
Suggested starting point if nothing comes close: `300000` (5 minutes), as a backstop that stops a
runaway statement rather than a tuning tool. The report cursor exempts its own fetches; the rest
of a report's reads are under the limit.

**What a hit looks like.** The statement fails with `57014` (`canceling statement due to statement
timeout`); the request returns an error, a report run fails `assembly_failed`.

---

## 6. Migration practice from now on

Written into `packages/db/CLAUDE.md`; repeated here for operators reviewing a release.

- **Locks.** A migration that takes a strong lock on a table the live server writes starts its Up
  with `SET LOCAL lock_timeout = '10s';`. If something still holds a lock on the table (a worker
  that has not exited, an operator's open session), the migration fails in 10 s and the deploy can
  be retried, instead of waiting with no limit while every other query queues behind it.
- **Indexes on large tables** are `CREATE INDEX IF NOT EXISTS`, so they can be built
  `CONCURRENTLY` before the deploy as in section 2. The release notes of such a migration say so.
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

Phase 2 also needs one decision that is not a measurement: **how long each kind of data is kept**
(call attempts, call records and transcripts, agent session events, pacing history). The UK GDPR
retention question is already open in `docs/decisions.md`; the retention purge and its new indexes
are ready for whichever windows are agreed.

---

## Checklist

- [ ] Section 2: index sizes checked; large ones built `CONCURRENTLY` and valid; dump or snapshot taken
- [ ] Release deployed (`0038_table_storage_settings` to `0040_drop_duplicate_indexes` applied)
- [ ] Section 3: PITR on; recovery targets written down; first restore drill done and timed
- [ ] Section 4.1: `pg_stat_statements` on, slow-query and lock-wait logging on, server restarted
- [ ] Section 4.2: snippets saved; first weekly reading recorded
- [ ] Section 4.3: Postgres data source and alerts in Grafana (or the weekly reading as a stopgap)
- [ ] Section 5 step 1: `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=120000`, a few days watched
- [ ] Section 5 step 2: lock-wait log read; `DB_LOCK_TIMEOUT_MS` set above the longest legitimate wait
- [ ] Section 5 step 3: after a month of data, `DB_STATEMENT_TIMEOUT_MS` set from the measured maximum
- [ ] Section 7: readings collected; retention windows agreed
