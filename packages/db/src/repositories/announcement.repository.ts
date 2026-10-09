// PORT NOTE (magick-agency): ported from magic-voice-core/src/db/repositories/announcement.repository.ts@4850d1d9.
// Changed: `create` no longer inserts `tts_text`, `tts_voice`, `tts_language` (or their
// 'Polly.Joanna' / 'en-US' fallbacks) — those columns are dropped by the baseline
// (decision 4, uploaded clip only). Placeholders renumbered $1..$5. Everything else verbatim.
import { getPool } from '../connection.js';
import type { AnnouncementRecord, CreateAnnouncementInput, UpdateAnnouncementInput } from '../models/announcement.model.js';

export class AnnouncementRepository {
  async create(input: CreateAnnouncementInput): Promise<AnnouncementRecord> {
    const pool = getPool();
    const result = await pool.query<AnnouncementRecord>(
      `INSERT INTO announcements (
        tenant_id, account_id, name, type, audio_file_id
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING *`,
      [
        input.tenant_id,
        input.account_id,
        input.name,
        input.type,
        input.audio_file_id ?? null,
      ]
    );
    return result.rows[0]!;
  }

  async findById(id: string): Promise<AnnouncementRecord | null> {
    const pool = getPool();
    const result = await pool.query<AnnouncementRecord>(
      'SELECT * FROM announcements WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /** Tenant+account-scoped lookup. Returns null when the row belongs to another tenant/account (→ 404). */
  async findByIdScoped(id: string, tenantId: string, accountId: string): Promise<AnnouncementRecord | null> {
    const pool = getPool();
    const result = await pool.query<AnnouncementRecord>(
      'SELECT * FROM announcements WHERE id = $1 AND tenant_id = $2 AND account_id = $3',
      [id, tenantId, accountId],
    );
    return result.rows[0] || null;
  }

  async findActiveById(id: string): Promise<AnnouncementRecord | null> {
    const pool = getPool();
    const result = await pool.query<AnnouncementRecord>(
      'SELECT * FROM announcements WHERE id = $1 AND is_active = true',
      [id]
    );
    return result.rows[0] || null;
  }

  /** Tenant+account-scoped active lookup. Returns null when the row belongs to another tenant/account (→ 404). */
  async findActiveByIdScoped(id: string, tenantId: string, accountId: string): Promise<AnnouncementRecord | null> {
    const pool = getPool();
    const result = await pool.query<AnnouncementRecord>(
      'SELECT * FROM announcements WHERE id = $1 AND tenant_id = $2 AND account_id = $3 AND is_active = true',
      [id, tenantId, accountId],
    );
    return result.rows[0] || null;
  }

  async listByTenant(
    tenantId: string,
    accountId: string,
    limit = 20,
    offset = 0,
  ): Promise<{ rows: AnnouncementRecord[]; total: number }> {
    const pool = getPool();
    const countResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM announcements WHERE tenant_id = $1 AND account_id = $2 AND is_active = true',
      [tenantId, accountId],
    );
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

    const dataResult = await pool.query<AnnouncementRecord>(
      `SELECT * FROM announcements
       WHERE tenant_id = $1 AND account_id = $2 AND is_active = true
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [tenantId, accountId, limit, offset],
    );

    return { rows: dataResult.rows, total };
  }

  async update(id: string, input: UpdateAnnouncementInput): Promise<AnnouncementRecord | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }

    if (setClauses.length === 0) return this.findById(id);

    values.push(id);
    const pool = getPool();
    const result = await pool.query<AnnouncementRecord>(
      `UPDATE announcements SET ${setClauses.join(', ')} WHERE id = $${paramIndex} AND is_active = true RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async softDelete(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      'UPDATE announcements SET is_active = false WHERE id = $1 AND is_active = true',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export const announcementRepository = new AnnouncementRepository();
