-- 0012_insights_rollup.sql — the campaign insights rollup (docs/insights.md "Shape", workstream B).
--
-- The range sections of the insights page (calls, outcomes, agents, trends, caller IDs,
-- recording) read a rollup, never the attempt table. The rollup is a pure function of
-- agency_call_attempts (plus three facts joined to each attempt: the agent behind its reserved
-- session, its contact's time zone and its call's recording), cut into 15-minute UTC buckets of
-- `dialed_at`. Recompute, never increment: dispositions arrive after the call ends, the reaper
-- rewrites outcomes, a recording lands minutes later, and an incremental counter drifts the
-- first time one path forgets it. So:
--
--  - triggers on every write that can change what a bucket holds append a MARK
--    (campaign_id, bucket_start) to agency_insights_rollup_dirty;
--  - a background job (agency bootstrap, the main process) claims marks oldest first,
--    recomputes each marked bucket from the attempts in it (delete + insert, one transaction)
--    and deletes the marks it claimed. The SQL that recomputes lives in the server
--    (`apps/server/src/db/repositories/agency/insights-rollup-sql.ts`), because it is built from
--    the domain's definitions (abandonment, conversation, measured wrap-up) and those are
--    TypeScript constants that must not be re-spelled here.
--
-- 15-minute buckets because UTC+05:30 and UTC+05:45 hours do not align to UTC hours: every
-- local hour and day in a zone whose offset is a multiple of 15 minutes (all of them today) is
-- a whole number of these buckets.
--
-- ── Why marks are APPENDED, never upserted ───────────────────────────────────
-- A unique (campaign_id, bucket_start) dirty row written with ON CONFLICT DO NOTHING loses
-- updates: an attempt write whose mark conflicts with a row the job is about to consume, and
-- whose transaction commits after the job's recompute snapshot, is in neither. ON CONFLICT DO
-- UPDATE (a generation bump) closes that, but makes every attempt write in one campaign's
-- current quarter hour queue on one row lock until its transaction commits: a new contention
-- point and a new deadlock order in the dialler's hot path. A plain INSERT into a table with no
-- unique key never waits on anything. The job deletes exactly the marks its claim saw, in the
-- transaction that recomputes from a later snapshot, so a mark is gone only once a recompute
-- has seen the write behind it; a mark committed later survives and the bucket is recomputed
-- again.
--
-- ── Why a header row per bucket ─────────────────────────────────────────────
-- agency_insights_rollup_buckets is the bucket's totals AND its lock: the job upserts the
-- headers of the buckets it recomputes (in key order) before it deletes and re-inserts their
-- rows, so two recomputes of one bucket serialize on that row and the second one's later
-- snapshot sees, deletes and replaces the first one's rows. Without it two jobs could each
-- insert a copy (a DELETE does not see rows inserted after its snapshot). The triggers never
-- touch the header.
--
-- ── The triggers ────────────────────────────────────────────────────────────
-- On agency_call_attempts: three AFTER ... FOR EACH STATEMENT triggers with transition tables
-- (INSERT, UPDATE, DELETE: a trigger with transition tables takes one event and no column
-- list), one function. Every placed attempt (dialed_at set) in the statement marks its bucket;
-- an UPDATE marks the OLD and the NEW bucket, so moving dialed_at across a boundary dirties
-- both. One INSERT per statement of the DISTINCT buckets it touched, so a reaper sweep that
-- settles a thousand attempts writes a handful of marks. Statement-level rather than 0011's
-- row-level WHEN: a WHEN clause cannot see the bucket, and a bulk write would mark per row.
-- Measured on 5,000 single-row attempt updates (the dialler's shape), shared dev host: see
-- BASELINE.md.
--
-- The three joined facts each get a row-level trigger whose WHEN clause makes the common write
-- free: agency_calls.recording_url (a recording arrives after the call), agency_contacts.timezone
-- (the contact's local hour), agency_campaigns.default_timezone (the fallback zone). A session's
-- agent_user_id never changes, so agency_agent_sessions needs none.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- One transaction. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on agency_call_attempts,
-- agency_calls, agency_contacts and agency_campaigns until commit, and the backfill (one mark
-- per distinct bucket that has a placed attempt) reads agency_call_attempts through
-- idx_agency_attempts_billing under it. Production has no data yet (docs/status.md); on the 1M
-- attempt seed the backfill took well under a second (BASELINE.md). The job then works the
-- backlog off at its batch size per pass.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE FUNCTION agency_insights_bucket(ts TIMESTAMPTZ) RETURNS TIMESTAMPTZ
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN date_bin(interval '15 minutes', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00');

COMMENT ON FUNCTION agency_insights_bucket(TIMESTAMPTZ) IS
  'The insights rollup bucket of an instant: its 15-minute UTC boundary. The one definition, used by the dirty-marking triggers, the rollup CHECKs and the server''s recompute.';

-- ── The marks ─────────────────────────────────────────────────────────────────

CREATE TABLE agency_insights_rollup_dirty (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- No FK: a campaign DELETE cascades to its attempts inside the same statement, and the
  -- attempts' DELETE trigger marks their buckets after the campaign row is gone. The job drops
  -- marks whose campaign no longer exists.
  campaign_id   UUID NOT NULL,
  bucket_start  TIMESTAMPTZ NOT NULL,
  marked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_agency_insights_dirty_bucket CHECK (bucket_start = agency_insights_bucket(bucket_start))
);

CREATE INDEX idx_agency_insights_rollup_dirty_bucket
  ON agency_insights_rollup_dirty (campaign_id, bucket_start);

COMMENT ON TABLE agency_insights_rollup_dirty IS
  'Append-only marks: "this campaign''s bucket changed, recompute it". Written by triggers, consumed (deleted) by the insights rollup job in the transaction that recomputes the bucket. Never upserted: see 0012''s header.';
COMMENT ON INDEX idx_agency_insights_rollup_dirty_bucket IS
  'The job''s collapse: every other visible mark of a bucket it claimed, so a busy bucket is recomputed once per pass, not once per mark.';

-- ── The rollup ────────────────────────────────────────────────────────────────
-- Every measure is a count or a sum, so any range is the SUM of its buckets. Durations are
-- whole microseconds (exact: EXTRACT(EPOCH ...) of a timestamptz difference has six decimals).

CREATE TABLE agency_insights_rollup_buckets (
  campaign_id            UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  bucket_start           TIMESTAMPTZ NOT NULL,
  -- The newest updated_at of the attempts folded in; NULL for a bucket that holds none now.
  source_updated_at      TIMESTAMPTZ,
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  dials                  BIGINT NOT NULL DEFAULT 0,
  connected              BIGINT NOT NULL DEFAULT 0,
  conversations          BIGINT NOT NULL DEFAULT 0,
  bridged                BIGINT NOT NULL DEFAULT 0,
  abandoned              BIGINT NOT NULL DEFAULT 0,
  answered               BIGINT NOT NULL DEFAULT 0,
  talk_us                BIGINT NOT NULL DEFAULT 0,
  wrapup_us              BIGINT NOT NULL DEFAULT 0,
  wrapup_measured        BIGINT NOT NULL DEFAULT 0,
  redials_placed         BIGINT NOT NULL DEFAULT 0,
  redials_connected      BIGINT NOT NULL DEFAULT 0,
  redial_chains_at_limit BIGINT NOT NULL DEFAULT 0,
  reopened_dials         BIGINT NOT NULL DEFAULT 0,
  reopened_connected     BIGINT NOT NULL DEFAULT 0,
  manual_dials           BIGINT NOT NULL DEFAULT 0,
  manual_connected       BIGINT NOT NULL DEFAULT 0,
  overrides_used         BIGINT NOT NULL DEFAULT 0,
  recorded_connected     BIGINT NOT NULL DEFAULT 0,
  callbacks_booked       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, bucket_start),
  CONSTRAINT ck_agency_insights_rollup_bucket CHECK (bucket_start = agency_insights_bucket(bucket_start))
);

-- Per agent (the reserved session's agent_user_id; NULL for an attempt with no session).
CREATE TABLE agency_insights_rollup_agents (
  campaign_id            UUID NOT NULL,
  bucket_start           TIMESTAMPTZ NOT NULL,
  agent_user_id          UUID,
  dials                  BIGINT NOT NULL DEFAULT 0,
  connected              BIGINT NOT NULL DEFAULT 0,
  conversations          BIGINT NOT NULL DEFAULT 0,
  bridged                BIGINT NOT NULL DEFAULT 0,
  abandoned              BIGINT NOT NULL DEFAULT 0,
  answered               BIGINT NOT NULL DEFAULT 0,
  talk_us                BIGINT NOT NULL DEFAULT 0,
  wrapup_us              BIGINT NOT NULL DEFAULT 0,
  wrapup_measured        BIGINT NOT NULL DEFAULT 0,
  redials_placed         BIGINT NOT NULL DEFAULT 0,
  redials_connected      BIGINT NOT NULL DEFAULT 0,
  redial_chains_at_limit BIGINT NOT NULL DEFAULT 0,
  reopened_dials         BIGINT NOT NULL DEFAULT 0,
  reopened_connected     BIGINT NOT NULL DEFAULT 0,
  manual_dials           BIGINT NOT NULL DEFAULT 0,
  manual_connected       BIGINT NOT NULL DEFAULT 0,
  overrides_used         BIGINT NOT NULL DEFAULT 0,
  recorded_connected     BIGINT NOT NULL DEFAULT 0,
  callbacks_booked       BIGINT NOT NULL DEFAULT 0,
  FOREIGN KEY (campaign_id, bucket_start)
    REFERENCES agency_insights_rollup_buckets (campaign_id, bucket_start) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_agency_insights_rollup_agents
  ON agency_insights_rollup_agents (campaign_id, bucket_start, agent_user_id) NULLS NOT DISTINCT;

-- Per agent and disposition code: the counts the reader filters by a caller-given code list
-- (successes, override grants), so a catalog edit never leaves the rollup stale. Only rows that
-- carry a code or are a conversation (a NULL code there is "connected, closed without one").
CREATE TABLE agency_insights_rollup_codes (
  campaign_id       UUID NOT NULL,
  bucket_start      TIMESTAMPTZ NOT NULL,
  agent_user_id     UUID,
  disposition_code  VARCHAR(50),
  conversations     BIGINT NOT NULL DEFAULT 0,
  dials             BIGINT NOT NULL DEFAULT 0,
  FOREIGN KEY (campaign_id, bucket_start)
    REFERENCES agency_insights_rollup_buckets (campaign_id, bucket_start) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_agency_insights_rollup_codes
  ON agency_insights_rollup_codes (campaign_id, bucket_start, agent_user_id, disposition_code) NULLS NOT DISTINCT;

-- One-dimensional breakdowns, one facet per row kind:
--   outcome      key = outcome (NULL: live or unrecorded)   n = dials
--   caller_id    key = caller ID                             n = dials, connected
--   local_hour   key = contact-local hour '0'..'23'          n = dials, connected
--   no_outcome   key = wrapup_resolution                     n = conversations closed with no outcome
--   override     key = the granting code, agent_user_id set  n = dials that spent an override
CREATE TABLE agency_insights_rollup_facets (
  campaign_id    UUID NOT NULL,
  bucket_start   TIMESTAMPTZ NOT NULL,
  facet          VARCHAR(16) NOT NULL,
  key            TEXT,
  agent_user_id  UUID,
  n              BIGINT NOT NULL DEFAULT 0,
  connected      BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT ck_agency_insights_rollup_facet CHECK (facet IN
    ('outcome', 'caller_id', 'local_hour', 'no_outcome', 'override')),
  FOREIGN KEY (campaign_id, bucket_start)
    REFERENCES agency_insights_rollup_buckets (campaign_id, bucket_start) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_agency_insights_rollup_facets
  ON agency_insights_rollup_facets (campaign_id, facet, bucket_start, key, agent_user_id) NULLS NOT DISTINCT;

-- The FKs above are (campaign_id, bucket_start); each unique index leads with them (the facets'
-- after `facet`), so a cascade from a header finds its rows. The facets' index leads with facet
-- because every read names one.

COMMENT ON TABLE agency_insights_rollup_buckets IS
  'Insights rollup: one row per (campaign, 15-minute UTC bucket of dialed_at) the job has recomputed: the bucket''s totals, and the row the job locks to serialize recomputes of it. Rebuilt from agency_call_attempts, never incremented.';
COMMENT ON TABLE agency_insights_rollup_agents IS
  'Insights rollup: the bucket''s measures per agent (agency_agent_sessions.agent_user_id of the reserved session).';
COMMENT ON TABLE agency_insights_rollup_codes IS
  'Insights rollup: conversations and dials per agent per disposition code, for the reads that filter by a caller-given code list (successes, override grants).';
COMMENT ON TABLE agency_insights_rollup_facets IS
  'Insights rollup: one-dimensional breakdowns (outcome, caller ID, contact-local hour, no-outcome resolution, override by granting code and agent).';
COMMENT ON COLUMN agency_insights_rollup_buckets.source_updated_at IS
  'Newest updated_at among the attempts folded into this bucket; the page''s "as of". NULL when the bucket now holds no attempt.';

-- ── The marking triggers ──────────────────────────────────────────────────────

CREATE FUNCTION agency_insights_mark_attempt_buckets() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
    SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at)
      FROM new_rows WHERE dialed_at IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
    SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at)
      FROM (SELECT campaign_id, dialed_at FROM old_rows
            UNION ALL
            SELECT campaign_id, dialed_at FROM new_rows) r
     WHERE dialed_at IS NOT NULL;
  ELSE
    INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
    SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at)
      FROM old_rows WHERE dialed_at IS NOT NULL;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_insights_mark_attempt_buckets() IS
  'Marks the insights rollup buckets an attempt statement touched (old and new dialed_at), one mark per distinct bucket. Called only by the three trg_agency_attempts_insights_* statement triggers.';

CREATE TRIGGER trg_agency_attempts_insights_insert
  AFTER INSERT ON agency_call_attempts
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION agency_insights_mark_attempt_buckets();

CREATE TRIGGER trg_agency_attempts_insights_update
  AFTER UPDATE ON agency_call_attempts
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION agency_insights_mark_attempt_buckets();

CREATE TRIGGER trg_agency_attempts_insights_delete
  AFTER DELETE ON agency_call_attempts
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION agency_insights_mark_attempt_buckets();

-- A recording lands on the call row, after the attempt has settled: re-mark the attempt's bucket.
CREATE FUNCTION agency_insights_mark_call_recording() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
  SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at)
    FROM agency_call_attempts
   WHERE webrtc_call_id = NEW.id AND dialed_at IS NOT NULL;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_insights_mark_call_recording() IS
  'Marks the insights rollup bucket of the attempt whose webrtc_call_id is this call (idx_agency_attempts_webrtc), when its recording_url changes.';

CREATE TRIGGER trg_agency_calls_insights_recording_insert
  AFTER INSERT ON agency_calls
  FOR EACH ROW WHEN (NEW.recording_url IS NOT NULL)
  EXECUTE FUNCTION agency_insights_mark_call_recording();

CREATE TRIGGER trg_agency_calls_insights_recording_update
  AFTER UPDATE OF recording_url ON agency_calls
  FOR EACH ROW WHEN (OLD.recording_url IS DISTINCT FROM NEW.recording_url)
  EXECUTE FUNCTION agency_insights_mark_call_recording();

-- The contact's zone decides its local hour.
CREATE FUNCTION agency_insights_mark_contact_zone() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
  SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at)
    FROM agency_call_attempts
   WHERE contact_id = NEW.id AND dialed_at IS NOT NULL;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_insights_mark_contact_zone() IS
  'Marks the insights rollup buckets of a contact''s placed attempts (uq_agency_attempt_number leads with contact_id) when its timezone changes.';

CREATE TRIGGER trg_agency_contacts_insights_zone
  AFTER UPDATE OF timezone ON agency_contacts
  FOR EACH ROW WHEN (OLD.timezone IS DISTINCT FROM NEW.timezone)
  EXECUTE FUNCTION agency_insights_mark_contact_zone();

-- The campaign zone is every zoneless contact's fallback: re-mark every bucket already rolled up.
-- (A bucket not rolled up yet is marked already.)
CREATE FUNCTION agency_insights_mark_campaign_zone() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
  SELECT campaign_id, bucket_start FROM agency_insights_rollup_buckets WHERE campaign_id = NEW.id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_insights_mark_campaign_zone() IS
  'Marks every rolled-up insights bucket of a campaign when its default_timezone changes (the contact-local hour of every zoneless contact moves).';

CREATE TRIGGER trg_agency_campaigns_insights_zone
  AFTER UPDATE OF default_timezone ON agency_campaigns
  FOR EACH ROW WHEN (OLD.default_timezone IS DISTINCT FROM NEW.default_timezone)
  EXECUTE FUNCTION agency_insights_mark_campaign_zone();

-- ── Backfill: every bucket that holds a placed attempt is dirty ──────────────

INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at)
  FROM agency_call_attempts
 WHERE dialed_at IS NOT NULL
 ORDER BY 2, 1;

-- Down Migration

DROP TRIGGER IF EXISTS trg_agency_campaigns_insights_zone ON agency_campaigns;
DROP TRIGGER IF EXISTS trg_agency_contacts_insights_zone ON agency_contacts;
DROP TRIGGER IF EXISTS trg_agency_calls_insights_recording_update ON agency_calls;
DROP TRIGGER IF EXISTS trg_agency_calls_insights_recording_insert ON agency_calls;
DROP TRIGGER IF EXISTS trg_agency_attempts_insights_delete ON agency_call_attempts;
DROP TRIGGER IF EXISTS trg_agency_attempts_insights_update ON agency_call_attempts;
DROP TRIGGER IF EXISTS trg_agency_attempts_insights_insert ON agency_call_attempts;
DROP FUNCTION IF EXISTS agency_insights_mark_campaign_zone();
DROP FUNCTION IF EXISTS agency_insights_mark_contact_zone();
DROP FUNCTION IF EXISTS agency_insights_mark_call_recording();
DROP FUNCTION IF EXISTS agency_insights_mark_attempt_buckets();

DROP TABLE IF EXISTS agency_insights_rollup_facets;
DROP TABLE IF EXISTS agency_insights_rollup_codes;
DROP TABLE IF EXISTS agency_insights_rollup_agents;
DROP TABLE IF EXISTS agency_insights_rollup_buckets;
DROP TABLE IF EXISTS agency_insights_rollup_dirty;

DROP FUNCTION IF EXISTS agency_insights_bucket(TIMESTAMPTZ);
