/**
 * `AgencyCallbacksRepository`: the account's open callbacks in one list (the Live floor's
 * Callbacks page, decisions LF1, LF22; the wire is `packages/contracts/src/api/agency/callbacks.ts`).
 * Two statements, both tenant and account scoped:
 *
 *  - {@link AgencyCallbacksRepository.activeCampaigns}: the account's ACTIVE campaigns (Home's
 *    set, `AGENCY_HOME_ACTIVE_STATUSES`), or the one named, with what the list needs of each: its
 *    name, mode, catalog (whose callback codes decide what a callback is) and zone (whose midnight
 *    ends "today").
 *  - {@link callbacksPageStatement}: one keyset page of their callbacks, ordered by due time then
 *    contact id across every campaign.
 *
 * ── One definition of a callback ─────────────────────────────────────────────
 * A row is a `pending` contact waiting on a callback ({@link isCallbackSql}, the owner's `callback`
 * bucket, the Insights roster's and the CA5 fallback's), due before now (`overdue`: the allocation's
 * `callbacks_overdue`, `callbackOverdueSql`) or from now until the campaign's local midnight
 * (`today`: the allocation's `callbacks_due_today`). So the list holds exactly the rows the
 * Insights tab and the Live floor count.
 *
 * ── The plan (decision LF22; `0053_account_callbacks_index.sql`) ─────────────
 * Per campaign, a LATERAL takes at most `limit + 1` rows in (due, id) order after the cursor from
 * `idx_agency_contacts_callbacks` (`(campaign_id, next_attempt_at, id) WHERE state = 'pending' AND
 * (last_outcome = 'connected' OR callback_source IS NOT NULL)`): the pending contacts whose last
 * call was a conversation, or that an inbound miss booked, a superset of the callbacks and a small
 * part of a roster. The query repeats that predicate byte for byte ({@link CALLBACK_CANDIDATE_SQL}),
 * so the planner proves the partial index applies; `isCallbackSql` alone (its `IS NOT DISTINCT
 * FROM`) does not imply it. The pages of all the campaigns are then merged and cut to `limit + 1`.
 * Without the index each campaign's page walked `idx_agency_contacts_dialable` over every pending
 * row due before now (the whole undialled roster) to find its few callbacks; measured in
 * `test/integration/agency/callbacks-list.test.ts`.
 */
import { getPool } from '@magick-agency/db';
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type { AgencyAssignmentMode, AgencyDisposition } from '@magick-agency/contracts/agency';
import { AGENCY_HOME_ACTIVE_STATUSES } from '@magick-agency/contracts/api/agency/home';
import type { AgencyCallbacksDue } from '@magick-agency/contracts/api/agency/callbacks';
import { isCallbackSql, presentSessionSql } from './assignment-sql.js';
import { params } from './query-builders.js';

/** An active campaign of the account, as the list reads it. */
export interface CallbacksListCampaignRow {
  id: string;
  name: string;
  assignment_mode: AgencyAssignmentMode;
  disposition_catalog: AgencyDisposition[] | null;
  default_timezone: string;
}

/** A campaign as the page statement takes it. */
export interface CallbacksPageCampaign {
  id: string;
  /** `callbackCodes(campaign.disposition_catalog)`. */
  callbackCodes: string[];
  /** The campaign's next local midnight after `now`: where `today` ends. */
  dayEnd: Date;
}

export interface CallbacksPageInput {
  tenantId: string;
  accountId: string;
  campaigns: readonly CallbacksPageCampaign[];
  due: AgencyCallbacksDue;
  /** The read's instant: `overdue` is before it, `today` from it. */
  now: Date;
  /** The last row of the previous page. */
  after: AgencyKeysetPosition | null;
  /** Rows to read: the page size plus one, to know whether there is a next page. */
  take: number;
}

/** One callback as the database answers. */
export interface CallbacksPageRow {
  contact_id: string;
  campaign_id: string;
  context: Record<string, unknown> | null;
  owner_id: string | null;
  owner_live: boolean;
  inbound: boolean;
  due_at: Date;
  /** `next_attempt_at` to the microsecond, for the cursor (`keysetAtSql`). */
  due_key: string;
}

/**
 * The partial index's predicate, byte for byte (`0053_account_callbacks_index.sql`): a pending
 * contact whose last call was a conversation or that an inbound miss booked. Every callback is one
 * ({@link isCallbackSql} needs `last_outcome = 'connected'` or `callback_source`). Over alias `c`.
 */
export const CALLBACK_CANDIDATE_SQL = `c.state = 'pending' AND (c.last_outcome = 'connected' OR c.callback_source IS NOT NULL)`;

/** One page of the account's callbacks (exported for its plan test). */
export function callbacksPageStatement(input: CallbacksPageInput): { text: string; values: unknown[] } {
  const bind = params();
  const ids = bind.add(input.campaigns.map((c) => c.id));
  const dayEnds = bind.add(input.campaigns.map((c) => c.dayEnd));
  const codes = bind.add(input.campaigns.map((c) => JSON.stringify(c.callbackCodes)));
  const tenant = bind.add(input.tenantId);
  const account = bind.add(input.accountId);
  const now = bind.add(input.now);
  const take = bind.add(input.take);
  const window = input.due === 'overdue'
    ? `c.next_attempt_at < ${now}::timestamptz`
    : `c.next_attempt_at >= ${now}::timestamptz AND c.next_attempt_at < camp.day_end`;
  const cursor = input.after
    ? `AND (c.next_attempt_at, c.id) > (${bind.add(input.after.at)}::timestamptz, ${bind.add(input.after.id)}::uuid)`
    : '';
  const text = `
    WITH camp AS MATERIALIZED (
      SELECT u.id, u.day_end, ARRAY(SELECT jsonb_array_elements_text(u.codes::jsonb)) AS codes
        FROM unnest(${ids}::uuid[], ${dayEnds}::timestamptz[], ${codes}::text[]) AS u(id, day_end, codes)
    )
    SELECT c.id::text AS contact_id, camp.id::text AS campaign_id, c.context,
           c.assigned_user_id::text AS owner_id,
           (c.assigned_user_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM agency_agent_sessions s
               WHERE s.campaign_id = camp.id AND s.agent_user_id = c.assigned_user_id AND ${presentSessionSql('s')}
           )) AS owner_live,
           (c.callback_source IS NOT NULL) AS inbound,
           c.next_attempt_at AS due_at,
           ${keysetAtSql('c.next_attempt_at')} AS due_key
      FROM camp
      CROSS JOIN LATERAL (
        SELECT c.id, c.context, c.assigned_user_id, c.callback_source, c.next_attempt_at
          FROM agency_contacts c
         WHERE c.campaign_id = camp.id
           AND ${CALLBACK_CANDIDATE_SQL}
           AND c.tenant_id = ${tenant}::uuid AND c.account_id = ${account}::uuid
           AND ${isCallbackSql('c', 'camp.codes')}
           AND ${window}
           ${cursor}
         ORDER BY c.next_attempt_at, c.id
         LIMIT ${take}::int
      ) c
     ORDER BY c.next_attempt_at, c.id
     LIMIT ${take}::int`;
  return { text, values: bind.values };
}

export class AgencyCallbacksRepository {
  /**
   * The account's active campaigns (running, stopping, paused), or only `campaignId` when it is
   * one of them. Tenant and account scoped: a campaign of another account is not found here.
   */
  async activeCampaigns(tenantId: string, accountId: string, campaignId: string | null): Promise<CallbacksListCampaignRow[]> {
    const { rows } = await getPool().query<CallbacksListCampaignRow>(
      `SELECT id::text AS id, name, assignment_mode, disposition_catalog, default_timezone
         FROM agency_campaigns
        WHERE tenant_id = $1::uuid AND account_id = $2::uuid AND status = ANY($3::text[])
          AND ($4::uuid IS NULL OR id = $4::uuid)
        ORDER BY id`,
      [tenantId, accountId, [...AGENCY_HOME_ACTIVE_STATUSES], campaignId],
    );
    return rows;
  }

  /** One page of their callbacks: at most `take` rows, by due time then contact id. */
  async page(input: CallbacksPageInput): Promise<CallbacksPageRow[]> {
    if (input.campaigns.length === 0) return [];
    const { text, values } = callbacksPageStatement(input);
    const { rows } = await getPool().query<CallbacksPageRow>(text, values);
    return rows;
  }
}

export const agencyCallbacksRepository = new AgencyCallbacksRepository();
