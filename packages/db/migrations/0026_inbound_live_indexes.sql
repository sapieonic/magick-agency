-- 0026_inbound_live_indexes.sql — the indexes inbound calls' reads need (docs/inbound.md §5.3,
-- §7; decisions IB4, IB5).
--
--  1. CREATE idx_agency_inbound_calls_account_live: IB5 counts a live ADMITTED inbound call in its
--     account's live-call total, so pacing's headroom read (`countLiveForAccount`, every pacing
--     round, per account) gains a third arm:
--       SELECT COUNT(*) FROM agency_inbound_calls i
--        WHERE i.tenant_id = $1 AND i.account_id = $2 AND i.state <> 'ended' AND i.state <> 'arrived'
--     A call still `arrived` was never admitted, or its admission was taken back (the route at its
--     max_concurrent, or the bridge's global or carrier scope full): it hears "all lines are busy"
--     and holds no line, so it is no part of the account's total. 0024's
--     idx_agency_inbound_calls_open is keyed on arrived_at alone, so that arm would walk every
--     live inbound call of every tenant each round. Partial on the arm's literal predicate, so it
--     stays the size of the floor and the planner proves it applies.
--
--     The answer webhook's per-route admission count (once per arriving call, not per round, the
--     same predicate) is left to idx_agency_inbound_calls_open: bounded by the live inbound calls,
--     and the planner prefers it over a (route_id) partial index on a route with any history.
--
--  2. CREATE idx_agency_contacts_inbound_callback: the open inbound callbacks of a campaign
--     (`callback_source IS NOT NULL`, booked by the inbound follow-up, cleared by the contact's
--     next placed call). The callback fallback (CA5) sweeps every running owner-mode campaign
--     every 30 s; on a catalog with no callback code the only callback it can move is an
--     inbound one, and this index answers that sweep without a walk of the campaign's pending
--     roster. It holds a row only while a contact has an inbound callback booked, so for a tenant
--     with no inbound it is empty and costs a probe; its columns are already indexed (campaign_id
--     everywhere, callback_source in the insights INCLUDE list), so no update loses HOT for it.
--
--  3. REBUILD idx_agency_contacts_insights (0011) with `callback_source` among its INCLUDE
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
-- agency_contacts, the roster, is scanned twice (the partial callback index, then the insights
-- rebuild), each scan of the size 0011 measured for this index (~4 s on 1.2M contacts). The
-- insights index is rebuilt under a temporary name FIRST, so the old one serves until the swap,
-- and only then dropped and the new one renamed: the ACCESS EXCLUSIVE those two take is held from
-- the swap to the commit, which follows at once.
--
-- That is acceptable because no writer is running: a deploy stops the one server, then the new
-- container migrates before it listens (docker/entrypoint.sh; DEPLOYMENT.md "Migrations run on
-- start. There is one server, so a deploy is a short outage"), the deploy model every index
-- migration here (0003, 0004, 0015, 0016, 0017) relies on. A deploy that overlapped the old
-- process (blue/green) would have pacing's contact writes wait for the scans; that layout is not
-- supported by this file or by those, and adopting it means moving such builds to CONCURRENTLY
-- statements run outside a migration transaction first.
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops the live index (the count falls back to idx_agency_inbound_calls_open) and the callback
-- index (the fallback sweep falls back to the campaign's pending roster), and rebuilds
-- idx_agency_contacts_insights exactly as 0011 made it, by the same swap.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE INDEX idx_agency_inbound_calls_account_live
  ON agency_inbound_calls (tenant_id, account_id)
  WHERE state <> 'ended' AND state <> 'arrived';

COMMENT ON INDEX idx_agency_inbound_calls_account_live IS
  'IB5: an account''s live admitted inbound calls, counted in its live-call total by every pacing round (countLiveForAccount).';

CREATE INDEX idx_agency_contacts_inbound_callback
  ON agency_contacts (campaign_id)
  WHERE callback_source IS NOT NULL;

COMMENT ON INDEX idx_agency_contacts_inbound_callback IS
  'A campaign''s open inbound callbacks: the CA5 fallback sweep on a catalog with no callback code (fallBackOverdueCallbacks).';

CREATE INDEX idx_agency_contacts_insights_0026
  ON agency_contacts (campaign_id, state)
  INCLUDE (next_attempt_at, suppressed_reason, attempt_count, dials_placed,
           last_outcome, last_disposition, assigned_user_id, callback_source);
DROP INDEX idx_agency_contacts_insights;
ALTER INDEX idx_agency_contacts_insights_0026 RENAME TO idx_agency_contacts_insights;

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

DROP INDEX IF EXISTS idx_agency_contacts_inbound_callback;
DROP INDEX IF EXISTS idx_agency_inbound_calls_account_live;
