-- 0027_inbound_connect.sql — what connecting agents to inbound calls needs (docs/inbound.md §6,
-- P2; decisions IB1, IB5, IB7, IB8). 0024 built the spine for calls that reach nobody; this adds the
-- agent side: the session a call is offered to, the queue's timestamps, the outcome the agent
-- writes (as agency_manual_calls carries the soft phone's), settlement, the voicemail's length,
-- and the ringing dial a call superseded (§5.4).
--
-- ── New columns on agency_inbound_calls ──────────────────────────────────────
--  - session_id: the agent session the call is offered to or connected with
--    (agency_agent_sessions.id; no FK, an audit spine). Set by the offer, cleared by a requeue
--    (a station lost before audio binds puts the caller back in the queue, §5.1), kept once the
--    call is connected and after it ends.
--  - queued_at (the first time it queued: the queue's maximum wait counts from it, so a requeue
--    keeps it), offered_at (the latest offer), offer_count (how many offers it has had).
--  - recording_requested: a mirror of the media leg's (the route's `record_calls` at arrival),
--    so the panel needs no join. Backfilled from the leg.
--  - The outcome, as the soft phone's: disposition_code (VARCHAR(64)), disposition_source
--    (`campaign`: the matched campaign's catalog; `route`: the route's catalog, which is the
--    built-in one when the route has none), notes, callback_at, dispositioned_by_user_id,
--    dispositioned_at, dispositioned_on_behalf (a supervisor saved it for the agent).
--  - settled_at: nothing more is owed on the call. An unbridged call settles as it ends (nobody
--    spoke to the caller, so no outcome is owed); a bridged one when its outcome is saved or
--    lapses (`no_disposition`, 30 min). Backfilled: every row 0024 ended is settled at its end
--    (P1 connected nobody, so none owes an outcome).
--  - voicemail_seconds: the length of the voicemail at voicemail_key.
--  - clash_attempt_id: the still-ringing outbound attempt this call cancelled (§5.4); no FK.
--
-- ── CHECKs ────────────────────────────────────────────────────────────────────
--  - ck_agency_inbound_calls_session: an `offered` or `connected` call has its session, its offer
--    time and at least one offer; an `arrived`, `greeting` or `queued` one has no session (a
--    requeue clears it, so the one-unsettled-per-session index below never holds a queued call
--    against an agent); offer_count is never negative.
--  - ck_agency_inbound_calls_settled: settled only once ended; an ended call that was offered to a
--    session but never bridged is settled (the UPDATE that ends it settles it, so the session is
--    free again: the unique index below would otherwise hold it for ever). A sessionless ended row
--    is not constrained: nothing reads its settlement (P1's writers, and their tests, predate it).
--  - ck_agency_inbound_calls_disposition: an outcome only on a bridged call, with its source and
--    time; the source only with a code, `campaign` exactly when the call matched a campaign (the
--    soft phone's ck_agency_manual_call_disposition_source rule); who saved it, and on behalf,
--    only with a code.
--  - ck_agency_inbound_calls_voicemail: a voicemail's length only with the voicemail, never
--    negative.
--
-- ── Indexes ───────────────────────────────────────────────────────────────────
--  - uq_agency_inbound_calls_session_unsettled (session_id) WHERE session_id IS NOT NULL AND
--    settled_at IS NULL: ONE unsettled inbound call per agent session (offered, connected, or
--    ended with its outcome owed), the soft phone's uq_agency_manual_call_unsettled rule. Also the
--    session's own read (`findUnsettledForSession`) and the supervisor floor's marker.
--  - idx_agency_inbound_calls_live_from_digits (tenant_id, account_id, <digits of from_e164>)
--    WHERE the call is admitted and live (`arrived` is "not admitted", 0026's rule: a call refused
--    at the cap holds no line) or bridged and unsettled: the inbound arm of the account's busy probe
--    (`numberLiveSql`, MC4, §5.4) and the soft phone's pre-dial. The key expression is
--    CONTACT_PHONE_DIGITS_SQL (apps/server/src/db/repositories/agency/sql-fragments.ts) byte for
--    byte with the column swapped, and the probe repeats the predicate literally, so the planner
--    proves the partial index applies. Partial, so it stays the size of the floor.
--  - idx_agency_inbound_calls_unsettled_lapse (ended_at) WHERE bridged_at IS NOT NULL AND
--    settled_at IS NULL: the outcome-lapse sweep, by age, over the owed outcomes only.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Every change is to agency_inbound_calls, which is small (one row per inbound call; P1's
-- history only). The columns are catalog-only (no default, or a constant one); the two backfills
-- and the CHECKs' validation scan it once under this file's ACCESS EXCLUSIVE, which is why the
-- CHECKs are added validated rather than NOT VALID plus a VALIDATE: in one transaction the split
-- (0009 / 0010's) would hold the same lock for the same scan. The leg backfill reads agency_calls
-- by primary key, one probe per inbound row. The backfills keep `updated_at` (the trigger is
-- disabled around them): settling P1's rows is not a change anyone made. Migrations run at
-- container start, before the server listens.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Refuses, before changing anything, while any call is offered or connected or owes its outcome,
-- or carries an outcome, notes or a callback an agent wrote: dropping them loses what the agent
-- recorded, and a later up would settle an owed outcome nobody wrote. Otherwise drops the indexes,
-- the CHECKs and the columns.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_inbound_calls
  ADD COLUMN session_id               UUID,
  ADD COLUMN queued_at                TIMESTAMPTZ,
  ADD COLUMN offered_at               TIMESTAMPTZ,
  ADD COLUMN offer_count              SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN recording_requested      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN disposition_code         VARCHAR(64),
  ADD COLUMN disposition_source       VARCHAR(16),
  ADD COLUMN notes                    TEXT,
  ADD COLUMN callback_at              TIMESTAMPTZ,
  ADD COLUMN dispositioned_by_user_id UUID,
  ADD COLUMN dispositioned_at         TIMESTAMPTZ,
  ADD COLUMN dispositioned_on_behalf  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN settled_at               TIMESTAMPTZ,
  ADD COLUMN voicemail_seconds        INTEGER,
  ADD COLUMN clash_attempt_id         UUID;

ALTER TABLE agency_inbound_calls DISABLE TRIGGER trg_agency_inbound_calls_updated_at;
UPDATE agency_inbound_calls SET settled_at = ended_at WHERE state = 'ended';
UPDATE agency_inbound_calls c
   SET recording_requested = true
  FROM agency_calls l
 WHERE l.id = c.webrtc_call_id AND l.recording_requested;
ALTER TABLE agency_inbound_calls ENABLE TRIGGER trg_agency_inbound_calls_updated_at;

ALTER TABLE agency_inbound_calls
  ADD CONSTRAINT ck_agency_inbound_calls_session CHECK (
    offer_count >= 0
    AND (
      (state IN ('offered', 'connected') AND session_id IS NOT NULL AND offered_at IS NOT NULL AND offer_count > 0)
      OR (state IN ('arrived', 'greeting', 'queued') AND session_id IS NULL)
      OR state = 'ended'
    )
  ),
  ADD CONSTRAINT ck_agency_inbound_calls_settled CHECK (
    (settled_at IS NULL OR state = 'ended')
    AND (state <> 'ended' OR session_id IS NULL OR bridged_at IS NOT NULL OR settled_at IS NOT NULL)
  ),
  ADD CONSTRAINT ck_agency_inbound_calls_disposition CHECK (
    (disposition_code IS NULL
      OR (bridged_at IS NOT NULL AND disposition_code <> '' AND disposition_source IS NOT NULL AND dispositioned_at IS NOT NULL))
    AND (disposition_source IS NULL
      OR (disposition_code IS NOT NULL
          AND disposition_source IN ('campaign', 'route')
          AND (disposition_source = 'campaign') = (matched_campaign_id IS NOT NULL)))
    AND (dispositioned_at IS NULL OR disposition_code IS NOT NULL)
    AND (dispositioned_by_user_id IS NULL OR disposition_code IS NOT NULL)
    AND (NOT dispositioned_on_behalf OR dispositioned_by_user_id IS NOT NULL)
  ),
  ADD CONSTRAINT ck_agency_inbound_calls_voicemail CHECK (
    voicemail_seconds IS NULL OR (voicemail_key IS NOT NULL AND voicemail_seconds >= 0)
  );

CREATE UNIQUE INDEX uq_agency_inbound_calls_session_unsettled
  ON agency_inbound_calls (session_id)
  WHERE session_id IS NOT NULL AND settled_at IS NULL;

COMMENT ON INDEX uq_agency_inbound_calls_session_unsettled IS
  'One unsettled inbound call per agent session (offered, connected, or ended with its outcome owed): the soft phone''s uq_agency_manual_call_unsettled rule.';

CREATE INDEX idx_agency_inbound_calls_live_from_digits
  ON agency_inbound_calls (tenant_id, account_id, regexp_replace(from_e164, '[^0-9]', '', 'g'))
  WHERE from_e164 IS NOT NULL
    AND ((state <> 'ended' AND state <> 'arrived') OR (bridged_at IS NOT NULL AND settled_at IS NULL));

COMMENT ON INDEX idx_agency_inbound_calls_live_from_digits IS
  'MC4, §5.4: a number with a live (or bridged, unsettled) inbound call is busy for the account: the inbound arm of numberLiveSql and the soft phone''s pre-dial. Key expression = CONTACT_PHONE_DIGITS_SQL on from_e164.';

CREATE INDEX idx_agency_inbound_calls_unsettled_lapse
  ON agency_inbound_calls (ended_at)
  WHERE bridged_at IS NOT NULL AND settled_at IS NULL;

COMMENT ON INDEX idx_agency_inbound_calls_unsettled_lapse IS
  'The outcome-lapse sweep: bridged inbound calls whose outcome is still owed, oldest end first.';

COMMENT ON COLUMN agency_inbound_calls.session_id IS
  'The agent session the call is offered to or connected with; cleared by a requeue. No FK.';
COMMENT ON COLUMN agency_inbound_calls.settled_at IS
  'Nothing more is owed: an unbridged call settles as it ends; a bridged one when its outcome is saved or lapses.';

-- Down Migration

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agency_inbound_calls
     WHERE (session_id IS NOT NULL AND settled_at IS NULL)
        OR disposition_code IS NOT NULL OR notes IS NOT NULL OR callback_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0027_inbound_connect down: inbound calls are with agents, owe their outcome, or carry an outcome, notes or a callback an agent wrote; settle or delete them deliberately before rolling back';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_agency_inbound_calls_unsettled_lapse;
DROP INDEX IF EXISTS idx_agency_inbound_calls_live_from_digits;
DROP INDEX IF EXISTS uq_agency_inbound_calls_session_unsettled;

ALTER TABLE agency_inbound_calls
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_voicemail,
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_disposition,
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_settled,
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_session,
  DROP COLUMN IF EXISTS clash_attempt_id,
  DROP COLUMN IF EXISTS voicemail_seconds,
  DROP COLUMN IF EXISTS settled_at,
  DROP COLUMN IF EXISTS dispositioned_on_behalf,
  DROP COLUMN IF EXISTS dispositioned_at,
  DROP COLUMN IF EXISTS dispositioned_by_user_id,
  DROP COLUMN IF EXISTS callback_at,
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS disposition_source,
  DROP COLUMN IF EXISTS disposition_code,
  DROP COLUMN IF EXISTS recording_requested,
  DROP COLUMN IF EXISTS offer_count,
  DROP COLUMN IF EXISTS offered_at,
  DROP COLUMN IF EXISTS queued_at,
  DROP COLUMN IF EXISTS session_id;
