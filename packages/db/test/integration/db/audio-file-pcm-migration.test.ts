// The three PCM columns are created inline by the squashed baseline
// (packages/db/migrations/0001_baseline.sql), so this suite pins the BASELINE's audio_files
// shape. Tenant/account labels are wrapped in `uuidFor` (UUID columns);
// `insertAudioFile` comes from ../setup/clip-factories.js.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAudioFile } from '../setup/clip-factories.js';
import { uuidFor } from '../setup/factories.js';

/**
 * Migration 067 — decoded-PCM bookkeeping on `audio_files`.
 *
 * Pins the schema contract that makes VoiceLink audio-file announcements safe
 * for legacy rows: three nullable columns, no backfill, no NOT NULL, no index.
 */
describe('audio-file PCM migration 067 (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('adds the three PCM columns as nullable with the expected types', async () => {
    const { rows } = await getTestPool().query<{
      column_name: string;
      is_nullable: string;
      data_type: string;
      character_maximum_length: number | null;
    }>(
      `SELECT column_name, is_nullable, data_type, character_maximum_length
         FROM information_schema.columns
        WHERE table_name = 'audio_files'
          AND column_name IN ('pcm_audio_hash', 'pcm_sample_rate', 'pcm_channels')
        ORDER BY column_name`,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        column_name: 'pcm_audio_hash',
        is_nullable: 'YES',
        data_type: 'character varying',
        character_maximum_length: 64,
      }),
      expect.objectContaining({
        column_name: 'pcm_channels',
        is_nullable: 'YES',
        data_type: 'smallint',
      }),
      expect.objectContaining({
        column_name: 'pcm_sample_rate',
        is_nullable: 'YES',
        data_type: 'integer',
      }),
    ]);
  });

  it('leaves a pre-migration-shaped insert valid (all PCM columns NULL)', async () => {
    const row = await insertAudioFile({
      tenant_id: uuidFor('tenant-legacy'),
      account_id: uuidFor('account-legacy'),
      name: 'legacy-m4a-shaped',
      content_type: 'audio/mp4',
      original_filename: 'legacy.m4a',
    });

    const { rows } = await getTestPool().query(
      `SELECT pcm_audio_hash, pcm_sample_rate, pcm_channels, duration_seconds
         FROM audio_files WHERE id = $1`,
      [row.id],
    );
    expect(rows[0]).toEqual({
      pcm_audio_hash: null,
      pcm_sample_rate: null,
      pcm_channels: null,
      duration_seconds: null,
    });
  });

  it('accepts a full PCM write (hash + rate + channels + duration)', async () => {
    const hash = 'a'.repeat(40);
    const row = await insertAudioFile({
      tenant_id: uuidFor('tenant-pcm'),
      account_id: uuidFor('account-pcm'),
      name: 'decoded-clip',
      pcm_audio_hash: hash,
      pcm_sample_rate: 44100,
      pcm_channels: 1,
      duration_seconds: 9.5,
    });

    const { rows } = await getTestPool().query(
      `SELECT pcm_audio_hash, pcm_sample_rate, pcm_channels, duration_seconds
         FROM audio_files WHERE id = $1`,
      [row.id],
    );
    expect(rows[0]!.pcm_audio_hash).toBe(hash);
    expect(rows[0]!.pcm_sample_rate).toBe(44100);
    expect(rows[0]!.pcm_channels).toBe(1);
    expect(Number(rows[0]!.duration_seconds)).toBe(9.5);
  });

  it('does not create an index on any PCM column', async () => {
    const { rows } = await getTestPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'audio_files'`,
    );
    for (const { indexdef } of rows) {
      expect(indexdef).not.toMatch(/pcm_audio_hash|pcm_sample_rate|pcm_channels/);
    }
  });
});
