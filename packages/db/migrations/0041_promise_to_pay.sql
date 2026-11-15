-- 0041_promise_to_pay.sql — a promised payment date (and optional amount) recorded with an outcome.
--
-- Decisions PT1–PT14 (docs/decisions.md). A catalog entry with `requires_promise` makes the
-- agent enter the date the customer promised to pay and, optionally, how much. The promise is
-- stored on the call it was recorded on, so history keeps every one, and the contact carries
-- its LATEST one, so the Contacts list can show, filter and export it without reading calls.
--
-- ── On each call that can carry an outcome ────────────────────────────────────
-- agency_call_attempts (a campaign call), agency_manual_calls (a soft-phone call, tagged to a
-- campaign) and agency_inbound_calls (an inbound call matched to a campaign contact) each get:
--   promise_date   DATE           the customer's calendar date; NULL: no promise.
--   promise_amount NUMERIC(14,2)  exact (never a float), >= 0, only beside a date; NULL: none given.
-- ck_<table>_promise: an amount needs a date, is not negative, and a promise needs an outcome
-- (disposition_code). NOT VALID on all three: the columns are new and NULL, the CHECK is enforced
-- on every write from now, and adding it validated would scan each table under its lock.
--
-- ── On the contact: its latest promise (denormalised, PT6) ────────────────────
--   promise_date, promise_amount   as above, copied from the call that recorded it.
--   promise_due_from               the instant the promised day starts in the customer's zone
--   promise_due_until              the instant the day after it starts (DST-correct, computed by
--                                  the server from the contact's zone, else the campaign's: the
--                                  zone calling hours use). The list's state (upcoming / due today
--                                  / missed) is then a comparison of instants with no timezone
--                                  arithmetic in SQL, so a junk zone string can never fail a read.
--   promise_call_at                when the call that recorded it started: a promise from a later
--                                  call replaces it, a replay of the same call corrects it, an
--                                  older call's replay never overwrites a newer promise.
--   promise_followed_up_at         when an outcome was first recorded on the contact by a call that
--                                  started after the promise's call and on or after the promised
--                                  day (PT7: "followed up"; without it a passed promise is "missed").
-- ck_agency_contact_promise: date, both day bounds and call_at are set together; an amount and a
-- follow-up need a date; the amount is not negative; the day ends after it starts. NOT VALID for
-- the same reason as above.
--
-- Why denormalised rather than read from the calls (PT6): "the latest promise across three call
-- tables" is a three-way lateral per contact row on a list sized for a million contacts, and its
-- filter (contacts with a promise, missed ones) could not use an index. The copy is one row write
-- beside the disposition's own contact write, in the same transaction.
--
-- idx_agency_contacts_promise (campaign_id, promise_date) WHERE promise_date IS NOT NULL: the
-- Contacts list's promise filter and the "Promised for" order read only contacts holding a
-- promise. Partial, so it is the size of the promises, not the roster. `IF NOT EXISTS`, so a
-- deployment can build it CONCURRENTLY first (db-hygiene.md).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN without a default and ADD CONSTRAINT … NOT VALID are catalogue changes under ACCESS
-- EXCLUSIVE held for an instant. The index build scans agency_contacts under SHARE (writes wait).
-- `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration (the
-- deploy can be retried) instead of queueing every other query behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the index, the CHECKs and the columns. Every recorded promise is lost; the outcomes
-- themselves (disposition_code) are untouched.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on one of these tables (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_call_attempts
  ADD COLUMN promise_date   DATE,
  ADD COLUMN promise_amount NUMERIC(14, 2),
  ADD CONSTRAINT ck_agency_attempt_promise CHECK (
    (promise_date IS NULL OR disposition_code IS NOT NULL)
    AND (promise_amount IS NULL OR (promise_date IS NOT NULL AND promise_amount >= 0))
  ) NOT VALID;

COMMENT ON COLUMN agency_call_attempts.promise_date IS
  'Promise to pay (PT1): the date the customer promised to pay, recorded with this attempt''s outcome. NULL: none.';
COMMENT ON COLUMN agency_call_attempts.promise_amount IS
  'Promise to pay (PT5): the promised amount, exact, no currency. NULL: none given.';

ALTER TABLE agency_manual_calls
  ADD COLUMN promise_date   DATE,
  ADD COLUMN promise_amount NUMERIC(14, 2),
  ADD CONSTRAINT ck_agency_manual_call_promise CHECK (
    (promise_date IS NULL OR disposition_code IS NOT NULL)
    AND (promise_amount IS NULL OR (promise_date IS NOT NULL AND promise_amount >= 0))
  ) NOT VALID;

COMMENT ON COLUMN agency_manual_calls.promise_date IS
  'Promise to pay (PT1): the date the customer promised to pay, saved with this call''s outcome. NULL: none.';
COMMENT ON COLUMN agency_manual_calls.promise_amount IS
  'Promise to pay (PT5): the promised amount, exact, no currency. NULL: none given.';

ALTER TABLE agency_inbound_calls
  ADD COLUMN promise_date   DATE,
  ADD COLUMN promise_amount NUMERIC(14, 2),
  ADD CONSTRAINT ck_agency_inbound_call_promise CHECK (
    (promise_date IS NULL OR disposition_code IS NOT NULL)
    AND (promise_amount IS NULL OR (promise_date IS NOT NULL AND promise_amount >= 0))
  ) NOT VALID;

COMMENT ON COLUMN agency_inbound_calls.promise_date IS
  'Promise to pay (PT1): the date the caller promised to pay, saved with this call''s outcome. NULL: none.';
COMMENT ON COLUMN agency_inbound_calls.promise_amount IS
  'Promise to pay (PT5): the promised amount, exact, no currency. NULL: none given.';

ALTER TABLE agency_contacts
  ADD COLUMN promise_date           DATE,
  ADD COLUMN promise_amount         NUMERIC(14, 2),
  ADD COLUMN promise_due_from       TIMESTAMPTZ,
  ADD COLUMN promise_due_until      TIMESTAMPTZ,
  ADD COLUMN promise_call_at        TIMESTAMPTZ,
  ADD COLUMN promise_followed_up_at TIMESTAMPTZ,
  ADD CONSTRAINT ck_agency_contact_promise CHECK (
    ((promise_date IS NULL) = (promise_due_from IS NULL)
      AND (promise_date IS NULL) = (promise_due_until IS NULL)
      AND (promise_date IS NULL) = (promise_call_at IS NULL))
    AND (promise_amount IS NULL OR (promise_date IS NOT NULL AND promise_amount >= 0))
    AND (promise_followed_up_at IS NULL OR promise_date IS NOT NULL)
    AND (promise_due_until IS NULL OR promise_due_until > promise_due_from)
  ) NOT VALID;

COMMENT ON COLUMN agency_contacts.promise_date IS
  'Promise to pay (PT6): the contact''s latest promised payment date, from whichever call recorded it. NULL: none.';
COMMENT ON COLUMN agency_contacts.promise_due_from IS
  'The instant promise_date starts in the customer''s zone (the contact''s, else the campaign''s).';
COMMENT ON COLUMN agency_contacts.promise_due_until IS
  'The instant the day after promise_date starts in the customer''s zone.';
COMMENT ON COLUMN agency_contacts.promise_call_at IS
  'When the call that recorded the latest promise started: a later call''s promise replaces it.';
COMMENT ON COLUMN agency_contacts.promise_followed_up_at IS
  'When an outcome was first recorded by a later call on or after the promised day (PT7). NULL with the day passed: missed.';

CREATE INDEX IF NOT EXISTS idx_agency_contacts_promise
  ON agency_contacts (campaign_id, promise_date)
  WHERE promise_date IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_agency_contacts_promise;

ALTER TABLE agency_contacts
  DROP CONSTRAINT IF EXISTS ck_agency_contact_promise,
  DROP COLUMN IF EXISTS promise_followed_up_at,
  DROP COLUMN IF EXISTS promise_call_at,
  DROP COLUMN IF EXISTS promise_due_until,
  DROP COLUMN IF EXISTS promise_due_from,
  DROP COLUMN IF EXISTS promise_amount,
  DROP COLUMN IF EXISTS promise_date;

ALTER TABLE agency_inbound_calls
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_call_promise,
  DROP COLUMN IF EXISTS promise_amount,
  DROP COLUMN IF EXISTS promise_date;

ALTER TABLE agency_manual_calls
  DROP CONSTRAINT IF EXISTS ck_agency_manual_call_promise,
  DROP COLUMN IF EXISTS promise_amount,
  DROP COLUMN IF EXISTS promise_date;

ALTER TABLE agency_call_attempts
  DROP CONSTRAINT IF EXISTS ck_agency_attempt_promise,
  DROP COLUMN IF EXISTS promise_amount,
  DROP COLUMN IF EXISTS promise_date;
