-- 0024_inbound.sql — inbound calls on Plivo numbers: routes, the inbound spine, inbound
-- callbacks on contacts, and the credential's and numbers' inbound state (docs/inbound.md §9,
-- decisions IB1–IB8). Everything P1 and the spine need; P2 adds what connecting agents needs.
--
-- ── New tables ────────────────────────────────────────────────────────────────
--  - agency_inbound_routes: an account's inbound route (§8.1): hours in its timezone, holidays,
--    clips, sticky routing, the agent pool, queue limits, what a call that reaches nobody gets,
--    recording and outcomes. Soft-deleted (`deleted_at`): the spine names routes for ever.
--  - agency_inbound_route_numbers: which route answers a number. One ACTIVE row per number
--    (`uq_agency_inbound_route_numbers_active`); a detached row is kept with when, by whom and
--    why (`detached_reason`), so "why does this number not ring through any more" has an answer.
--  - agency_inbound_calls: the inbound spine, one row per call that reached the answer webhook,
--    as agency_manual_calls is the soft phone's. It is also the Missed inbound row (§7): a call
--    that reached nobody carries `follow_up_status`, its reason, assignee and who handled it.
--
-- ── Changed tables ────────────────────────────────────────────────────────────
--  - agency_calls: `origin` gains `inbound`, with `inbound_call_id` the correlation to the spine
--    (no FK, like manual_call_id). ck_agency_calls_origin is rewritten (the value list).
--    ck_agency_calls_manual_correlation is NOT rewritten, deliberately: its two arms already say
--    the right thing for an inbound leg (no manual_call_id; campaign_id and agency_attempt_id
--    NULL, since origin <> 'campaign'), so an inbound leg can never be counted by a campaign
--    aggregation. ck_agency_calls_inbound_correlation is new: inbound_call_id exactly on an
--    inbound leg. idx_agency_calls_provider_call_id (baseline) already serves the status
--    webhook's CallUUID lookup, so no index is added.
--  - agency_contacts: `callback_source` (`inbound`) and `callback_due_at`: a callback no
--    disposition booked (§7, IB4). isCallbackSql reads a callback from the last disposition
--    today; widening it to `callback_source IS NOT NULL OR …` is the inbound follow-up's change.
--  - agency_campaigns: `inbound_sticky_enabled` (default true): a campaign may opt out of being
--    a sticky-routing signal (§4.1).
--  - telephony_credentials: the inbound Plivo Application (`inbound_app_id`), the URLs it was
--    given (answer, hangup, fallback answer; signatures are verified against these, never
--    rebuilt from env, §3.1), and the inbound token as sha256 hex only (the membership invite
--    rule: the raw token lives only in the URLs handed to Plivo, never in this database), with
--    the previous token's hash kept until `inbound_previous_token_expires_at` so a Re-point
--    does not refuse the hangup callbacks of calls answered before it.
--  - phone_numbers: `inbound_linked_at` (the number is linked to its credential's inbound
--    Application; NULL = not linked) and `inbound_previous_app_id` (the Plivo app it pointed at
--    before, restored by Unlink; NULL = none).
--
-- ── FKs ───────────────────────────────────────────────────────────────────────
--  - Routes: tenant ON DELETE CASCADE (configuration dies with its tenant, as 0018's and 0023's);
--    account_id has no FK, as agency_campaigns.account_id. Clips → audio_files ON DELETE SET
--    NULL: deleting a clip puts the slot back on the built-in clip rather than refusing the
--    delete or breaking the route.
--  - Route numbers: route ON DELETE CASCADE; phone_number RESTRICT (numbers are never
--    hard-deleted, only retired; the key proves a routed number exists).
--  - Spine: no FK on tenant, account, route, number, contact, campaign or media leg: it is an
--    audit spine, and each side purges or is deleted on its own clock (agency_manual_calls'
--    rule). The one FK is the credential's composite (credential, tenant, provider) → RESTRICT,
--    as agency_calls': Postgres refuses a call pinned to another tenant's or provider's
--    credential, and credentials are never deleted.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- 0009's rule: no work that grows with agency_contacts or agency_calls under this file's
-- ACCESS EXCLUSIVE. Their new columns have no default (catalog only) and their CHECKs are added
-- NOT VALID (enforced on every write from here on, existing rows not scanned); 0025 validates
-- them in its own transaction under SHARE UPDATE EXCLUSIVE. Every existing row satisfies them:
-- the new columns are NULL on all of them, and the rewritten origin CHECK is wider than the one
-- it replaces. agency_campaigns, telephony_credentials and phone_numbers are small: their CHECKs
-- are validated here. Migrations run at container start, before the server listens.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- ── 1. Routes ─────────────────────────────────────────────────────────────────

CREATE TABLE agency_inbound_routes (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id                 UUID NOT NULL,
  name                       VARCHAR(100) NOT NULL,
  -- Validated as a usable IANA zone by the server (`isUsableTimezone`); here only trimmed.
  timezone                   TEXT NOT NULL,
  -- [{day, start, end}] and [{from, to, label}] (contract: AgencyInboundHoursInterval,
  -- AgencyInboundHoliday). Elements are the server's to validate; the shape and size are here.
  weekly_hours               JSONB NOT NULL DEFAULT '[]'::jsonb,
  holidays                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- AGENCY_INBOUND_CLIP_SLOTS. NULL: the built-in clip.
  greeting_audio_id          UUID REFERENCES audio_files(id) ON DELETE SET NULL,
  hold_audio_id              UUID REFERENCES audio_files(id) ON DELETE SET NULL,
  closed_audio_id            UUID REFERENCES audio_files(id) ON DELETE SET NULL,
  busy_audio_id              UUID REFERENCES audio_files(id) ON DELETE SET NULL,
  recording_notice_audio_id  UUID REFERENCES audio_files(id) ON DELETE SET NULL,
  callback_audio_id          UUID REFERENCES audio_files(id) ON DELETE SET NULL,
  sticky_mode                VARCHAR(8) NOT NULL DEFAULT 'loose',
  sticky_wait_seconds        SMALLINT NOT NULL DEFAULT 30,
  sticky_lookback_days       SMALLINT NOT NULL DEFAULT 30,
  -- Empty: every live campaign session in the account (§5.1). No FK, as staffing's campaign_id.
  pool_campaign_ids          UUID[] NOT NULL DEFAULT '{}',
  queue_max_wait_seconds     SMALLINT NOT NULL DEFAULT 120,
  max_waiting                SMALLINT NOT NULL DEFAULT 10,
  max_concurrent             SMALLINT NOT NULL DEFAULT 20,
  after_hours_action         VARCHAR(16) NOT NULL DEFAULT 'callback',
  overflow_action            VARCHAR(16) NOT NULL DEFAULT 'callback',
  record_calls               BOOLEAN NOT NULL DEFAULT false,
  recording_notice           BOOLEAN NOT NULL DEFAULT true,
  analysis_profile_id        UUID,               -- NULL = the account default; no FK, as on campaigns
  -- [{code,label,...}] as agency_campaigns.disposition_catalog; '[]' = the built-in catalog.
  disposition_catalog        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- User ids with no FK, as the agency tables' actor columns: the record outlives the user.
  created_by                 UUID,
  updated_by                 UUID,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                 TIMESTAMPTZ,
  deleted_by                 UUID,

  -- AGENCY_INBOUND_ROUTE_LIMITS (packages/contracts/src/agency/inbound.ts).
  CONSTRAINT ck_agency_inbound_routes_name CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 100 AND name = btrim(name)
  ),
  CONSTRAINT ck_agency_inbound_routes_timezone CHECK (timezone <> '' AND timezone = btrim(timezone)),
  CONSTRAINT ck_agency_inbound_routes_hours CHECK (
    jsonb_typeof(weekly_hours) = 'array' AND jsonb_array_length(weekly_hours) <= 50
  ),
  CONSTRAINT ck_agency_inbound_routes_holidays CHECK (
    jsonb_typeof(holidays) = 'array' AND jsonb_array_length(holidays) <= 100
  ),
  CONSTRAINT ck_agency_inbound_routes_sticky_mode CHECK (sticky_mode IN ('off', 'loose', 'strict')),
  CONSTRAINT ck_agency_inbound_routes_sticky CHECK (
    sticky_wait_seconds BETWEEN 5 AND 300
    AND sticky_lookback_days BETWEEN 1 AND 365
    AND sticky_wait_seconds <= queue_max_wait_seconds
  ),
  CONSTRAINT ck_agency_inbound_routes_pool CHECK (cardinality(pool_campaign_ids) <= 50),
  CONSTRAINT ck_agency_inbound_routes_queue CHECK (
    queue_max_wait_seconds BETWEEN 10 AND 1800
    AND max_waiting BETWEEN 0 AND 100
    AND max_concurrent BETWEEN 1 AND 500
    AND max_waiting <= max_concurrent
  ),
  CONSTRAINT ck_agency_inbound_routes_actions CHECK (
    after_hours_action IN ('callback', 'voicemail') AND overflow_action IN ('callback', 'voicemail')
  ),
  CONSTRAINT ck_agency_inbound_routes_dispositions CHECK (jsonb_typeof(disposition_catalog) = 'array'),
  CONSTRAINT ck_agency_inbound_routes_deleted CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL)
);

-- One live route per name in an account; a deleted route frees its name.
CREATE UNIQUE INDEX uq_agency_inbound_routes_name
  ON agency_inbound_routes (tenant_id, account_id, lower(name))
  WHERE deleted_at IS NULL;

-- The account's routes (the console list), live ones only.
CREATE INDEX idx_agency_inbound_routes_account
  ON agency_inbound_routes (tenant_id, account_id, created_at)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_agency_inbound_routes_updated_at
  BEFORE UPDATE ON agency_inbound_routes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agency_inbound_routes IS
  'An account''s inbound route (docs/inbound.md §8.1): hours, holidays and clips in its timezone, sticky routing, pool, queue limits, unconnected actions, recording, outcomes. Soft-deleted.';
COMMENT ON COLUMN agency_inbound_routes.weekly_hours IS
  '[{day: 1-7 ISO, start: HH:MM, end: HH:MM|24:00}]; end < start runs overnight and belongs to the day it opens. Empty: never open.';
COMMENT ON COLUMN agency_inbound_routes.holidays IS
  '[{from, to: YYYY-MM-DD inclusive, label}]: closed all day; a stretch that opens on a holiday does not run.';

CREATE TABLE agency_inbound_route_numbers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id         UUID NOT NULL REFERENCES agency_inbound_routes(id) ON DELETE CASCADE,
  phone_number_id  UUID NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
  attached_by      UUID,
  attached_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  detached_at      TIMESTAMPTZ,
  detached_by      UUID,
  -- detached: an account admin took it off the route; route_deleted: the route was deleted;
  -- number_unlinked: the §8.2 cascade (unlinked from inbound, untagged from the account,
  -- unassigned from the tenant, retired by a sync, or its credential disabled or revoked).
  detached_reason  VARCHAR(24),
  CONSTRAINT ck_agency_inbound_route_numbers_detached CHECK (
    (detached_at IS NULL) = (detached_reason IS NULL)
    AND (detached_reason IS NULL OR detached_reason IN ('detached', 'route_deleted', 'number_unlinked'))
    AND (detached_by IS NULL OR detached_at IS NOT NULL)
  )
);

-- THE invariant: one route answers a number. Also the answer webhook's lookup by number.
CREATE UNIQUE INDEX uq_agency_inbound_route_numbers_active
  ON agency_inbound_route_numbers (phone_number_id)
  WHERE detached_at IS NULL;

-- A route's live numbers (the route list, delete's cascade).
CREATE INDEX idx_agency_inbound_route_numbers_route
  ON agency_inbound_route_numbers (route_id)
  WHERE detached_at IS NULL;

COMMENT ON TABLE agency_inbound_route_numbers IS
  'Which inbound route answers a number: one active row per number (uq_agency_inbound_route_numbers_active); detached rows are kept with their reason.';

-- ── 2. The inbound spine ──────────────────────────────────────────────────────

CREATE TABLE agency_inbound_calls (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                    UUID NOT NULL,
  -- §8.3: the matched contact's account, else the number's route's. NULL: the tenant default
  -- (closed message, Missed row with no account, no media leg).
  account_id                   UUID,
  route_id                     UUID,
  -- The number rung (phone_numbers.id), as it was at arrival. to_e164 keeps the number itself.
  phone_number_id              UUID,
  provider                     VARCHAR(20) NOT NULL DEFAULT 'plivo',
  telephony_credential_id      UUID,
  -- The carrier's call id (Plivo CallUUID). Unique per provider: a retried answer webhook finds
  -- the row it already wrote instead of writing a second.
  provider_call_id             VARCHAR(100) NOT NULL,
  -- NULL: withheld or anonymous (a Missed row with no number, §7).
  from_e164                    VARCHAR(20),
  to_e164                      VARCHAR(20) NOT NULL,
  -- The roster contact the caller matched and its campaign (§4.1). No FKs.
  matched_contact_id           UUID,
  matched_campaign_id          UUID,
  -- The caller's number is on a DNC list (§7: flagged, never dialled automatically).
  caller_dnc                   BOOLEAN NOT NULL DEFAULT false,
  sticky_user_id               UUID,
  sticky_reason                VARCHAR(24),
  -- arrived → greeting → queued ⇄ offered → connected → ended (the repository's transition map).
  state                        VARCHAR(16) NOT NULL DEFAULT 'arrived',
  outcome                      VARCHAR(24),
  arrived_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When our answer XML answered it; NULL for a call refused with a hangup.
  answered_at                  TIMESTAMPTZ,
  -- An agent was bridged (P2): talk time and the recording start here, not at answer.
  bridged_at                   TIMESTAMPTZ,
  answered_by_user_id          UUID,
  ended_at                     TIMESTAMPTZ,
  talk_seconds                 INTEGER,
  -- The media leg (agency_calls.id, origin = 'inbound'). NULL with no account.
  webrtc_call_id               UUID,
  voicemail_key                TEXT,
  -- The callback booked on matched_contact_id by this call (its due time), if any.
  callback_due_at              TIMESTAMPTZ,
  -- The Missed inbound row (§7): set exactly on a call that ended reaching nobody.
  follow_up_status             VARCHAR(8),
  follow_up_reason             VARCHAR(24),
  -- The sticky agent, else NULL: the account (anyone with the Missed list).
  follow_up_assignee_user_id   UUID,
  handled_by_user_id           UUID,
  handled_at                   TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_agency_inbound_calls_telephony_credential
    FOREIGN KEY (telephony_credential_id, tenant_id, provider)
    REFERENCES telephony_credentials (id, tenant_id, provider)
    ON DELETE RESTRICT,

  -- The vocabularies are the contract's lists (packages/contracts/src/agency/inbound.ts);
  -- test/integration/db/inbound-migration.test.ts pins each CHECK to its list.
  CONSTRAINT ck_agency_inbound_calls_state CHECK (state IN
    ('arrived', 'greeting', 'queued', 'offered', 'connected', 'ended')),
  CONSTRAINT ck_agency_inbound_calls_outcome CHECK (outcome IS NULL OR outcome IN
    ('answered', 'abandoned_in_queue', 'overflow', 'overflow_no_capacity', 'closed', 'voicemail', 'rejected', 'failed')),
  CONSTRAINT ck_agency_inbound_calls_sticky CHECK (
    (sticky_user_id IS NULL) = (sticky_reason IS NULL)
    AND (sticky_reason IS NULL OR sticky_reason IN ('owner', 'last_from_number', 'last_connected', 'last_dialled'))
  ),
  CONSTRAINT ck_agency_inbound_calls_numbers CHECK (
    to_e164 ~ '^\+[1-9][0-9]{1,14}$' AND (from_e164 IS NULL OR from_e164 ~ '^\+[1-9][0-9]{1,14}$')
  ),
  CONSTRAINT ck_agency_inbound_calls_provider_call_id CHECK (provider_call_id <> '' AND provider_call_id = btrim(provider_call_id)),
  -- A route, a match and a media leg all belong to an account.
  CONSTRAINT ck_agency_inbound_calls_account CHECK (
    account_id IS NOT NULL OR (route_id IS NULL AND matched_contact_id IS NULL AND webrtc_call_id IS NULL)
  ),
  CONSTRAINT ck_agency_inbound_calls_match CHECK (
    (matched_contact_id IS NULL OR matched_campaign_id IS NOT NULL)
    AND (callback_due_at IS NULL OR matched_contact_id IS NOT NULL)
  ),
  -- Ended exactly when it has an outcome and an end time.
  CONSTRAINT ck_agency_inbound_calls_ended CHECK (
    (state = 'ended') = (ended_at IS NOT NULL) AND (state = 'ended') = (outcome IS NOT NULL)
  ),
  -- Bridged exactly with the agent who took it; connected, and answered, only once bridged.
  CONSTRAINT ck_agency_inbound_calls_bridged CHECK (
    (bridged_at IS NULL) = (answered_by_user_id IS NULL)
    AND (state <> 'connected' OR bridged_at IS NOT NULL)
    AND (outcome IS DISTINCT FROM 'answered' OR bridged_at IS NOT NULL)
  ),
  CONSTRAINT ck_agency_inbound_calls_talk_seconds CHECK (talk_seconds IS NULL OR talk_seconds >= 0),
  -- The Missed row: only on an ended call that reached nobody; status and reason together; the
  -- handler only once handled.
  CONSTRAINT ck_agency_inbound_calls_follow_up CHECK (
    (follow_up_status IS NULL) = (follow_up_reason IS NULL)
    AND (follow_up_status IS NULL OR follow_up_status IN ('open', 'handled'))
    AND (follow_up_reason IS NULL OR follow_up_reason IN
      ('closed', 'abandoned_in_queue', 'overflow', 'overflow_no_capacity', 'failed'))
    AND (follow_up_status IS NULL OR (state = 'ended' AND outcome NOT IN ('answered', 'rejected')))
    AND (follow_up_assignee_user_id IS NULL OR follow_up_status IS NOT NULL)
    AND (follow_up_status IS NOT DISTINCT FROM 'handled') = (handled_at IS NOT NULL)
    AND (handled_by_user_id IS NULL OR handled_at IS NOT NULL)
  )
);

-- A retried answer webhook, and the status webhook's lookup by CallUUID.
CREATE UNIQUE INDEX uq_agency_inbound_calls_provider_call
  ON agency_inbound_calls (provider, provider_call_id);

-- The account's Missed list: status, newest first (keyset on arrived_at, id).
CREATE INDEX idx_agency_inbound_calls_missed
  ON agency_inbound_calls (tenant_id, account_id, follow_up_status, arrived_at DESC, id DESC)
  WHERE follow_up_status IS NOT NULL;

-- One assignee's Missed list (an agent's own, or the unassigned ones: assignee IS NULL).
CREATE INDEX idx_agency_inbound_calls_missed_assignee
  ON agency_inbound_calls (tenant_id, account_id, follow_up_assignee_user_id, follow_up_status, arrived_at DESC, id DESC)
  WHERE follow_up_status IS NOT NULL;

-- The startup and periodic sweep (§10): non-terminal rows by age. Live calls only, so it stays
-- the size of the floor. Predicate as idx_agency_manual_calls_live's.
CREATE INDEX idx_agency_inbound_calls_open
  ON agency_inbound_calls (arrived_at)
  WHERE state <> 'ended';

CREATE TRIGGER trg_agency_inbound_calls_updated_at
  BEFORE UPDATE ON agency_inbound_calls
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agency_inbound_calls IS
  'The inbound spine (docs/inbound.md §9): one row per call that reached the answer webhook. A row with follow_up_status is a Missed inbound row (§7).';
COMMENT ON COLUMN agency_inbound_calls.account_id IS
  'The matched contact''s account, else the route''s (§8.3). NULL: the tenant default, which has no route, match or media leg.';
COMMENT ON COLUMN agency_inbound_calls.follow_up_status IS
  'open | handled: the Missed inbound row. NULL: no follow-up owed (answered, rejected, or not ended yet).';

-- ── 3. The media leg ──────────────────────────────────────────────────────────

ALTER TABLE agency_calls
  ADD COLUMN inbound_call_id UUID,
  DROP CONSTRAINT ck_agency_calls_origin,
  ADD CONSTRAINT ck_agency_calls_origin CHECK (origin IN ('campaign', 'manual', 'inbound')) NOT VALID,
  ADD CONSTRAINT ck_agency_calls_inbound_correlation
    CHECK ((origin = 'inbound') = (inbound_call_id IS NOT NULL)) NOT VALID;

COMMENT ON COLUMN agency_calls.origin IS
  'campaign: placed by pacing for an agency_call_attempts row (agency_attempt_id). manual: a soft-phone dial (manual_call_id). inbound: a customer''s call to an inbound route (inbound_call_id). campaign_id is NULL on the last two. All are agency calls (SP5).';
COMMENT ON COLUMN agency_calls.inbound_call_id IS
  'agency_inbound_calls.id this media leg belongs to (origin = inbound). Correlation only, no FK. caller_id is the number rung, destination_phone the caller''s (empty when withheld).';

-- ── 4. Contacts and campaigns ─────────────────────────────────────────────────

ALTER TABLE agency_contacts
  ADD COLUMN callback_source VARCHAR(16),
  ADD COLUMN callback_due_at TIMESTAMPTZ,
  ADD CONSTRAINT ck_agency_contact_callback_source CHECK (
    (callback_source IS NULL) = (callback_due_at IS NULL)
    AND (callback_source IS NULL OR callback_source = 'inbound')
  ) NOT VALID;

COMMENT ON COLUMN agency_contacts.callback_source IS
  'A callback no disposition booked: inbound (the customer rang and reached nobody, docs/inbound.md §7). Due at callback_due_at. NULL: none (a disposition callback is read from last_disposition).';

ALTER TABLE agency_campaigns
  ADD COLUMN inbound_sticky_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN agency_campaigns.inbound_sticky_enabled IS
  'Whether this campaign''s owners and calls are sticky-routing signals for inbound calls (docs/inbound.md §4.1).';

-- ── 5. Credentials and numbers ────────────────────────────────────────────────

ALTER TABLE telephony_credentials
  ADD COLUMN inbound_app_id                     VARCHAR(100),
  ADD COLUMN inbound_answer_url                 TEXT,
  ADD COLUMN inbound_hangup_url                 TEXT,
  ADD COLUMN inbound_fallback_answer_url        TEXT,
  ADD COLUMN inbound_token_hash                 TEXT,
  ADD COLUMN inbound_previous_token_hash        TEXT,
  ADD COLUMN inbound_previous_token_expires_at  TIMESTAMPTZ,
  ADD COLUMN inbound_enabled_at                 TIMESTAMPTZ,
  -- Enabled is all of it or none of it: an Application with no stored URL could not be
  -- verified, and a token with no Application has nothing to protect.
  ADD CONSTRAINT ck_telephony_credentials_inbound CHECK (
    (inbound_app_id IS NULL) = (inbound_answer_url IS NULL)
    AND (inbound_app_id IS NULL) = (inbound_hangup_url IS NULL)
    AND (inbound_app_id IS NULL) = (inbound_fallback_answer_url IS NULL)
    AND (inbound_app_id IS NULL) = (inbound_token_hash IS NULL)
    AND (inbound_app_id IS NULL) = (inbound_enabled_at IS NULL)
    AND (inbound_app_id IS NULL OR (inbound_app_id = btrim(inbound_app_id) AND inbound_app_id <> ''))
    AND (inbound_token_hash IS NULL OR inbound_token_hash ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT ck_telephony_credentials_inbound_previous_token CHECK (
    (inbound_previous_token_hash IS NULL) = (inbound_previous_token_expires_at IS NULL)
    AND (inbound_previous_token_hash IS NULL OR
         (inbound_token_hash IS NOT NULL AND inbound_previous_token_hash ~ '^[0-9a-f]{64}$'))
  ),
  -- A revoked credential's secret is shredded: it could never verify or remove the Application,
  -- so inbound is disabled (and every number unlinked) before a revoke.
  ADD CONSTRAINT ck_telephony_credentials_inbound_revoked CHECK (status <> 'revoked' OR inbound_app_id IS NULL);

COMMENT ON COLUMN telephony_credentials.inbound_app_id IS
  'The Plivo Application inbound calls on this account''s linked numbers are routed to. NULL: inbound not enabled.';
COMMENT ON COLUMN telephony_credentials.inbound_answer_url IS
  'The answer URL the Application was given, WITHOUT its token query: inbound signatures are verified against this URL plus the request''s query, never one rebuilt from env.';
COMMENT ON COLUMN telephony_credentials.inbound_token_hash IS
  'sha256(token) as hex of the inbound webhooks'' purpose token. The raw token exists only in the URLs handed to the carrier.';
COMMENT ON COLUMN telephony_credentials.inbound_previous_token_hash IS
  'The token a Re-point replaced, still accepted until inbound_previous_token_expires_at (calls answered before the Re-point post their hangup with it).';

ALTER TABLE phone_numbers
  ADD COLUMN inbound_linked_at        TIMESTAMPTZ,
  ADD COLUMN inbound_previous_app_id  VARCHAR(100),
  -- Only a number synced from a tenant credential can point at that credential's Application;
  -- the previous app is remembered only while linked.
  ADD CONSTRAINT ck_phone_numbers_inbound CHECK (
    (inbound_linked_at IS NULL OR telephony_credential_id IS NOT NULL)
    AND (inbound_previous_app_id IS NULL OR inbound_linked_at IS NOT NULL)
  );

-- A credential's linked numbers: its inbound status count, and the cascade on disable / revoke.
CREATE INDEX idx_phone_numbers_inbound_linked
  ON phone_numbers (telephony_credential_id)
  WHERE inbound_linked_at IS NOT NULL;

COMMENT ON COLUMN phone_numbers.inbound_linked_at IS
  'When a super-admin linked the number to its credential''s inbound Application (IB6). NULL: not linked; inbound calls get the carrier''s previous behaviour.';
COMMENT ON COLUMN phone_numbers.inbound_previous_app_id IS
  'The Plivo app the number pointed at before it was linked, restored by Unlink. NULL while linked: it had none.';

-- Down Migration

-- Dropping the spine loses every inbound call's record and the Missed rows people are working,
-- and dropping agency_calls.inbound_call_id leaves inbound media legs unexplained. Like 0005's,
-- this refuses, before changing anything, while any of them exists; an operator who really
-- means to roll back deletes them deliberately first. A linked number or an enabled credential
-- points at a Plivo Application only this schema remembers: unlink and disable first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agency_inbound_calls) OR EXISTS (SELECT 1 FROM agency_calls WHERE origin = 'inbound') THEN
    RAISE EXCEPTION '0024_inbound down: inbound calls exist (agency_inbound_calls, or agency_calls with origin inbound); delete them deliberately before rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM phone_numbers WHERE inbound_linked_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM telephony_credentials WHERE inbound_app_id IS NOT NULL) THEN
    RAISE EXCEPTION '0024_inbound down: numbers are linked to inbound or a credential has inbound enabled; unlink and disable them before rolling back';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_phone_numbers_inbound_linked;
ALTER TABLE phone_numbers
  DROP CONSTRAINT IF EXISTS ck_phone_numbers_inbound,
  DROP COLUMN IF EXISTS inbound_previous_app_id,
  DROP COLUMN IF EXISTS inbound_linked_at;

ALTER TABLE telephony_credentials
  DROP CONSTRAINT IF EXISTS ck_telephony_credentials_inbound_revoked,
  DROP CONSTRAINT IF EXISTS ck_telephony_credentials_inbound_previous_token,
  DROP CONSTRAINT IF EXISTS ck_telephony_credentials_inbound,
  DROP COLUMN IF EXISTS inbound_enabled_at,
  DROP COLUMN IF EXISTS inbound_previous_token_expires_at,
  DROP COLUMN IF EXISTS inbound_previous_token_hash,
  DROP COLUMN IF EXISTS inbound_token_hash,
  DROP COLUMN IF EXISTS inbound_fallback_answer_url,
  DROP COLUMN IF EXISTS inbound_hangup_url,
  DROP COLUMN IF EXISTS inbound_answer_url,
  DROP COLUMN IF EXISTS inbound_app_id;

ALTER TABLE agency_campaigns DROP COLUMN IF EXISTS inbound_sticky_enabled;

-- An inbound callback on a contact reads as none once the columns go: the contact keeps its
-- state and next_attempt_at, so it is still dialled when due, as an ordinary retry.
ALTER TABLE agency_contacts
  DROP CONSTRAINT IF EXISTS ck_agency_contact_callback_source,
  DROP COLUMN IF EXISTS callback_due_at,
  DROP COLUMN IF EXISTS callback_source;

-- No inbound leg exists (checked above), so the old CHECK holds on every row.
ALTER TABLE agency_calls
  DROP CONSTRAINT IF EXISTS ck_agency_calls_inbound_correlation,
  DROP CONSTRAINT IF EXISTS ck_agency_calls_origin,
  DROP COLUMN IF EXISTS inbound_call_id,
  ADD CONSTRAINT ck_agency_calls_origin CHECK (origin IN ('campaign', 'manual'));
COMMENT ON COLUMN agency_calls.origin IS
  'campaign: placed by pacing for an agency_call_attempts row (agency_attempt_id). manual: a soft-phone dial (manual_call_id); campaign_id stays NULL. Both are agency calls (SP5).';

DROP TABLE IF EXISTS agency_inbound_calls;
DROP TABLE IF EXISTS agency_inbound_route_numbers;
DROP TABLE IF EXISTS agency_inbound_routes;
