/**
 * Service-account campaigns that hold a caller ID pinned to a tenant credential (CR9): the
 * reads and the locked write of the one-off clean-up
 * (`scripts/cleanup-service-campaign-pinned-caller-ids.ts`).
 *
 * CR9 refuses such a caller ID at the write, for the IDs a write adds (every ID on a retry),
 * under the number rows' lock, so a move onto a tenant's account (CR6) cannot commit beside it.
 * A campaign saved before CR9, or one holding a number that was not in the inventory when it was
 * written and has since been added pinned (by hand or by a sync), may still hold one. The dial
 * never uses it (`dialableCallerIds`); this clean-up takes it out of the campaign so the
 * supervisor sees the pool it dials. "Unfinished" is the set a credential revoke and a number's move read
 * (`LIVE_CAMPAIGN`: draft, running, paused, stopping): a completed or stopped campaign never
 * dials again.
 *
 * `phone_numbers.phone_number` is unique, so each pinned caller ID names one credential.
 */
import { getPool } from '@magick-agency/db';
import { LIVE_CAMPAIGN } from '@magick-agency/db/repositories/live-campaign';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { PoolClient } from 'pg';
import { publishPacingInvalidation } from '../../../agency/pacing/invalidation-bus.js';
import type { AgencyCampaignRecord } from '../../models/agency.model.js';

/** A caller ID of a service-account campaign that is a number pinned to a credential. */
export interface PinnedCallerId {
  phone_number: string;
  telephony_credential_id: string;
  /** The credential's label, for an operator to read (null when the credential row is gone). */
  credential_label: string | null;
  /** The credential's tenant (another tenant's own number is the worse case). */
  credential_tenant_id: string | null;
}

/** One service-account campaign that is not finished and holds pinned caller IDs. */
export interface ServiceCampaignPinnedCallerIds {
  campaign_id: string;
  campaign_name: string;
  status: AgencyCampaignRecord['status'];
  tenant_id: string;
  tenant_name: string;
  account_id: string;
  account_name: string | null;
  /** Every caller ID the campaign holds, in its stored order. */
  caller_ids: string[];
  /** The pinned ones, by number. */
  pinned: PinnedCallerId[];
  /** `caller_ids` without the pinned ones, in order: what the campaign would keep. */
  remaining: string[];
}

/** The pinned numbers among `numbers`, with their credentials, by number. */
const PINNED_AMONG_SQL = `
  SELECT p.phone_number::text AS phone_number, p.telephony_credential_id::text AS telephony_credential_id,
         tc.label AS credential_label, tc.tenant_id::text AS credential_tenant_id
    FROM phone_numbers p
    LEFT JOIN telephony_credentials tc ON tc.id = p.telephony_credential_id
   WHERE p.phone_number = ANY($1::text[]) AND p.telephony_credential_id IS NOT NULL
   ORDER BY p.phone_number`;

/** What {@link AgencyServicePinnedCallerIdRepository.removePinnedCallerIds} did with one campaign. */
export type PinnedCallerIdRemoval =
  /** The pinned IDs were removed; `before` and `after` are the campaign's caller IDs. */
  | { outcome: 'removed'; campaign: AgencyCampaignRecord; before: string[]; after: string[]; removed: PinnedCallerId[] }
  /** Re-checked under the lock: nothing to do (gone, finished, on a credential now, or no pinned ID left). */
  | { outcome: 'unchanged'; reason: 'not_found' | 'finished' | 'on_credential' | 'nothing_pinned' }
  /** Removing them would leave no caller ID, and that was not allowed (a running campaign never is). */
  | { outcome: 'would_empty'; campaign: AgencyCampaignRecord; pinned: PinnedCallerId[] };

const LIVE_STATUSES: ReadonlySet<string> = new Set(
  LIVE_CAMPAIGN.replace(/[()' ]/g, '').split(','),
);

export class AgencyServicePinnedCallerIdRepository {
  /**
   * Every campaign on the service's own account (`telephony_credential_id IS NULL`) that is not
   * finished and holds at least one caller ID that is a number pinned to a credential. Ordered by
   * tenant, account and campaign name. A read only.
   */
  async findServiceCampaignsHoldingPinned(): Promise<ServiceCampaignPinnedCallerIds[]> {
    const { rows } = await getPool().query<Omit<ServiceCampaignPinnedCallerIds, 'remaining'>>(
      `SELECT c.id::text AS campaign_id, c.name AS campaign_name, c.status,
              c.tenant_id::text AS tenant_id, t.name AS tenant_name,
              c.account_id::text AS account_id, a.name AS account_name, c.caller_ids,
              json_agg(json_build_object(
                'phone_number', p.phone_number, 'telephony_credential_id', p.telephony_credential_id,
                'credential_label', tc.label, 'credential_tenant_id', tc.tenant_id
              ) ORDER BY p.phone_number) AS pinned
         FROM agency_campaigns c
         JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN accounts a ON a.id = c.account_id
         JOIN phone_numbers p ON p.phone_number = ANY(c.caller_ids) AND p.telephony_credential_id IS NOT NULL
         LEFT JOIN telephony_credentials tc ON tc.id = p.telephony_credential_id
        WHERE c.telephony_credential_id IS NULL
          AND c.status IN ${LIVE_CAMPAIGN}
        GROUP BY c.id, t.name, a.name
        ORDER BY t.name, a.name NULLS LAST, c.name, c.id`,
    );
    return rows.map((row) => {
      const pinned = new Set(row.pinned.map((p) => p.phone_number));
      return { ...row, remaining: row.caller_ids.filter((id) => !pinned.has(id)) };
    });
  }

  /**
   * Remove the pinned caller IDs from one service-account campaign, in one transaction with the
   * campaign row locked `FOR UPDATE`, re-checking everything under the lock (the campaign may
   * have been edited, finished, or moved to a credential since it was listed). A write that
   * would leave the campaign no caller ID is refused (`would_empty`) unless `allowEmpty`, and
   * always for a running campaign. `record(removal, client)` runs inside the transaction after
   * the write, so its audit row commits with it or not at all.
   *
   * After the commit, `campaign_changed` goes out on this process's pacing bus, as every campaign
   * write here does. It reaches only this process: another process (a server, when this runs
   * from a script) reads the new row when its cached one expires (`PACING_CACHE_TTL_MS`, 2 s).
   */
  async removePinnedCallerIds(
    campaignId: string,
    opts: {
      allowEmpty: boolean;
      record: (removal: Extract<PinnedCallerIdRemoval, { outcome: 'removed' }>, client: PoolClient) => Promise<void>;
    },
  ): Promise<PinnedCallerIdRemoval> {
    const result = await withTransaction(async (client): Promise<PinnedCallerIdRemoval> => {
      const locked = await client.query<AgencyCampaignRecord>(
        'SELECT * FROM agency_campaigns WHERE id = $1::uuid FOR UPDATE', [campaignId]);
      const row = locked.rows[0];
      if (!row) return { outcome: 'unchanged', reason: 'not_found' };
      if (!LIVE_STATUSES.has(row.status)) return { outcome: 'unchanged', reason: 'finished' };
      if (row.telephony_credential_id !== null) return { outcome: 'unchanged', reason: 'on_credential' };
      const before = row.caller_ids ?? [];
      const pinned = (await client.query<PinnedCallerId>(PINNED_AMONG_SQL, [before])).rows;
      if (pinned.length === 0) return { outcome: 'unchanged', reason: 'nothing_pinned' };
      const drop = new Set(pinned.map((p) => p.phone_number));
      const after = before.filter((id) => !drop.has(id));
      if (after.length === 0 && (!opts.allowEmpty || row.status === 'running')) {
        return { outcome: 'would_empty', campaign: row, pinned };
      }
      const { rows } = await client.query<AgencyCampaignRecord>(
        `UPDATE agency_campaigns SET caller_ids = $2::text[], updated_at = now() WHERE id = $1::uuid RETURNING *`,
        [campaignId, after],
      );
      const removal = { outcome: 'removed' as const, campaign: rows[0]!, before, after, removed: pinned };
      await opts.record(removal, client);
      return removal;
    }, { pool: getPool() });
    if (result.outcome === 'removed') publishPacingInvalidation({ type: 'campaign_changed', campaignId });
    return result;
  }
}

export const agencyServicePinnedCallerIdRepository = new AgencyServicePinnedCallerIdRepository();
