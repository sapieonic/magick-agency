-- 0003_agency_attempt_indexes.sql — indexes for the dialer's periodic reads.
--
-- Each change was checked with EXPLAIN on a seeded copy of the schema (200k contacts,
-- 265k attempts over 60 days, 40 live); packages/db/BASELINE.md lists the plans before and
-- after, and test/integration/db/attempt-indexes-migration.test.ts pins that the planner can
-- use each index for the query it exists for.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX / DROP INDEX, not CONCURRENTLY: node-pg-migrate runs each SQL file in
-- one transaction, and CONCURRENTLY cannot run inside one. A plain build holds a SHARE lock
-- on its table (reads proceed; INSERT/UPDATE/DELETE wait) for as long as the build takes,
-- and DROP INDEX takes ACCESS EXCLUSIVE briefly. The migrations run at container start,
-- before the server listens (docker/entrypoint.sh), so nothing on this single-replica
-- deployment is writing these tables while they build. All three new indexes are partial
-- and small: live attempts, answered attempts, and contacts parked in `connected`.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down
-- marker comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- countLive (every pacing tick, every 250 ms), stats().attempts_live and liveByState filter
-- `state <> 'ended'`. The baseline predicate listed the five live states, which the planner
-- cannot prove `<> 'ended'` implies, so countLive fell back to a BitmapAnd of two other
-- indexes. `<> 'ended'` is also the predicate of uq_agency_attempt_live, and the reaper's
-- `state = ANY(<the five live states>)` still implies it, so that caller keeps the index.
DROP INDEX idx_agency_attempts_live;
CREATE INDEX idx_agency_attempts_live
  ON agency_call_attempts (campaign_id)
  WHERE state <> 'ended';

-- The 60 s abandonment window (window24h) is a time range on answered_at across every
-- campaign. It had no index and read the whole table in a parallel sequential scan.
CREATE INDEX idx_agency_attempts_answered
  ON agency_call_attempts (answered_at)
  WHERE answered_at IS NOT NULL;

-- The reaper's lapsed-wrap-up sweep (findLapsedWrapups) drives from the few contacts
-- parked in `connected`, then joins their attempts through uq_agency_attempt_number
-- (contact_id, attempt_number). Without this it scanned every contact on every sweep.
CREATE INDEX idx_agency_contacts_connected
  ON agency_contacts (id)
  WHERE state = 'connected';

-- A strict prefix of idx_agency_attempts_keyset (campaign_id, created_at DESC, id DESC):
-- every query that used it plans onto the keyset index with the same index condition, and
-- each index on this table is paid for on every dial.
DROP INDEX idx_agency_attempts_reporting;

COMMENT ON INDEX idx_agency_attempts_live IS
  'Live attempts per campaign: countLive (every pacing tick), stats attempts_live, liveByState. Predicate is state <> ''ended'', the same as uq_agency_attempt_live, so those queries are provably covered.';
COMMENT ON INDEX idx_agency_attempts_answered IS
  'The rolling abandonment window (window24h): answered_at range across all campaigns.';
COMMENT ON INDEX idx_agency_contacts_connected IS
  'The reaper''s lapsed-wrap-up sweep: the few contacts parked in connected, joined to their attempts by uq_agency_attempt_number.';

-- Down Migration

DROP INDEX IF EXISTS idx_agency_contacts_connected;
DROP INDEX IF EXISTS idx_agency_attempts_answered;
DROP INDEX IF EXISTS idx_agency_attempts_live;
CREATE INDEX idx_agency_attempts_live
  ON agency_call_attempts (campaign_id)
  WHERE state IN ('queued','dialing','ringing','answered','bridged');
CREATE INDEX idx_agency_attempts_reporting
  ON agency_call_attempts (campaign_id, created_at DESC);
