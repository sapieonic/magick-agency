-- 0013_insights_pacing_history.sql — pacing history per campaign per minute, and the pending
-- marker that flags the first paced dial after an agent's reopen (docs/insights.md, IN2).
--
-- ── agency_campaign_pacing_minutes ───────────────────────────────────────────
-- Why a campaign was or was not dialling used to exist only as live state (/stats `stall`) and
-- Prometheus counters. This table keeps it: one row per campaign per UTC minute, additive integer
-- counters, written by
--
--  - the pacing leader (src/agency/pacing/pacing-history.ts): counts in memory per (campaign,
--    minute) next to each metric increment and flushes one additive upsert every ~15 s, on
--    campaign stop and on shutdown;
--  - the writes outside the pacing tick (a wrap-up redial refused at the limit, an our-fault
--    retirement): one single-row additive upsert each.
--
-- Every write is `INSERT … ON CONFLICT (campaign_id, minute_start) DO UPDATE SET x = t.x +
-- EXCLUDED.x`, so two writers of one minute add up and the row is never rewritten from memory.
-- The primary key serves the only reads (one campaign, a range of minutes, and its first
-- minute). A minute nobody counted in has no row: absent, not zero.
--
-- `ticks` counts the pacing ticks (full or skipped) that evaluated the campaign while it was
-- `running`; the six `idle_*` columns are the ticks of those that dialled nothing, by
-- `agency_tick_idle_total`'s reason (one reason per tick, so their sum never exceeds `ticks`);
-- `outside_hours_ticks` the running ticks on which the campaign's own calling window (its
-- default time zone) was closed. The rest are event counts: `calling_hours_deferrals` and
-- `dnc_unavailable_halts` (`agency_predial_gate_total` defers on calling hours, and halts),
-- `dials_placed` (paced dials handed to the dialer), `predial_dnc_suppressed` and
-- `predial_invalid_suppressed` (pre-dial suppressions), `our_fault_retired`
-- (`agency_our_fault_retirement_total`), `redials_refused_at_limit` (a wrap-up redial refused
-- because the call's redials were used up).
--
-- The FK cascades a campaign delete. A write for a campaign already deleted is filtered by the
-- writer (it joins agency_campaigns), so one deleted campaign cannot poison a batch.
--
-- ── agency_contacts.agent_reopen_pending ─────────────────────────────────────
-- Set by the agent's reopen ("Retry not reached", AgencyAgentRetryRepository.reopenForAgent).
-- Consumed by the first paced attempt insert on the contact (AgencyAttemptRepository.create
-- with `consumeAgentReopen`), which stamps that attempt `agent_reopened = true` (0011) in the
-- same statement; an agent's own dial of the contact clears it too (the reopen was followed up
-- by hand). Restored when a paced attempt is abandoned before its dial (dispatch refused).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- CREATE TABLE on a new name, and one ADD COLUMN with a constant default (no rewrite, Postgres
-- 11+) under a brief ACCESS EXCLUSIVE on agency_contacts. Nothing here grows with the roster.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE TABLE agency_campaign_pacing_minutes (
  campaign_id                 UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  minute_start                TIMESTAMPTZ NOT NULL,
  tenant_id                   UUID NOT NULL,
  ticks                       INTEGER NOT NULL DEFAULT 0,
  outside_hours_ticks         INTEGER NOT NULL DEFAULT 0,
  idle_no_agents              INTEGER NOT NULL DEFAULT 0,
  idle_no_slots               INTEGER NOT NULL DEFAULT 0,
  idle_no_contacts            INTEGER NOT NULL DEFAULT 0,
  idle_no_reservations        INTEGER NOT NULL DEFAULT 0,
  idle_no_caller_ids          INTEGER NOT NULL DEFAULT 0,
  idle_nothing_due            INTEGER NOT NULL DEFAULT 0,
  calling_hours_deferrals     INTEGER NOT NULL DEFAULT 0,
  dnc_unavailable_halts       INTEGER NOT NULL DEFAULT 0,
  dials_placed                INTEGER NOT NULL DEFAULT 0,
  predial_dnc_suppressed      INTEGER NOT NULL DEFAULT 0,
  predial_invalid_suppressed  INTEGER NOT NULL DEFAULT 0,
  our_fault_retired           INTEGER NOT NULL DEFAULT 0,
  redials_refused_at_limit    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, minute_start),
  -- A whole UTC minute. `AT TIME ZONE 'UTC'` and date_trunc on a timestamp are both immutable.
  CONSTRAINT ck_agency_pacing_minute_whole CHECK (
    date_trunc('minute', minute_start AT TIME ZONE 'UTC') = minute_start AT TIME ZONE 'UTC'
  ),
  CONSTRAINT ck_agency_pacing_minute_counts CHECK (
    ticks >= 0 AND outside_hours_ticks >= 0
    AND idle_no_agents >= 0 AND idle_no_slots >= 0 AND idle_no_contacts >= 0
    AND idle_no_reservations >= 0 AND idle_no_caller_ids >= 0 AND idle_nothing_due >= 0
    AND calling_hours_deferrals >= 0 AND dnc_unavailable_halts >= 0 AND dials_placed >= 0
    AND predial_dnc_suppressed >= 0 AND predial_invalid_suppressed >= 0
    AND our_fault_retired >= 0 AND redials_refused_at_limit >= 0
  )
);

COMMENT ON TABLE agency_campaign_pacing_minutes IS
  'Pacing history (IN2): additive counters per campaign per UTC minute, written by the pacing leader '
  '(batched every ~15 s) and by single-row upserts outside the tick. A minute with no row was not recorded.';
COMMENT ON COLUMN agency_campaign_pacing_minutes.ticks IS
  'Pacing ticks (full or skipped) that evaluated the campaign while it was running.';
COMMENT ON COLUMN agency_campaign_pacing_minutes.outside_hours_ticks IS
  'Running ticks on which the campaign''s own calling window (default time zone) was closed.';

ALTER TABLE agency_contacts
  ADD COLUMN agent_reopen_pending BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN agency_contacts.agent_reopen_pending IS
  'Set by an agent''s reopen ("Retry not reached"); consumed by the first paced attempt insert, which is '
  'stamped agency_call_attempts.agent_reopened. Cleared by the agent''s own dial of the contact.';

-- Down Migration

ALTER TABLE agency_contacts
  DROP COLUMN IF EXISTS agent_reopen_pending;

DROP TABLE IF EXISTS agency_campaign_pacing_minutes;
