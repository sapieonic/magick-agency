-- 0034_dnc_phone_ending_index.sql — the Do Not Call list's search by the end of a number.
--
-- The list's search box (`GET /dnc?phone=`) used to match the typed text exactly against
-- `phone_e164`, so only `+919908815060` found `+919908815060`. It now reads a whole number by the
-- customer-history search's rule (exact, `idx_dnc_entries_tenant_phone`) and also matches the
-- digits typed as the END of the number, as the soft phone's call log does (`15060`).
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_dnc_entries_tenant_phone_reversed (tenant_id, reverse(phone_e164) text_pattern_ops): an
-- ending is a prefix of the reversed number, so `reverse(phone_e164) LIKE '06051%'` is a range scan
-- inside the tenant rather than a `LIKE '%15060'` over every row it has (the contacts' suffix index
-- in 0001 does the same). Stored numbers are E.164 (`+` and digits, `toDncE164`), so the column
-- itself is reversed, with no digits expression. The repository must spell the expression
-- `reverse(phone_e164)` to match it (`phoneSearchCondition` in `dnc.repository.ts`).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE INDEX: dnc_entries is small next to the roster tables, and migrations run at
-- container start, before the server listens.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE INDEX idx_dnc_entries_tenant_phone_reversed
  ON dnc_entries (tenant_id, reverse(phone_e164) text_pattern_ops);

COMMENT ON INDEX idx_dnc_entries_tenant_phone_reversed IS
  'The Do Not Call list search by the end of a number: an ending is a prefix of the reversed number (GET /dnc?phone=, phoneSearchCondition).';

-- Down Migration

DROP INDEX IF EXISTS idx_dnc_entries_tenant_phone_reversed;
