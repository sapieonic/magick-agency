import { getPool } from '../connection.js';
import type { AudioFileRecord, CreateAudioFileInput } from '../models/audio-file.model.js';

/**
 * `duration_seconds` is NUMERIC(10,2), which node-pg returns as a STRING. Left
 * as that string, the `number | null` on the model would be a type
 * lie that reaches API responses and any arithmetic on it. Coerce here so every
 * read path agrees. (`pcm_sample_rate`/`pcm_channels` are INTEGER/SMALLINT, which
 * pg already returns as numbers. `size_bytes` is BIGINT and therefore also a
 * string — deliberately left as-is: it is already in API responses and coercing
 * it would change the wire type for existing clients.)
 */
function mapRow(row: AudioFileRecord): AudioFileRecord {
  const duration = row.duration_seconds;
  return duration === null || duration === undefined
    ? row
    : { ...row, duration_seconds: Number(duration) };
}

export class AudioFileRepository {
  async create(input: CreateAudioFileInput): Promise<AudioFileRecord> {
    const pool = getPool();
    const result = await pool.query<AudioFileRecord>(
      `INSERT INTO audio_files (
        tenant_id, account_id, name, slug, original_filename, content_type, size_bytes, s3_key,
        duration_seconds, pcm_audio_hash, pcm_sample_rate, pcm_channels
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        input.tenant_id,
        input.account_id,
        input.name,
        input.slug,
        input.original_filename,
        input.content_type,
        input.size_bytes,
        input.s3_key,
        input.duration_seconds ?? null,
        input.pcm_audio_hash ?? null,
        input.pcm_sample_rate ?? null,
        input.pcm_channels ?? null,
      ]
    );
    return mapRow(result.rows[0]!);
  }

  async findById(id: string): Promise<AudioFileRecord | null> {
    const pool = getPool();
    const result = await pool.query<AudioFileRecord>('SELECT * FROM audio_files WHERE id = $1', [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /** Tenant+account-scoped lookup. Returns null when the row belongs to another tenant/account (→ 404). */
  async findByIdScoped(id: string, tenantId: string, accountId: string): Promise<AudioFileRecord | null> {
    const pool = getPool();
    const result = await pool.query<AudioFileRecord>(
      'SELECT * FROM audio_files WHERE id = $1 AND tenant_id = $2 AND account_id = $3',
      [id, tenantId, accountId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async listByTenant(
    tenantId: string,
    accountId: string,
    limit = 20,
    offset = 0,
  ): Promise<{ rows: AudioFileRecord[]; total: number }> {
    const pool = getPool();
    const countResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM audio_files WHERE tenant_id = $1 AND account_id = $2',
      [tenantId, accountId],
    );
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

    const dataResult = await pool.query<AudioFileRecord>(
      'SELECT * FROM audio_files WHERE tenant_id = $1 AND account_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4',
      [tenantId, accountId, limit, offset],
    );

    return { rows: dataResult.rows.map(mapRow), total };
  }

  // NOTE: the healing write for a legacy row (pcm_audio_hash IS NULL) or an
  // evicted clip lives in `src/audio/ensure-pcm-clip.ts`, deliberately as the
  // SINGLE place that persists these columns post-upload — one helper is
  // required so upload, dispatch, and legacy paths cannot drift. A
  // second setter here would be exactly that drift.

  async delete(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query('DELETE FROM audio_files WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}

export const audioFileRepository = new AudioFileRepository();
