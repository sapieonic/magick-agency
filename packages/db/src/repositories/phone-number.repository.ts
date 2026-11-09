import type { PoolClient } from 'pg';
import { getPool } from '../connection.js';
import { withTransaction } from '../utils/transaction.js';
import { LIVE_CAMPAIGN } from './live-campaign.js';
import type {
  PhoneNumberRecord,
  CreatePhoneNumberInput,
  UpdatePhoneNumberInput,
  SyncedNumberInput,
  NumberSyncResult,
  CampaignHoldingInactiveNumbers,
  ClearedInboundLink,
  PhoneNumberInboundLinkRecord,
} from '../models/phone-number.model.js';

/**
 * The inbound link read (`PhoneNumberInboundLinkRecord`): the number, its credential, whether it
 * is assigned to that credential's tenant, and the live route answering it. `pn` is the number.
 */
const INBOUND_LINK_SELECT = `
  SELECT pn.id AS phone_number_id, pn.phone_number, pn.status, pn.telephony_credential_id,
         pn.inbound_linked_at, pn.inbound_previous_app_id,
         c.label AS credential_label, c.status AS credential_status, c.tenant_id AS credential_tenant_id,
         c.inbound_app_id AS credential_app_id,
         (c.id IS NOT NULL AND EXISTS (
           SELECT 1 FROM tenant_phone_assignments tpa
            WHERE tpa.phone_number_id = pn.id AND tpa.tenant_id = c.tenant_id)) AS assigned,
         r.id AS route_id, r.name AS route_name, r.account_id AS route_account_id
    FROM phone_numbers pn
    LEFT JOIN telephony_credentials c ON c.id = pn.telephony_credential_id
    LEFT JOIN agency_inbound_route_numbers rn ON rn.phone_number_id = pn.id AND rn.detached_at IS NULL
    LEFT JOIN agency_inbound_routes r ON r.id = rn.route_id`;

export class PhoneNumberRepository {
  async findAll(filters?: { provider_id?: string; status?: string; region?: string }): Promise<PhoneNumberRecord[]> {
    const pool = getPool();
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters?.provider_id) {
      whereClauses.push(`pn.provider_id = $${paramIndex++}`);
      values.push(filters.provider_id);
    }
    if (filters?.status) {
      whereClauses.push(`pn.status = $${paramIndex++}`);
      values.push(filters.status);
    } else {
      // Exclude deleted by default unless explicitly requested
      whereClauses.push(`pn.status != 'deleted'`);
    }
    if (filters?.region) {
      whereClauses.push(`pn.region = $${paramIndex++}`);
      values.push(filters.region);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const result = await pool.query<PhoneNumberRecord>(
      `SELECT pn.*, tp.name AS provider_name, tp.display_name AS provider_display_name
       FROM phone_numbers pn
       JOIN telephony_providers tp ON tp.id = pn.provider_id
       ${whereClause}
       ORDER BY pn.phone_number`,
      values,
    );
    return result.rows;
  }

  async findById(id: string): Promise<PhoneNumberRecord | null> {
    const pool = getPool();
    const result = await pool.query<PhoneNumberRecord>(
      `SELECT pn.*, tp.name AS provider_name, tp.display_name AS provider_display_name
       FROM phone_numbers pn
       JOIN telephony_providers tp ON tp.id = pn.provider_id
       WHERE pn.id = $1`,
      [id],
    );
    return result.rows[0] || null;
  }

  async findByPhoneNumber(phoneNumber: string): Promise<PhoneNumberRecord | null> {
    const pool = getPool();
    const result = await pool.query<PhoneNumberRecord>(
      `SELECT pn.*, tp.name AS provider_name, tp.display_name AS provider_display_name
       FROM phone_numbers pn
       JOIN telephony_providers tp ON tp.id = pn.provider_id
       WHERE pn.phone_number = $1`,
      [phoneNumber],
    );
    return result.rows[0] || null;
  }

  /**
   * Make the inventory match the numbers a tenant credential's carrier account lists
   * (BYOC, B18; 0019), in one transaction:
   *
   *  - a listed number not in the inventory is inserted on the credential's provider,
   *    pinned to the credential (`telephony_credential_id`), and assigned to the
   *    credential's tenant with no account tag, so every account of the tenant may
   *    dial from it (B20: a credential serves every account of its tenant);
   *  - a listed number already pinned to this credential is reactivated if it was
   *    retired, and assigned to the tenant if it is not (a `deleted` one is left alone);
   *  - a listed number pinned to a REVOKED credential of the same tenant, provider and
   *    carrier account (`account_ref`, Plivo's auth ID) is taken over: re-pinned to this
   *    credential and made `active` (`taken_over`). That is the same account registered
   *    again after its old registration was revoked; without it the account's numbers could
   *    never be synced again. A `deleted` one is left alone;
   *  - a listed number already in the inventory on any other credential (another tenant's,
   *    another account's, or one disabled or invalid rather than revoked), or on the
   *    service's own account (NULL), is refused as a conflict, never taken over;
   *  - this credential's numbers the account no longer lists are retired, never deleted:
   *    calls and campaigns name them, and the carrier may list them again.
   *
   * The credential row is locked first (`FOR NO KEY UPDATE`): two syncs of one
   * credential run one after the other, and a disable or revoke waits for the sync (or
   * the sync, finding the credential no longer `active`, writes nothing and returns
   * null). The provider is read off the credential in SQL, so a synced number cannot
   * name a different carrier from the credential it is pinned to.
   *
   * `listed` must be the account's COMPLETE list: anything missing from it is retired.
   */
  async syncForCredential(
    credentialId: string,
    listed: readonly SyncedNumberInput[],
    adminId: string | null,
  ): Promise<NumberSyncResult | null> {
    return withTransaction(async (client, tx) => {
      const cred = await client.query<{ tenant_id: string; provider: string; account_ref: string; provider_id: string }>(
        `SELECT c.tenant_id, c.provider, c.account_ref, p.id AS provider_id
           FROM telephony_credentials c
           JOIN telephony_providers p ON p.name = c.provider
          WHERE c.id = $1 AND c.status = 'active'
            FOR NO KEY UPDATE OF c`,
        [credentialId],
      );
      const row = cred.rows[0];
      if (!row) {
        await tx.rollback();
        return null;
      }
      const numbers = [...new Set(listed.map((n) => n.phone_number))];
      const labels = new Map(listed.map((n) => [n.phone_number, n.label]));

      // With the credential each number is pinned to, to tell a revoked registration of
      // this same carrier account (taken over) from anyone else's (a conflict). Revoked is
      // terminal, so the owner's row needs no lock.
      const existing = await client.query<{
        id: string; phone_number: string; status: PhoneNumberRecord['status']; telephony_credential_id: string | null;
        provider_id: string; owner_status: string | null; owner_tenant_id: string | null; owner_provider: string | null; owner_account_ref: string | null;
      }>(
        `SELECT pn.id, pn.phone_number, pn.status, pn.telephony_credential_id, pn.provider_id,
                oc.status AS owner_status, oc.tenant_id AS owner_tenant_id,
                oc.provider AS owner_provider, oc.account_ref AS owner_account_ref
           FROM phone_numbers pn
           LEFT JOIN telephony_credentials oc ON oc.id = pn.telephony_credential_id
          WHERE pn.phone_number = ANY($1::varchar[]) OR pn.telephony_credential_id = $2::uuid
            FOR UPDATE OF pn`,
        [numbers, credentialId],
      );
      /** Pinned to a revoked registration of this same carrier account, of this tenant. */
      const sameAccountRevoked = (r: (typeof existing.rows)[number]): boolean =>
        r.owner_status === 'revoked' && r.owner_tenant_id === row.tenant_id && r.owner_provider === row.provider
        && r.owner_account_ref === row.account_ref && r.provider_id === row.provider_id;
      const byNumber = new Map(existing.rows.map((r) => [r.phone_number, r]));
      const listedSet = new Set(numbers);

      const result: NumberSyncResult = { added: [], reactivated: [], taken_over: [], unchanged: [], retired: [], conflicts: [], active: 0 };
      const toInsert: string[] = [];
      const toReactivate: string[] = [];
      const toTakeOver: string[] = [];
      for (const number of numbers) {
        const found = byNumber.get(number);
        if (!found) toInsert.push(number);
        else if (found.telephony_credential_id !== credentialId) {
          if (!sameAccountRevoked(found)) result.conflicts.push({ phone_number: number, reason: 'registered_elsewhere' });
          else if (found.status === 'deleted') result.conflicts.push({ phone_number: number, reason: 'deleted' });
          else toTakeOver.push(found.id);
        } else if (found.status === 'deleted') result.conflicts.push({ phone_number: number, reason: 'deleted' });
        else if (found.status === 'retired') toReactivate.push(found.id);
        else result.unchanged.push(number);
      }
      const toRetire = existing.rows.filter(
        (r) => r.telephony_credential_id === credentialId && r.status === 'active' && !listedSet.has(r.phone_number),
      );

      if (toInsert.length > 0) {
        // ON CONFLICT DO NOTHING: a number inserted by someone else since the read above
        // (a super-admin's manual create, another credential's sync) is that writer's,
        // and is reported as a conflict rather than overwritten.
        const inserted = await client.query<{ phone_number: string }>(
          `INSERT INTO phone_numbers
             (phone_number, provider_id, label, capabilities, created_by, telephony_credential_id)
           SELECT n.phone_number, $2::uuid, n.label, '{voice}', $3::uuid, $4::uuid
             FROM unnest($1::varchar[], $5::varchar[]) AS n(phone_number, label)
           ON CONFLICT (phone_number) DO NOTHING
           RETURNING phone_number`,
          [toInsert, row.provider_id, adminId, credentialId, toInsert.map((n) => labels.get(n) ?? null)],
        );
        const done = new Set(inserted.rows.map((r) => r.phone_number));
        for (const number of toInsert) {
          if (done.has(number)) result.added.push(number);
          else result.conflicts.push({ phone_number: number, reason: 'registered_elsewhere' });
        }
      }
      if (toReactivate.length > 0) {
        const back = await client.query<{ phone_number: string }>(
          `UPDATE phone_numbers SET status = 'active'
            WHERE id = ANY($1::uuid[]) AND telephony_credential_id = $2::uuid AND status = 'retired'
            RETURNING phone_number`,
          [toReactivate, credentialId],
        );
        result.reactivated.push(...back.rows.map((r) => r.phone_number));
      }
      if (toTakeOver.length > 0) {
        // The same conditions as `sameAccountRevoked`, in the write itself. Calls and their
        // recordings stay on the old credential (`agency_calls.telephony_credential_id` is
        // pinned at dial time and never moved); only the number changes hands.
        const moved = await client.query<{ phone_number: string }>(
          `UPDATE phone_numbers pn
              SET telephony_credential_id = $2::uuid, status = 'active'
             FROM telephony_credentials oc
            WHERE pn.id = ANY($1::uuid[])
              AND oc.id = pn.telephony_credential_id
              AND oc.status = 'revoked' AND oc.tenant_id = $3::uuid
              AND oc.provider = $4::varchar AND oc.account_ref = $5::varchar
              AND pn.provider_id = $6::uuid AND pn.status <> 'deleted'
            RETURNING pn.phone_number`,
          [toTakeOver, credentialId, row.tenant_id, row.provider, row.account_ref, row.provider_id],
        );
        result.taken_over.push(...moved.rows.map((r) => r.phone_number));
      }
      if (toRetire.length > 0) {
        const gone = await client.query<{ phone_number: string }>(
          `UPDATE phone_numbers SET status = 'retired'
            WHERE id = ANY($1::uuid[]) AND telephony_credential_id = $2::uuid AND status = 'active'
            RETURNING phone_number`,
          [toRetire.map((r) => r.id), credentialId],
        );
        result.retired.push(...gone.rows.map((r) => r.phone_number));
      }

      // Every listed number now pinned to this credential is assigned to its tenant.
      // Existing assignments (and their account tags and default) are left as they are.
      await client.query(
        `INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id, is_default, assigned_by)
         SELECT $1::uuid, pn.id, false, $3::uuid
           FROM phone_numbers pn
          WHERE pn.telephony_credential_id = $2::uuid AND pn.status = 'active'
         ON CONFLICT (tenant_id, phone_number_id) DO NOTHING`,
        [row.tenant_id, credentialId, adminId],
      );
      const count = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM phone_numbers WHERE telephony_credential_id = $1 AND status = 'active'`,
        [credentialId],
      );
      result.active = count.rows[0]!.n;
      for (const list of [result.added, result.reactivated, result.taken_over, result.unchanged, result.retired]) list.sort();
      result.conflicts.sort((a, b) => a.phone_number.localeCompare(b.phone_number));
      return result;
    }, { pool: getPool() });
  }

  /**
   * The live campaigns (draft, running, paused, stopping) pinned to `credentialId` whose
   * caller IDs still name one of its numbers that is not `active` (a sync or a
   * super-admin retired it, or it was deleted). The dial skips such a number (PL13); this
   * is the list an operator tells the tenant about. Ordered by account, then campaign.
   */
  async findCampaignsHoldingInactiveNumbers(credentialId: string): Promise<CampaignHoldingInactiveNumbers[]> {
    const pool = getPool();
    const result = await pool.query<CampaignHoldingInactiveNumbers>(
      `WITH inactive AS (
         SELECT phone_number FROM phone_numbers
          WHERE telephony_credential_id = $1::uuid AND status <> 'active'
       )
       SELECT c.id AS campaign_id, c.name AS campaign_name, c.account_id, a.name AS account_name, c.status,
              ARRAY(SELECT n FROM unnest(c.caller_ids) AS n WHERE n IN (SELECT phone_number FROM inactive) ORDER BY n) AS caller_ids
         FROM agency_campaigns c
         JOIN accounts a ON a.id = c.account_id
        WHERE c.telephony_credential_id = $1::uuid
          AND c.status IN ${LIVE_CAMPAIGN}
          AND c.caller_ids && ARRAY(SELECT phone_number::text FROM inactive)
        ORDER BY a.name, c.name, c.id`,
      [credentialId],
    );
    return result.rows;
  }

  // There is no `findPlatformOwned`: its one use was refusing to register a
  // platform DID as a tenant's BYOC number. A tenant's own-carrier numbers are not
  // registered by hand: `syncForCredential` takes them from the carrier account.

  async create(input: CreatePhoneNumberInput): Promise<PhoneNumberRecord> {
    const pool = getPool();
    const result = await pool.query<PhoneNumberRecord>(
      `INSERT INTO phone_numbers (phone_number, provider_id, label, capabilities, region, max_concurrent_calls, notes, created_by, pool_eligible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.phone_number,
        input.provider_id,
        input.label || null,
        input.capabilities || [],
        input.region || null,
        input.max_concurrent_calls,
        input.notes || null,
        input.created_by || null,
        input.pool_eligible ?? false,
      ],
    );
    return result.rows[0]!;
  }

  async update(id: string, input: UpdatePhoneNumberInput): Promise<PhoneNumberRecord | null> {
    const pool = getPool();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.label !== undefined) {
      setClauses.push(`label = $${paramIndex++}`);
      values.push(input.label);
    }
    if (input.notes !== undefined) {
      setClauses.push(`notes = $${paramIndex++}`);
      values.push(input.notes);
    }
    if (input.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }
    if (input.max_concurrent_calls !== undefined) {
      setClauses.push(`max_concurrent_calls = $${paramIndex++}`);
      values.push(input.max_concurrent_calls);
    }
    if (input.pool_eligible !== undefined) {
      setClauses.push(`pool_eligible = $${paramIndex++}`);
      values.push(input.pool_eligible);
    }

    if (setClauses.length === 0) return this.findById(id);

    values.push(id);
    const result = await pool.query<PhoneNumberRecord>(
      `UPDATE phone_numbers SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }

  async retire(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE phone_numbers SET status = 'retired' WHERE id = $1 AND status = 'active'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async reactivate(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE phone_numbers SET status = 'active' WHERE id = $1 AND status = 'retired'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async softDelete(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE phone_numbers SET status = 'deleted' WHERE id = $1 AND status = 'retired'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async countAssignments(id: string): Promise<number> {
    const pool = getPool();
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM tenant_phone_assignments WHERE phone_number_id = $1`,
      [id],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * It has NO caller today: self-serve signup refuses and super-admin tenant
   * create assigns no number. Kept, with
   * the `pool_eligible` column and its real-Postgres tests, because the column is
   * in the schema; a candidate deletion with that column.
   *
   * Pick the least-assigned number from the *signup pool* — i.e. numbers a super
   * admin has explicitly flagged `pool_eligible = true`. Used to auto-assign a
   * default number to brand-new tenants at signup. Numbers that are not
   * pool-eligible (the default) are dedicated and are deliberately excluded here
   * so they can never be handed to an unverified signup.
   */
  async findLeastAssigned(): Promise<PhoneNumberRecord | null> {
    const pool = getPool();
    const result = await pool.query<PhoneNumberRecord>(
      `SELECT pn.*, tp.name AS provider_name, tp.display_name AS provider_display_name
       FROM phone_numbers pn
       JOIN telephony_providers tp ON tp.id = pn.provider_id
       LEFT JOIN tenant_phone_assignments tpa ON tpa.phone_number_id = pn.id
       WHERE pn.status = 'active' AND pn.pool_eligible = true
       GROUP BY pn.id, tp.name, tp.display_name
       ORDER BY COUNT(tpa.id) ASC
       LIMIT 1`,
    );
    return result.rows[0] || null;
  }
  // ── Inbound links (0024; docs/inbound.md §8.1, §8.2) ───────────────────────────
  // A link is `inbound_linked_at` (+ the app the number pointed at before, restored by Unlink).
  // Only a super-admin links (IB6); the writes run inside the caller's transaction, which also
  // holds the carrier call that the write records, so a carrier refusal rolls the write back.

  /** A number's inbound link and what Link checks; null when there is no such number. */
  async findInboundLink(phoneNumberId: string): Promise<PhoneNumberInboundLinkRecord | null> {
    const result = await getPool().query<PhoneNumberInboundLinkRecord>(
      `${INBOUND_LINK_SELECT} WHERE pn.id = $1::uuid`,
      [phoneNumberId],
    );
    return result.rows[0] ?? null;
  }

  /** The credential's numbers that are not deleted, with their inbound links, by number. */
  async listInboundForCredential(credentialId: string): Promise<PhoneNumberInboundLinkRecord[]> {
    const result = await getPool().query<PhoneNumberInboundLinkRecord>(
      `${INBOUND_LINK_SELECT}
        WHERE pn.telephony_credential_id = $1::uuid AND pn.status <> 'deleted'
        ORDER BY pn.phone_number`,
      [credentialId],
    );
    return result.rows;
  }

  /**
   * Link a number to its credential's inbound Application `appId`, remembering `previousAppId`
   * (the app the carrier had it on; NULL: none). Run inside the caller's transaction (`client`):
   * the credential row is taken `FOR SHARE` first, so a disable or Re-point (`FOR UPDATE`,
   * `lockInbound`) cannot interleave, and the caller commits only once the carrier has the
   * number on the Application. Lands only when: the credential is `active` with Application
   * `appId`; the number is synced from it, `active`, assigned to its tenant, and not linked yet.
   * Null otherwise: the caller re-reads to say why.
   */
  async linkInbound(
    input: { phoneNumberId: string; credentialId: string; appId: string; previousAppId: string | null },
    client: PoolClient,
  ): Promise<PhoneNumberRecord | null> {
    const cred = await client.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM telephony_credentials
        WHERE id = $1::uuid AND status = 'active' AND inbound_app_id = $2::varchar
          FOR SHARE`,
      [input.credentialId, input.appId],
    );
    const tenantId = cred.rows[0]?.tenant_id;
    if (!tenantId) return null;
    const result = await client.query<PhoneNumberRecord>(
      `UPDATE phone_numbers pn
          SET inbound_linked_at = now(), inbound_previous_app_id = $3::varchar
        WHERE pn.id = $1::uuid AND pn.telephony_credential_id = $2::uuid
          AND pn.status = 'active' AND pn.inbound_linked_at IS NULL
          AND EXISTS (SELECT 1 FROM tenant_phone_assignments tpa
                       WHERE tpa.phone_number_id = pn.id AND tpa.tenant_id = $4::uuid)
        RETURNING pn.*`,
      [input.phoneNumberId, input.credentialId, input.previousAppId, tenantId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Clear a number's inbound link and return it as it was (the app to restore on the carrier);
   * null when it was not linked. The row is locked, so of two concurrent clears one gets the
   * link and the other null. With `client` it runs in the caller's transaction (the §8.2
   * cascade detaches the number's route in the same one).
   */
  async clearInboundLink(phoneNumberId: string, opts: { client?: PoolClient } = {}): Promise<ClearedInboundLink | null> {
    const result = await (opts.client ?? getPool()).query<ClearedInboundLink>(
      `WITH old AS MATERIALIZED (
         SELECT id, phone_number, status, telephony_credential_id, inbound_linked_at, inbound_previous_app_id
           FROM phone_numbers
          WHERE id = $1::uuid AND inbound_linked_at IS NOT NULL
            FOR UPDATE
       )
       UPDATE phone_numbers pn
          SET inbound_linked_at = NULL, inbound_previous_app_id = NULL
         FROM old
        WHERE pn.id = old.id
        RETURNING old.id AS phone_number_id, old.phone_number, old.status, old.telephony_credential_id,
                  old.inbound_linked_at, old.inbound_previous_app_id`,
      [phoneNumberId],
    );
    return result.rows[0] ?? null;
  }
}

export const phoneNumberRepository = new PhoneNumberRepository();
