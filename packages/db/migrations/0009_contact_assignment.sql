-- 0009_contact_assignment.sql — supervisors assign roster contacts to agents; agent-led retry;
-- outcome-granted overrides.
--
-- ── Assignment (phase 1) ──────────────────────────────────────────────────────
--
-- `agency_contacts.assigned_user_id` names the agent who owns a contact. NULL is the shared pool,
-- which is every row today, so nothing changes for an existing campaign. How pacing reads the
-- owner is the campaign's `assignment_mode`:
--
--  - `pool` (default): the owner is ignored; one shared queue, exactly as before.
--  - `strict`: an agent is paired only with contacts assigned to them. Unassigned contacts are
--    never dialled and keep the campaign from completing until the supervisor assigns them.
--  - `preferred`: an agent takes their own due contacts first, then the pool; never another
--    agent's.
--
-- `assigned_user_id` deliberately has no FK to `users`, as `agency_agent_sessions.agent_user_id`
-- has none: the dialer runtime treats user ids as opaque, and an FK would make every user delete
-- scan a million-row roster (the index below leads with `campaign_id`). A contact assigned to a
-- user who no longer exists reads as assigned to a former member and can be reassigned.
--
-- `idx_agency_contacts_assignee` serves the per-agent claim ("next due contact for agent X":
-- campaign, owner, `pending`, then `next_attempt_at` order), the pool claim in preferred mode
-- (`assigned_user_id IS NULL`), and the per-agent counts (campaign, owner, state). The pool-mode
-- claim keeps `idx_agency_contacts_dialable`.
--
-- `agency_contact_assignment_events` is the history: one row per contact per move, so the
-- supervisor can see who held a contact and when. `batch_id` groups the rows one operation
-- wrote (a split of 10,000 contacts is one batch); the operation itself is one
-- `platform_audit_log` row carrying the same batch id. `actor_user_id` NULL is the system (an
-- unstaff, a callback fallback, a roster supersede).
--
-- ── Agent-led retry and outcome overrides (phase 2) ──────────────────────────
--
-- `agency_campaigns.allow_agent_retry` (off by default) lets an agent reopen the contacts they
-- did not reach, into their own queue or by dialling them one by one, bounded per contact by
-- `agent_retry_rounds` (`agency_contacts.agent_retry_rounds_used` counts them) and by
-- `agent_retry_cooldown_minutes` since the contact's last attempt.
--
-- An outcome in the campaign's catalog may grant an override (`override` on the disposition, in
-- the catalog JSON; no column). The latest granting outcome on a contact is copied onto the
-- contact's `override_*` columns and each part is used up when spent:
--
--  - `override_extra_attempts`: dials still allowed past the retry policy's `max_attempts`;
--  - `override_retry_delay`: the agent may dial before the contact's next scheduled time, once;
--  - `override_calling_hours`: the agent may dial outside calling hours, once, with a note.
--
-- DNC is never overridable: no column exists for it, and every claim and dial path keeps its
-- DNC refusal regardless of these columns.
--
-- On `agency_call_attempts`, `agent_manual` marks a dial an agent placed from their own contact
-- list (on the campaign's path: attempt row, caller IDs, recording, outcome), and
-- `override_applied` / `override_note` record which overrides the dial spent.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with a constant default does not rewrite the table (Postgres 11+). CREATE INDEX
-- (not CONCURRENTLY: one transaction) blocks writes to agency_contacts while it builds; migrations
-- run at container start, before the server listens (docker/entrypoint.sh).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_campaigns
  ADD COLUMN assignment_mode VARCHAR(16) NOT NULL DEFAULT 'pool',
  ADD COLUMN on_unstaff VARCHAR(16) NOT NULL DEFAULT 'return_to_pool',
  ADD COLUMN callback_owner_grace_minutes INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN callback_fallback VARCHAR(8) NOT NULL DEFAULT 'pool',
  ADD COLUMN allow_agent_retry BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN agent_retry_rounds SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN agent_retry_cooldown_minutes INTEGER NOT NULL DEFAULT 30,
  ADD CONSTRAINT ck_agency_campaign_assignment_mode
    CHECK (assignment_mode IN ('pool', 'strict', 'preferred')),
  ADD CONSTRAINT ck_agency_campaign_on_unstaff
    CHECK (on_unstaff IN ('return_to_pool', 'keep')),
  ADD CONSTRAINT ck_agency_campaign_callback_grace
    CHECK (callback_owner_grace_minutes BETWEEN 0 AND 10080),
  ADD CONSTRAINT ck_agency_campaign_callback_fallback
    CHECK (callback_fallback IN ('pool', 'wait')),
  ADD CONSTRAINT ck_agency_campaign_agent_retry_rounds
    CHECK (agent_retry_rounds BETWEEN 1 AND 10),
  ADD CONSTRAINT ck_agency_campaign_agent_retry_cooldown
    CHECK (agent_retry_cooldown_minutes BETWEEN 0 AND 10080);

COMMENT ON COLUMN agency_campaigns.assignment_mode IS
  'How pacing reads agency_contacts.assigned_user_id: pool (ignored, one shared queue), strict (own contacts only), preferred (own first, then unassigned).';
COMMENT ON COLUMN agency_campaigns.on_unstaff IS
  'When an agent is unstaffed: return_to_pool (their open contacts lose the owner) or keep.';
COMMENT ON COLUMN agency_campaigns.callback_owner_grace_minutes IS
  'How long a due callback waits for its owner to be live on the campaign before callback_fallback applies.';
COMMENT ON COLUMN agency_campaigns.callback_fallback IS
  'After the grace: pool (the callback loses its owner) or wait (it keeps waiting for the owner).';
COMMENT ON COLUMN agency_campaigns.allow_agent_retry IS
  'Agents may reopen the contacts they did not reach (into their own queue, or one by one).';
COMMENT ON COLUMN agency_campaigns.agent_retry_rounds IS
  'How many times an agent may reopen one contact after it was not reached.';
COMMENT ON COLUMN agency_campaigns.agent_retry_cooldown_minutes IS
  'Minimum minutes since a contact''s last attempt before an agent may retry it.';

ALTER TABLE agency_contacts
  ADD COLUMN assigned_user_id UUID,
  ADD COLUMN assigned_at TIMESTAMPTZ,
  ADD COLUMN assigned_by_user_id UUID,
  ADD COLUMN agent_retry_rounds_used SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN override_disposition VARCHAR(50),
  ADD COLUMN override_extra_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN override_retry_delay BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN override_calling_hours BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN override_granted_at TIMESTAMPTZ,
  -- An owner is stamped with when it was given; the pool has neither.
  ADD CONSTRAINT ck_agency_contact_assigned_at
    CHECK (assigned_user_id IS NULL OR assigned_at IS NOT NULL),
  ADD CONSTRAINT ck_agency_contact_agent_retry_rounds_used
    CHECK (agent_retry_rounds_used >= 0),
  ADD CONSTRAINT ck_agency_contact_override_extra_attempts
    CHECK (override_extra_attempts BETWEEN 0 AND 5);

COMMENT ON COLUMN agency_contacts.assigned_user_id IS
  'The agent (user id) who owns this contact. NULL: the shared pool. Read by pacing per agency_campaigns.assignment_mode.';
COMMENT ON COLUMN agency_contacts.agent_retry_rounds_used IS
  'How many times an agent reopened this contact after it was not reached (bounded by agency_campaigns.agent_retry_rounds).';
COMMENT ON COLUMN agency_contacts.override_disposition IS
  'The outcome code whose override the override_* columns hold (the latest granting outcome).';
COMMENT ON COLUMN agency_contacts.override_extra_attempts IS
  'Dials still allowed past the retry policy''s max_attempts, granted by override_disposition.';
COMMENT ON COLUMN agency_contacts.override_retry_delay IS
  'The agent may dial before the next scheduled time, once (granted by override_disposition).';
COMMENT ON COLUMN agency_contacts.override_calling_hours IS
  'The agent may dial outside calling hours, once, with a note (granted by override_disposition).';

CREATE INDEX idx_agency_contacts_assignee
  ON agency_contacts (campaign_id, assigned_user_id, state, next_attempt_at);

COMMENT ON INDEX idx_agency_contacts_assignee IS
  'Per-agent claim (strict/preferred), the preferred-mode pool claim (assigned_user_id IS NULL) and per-agent counts.';

CREATE TABLE agency_contact_assignment_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  campaign_id    UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES agency_contacts(id) ON DELETE CASCADE,
  -- NULL: the pool.
  from_user_id   UUID,
  to_user_id     UUID,
  -- NULL: the system.
  actor_user_id  UUID,
  reason         VARCHAR(20) NOT NULL,
  batch_id       UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_agency_assignment_event_reason CHECK (reason IN (
    'manual', 'random_split', 'count', 'filter', 'range', 'rebalance', 'unstaffed', 'reassign',
    'unassign', 'callback', 'callback_fallback', 'superseded', 'inherited'
  )),
  CONSTRAINT ck_agency_assignment_event_moves CHECK (from_user_id IS DISTINCT FROM to_user_id)
);

CREATE INDEX idx_agency_assignment_events_contact
  ON agency_contact_assignment_events (contact_id, created_at DESC);
CREATE INDEX idx_agency_assignment_events_campaign
  ON agency_contact_assignment_events (campaign_id, created_at DESC);
CREATE INDEX idx_agency_assignment_events_batch
  ON agency_contact_assignment_events (batch_id);

COMMENT ON TABLE agency_contact_assignment_events IS
  'Who held a contact and when: one row per contact per owner change. batch_id groups one operation (its platform_audit_log row carries the same id).';

ALTER TABLE agency_call_attempts
  ADD COLUMN agent_manual BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN override_applied TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN override_note TEXT,
  ADD CONSTRAINT ck_agency_attempt_override_applied
    CHECK (override_applied <@ ARRAY['extra_attempts', 'retry_delay', 'calling_hours']::text[]),
  ADD CONSTRAINT ck_agency_attempt_override_note
    CHECK (override_note IS NULL OR char_length(override_note) BETWEEN 10 AND 500);

COMMENT ON COLUMN agency_call_attempts.agent_manual IS
  'An agent dialled this contact from their own contact list (agent retry), not the pacing engine.';
COMMENT ON COLUMN agency_call_attempts.override_applied IS
  'Which outcome-granted overrides this dial spent: extra_attempts, retry_delay, calling_hours.';
COMMENT ON COLUMN agency_call_attempts.override_note IS
  'The agent''s note for a calling-hours override (10-500 characters).';

-- Down Migration

ALTER TABLE agency_call_attempts
  DROP CONSTRAINT IF EXISTS ck_agency_attempt_override_note,
  DROP CONSTRAINT IF EXISTS ck_agency_attempt_override_applied,
  DROP COLUMN IF EXISTS override_note,
  DROP COLUMN IF EXISTS override_applied,
  DROP COLUMN IF EXISTS agent_manual;

DROP TABLE IF EXISTS agency_contact_assignment_events;

DROP INDEX IF EXISTS idx_agency_contacts_assignee;

ALTER TABLE agency_contacts
  DROP CONSTRAINT IF EXISTS ck_agency_contact_override_extra_attempts,
  DROP CONSTRAINT IF EXISTS ck_agency_contact_agent_retry_rounds_used,
  DROP CONSTRAINT IF EXISTS ck_agency_contact_assigned_at,
  DROP COLUMN IF EXISTS override_granted_at,
  DROP COLUMN IF EXISTS override_calling_hours,
  DROP COLUMN IF EXISTS override_retry_delay,
  DROP COLUMN IF EXISTS override_extra_attempts,
  DROP COLUMN IF EXISTS override_disposition,
  DROP COLUMN IF EXISTS agent_retry_rounds_used,
  DROP COLUMN IF EXISTS assigned_by_user_id,
  DROP COLUMN IF EXISTS assigned_at,
  DROP COLUMN IF EXISTS assigned_user_id;

ALTER TABLE agency_campaigns
  DROP CONSTRAINT IF EXISTS ck_agency_campaign_agent_retry_cooldown,
  DROP CONSTRAINT IF EXISTS ck_agency_campaign_agent_retry_rounds,
  DROP CONSTRAINT IF EXISTS ck_agency_campaign_callback_fallback,
  DROP CONSTRAINT IF EXISTS ck_agency_campaign_callback_grace,
  DROP CONSTRAINT IF EXISTS ck_agency_campaign_on_unstaff,
  DROP CONSTRAINT IF EXISTS ck_agency_campaign_assignment_mode,
  DROP COLUMN IF EXISTS agent_retry_cooldown_minutes,
  DROP COLUMN IF EXISTS agent_retry_rounds,
  DROP COLUMN IF EXISTS allow_agent_retry,
  DROP COLUMN IF EXISTS callback_fallback,
  DROP COLUMN IF EXISTS callback_owner_grace_minutes,
  DROP COLUMN IF EXISTS on_unstaff,
  DROP COLUMN IF EXISTS assignment_mode;
