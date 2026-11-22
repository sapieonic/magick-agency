-- 0067_call_log_inbound_campaign.sql — one call log per campaign, P2 (docs/call-log.md §4): the
-- campaign an inbound call is filed under, and the missed call a soft-phone call rang back.
--
-- ── agency_inbound_calls ──────────────────────────────────────────────────────
--  - campaign_id UUID NULL: the campaign the call is filed under, the column the campaign Call log
--    reads. Today it is the matched contact's campaign (`matched_campaign_id`); a later phase files
--    an unknown caller under the route's default or the agent's choice, which is why it is its own
--    column and not a second name for the match. No FK, as `matched_campaign_id` has none: the
--    call outlives a deleted campaign.
--  - campaign_source VARCHAR(16) NULL: how the call came by that campaign (contract
--    AGENCY_INBOUND_CAMPAIGN_SOURCES): `contact` (its number is on the campaign's list), `route`,
--    `agent`, `supervisor` (written by a later phase).
--  - ck_agency_inbound_calls_campaign_source: the vocabulary, and both columns set together.
--
-- ── agency_manual_calls ───────────────────────────────────────────────────────
--  - callback_of_inbound_call_id UUID NULL: the Missed inbound call this soft-phone call was
--    placed from (the row's Call back). The call stays a soft-phone call (CL1); the link lets the
--    two rows of the Call log point at each other. No FK: either row may outlive the other
--    (retention), as `webrtc_call_id` has none.
--
-- ── Backfill ──────────────────────────────────────────────────────────────────
-- Every existing inbound call with a matched campaign is filed under it (`campaign_source =
-- 'contact'`), which is what the arrival writes from now on. An unmatched call stays NULL: old
-- calls are never given a guessed campaign (CL10). The `updated_at` trigger is disabled around it
-- (a schema copy is not a change anyone made), as in 0027 and 0032. Done here, not in a batched
-- script (db-hygiene.md §6): agency_inbound_calls holds one row per inbound call (0027 and 0032
-- backfilled it the same way), and only the matched rows are written. A deployment whose table has
-- grown past about a million rows runs the same UPDATE in batches by `id` before the deploy; the
-- statement here then writes nothing (`campaign_id IS NULL` guards it).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- The ADD COLUMNs are catalogue-only (no default). The backfill and the CHECK's validation scan
-- agency_inbound_calls once under this file's ACCESS EXCLUSIVE; migrations run at container start,
-- before the server listens. agency_manual_calls takes a catalogue change only. The indexes are
-- 0068's, built out of this file's locks (0057 / 0058's split). `SET LOCAL lock_timeout = '10s'`
-- first: a lock not granted in 10 s fails the migration instead of queueing every query behind it.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the CHECK and the three columns. The call-back links are lost (nothing else records which
-- missed call a soft-phone call answered); a later up files matched calls again and links none.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_inbound_calls
  ADD COLUMN campaign_id UUID,
  ADD COLUMN campaign_source VARCHAR(16);

ALTER TABLE agency_inbound_calls DISABLE TRIGGER trg_agency_inbound_calls_updated_at;
UPDATE agency_inbound_calls
   SET campaign_id = matched_campaign_id, campaign_source = 'contact'
 WHERE matched_campaign_id IS NOT NULL AND campaign_id IS NULL;
ALTER TABLE agency_inbound_calls ENABLE TRIGGER trg_agency_inbound_calls_updated_at;

ALTER TABLE agency_inbound_calls
  ADD CONSTRAINT ck_agency_inbound_calls_campaign_source CHECK (
    (campaign_id IS NULL AND campaign_source IS NULL)
    OR (campaign_id IS NOT NULL AND campaign_source IS NOT NULL
        AND campaign_source IN ('contact', 'route', 'agent', 'supervisor'))
  );

COMMENT ON COLUMN agency_inbound_calls.campaign_id IS
  'The campaign this call is filed under (docs/call-log.md): the matched contact''s campaign at arrival. NULL: no campaign. No FK.';
COMMENT ON COLUMN agency_inbound_calls.campaign_source IS
  'How the call came by campaign_id: contact (its number is on the campaign''s list), route, agent or supervisor. Set exactly when campaign_id is.';

ALTER TABLE agency_manual_calls
  ADD COLUMN callback_of_inbound_call_id UUID;

COMMENT ON COLUMN agency_manual_calls.callback_of_inbound_call_id IS
  'The Missed inbound call (agency_inbound_calls.id) this soft-phone call was placed from, by its Call back (CL1). NULL: not a call back. No FK.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_manual_calls
  DROP COLUMN IF EXISTS callback_of_inbound_call_id;

ALTER TABLE agency_inbound_calls
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_campaign_source,
  DROP COLUMN IF EXISTS campaign_source,
  DROP COLUMN IF EXISTS campaign_id;
