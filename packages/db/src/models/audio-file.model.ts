export interface AudioFileRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  slug: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  s3_key: string;
  duration_seconds: number | null;
  /**
   * Cache key of the decoded mono PCM16 clip.
   *
   * Means "this file decoded successfully, and this is its cache key" — NOT "the
   * clip is on this disk right now". The clip cache is node-local and swept, so
   * dispatch must re-decode from S3 (the durable source of truth) whenever the
   * clip is absent, re-populating the same content-addressed key.
   *
   * NULL = never decoded: a row ever used on a `<Play>`
   * carrier. Such rows heal on first WebSocket-carrier use.
   */
  pcm_audio_hash: string | null;
  /** Native sample rate of the cached clip — not resampled at decode time. */
  pcm_sample_rate: number | null;
  /** Channel count of the cached clip (1 — the decode path downmixes). */
  pcm_channels: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateAudioFileInput {
  tenant_id: string;
  account_id: string;
  name: string;
  slug: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  s3_key: string;
  duration_seconds?: number;
  pcm_audio_hash?: string;
  pcm_sample_rate?: number;
  pcm_channels?: number;
}
