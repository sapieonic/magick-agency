-- 0053_account_callbacks_index.sql — the index the account's callbacks list walks (decisions LF1,
-- LF22; apps/server/src/db/repositories/agency/callbacks.repository.ts).
--
-- The Live floor's Callbacks page lists an account's open callbacks across its active campaigns,
-- by due time, a keyset page at a time (`GET /proxy/agency/callbacks`). Per campaign, the read
-- takes the callbacks due before now (or later today) in due order. The only index of pending
-- contacts by due time, `idx_agency_contacts_dialable (campaign_id, next_attempt_at) WHERE state =
-- 'pending'`, holds every pending contact, and almost every one of them is a contact never dialled,
-- due since its upload: the overdue page read the whole undialled roster to find its few callbacks
-- (measured, 25 active campaigns of 40,000 contacts each: 3.4 s, 954,040 heap blocks). This index
-- holds only the pending contacts whose last call was a conversation or that an inbound miss
-- booked, a superset of the callbacks (`isCallbackSql` needs one or the other), and is the size of
-- the callbacks, not of the rosters (5 MB against the dialable index's 16 MB there): the same
-- page reads 613 rows a campaign, 38 ms.
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_agency_contacts_callbacks on agency_contacts
--   (campaign_id, next_attempt_at, id) WHERE state = 'pending' AND (last_outcome = 'connected' OR
--   callback_source IS NOT NULL). The read repeats the predicate byte for byte
--   (`CALLBACK_CANDIDATE_SQL`), so the planner proves the index applies. `id` last: the page's
--   order and keyset are (next_attempt_at, id).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX (node-pg-migrate runs a SQL file's Up inside a transaction, where
-- CONCURRENTLY is refused): SHARE on agency_contacts until commit, reads proceed, writes (claims,
-- settlements, assignment) wait while the table is read once. agency_contacts is large: a
-- deployment that wants it built first can CREATE INDEX CONCURRENTLY under the same name
-- (db-hygiene.md, "2. Building an index before a deploy"); IF NOT EXISTS then finds it and the
-- migration adds the comment and records itself. A CONCURRENTLY build that failed leaves an invalid
-- index under its name; the check at the end of Up fails the migration on one. `SET LOCAL
-- lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration (the deploy can be
-- retried) instead of queueing the dialler's writes behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops it; the list falls back to the dialable index (correct, slower).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on agency_contacts (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_contacts_callbacks
  ON agency_contacts (campaign_id, next_attempt_at, id)
  WHERE state = 'pending' AND (last_outcome = 'connected' OR callback_source IS NOT NULL);

COMMENT ON INDEX idx_agency_contacts_callbacks IS
  'A campaign''s pending contacts that may be callbacks (last call a conversation, or an inbound miss) by due time: the account''s callbacks list (LF22).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'idx_agency_contacts_callbacks'
     AND NOT (i.indisvalid AND i.indisready);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: %; DROP INDEX CONCURRENTLY and build again', bad;
  END IF;
END
$$;

-- Down Migration

DROP INDEX IF EXISTS idx_agency_contacts_callbacks;
