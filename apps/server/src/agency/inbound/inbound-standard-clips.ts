import fs from 'node:fs';
import path from 'node:path';
import type { AgencyInboundStandardRecording } from '@magick-agency/contracts/api/agency/inbound';
import { createChildLogger } from '@magick-agency/observability';
import { SingleFlight } from '@magick-agency/db/utils/single-flight';
import { parseWavPcm16 } from '../../audio/decode.js';
import { toTelephonyClip } from '../../audio/telephony-clip.js';
import { hashAudioFileContent, ttsFileExists, writeTtsFile } from '../../tts/tts-file-cache.js';
import { downmixToMono } from '../../utils/audio.js';
import { INBOUND_STANDARD_CLIP_FILES, inboundStandardClipDir } from './inbound-standard-clip-files.js';

const log = createChildLogger({ component: 'agency-inbound-standard-clips' });

/**
 * ─── OUR STANDARD RECORDINGS (docs/inbound.md §3.4) ──────────────────────────────
 *
 * What an inbound caller hears when the route has no recording of its own for a message:
 * "please hold", the recording notice, closed, all lines busy, "we'll call you back" and the
 * voicemail prompt (`AGENCY_INBOUND_STANDARD_WORDS`, the contract's words, which the carrier's
 * spoken stand-ins also say). They are WAVs committed under `apps/server/assets/inbound/`
 * (made by `scripts/generate-inbound-clips.ts`; the image copies the directory, docker/Dockerfile)
 * and drop-in replaceable by recordings of the same names.
 *
 * A recording is put into the node-local clip cache the way an uploaded audio file is: hashed on
 * its bytes (`hashAudioFileContent`, so it can never collide with a TTS clip), converted to the
 * telephony rate (`toTelephonyClip`) and written through `writeTtsFile`, the cache's one writer.
 * Lazily, on its first use, and single-flighted per recording, so two callers needing it at once
 * read and write it once. The cache is swept (by age and size), so every use checks the file is
 * still there and writes it again when it is not; the bytes read from disk are not kept.
 *
 * Every failure (the asset missing or unreadable, a cache write that fails) is "nothing to play"
 * for that recording, logged, never a throw: the caller hears the rest and is put down, as with an
 * uploaded clip that cannot be played.
 */

/** The recordings' hashes once written, so a use whose file is still cached reads nothing from disk. */
const hashes = new Map<AgencyInboundStandardRecording, string>();
const flight = new SingleFlight<string | null>();

/**
 * The clip cache hash of a standard recording, written into the cache if it is not there; null
 * when it cannot be played (logged). Never throws.
 */
export async function standardClipHash(recording: AgencyInboundStandardRecording): Promise<string | null> {
  const known = hashes.get(recording);
  if (known && ttsFileExists(known)) return known;
  try {
    return await flight.run(recording, async () => {
      const again = hashes.get(recording);
      if (again && ttsFileExists(again)) return again;
      return loadIntoCache(recording);
    });
  } catch (err) {
    log.error({ err, recording }, 'Could not load a standard inbound recording — skipping it');
    return null;
  }
}

async function loadIntoCache(recording: AgencyInboundStandardRecording): Promise<string | null> {
  const file = path.join(inboundStandardClipDir(), INBOUND_STANDARD_CLIP_FILES[recording]);
  const bytes = await fs.promises.readFile(file);
  const parsed = parseWavPcm16(bytes);
  if (!parsed || parsed.pcm.length === 0) {
    log.error({ recording, file }, 'A standard inbound recording is not a PCM16 WAV — skipping it');
    return null;
  }
  const mono = downmixToMono(parsed.pcm, parsed.channels);
  const clip = toTelephonyClip(mono, parsed.sampleRate);
  const hash = hashAudioFileContent(bytes);
  writeTtsFile(hash, clip.pcm16, clip.sampleRate, 1);
  hashes.set(recording, hash);
  log.info({ recording, hash, sampleRate: clip.sampleRate }, 'Standard inbound recording loaded into the clip cache');
  return hash;
}

/** Tests: forget what this process has written (the cache directory is the test's own). */
export function resetStandardClipsForTests(): void {
  hashes.clear();
}
