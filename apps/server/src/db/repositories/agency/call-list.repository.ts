/**
 * What a list of calls across campaigns needs beside its rows (`docs/call-log.md` §7): each
 * campaign's name, how it shows a customer's number to agents and its outcome list, and each
 * roster contact's name. Two reads by primary key for one page, never one per row. The rows
 * themselves are `AgencyAttemptRepository.listCallLog`'s.
 */
import { getPool } from '@magick-agency/db';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import type { CustomerNameDisplay } from '@magick-agency/domain/customer-name';
import { contactNameContextSql } from './sql-fragments.js';

/** A campaign as a call list labels it. */
export interface CallListCampaign {
  id: string;
  name: string;
  /** The stored `phone_display`; read with `phoneDisplayOf`. */
  phone_display: string | null;
  disposition_catalog: AgencyDisposition[] | null;
}

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
