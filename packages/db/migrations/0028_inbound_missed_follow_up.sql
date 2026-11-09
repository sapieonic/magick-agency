-- 0028_inbound_missed_follow_up.sql — the Missed inbound row closes itself when the customer is
-- reached, says how it was handled, and the inbound summary has an index to read from
-- (docs/inbound.md §7, §8.4, §11).
--
-- ── New column on agency_inbound_calls ───────────────────────────────────────
--  - handled_reason: how a Missed row was handled. `marked`: a person pressed Mark handled;
--    `reached`: the customer was put through to an agent afterwards (the triggers below). NULL on
--    an open row, and on a row handled before this migration (a person marked it: Mark handled
--    was the only writer), which readers treat as `marked`. The vocabulary is the contract's
--    AGENCY_INBOUND_HANDLED_REASONS (packages/contracts/src/agency/inbound.ts), pinned by
--    test/integration/db/inbound-missed-follow-up-migration.test.ts.
--
-- ── Closing a Missed row when the customer is reached ────────────────────────
-- A Missed row asks someone to call the customer back. Once the customer has spoken to an agent
-- of the same account (a later inbound call of theirs put through, or an outbound call to their
-- number, campaign or soft phone, put through) the follow-up is done, and leaving it open invites
-- a second, needless call. "Put through" is the product's conversation: `bridged_at` set
-- (CONVERSATION_ATTEMPT_SQL counts the same instant).
--
-- agency_inbound_close_reached_missed(tenant, account, phone, reached_at, user, except) closes,
-- in one guarded UPDATE, every OPEN Missed row of the account from that number that arrived no
-- later than the conversation began: `handled`, `handled_reason = 'reached'`, handled by the
-- agent who took the conversation, now. Rows from a withheld number never match (NULL), nor do
-- the tenant default's rows (no account), another account's, or a call that rang after the
-- conversation began. `follow_up_status = 'open'` is in the WHERE, so a row a person marks at the
-- same instant, or two conversations at once, close it once: the second UPDATE waits on the row
-- lock and re-reads the row (READ COMMITTED), finding it handled.
--
-- Three row triggers call it, each when `bridged_at` goes from NULL to set, on the transaction
-- that records the conversation, so the close commits with it and can never be missed or run
-- twice:
--  - trg_agency_attempts_inbound_reached (agency_call_attempts): the contact's number
--    (agency_contacts by primary key), the reserved session's agent (agency_agent_sessions by
--    primary key);
--  - trg_agency_manual_calls_inbound_reached (agency_manual_calls): destination_e164 and the
--    call's agent_user_id;
--  - trg_agency_inbound_calls_inbound_reached (agency_inbound_calls): the caller's from_e164 and
--    answered_by_user_id, the call itself excepted.
-- Each costs one probe of idx_agency_inbound_calls_missed_open_from (below), which holds only
-- OPEN Missed rows with a number: empty for an account with no inbound, so an outbound-only
-- tenant pays one empty index probe per conversation. The triggers write only
-- agency_inbound_calls rows that are already ended (Missed rows), which no other writer locks
-- together with an attempt, a manual call or a live inbound call, so they add no lock-order
-- hazard to the writes they ride on.
--
-- What the triggers deliberately do not do: touch the matched contact. A callback the call booked
-- (`callback_source = 'inbound'`) is settled by the conversation that reaches the contact itself
-- (chargeAttempt, settleFromManual for a soft-phone call that claimed it, which a Call back from
-- the Missed row does by logging to the matched campaign, settleFromInbound), with the outcome the
-- agent chose. Clearing it here could only leave the contact `pending` (the state it was reopened
-- to is not recorded), so the campaign would dial it anyway.
--
-- ── Indexes ───────────────────────────────────────────────────────────────────
--  - idx_agency_inbound_calls_missed_open_from (tenant_id, account_id, from_e164) WHERE
--    follow_up_status = 'open' AND from_e164 IS NOT NULL: the triggers' probe. Partial, so it is
--    the size of the open follow-ups.
--  - idx_agency_inbound_calls_account_arrived (tenant_id, account_id, arrived_at): the inbound
--    summary (`GET /inbound/summary`) reads one account's calls over a date range.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- agency_inbound_calls is small (one row per inbound call); its column is catalog-only (no
-- default) and its index builds hold a SHARE lock for one scan of it. CREATE TRIGGER takes SHARE
-- ROW EXCLUSIVE on agency_call_attempts and agency_manual_calls until the commit, which follows
-- at once; no writer is running (a deploy stops the one server before the new container
-- migrates, DEPLOYMENT.md), the model of 0012 and 0014's triggers.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the triggers, the function, the indexes and the column. A row closed as reached stays
-- handled, now with no reason (read as marked by the code before this migration, which has no
-- reason to read).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_inbound_calls
  ADD COLUMN handled_reason VARCHAR(16),
  ADD CONSTRAINT ck_agency_inbound_calls_handled_reason CHECK (
    handled_reason IS NULL OR (follow_up_status = 'handled' AND handled_reason IN ('marked', 'reached'))
  );

COMMENT ON COLUMN agency_inbound_calls.handled_reason IS
  'How a Missed row was handled: marked (a person) or reached (the customer was put through to an agent afterwards). NULL: open, or handled before 0028 (marked).';

CREATE INDEX idx_agency_inbound_calls_missed_open_from
  ON agency_inbound_calls (tenant_id, account_id, from_e164)
  WHERE follow_up_status = 'open' AND from_e164 IS NOT NULL;

COMMENT ON INDEX idx_agency_inbound_calls_missed_open_from IS
  'The open Missed rows from one number in one account: the reached triggers'' probe (0028).';

CREATE INDEX idx_agency_inbound_calls_account_arrived
  ON agency_inbound_calls (tenant_id, account_id, arrived_at);

COMMENT ON INDEX idx_agency_inbound_calls_account_arrived IS
  'One account''s inbound calls by arrival: the inbound summary''s date range (0028).';

CREATE FUNCTION agency_inbound_close_reached_missed(
  p_tenant UUID, p_account UUID, p_phone TEXT, p_reached_at TIMESTAMPTZ, p_user UUID, p_except UUID
) RETURNS VOID AS $$
BEGIN
  IF p_account IS NULL OR p_phone IS NULL THEN
    RETURN;
  END IF;
  UPDATE agency_inbound_calls m
     SET follow_up_status = 'handled',
         handled_reason = 'reached',
         handled_by_user_id = p_user,
         handled_at = now()
   WHERE m.tenant_id = p_tenant
     AND m.account_id = p_account
     AND m.from_e164 = p_phone
     AND m.follow_up_status = 'open'
     AND m.arrived_at <= p_reached_at
     AND m.id IS DISTINCT FROM p_except;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_inbound_close_reached_missed(UUID, UUID, TEXT, TIMESTAMPTZ, UUID, UUID) IS
  'Closes the account''s open Missed inbound rows from a number that arrived by the time the customer was put through to an agent: handled, reason reached (0028).';

CREATE FUNCTION agency_attempt_inbound_reached() RETURNS TRIGGER AS $$
BEGIN
  PERFORM agency_inbound_close_reached_missed(
    NEW.tenant_id,
    NEW.account_id,
    (SELECT c.phone_e164 FROM agency_contacts c WHERE c.id = NEW.contact_id),
    NEW.bridged_at,
    (SELECT s.agent_user_id FROM agency_agent_sessions s WHERE s.id = NEW.reserved_agent_id),
    NULL
  );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_attempt_inbound_reached() IS
  'A campaign attempt put through to an agent closes the open Missed inbound rows from its contact''s number (0028).';

CREATE TRIGGER trg_agency_attempts_inbound_reached
  AFTER UPDATE OF bridged_at ON agency_call_attempts
  FOR EACH ROW WHEN (OLD.bridged_at IS NULL AND NEW.bridged_at IS NOT NULL)
  EXECUTE FUNCTION agency_attempt_inbound_reached();

CREATE FUNCTION agency_manual_call_inbound_reached() RETURNS TRIGGER AS $$
BEGIN
  PERFORM agency_inbound_close_reached_missed(
    NEW.tenant_id, NEW.account_id, NEW.destination_e164, NEW.bridged_at, NEW.agent_user_id, NULL
  );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_manual_call_inbound_reached() IS
  'A soft-phone call put through closes the open Missed inbound rows from the number it dialled (0028).';

CREATE TRIGGER trg_agency_manual_calls_inbound_reached
  AFTER UPDATE OF bridged_at ON agency_manual_calls
  FOR EACH ROW WHEN (OLD.bridged_at IS NULL AND NEW.bridged_at IS NOT NULL)
  EXECUTE FUNCTION agency_manual_call_inbound_reached();

CREATE FUNCTION agency_inbound_call_inbound_reached() RETURNS TRIGGER AS $$
BEGIN
  PERFORM agency_inbound_close_reached_missed(
    NEW.tenant_id, NEW.account_id, NEW.from_e164, NEW.bridged_at, NEW.answered_by_user_id, NEW.id
  );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_inbound_call_inbound_reached() IS
  'An inbound call put through to an agent closes the caller''s earlier open Missed inbound rows (0028).';

CREATE TRIGGER trg_agency_inbound_calls_inbound_reached
  AFTER UPDATE OF bridged_at ON agency_inbound_calls
  FOR EACH ROW WHEN (OLD.bridged_at IS NULL AND NEW.bridged_at IS NOT NULL)
  EXECUTE FUNCTION agency_inbound_call_inbound_reached();

-- Down Migration

DROP TRIGGER IF EXISTS trg_agency_inbound_calls_inbound_reached ON agency_inbound_calls;
DROP TRIGGER IF EXISTS trg_agency_manual_calls_inbound_reached ON agency_manual_calls;
DROP TRIGGER IF EXISTS trg_agency_attempts_inbound_reached ON agency_call_attempts;
DROP FUNCTION IF EXISTS agency_inbound_call_inbound_reached();
DROP FUNCTION IF EXISTS agency_manual_call_inbound_reached();
DROP FUNCTION IF EXISTS agency_attempt_inbound_reached();
DROP FUNCTION IF EXISTS agency_inbound_close_reached_missed(UUID, UUID, TEXT, TIMESTAMPTZ, UUID, UUID);
DROP INDEX IF EXISTS idx_agency_inbound_calls_account_arrived;
DROP INDEX IF EXISTS idx_agency_inbound_calls_missed_open_from;

ALTER TABLE agency_inbound_calls
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_handled_reason,
  DROP COLUMN IF EXISTS handled_reason;
