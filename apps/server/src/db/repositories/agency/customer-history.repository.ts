/**
 * `AgencyCustomerHistoryRepository`: the reads behind the customer-history search
 * (`docs/customer-history.md`, CH1–CH12): what the tenant's campaigns and the soft phone hold
 * about ONE number, in the accounts the caller can see.
 *
 * ── Every read is scoped inside the query (CH2) ─────────────────────────────────
 * Each statement binds the tenant and `account_id = ANY($visible::uuid[])`: a row of an account
 * the caller cannot see is never read, so it can never be counted, leaked through a join or
 * left behind by a filter in code. The visible set comes from the caller's memberships
 * (`agency/customer-history/visibility.ts`); an empty set reads nothing (`= ANY('{}')` is false).
 * Two rows have no account of their own and are scoped through what they name:
 *  - a DNC mark on a campaign is written `account_id NULL, campaign_id <campaign>` (the dialer's
 *    `markDnc`), so it belongs to its campaign's account, resolved through `agency_campaigns` as
 *    the dial-time check does (`dnc/dnc.repository.ts` `findMatchingEntryForAccount`). Only an
 *    entry with neither an account nor a campaign is tenant-wide;
 *  - a roster import (`agency_ingest_jobs.account_id` is the UPLOADER's membership account, NULL
 *    for a tenant-level member) belongs to its campaign's account.
 *
 * ── Two kinds of read ───────────────────────────────────────────────────────────
 *  - **The summary** (once, at search time): the roster rows (newest first, capped), the DNC
 *    entries, and SQL aggregates over the number's calls (totals, the newest placed call, what
 *    is live, the filter options, how many timeline entries there are). No call row is shipped
 *    to build it.
 *  - **A timeline page**: one keyset statement per source (campaign calls, callbacks booked on
 *    them, soft-phone calls, callbacks booked on those, DNC marks, roster rows), each taking the
 *    cursor, every filter it can apply, and `LIMIT n + 1`; the service merges their heads and keeps
 *    the top `n` (`agency/customer-history/service.ts`). A page reads O(page) rows per source, plus
 *    the index entries of the number's own rows where the source has no index in timeline order
 *    (below). Then the page's rows are enriched by primary key (campaigns, media legs, names) and
 *    its callbacks judged ({@link CUSTOMER_HISTORY_SQL}.`callbackNext`).
 *
 * ── Every read uses an index (CH9) ─────────────────────────────────────────────
 *  - contacts: `idx_agency_contacts_phone (tenant_id, phone_e164)`, an exact match on E.164;
 *  - attempts: `uq_agency_attempt_number (contact_id, attempt_number)` by the number's contacts,
 *    then a top-N sort over that number's attempts (no index orders attempts by contact and time);
 *  - soft-phone calls: `idx_agency_manual_calls_destination (tenant_id, account_id,
 *    destination_e164, created_at DESC, id DESC)` (migration 0016) walked once per visible account
 *    in keyset order with the cursor as an index condition (no sort), and
 *    `idx_agency_manual_calls_contact_history (contact_id, created_at DESC, id DESC)` the same way
 *    per contact for a call logged to one of the number's contacts but dialled to another number;
 *  - DNC: `idx_dnc_entries_tenant_phone (tenant_id, phone_e164)`;
 *  - campaigns, sessions and media legs by primary key; imports by `idx_agency_ingest_jobs_campaign`.
 * `test/integration/api/customer-history.test.ts` ("every read uses its index") EXPLAINs each
 * statement exactly as exported here, on analysed tables, without disabling any plan type.
 *
 * Nothing here matches a number by its ending (CH4): every read is `= $phone`.
 *
 * `at` columns are the row's ordering instant rendered at MICROSECOND precision
 * (`keysetAtSql`), so the timeline's keyset cursor never floors a timestamp (see
 * `packages/domain/src/keyset-cursor.ts`).
 */
import { getPool } from '@magick-agency/db';
import { keysetAtSql } from '@magick-agency/domain/keyset-cursor';

/** Who may be read: the tenant and the accounts the caller can see. */
export interface CustomerHistoryScope {
  tenantId: string;
  accountIds: readonly string[];
}

export interface CustomerHistoryContactRow {
  id: string;
  root_contact_id: string;
  campaign_id: string;
  account_id: string;
  phone_e164: string;
  context: Record<string, unknown>;
  state: string;
  suppressed_reason: string | null;
  last_outcome: string | null;
  last_disposition: string | null;
  next_attempt_at: Date;
  assigned_user_id: string | null;
  override_disposition: string | null;
  override_extra_attempts: number;
  override_retry_delay: boolean;
  override_calling_hours: boolean;
  override_granted_at: Date | null;
  created_at: Date;
  /** `created_at`, microseconds. */
  at: string;
}

/** A summary roster row: the contact and its placed attempts. */
export interface CustomerHistorySummaryContactRow extends CustomerHistoryContactRow {
  placed: number;
}

export interface CustomerHistoryCampaignRow {
  id: string;
  account_id: string;
  name: string;
  status: string;
  root_id: string;
  retry_generation: number;
  context_display: { hero?: unknown; order?: unknown; hidden?: unknown } | null;
  disposition_catalog: unknown;
}

export interface CustomerHistoryAttemptRow {
  id: string;
  contact_id: string;
  campaign_id: string;
  account_id: string;
  attempt_number: number;
  webrtc_call_id: string | null;
  /** The reserved session's agent (`agency_agent_sessions.agent_user_id`); NULL = none reserved. */
  agent_user_id: string | null;
  state: string;
  outcome: string | null;
  disposition_code: string | null;
  notes: string | null;
  callback_at: Date | null;
  dialed_at: Date | null;
  ended_at: Date | null;
  talk_seconds: number | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: Date | null;
  redial_of_attempt_id: string | null;
  /** The wrap-up redial chain's first attempt (itself when not a redial). */
  chain_attempt_id: string;
  redial_number: number;
  override_applied: string[];
  override_note: string | null;
  /** The campaign records its calls (`agency_campaigns.record_calls`): whether a purged leg had a recording. */
  record_calls: boolean;
  created_at: Date;
  /** `created_at`, microseconds. */
  at: string;
}

export interface CustomerHistoryManualCallRow {
  id: string;
  account_id: string;
  agent_user_id: string;
  campaign_id: string | null;
  contact_id: string | null;
  webrtc_call_id: string | null;
  destination_e164: string;
  state: string;
  outcome: string | null;
  disposition_code: string | null;
  notes: string | null;
  callback_at: Date | null;
  fields: Record<string, unknown> | null;
  dnc_override_note: string | null;
  hours_override_note: string | null;
  /** The call asked for a recording (`agency_manual_calls.recording_requested`). */
  recording_requested: boolean;
  dialed_at: Date | null;
  ended_at: Date | null;
  talk_seconds: number | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: Date | null;
  created_at: Date;
  at: string;
}

/** A callback booked on a call (campaign or soft phone). `at` is when it was booked, microseconds. */
export interface CustomerHistoryCallbackRow {
  channel: 'campaign' | 'softphone';
  /** The call it was booked on (attempt or manual call id). */
  id: string;
  account_id: string;
  campaign_id: string | null;
  callback_at: Date;
  /** Who booked it: the dispositioning user, else the call's agent. */
  booked_by_user_id: string | null;
  at: string;
}

export interface CustomerHistoryDncRow {
  id: string;
  account_id: string | null;
  campaign_id: string | null;
  /** The account the entry belongs to: its own, else its campaign's; NULL = tenant-wide. */
  effective_account_id: string | null;
  source: string;
  reason: string | null;
  added_by: string | null;
  created_at: Date;
  at: string;
}

export interface CustomerHistoryMediaLegRow {
  id: string;
  recording_url: string | null;
}

export interface CustomerHistoryUploadRow {
  campaign_id: string;
  file_name: string;
  /** The import's retained columns in file order (`agency_ingest_jobs.context_columns`). */
  context_columns: string[] | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

/** The number's calls, aggregated: the summary's totals and filter options, and the audit's count. */
export interface CustomerHistoryCallStatsRow {
  /** Roster rows carrying the number (each a `roster_entry`). */
  contact_entries: number;
  /** Campaign attempts and soft-phone calls (each a call entry). */
  call_entries: number;
  /** Calls with a callback booked (each a `callback` entry). */
  callback_entries: number;
  /** Placed calls (`dialed_at` set) and, of them, connected. */
  calls: number;
  connected: number;
  agent_ids: string[];
  outcomes: string[];
  disposition_codes: string[];
  /** Every campaign a roster row or a soft-phone call names. */
  campaign_ids: string[];
}

export interface CustomerHistoryLastPlacedRow {
  channel: 'campaign' | 'softphone';
  id: string;
  dialed_at: Date;
  agent_user_id: string | null;
  outcome: string | null;
  disposition_code: string | null;
}

export interface CustomerHistoryLiveCallRow {
  channel: 'campaign' | 'softphone';
  id: string;
  campaign_id: string | null;
  agent_user_id: string | null;
  started_at: Date;
}

export interface CustomerHistoryBookingRow {
  contact_id: string;
  booked_by_user_id: string | null;
}

/**
 * The most roster rows the SUMMARY lists. A number pasted into a roster thousands of times (a
 * placeholder like `9999999999`) must not turn one search into a list of every copy; newest
 * first, so what is cut is the oldest. The answer says so (`contacts_truncated`). The timeline
 * pages through every row whatever this is.
 */
export const CUSTOMER_HISTORY_MAX_CONTACT_ROWS = 2000;

/** The live call states: dialled and not ended (`queued` has not been dialled). */
const CUSTOMER_HISTORY_LIVE_STATES = ['dialing', 'ringing', 'answered', 'bridged'] as const;

/** Above every id gen_random_uuid() mints (a v4 id's 13th digit is `4`), and below none. */
export const UUID_MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
export const UUID_NIL = '00000000-0000-0000-0000-000000000000';

const BOOKED = (alias: string) => `COALESCE(${alias}.dispositioned_at, ${alias}.ended_at, ${alias}.created_at)`;

/** The number's roster rows in the visible accounts. $1 tenant, $2 phone, $3 accounts. */
const CONTACTS_CTE = `
    ct AS MATERIALIZED (
      SELECT c.id, c.campaign_id FROM agency_contacts c
       WHERE c.tenant_id = $1::uuid AND c.phone_e164 = $2::text AND c.account_id = ANY($3::uuid[]))`;

/**
 * The number's soft-phone calls in the visible accounts: dialled to it, or logged to one of its
 * contacts (UNION: a call that is both is one row). Needs {@link CONTACTS_CTE}.
 */
const MANUAL_CTE = `
    mc AS MATERIALIZED (
      SELECT m.id FROM agency_manual_calls m
       WHERE m.tenant_id = $1::uuid AND m.account_id = ANY($3::uuid[]) AND m.destination_e164 = $2::text
      UNION
      SELECT m.id FROM agency_manual_calls m
       WHERE m.contact_id IN (SELECT id FROM ct) AND m.tenant_id = $1::uuid AND m.account_id = ANY($3::uuid[]))`;

/** The number's campaign attempts (alias `a`, its session `s`). Needs {@link CONTACTS_CTE}. */
const ATTEMPTS_FROM = `
      FROM agency_call_attempts a
      LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
     WHERE a.contact_id IN (SELECT id FROM ct)
       AND a.tenant_id = $1::uuid
       AND a.account_id = ANY($3::uuid[])`;

/**
 * A timeline source's keyset and shared filters. $4 cursor instant (`infinity` for the first
 * page), $5 cursor id (see `sourceBound` in the service: the cursor's own id for the cursor's
 * kind, {@link UUID_MAX} or {@link UUID_NIL} for a kind before or after it), $6 the limit,
 * $7 `from` / $8 `to` (NULL = open), $9 the root campaigns (NULL = any; a row with no campaign
 * then never matches).
 */
const keyset = (at: string, id: string) => `(${at}, ${id}) < ($4::timestamptz, $5::uuid)`;
const timeWindow = (at: string) =>
  `($7::timestamptz IS NULL OR ${at} >= $7::timestamptz) AND ($8::timestamptz IS NULL OR ${at} < $8::timestamptz)`;
const rootOf = (campaignId: string) => `($9::uuid[] IS NULL OR EXISTS (
         SELECT 1 FROM agency_campaigns g9 WHERE g9.id = ${campaignId} AND COALESCE(g9.root_campaign_id, g9.id) = ANY($9::uuid[])))`;
/**
 * The call-only filters: $10 outcomes, $11 disposition codes, $12 agents (NULL = any), $13
 * connected only. `agentIn` is the condition "the call's agent is in $12".
 */
const callFilters = (alias: string, agentIn: string) => `($10::text[] IS NULL OR ${alias}.outcome = ANY($10::text[]))
       AND ($11::text[] IS NULL OR ${alias}.disposition_code = ANY($11::text[]))
       AND ($12::uuid[] IS NULL OR ${agentIn})
       AND (NOT $13::boolean OR ${alias}.outcome = 'connected')`;
/** An attempt's agent is its reserved session's. */
const ATTEMPT_AGENT_IN = `EXISTS (
         SELECT 1 FROM agency_agent_sessions s12 WHERE s12.id = a.reserved_agent_id AND s12.agent_user_id = ANY($12::uuid[]))`;
const MANUAL_AGENT_IN = 'm.agent_user_id = ANY($12::uuid[])';

const CONTACT_COLUMNS = `c.id, c.root_contact_id, c.campaign_id, c.account_id, c.phone_e164, c.context, c.state,
           c.suppressed_reason, c.last_outcome, c.last_disposition, c.next_attempt_at,
           c.assigned_user_id, c.override_disposition, c.override_extra_attempts,
           c.override_retry_delay, c.override_calling_hours, c.override_granted_at, c.created_at,
           ${keysetAtSql('c.created_at')} AS at`;

const MANUAL_COLUMNS = `m.id, m.account_id, m.agent_user_id, m.campaign_id, m.contact_id, m.webrtc_call_id,
           m.destination_e164, m.state, m.outcome, m.disposition_code, m.notes, m.callback_at,
           m.fields, m.dnc_override_note, m.hours_override_note, m.recording_requested, m.dialed_at,
           m.ended_at, m.talk_seconds, m.dispositioned_by_user_id, m.dispositioned_at, m.created_at,
           ${keysetAtSql('m.created_at')} AS at`;

/**
 * A DNC entry the caller may see: tenant-wide (no account, no campaign), on a visible account,
 * or on a campaign of a visible account. `g` is the entry's campaign (LEFT JOIN).
 */
const DNC_VISIBLE = `((d.account_id IS NULL AND d.campaign_id IS NULL)
        OR d.account_id = ANY($3::uuid[])
        OR (d.account_id IS NULL AND g.account_id = ANY($3::uuid[])))`;
const DNC_COLUMNS = `d.id, d.account_id, d.campaign_id, COALESCE(d.account_id, g.account_id) AS effective_account_id,
           d.source, d.reason, d.added_by, d.created_at, ${keysetAtSql('d.created_at')} AS at`;

/** The redial chain's first attempt: follow `redial_of_attempt_id` back (bounded). */
const CHAIN_SQL = `CASE WHEN a.redial_of_attempt_id IS NULL THEN a.id ELSE COALESCE((
             WITH RECURSIVE up(id, prev, depth) AS (
               SELECT p.id, p.redial_of_attempt_id, 1 FROM agency_call_attempts p
                WHERE p.id = a.redial_of_attempt_id AND p.tenant_id = $1::uuid
               UNION ALL
               SELECT p.id, p.redial_of_attempt_id, up.depth + 1 FROM up
                 JOIN agency_call_attempts p ON p.id = up.prev AND p.tenant_id = $1::uuid
                WHERE up.depth < 16)
             SELECT up.id FROM up ORDER BY up.depth DESC LIMIT 1), a.redial_of_attempt_id) END`;

/** The statements, exported so the plan test runs exactly what the repository runs. */
export const CUSTOMER_HISTORY_SQL = {
  // ─── The summary ────────────────────────────────────────────────────────────

  /**
   * The summary's roster rows, newest first, with each row's placed attempts:
   * `idx_agency_contacts_phone`. $1 tenant, $2 phone, $3 accounts, $4 cap.
   */
  summaryContacts: `
    SELECT ${CONTACT_COLUMNS},
           (SELECT count(*) FROM agency_call_attempts a
             WHERE a.contact_id = c.id AND a.dialed_at IS NOT NULL
               AND a.tenant_id = $1::uuid AND a.account_id = ANY($3::uuid[]))::int AS placed
      FROM agency_contacts c
     WHERE c.tenant_id = $1::uuid
       AND c.phone_e164 = $2::text
       AND c.account_id = ANY($3::uuid[])
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $4::int`,

  /** The number's calls aggregated (see {@link CustomerHistoryCallStatsRow}). $1 tenant, $2 phone, $3 accounts. */
  callStats: `
    WITH ${CONTACTS_CTE},${MANUAL_CTE},
    calls AS (
      SELECT a.dialed_at, a.outcome, a.disposition_code, s.agent_user_id AS agent, a.callback_at
      ${ATTEMPTS_FROM}
      UNION ALL
      SELECT m.dialed_at, m.outcome, m.disposition_code, m.agent_user_id, m.callback_at
        FROM agency_manual_calls m WHERE m.id IN (SELECT id FROM mc))
    SELECT (SELECT count(*) FROM ct)::int AS contact_entries,
           count(*)::int AS call_entries,
           count(callback_at)::int AS callback_entries,
           (count(*) FILTER (WHERE dialed_at IS NOT NULL))::int AS calls,
           (count(*) FILTER (WHERE dialed_at IS NOT NULL AND outcome = 'connected'))::int AS connected,
           COALESCE(array_agg(DISTINCT agent::text) FILTER (WHERE agent IS NOT NULL), '{}') AS agent_ids,
           COALESCE(array_agg(DISTINCT outcome::text) FILTER (WHERE outcome IS NOT NULL), '{}') AS outcomes,
           COALESCE(array_agg(DISTINCT disposition_code::text) FILTER (WHERE disposition_code IS NOT NULL), '{}') AS disposition_codes,
           ARRAY(SELECT DISTINCT x::text FROM (
             SELECT campaign_id AS x FROM ct
             UNION SELECT m.campaign_id FROM agency_manual_calls m
                    WHERE m.id IN (SELECT id FROM mc) AND m.campaign_id IS NOT NULL) u) AS campaign_ids
      FROM calls`,

  /** The newest placed call to the number, either channel. $1 tenant, $2 phone, $3 accounts. */
  lastPlaced: `
    WITH ${CONTACTS_CTE},${MANUAL_CTE}
    SELECT * FROM (
      SELECT 'campaign' AS channel, a.id, a.dialed_at, s.agent_user_id, a.outcome, a.disposition_code
      ${ATTEMPTS_FROM} AND a.dialed_at IS NOT NULL
      UNION ALL
      SELECT 'softphone', m.id, m.dialed_at, m.agent_user_id, m.outcome, m.disposition_code
        FROM agency_manual_calls m WHERE m.id IN (SELECT id FROM mc) AND m.dialed_at IS NOT NULL) x
     ORDER BY x.dialed_at DESC, x.id DESC
     LIMIT 1`,

  /** Calls to the number dialled and not ended. $1 tenant, $2 phone, $3 accounts. */
  liveCalls: `
    WITH ${CONTACTS_CTE},${MANUAL_CTE}
    SELECT 'campaign' AS channel, a.id, a.campaign_id, s.agent_user_id, COALESCE(a.dialed_at, a.created_at) AS started_at
    ${ATTEMPTS_FROM} AND a.state IN ('${CUSTOMER_HISTORY_LIVE_STATES.join("', '")}')
    UNION ALL
    SELECT 'softphone', m.id, m.campaign_id, m.agent_user_id, COALESCE(m.dialed_at, m.created_at)
      FROM agency_manual_calls m
     WHERE m.id IN (SELECT id FROM mc) AND m.state IN ('${CUSTOMER_HISTORY_LIVE_STATES.join("', '")}')`,

  /**
   * Who booked each contact's latest callback (campaign or soft phone): by contact id
   * (`uq_agency_attempt_number`, `idx_agency_manual_calls_contact_history`). $1 tenant,
   * $2 accounts, $3 contact ids.
   */
  latestBookings: `
    SELECT DISTINCT ON (x.contact_id) x.contact_id, x.booked_by_user_id FROM (
      SELECT a.contact_id, COALESCE(a.dispositioned_by_user_id, s.agent_user_id) AS booked_by_user_id,
             ${BOOKED('a')} AS booked, a.id
        FROM agency_call_attempts a
        LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
       WHERE a.contact_id = ANY($3::uuid[]) AND a.callback_at IS NOT NULL
         AND a.tenant_id = $1::uuid AND a.account_id = ANY($2::uuid[])
      UNION ALL
      SELECT m.contact_id, COALESCE(m.dispositioned_by_user_id, m.agent_user_id), ${BOOKED('m')}, m.id
        FROM agency_manual_calls m
       WHERE m.contact_id = ANY($3::uuid[]) AND m.callback_at IS NOT NULL
         AND m.tenant_id = $1::uuid AND m.account_id = ANY($2::uuid[])) x
     ORDER BY x.contact_id, x.booked DESC, x.id DESC`,

  /** Every DNC entry covering the number that the caller may see: `idx_dnc_entries_tenant_phone`. $1 tenant, $2 phone, $3 accounts. */
  dnc: `
    SELECT ${DNC_COLUMNS}
      FROM dnc_entries d
      LEFT JOIN agency_campaigns g ON g.id = d.campaign_id AND g.tenant_id = $1::uuid
     WHERE d.tenant_id = $1::uuid
       AND d.phone_e164 = $2::text
       AND ${DNC_VISIBLE}
     ORDER BY d.created_at DESC, d.id DESC`,

  // ─── Timeline pages: one keyset statement per source ────────────────────────

  /**
   * Campaign attempts (`campaign_call`). $1–$13 (see {@link keyset}, {@link callFilters}). The
   * page's ids first (the number's attempts by contact, filtered, top `n` by the order), then
   * each one's row, campaign, session and redial chain by primary key: the joins run per page
   * row, not per attempt of the number.
   */
  pageAttempts: `
    WITH ${CONTACTS_CTE},
    heads AS (
      SELECT a.id FROM agency_call_attempts a
       WHERE a.contact_id IN (SELECT id FROM ct)
         AND a.tenant_id = $1::uuid
         AND a.account_id = ANY($3::uuid[])
         AND ${keyset('a.created_at', 'a.id')}
         AND ${timeWindow('a.created_at')}
         AND ${rootOf('a.campaign_id')}
         AND ${callFilters('a', ATTEMPT_AGENT_IN)}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $6::int)
    SELECT a.id, a.contact_id, a.campaign_id, a.account_id, a.attempt_number, a.webrtc_call_id,
           s.agent_user_id, a.state, a.outcome, a.disposition_code, a.notes, a.callback_at,
           a.dialed_at, a.ended_at, a.talk_seconds, a.dispositioned_by_user_id, a.dispositioned_at,
           a.redial_of_attempt_id, ${CHAIN_SQL} AS chain_attempt_id, a.redial_number,
           a.override_applied, a.override_note, g.record_calls, a.created_at,
           ${keysetAtSql('a.created_at')} AS at
      FROM heads
      JOIN agency_call_attempts a ON a.id = heads.id
      JOIN agency_campaigns g ON g.id = a.campaign_id
      LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
     ORDER BY a.created_at DESC, a.id DESC`,

  /** Callbacks booked on campaign attempts (`callback`), at their booking instant. $1–$9. */
  pageAttemptCallbacks: `
    WITH ${CONTACTS_CTE}
    SELECT 'campaign' AS channel, a.id, a.account_id, a.campaign_id, a.callback_at,
           COALESCE(a.dispositioned_by_user_id, s.agent_user_id) AS booked_by_user_id,
           ${keysetAtSql(BOOKED('a'))} AS at
    ${ATTEMPTS_FROM}
       AND a.callback_at IS NOT NULL
       AND ${keyset(BOOKED('a'), 'a.id')}
       AND ${timeWindow(BOOKED('a'))}
       AND ${rootOf('a.campaign_id')}
     ORDER BY ${BOOKED('a')} DESC, a.id DESC
     LIMIT $6::int`,

  /**
   * Soft-phone calls (`softphone_call`): `idx_agency_manual_calls_destination` walked per visible
   * account and `idx_agency_manual_calls_contact_history` per contact, each in keyset order with
   * the cursor in the index condition and its own `LIMIT`, then the heads merged. $1–$13.
   */
  pageManualCalls: `
    WITH ${CONTACTS_CTE},
    picked AS (
      SELECT d.id, d.created_at FROM unnest($3::uuid[]) AS acc(id)
      CROSS JOIN LATERAL (
        SELECT m.id, m.created_at FROM agency_manual_calls m
         WHERE m.tenant_id = $1::uuid AND m.account_id = acc.id AND m.destination_e164 = $2::text
           AND ${keyset('m.created_at', 'm.id')}
           AND ${timeWindow('m.created_at')}
           AND ${rootOf('m.campaign_id')}
           AND ${callFilters('m', MANUAL_AGENT_IN)}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $6::int) d
      UNION
      SELECT l.id, l.created_at FROM ct
      CROSS JOIN LATERAL (
        SELECT m.id, m.created_at FROM agency_manual_calls m
         WHERE m.contact_id = ct.id AND m.tenant_id = $1::uuid AND m.account_id = ANY($3::uuid[])
           AND ${keyset('m.created_at', 'm.id')}
           AND ${timeWindow('m.created_at')}
           AND ${rootOf('m.campaign_id')}
           AND ${callFilters('m', MANUAL_AGENT_IN)}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $6::int) l)
    SELECT ${MANUAL_COLUMNS}
      FROM (SELECT p.id FROM picked p ORDER BY p.created_at DESC, p.id DESC LIMIT $6::int) heads
      JOIN agency_manual_calls m ON m.id = heads.id
     ORDER BY m.created_at DESC, m.id DESC`,

  /** Callbacks booked on soft-phone calls (`callback`), at their booking instant. $1–$9. */
  pageManualCallbacks: `
    WITH ${CONTACTS_CTE},${MANUAL_CTE}
    SELECT 'softphone' AS channel, m.id, m.account_id, m.campaign_id, m.callback_at,
           COALESCE(m.dispositioned_by_user_id, m.agent_user_id) AS booked_by_user_id,
           ${keysetAtSql(BOOKED('m'))} AS at
      FROM agency_manual_calls m
     WHERE m.id IN (SELECT id FROM mc)
       AND m.callback_at IS NOT NULL
       AND ${keyset(BOOKED('m'), 'm.id')}
       AND ${timeWindow(BOOKED('m'))}
       AND ${rootOf('m.campaign_id')}
     ORDER BY ${BOOKED('m')} DESC, m.id DESC
     LIMIT $6::int`,

  /** DNC marks (`dnc_mark`). $1–$9. */
  pageDnc: `
    SELECT ${DNC_COLUMNS}
      FROM dnc_entries d
      LEFT JOIN agency_campaigns g ON g.id = d.campaign_id AND g.tenant_id = $1::uuid
     WHERE d.tenant_id = $1::uuid
       AND d.phone_e164 = $2::text
       AND ${DNC_VISIBLE}
       AND ${keyset('d.created_at', 'd.id')}
       AND ${timeWindow('d.created_at')}
       AND ($9::uuid[] IS NULL OR COALESCE(g.root_campaign_id, g.id) = ANY($9::uuid[]))
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT $6::int`,

  /** Roster rows (`roster_entry`): `idx_agency_contacts_phone`. $1–$9. */
  pageContacts: `
    SELECT ${CONTACT_COLUMNS}
      FROM agency_contacts c
      JOIN agency_campaigns g ON g.id = c.campaign_id
     WHERE c.tenant_id = $1::uuid
       AND c.phone_e164 = $2::text
       AND c.account_id = ANY($3::uuid[])
       AND ${keyset('c.created_at', 'c.id')}
       AND ${timeWindow('c.created_at')}
       AND ($9::uuid[] IS NULL OR COALESCE(g.root_campaign_id, g.id) = ANY($9::uuid[]))
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $6::int`,

  // ─── Enrichment, by primary key ─────────────────────────────────────────────

  /**
   * Each booked callback's next placed call to the number (either channel, not the booking
   * call, dialled after the booking): the callback's status. $1 tenant, $2 phone, $3 accounts,
   * $4 booking call ids, $5 their booking instants (microseconds).
   */
  callbackNext: `
    WITH ${CONTACTS_CTE},${MANUAL_CTE},
    placed AS MATERIALIZED (
      SELECT a.id, a.dialed_at ${ATTEMPTS_FROM} AND a.dialed_at IS NOT NULL
      UNION ALL
      SELECT m.id, m.dialed_at FROM agency_manual_calls m WHERE m.id IN (SELECT id FROM mc) AND m.dialed_at IS NOT NULL)
    SELECT b.id::text AS id,
           (SELECT min(p.dialed_at) FROM placed p WHERE p.dialed_at > b.booked AND p.id <> b.id) AS next_dialed_at
      FROM unnest($4::uuid[], $5::timestamptz[]) AS b(id, booked)`,

  /** Campaigns by id (primary key). $1 tenant, $2 accounts, $3 ids. */
  campaigns: `
    SELECT g.id, g.account_id, g.name, g.status, COALESCE(g.root_campaign_id, g.id) AS root_id,
           g.retry_generation, g.context_display, g.disposition_catalog
      FROM agency_campaigns g
     WHERE g.id = ANY($3::uuid[])
       AND g.tenant_id = $1::uuid
       AND g.account_id = ANY($2::uuid[])`,

  /** The calls' media legs (primary key): present or purged, and recorded or not. $1 tenant, $2 accounts, $3 ids. */
  mediaLegs: `
    SELECT k.id, k.recording_url
      FROM agency_calls k
     WHERE k.id = ANY($3::uuid[])
       AND k.tenant_id = $1::uuid
       AND k.account_id = ANY($2::uuid[])`,

  /**
   * The campaigns' real roster imports: `idx_agency_ingest_jobs_campaign`. Scoped by the
   * campaign's account, not the job's (the job carries the uploader's membership account, NULL
   * for a tenant-level member). $1 tenant, $2 accounts, $3 campaign ids.
   */
  uploads: `
    SELECT j.campaign_id, j.file_name, j.context_columns, j.started_at, j.finished_at, j.created_at
      FROM agency_ingest_jobs j
      JOIN agency_campaigns g ON g.id = j.campaign_id AND g.id = ANY($3::uuid[])
                             AND g.tenant_id = $1::uuid AND g.account_id = ANY($2::uuid[])
     WHERE j.campaign_id = ANY($3::uuid[])
       AND j.tenant_id = $1::uuid
       AND j.dry_run = false
     ORDER BY j.created_at ASC`,
} as const;

/** One timeline source's bounds and filters (`$4`–`$13`). */
export interface CustomerHistoryPageQuery {
  /** The cursor instant (microseconds) or `infinity`. */
  cursorAt: string;
  /** The cursor id for this source's kind (see `sourceBound`). */
  cursorId: string;
  limit: number;
  from: string | null;
  to: string | null;
  campaignRoots: readonly string[] | null;
  outcomes: readonly string[] | null;
  dispositionCodes: readonly string[] | null;
  agentUserIds: readonly string[] | null;
  connectedOnly: boolean;
}

const noIds = (ids: readonly string[]) => ids.length === 0;
const orNull = (list: readonly string[] | null) => (list && list.length > 0 ? [...list] : null);

function baseParams(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): unknown[] {
  return [scope.tenantId, phone, scope.accountIds, q.cursorAt, q.cursorId, q.limit, q.from, q.to, orNull(q.campaignRoots)];
}

function callParams(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): unknown[] {
  return [...baseParams(scope, phone, q), orNull(q.outcomes), orNull(q.dispositionCodes), orNull(q.agentUserIds), q.connectedOnly];
}

const attemptRow = (r: CustomerHistoryAttemptRow): CustomerHistoryAttemptRow => ({
  ...r,
  redial_number: Number(r.redial_number),
  override_applied: Array.isArray(r.override_applied) ? r.override_applied : [],
});

export class AgencyCustomerHistoryRepository {
  // ─── The summary ──────────────────────────────────────────────────────────

  /** The summary's roster rows carrying `phone`, newest first, at most `cap`. */
  async summaryContacts(scope: CustomerHistoryScope, phone: string, cap: number): Promise<CustomerHistorySummaryContactRow[]> {
    if (noIds(scope.accountIds)) return [];
    const { rows } = await getPool().query<CustomerHistorySummaryContactRow>(CUSTOMER_HISTORY_SQL.summaryContacts, [
      scope.tenantId, phone, scope.accountIds, cap,
    ]);
    return rows;
  }

  async callStats(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryCallStatsRow> {
    const empty: CustomerHistoryCallStatsRow = {
      contact_entries: 0, call_entries: 0, callback_entries: 0, calls: 0, connected: 0,
      agent_ids: [], outcomes: [], disposition_codes: [], campaign_ids: [],
    };
    if (noIds(scope.accountIds)) return empty;
    const { rows } = await getPool().query<CustomerHistoryCallStatsRow>(CUSTOMER_HISTORY_SQL.callStats, [
      scope.tenantId, phone, scope.accountIds,
    ]);
    return rows[0] ?? empty;
  }

  async lastPlaced(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryLastPlacedRow | null> {
    if (noIds(scope.accountIds)) return null;
    const { rows } = await getPool().query<CustomerHistoryLastPlacedRow>(CUSTOMER_HISTORY_SQL.lastPlaced, [
      scope.tenantId, phone, scope.accountIds,
    ]);
    return rows[0] ?? null;
  }

  async liveCalls(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryLiveCallRow[]> {
    if (noIds(scope.accountIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryLiveCallRow>(CUSTOMER_HISTORY_SQL.liveCalls, [
      scope.tenantId, phone, scope.accountIds,
    ]);
    return rows;
  }

  async latestBookings(scope: CustomerHistoryScope, contactIds: readonly string[]): Promise<CustomerHistoryBookingRow[]> {
    if (noIds(scope.accountIds) || noIds(contactIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryBookingRow>(CUSTOMER_HISTORY_SQL.latestBookings, [
      scope.tenantId, scope.accountIds, [...new Set(contactIds)],
    ]);
    return rows;
  }

  /** Every DNC entry covering the number the caller may see; tenant-wide ones even with no visible account. */
  async dncForNumber(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryDncRow[]> {
    const { rows } = await getPool().query<CustomerHistoryDncRow>(CUSTOMER_HISTORY_SQL.dnc, [
      scope.tenantId, phone, scope.accountIds,
    ]);
    return rows;
  }

  // ─── Timeline pages ───────────────────────────────────────────────────────

  async pageAttempts(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryAttemptRow[]> {
    if (noIds(scope.accountIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryAttemptRow>(CUSTOMER_HISTORY_SQL.pageAttempts, callParams(scope, phone, q));
    return rows.map(attemptRow);
  }

  async pageAttemptCallbacks(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryCallbackRow[]> {
    if (noIds(scope.accountIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryCallbackRow>(CUSTOMER_HISTORY_SQL.pageAttemptCallbacks, baseParams(scope, phone, q));
    return rows;
  }

  async pageManualCalls(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryManualCallRow[]> {
    if (noIds(scope.accountIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryManualCallRow>(CUSTOMER_HISTORY_SQL.pageManualCalls, callParams(scope, phone, q));
    return rows;
  }

  async pageManualCallbacks(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryCallbackRow[]> {
    if (noIds(scope.accountIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryCallbackRow>(CUSTOMER_HISTORY_SQL.pageManualCallbacks, baseParams(scope, phone, q));
    return rows;
  }

  /** DNC marks; tenant-wide ones even with no visible account. */
  async pageDnc(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryDncRow[]> {
    const { rows } = await getPool().query<CustomerHistoryDncRow>(CUSTOMER_HISTORY_SQL.pageDnc, baseParams(scope, phone, q));
    return rows;
  }

  async pageContacts(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryContactRow[]> {
    if (noIds(scope.accountIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryContactRow>(CUSTOMER_HISTORY_SQL.pageContacts, baseParams(scope, phone, q));
    return rows;
  }

  // ─── Enrichment ───────────────────────────────────────────────────────────

  /** Each booking's next placed call (NULL: none yet), by booking call id. */
  async callbackNext(
    scope: CustomerHistoryScope,
    phone: string,
    bookings: ReadonlyArray<{ id: string; at: string }>,
  ): Promise<Map<string, Date | null>> {
    if (noIds(scope.accountIds) || bookings.length === 0) return new Map();
    const { rows } = await getPool().query<{ id: string; next_dialed_at: Date | null }>(CUSTOMER_HISTORY_SQL.callbackNext, [
      scope.tenantId, phone, scope.accountIds, bookings.map((b) => b.id), bookings.map((b) => b.at),
    ]);
    return new Map(rows.map((r) => [r.id, r.next_dialed_at]));
  }

  async campaignsByIds(scope: CustomerHistoryScope, ids: readonly string[]): Promise<CustomerHistoryCampaignRow[]> {
    if (noIds(scope.accountIds) || noIds(ids)) return [];
    const { rows } = await getPool().query<CustomerHistoryCampaignRow>(CUSTOMER_HISTORY_SQL.campaigns, [
      scope.tenantId, scope.accountIds, [...new Set(ids)],
    ]);
    return rows.map((r) => ({ ...r, retry_generation: Number(r.retry_generation) }));
  }

  async mediaLegs(scope: CustomerHistoryScope, callIds: readonly string[]): Promise<CustomerHistoryMediaLegRow[]> {
    if (noIds(scope.accountIds) || noIds(callIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryMediaLegRow>(CUSTOMER_HISTORY_SQL.mediaLegs, [
      scope.tenantId, scope.accountIds, [...new Set(callIds)],
    ]);
    return rows;
  }

  async uploads(scope: CustomerHistoryScope, campaignIds: readonly string[]): Promise<CustomerHistoryUploadRow[]> {
    if (noIds(scope.accountIds) || noIds(campaignIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryUploadRow>(CUSTOMER_HISTORY_SQL.uploads, [
      scope.tenantId, scope.accountIds, [...new Set(campaignIds)],
    ]);
    return rows;
  }
}

export const agencyCustomerHistoryRepository = new AgencyCustomerHistoryRepository();
