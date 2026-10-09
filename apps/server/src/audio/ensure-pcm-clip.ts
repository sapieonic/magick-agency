// PORT NOTE (magick-agency): ported from magic-voice-core/src/audio/ensure-pcm-clip.ts@4850d1d9.
// Only change: import specifiers (getPool, SingleFlight, AudioFileRecord -> @magick-agency/db;
// logger, withSpan -> @magick-agency/observability).

import { getPool } from '@magick-agency/db';
import { getFile } from '../storage/s3.js';
import { createChildLogger, withSpan } from '@magick-agency/observability';
import { SingleFlight } from '@magick-agency/db/utils/single-flight';
import { hashAudioFileContent, ttsFileExists, writeTtsFile } from '../tts/tts-file-cache.js';
import { decodeToPcm16 } from './decode.js';
import { toTelephonyClip, TELEPHONY_CLIP_SAMPLE_RATE } from './telephony-clip.js';
import type { AudioFileRecord } from '@magick-agency/db/models/audio-file.model';

const log = createChildLogger({ component: 'ensure-pcm-clip' });

export interface PcmClipRef {
  hash: string;
  sampleRate: number;
}

/**
 * Coalesce concurrent resolution of the *same* audio file within this process.
 * A 100-phone VoiceLink batch resolves one clip, but two overlapping batches (or
 * a dequeued call racing an immediate dispatch) would each S3-download and
 * re-decode identical bytes. Keyed on the audio-file id, which fully determines
 * the result. Failures are never memoized — the next caller retries cleanly.
 */
const clipFlight = new SingleFlight<PcmClipRef>();

/**
 * Return a cache hash for a decoded PCM16 clip of this audio file, decoding from
 * S3 and populating the node-local clip cache if it is absent. Idempotent and
 * safe to race across replicas.
 *
 * Why this exists rather than trusting `pcm_audio_hash`: the clip cache is
 * **node-local disk** (`TTS_AUDIO_DIR`). A batch dispatched from a replica that
 * did not handle the upload will miss it, and `sweepTtsCache` can evict a clip by
 * age or size at any time. So the row's hash is a *cache key*, not a promise that
 * the bytes are present. Three cases, one code path:
 *
 *  1. hash set + clip on disk → fast path, no S3, no decode.
 *  2. hash set + clip missing (another replica handled the upload, or the sweeper
 *     evicted it) → re-download from S3 (the durable source of truth), re-decode,
 *     re-populate the cache under the same content hash.
 *  3. `pcm_audio_hash IS NULL` (legacy row uploaded before this feature) → same
 *     S3 decode path, then **persist** the hash/rate/channels so the row heals.
 *     There is deliberately no backfill migration; rows heal on first use.
 *
 * Race-safety rests on content-addressing: the hash is derived from the S3 bytes,
 * so two replicas decoding concurrently converge on the same key, each writing
 * identical bytes to its own local cache and issuing the same idempotent UPDATE.
 *
 * Throws (never returns a silent/empty clip): `AudioDecodeError` for an
 * undecodable object — notably a legacy `audio/mp4` row, which is exactly the
 * case §5.8's fail-closed dial guard exists to catch — or an S3 error. A caller
 * on a WS-only carrier MUST treat a throw as "fail the call", never "dial anyway".
 */
export async function ensurePcmClip(audioFile: AudioFileRecord): Promise<PcmClipRef> {
  const storedHash = audioFile.pcm_audio_hash ?? null;
  const storedRate = audioFile.pcm_sample_rate ?? null;
  // A clip cached at anything other than the telephony wire rate predates the
  // pre-conversion change and is USABLE but SLOW — it makes the call pay the
  // ~1.9s resample. Treat it as a miss so it is re-decoded (at dispatch, off the
  // call path) and the row heals to 8kHz permanently.
  //
  // This check cannot be folded into the hash: the hash is content-addressed on
  // the raw uploaded BYTES, so it is identical for a 44.1kHz and an 8kHz cache of
  // the same file. `pcm_sample_rate` is the only thing that distinguishes them,
  // which is why the column — not the hash — gates the fast path.
  const cacheIsCurrent = storedRate === TELEPHONY_CLIP_SAMPLE_RATE;

  // ── Case 1: fast path — decoded before, at the right rate, AND on this disk. ──
  if (storedHash && storedRate && cacheIsCurrent && ttsFileExists(storedHash)) {
    return { hash: storedHash, sampleRate: storedRate };
  }

  return clipFlight.run(audioFile.id, async () => {
    // Re-check inside the flight: a caller that queued behind a just-finished
    // decode reads the freshly written file instead of re-downloading.
    if (storedHash && storedRate && cacheIsCurrent && ttsFileExists(storedHash)) {
      return { hash: storedHash, sampleRate: storedRate };
    }

    return withSpan('audio.ensure_pcm_clip', {
      'audio_file.id': audioFile.id,
      'audio_file.content_type': audioFile.content_type,
      'audio_file.had_hash': storedHash !== null,
    }, async () => {
      const bytes = await getFile(audioFile.s3_key);
      // Content-addressed on the raw uploaded bytes — a distinct hash input from
      // hashTtsInput(text|language|voice), so an audio clip can never collide
      // with a TTS clip in the shared cache directory.
      const hash = hashAudioFileContent(bytes);

      let sampleRate: number;
      let channels = 1;
      if (ttsFileExists(hash) && storedRate && cacheIsCurrent && hash === storedHash) {
        // The clip reappeared (another concurrent resolver in this process
        // finished, or the row was already correct) — no need to re-decode.
        // `cacheIsCurrent` is re-applied here too: without it a legacy 44.1kHz
        // clip still on disk would be adopted unchanged, skipping the re-decode
        // and leaving the mid-call resample in place.
        sampleRate = storedRate;
      } else {
        const decoded = await decodeToPcm16(bytes, audioFile.content_type);
        // Downsample to the telephony wire rate before caching — the SAME
        // normalization the upload path applies. This arm must not be forgotten:
        // it serves the cache-miss re-decode and the legacy-row heal, so without
        // it a clip resolved on a replica that did not handle the upload (or after
        // the sweeper evicted it) would be cached at 44.1kHz and quietly
        // re-introduce the ~1.9s mid-call resample this change removes. That is a
        // latency regression with no error to show for it.
        const clip = toTelephonyClip(decoded.pcm16, decoded.sampleRate);
        sampleRate = clip.sampleRate;
        // decodeToPcm16 contracts mono output (it downmixes internally), so the
        // cached clip is always 1 channel regardless of the source layout.
        channels = 1;
        // MUST go through writeTtsFile: readTtsPcm hardcodes a 44-byte header and
        // is safe only because writeTtsFile is the sole writer of that layout.
        writeTtsFile(hash, clip.pcm16, clip.sampleRate, channels);
        log.info({
          audioFileId: audioFile.id,
          hash,
          sourceSampleRate: decoded.sampleRate,
          sampleRate: clip.sampleRate,
          durationSeconds: decoded.durationSeconds,
          decoder: decoded.decoder,
          reason: storedHash ? 'cache_miss_redecode' : 'legacy_row_heal',
        }, 'Audio-file PCM clip decoded into clip cache');
      }

      // Persist/heal the row. Best-effort: the clip is already usable for THIS
      // dispatch, and a failed write only costs a re-decode next time — it must
      // not fail a batch that can otherwise render audio.
      if (hash !== storedHash || sampleRate !== storedRate) {
        await persistPcmMetadata(audioFile.id, hash, sampleRate, channels).catch((err) => {
          log.warn({ err, audioFileId: audioFile.id, hash }, 'Failed to persist PCM clip metadata (will re-decode next use)');
        });
      }

      return { hash, sampleRate };
    });
  });
}

/**
 * Idempotent same-value UPDATE — two replicas healing the same legacy row write
 * the same content-addressed hash, so last-write-wins is correct by construction.
 */
async function persistPcmMetadata(
  audioFileId: string,
  hash: string,
  sampleRate: number,
  channels: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE audio_files
        SET pcm_audio_hash = $2, pcm_sample_rate = $3, pcm_channels = $4
      WHERE id = $1`,
    [audioFileId, hash, sampleRate, channels],
  );
}
