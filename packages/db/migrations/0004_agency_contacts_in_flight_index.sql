-- 0004_agency_contacts_in_flight_index.sql — the index for the reaper's stranded-contact sweep.
--
-- The sweep (AgencyContactRepository.findStrandedInFlight, every 60 s) looks for contacts left
-- `in_flight` with no live attempt: the dialer's contact settlement failing after the attempt
-- row was ended, or a crash between the contact claim and the attempt insert. It drives from
-- the few contacts in `in_flight` (one per live call), then reads their attempts through
-- uq_agency_attempt_number (contact_id, attempt_number). Without this it scanned every contact
-- on every sweep. Same shape as 0003's idx_agency_contacts_connected; keyed on `id` rather
-- than `updated_at`, so the contact writes that only move `updated_at` stay HOT-eligible.
--
-- Plain CREATE INDEX, as in 0003: node-pg-migrate runs each SQL file in one transaction, the
-- build holds a SHARE lock on agency_contacts (writes wait), and migrations run at container
-- start, before the server listens. The index is partial and small.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down
-- marker comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE INDEX idx_agency_contacts_in_flight
  ON agency_contacts (id)
  WHERE state = 'in_flight';

COMMENT ON INDEX idx_agency_contacts_in_flight IS
  'The reaper''s stranded-contact sweep: the few contacts in in_flight, joined to their attempts by uq_agency_attempt_number.';

-- Down Migration

DROP INDEX IF EXISTS idx_agency_contacts_in_flight;
