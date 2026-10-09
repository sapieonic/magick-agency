import { getPool } from '../connection.js';
import type {
  PhoneNumberRecord,
  CreatePhoneNumberInput,
  UpdatePhoneNumberInput,
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

  // There is no `findPlatformOwned`: its one use was refusing to register a
  // platform DID as a tenant's BYOC number, and bring-your-own-carrier is out of
  // scope (VoiceLink only).

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
