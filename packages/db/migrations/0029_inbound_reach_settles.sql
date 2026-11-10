-- 0029_inbound_reach_settles.sql — an inbound callback remembers whether it reopened its contact,
-- so a reach that settles it can put the contact back where it was; and the inbound spine keeps
-- the carrier's own duration of the call (docs/inbound.md §6, §7, §9).
--
-- ── agency_contacts.callback_reopened ────────────────────────────────────────
-- A missed inbound call books a callback on its matched contact (`bookInboundCallback`, IB4): a
-- `pending` contact keeps its state, an `exhausted` one (retries used up) is REOPENED, `pending`
-- again, so the dialer calls the customer back. Until now nothing recorded which, so a reach that
-- settled the callback with no outcome that moves the contact (a retry or plain code saved, or the
-- outcome lapsing: SWE-F2) could only leave the contact `pending`, and the campaign dialled a
-- customer who had just been spoken to, beyond their retries. With this flag the settle
-- (`settleFromInbound`'s `none` arm) puts a reopened contact back to `exhausted`.
--
-- true: the contact's inbound callback (`callback_source = 'inbound'`) reopened it from
-- `exhausted`. Written by `bookInboundCallback` only (true when it reopens; a second booking on a
-- contact already holding one keeps the flag; any other booking writes false) and cleared by
-- `settleFromInbound`. Meaningful only while `callback_source` is set: every other writer that
-- clears the callback (a placed dial, `chargeAttempt`; a soft-phone call that claimed it) leaves
-- the flag as it was, and the next booking rewrites it.
--
-- NOT NULL DEFAULT false: a constant default, so the column is catalog-only on Postgres 11+ (no
-- table rewrite, no scan of agency_contacts). No index: it is read only on the row a settle has
-- already locked by primary key.
--
-- ── agency_inbound_calls.carrier_seconds ─────────────────────────────────────
-- The carrier's duration of the call, whole seconds, from its hangup callback (Plivo's
-- `Duration`): what it bills the call for. A call the carrier answered with a spoken message
-- (`<Speak>`: no recording of the route's for the message, the kill switch, the tenant default)
-- ends on our side at the answer, so `ended_at - answered_at` is ~0 while the carrier speaks and
-- bills until the caller hangs up (SWE-F8). The usage report's `inbound_seconds` sums this when it
-- is known, else the timestamps. NULL: no hangup callback with a duration yet (or a call that never
-- reached the hangup URL). CHECK non-negative; the table is small (one row per inbound call), so
-- the CHECK's validating scan is cheap.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops both columns (and the CHECK). A contact reopened by a callback still due stays `pending`
-- with it, as before this migration.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_contacts
  ADD COLUMN callback_reopened BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN agency_contacts.callback_reopened IS
  'True: the inbound callback (callback_source) reopened this contact from exhausted (IB4); a reach that settles it with no outcome that moves the contact puts it back to exhausted. Meaningful only while callback_source is set.';

ALTER TABLE agency_inbound_calls
  ADD COLUMN carrier_seconds INTEGER,
  ADD CONSTRAINT ck_agency_inbound_calls_carrier_seconds CHECK (carrier_seconds IS NULL OR carrier_seconds >= 0);

COMMENT ON COLUMN agency_inbound_calls.carrier_seconds IS
  'The carrier''s duration of the call in whole seconds, from its hangup callback (Plivo Duration): what it bills. NULL until the hangup callback carries one; the usage report then reads ended_at - answered_at.';

-- Down Migration

ALTER TABLE agency_inbound_calls
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_carrier_seconds,
  DROP COLUMN IF EXISTS carrier_seconds;

ALTER TABLE agency_contacts
  DROP COLUMN IF EXISTS callback_reopened;
