import { getPool } from '../connection.js';
import type {
  TenantPhoneAssignmentRecord,
  PhoneAccountTagRecord,
} from '../models/tenant-phone-assignment.model.js';

export class TenantPhoneAssignmentRepository {
  async assign(
    tenantId: string,
    phoneNumberId: string,
    isDefault: boolean,
    assignedBy?: string,
  ): Promise<TenantPhoneAssignmentRecord> {
    const pool = getPool();
    const result = await pool.query<TenantPhoneAssignmentRecord>(
      `INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id, is_default, assigned_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, phoneNumberId, isDefault, assignedBy || null],
    );
    return result.rows[0]!;
  }

  async findById(assignmentId: string): Promise<TenantPhoneAssignmentRecord | null> {
    const pool = getPool();
    const result = await pool.query<TenantPhoneAssignmentRecord>(
      `SELECT tpa.*, pn.phone_number, pn.label, pn.max_concurrent_calls, pn.capabilities, pn.region,
              tp.name AS provider_name, tp.display_name AS provider_display_name
       FROM tenant_phone_assignments tpa
       JOIN phone_numbers pn ON pn.id = tpa.phone_number_id
       JOIN telephony_providers tp ON tp.id = pn.provider_id
       WHERE tpa.id = $1`,
      [assignmentId],
    );
    return result.rows[0] || null;
  }

  async unassign(tenantId: string, phoneNumberId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM tenant_phone_assignments WHERE tenant_id = $1 AND phone_number_id = $2`,
      [tenantId, phoneNumberId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findByTenantId(tenantId: string): Promise<TenantPhoneAssignmentRecord[]> {
    const pool = getPool();
    const result = await pool.query<TenantPhoneAssignmentRecord>(
      `SELECT tpa.*, pn.phone_number, pn.label, pn.max_concurrent_calls, pn.capabilities, pn.region,
              tp.name AS provider_name, tp.display_name AS provider_display_name
       FROM tenant_phone_assignments tpa
       JOIN phone_numbers pn ON pn.id = tpa.phone_number_id
       JOIN telephony_providers tp ON tp.id = pn.provider_id
       WHERE tpa.tenant_id = $1 AND pn.status = 'active'
       ORDER BY tpa.is_default DESC, pn.phone_number ASC`,
      [tenantId],
    );
    return result.rows;
  }

  async findByPhoneNumberId(phoneNumberId: string): Promise<(TenantPhoneAssignmentRecord & { tenant_name?: string })[]> {
    const pool = getPool();
    const result = await pool.query<TenantPhoneAssignmentRecord & { tenant_name?: string }>(
      `SELECT tpa.*, t.name AS tenant_name
       FROM tenant_phone_assignments tpa
       JOIN tenants t ON t.id = tpa.tenant_id
       WHERE tpa.phone_number_id = $1`,
      [phoneNumberId],
    );
    return result.rows;
  }

  async findByTenantAndPhoneString(
    tenantId: string,
    phoneNumber: string,
  ): Promise<TenantPhoneAssignmentRecord | null> {
    const pool = getPool();
    const result = await pool.query<TenantPhoneAssignmentRecord>(
      `SELECT tpa.*, pn.phone_number, pn.max_concurrent_calls,
              tp.name AS provider_name, tp.display_name AS provider_display_name
       FROM tenant_phone_assignments tpa
       JOIN phone_numbers pn ON pn.id = tpa.phone_number_id
       JOIN telephony_providers tp ON tp.id = pn.provider_id
       WHERE tpa.tenant_id = $1 AND pn.phone_number = $2 AND pn.status = 'active'`,
      [tenantId, phoneNumber],
    );
    return result.rows[0] || null;
  }

  async findDefaultForTenant(tenantId: string): Promise<TenantPhoneAssignmentRecord | null> {
    const pool = getPool();
    const result = await pool.query<TenantPhoneAssignmentRecord>(
      `SELECT tpa.*, pn.phone_number, pn.label, pn.max_concurrent_calls, pn.capabilities, pn.region,
              tp.name AS provider_name, tp.display_name AS provider_display_name
       FROM tenant_phone_assignments tpa
       JOIN phone_numbers pn ON pn.id = tpa.phone_number_id
       JOIN telephony_providers tp ON tp.id = pn.provider_id
       WHERE tpa.tenant_id = $1 AND tpa.is_default = true AND pn.status = 'active'`,
      [tenantId],
    );
    return result.rows[0] || null;
  }

  async setDefault(tenantId: string, assignmentId: string): Promise<boolean> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE tenant_phone_assignments SET is_default = false WHERE tenant_id = $1`,
        [tenantId],
      );
      const result = await client.query(
        `UPDATE tenant_phone_assignments SET is_default = true WHERE id = $1 AND tenant_id = $2`,
        [assignmentId, tenantId],
      );
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async tagToAccount(
    assignmentId: string,
    accountId: string,
    isDefault: boolean,
    taggedBy?: string,
  ): Promise<PhoneAccountTagRecord> {
    const pool = getPool();
    const result = await pool.query<PhoneAccountTagRecord>(
      `INSERT INTO phone_account_tags (assignment_id, account_id, is_default, tagged_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [assignmentId, accountId, isDefault, taggedBy || null],
    );
    return result.rows[0]!;
  }

  async untagFromAccount(assignmentId: string, accountId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM phone_account_tags WHERE assignment_id = $1 AND account_id = $2`,
      [assignmentId, accountId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findTagsForAssignment(assignmentId: string): Promise<PhoneAccountTagRecord[]> {
    const pool = getPool();
    const result = await pool.query<PhoneAccountTagRecord>(
      `SELECT pat.*, a.name AS account_name
       FROM phone_account_tags pat
       JOIN accounts a ON a.id = pat.account_id
       WHERE pat.assignment_id = $1`,
      [assignmentId],
    );
    return result.rows;
  }

  async findAvailableForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<(TenantPhoneAssignmentRecord & { assignment_id: string })[]> {
    const pool = getPool();
    const result = await pool.query<TenantPhoneAssignmentRecord & { assignment_id: string }>(
      `SELECT pn.phone_number, pn.label, pn.max_concurrent_calls, pn.capabilities, pn.region,
              tp.name AS provider_name, tp.display_name AS provider_display_name,
              tpa.id AS assignment_id, tpa.is_default
       FROM tenant_phone_assignments tpa
       JOIN phone_numbers pn ON pn.id = tpa.phone_number_id
       JOIN telephony_providers tp ON tp.id = pn.provider_id
       WHERE tpa.tenant_id = $1 AND pn.status = 'active'
         AND (
           NOT EXISTS (SELECT 1 FROM phone_account_tags pat WHERE pat.assignment_id = tpa.id)
           OR EXISTS (SELECT 1 FROM phone_account_tags pat WHERE pat.assignment_id = tpa.id AND pat.account_id = $2)
         )
       ORDER BY tpa.is_default DESC, pn.phone_number ASC`,
      [tenantId, accountId],
    );
    return result.rows;
  }

  async setAccountDefault(
    assignmentId: string,
    accountId: string,
    taggedBy?: string,
  ): Promise<PhoneAccountTagRecord> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Clear existing default for this account
      await client.query(
        `UPDATE phone_account_tags SET is_default = false WHERE account_id = $1 AND is_default = true`,
        [accountId],
      );
      // Upsert tag with is_default = true
      const result = await client.query<PhoneAccountTagRecord>(
        `INSERT INTO phone_account_tags (assignment_id, account_id, is_default, tagged_by)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (assignment_id, account_id)
         DO UPDATE SET is_default = true
         RETURNING *`,
        [assignmentId, accountId, taggedBy || null],
      );
      await client.query('COMMIT');
      return result.rows[0]!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async isPhoneAccessibleToAccount(assignmentId: string, accountId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query<{ accessible: boolean }>(
      `SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM phone_account_tags WHERE assignment_id = $1) THEN true
         WHEN EXISTS (SELECT 1 FROM phone_account_tags WHERE assignment_id = $1 AND account_id = $2) THEN true
         ELSE false
       END AS accessible`,
      [assignmentId, accountId],
    );
    return result.rows[0]?.accessible ?? false;
  }
}

export const tenantPhoneAssignmentRepository = new TenantPhoneAssignmentRepository();
