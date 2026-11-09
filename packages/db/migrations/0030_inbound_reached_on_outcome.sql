-- 0030_inbound_reached_on_outcome.sql — a Missed inbound row closes as `reached` only when a
-- person was reached, matched on the number's digits; and why a call was answered `closed`
-- (docs/inbound.md §7, §11).
--
-- ── Closing on the outcome of an outbound conversation, not on its bridge ─────
-- 0028 closed the account's open Missed rows from a number the moment any conversation with it
-- was put through (`bridged_at` set). For a call WE place (a campaign attempt, a soft-phone call)
-- "put through" is not "a person was reached": with no answering-machine detection, the agent is
-- bridged to whatever answered, and the only signal that it was the customer's voicemail is the
-- outcome the agent then saves (`voicemail`, VOICEMAIL_DISPOSITION_CODE). 0028 closed the row
-- "Customer reached" on a voicemail, and nothing was left on any list.
--
-- So an outbound conversation now closes the rows when its OUTCOME says a person was reached:
-- the product's one definition of a human connect (HUMAN_CONNECT_ATTEMPT_SQL, the connect rate's
-- numerator, apps/server/src/db/repositories/agency/sql-fragments.ts): a conversation written up
-- with a code that is not
--  - `voicemail` (VOICEMAIL_DISPOSITION_CODE): a machine answered;
--  - `no_disposition` (AUTO_DISPOSITION_CODE): the outcome lapsed, so nobody said who answered;
--  - `redialed` (AGENCY_REDIALED_DISPOSITION_CODE): a wrap-up redial continues the conversation,
--    and the redial attempt carries its outcome.
-- "A conversation" is CONVERSATION_ATTEMPT_SQL's for an attempt (bridged, or a wrap-up redial
-- whether or not it bridged itself) and `bridged_at` set for a soft-phone call. The server's
-- test/integration/agency/inbound-missed-reached.test.ts drives the triggers with those
-- constants, so a renamed code turns it red.
--
-- Why the outcome rather than reopening a row the bridge closed: the outcome is the one place the
-- product learns who answered, and closing on it leaves nothing to undo. Reopening would need the
-- row to remember which conversation closed it, a second trigger on the outcome, and a row that
-- shows "Customer reached" for the length of a voicemail and its wrap-up and then reappears. While
-- the call is live the row is open but nobody can call the number twice: the soft phone's
-- pre-dial busy probe (numberLiveSql) refuses a number with a live call in the account.
-- A conversation that lapses (`no_disposition`) leaves the row open: unknown is not reached, and
-- an open row is the side that cannot lose a customer.
--
-- An INBOUND conversation still closes at the bridge (0028's trigger, unchanged): the customer
-- rang us and was put through to an agent, which a machine does not do.
--
-- The triggers fire when the outcome is first written or changed to a person-reached code
-- (`IS DISTINCT FROM`), never on another write to the row; the WHEN carries the whole rule, so
-- every other write to the hot tables queues nothing. A conversation's outcome changed later to a
-- no-contact code does not reopen what it closed (a person can, with Reopen).
--
-- ── Matching the number by its digits ──────────────────────────────────────────
-- 0028 compared `from_e164 = phone` as text. Every other number match in this code compares
-- digits (CONTACT_PHONE_DIGITS_SQL, `regexp_replace(phone_e164, '[^0-9]', '', 'g')`), because a
-- roster number is stored as it was ingested. agency_inbound_close_reached_missed now compares
-- the digits of both sides (and does nothing for a number with no digits), and its probe moves to
-- idx_agency_inbound_calls_missed_open_digits, keyed on the digits of `from_e164` with the
-- expression byte for byte (CONTACT_PHONE_DIGITS_SQL with the column swapped, as 0027's
-- idx_agency_inbound_calls_live_from_digits), so the planner can use it.
--
-- ── Why a call was answered `closed` ───────────────────────────────────────────
-- agency_inbound_calls.closed_cause VARCHAR(24): the answer's reason for treating the caller as
-- closed, stamped at arrival by the router (AGENCY_INBOUND_CLOSED_CAUSES,
-- packages/contracts/src/agency/inbound.ts):
--  - `hours`: outside the route's opening hours, or a holiday (the route's after-hours action
--    applies, a voicemail included);
--  - `switched_off`: the account's inbound flag is off (the kill switch, §8.1);
--  - `no_route`: the number reaches no route (with an account, or the tenant default's);
--  - `credential_inactive`: the carrier credential the call arrived on is not active (§10).
-- NULL for a call the route was open for. The inbound summary counts the four apart; before this
-- column every one of them read as "after hours". Backfill: an existing closed call (outcome
-- `closed`, or a voicemail whose Missed reason is `closed`) is `no_route` without a route, else
-- `hours`, the only causes that existed when it was answered with a route (the kill switch and the
-- credential rule shipped with this pass, with no production traffic).
-- ck_agency_inbound_calls_closed_cause holds the vocabulary.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- agency_inbound_calls is small (one row per inbound call); its column is catalog-only (no
-- default), its backfill and CHECK scan it once under this file's ACCESS EXCLUSIVE, and its index
-- builds scan it once. Dropping and creating the two outbound triggers takes SHARE ROW EXCLUSIVE
-- on agency_call_attempts and agency_manual_calls until the commit, which follows at once; no
-- writer is running (a deploy stops the one server before the new container migrates,
-- DEPLOYMENT.md), 0028's model.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Restores 0028 exactly: the bridge triggers on attempts and soft-phone calls, the text match and
-- idx_agency_inbound_calls_missed_open_from, and drops the column. Rows keep their state.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_inbound_calls
  ADD COLUMN closed_cause VARCHAR(24),
  ADD CONSTRAINT ck_agency_inbound_calls_closed_cause CHECK (
    closed_cause IS NULL OR closed_cause IN ('hours', 'switched_off', 'no_route', 'credential_inactive')
  );

COMMENT ON COLUMN agency_inbound_calls.closed_cause IS
  'Why the answer treated the caller as closed: hours, switched_off (the kill switch), no_route, credential_inactive. NULL: the route was open (0030).';

ALTER TABLE agency_inbound_calls DISABLE TRIGGER trg_agency_inbound_calls_updated_at;
UPDATE agency_inbound_calls
   SET closed_cause = CASE WHEN route_id IS NULL THEN 'no_route' ELSE 'hours' END
 WHERE outcome = 'closed' OR (outcome = 'voicemail' AND follow_up_reason = 'closed');
ALTER TABLE agency_inbound_calls ENABLE TRIGGER trg_agency_inbound_calls_updated_at;

DROP INDEX idx_agency_inbound_calls_missed_open_from;

CREATE INDEX idx_agency_inbound_calls_missed_open_digits
  ON agency_inbound_calls (tenant_id, account_id, regexp_replace(from_e164, '[^0-9]', '', 'g'))
  WHERE follow_up_status = 'open' AND from_e164 IS NOT NULL;

COMMENT ON INDEX idx_agency_inbound_calls_missed_open_digits IS
  'The open Missed rows from one number (by its digits, CONTACT_PHONE_DIGITS_SQL on from_e164) in one account: the reached triggers'' probe (0030).';

CREATE OR REPLACE FUNCTION agency_inbound_close_reached_missed(
  p_tenant UUID, p_account UUID, p_phone TEXT, p_reached_at TIMESTAMPTZ, p_user UUID
) RETURNS VOID AS $$
DECLARE
  v_digits TEXT := regexp_replace(p_phone, '[^0-9]', '', 'g');
BEGIN
  IF p_account IS NULL OR v_digits IS NULL OR v_digits = '' THEN
    RETURN;
  END IF;
  UPDATE agency_inbound_calls m
     SET follow_up_status = 'handled',
         handled_reason = 'reached',
         handled_by_user_id = p_user,
         handled_at = now()
   WHERE m.tenant_id = p_tenant
     AND m.account_id = p_account
     AND regexp_replace(m.from_e164, '[^0-9]', '', 'g') = v_digits
     AND m.from_e164 IS NOT NULL
     AND m.follow_up_status = 'open'
     AND m.arrived_at <= p_reached_at;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_inbound_close_reached_missed(UUID, UUID, TEXT, TIMESTAMPTZ, UUID) IS
  'Closes the account''s open Missed inbound rows from a number (matched on its digits) that arrived by the time the conversation with the customer began: handled, reason reached (0028, 0030).';

DROP TRIGGER trg_agency_attempts_inbound_reached ON agency_call_attempts;
DROP TRIGGER trg_agency_manual_calls_inbound_reached ON agency_manual_calls;

CREATE OR REPLACE FUNCTION agency_attempt_inbound_reached() RETURNS TRIGGER AS $$
BEGIN
  PERFORM agency_inbound_close_reached_missed(
    NEW.tenant_id,
    NEW.account_id,
    (SELECT c.phone_e164 FROM agency_contacts c WHERE c.id = NEW.contact_id),
    -- The conversation began at the bridge; a wrap-up redial that rang out began at its dial.
    COALESCE(NEW.bridged_at, NEW.dialed_at, NEW.created_at),
    (SELECT s.agent_user_id FROM agency_agent_sessions s WHERE s.id = NEW.reserved_agent_id)
  );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_attempt_inbound_reached() IS
  'A campaign conversation whose outcome says a person was reached closes the open Missed inbound rows from its contact''s number (0030).';

CREATE TRIGGER trg_agency_attempts_inbound_reached
  AFTER UPDATE OF disposition_code ON agency_call_attempts
  FOR EACH ROW WHEN (
    NEW.disposition_code IS NOT NULL
    AND NEW.disposition_code IS DISTINCT FROM OLD.disposition_code
    AND NEW.disposition_code NOT IN ('voicemail', 'no_disposition', 'redialed')
    AND (NEW.bridged_at IS NOT NULL OR NEW.redial_number > 0)
  )
  EXECUTE FUNCTION agency_attempt_inbound_reached();

CREATE OR REPLACE FUNCTION agency_manual_call_inbound_reached() RETURNS TRIGGER AS $$
BEGIN
  PERFORM agency_inbound_close_reached_missed(
    NEW.tenant_id, NEW.account_id, NEW.destination_e164, NEW.bridged_at, NEW.agent_user_id
  );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_manual_call_inbound_reached() IS
  'A soft-phone conversation whose outcome says a person was reached closes the open Missed inbound rows from the number it dialled (0030).';

CREATE TRIGGER trg_agency_manual_calls_inbound_reached
  AFTER UPDATE OF disposition_code ON agency_manual_calls
  FOR EACH ROW WHEN (
    NEW.disposition_code IS NOT NULL
    AND NEW.disposition_code IS DISTINCT FROM OLD.disposition_code
    AND NEW.disposition_code NOT IN ('voicemail', 'no_disposition', 'redialed')
    AND NEW.bridged_at IS NOT NULL
  )
  EXECUTE FUNCTION agency_manual_call_inbound_reached();

-- Down Migration

DROP TRIGGER IF EXISTS trg_agency_manual_calls_inbound_reached ON agency_manual_calls;
DROP TRIGGER IF EXISTS trg_agency_attempts_inbound_reached ON agency_call_attempts;

CREATE OR REPLACE FUNCTION agency_manual_call_inbound_reached() RETURNS TRIGGER AS $$
BEGIN
  PERFORM agency_inbound_close_reached_missed(
    NEW.tenant_id, NEW.account_id, NEW.destination_e164, NEW.bridged_at, NEW.agent_user_id
  );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_manual_call_inbound_reached() IS
  'A soft-phone call put through closes the open Missed inbound rows from the number it dialled (0028).';

CREATE TRIGGER trg_agency_manual_calls_inbound_reached
  AFTER UPDATE OF bridged_at ON agency_manual_calls
  FOR EACH ROW WHEN (OLD.bridged_at IS NULL AND NEW.bridged_at IS NOT NULL)
  EXECUTE FUNCTION agency_manual_call_inbound_reached();

CREATE OR REPLACE FUNCTION agency_attempt_inbound_reached() RETURNS TRIGGER AS $$
BEGIN
  PERFORM agency_inbound_close_reached_missed(
    NEW.tenant_id,
    NEW.account_id,
    (SELECT c.phone_e164 FROM agency_contacts c WHERE c.id = NEW.contact_id),
    NEW.bridged_at,
    (SELECT s.agent_user_id FROM agency_agent_sessions s WHERE s.id = NEW.reserved_agent_id)
  );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_attempt_inbound_reached() IS
  'A campaign attempt put through to an agent closes the open Missed inbound rows from its contact''s number (0028).';

CREATE TRIGGER trg_agency_attempts_inbound_reached
  AFTER UPDATE OF bridged_at ON agency_call_attempts
  FOR EACH ROW WHEN (OLD.bridged_at IS NULL AND NEW.bridged_at IS NOT NULL)
  EXECUTE FUNCTION agency_attempt_inbound_reached();

CREATE OR REPLACE FUNCTION agency_inbound_close_reached_missed(
  p_tenant UUID, p_account UUID, p_phone TEXT, p_reached_at TIMESTAMPTZ, p_user UUID
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
     AND m.arrived_at <= p_reached_at;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_inbound_close_reached_missed(UUID, UUID, TEXT, TIMESTAMPTZ, UUID) IS
  'Closes the account''s open Missed inbound rows from a number that arrived by the time the customer was put through to an agent: handled, reason reached (0028).';

DROP INDEX IF EXISTS idx_agency_inbound_calls_missed_open_digits;

CREATE INDEX idx_agency_inbound_calls_missed_open_from
  ON agency_inbound_calls (tenant_id, account_id, from_e164)
  WHERE follow_up_status = 'open' AND from_e164 IS NOT NULL;

COMMENT ON INDEX idx_agency_inbound_calls_missed_open_from IS
  'The open Missed rows from one number in one account: the reached triggers'' probe (0028).';

ALTER TABLE agency_inbound_calls
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_closed_cause,
  DROP COLUMN IF EXISTS closed_cause;
