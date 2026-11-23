/**
 * What a list of calls across campaigns needs beside its rows (`docs/call-log.md` §7): each
 * campaign's name, how it shows a customer's number to agents and its outcome list, and each
 * roster contact's name. Two reads by primary key for one page, never one per row. The rows
 * themselves are `AgencyAttemptRepository.listCallLog`'s.
 */
import { getPool } from '@magick-agency/db';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import type { CustomerNameDisplay } from '@magick-agency/domain/customer-name';
import type { AgencyCampaignRecord } from '../../models/agency.model.js';
import { contactNameContextSql } from './sql-fragments.js';

/** A campaign as a call list labels it. */
export interface CallListCampaign {
  id: string;
  name: string;
  /** The stored `phone_display`; read with `phoneDisplayOf`. */
  phone_display: string | null;
  disposition_catalog: AgencyDisposition[] | null;
}

/**
 * A campaign the agent is actively staffed on, with what their callbacks due are read by
 * (`myCallbacksDue`): its day (`default_timezone`), whose callbacks they are (`assignment_mode`,
 * `callback_fallback`), which outcomes book one (`disposition_catalog`) and how a contact is
 * named (`context_display`).
 */
export type StaffedCampaign = Pick<AgencyCampaignRecord,
  'id' | 'name' | 'default_timezone' | 'assignment_mode' | 'callback_fallback' | 'context_display' | 'disposition_catalog'>;

/** A roster contact's name columns and its campaign's display rules, for `matchName`. */
export interface CallListContactName {
  id: string;
  context: Record<string, unknown> | null;
  display: CustomerNameDisplay | null;
}

export class AgencyCallListRepository {
  /** The account's campaigns among `ids`. An id outside the tenant and account is absent. */
  async campaigns(tenantId: string, accountId: string, ids: readonly string[]): Promise<Map<string, CallListCampaign>> {
    if (ids.length === 0) return new Map();
    const { rows } = await getPool().query<CallListCampaign>(
      `SELECT id, name, phone_display, disposition_catalog
         FROM agency_campaigns
        WHERE id = ANY($3::uuid[]) AND tenant_id = $1::uuid AND account_id = $2::uuid`,
      [tenantId, accountId, [...ids]],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** The names of the account's campaigns among `ids`: what a list that only names each row's campaign reads. */
  async campaignNames(tenantId: string, accountId: string, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { rows } = await getPool().query<{ id: string; name: string }>(
      `SELECT id, name
         FROM agency_campaigns
        WHERE id = ANY($3::uuid[]) AND tenant_id = $1::uuid AND account_id = $2::uuid`,
      [tenantId, accountId, [...ids]],
    );
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /**
   * The account's campaigns the user is actively staffed on (`unassigned_at IS NULL`), archived
   * ones left out, oldest staffing first (`assigned_at`, then the staffing row's id: a total
   * order). One read: the staffing rows of the user in the tenant
   * (`uq_agency_campaign_agent_active_campaign`) joined to their campaigns by primary key, the
   * account and the archive checked in the statement, so a campaign of another account the
   * user is also on is never read.
   */
  async staffedCampaigns(tenantId: string, accountId: string, userId: string): Promise<StaffedCampaign[]> {
    const { rows } = await getPool().query<StaffedCampaign>(
      `SELECT c.id, c.name, c.default_timezone, c.assignment_mode, c.callback_fallback,
              c.context_display, c.disposition_catalog
         FROM agency_campaign_agents ca
         JOIN agency_campaigns c ON c.id = ca.campaign_id
        WHERE ca.tenant_id = $1::uuid AND ca.user_id = $3::uuid AND ca.unassigned_at IS NULL
          AND c.tenant_id = $1::uuid AND c.account_id = $2::uuid AND c.archived_at IS NULL
        ORDER BY ca.assigned_at ASC, ca.id ASC`,
      [tenantId, accountId, userId],
    );
    return rows;
  }

  /**
   * Of the account's inbound calls among `ids`, the ones filed under no campaign whose caller
   * matched a campaign's contact: call id → that campaign. A call is filed under its matched
   * contact's campaign when it is written (0067), so these are rows from while an older server
   * ran; an agent's list still masks their number as that campaign says.
   */
  async inboundMatchedCampaigns(tenantId: string, accountId: string, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { rows } = await getPool().query<{ id: string; matched_campaign_id: string }>(
      `SELECT id, matched_campaign_id
         FROM agency_inbound_calls
        WHERE id = ANY($3::uuid[]) AND tenant_id = $1::uuid AND account_id = $2::uuid
          AND campaign_id IS NULL AND matched_campaign_id IS NOT NULL`,
      [tenantId, accountId, [...ids]],
    );
    return new Map(rows.map((r) => [r.id, r.matched_campaign_id]));
  }

  /**
   * The name columns of the account's roster contacts among `ids` (`contactNameContextSql`:
   * only the columns a name can be read from leave the database), with each one's campaign's
   * `context_display`.
   */
  async contactNames(tenantId: string, accountId: string, ids: readonly string[]): Promise<CallListContactName[]> {
    if (ids.length === 0) return [];
    const { rows } = await getPool().query<CallListContactName>(
      `SELECT ct.id, ${contactNameContextSql('ct', 'cam')} AS context, cam.context_display AS display
         FROM agency_contacts ct
         JOIN agency_campaigns cam ON cam.id = ct.campaign_id
        WHERE ct.id = ANY($3::uuid[]) AND ct.tenant_id = $1::uuid AND ct.account_id = $2::uuid`,
      [tenantId, accountId, [...ids]],
    );
    return rows;
  }
}

export const agencyCallListRepository = new AgencyCallListRepository();
