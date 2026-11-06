-- 0016_agent_caller_ids.sql — a dedicated caller ID per agent on a campaign (docs/decisions.md,
-- "Dedicated caller ID per agent", DN1–DN10).
--
-- A supervisor dedicates one of a campaign's `caller_ids` to an agent staffed on it; every dial
-- to a contact that agent OWNS on that campaign (`agency_contacts.assigned_user_id`) goes out
-- from that number, whoever places the dial (DN2). The rest of the campaign's numbers are the
-- rotation for every other contact (DN3). One row per (campaign, agent).
--
--  - UNIQUE (campaign_id, user_id): an agent holds at most one number on a campaign. A PUT for
--    an agent who already has one replaces it (an UPSERT on this constraint).
--  - UNIQUE (campaign_id, caller_id): a number is dedicated to at most one agent on a campaign.
--    The same number may be dedicated on other campaigns, to the same agent or another. The PUT
--    maps a violation of this one to 409 `caller_id_taken`, never a 500.
--  - `campaign_id` has no FK, as `agency_campaign_agents.campaign_id` has none (the staffing a
--    dedication follows): a campaign row is never deleted while it has a roster, and a row left
--    pointing at nothing is read by nothing.
--  - `user_id` IS FK'd to `users` (CASCADE), unlike `agency_contacts.assigned_user_id` (0009).
--    0009 left that one without an FK because a user delete would scan a million-row roster;
--    this table holds at most one row per staffed agent per campaign, so that cost does not
--    apply, and `agency_campaign_agents.user_id` (the staffing row the dedication requires)
--    cascades the same way. `idx_agency_agent_caller_ids_user` serves the cascade and the
--    unstaff release (DN7), which deletes by agent across the campaigns just closed.
--  - `set_by_user_id` SET NULL: the dedication outlives the supervisor who made it.
--  - `caller_id` is stored trimmed and non-empty (the PUT trims; `ck_…_trimmed` holds it), so
--    the dial path compares it with `usableCallerIds` (trimmed) without trimming again.
--  - `account_id` is the CAMPAIGN's account (attribution, the audit rows' account), with no FK,
--    as `agency_campaigns.account_id` has none.
--
-- Nothing else stores a dedication: the number must still be one of the campaign's usable
-- caller IDs when it is dialled (the dial path re-checks, DN2), so a campaign PATCH that drops
-- a dedicated number is refused (DN6) and a direct write that drops one only stops it being
-- used.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- A new, empty table and its index: no existing table is altered, so nothing is locked beyond
-- the catalog. The FKs to tenants and users scan nothing (the table is empty).
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops the table: every dedication is lost and every contact dials from the campaign's
-- rotation again (the server code that reads the table must be rolled back with it).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE TABLE agency_campaign_agent_caller_ids (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL,
  campaign_id     UUID NOT NULL,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caller_id       VARCHAR(20) NOT NULL,
  set_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  set_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_agency_agent_caller_id_agent UNIQUE (campaign_id, user_id),
  CONSTRAINT uq_agency_agent_caller_id_number UNIQUE (campaign_id, caller_id),
  CONSTRAINT ck_agency_agent_caller_id_trimmed CHECK (caller_id <> '' AND caller_id = btrim(caller_id))
);

CREATE INDEX idx_agency_agent_caller_ids_user
  ON agency_campaign_agent_caller_ids (user_id);

COMMENT ON TABLE agency_campaign_agent_caller_ids IS
  'Dedicated caller IDs (DN1): every dial to a contact user_id owns on campaign_id goes out from caller_id while it is one of the campaign''s usable caller_ids. One number per agent and one agent per number on a campaign.';
COMMENT ON COLUMN agency_campaign_agent_caller_ids.campaign_id IS
  'The agency_campaigns id. No FK, as agency_campaign_agents.campaign_id.';
COMMENT ON COLUMN agency_campaign_agent_caller_ids.caller_id IS
  'One of the campaign''s caller_ids, trimmed. Re-checked against the campaign''s usable caller IDs on every dial.';

-- Down Migration

DROP TABLE IF EXISTS agency_campaign_agent_caller_ids;
