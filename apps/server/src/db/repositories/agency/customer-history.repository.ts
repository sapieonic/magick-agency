/**
 * `AgencyCustomerHistoryRepository`: the reads behind the customer-history search
 * (`docs/customer-history.md`, CH1–CH12): everything the tenant's campaigns and the soft phone
 * hold about ONE number, in the accounts the caller can see.
 *
 * ── Every read is scoped inside the query (CH2) ─────────────────────────────────
 * Each statement binds the tenant and `account_id = ANY($visible::uuid[])`: a row of an account
 * the caller cannot see is never read, so it can never be counted, leaked through a join or
 * left behind by a filter in code. The visible set comes from the caller's memberships
 * (`agency/customer-history/visibility.ts`); an empty set reads nothing (`= ANY('{}')` is false).
 *
 * ── Every read uses an index (CH9) ─────────────────────────────────────────────
 *  - contacts: `idx_agency_contacts_phone (tenant_id, phone_e164)`, an exact match on E.164;
 *  - attempts: `uq_agency_attempt_number (contact_id, attempt_number)` by the contacts' ids;
 *  - soft-phone calls: `idx_agency_manual_calls_destination (tenant_id, account_id,
 *    destination_e164, …)` (migration 0016: an untagged call has no contact) and
 *    `idx_agency_manual_calls_contact_history (contact_id, …)` for the calls logged to a contact;
 *  - DNC: `idx_dnc_entries_tenant_phone (tenant_id, phone_e164)`;
 *  - campaigns and media legs by primary key; imports by `idx_agency_ingest_jobs_campaign`.
 * The integration suite asserts each plan with `EXPLAIN` (`customer-history-plans.test.ts`).
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
  redial_number: number;
  override_applied: string[];
  override_note: string | null;
  created_at: Date;
  /** `created_at`, microseconds. */
  at: string;
  /** When a callback on this call was booked (`dispositioned_at`, else `ended_at`, else `created_at`), microseconds. */
  booked_at: string;
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
  dialed_at: Date | null;
  ended_at: Date | null;
  talk_seconds: number | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: Date | null;
  created_at: Date;
  at: string;
  booked_at: string;
}

export interface CustomerHistoryDncRow {
  id: string;
  account_id: string | null;
  campaign_id: string | null;
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
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

/**
 * The most roster rows one search reads. A number pasted into a roster thousands of times (a
 * placeholder like `9999999999`) must not turn one search into a scan of every copy; newest first,
 * so what is cut is the oldest.
 */
export const CUSTOMER_HISTORY_MAX_CONTACT_ROWS = 2000;

const BOOKED_AT_SQL = (alias: string) =>
  keysetAtSql(`COALESCE(${alias}.dispositioned_at, ${alias}.ended_at, ${alias}.created_at)`);

/** The statements, exported so the plan test runs exactly what the repository runs. */
export const CUSTOMER_HISTORY_SQL = {
  /** Contacts carrying the number: `idx_agency_contacts_phone`. $1 tenant, $2 phone, $3 accounts, $4 cap. */
  contacts: `
    SELECT c.id, c.root_contact_id, c.campaign_id, c.account_id, c.phone_e164, c.context, c.state,
           c.suppressed_reason, c.last_outcome, c.last_disposition, c.next_attempt_at,
           c.assigned_user_id, c.override_disposition, c.override_extra_attempts,
           c.override_retry_delay, c.override_calling_hours, c.override_granted_at, c.created_at,
           ${keysetAtSql('c.created_at')} AS at
      FROM agency_contacts c
     WHERE c.tenant_id = $1::uuid
       AND c.phone_e164 = $2::text
       AND c.account_id = ANY($3::uuid[])
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $4::int`,

  /** Campaigns by id (primary key). $1 tenant, $2 accounts, $3 ids. */
  campaigns: `
    SELECT g.id, g.account_id, g.name, g.status, COALESCE(g.root_campaign_id, g.id) AS root_id,
           g.retry_generation, g.context_display, g.disposition_catalog
      FROM agency_campaigns g
     WHERE g.id = ANY($3::uuid[])
       AND g.tenant_id = $1::uuid
       AND g.account_id = ANY($2::uuid[])`,

  /** Attempts on the contacts: `uq_agency_attempt_number (contact_id, …)`. $1 tenant, $2 accounts, $3 contact ids. */
  attempts: `
    SELECT a.id, a.contact_id, a.campaign_id, a.account_id, a.attempt_number, a.webrtc_call_id,
           s.agent_user_id, a.state, a.outcome, a.disposition_code, a.notes, a.callback_at,
           a.dialed_at, a.ended_at, a.talk_seconds, a.dispositioned_by_user_id, a.dispositioned_at,
           a.redial_of_attempt_id, a.redial_number, a.override_applied, a.override_note, a.created_at,
           ${keysetAtSql('a.created_at')} AS at,
           ${BOOKED_AT_SQL('a')} AS booked_at
      FROM agency_call_attempts a
      LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
     WHERE a.contact_id = ANY($3::uuid[])
       AND a.tenant_id = $1::uuid
       AND a.account_id = ANY($2::uuid[])`,

  /**
   * Soft-phone calls to the number (`idx_agency_manual_calls_destination`), tagged or not, and
   * those logged to one of the contacts (`idx_agency_manual_calls_contact_history`). UNION: a
   * call that is both is one row. $1 tenant, $2 accounts, $3 phone, $4 contact ids.
   */
  manualCalls: `
    WITH picked AS (
      SELECT m.id FROM agency_manual_calls m
       WHERE m.tenant_id = $1::uuid AND m.account_id = ANY($2::uuid[]) AND m.destination_e164 = $3::text
      UNION
      SELECT m.id FROM agency_manual_calls m
       WHERE m.contact_id = ANY($4::uuid[]) AND m.tenant_id = $1::uuid AND m.account_id = ANY($2::uuid[])
    )
    SELECT m.id, m.account_id, m.agent_user_id, m.campaign_id, m.contact_id, m.webrtc_call_id,
           m.destination_e164, m.state, m.outcome, m.disposition_code, m.notes, m.callback_at,
           m.fields, m.dnc_override_note, m.hours_override_note, m.dialed_at, m.ended_at,
           m.talk_seconds, m.dispositioned_by_user_id, m.dispositioned_at, m.created_at,
           ${keysetAtSql('m.created_at')} AS at,
           ${BOOKED_AT_SQL('m')} AS booked_at
      FROM picked
      JOIN agency_manual_calls m ON m.id = picked.id`,

  /**
   * DNC entries covering the number: `idx_dnc_entries_tenant_phone`. A tenant-wide entry
   * (`account_id IS NULL`) covers every account; an account or campaign entry only shows when its
   * account is visible. $1 tenant, $2 phone, $3 accounts.
   */
  dnc: `
    SELECT d.id, d.account_id, d.campaign_id, d.source, d.reason, d.added_by, d.created_at,
           ${keysetAtSql('d.created_at')} AS at
      FROM dnc_entries d
     WHERE d.tenant_id = $1::uuid
       AND d.phone_e164 = $2::text
       AND (d.account_id IS NULL OR d.account_id = ANY($3::uuid[]))`,

  /** The calls' media legs (primary key): present or purged, and recorded or not. $1 tenant, $2 accounts, $3 ids. */
  mediaLegs: `
    SELECT k.id, k.recording_url
      FROM agency_calls k
     WHERE k.id = ANY($3::uuid[])
       AND k.tenant_id = $1::uuid
       AND k.account_id = ANY($2::uuid[])`,

  /** The campaigns' real roster imports: `idx_agency_ingest_jobs_campaign`. $1 tenant, $2 accounts, $3 campaign ids. */
  uploads: `
    SELECT j.campaign_id, j.file_name, j.started_at, j.finished_at, j.created_at
      FROM agency_ingest_jobs j
     WHERE j.campaign_id = ANY($3::uuid[])
       AND j.tenant_id = $1::uuid
       AND j.account_id = ANY($2::uuid[])
       AND j.dry_run = false
     ORDER BY j.created_at ASC`,
} as const;

const noIds = (ids: readonly string[]) => ids.length === 0;

export class AgencyCustomerHistoryRepository {
  /** The roster rows carrying `phone` (E.164, exact), newest first, at most {@link CUSTOMER_HISTORY_MAX_CONTACT_ROWS}. */
  async contactsForNumber(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryContactRow[]> {
    if (noIds(scope.accountIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryContactRow>(CUSTOMER_HISTORY_SQL.contacts, [
      scope.tenantId, phone, scope.accountIds, CUSTOMER_HISTORY_MAX_CONTACT_ROWS,
    ]);
    return rows;
  }

  async campaignsByIds(scope: CustomerHistoryScope, ids: readonly string[]): Promise<CustomerHistoryCampaignRow[]> {
    if (noIds(scope.accountIds) || noIds(ids)) return [];
    const { rows } = await getPool().query<CustomerHistoryCampaignRow>(CUSTOMER_HISTORY_SQL.campaigns, [
      scope.tenantId, scope.accountIds, [...new Set(ids)],
    ]);
    return rows.map((r) => ({ ...r, retry_generation: Number(r.retry_generation) }));
  }

  async attemptsForContacts(scope: CustomerHistoryScope, contactIds: readonly string[]): Promise<CustomerHistoryAttemptRow[]> {
    if (noIds(scope.accountIds) || noIds(contactIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryAttemptRow>(CUSTOMER_HISTORY_SQL.attempts, [
      scope.tenantId, scope.accountIds, [...new Set(contactIds)],
    ]);
    return rows.map((r) => ({
      ...r,
      redial_number: Number(r.redial_number),
      override_applied: Array.isArray(r.override_applied) ? r.override_applied : [],
    }));
  }

  async manualCallsForNumber(
    scope: CustomerHistoryScope,
    phone: string,
    contactIds: readonly string[],
  ): Promise<CustomerHistoryManualCallRow[]> {
    if (noIds(scope.accountIds)) return [];
    const { rows } = await getPool().query<CustomerHistoryManualCallRow>(CUSTOMER_HISTORY_SQL.manualCalls, [
      scope.tenantId, scope.accountIds, phone, [...new Set(contactIds)],
    ]);
    return rows;
  }

  async dncForNumber(scope: CustomerHistoryScope, phone: string): Promise<CustomerHistoryDncRow[]> {
    const { rows } = await getPool().query<CustomerHistoryDncRow>(CUSTOMER_HISTORY_SQL.dnc, [
      scope.tenantId, phone, scope.accountIds,
    ]);
    return rows;
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
