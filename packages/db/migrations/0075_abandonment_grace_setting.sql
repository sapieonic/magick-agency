-- 0075_abandonment_grace_setting.sql — the abandonment grace becomes a per-campaign setting, and
-- each attempt carries the grace it is judged by (decisions AG1–AG5, docs/decisions.md).
--
-- The grace is how long after the carrier's answer the agent's audio may connect before the call
-- counts as abandoned. It was one constant (1000 ms, then 3000 ms with AG1, 0074). Manas,
-- 2026-11-24: "configurable, but default to 3".
--
-- ── On the campaign: the setting ──────────────────────────────────────────────
--   agency_campaigns.abandonment_grace_ms  INTEGER NOT NULL DEFAULT 3000
-- ck_agency_campaign_abandonment_grace: whole seconds from 1 to 5 (1000, 2000, 3000, 4000, 5000;
-- AG2), so every allowed value is a bucket boundary of `agency_answer_to_bridge_seconds`. The
-- server's campaign-config validation refuses anything else first (`isAllowedAbandonmentGraceMs`,
-- packages/domain/src/abandonment-predicate.ts, which lists the same five values). Validated here:
-- `agency_campaigns` is small (a few rows per account) and every row takes the default.
--
-- ── On each attempt: the grace it is judged by ────────────────────────────────
--   agency_call_attempts.bridge_grace_ms  INTEGER NOT NULL DEFAULT 3000
-- Stamped from the campaign's setting when the attempt row is created (AG3,
-- `AgencyAttemptRepository.create` and `.beginWrapupRedial` read it from the campaign row in the
-- INSERT itself). ABANDONED_ATTEMPT_PREDICATE_SQL compares `bridged_at - answered_at` with it, so:
--   - a change to a campaign's setting applies to calls placed from then on, and never rewrites
--     the compliance figures of calls already made (the predicate is read at query time);
--   - the predicate stays a predicate over one attempt row, with no join to the campaign: its
--     independence as an audit of `agency_abandoned_total` is the reason it exists.
-- Named `bridge_grace_ms`, not `abandonment_grace_ms`: the predicate names its columns unqualified,
-- and one name on both tables would make every query that joins them ambiguous.
-- Every existing row takes 3000 from the default: the grace AG1 already counts it with, so no
-- figure changes and the Insights rollup (rebuilt by 0074) needs no rebuild.
-- ck_agency_attempt_bridge_grace: the same five values, NOT VALID (no scan of the largest table
-- under this file's lock); 0076 validates it.
--
-- ── A large attempts table: the column and the CHECK can be added beforehand ──
-- The ADD COLUMN costs no scan at any size; 0076's validation reads the whole table, while the
-- server is down for the deploy. Where `agency_call_attempts` is large, DEPLOYMENT.md 12
-- ("Deploying the per-campaign abandonment grace") adds the column and the CHECK and validates it
-- with the server running, before the deploy (the running image never names the column, and the
-- default fills it in). So this file takes the attempts column `IF NOT EXISTS` and adds the CHECK
-- only when it is missing, and refuses, changing nothing, a column or a CHECK found with another
-- definition; 0076's VALIDATE then has nothing left to read.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN … NOT NULL DEFAULT <constant> is a catalogue change on Postgres 11 and later (the
-- default is stored once, not written into each row): no rewrite, no scan. It still takes ACCESS
-- EXCLUSIVE on each table until commit, so `SET LOCAL lock_timeout = '10s'` first: a lock not
-- granted within 10 s fails the migration (the deploy can be retried) instead of queueing every
-- dial behind the wait (db-hygiene.md §6). The campaign CHECK reads `agency_campaigns` once.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops both CHECKs and both columns. Every campaign's own grace and every attempt's stamp is
-- lost; an image from before this release counts every call with its constant again.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on one of these tables (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_campaigns
  ADD COLUMN abandonment_grace_ms INTEGER NOT NULL DEFAULT 3000,
  ADD CONSTRAINT ck_agency_campaign_abandonment_grace
    CHECK (abandonment_grace_ms IN (1000, 2000, 3000, 4000, 5000));

COMMENT ON COLUMN agency_campaigns.abandonment_grace_ms IS
  'Abandonment grace (AG2): how long after the carrier''s answer the agent''s audio may connect before a call counts as abandoned, in ms. Whole seconds 1–5. Stamped on each new attempt as bridge_grace_ms (AG3); a change applies to new calls only.';

-- IF NOT EXISTS and a CHECK added only when missing: a deployment with a large table adds both
-- beforehand (header). Each is checked below, so one pre-added wrong fails here, not later.
ALTER TABLE agency_call_attempts
  ADD COLUMN IF NOT EXISTS bridge_grace_ms INTEGER NOT NULL DEFAULT 3000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'agency_call_attempts'
       AND column_name = 'bridge_grace_ms' AND data_type = 'integer'
       AND is_nullable = 'NO' AND column_default = '3000'
  ) THEN
    RAISE EXCEPTION 'agency_call_attempts.bridge_grace_ms was added beforehand with another definition; expected INTEGER NOT NULL DEFAULT 3000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'agency_call_attempts'::regclass AND conname = 'ck_agency_attempt_bridge_grace'
  ) THEN
    ALTER TABLE agency_call_attempts
      ADD CONSTRAINT ck_agency_attempt_bridge_grace
        CHECK (bridge_grace_ms IN (1000, 2000, 3000, 4000, 5000)) NOT VALID;
  ELSIF (
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid = 'agency_call_attempts'::regclass AND conname = 'ck_agency_attempt_bridge_grace'
  ) <> 'CHECK ((bridge_grace_ms = ANY (ARRAY[1000, 2000, 3000, 4000, 5000])))' THEN
    RAISE EXCEPTION 'ck_agency_attempt_bridge_grace was added beforehand with another definition; expected CHECK (bridge_grace_ms IN (1000, 2000, 3000, 4000, 5000))';
  END IF;
END
$$;

COMMENT ON COLUMN agency_call_attempts.bridge_grace_ms IS
  'The abandonment grace this attempt is judged by, in ms (AG3): its campaign''s abandonment_grace_ms when the row was created. ABANDONED_ATTEMPT_PREDICATE_SQL counts it abandoned when bridged_at - answered_at is longer. Never rewritten. Rows before 0075 hold 3000, the grace they were counted with.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_call_attempts
  DROP CONSTRAINT IF EXISTS ck_agency_attempt_bridge_grace,
  DROP COLUMN IF EXISTS bridge_grace_ms;

ALTER TABLE agency_campaigns
  DROP CONSTRAINT IF EXISTS ck_agency_campaign_abandonment_grace,
  DROP COLUMN IF EXISTS abandonment_grace_ms;
