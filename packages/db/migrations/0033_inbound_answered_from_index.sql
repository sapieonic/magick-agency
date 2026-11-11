-- 0033_inbound_answered_from_index.sql — an answered inbound call is a sticky signal (docs/inbound.md
-- §4.1; decision IQ49).
--
-- IQ49: the agent who took a caller's latest ANSWERED inbound call (bridged to an agent) inside the
-- route's lookback is their agent next time, as for an outbound call. The caller identification
-- (`AgencyInboundAnswerRepository.findCallSignals`) now reads, per account of the tenant, the
-- caller's bridged inbound calls inside the lookback, newest first and stopped early (at most
-- INBOUND_CALLS_PER_ACCOUNT): the `last_connected` signal is "the latest connected call, in either
-- direction".
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_agency_inbound_calls_answered_from (tenant_id, account_id, from_e164, arrived_at DESC, id
-- DESC) WHERE bridged_at IS NOT NULL AND from_e164 IS NOT NULL: one walk per account, in the read's
-- order, over the calls an agent took only (an unanswered call names nobody). Exact `from_e164`: the
-- caller's number as the answer webhook normalised it (`plivoNumberToE164`), the form the read is
-- given, so no digits expression is needed here. Without it the read would walk the account's
-- whole inbound history inside the lookback (idx_agency_inbound_calls_account_arrived) for every
-- call that rings.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE INDEX (as 0026, 0028, 0030): agency_inbound_calls is small (one row per inbound
-- call), and migrations run at container start, before the server listens.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE INDEX idx_agency_inbound_calls_answered_from
  ON agency_inbound_calls (tenant_id, account_id, from_e164, arrived_at DESC, id DESC)
  WHERE bridged_at IS NOT NULL AND from_e164 IS NOT NULL;

COMMENT ON INDEX idx_agency_inbound_calls_answered_from IS
  'IQ49: a caller''s answered inbound calls in one account, newest first: the identification''s inbound arm of the last_connected sticky signal (findCallSignals).';

-- Down Migration

DROP INDEX IF EXISTS idx_agency_inbound_calls_answered_from;
