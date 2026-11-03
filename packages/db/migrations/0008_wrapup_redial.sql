-- 0008_wrapup_redial.sql — the agent redials the same customer from the wrap-up screen.
--
-- A connected call can drop for reasons on any side (ours, the carrier's, the customer's). With
-- `agency_campaigns.allow_wrapup_redial` on, an agent in wrap-up whose outcome is still owed may
-- redial the customer they were just talking to, connected back to themselves
-- (`POST /proxy/agency/sessions/:id/redial`). Off by default: nothing changes for a campaign that
-- does not ask for it.
--
-- A redial is an ordinary attempt row with two links back:
--
--  - `redial_of_attempt_id`: the attempt it redials (the one whose wrap-up the agent was in). That
--    attempt keeps its own outcome (`connected`, so campaign stats and talk time stay true) and is
--    closed with the reserved system disposition `redialed` and `wrapup_resolution = 'redialed'`.
--    The partial unique index makes "one redial per attempt" the database's rule, so a
--    double-click cannot start two calls to one customer.
--  - `redial_number`: 1 for the first redial of a call, 2 for the redial of that redial. The bound
--    (`AGENCY_WRAPUP_REDIAL_LIMIT`, 2) is the contract's and the server enforces it; the column
--    only refuses a negative number, so the limit has one home.
--
-- `ck_agency_wrapup_resolution` gains `redialed`: the wrap-up the redial ended. The supervisor's
-- average wrap-up (`stats()`) averages only `disposition_submitted`, `auto_return` and
-- `agent_returned`, so a redial is not counted as wrap-up work.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with a constant default does not rewrite the table (Postgres 11+). Dropping and
-- re-adding the CHECK scans agency_call_attempts once under ACCESS EXCLUSIVE; migrations run at
-- container start, before the server listens (docker/entrypoint.sh).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_campaigns
  ADD COLUMN allow_wrapup_redial BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN agency_campaigns.allow_wrapup_redial IS
  'The agent may redial the same customer from the wrap-up screen while the outcome is owed (at most AGENCY_WRAPUP_REDIAL_LIMIT redials per call).';

ALTER TABLE agency_call_attempts
  ADD COLUMN redial_of_attempt_id UUID REFERENCES agency_call_attempts(id) ON DELETE SET NULL,
  ADD COLUMN redial_number SMALLINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_agency_attempt_redial_number CHECK (redial_number >= 0),
  -- A link means a redial. The converse is not checked: ON DELETE SET NULL can drop the link of
  -- a redial whose original was purged, and its number stays.
  ADD CONSTRAINT ck_agency_attempt_redial_link CHECK (redial_of_attempt_id IS NULL OR redial_number > 0);

COMMENT ON COLUMN agency_call_attempts.redial_of_attempt_id IS
  'The attempt this one redials from its wrap-up (closed with disposition redialed). NULL: a dial the pacing engine placed.';
COMMENT ON COLUMN agency_call_attempts.redial_number IS
  '0 for a paced dial; 1, 2, ... for the redials of one call, in order.';

-- One redial per attempt: a second request for the same wrap-up is refused by the index.
CREATE UNIQUE INDEX uq_agency_attempt_redial_of
  ON agency_call_attempts (redial_of_attempt_id)
  WHERE redial_of_attempt_id IS NOT NULL;

ALTER TABLE agency_call_attempts
  DROP CONSTRAINT ck_agency_wrapup_resolution;
ALTER TABLE agency_call_attempts
  ADD CONSTRAINT ck_agency_wrapup_resolution CHECK (
    wrapup_resolution IS NULL OR wrapup_resolution IN (
      'auto_return', 'disposition_submitted', 'agent_returned',
      'forced', 'agent_left', 'campaign_stopped', 'redialed'
    )
  );

-- Down Migration

UPDATE agency_call_attempts SET wrapup_resolution = 'agent_left' WHERE wrapup_resolution = 'redialed';
ALTER TABLE agency_call_attempts
  DROP CONSTRAINT ck_agency_wrapup_resolution;
ALTER TABLE agency_call_attempts
  ADD CONSTRAINT ck_agency_wrapup_resolution CHECK (
    wrapup_resolution IS NULL OR wrapup_resolution IN (
      'auto_return', 'disposition_submitted', 'agent_returned',
      'forced', 'agent_left', 'campaign_stopped'
    )
  );

DROP INDEX IF EXISTS uq_agency_attempt_redial_of;
ALTER TABLE agency_call_attempts
  DROP CONSTRAINT IF EXISTS ck_agency_attempt_redial_link,
  DROP CONSTRAINT IF EXISTS ck_agency_attempt_redial_number,
  DROP COLUMN IF EXISTS redial_number,
  DROP COLUMN IF EXISTS redial_of_attempt_id;

ALTER TABLE agency_campaigns
  DROP COLUMN IF EXISTS allow_wrapup_redial;
