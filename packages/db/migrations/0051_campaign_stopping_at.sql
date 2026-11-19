-- 0051_campaign_stopping_at.sql — when a campaign entered `stopping` (decision B28b: Home's
-- "Stopping, by Ravi at 11:03" on the Live floor's campaign cards). 0050 is applied and is not
-- edited.
--
-- ── stopping_at (new) ─────────────────────────────────────────────────────────
-- Stamped by `transitionStatus` (the one statement that moves a campaign's status) on the way into
-- `stopping`, first-write-wins (`COALESCE(stopping_at, now())`), and left alone by every other
-- transition: a second Stop, were one accepted, cannot move it, and `stopping → stopped` keeps it.
-- Before it, Home read the time from the Stop's `agency_campaign.stopped` audit row, which the Stop
-- route writes after the transition without waiting for it, so the console's reload straight after
-- Stop often read the board before that row existed (and memoised a stop with no time).
--
-- Nullable, no default, no backfill. A campaign that entered `stopping` before this migration
-- reads null, and Home serves its stop with no time: `stopping` is a drain of the calls in flight
-- (minutes), so such a row stops soon after the deploy, and the audit row is not read for it.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default is catalog-only (no rewrite), but takes ACCESS EXCLUSIVE on
-- agency_campaigns, which the live server writes: the Up starts with a lock timeout
-- (db-hygiene.md).
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the column; a release before this one reads the time from the audit row again.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_campaigns ADD COLUMN IF NOT EXISTS stopping_at TIMESTAMPTZ;

COMMENT ON COLUMN agency_campaigns.stopping_at IS
  'When Stop moved the campaign to stopping (transitionStatus, first-write-wins; kept on stopped). NULL for a campaign never stopped, or one that entered stopping before 0051.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_campaigns DROP COLUMN IF EXISTS stopping_at;
