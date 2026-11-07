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
 * ── The newest 2,000 roster rows (CH14) ─────────────────────────────────────────
 * Every read covers the number's newest {@link CUSTOMER_HISTORY_MAX_CONTACT_ROWS} roster rows in
 * the visible accounts and no others: the summary, the aggregates, every timeline source that
 * reaches calls through a contact, and the export. They are chosen by an index walk that stops at
 * the cap ({@link newestContacts}), so a placeholder number pasted down a roster costs at most
 * `accounts × cap` index entries per statement, never one per roster row. Soft-phone calls dialled
 * to the number are found by destination whatever their contact, so the cap does not bound them;
 * they are walked per account on their own index. Past the cap the summary says
 * `contacts_truncated`.
 *
 * ── Two kinds of read ───────────────────────────────────────────────────────────
 *  - **The summary** (once, at search time): the roster rows (newest first, capped), the DNC
 *    entries, and SQL aggregates over the number's calls (totals, the newest placed call, what
 *    is live, the filter options, how many timeline entries there are). No call row is shipped
 *    to build it.
 *  - **A timeline page**: one keyset statement per source (campaign calls, soft-phone calls,
 *    callbacks booked on either, DNC marks, roster rows), each taking the
 *    cursor, every filter it can apply, and `LIMIT n + 1`; the service merges their heads and keeps
 *    the top `n` (`agency/customer-history/service.ts`). A page reads O(page) rows per source, plus
 *    the index entries of the number's own rows where the source has no index in timeline order
 *    (below). Then the page's rows are enriched by primary key (campaigns, media legs, names) and
 *    its callbacks judged ({@link CUSTOMER_HISTORY_SQL}.`callbackNext`).
 *
 * ── Every read uses an index (CH9) ─────────────────────────────────────────────
 *  - contacts: `idx_agency_contacts_customer_history (tenant_id, account_id, phone_e164,
 *    created_at DESC, id DESC) INCLUDE (campaign_id)` (migration 0017), walked once per visible
 *    account newest first and stopped at the cap, an exact match on E.164;
 *  - attempts: `uq_agency_attempt_number (contact_id, attempt_number)` by the number's (capped)
 *    contacts, then a top-N sort over their attempts (no index orders attempts by contact and time);
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
import type { QueryResultRow } from 'pg';
import { getPool } from '@magick-agency/db';
import { keysetAtSql } from '@magick-agency/domain/keyset-cursor';
import { AGENCY_ATTEMPT_LIVE_STATES } from '../../models/agency.model.js';

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

/**
 * A callback booked on a call (campaign or soft phone). `at` is the booking call's `created_at`,
 * microseconds: its timeline position, which a re-booking never moves.
 */
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
  /** When it was (last) booked: the disposition, else the call's end, else its start; microseconds. Judges it, never orders it. */
  booked_at: string;
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
  /** Roster rows carrying the number that the history covers (each a `roster_entry`; at most the cap). */
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
  /**
   * The booker's display name by `agentNamesOrNone`'s rule (display name, else email; a member of the
   * tenant, not deleted); NULL when there is no booker or they cannot be named.
   */
  booked_by_name: string | null;
}

/**
 * The most roster rows of one number the history covers (CH14). A number pasted into a roster
 * thousands of times (a placeholder like `9999999999`) must not make every read of the history
 * O(roster rows): the summary, the aggregates, the timeline and the export all read the newest
 * this many rows and no older one (what is cut is the oldest). The summary says so
 * (`contacts_truncated`).
 */
export const CUSTOMER_HISTORY_MAX_CONTACT_ROWS = 2000;

/**
 * The live call states: dialled and not ended (`queued` has not been dialled). One list for both
 * channels: a soft-phone call's state is an attempt state (`AgencyManualCallState`).
 */
const LIVE_STATES_SQL = AGENCY_ATTEMPT_LIVE_STATES
  .filter((state) => state !== 'queued')
  .map((state) => `'${state}'`)
  .join(', ');

/** Above every id gen_random_uuid() mints (a v4 id's 13th digit is `4`), and below none. */
export const UUID_MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
export const UUID_NIL = '00000000-0000-0000-0000-000000000000';

/**
 * When a callback was booked: the disposition, else the call's end, else its start. MUTABLE (a
 * same-code re-disposition or an outcome override rewrites `dispositioned_at`), so it judges the
 * callback (the next call placed after it) and is never a keyset position: a callback entry is
 * ordered and paged on its call's `created_at`, which nothing rewrites.
 */
const BOOKED = (alias: string) => `COALESCE(${alias}.dispositioned_at, ${alias}.ended_at, ${alias}.created_at)`;

/**
 * The number's newest roster rows in the visible accounts, at most `limit` (CH14): each visible
 * account's slice of `idx_agency_contacts_customer_history` walked newest first and stopped at
 * `limit` (no sort, the walk ends early), then the newest `limit` of those (a top-N over at most
 * `accounts × limit` rows). `columns` of contact `c` (default `id`, `campaign_id`, `created_at`,
 * all in the index; they must include `id` and `created_at`). $1 tenant, $2 phone, $3 accounts
 * (distinct: the viewer's account map's keys).
 */
const newestContacts = (limit: string, columns = 'c.id, c.campaign_id, c.created_at') => `
      SELECT w.* FROM unnest($3::uuid[]) AS acc(id)
      CROSS JOIN LATERAL (
        SELECT ${columns} FROM agency_contacts c
         WHERE c.tenant_id = $1::uuid AND c.account_id = acc.id AND c.phone_e164 = $2::text
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT ${limit}) w
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT ${limit}`;

/** The roster rows the history covers: {@link newestContacts} at the cap. $1 tenant, $2 phone, $3 accounts. */
const CONTACTS_CTE = `
    ct AS MATERIALIZED (${newestContacts(String(CUSTOMER_HISTORY_MAX_CONTACT_ROWS))})`;

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

/** The number's soft-phone calls (alias `m`). Needs {@link MANUAL_CTE}. */
const MANUAL_FROM = `
      FROM agency_manual_calls m
     WHERE m.id IN (SELECT id FROM mc)`;

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
/** Campaign `g` is, or is a retry of, one of the root campaigns $9. */
const inRoots = (g: string) => `COALESCE(${g}.root_campaign_id, ${g}.id) = ANY($9::uuid[])`;
const rootOf = (campaignId: string) => `($9::uuid[] IS NULL OR EXISTS (
         SELECT 1 FROM agency_campaigns g9 WHERE g9.id = ${campaignId} AND ${inRoots('g9')}))`;
/** {@link rootOf} for a row whose campaign is joined as `g`. */
const ROOT_OF_G = `($9::uuid[] IS NULL OR ${inRoots('g')})`;
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

/** One soft-phone index walk's filters and its own top `n` (both arms of `pageManualCalls`). */
const MANUAL_WALK_TAIL = `
           AND ${keyset('m.created_at', 'm.id')}
           AND ${timeWindow('m.created_at')}
           AND ${rootOf('m.campaign_id')}
           AND ${callFilters('m', MANUAL_AGENT_IN)}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $6::int`;

/**
 * One channel's arm of `pageCallbacks`: the calls (alias `x`, read `from`) with a callback booked,
 * at their call's `created_at` (immutable: re-booking rewrites `dispositioned_at`, and a keyset
 * position that moves is an entry skipped or shown twice), after the cursor, top `n` of their
 * own. `booked_at` is {@link BOOKED}, for judging the callback only. `bookedBy`: who booked it.
 */
const callbackArm = (channel: 'campaign' | 'softphone', x: string, from: string, bookedBy: string) => `
      (SELECT '${channel}' AS channel, ${x}.id, ${x}.account_id, ${x}.campaign_id, ${x}.callback_at,
              ${bookedBy} AS booked_by_user_id, ${x}.created_at AS created, ${keysetAtSql(`${x}.created_at`)} AS at,
              ${keysetAtSql(BOOKED(x))} AS booked_at
       ${from}
         AND ${x}.callback_at IS NOT NULL
         AND ${keyset(`${x}.created_at`, `${x}.id`)}
         AND ${timeWindow(`${x}.created_at`)}
         AND ${rootOf(`${x}.campaign_id`)}
       ORDER BY ${x}.created_at DESC, ${x}.id DESC
       LIMIT $6::int)`;

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

const CAMPAIGN_COLUMNS = `g.id, g.account_id, g.name, g.status, COALESCE(g.root_campaign_id, g.id) AS root_id,
           g.retry_generation, g.context_display, g.disposition_catalog`;

/**
 * The DNC entries covering the number that the caller may see: tenant-wide (no account, no
 * campaign), on a visible account, or on a campaign of a visible account. `g` is the entry's
 * campaign (LEFT JOIN). $1 tenant, $2 phone, $3 accounts.
 */
const DNC_FROM = `
      FROM dnc_entries d
      LEFT JOIN agency_campaigns g ON g.id = d.campaign_id AND g.tenant_id = $1::uuid
     WHERE d.tenant_id = $1::uuid
       AND d.phone_e164 = $2::text
       AND ((d.account_id IS NULL AND d.campaign_id IS NULL)
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
   * The summary's roster rows, newest first, with each row's placed attempts: {@link newestContacts}
   * (`idx_agency_contacts_customer_history`, each row read by the walk itself). $1 tenant,
   * $2 phone, $3 accounts, $4 how many (the cap + 1, to know there are more).
   */
  summaryContacts: `
    SELECT n.*,
           (SELECT count(*) FROM agency_call_attempts a
             WHERE a.contact_id = n.id AND a.dialed_at IS NOT NULL
               AND a.tenant_id = $1::uuid AND a.account_id = ANY($3::uuid[]))::int AS placed
      FROM (${newestContacts('$4::int', CONTACT_COLUMNS)}) n
     ORDER BY n.created_at DESC, n.id DESC`,

  /** The number's calls aggregated (see {@link CustomerHistoryCallStatsRow}). $1 tenant, $2 phone, $3 accounts. */
  callStats: `
    WITH ${CONTACTS_CTE},${MANUAL_CTE},
    calls AS (
      SELECT a.dialed_at, a.outcome, a.disposition_code, s.agent_user_id AS agent, a.callback_at
      ${ATTEMPTS_FROM}
      UNION ALL
      SELECT m.dialed_at, m.outcome, m.disposition_code, m.agent_user_id, m.callback_at ${MANUAL_FROM})
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
             UNION SELECT m.campaign_id ${MANUAL_FROM} AND m.campaign_id IS NOT NULL) u) AS campaign_ids
      FROM calls`,

  /** The newest placed call to the number, either channel. $1 tenant, $2 phone, $3 accounts. */
  lastPlaced: `
    WITH ${CONTACTS_CTE},${MANUAL_CTE}
    SELECT * FROM (
      SELECT 'campaign' AS channel, a.id, a.dialed_at, s.agent_user_id, a.outcome, a.disposition_code
      ${ATTEMPTS_FROM} AND a.dialed_at IS NOT NULL
      UNION ALL
      SELECT 'softphone', m.id, m.dialed_at, m.agent_user_id, m.outcome, m.disposition_code
      ${MANUAL_FROM} AND m.dialed_at IS NOT NULL) x
     ORDER BY x.dialed_at DESC, x.id DESC
     LIMIT 1`,

  /** Calls to the number dialled and not ended. $1 tenant, $2 phone, $3 accounts. */
  liveCalls: `
    WITH ${CONTACTS_CTE},${MANUAL_CTE}
    SELECT 'campaign' AS channel, a.id, a.campaign_id, s.agent_user_id, COALESCE(a.dialed_at, a.created_at) AS started_at
    ${ATTEMPTS_FROM} AND a.state IN (${LIVE_STATES_SQL})
    UNION ALL
    SELECT 'softphone', m.id, m.campaign_id, m.agent_user_id, COALESCE(m.dialed_at, m.created_at)
    ${MANUAL_FROM} AND m.state IN (${LIVE_STATES_SQL})`,

  /**
   * Who booked each contact's latest callback (campaign or soft phone), with their name: by
   * contact id (`uq_agency_attempt_number`, `idx_agency_manual_calls_contact_history`), the
   * name by primary key under `findDisplayNamesInTenant`'s rule (display name trimmed, else
   * email; only a user with a membership in the tenant who is not deleted), so the search needs
   * no second name lookup. $1 tenant, $2 accounts, $3 contact ids.
   */
  latestBookings: `
    SELECT b.contact_id, b.booked_by_user_id,
           (SELECT COALESCE(NULLIF(btrim(u.display_name, E' \\t\\n\\r\\f'), ''), u.email) FROM users u
             WHERE u.id = b.booked_by_user_id AND u.status <> 'deleted'
               AND EXISTS (SELECT 1 FROM memberships mm WHERE mm.user_id = u.id AND mm.tenant_id = $1::uuid)) AS booked_by_name
      FROM (
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
     ORDER BY x.contact_id, x.booked DESC, x.id DESC) b`,

  /** Every DNC entry covering the number that the caller may see: `idx_dnc_entries_tenant_phone`. $1 tenant, $2 phone, $3 accounts. */
  dnc: `
    SELECT ${DNC_COLUMNS}${DNC_FROM}
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

  /**
   * Callbacks booked on campaign attempts and on soft-phone calls (`callback`), at their call's
   * `created_at` (see {@link callbackArm}): each channel's top `n`, then the top `n` of both. $1–$9.
   */
  pageCallbacks: `
    WITH ${CONTACTS_CTE},${MANUAL_CTE}
    SELECT x.channel, x.id, x.account_id, x.campaign_id, x.callback_at, x.booked_by_user_id, x.at, x.booked_at
      FROM (${callbackArm('campaign', 'a', ATTEMPTS_FROM, 'COALESCE(a.dispositioned_by_user_id, s.agent_user_id)')}
      UNION ALL${callbackArm('softphone', 'm', MANUAL_FROM, 'COALESCE(m.dispositioned_by_user_id, m.agent_user_id)')}) x
     ORDER BY x.created DESC, x.id DESC
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
         WHERE m.tenant_id = $1::uuid AND m.account_id = acc.id AND m.destination_e164 = $2::text${MANUAL_WALK_TAIL}) d
      UNION
      SELECT l.id, l.created_at FROM ct
      CROSS JOIN LATERAL (
        SELECT m.id, m.created_at FROM agency_manual_calls m
         WHERE m.contact_id = ct.id AND m.tenant_id = $1::uuid AND m.account_id = ANY($3::uuid[])${MANUAL_WALK_TAIL}) l)
    SELECT ${MANUAL_COLUMNS}
      FROM (SELECT p.id FROM picked p ORDER BY p.created_at DESC, p.id DESC LIMIT $6::int) heads
      JOIN agency_manual_calls m ON m.id = heads.id
     ORDER BY m.created_at DESC, m.id DESC`,

  /** DNC marks (`dnc_mark`). $1–$9. */
  pageDnc: `
    SELECT ${DNC_COLUMNS}${DNC_FROM}
       AND ${keyset('d.created_at', 'd.id')}
       AND ${timeWindow('d.created_at')}
       AND ${ROOT_OF_G}
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT $6::int`,

  /**
   * Roster rows (`roster_entry`): the covered rows ({@link CONTACTS_CTE}, so an entry older than
   * the cap is never paged to), cut at the cursor, top `n`, then each by primary key. $1–$9.
   */
  pageContacts: `
    WITH ${CONTACTS_CTE}
    SELECT ${CONTACT_COLUMNS}
      FROM (SELECT ct.id FROM ct
             WHERE ${keyset('ct.created_at', 'ct.id')}
               AND ${timeWindow('ct.created_at')}
               AND ${rootOf('ct.campaign_id')}
             ORDER BY ct.created_at DESC, ct.id DESC
             LIMIT $6::int) heads
      JOIN agency_contacts c ON c.id = heads.id
     ORDER BY c.created_at DESC, c.id DESC`,

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
      SELECT m.id, m.dialed_at ${MANUAL_FROM} AND m.dialed_at IS NOT NULL)
    SELECT b.id::text AS id,
           (SELECT min(p.dialed_at) FROM placed p WHERE p.dialed_at > b.booked AND p.id <> b.id) AS next_dialed_at
      FROM unnest($4::uuid[], $5::timestamptz[]) AS b(id, booked)`,

  /** Campaigns by id (primary key). $1 tenant, $2 accounts, $3 ids. */
  campaigns: `
    SELECT ${CAMPAIGN_COLUMNS}
      FROM agency_campaigns g
     WHERE g.id = ANY($3::uuid[])
       AND g.tenant_id = $1::uuid
       AND g.account_id = ANY($2::uuid[])`,

  /**
   * Campaigns by id and the chain root of each visible one (CH7: the filter names roots), by
   * primary key. $1 tenant, $2 accounts, $3 ids.
   */
  campaignsWithRoots: `
    SELECT ${CAMPAIGN_COLUMNS}
      FROM agency_campaigns g
     WHERE g.id = ANY(ARRAY(
             SELECT unnest($3::uuid[])
             UNION
             SELECT COALESCE(r.root_campaign_id, r.id) FROM agency_campaigns r
              WHERE r.id = ANY($3::uuid[]) AND r.tenant_id = $1::uuid AND r.account_id = ANY($2::uuid[])))
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

/** `$1` tenant, `$2` phone, `$3` accounts: the summary statements. */
const numberParams = (scope: CustomerHistoryScope, phone: string): unknown[] => [scope.tenantId, phone, scope.accountIds];

/** `$1` tenant, `$2` accounts, `$3` the ids (deduplicated): the lookups by id. */
const idParams = (scope: CustomerHistoryScope, ids: readonly string[]): unknown[] => [scope.tenantId, scope.accountIds, [...new Set(ids)]];

function baseParams(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): unknown[] {
  return [...numberParams(scope, phone), q.cursorAt, q.cursorId, q.limit, q.from, q.to, orNull(q.campaignRoots)];
}

function callParams(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): unknown[] {
  return [...baseParams(scope, phone, q), orNull(q.outcomes), orNull(q.dispositionCodes), orNull(q.agentUserIds), q.connectedOnly];
}

async function read<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  return (await getPool().query<T>(sql, params)).rows;
}

const emptyCallStats = (): CustomerHistoryCallStatsRow => ({
  contact_entries: 0, call_entries: 0, callback_entries: 0, calls: 0, connected: 0,
  agent_ids: [], outcomes: [], disposition_codes: [], campaign_ids: [],
});

const attemptRow = (r: CustomerHistoryAttemptRow): CustomerHistoryAttemptRow => ({
  ...r,
  redial_number: Number(r.redial_number),
  override_applied: Array.isArray(r.override_applied) ? r.override_applied : [],
});

const campaignRow = (r: CustomerHistoryCampaignRow): CustomerHistoryCampaignRow => ({ ...r, retry_generation: Number(r.retry_generation) });

/**
 * An empty visible-account set reads nothing and runs no statement, except where a DNC entry is
 * read (a tenant-wide entry covers every account): the DNC reads.
 */
export class AgencyCustomerHistoryRepository {
  // ─── The summary ──────────────────────────────────────────────────────────

  /** The summary's roster rows carrying `phone`, newest first, at most `cap`. */
  async summaryContacts(scope: CustomerHistoryScope, phone: string, cap: number): Promise<CustomerHistorySummaryContactRow[]> {
    if (noIds(scope.accountIds)) return [];
    return read(CUSTOMER_HISTORY_SQL.summaryContacts, [...numberParams(scope, phone), cap]);
  }

  async callStats(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryCallStatsRow> {
    if (noIds(scope.accountIds)) return emptyCallStats();
    const [row] = await read<CustomerHistoryCallStatsRow>(CUSTOMER_HISTORY_SQL.callStats, numberParams(scope, phone));
    return row ?? emptyCallStats();
  }

  async lastPlaced(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryLastPlacedRow | null> {
    if (noIds(scope.accountIds)) return null;
    const [row] = await read<CustomerHistoryLastPlacedRow>(CUSTOMER_HISTORY_SQL.lastPlaced, numberParams(scope, phone));
    return row ?? null;
  }

  async liveCalls(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryLiveCallRow[]> {
    if (noIds(scope.accountIds)) return [];
    return read(CUSTOMER_HISTORY_SQL.liveCalls, numberParams(scope, phone));
  }

  async latestBookings(scope: CustomerHistoryScope, contactIds: readonly string[]): Promise<CustomerHistoryBookingRow[]> {
    if (noIds(scope.accountIds) || noIds(contactIds)) return [];
    return read(CUSTOMER_HISTORY_SQL.latestBookings, idParams(scope, contactIds));
  }

  /** Every DNC entry covering the number the caller may see; tenant-wide ones even with no visible account. */
  async dncForNumber(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryDncRow[]> {
    return read(CUSTOMER_HISTORY_SQL.dnc, numberParams(scope, phone));
  }

  // ─── Timeline pages ───────────────────────────────────────────────────────

  async pageAttempts(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryAttemptRow[]> {
    if (noIds(scope.accountIds)) return [];
    return (await read<CustomerHistoryAttemptRow>(CUSTOMER_HISTORY_SQL.pageAttempts, callParams(scope, phone, q))).map(attemptRow);
  }

  /** Callbacks booked on either channel's calls. */
  async pageCallbacks(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryCallbackRow[]> {
    if (noIds(scope.accountIds)) return [];
    return read(CUSTOMER_HISTORY_SQL.pageCallbacks, baseParams(scope, phone, q));
  }

  async pageManualCalls(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryManualCallRow[]> {
    if (noIds(scope.accountIds)) return [];
    return read(CUSTOMER_HISTORY_SQL.pageManualCalls, callParams(scope, phone, q));
  }

  /** DNC marks; tenant-wide ones even with no visible account. */
  async pageDnc(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryDncRow[]> {
    return read(CUSTOMER_HISTORY_SQL.pageDnc, baseParams(scope, phone, q));
  }

  async pageContacts(scope: CustomerHistoryScope, phone: string, q: CustomerHistoryPageQuery): Promise<CustomerHistoryContactRow[]> {
    if (noIds(scope.accountIds)) return [];
    return read(CUSTOMER_HISTORY_SQL.pageContacts, baseParams(scope, phone, q));
  }

  // ─── Enrichment ───────────────────────────────────────────────────────────

  /** Each booking's next placed call (NULL: none yet), by booking call id; `at` is when it was booked (`booked_at`). */
  async callbackNext(
    scope: CustomerHistoryScope,
    phone: string,
    bookings: ReadonlyArray<{ id: string; at: string }>,
  ): Promise<Map<string, Date | null>> {
    if (noIds(scope.accountIds) || bookings.length === 0) return new Map();
    const rows = await read<{ id: string; next_dialed_at: Date | null }>(CUSTOMER_HISTORY_SQL.callbackNext, [
      ...numberParams(scope, phone), bookings.map((b) => b.id), bookings.map((b) => b.at),
    ]);
    return new Map(rows.map((r) => [r.id, r.next_dialed_at]));
  }

  async campaignsByIds(scope: CustomerHistoryScope, ids: readonly string[]): Promise<CustomerHistoryCampaignRow[]> {
    if (noIds(scope.accountIds) || noIds(ids)) return [];
    return (await read<CustomerHistoryCampaignRow>(CUSTOMER_HISTORY_SQL.campaigns, idParams(scope, ids))).map(campaignRow);
  }

  /** {@link campaignsByIds} plus the chain root of each campaign read. */
  async campaignsWithRoots(scope: CustomerHistoryScope, ids: readonly string[]): Promise<CustomerHistoryCampaignRow[]> {
    if (noIds(scope.accountIds) || noIds(ids)) return [];
    return (await read<CustomerHistoryCampaignRow>(CUSTOMER_HISTORY_SQL.campaignsWithRoots, idParams(scope, ids))).map(campaignRow);
  }

  async mediaLegs(scope: CustomerHistoryScope, callIds: readonly string[]): Promise<CustomerHistoryMediaLegRow[]> {
    if (noIds(scope.accountIds) || noIds(callIds)) return [];
    return read(CUSTOMER_HISTORY_SQL.mediaLegs, idParams(scope, callIds));
  }

  async uploads(scope: CustomerHistoryScope, campaignIds: readonly string[]): Promise<CustomerHistoryUploadRow[]> {
    if (noIds(scope.accountIds) || noIds(campaignIds)) return [];
    return read(CUSTOMER_HISTORY_SQL.uploads, idParams(scope, campaignIds));
  }
}

export const agencyCustomerHistoryRepository = new AgencyCustomerHistoryRepository();
