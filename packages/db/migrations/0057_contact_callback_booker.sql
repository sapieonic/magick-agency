-- 0057_contact_callback_booker.sql — who booked a contact's call-later, and when (agent station
-- redesign, BE-3; docs/agent-station.md AS8). 0056 is applied and is not edited.
--
-- A call-later is not a table: it is a `pending` contact whose last outcome booked one, due at
-- `next_attempt_at` (`isCallbackSql`). On `strict` / `preferred` campaigns the booker becomes the
-- owner (`assigned_user_id`, CA4); on `pool` nothing on the contact said who booked it. These two
-- columns record it, for the agent's own call-later list (`GET /proxy/agency/my-day`) and the
-- "You said you will call at 3:00 PM" tag on the panel (`AgencyReservedAttempt.callback`,
-- `booked_by_me`). They do not change who is dialled (AS8: routing is unchanged).
--
-- ── agency_contacts (new columns) ─────────────────────────────────────────────
-- callback_booked_by_user_id UUID          the agent who took the call whose outcome booked the
--                                          call-later (never a supervisor filing on their behalf,
--                                          CA4's rule), or whose promise to pay booked its
--                                          follow-up (PT2). No foreign key, as assigned_user_id.
--                                          NULL: none recorded (no call-later, an inbound one, or
--                                          one booked before this migration).
-- callback_booked_at         TIMESTAMPTZ   when that outcome was written.
-- Stamped by the disposition write that books the call-later, in the same statement as its contact
-- write; cleared by the contact's next settled call. ck_agency_contact_callback_booked: both set or
-- both NULL. NOT VALID: the columns are new and NULL on every row, the CHECK is enforced on every
-- write from now, and validating it here would scan the roster under this file's lock (0058
-- validates it).
--
-- No backfill: `dispositioned_by_user_id` on the attempt could feed one, but that is a scan of the
-- largest table for a list that empties itself in days. On assigning campaigns the owner covers the
-- older call-laters; on pool campaigns they are missing from the list until redialled.
--
-- The list's index (idx_agency_contacts_my_callbacks) is 0058's, not this file's: an index built
-- here would scan the roster under this file's ACCESS EXCLUSIVE.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN without a default and ADD CONSTRAINT … NOT VALID are catalogue changes: ACCESS
-- EXCLUSIVE on agency_contacts (large) until commit, with no scan or rewrite, so the transaction is
-- short. `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration
-- (the deploy can be retried) instead of queueing every other query behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the CHECK and the columns (0058's Down has dropped the index first). Every recorded booker
-- is lost; the call-laters themselves are untouched.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_contacts
  ADD COLUMN IF NOT EXISTS callback_booked_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS callback_booked_at TIMESTAMPTZ;

ALTER TABLE agency_contacts
  ADD CONSTRAINT ck_agency_contact_callback_booked
    CHECK ((callback_booked_by_user_id IS NULL) = (callback_booked_at IS NULL)) NOT VALID;

COMMENT ON COLUMN agency_contacts.callback_booked_by_user_id IS
  'Agent station (BE-3): the agent whose outcome booked the pending call-later (or promise follow-up); NULL when none is recorded. No foreign key. Cleared by the next settled call.';
COMMENT ON COLUMN agency_contacts.callback_booked_at IS
  'Agent station (BE-3): when the outcome that booked the call-later was written; set with callback_booked_by_user_id.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_contacts DROP CONSTRAINT IF EXISTS ck_agency_contact_callback_booked;

ALTER TABLE agency_contacts
  DROP COLUMN IF EXISTS callback_booked_at,
  DROP COLUMN IF EXISTS callback_booked_by_user_id;
