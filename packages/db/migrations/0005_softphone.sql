-- 0005_softphone.sql — the soft phone: an agent dials a typed number outside pacing.
--
-- docs/softphone.md §3 is the design; its rulings SP1–SP7 are Manas's of 2026-10-30
-- (docs/decisions.md, "Soft phone"). Four changes:
--
--   1. agency_agent_sessions gains `kind` (campaign | softphone) and its campaign_id
--      becomes nullable: a soft-phone session belongs to no campaign. The session-event
--      copy of campaign_id follows.
--   2. agency_manual_calls: one row per soft-phone dial. Never agency_contacts or
--      agency_call_attempts, so retries, roster completion, per-campaign pacing headroom
--      and the abandonment predicate cannot read a manual call by accident.
--   3. agency_calls gains `origin` (campaign | manual) and `manual_call_id`, the media
--      leg's correlation to (2). A manual leg keeps campaign_id NULL, so no campaign
--      aggregation over agency_calls counts it.
--   4. agency_softphone_settings: one optional row per account, for untagged calls.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- The ALTERs take ACCESS EXCLUSIVE on agency_agent_sessions, agency_agent_session_events
-- and agency_calls for the duration. Adding a column with a constant DEFAULT does not
-- rewrite the table (PG 11+); DROP NOT NULL is catalog-only; each new CHECK scans its
-- table once to validate. Migrations run at container start, before the server listens
-- (docker/entrypoint.sh), so nothing is writing these tables meanwhile. The new indexes
-- are on empty tables, or partial on a column every existing row has NULL.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down
-- marker comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- ── 1. Sessions ───────────────────────────────────────────────────────────────

-- `kind` decides whether the session has a campaign, in both directions: a campaign
-- session always names one (pacing, staffing and the supervisor's floor key on it), and
-- a soft-phone session never does. The campaign FK stays (ON DELETE CASCADE); a NULL
-- simply has nothing to cascade from.
--
-- A soft-phone session lives in `break` with the reserved reason `soft_phone` and is
-- created there; it can never be `available`, so pacing can never reserve it, by
-- construction (docs/softphone.md §2). The state CHECK is that rule in the database: a
-- campaign path that tried to make one available, reserved or on a campaign call fails
-- here rather than dialling into it. `offline` is what leaving writes.
ALTER TABLE agency_agent_sessions
  ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'campaign',
  ALTER COLUMN campaign_id DROP NOT NULL,
  ADD CONSTRAINT ck_agency_agent_session_kind CHECK (kind IN ('campaign', 'softphone')),
  ADD CONSTRAINT ck_agency_agent_session_kind_campaign
    CHECK ((kind = 'campaign') = (campaign_id IS NOT NULL)),
  ADD CONSTRAINT ck_agency_agent_session_softphone_state
    CHECK (kind = 'campaign' OR state IN ('break', 'offline'));

-- Denormalised from the session, so it is NULL exactly when the session's is. Occupancy
-- keys on agent_user_id, not campaign_id, so soft-phone time is reported as one more
-- break reason with no change to the read (§2).
ALTER TABLE agency_agent_session_events
  ALTER COLUMN campaign_id DROP NOT NULL;

COMMENT ON COLUMN agency_agent_sessions.kind IS
  'campaign: a session on campaign_id. softphone: an agent on no campaign using the soft phone; campaign_id is NULL and the session stays in break/soft_phone (docs/softphone.md).';

-- ── 2. Manual calls ───────────────────────────────────────────────────────────

-- One row per soft-phone dial: the soft phone's audit spine, as agency_call_attempts is
-- the campaign's. Pre-dial overrides (SP1 DNC, SP2 calling hours) are recorded here with
-- the agent's note, so a row must outlive everything it points at:
--
--   - `session_id` has a foreign key with no cascade, like
--     agency_call_attempts.reserved_agent_id: a session is never deleted, and if one ever
--     were, its calls must stop the delete rather than vanish with it.
--   - `campaign_id` (the tag), `contact_id` (the roster match), `webrtc_call_id` (the media
--     leg), `analysis_profile_id` and `dnc_override_entry_id` have NO foreign keys, the
--     same choice as the attempt spine: each side purges or is deleted on its own clock,
--     and a cascade either way would destroy the other side's record.
CREATE TABLE agency_manual_calls (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  account_id               UUID NOT NULL,
  session_id               UUID NOT NULL REFERENCES agency_agent_sessions(id),
  agent_user_id            UUID NOT NULL,   -- the user id, opaque to the dialer runtime

  -- The campaign the call is logged to (a tag, chosen before Call and fixed for the
  -- call). NULL = untagged.
  campaign_id              UUID,
  -- The roster contact the number matched on the tag. `contact_claimed`: this call moved
  -- it pending → in_flight, so its outcome settles it (SP6, §5); a contact in any other
  -- state is linked only. `contact_prior_state` is what lapse and restart release a claim
  -- back to.
  contact_id               UUID,
  contact_claimed          BOOLEAN NOT NULL DEFAULT false,
  contact_prior_state      VARCHAR(20),

  -- The media leg (agency_calls.id). NULL until the dial is placed.
  webrtc_call_id           UUID,
  destination_e164         VARCHAR(20) NOT NULL,
  caller_id                VARCHAR(20) NOT NULL,

  -- queued → dialing → ringing → answered → bridged → ended (the attempt lifecycle)
  state                    VARCHAR(20) NOT NULL DEFAULT 'queued',
  outcome                  VARCHAR(30),
  end_reason               VARCHAR(30),

  -- The outcome the agent saved, and which catalog it was resolved against: the tag's,
  -- or the soft phone's own (settings, else built-in) for an untagged call.
  disposition_code         VARCHAR(50),
  disposition_source       VARCHAR(16),
  notes                    TEXT,
  callback_at              TIMESTAMPTZ,
  -- The call details the agent entered, keyed by agency_softphone_settings.call_fields
  -- keys and validated against that set when saved.
  fields                   JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Fixed at dial, like the same two columns on agency_calls.
  recording_requested      BOOLEAN NOT NULL DEFAULT false,
  analysis_profile_id      UUID,

  -- SP1 / SP2: the agent's reason for dialling through a refusal. A DNC override names
  -- the entry it overrode; who overrode it is agent_user_id.
  dnc_override_note        TEXT,
  dnc_override_entry_id    UUID,
  hours_override_note      TEXT,

  dialed_at                TIMESTAMPTZ,
  answered_at              TIMESTAMPTZ,
  bridged_at               TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  talk_seconds             INTEGER,

  -- Who saved the outcome, separately from who placed the call (a supervisor may, on
  -- behalf).
  dispositioned_by_user_id UUID,
  dispositioned_at         TIMESTAMPTZ,
  dispositioned_on_behalf  BOOLEAN NOT NULL DEFAULT false,

  -- Outcome saved, lapsed (reaper, `no_disposition`), or an unanswered call closed with
  -- no outcome owed. NULL = live, or ended and awaiting its outcome.
  settled_at               TIMESTAMPTZ,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The vocabularies are the contract's lists in packages/contracts/src/agency/softphone.ts
  -- (AGENCY_MANUAL_CALL_STATES / _OUTCOMES / _END_REASONS / _DISPOSITION_SOURCES);
  -- test/integration/db/softphone-migration.test.ts pins each CHECK to its list. Unlike
  -- agency_call_attempts.outcome, these are CHECKed: the table is new, so there is no
  -- history of unlisted values to tolerate.
  CONSTRAINT ck_agency_manual_call_state CHECK (state IN
    ('queued','dialing','ringing','answered','bridged','ended')),
  CONSTRAINT ck_agency_manual_call_outcome CHECK (outcome IS NULL OR outcome IN
    ('connected','no_answer','busy','failed','machine','invalid','abandoned',
     'agent_disconnected','orphaned','canceled')),
  CONSTRAINT ck_agency_manual_call_end_reason CHECK (end_reason IS NULL OR end_reason IN
    ('completed','no_answer','busy','failed','invalid','agent_disconnected',
     'agent_hangup','remote_hangup','supervisor_released','orphaned')),
  -- `campaign` only on a tagged call, `softphone` only on an untagged one.
  CONSTRAINT ck_agency_manual_call_disposition_source CHECK (
    disposition_source IS NULL
    OR (disposition_source IN ('campaign', 'softphone')
        AND (disposition_source = 'campaign') = (campaign_id IS NOT NULL))
  ),
  CONSTRAINT ck_agency_manual_call_contact_prior_state CHECK (contact_prior_state IS NULL OR
    contact_prior_state IN ('pending','in_flight','connected','completed','exhausted','suppressed')),
  -- A roster match exists only on a tag, and a claim needs a contact and the state to
  -- release it to.
  CONSTRAINT ck_agency_manual_call_contact CHECK (
    (contact_id IS NULL OR campaign_id IS NOT NULL)
    AND (NOT contact_claimed OR (contact_id IS NOT NULL AND contact_prior_state IS NOT NULL))
  ),
  CONSTRAINT ck_agency_manual_call_fields CHECK (jsonb_typeof(fields) = 'object'),
  -- SOFTPHONE_OVERRIDE_NOTE_MIN / _MAX, after trimming: "ok" is not a reason.
  CONSTRAINT ck_agency_manual_call_dnc_override CHECK (
    (dnc_override_note IS NULL) = (dnc_override_entry_id IS NULL)
    AND (dnc_override_note IS NULL OR char_length(btrim(dnc_override_note)) BETWEEN 10 AND 500)
  ),
  CONSTRAINT ck_agency_manual_call_hours_override CHECK (
    hours_override_note IS NULL OR char_length(btrim(hours_override_note)) BETWEEN 10 AND 500
  ),
  CONSTRAINT ck_agency_manual_call_ended CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
  CONSTRAINT ck_agency_manual_call_settled CHECK (settled_at IS NULL OR state = 'ended'),
  CONSTRAINT ck_agency_manual_call_talk_seconds CHECK (talk_seconds IS NULL OR talk_seconds >= 0)
);

-- ONE unsettled call per session: it covers a live call and an ended one still awaiting
-- its outcome, so an agent cannot dial again before saving the last outcome, whatever
-- the Redis claim (§4.1 step 1) believes. The correctness backstop, as
-- uq_agency_attempt_live is for campaign dials. The lapse sweep reads it too: every
-- unsettled row is in it.
CREATE UNIQUE INDEX uq_agency_manual_call_unsettled
  ON agency_manual_calls (session_id)
  WHERE settled_at IS NULL;

-- The agent's own list ("My calls"), keyset on (created_at DESC, id DESC).
CREATE INDEX idx_agency_manual_calls_agent
  ON agency_manual_calls (tenant_id, account_id, agent_user_id, created_at DESC, id DESC);

-- The supervisor's account list, the same keyset.
CREATE INDEX idx_agency_manual_calls_account
  ON agency_manual_calls (tenant_id, account_id, created_at DESC, id DESC);

-- Live manual calls per account: pacing headroom subtracts them from the account's
-- concurrency on every tick (countLiveForAccount, §4.1), and the reapers sweep them.
-- Predicate as idx_agency_attempts_live's, so a `state <> 'ended'` query is provably
-- covered.
CREATE INDEX idx_agency_manual_calls_live
  ON agency_manual_calls (account_id)
  WHERE state <> 'ended';

-- A campaign's manual calls (the campaign page's list).
CREATE INDEX idx_agency_manual_calls_campaign
  ON agency_manual_calls (campaign_id, created_at DESC)
  WHERE campaign_id IS NOT NULL;

-- "Does this contact have a live or unsettled manual call": the stranded-contact sweep
-- must not release a contact a manual call holds (§5), and the pre-dial roster match
-- asks the same. Partial on unsettled, so it stays the size of the live floor.
CREATE INDEX idx_agency_manual_calls_contact
  ON agency_manual_calls (contact_id)
  WHERE contact_id IS NOT NULL AND settled_at IS NULL;

-- Bridge lifecycle → manual call (a carrier event carries the call id).
CREATE INDEX idx_agency_manual_calls_webrtc
  ON agency_manual_calls (webrtc_call_id)
  WHERE webrtc_call_id IS NOT NULL;

CREATE TRIGGER trg_agency_manual_calls_updated_at
  BEFORE UPDATE ON agency_manual_calls
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agency_manual_calls IS
  'One row per soft-phone dial (docs/softphone.md). Never read by retries, roster completion, per-campaign pacing or the abandonment predicate. uq_agency_manual_call_unsettled is the one-call-per-session backstop.';
COMMENT ON COLUMN agency_manual_calls.campaign_id IS
  'The campaign the call is logged to (a tag: caller IDs, catalog, recording, profile). No FK. The media leg''s agency_calls.campaign_id stays NULL.';
COMMENT ON COLUMN agency_manual_calls.contact_claimed IS
  'True when this call moved the matched contact pending -> in_flight, so its outcome settles the contact (SP6). Lapse and restart release the claim to contact_prior_state.';
COMMENT ON COLUMN agency_manual_calls.settled_at IS
  'Outcome saved, lapsed, or an unanswered call closed. NULL while live or awaiting the outcome; the session cannot dial again until it is set.';
COMMENT ON COLUMN agency_manual_calls.dnc_override_note IS
  'SP1: the agent''s reason for dialling a DNC-listed number, with the entry overridden in dnc_override_entry_id. Audited as agency_manual_call.dnc_overridden.';
COMMENT ON COLUMN agency_manual_calls.hours_override_note IS
  'SP2: the agent''s reason for dialling outside the tagged campaign''s calling window. Audited as agency_manual_call.hours_overridden.';

-- ── 3. The media leg ──────────────────────────────────────────────────────────

-- `origin` says which spine a leg belongs to. A manual leg has campaign_id and
-- agency_attempt_id NULL, so no campaign aggregation over agency_calls counts it, and
-- `manual_call_id` is its correlation (no FK, like agency_attempt_id). It is still an
-- agency call: it sits in the agency call scope and is metered at the agency rate (SP5).
ALTER TABLE agency_calls
  ADD COLUMN origin VARCHAR(16) NOT NULL DEFAULT 'campaign',
  ADD COLUMN manual_call_id UUID,
  ADD CONSTRAINT ck_agency_calls_origin CHECK (origin IN ('campaign', 'manual')),
  ADD CONSTRAINT ck_agency_calls_manual_correlation CHECK (
    (origin = 'manual') = (manual_call_id IS NOT NULL)
    AND (origin = 'campaign' OR (campaign_id IS NULL AND agency_attempt_id IS NULL))
  );

CREATE INDEX idx_agency_calls_manual_call
  ON agency_calls (manual_call_id)
  WHERE manual_call_id IS NOT NULL;

COMMENT ON COLUMN agency_calls.origin IS
  'campaign: placed by pacing for an agency_call_attempts row (agency_attempt_id). manual: a soft-phone dial (manual_call_id); campaign_id stays NULL. Both are agency calls (SP5).';
COMMENT ON COLUMN agency_calls.manual_call_id IS
  'agency_manual_calls.id this media leg was placed for. Correlation only, no FK: both sides purge independently.';

-- ── 4. Soft-phone settings ────────────────────────────────────────────────────

-- One row per account, all optional: an account with no row reads as the defaults.
-- Applies to untagged calls, except call_fields, which apply to every call. No FK to
-- tenants/accounts, as account_settings has none (BASELINE.md, open question 2).
CREATE TABLE agency_softphone_settings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  account_id           UUID NOT NULL,
  -- [{code,label,...}] as agency_campaigns.disposition_catalog. '[]' = the built-in
  -- catalog (AGENCY_DEFAULT_DISPOSITION_CATALOG), never "no outcomes".
  disposition_catalog  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{key,label,type,options?,required?}], at most 20 (SOFTPHONE_CALL_FIELDS_MAX). '[]' = none.
  call_fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
  analysis_profile_id  UUID,              -- NULL = the account default; no FK, as on campaigns
  record_calls         BOOLEAN NOT NULL DEFAULT false,
  default_caller_id    VARCHAR(20),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_agency_softphone_settings_account UNIQUE (tenant_id, account_id),
  -- The same guard disposition_catalog and break_reasons carry on agency_campaigns: a
  -- `{}` or a bare string is valid JSONB, and every reader would 500 on an array method.
  CONSTRAINT ck_agency_softphone_settings_dispositions CHECK (jsonb_typeof(disposition_catalog) = 'array'),
  CONSTRAINT ck_agency_softphone_settings_call_fields CHECK (
    jsonb_typeof(call_fields) = 'array' AND jsonb_array_length(call_fields) <= 20
  )
);

CREATE TRIGGER trg_agency_softphone_settings_updated_at
  BEFORE UPDATE ON agency_softphone_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agency_softphone_settings IS
  'Per-account soft-phone settings (docs/softphone.md §3): the untagged outcome catalog, call fields for every call, untagged recording, profile and default caller ID. No row = defaults.';

-- Down Migration

-- Reverting campaign_id to NOT NULL cannot keep a soft-phone session, and deleting them
-- would delete the manual calls' sessions and their audit trail with them. So this
-- refuses, loudly and before changing anything, while one exists: an operator who
-- really means to roll back deletes those rows deliberately first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agency_agent_sessions WHERE campaign_id IS NULL)
     OR EXISTS (SELECT 1 FROM agency_agent_session_events WHERE campaign_id IS NULL) THEN
    RAISE EXCEPTION '0005_softphone down: soft-phone sessions exist (agency_agent_sessions or agency_agent_session_events with campaign_id NULL); delete them deliberately before rolling back';
  END IF;
END $$;

DROP TABLE IF EXISTS agency_softphone_settings;

DROP INDEX IF EXISTS idx_agency_calls_manual_call;
ALTER TABLE agency_calls
  DROP CONSTRAINT IF EXISTS ck_agency_calls_manual_correlation,
  DROP CONSTRAINT IF EXISTS ck_agency_calls_origin,
  DROP COLUMN IF EXISTS manual_call_id,
  DROP COLUMN IF EXISTS origin;

DROP TABLE IF EXISTS agency_manual_calls;

ALTER TABLE agency_agent_session_events
  ALTER COLUMN campaign_id SET NOT NULL;

ALTER TABLE agency_agent_sessions
  DROP CONSTRAINT IF EXISTS ck_agency_agent_session_softphone_state,
  DROP CONSTRAINT IF EXISTS ck_agency_agent_session_kind_campaign,
  DROP CONSTRAINT IF EXISTS ck_agency_agent_session_kind,
  DROP COLUMN IF EXISTS kind,
  ALTER COLUMN campaign_id SET NOT NULL;
