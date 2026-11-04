-- 0014_insights_rollup_first_dials_carrier_errors.sql — two facts the insights rollup's facets
-- (0012) did not carry (docs/insights.md "The rollup").
--
--  1. FIRST DIALS per facet key. The page's connect rate is `/stats`' definition: connected over
--     the dials that were not a wrap-up redial, redials out of both (`campaign-stats.ts`
--     `connect_rate_pct`). The `caller_id` and `local_hour` facets held every dial (`n`) and the
--     connected among the first dials, so a caller ID's or an hour's rate could only be read
--     with the redials in its denominator. `first_dials` is the denominator: the facet's dials
--     with `redial_number = 0` (0 on every other facet).
--
--  2. CARRIER FAILURES BY CODE. The `carrier_error` facet: placed dials whose outcome is
--     `failed`, keyed by the call row's `agency_calls.error_code` (NULL: no call row, or none
--     recorded). It sums to the `outcome = 'failed'` facet over any range. The call row's
--     `error_code` is written when the bridge ends the call, which can be after the attempt's
--     own last write, so a row trigger re-marks the attempt's bucket when it changes, as 0012's
--     recording trigger does for `recording_url`. Its WHEN clause makes every other agency_calls
--     write free; it fires once per failed call (BASELINE.md "0014" has the measured cost).
--
-- ── Backfill ────────────────────────────────────────────────────────────────
-- Every bucket the rollup already holds is marked dirty, so the job rebuilds it with the new
-- column and facet (recompute, never increment: 0012's header). A bucket not rolled up yet is
-- marked already.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- One transaction. ADD COLUMN with a constant default is a catalog change; replacing the facet
-- CHECK takes ACCESS EXCLUSIVE on agency_insights_rollup_facets and validates its rows (the job
-- is its only writer and waits). CREATE TRIGGER takes SHARE ROW EXCLUSIVE on agency_calls until
-- commit. The backfill reads the rollup headers (2,880 rows for a 1M-attempt month).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_insights_rollup_facets
  ADD COLUMN first_dials BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN agency_insights_rollup_facets.first_dials IS
  'caller_id and local_hour: the key''s dials that were not a wrap-up redial (redial_number = 0), the connect rate''s denominator. 0 on every other facet.';

ALTER TABLE agency_insights_rollup_facets
  DROP CONSTRAINT ck_agency_insights_rollup_facet,
  ADD CONSTRAINT ck_agency_insights_rollup_facet CHECK (facet IN
    ('outcome', 'caller_id', 'local_hour', 'no_outcome', 'override', 'carrier_error'));

COMMENT ON TABLE agency_insights_rollup_facets IS
  'Insights rollup: one-dimensional breakdowns (outcome, caller ID, contact-local hour, no-outcome resolution, override by granting code and agent, carrier failures by the call''s error code).';

-- The carrier's error code lands on the call row when the bridge ends the call: re-mark the bucket.
CREATE FUNCTION agency_insights_mark_call_error() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
  SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at)
    FROM agency_call_attempts
   WHERE webrtc_call_id = NEW.id AND dialed_at IS NOT NULL;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_insights_mark_call_error() IS
  'Marks the insights rollup bucket of the attempt whose webrtc_call_id is this call (idx_agency_attempts_webrtc), when its error_code changes (the carrier_error facet).';

CREATE TRIGGER trg_agency_calls_insights_error_insert
  AFTER INSERT ON agency_calls
  FOR EACH ROW WHEN (NEW.error_code IS NOT NULL)
  EXECUTE FUNCTION agency_insights_mark_call_error();

CREATE TRIGGER trg_agency_calls_insights_error_update
  AFTER UPDATE OF error_code ON agency_calls
  FOR EACH ROW WHEN (OLD.error_code IS DISTINCT FROM NEW.error_code)
  EXECUTE FUNCTION agency_insights_mark_call_error();

-- Backfill: rebuild every bucket the rollup holds.
INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
SELECT campaign_id, bucket_start FROM agency_insights_rollup_buckets ORDER BY bucket_start, campaign_id;

-- Down Migration

DROP TRIGGER IF EXISTS trg_agency_calls_insights_error_update ON agency_calls;
DROP TRIGGER IF EXISTS trg_agency_calls_insights_error_insert ON agency_calls;
DROP FUNCTION IF EXISTS agency_insights_mark_call_error();

DELETE FROM agency_insights_rollup_facets WHERE facet = 'carrier_error';

ALTER TABLE agency_insights_rollup_facets
  DROP CONSTRAINT ck_agency_insights_rollup_facet,
  ADD CONSTRAINT ck_agency_insights_rollup_facet CHECK (facet IN
    ('outcome', 'caller_id', 'local_hour', 'no_outcome', 'override'));

COMMENT ON TABLE agency_insights_rollup_facets IS
  'Insights rollup: one-dimensional breakdowns (outcome, caller ID, contact-local hour, no-outcome resolution, override by granting code and agent).';

ALTER TABLE agency_insights_rollup_facets DROP COLUMN IF EXISTS first_dials;
