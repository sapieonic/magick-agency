-- 0032_inbound_route_wrapup.sql — the inbound wrap-up window is the route's (docs/inbound.md §6, §9;
-- decision IQ52, which replaces IQ32's window).
--
-- Until now an answered inbound call's wrap-up followed the matched campaign's auto-return rule
-- (`wrapup_seconds`, `wrapup_auto_return`), and an unmatched call took a fixed 120 s. IQ52: every
-- inbound call on a route takes the ROUTE's window, on a console or a phone, always with
-- auto-return (the outcome lapses `no_disposition` when the window ends and the agent is returned);
-- the 30-minute lapse (AGENCY_INBOUND_OUTCOME_LAPSE_MS) stays the backstop.
--
-- ── New columns ───────────────────────────────────────────────────────────────
--  - agency_inbound_routes.wrapup_seconds SMALLINT NOT NULL DEFAULT 30: the route's window, set in
--    the route editor. ck_agency_inbound_routes_wrapup holds it to 10..600 seconds (the contract's
--    AGENCY_INBOUND_ROUTE_LIMITS.WRAPUP_SECONDS): long enough to note who rang, never so long that
--    an agent who walked away is held out of the pool for more than ten minutes. Existing routes
--    take the default (a constant default: catalog-only, no rewrite).
--  - agency_inbound_calls.wrapup_seconds SMALLINT NULL: the window the call takes, CAPTURED from its
--    route when the call arrives (the answer webhook's insert). The lapse sweep and the panel's
--    `outcome_due_at` read it from the call row, never from the route, so a route edited or deleted
--    while the call is live or its outcome owed does not move the countdown the agent was shown.
--    NULL on a call with no route (the tenant default's, which no agent ever takes) and on a row
--    from before this migration that the backfill could not name a route for; the server reads
--    NULL as the default (30 s). ck_agency_inbound_calls_wrapup: the same range when set.
--
-- ── Backfill ──────────────────────────────────────────────────────────────────
-- Every existing call with a route takes its route's window (30 s: every route has the default
-- here), so an outcome owed across the deploy lapses on the new rule. The `updated_at` trigger is
-- disabled around it (a schema copy is not a change anyone made), as in 0027.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Both tables are small (one row per route; one per inbound call). The columns are catalog-only;
-- the backfill and the CHECKs scan agency_inbound_calls once under this file's ACCESS EXCLUSIVE.
-- Migrations run at container start, before the server listens.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the CHECKs and the columns. A route's window is lost (the server before this reads the
-- matched campaign's rule again).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_inbound_routes
  ADD COLUMN wrapup_seconds SMALLINT NOT NULL DEFAULT 30,
  ADD CONSTRAINT ck_agency_inbound_routes_wrapup CHECK (wrapup_seconds BETWEEN 10 AND 600);

COMMENT ON COLUMN agency_inbound_routes.wrapup_seconds IS
  'IQ52: the wrap-up window of every inbound call on the route, in seconds (10..600), always with auto-return; captured on each call at arrival (agency_inbound_calls.wrapup_seconds).';

ALTER TABLE agency_inbound_calls
  ADD COLUMN wrapup_seconds SMALLINT;

ALTER TABLE agency_inbound_calls DISABLE TRIGGER trg_agency_inbound_calls_updated_at;
UPDATE agency_inbound_calls c
   SET wrapup_seconds = r.wrapup_seconds
  FROM agency_inbound_routes r
 WHERE r.id = c.route_id;
ALTER TABLE agency_inbound_calls ENABLE TRIGGER trg_agency_inbound_calls_updated_at;

ALTER TABLE agency_inbound_calls
  ADD CONSTRAINT ck_agency_inbound_calls_wrapup CHECK (wrapup_seconds IS NULL OR wrapup_seconds BETWEEN 10 AND 600);

COMMENT ON COLUMN agency_inbound_calls.wrapup_seconds IS
  'IQ52: the route''s wrap-up window, captured when the call arrived; the lapse sweep and the panel read it. NULL: no route (or not captured): the default, 30 s.';

-- Down Migration

ALTER TABLE agency_inbound_calls
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_wrapup,
  DROP COLUMN IF EXISTS wrapup_seconds;

ALTER TABLE agency_inbound_routes
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_routes_wrapup,
  DROP COLUMN IF EXISTS wrapup_seconds;
