-- 0027_inbound_live_indexes.sql — the indexes inbound calls' reads need (docs/inbound.md §5.3,
-- §7; decisions IB4, IB5).
--
--  1. CREATE idx_agency_inbound_calls_account_live: IB5 counts a live inbound call in its
--     account's live-call total, so pacing's headroom read (`countLiveForAccount`, every pacing
--     round, per account) gains a third arm:
--       SELECT COUNT(*) FROM agency_inbound_calls i
--        WHERE i.tenant_id = $1 AND i.account_id = $2 AND i.state <> 'ended'
--     0024's idx_agency_inbound_calls_open is keyed on arrived_at alone, so that arm would walk
--     every live inbound call of every tenant each round. Partial on the same literal predicate
--     as the attempt and soft-phone halves (`state <> 'ended'`), so it stays the size of the
--     floor and the planner proves it applies.
--
--     The answer webhook's per-route admission count (once per arriving call, not per round) is
--     left to idx_agency_inbound_calls_open: bounded by the live inbound calls, and the planner
--     prefers it over a (route_id) partial index on a route with any history anyway.
--
--  2. REBUILD idx_agency_contacts_insights (0011) with `callback_source` among its INCLUDE
--     columns. The inbound follow-up widens `isCallbackSql` to `callback_source IS NOT NULL OR
--     <the disposition rule>`, and the insights as-of-now reads (the roster buckets, the
--     allocation) bucket every contact through it: without the column they leave the index-only
--     scan 0011 built the index for and visit the heap for every contact of the campaign.
--     Same name, same key, the same INCLUDE list plus `callback_source`, the same comment.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX, as in 0003, 0004, 0015, 0016 and 0017: node-pg-migrate runs each SQL file
-- in one transaction, where CONCURRENTLY is not allowed. Each build holds a SHARE lock on its table
-- (writes wait, reads go on) while it scans it once: agency_inbound_calls is 0024's and small;
-- agency_contacts is the roster, scanned once as 0017 did. The insights index is rebuilt under a
-- temporary name FIRST, so the old one serves until the swap, and only then dropped and the new
-- one renamed: the ACCESS EXCLUSIVE those two take is held from the swap to the commit, which
-- follows at once. Migrations run at container start, before the server listens.
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops the live index (the count falls back to idx_agency_inbound_calls_open) and rebuilds
-- idx_agency_contacts_insights exactly as 0011 made it, by the same swap.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE INDEX idx_agency_inbound_calls_account_live
  ON agency_inbound_calls (tenant_id, account_id)
  WHERE state <> 'ended';

COMMENT ON INDEX idx_agency_inbound_calls_account_live IS
  'IB5: an account''s live inbound calls, counted in its live-call total by every pacing round (countLiveForAccount).';

CREATE INDEX idx_agency_contacts_insights_0027
  ON agency_contacts (campaign_id, state)
  INCLUDE (next_attempt_at, suppressed_reason, attempt_count, dials_placed,
           last_outcome, last_disposition, assigned_user_id, callback_source);
DROP INDEX idx_agency_contacts_insights;
ALTER INDEX idx_agency_contacts_insights_0027 RENAME TO idx_agency_contacts_insights;

COMMENT ON INDEX idx_agency_contacts_insights IS
  'Insights as-of-now reads: roster bucket counts, allocation and the headline for one campaign, index-only (every column they read is a key or INCLUDE column).';

-- Down Migration

CREATE INDEX idx_agency_contacts_insights_0011
  ON agency_contacts (campaign_id, state)
  INCLUDE (next_attempt_at, suppressed_reason, attempt_count, dials_placed,
           last_outcome, last_disposition, assigned_user_id);
DROP INDEX idx_agency_contacts_insights;
ALTER INDEX idx_agency_contacts_insights_0011 RENAME TO idx_agency_contacts_insights;

COMMENT ON INDEX idx_agency_contacts_insights IS
  'Insights as-of-now reads: roster bucket counts, allocation and the headline for one campaign, index-only (every column they read is a key or INCLUDE column).';

DROP INDEX IF EXISTS idx_agency_inbound_calls_account_live;
