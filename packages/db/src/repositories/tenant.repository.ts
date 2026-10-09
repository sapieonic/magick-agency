import { getPool } from '../connection.js';
import type { TenantRecord, CreateTenantInput, UpdateTenantInput } from '../models/tenant.model.js';

export class TenantRepository {
  async create(input: CreateTenantInput): Promise<TenantRecord> {
    const pool = getPool();
    const result = await pool.query<TenantRecord>(
      `INSERT INTO tenants (name, slug, settings)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.name, input.slug, JSON.stringify(input.settings || {})],
    );
    return result.rows[0]!;
  }

  async findById(id: string): Promise<TenantRecord | null> {
    const pool = getPool();
    const result = await pool.query<TenantRecord>(
      `SELECT * FROM tenants WHERE id = $1 AND status != 'deleted'`,
      [id],
    );
    return result.rows[0] || null;
  }

  async findBySlug(slug: string): Promise<TenantRecord | null> {
    const pool = getPool();
    const result = await pool.query<TenantRecord>(
      `SELECT * FROM tenants WHERE slug = $1 AND status != 'deleted'`,
      [slug],
    );
    return result.rows[0] || null;
  }

  async update(id: string, input: UpdateTenantInput): Promise<TenantRecord | null> {
    const pool = getPool();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.settings !== undefined) {
      setClauses.push(`settings = $${paramIndex++}`);
      values.push(JSON.stringify(input.settings));
    }
    if (input.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }

    if (setClauses.length === 0) return this.findById(id);

    values.push(id);
    const result = await pool.query<TenantRecord>(
      `UPDATE tenants SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }

  async listAll(): Promise<TenantRecord[]> {
    const pool = getPool();
    const result = await pool.query<TenantRecord>(
      `SELECT * FROM tenants WHERE status != 'deleted' ORDER BY created_at`,
    );
    return result.rows;
  }

  async listByUserId(userId: string): Promise<TenantRecord[]> {
    const pool = getPool();
    const result = await pool.query<TenantRecord>(
      `SELECT DISTINCT t.* FROM tenants t
       INNER JOIN memberships m ON m.tenant_id = t.id
       WHERE m.user_id = $1 AND m.status = 'active' AND t.status != 'deleted'
       ORDER BY t.created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  async softDelete(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE tenants SET status = 'deleted' WHERE id = $1 AND status != 'deleted'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export const tenantRepository = new TenantRepository();
