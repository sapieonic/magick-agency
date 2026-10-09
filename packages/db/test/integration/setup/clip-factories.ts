import { randomUUID } from 'node:crypto';
import { getTestPool } from './test-utils.js';
import { DEFAULTS } from './factories.js';

/**
 * `insertAudioFile` and `insertAnnouncement`, kept in their own file apart from
 * `factories.ts`. Ids default to the UUID `DEFAULTS` of `factories.ts`.
 *
 *  - `insertAnnouncement` follows the baseline (uploaded clip only):
 *    there are no `tts_text` / `tts_voice` / `tts_language` columns and `type` is
 *    CHECKed to `'audio'`. The default is `type: 'audio'`, and because
 *    `announcements_audio_check` requires an `audio_file_id` on an active audio
 *    row, the factory inserts an audio file in the same tenant/account when the
 *    caller passes no `audio_file_id` key (pass `audio_file_id: null` explicitly
 *    to build the row the CHECK must refuse, or an inactive one).
 */
export async function insertAudioFile(overrides: Record<string, unknown> = {}) {
  const pool = getTestPool();
  const id = randomUUID();
  const defaults = {
    id,
    tenant_id: DEFAULTS.tenantId,
    account_id: DEFAULTS.accountId,
    name: `audio-${Date.now()}-${randomUUID().slice(0, 8)}`,
    slug: `audio-${id}`,
    original_filename: 'test.wav',
    content_type: 'audio/wav',
    size_bytes: 1024,
    s3_key: `${DEFAULTS.tenantId}/${id}/test.wav`,
  };
  const merged = { ...defaults, ...overrides };
  const cols = Object.keys(merged);
  const vals = Object.values(merged);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  const { rows } = await pool.query(
    `INSERT INTO audio_files (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals,
  );
  return rows[0];
}

export async function insertAnnouncement(overrides: Record<string, unknown> = {}) {
  const pool = getTestPool();
  const defaults = {
    id: randomUUID(),
    tenant_id: DEFAULTS.tenantId,
    account_id: DEFAULTS.accountId,
    name: `test-announcement-${Date.now()}-${randomUUID().slice(0, 8)}`,
    type: 'audio',
  };
  const merged: Record<string, unknown> = { ...defaults, ...overrides };
  if (!('audio_file_id' in merged)) {
    const audioFile = await insertAudioFile({ tenant_id: merged['tenant_id'], account_id: merged['account_id'] });
    merged['audio_file_id'] = audioFile.id;
  }
  const cols = Object.keys(merged);
  const vals = Object.values(merged);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  const { rows } = await pool.query(
    `INSERT INTO announcements (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals,
  );
  return rows[0];
}
