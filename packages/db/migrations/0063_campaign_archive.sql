-- 0063_campaign_archive.sql — archived campaigns (decisions AR1–AR6, docs/decisions.md). 0062 is
-- applied and is not edited.
--
-- A supervisor archives a draft or a stopped campaign to take it off the Campaigns page; it is listed
-- on its own Archived campaigns screen instead, and can be restored. Archiving is NOT a status: the
-- campaign stays `draft` or `stopped`, so every reader of `status` (reports, Insights, the pacing
-- leader, customer history) is unchanged, and restoring puts it back exactly as it was (AR1).
--
-- ── archived_at, archived_by_user_id, archived_by_name (new) ─────────────────
-- Written together by the archive route (`archive`, the campaign repository) and cleared together by
-- the restore route. `archived_at` NULL is a campaign that is not archived. The actor pair is the
-- public layer's user id and the display name it resolved at the moment of archiving, the same pair
-- and the same widths as `last_transition_by_*` (a snapshot; NULL when nobody could be named).
--
-- ── ck_agency_campaign_archived_status (new) ──────────────────────────────────
-- Only a `draft` or `stopped` campaign is archived (AR2). The routes refuse the rest, and the one
-- statement that moves a status refuses an archived campaign (`transitionStatus`), so this CHECK is
-- the backstop: nothing can dial a campaign while it is archived. Added validated: every row is
-- NULL today and the table is a few rows per account, so the scan is short.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default is catalog-only, but it and ADD CONSTRAINT take ACCESS EXCLUSIVE on
-- agency_campaigns, which the live server writes: the Up starts with a lock timeout (db-hygiene.md).
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the constraint and the columns: every archived campaign is listed on the Campaigns page
-- again, in the status it was archived in.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_campaigns
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS archived_by_name VARCHAR(255);

ALTER TABLE agency_campaigns
  ADD CONSTRAINT ck_agency_campaign_archived_status
  CHECK (archived_at IS NULL OR status IN ('draft', 'stopped'));

COMMENT ON COLUMN agency_campaigns.archived_at IS
  'When the campaign was archived (off the Campaigns page, on Archived campaigns). NULL = not archived. Only a draft or stopped campaign (ck_agency_campaign_archived_status).';
COMMENT ON COLUMN agency_campaigns.archived_by_user_id IS
  'users.id of whoever archived it, or NULL. No FK: opaque to the dialer tables. Cleared on restore.';
COMMENT ON COLUMN agency_campaigns.archived_by_name IS
  'Their display name when they archived it (a snapshot, never refreshed), or NULL. Cleared on restore.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_campaigns DROP CONSTRAINT IF EXISTS ck_agency_campaign_archived_status;
ALTER TABLE agency_campaigns
  DROP COLUMN IF EXISTS archived_by_name,
  DROP COLUMN IF EXISTS archived_by_user_id,
  DROP COLUMN IF EXISTS archived_at;
