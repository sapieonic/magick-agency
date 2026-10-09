import { getPool } from '../connection.js';
import type { SuperAdminRecord, CreateSuperAdminInput, SafeSuperAdminRecord } from '../models/super-admin.model.js';

const SAFE_COLUMNS = 'id, email, name, status, is_system, created_at, updated_at';

export class SuperAdminRepository {
  async findByEmail(email: string): Promise<SuperAdminRecord | null> {
    const pool = getPool();
    const result = await pool.query<SuperAdminRecord>(
      `SELECT * FROM super_admins WHERE email = $1`,
      [email],
    );
    return result.rows[0] || null;
  }

  async findById(id: string): Promise<SafeSuperAdminRecord | null> {
    const pool = getPool();
    const result = await pool.query<SafeSuperAdminRecord>(
      `SELECT ${SAFE_COLUMNS} FROM super_admins WHERE id = $1`,
      [id],
    );
    return result.rows[0] || null;
  }

  async create(input: CreateSuperAdminInput): Promise<SafeSuperAdminRecord> {
    const pool = getPool();
    const result = await pool.query<SafeSuperAdminRecord>(
      `INSERT INTO super_admins (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING ${SAFE_COLUMNS}`,
      [input.email, input.password_hash, input.name],
    );
    return result.rows[0]!;
  }

  async findByIdWithHash(id: string): Promise<SuperAdminRecord | null> {
    const pool = getPool();
    const result = await pool.query<SuperAdminRecord>(
      `SELECT * FROM super_admins WHERE id = $1`,
      [id],
    );
    return result.rows[0] || null;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE super_admins SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, id],
    );
  }

  async deactivate(id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE super_admins SET status = 'inactive', updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async reactivate(id: string): Promise<SafeSuperAdminRecord | null> {
    const pool = getPool();
    const result = await pool.query<SafeSuperAdminRecord>(
      `UPDATE super_admins
          SET status = 'active', updated_at = NOW()
        WHERE id = $1 AND status = 'inactive'
        RETURNING ${SAFE_COLUMNS}`,
      [id],
    );
    return result.rows[0] || null;
  }

  async findAll(): Promise<SafeSuperAdminRecord[]> {
    const pool = getPool();
    const result = await pool.query<SafeSuperAdminRecord>(
      `SELECT ${SAFE_COLUMNS} FROM super_admins ORDER BY created_at ASC`,
    );
    return result.rows;
  }
}

export const superAdminRepository = new SuperAdminRepository();
