-- 0037_away_ring_sessions_index.sql — the sessions on an away break whose phone rings (Mode B).
--
-- Two reads look for the live sessions on an absence (`away_ring_since IS NOT NULL AND left_at IS
-- NULL`, IQ67's key, set by 0036): the inbound connector at every search of an account
-- (`findRingableInAccount`, keyed on the tenant and the account) and the away-ring reconcile at
-- boot and every minute (`findAwayRingCandidates`, every account). Without an index both scanned
-- every session row the deployment ever had.
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_agency_agent_sessions_away_ring (tenant_id, account_id) WHERE away_ring_since IS NOT NULL
-- AND left_at IS NULL: partial, so it holds only the agents away right now (a handful per account)
-- whatever the table's size. The search's equality on (tenant_id, account_id) is its key; the
-- reconcile reads the whole (small) index.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE INDEX, as every index here is: the server is one replica and migrations run at
-- container start, before it listens. The predicate matches only rows on an away break, so the
-- build reads the table once and writes almost nothing.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE INDEX idx_agency_agent_sessions_away_ring
  ON agency_agent_sessions (tenant_id, account_id)
  WHERE away_ring_since IS NOT NULL AND left_at IS NULL;

COMMENT ON INDEX idx_agency_agent_sessions_away_ring IS
  'Live sessions on an away break whose phone rings (Mode B): the inbound search per account (findRingableInAccount) and the away-ring reconcile (findAwayRingCandidates).';

-- Down Migration

DROP INDEX IF EXISTS idx_agency_agent_sessions_away_ring;
