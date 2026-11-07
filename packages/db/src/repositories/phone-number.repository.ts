import { getPool } from '../connection.js';
import { withTransaction } from '../utils/transaction.js';
import type {
  PhoneNumberRecord,
  CreatePhoneNumberInput,
  UpdatePhoneNumberInput,
  SyncedNumberInput,
  NumberSyncResult,
  CampaignHoldingInactiveNumbers,
} from '../models/phone-number.model.js';

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
   * (BYOC, B18; 0018), in one transaction:
   *
   *  - a listed number not in the inventory is inserted on the credential's provider,
   *    pinned to the credential (`telephony_credential_id`), and assigned to the
   *    credential's tenant with no account tag, so every account of the tenant may
   *    dial from it (B20: a credential serves every account of its tenant);
   *  - a listed number already pinned to this credential is reactivated if it was
   *    retired, and assigned to the tenant if it is not (a `deleted` one is left alone);
   *  - a listed number already in the inventory on ANOTHER credential, or on the
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
      const cred = await client.query<{ tenant_id: string; provider_id: string }>(
        `SELECT c.tenant_id, p.id AS provider_id
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

      const existing = await client.query<{ id: string; phone_number: string; status: PhoneNumberRecord['status']; telephony_credential_id: string | null }>(
        `SELECT id, phone_number, status, telephony_credential_id
           FROM phone_numbers
          WHERE phone_number = ANY($1::varchar[]) OR telephony_credential_id = $2::uuid
            FOR UPDATE`,
        [numbers, credentialId],
      );
      const byNumber = new Map(existing.rows.map((r) => [r.phone_number, r]));
      const listedSet = new Set(numbers);

      const result: NumberSyncResult = { added: [], reactivated: [], unchanged: [], retired: [], conflicts: [], active: 0 };
      const toInsert: string[] = [];
      const toReactivate: string[] = [];
      for (const number of numbers) {
        const found = byNumber.get(number);
        if (!found) toInsert.push(number);
        else if (found.telephony_credential_id !== credentialId) result.conflicts.push({ phone_number: number, reason: 'registered_elsewhere' });
        else if (found.status === 'deleted') result.conflicts.push({ phone_number: number, reason: 'deleted' });
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
      for (const list of [result.added, result.reactivated, result.unchanged, result.retired]) list.sort();
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
          AND c.status IN ('draft', 'running', 'paused', 'stopping')
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
}

export const phoneNumberRepository = new PhoneNumberRepository();
