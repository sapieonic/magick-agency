-- 0068_call_log_inbound_indexes.sql — the campaign Call log's inbound indexes (docs/call-log.md
-- §4) and the validation of 0067's CHECK, out of 0067's ACCESS EXCLUSIVE (0057 / 0058's split).
--
-- ── ck_agency_inbound_calls_campaign_source ───────────────────────────────────
-- VALIDATE CONSTRAINT: every row written since 0067 was already checked, 0067's backfill wrote
-- `contact` beside each campaign, and every other row has both columns NULL, so validation
-- cannot fail. It reads the table once under SHARE UPDATE EXCLUSIVE (writes proceed). Afterwards
-- pg_constraint.convalidated is true.
--
-- ── Indexes ───────────────────────────────────────────────────────────────────
-- idx_agency_inbound_calls_campaign on agency_inbound_calls
--   (campaign_id, arrived_at DESC, id DESC) WHERE campaign_id IS NOT NULL
-- The Call log's inbound branch (`listCallLogForCampaign`): one campaign's calls, newest first, a
-- keyset range on `(arrived_at, id)`, as `idx_agency_manual_calls_campaign` serves the soft-phone
-- branch. Partial: a call filed under no campaign is in no campaign's log.
--
-- idx_agency_manual_calls_callback_of on agency_manual_calls
--   (callback_of_inbound_call_id) WHERE callback_of_inbound_call_id IS NOT NULL
-- The call back of a missed call ("Called back 3:31 PM"): the soft-phone calls placed from the
-- inbound rows of one page, by `= ANY(ids)`. Partial, so it is the size of the call backs.
--
-- ── Locking and cost ──────────────────────────────────────────────────────────
-- Its own transaction (the image's runner commits each file on its own, apps/server/src/
-- migrate.ts). Plain CREATE INDEX, not CONCURRENTLY (refused inside a transaction): each holds
-- SHARE on its table until commit. On the release that adds 0067 the manual calls' column is all
-- NULL, so that build is one read of agency_manual_calls writing an empty index; the inbound one
-- holds the calls 0067 filed. Neither can be built beforehand on a database without 0067 (the
-- columns do not exist). `IF NOT EXISTS` all the same, so a database already on 0067 can build
-- them CONCURRENTLY first (db-hygiene.md §2); the check at the end of Up refuses an invalid index
-- a failed concurrent build leaves under the name. `SET LOCAL lock_timeout = '10s'` first.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops both indexes; the reads fall back to other plans (correct, slower). A validated CHECK
-- cannot be marked NOT VALID again, and need not be: 0067's Down drops it.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_inbound_calls_campaign
  ON agency_inbound_calls (campaign_id, arrived_at DESC, id DESC)
  WHERE campaign_id IS NOT NULL;

COMMENT ON INDEX idx_agency_inbound_calls_campaign IS
  'A campaign''s inbound calls, newest first: the campaign Call log''s inbound branch (docs/call-log.md).';

CREATE INDEX IF NOT EXISTS idx_agency_manual_calls_callback_of
  ON agency_manual_calls (callback_of_inbound_call_id)
  WHERE callback_of_inbound_call_id IS NOT NULL;

COMMENT ON INDEX idx_agency_manual_calls_callback_of IS
  'The soft-phone calls placed from a Missed inbound call''s Call back, by that call (docs/call-log.md, CL1).';

DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_agency_inbound_calls_campaign', 'idx_agency_manual_calls_callback_of')
     AND NOT (i.indisvalid AND i.indisready);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: %; DROP INDEX CONCURRENTLY and build again', bad;
  END IF;
END
$$;

ALTER TABLE agency_inbound_calls VALIDATE CONSTRAINT ck_agency_inbound_calls_campaign_source;

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS idx_agency_manual_calls_callback_of;
DROP INDEX IF EXISTS idx_agency_inbound_calls_campaign;
