import { getPool } from '../connection.js';

export interface SuperAdminAuditRecord {
  id: string;
  admin_id: string;
  admin_email: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown>;
  created_at: Date;
}

export interface SuperAdminAuditListFilters {
  actor?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  q?: string;
  from?: string;
  to?: string;
}

export class SuperAdminAuditRepository {
  async log(entry: {
    admin_id: string;
    admin_email: string;
    action: string;
    resource_type: string;
    resource_id?: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO super_admin_audit_log (admin_id, admin_email, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.admin_id,
        entry.admin_email,
        entry.action,
        entry.resource_type,
        entry.resource_id || null,
        JSON.stringify(entry.details || {}),
      ],
    );
  }

  async list(
    limit = 100,
    offset = 0,
    filters: SuperAdminAuditListFilters = {},
  ): Promise<{ entries: SuperAdminAuditRecord[]; total: number; actions: string[] }> {
    const pool = getPool();
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filters.actor) {
      conditions.push(`admin_email ILIKE $${idx++}`);
      values.push(`%${filters.actor}%`);
    }
    if (filters.action) {
      conditions.push(`action = $${idx++}`);
      values.push(filters.action);
    }
    if (filters.resource_type) {
      conditions.push(`resource_type = $${idx++}`);
      values.push(filters.resource_type);
    }
    if (filters.resource_id) {
      conditions.push(`resource_id ILIKE $${idx++}`);
      values.push(`%${filters.resource_id}%`);
    }
    if (filters.q) {
      conditions.push(
        `(admin_email ILIKE $${idx} OR action ILIKE $${idx} OR resource_type ILIKE $${idx} OR COALESCE(resource_id, '') ILIKE $${idx})`,
      );
      values.push(`%${filters.q}%`);
      idx += 1;
    }
    if (filters.from) {
      conditions.push(`created_at >= $${idx++}`);
      values.push(filters.from);
    }
    if (filters.to) {
      conditions.push(`created_at <= $${idx++}`);
      values.push(filters.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitIdx = idx++;
    const offsetIdx = idx;
    const pageValues = [...values, limit, offset];

    const [entriesResult, countResult, actionsResult] = await Promise.all([
      pool.query<SuperAdminAuditRecord>(
        `SELECT * FROM super_admin_audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        pageValues,
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM super_admin_audit_log ${where}`,
        values,
      ),
      // Distinct actions across the WHOLE log, not the filtered page — the
      // dropdown must list types an operator can search for, including ones
      // not on the current page.
      pool.query<{ action: string }>(
        `SELECT DISTINCT action FROM super_admin_audit_log ORDER BY action`,
      ),
    ]);
    return {
      entries: entriesResult.rows,
      total: parseInt(countResult.rows[0]?.count || '0', 10),
      actions: actionsResult.rows.map((r) => r.action),
    };
  }
}

export const superAdminAuditRepository = new SuperAdminAuditRepository();
