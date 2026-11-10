import crypto from 'node:crypto';
import path from 'node:path';
import {
  AGENCY_INBOUND_CLIP_UPLOAD_LIMITS as LIMITS,
  type AgencyInboundClipInvalidReason,
} from '@magick-agency/contracts/api/agency/inbound';
import { createChildLogger } from '@magick-agency/observability';
import { AudioDecodeError, decodeToPcm16 } from '../../audio/decode.js';
import { TELEPHONY_CLIP_SAMPLE_RATE, toTelephonyClip } from '../../audio/telephony-clip.js';
import { hashAudioFileContent, writeTtsFile } from '../../tts/tts-file-cache.js';

const log = createChildLogger({ component: 'agency-inbound-recordings' });

/**
 * ─── A RECORDING UPLOADED FOR INBOUND ROUTES (docs/inbound.md §8.4) ──────────────
 *
 * What `POST /inbound/clips` does with a file before anything is stored: its type from its name
 * (and the browser's type when the name says nothing), its name, then the whole file decoded the
 * way a call would play it (`decodeToPcm16`: a child-process decoder, the 120 s maximum, an empty
 * or implausibly short file refused). A file that does not decode is refused here, so no row or
 * object ever names a recording that cannot be played.
 *
 * The decoded audio is converted to the telephony rate (`toTelephonyClip`) and put in this node's
 * clip cache under the content hash `ensurePcmClip` would compute (`hashAudioFileContent`), and
 * the row carries that hash and rate, so the first call that plays it takes the cache's fast path.
 * The cache write is best-effort: a recording whose write fails is decoded again on first use.
 *
 * Stored at `inbound-audio/<tenant>/<account>/<random id>.<ext>` in the app's bucket: the tenant
 * and account in the key, as the voicemails' (`inbound-voicemail/<tenant>/<account>/…`), so the
 * internal handler can prove a key it is asked to record is this account's ({@link
 * isInboundRecordingKey}).
 */

const PREFIX = 'inbound-audio';

/** Each accepted extension's content type: the ones `decodeToPcm16` decodes. */
const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};
/** A browser's type for a file whose name has no usable extension. */
const EXT_BY_MIMETYPE: Readonly<Record<string, string>> = {
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/vnd.wave': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
};

/** A recording ready to store. */
export interface PreparedInboundRecording {
  name: string;
  originalFilename: string;
  contentType: string;
  /** With the dot. */
  ext: string;
  bytes: Buffer;
  durationSeconds: number;
  /** The clip cache key (`hashAudioFileContent`), and the cached clip's rate. */
  pcmHash: string;
  pcmSampleRate: number;
}

export type PrepareInboundRecordingResult =
  | { ok: true; recording: PreparedInboundRecording }
  | { ok: false; reason: AgencyInboundClipInvalidReason; message: string };

/** The extension a file is taken as, or null when it is none this accepts. */
export function inboundRecordingExt(filename: string, mimetype: string | undefined): string | null {
  const ext = path.extname(filename).toLowerCase();
  if (CONTENT_TYPE_BY_EXT[ext]) return ext;
  if (ext) return null;
  const byType = mimetype ? EXT_BY_MIMETYPE[mimetype.toLowerCase().split(';')[0]!.trim()] : undefined;
  return byType ?? null;
}

/** The name a recording is stored under: the one given, else the file's name without its extension. Null: none usable. */
export function inboundRecordingName(given: string | undefined, filename: string): string | null {
  const raw = given !== undefined && given.trim() !== '' ? given : path.basename(filename, path.extname(filename));
  // Collapse whitespace and drop control characters: the name is shown in a select.
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > LIMITS.name_max) return null;
  return name;
}

const REFUSALS: Readonly<Record<AgencyInboundClipInvalidReason, string>> = {
  no_file: 'Choose a recording to upload.',
  unsupported_type: 'Upload a WAV, MP3 or OGG file.',
  too_large: `The file is larger than ${LIMITS.max_bytes / (1024 * 1024)} MB.`,
  too_long: `The recording is longer than ${LIMITS.max_seconds / 60} minutes.`,
  empty: 'The file has no audio in it, or it is too short to be a recording.',
  undecodable: 'The file could not be read as audio. It may be damaged, or not the type its name says.',
  name_invalid: `Give the recording a name of up to ${LIMITS.name_max} characters.`,
};

/** The English message of each refusal (the console words each reason itself). */
export function inboundRecordingRefusalMessage(reason: AgencyInboundClipInvalidReason): string {
  return REFUSALS[reason];
}

function refuse(reason: AgencyInboundClipInvalidReason): PrepareInboundRecordingResult {
  return { ok: false, reason, message: REFUSALS[reason] };
}

/** The upload checked and decoded (see the module note). Throws only for a fault that is not the file's. */
export async function prepareInboundRecording(input: {
  bytes: Buffer;
  filename: string;
  mimetype?: string;
  name?: string;
}): Promise<PrepareInboundRecordingResult> {
  const ext = inboundRecordingExt(input.filename, input.mimetype);
  if (!ext) return refuse('unsupported_type');
  const name = inboundRecordingName(input.name, input.filename);
  if (!name) return refuse('name_invalid');
  if (input.bytes.length === 0) return refuse('empty');
  if (input.bytes.length > LIMITS.max_bytes) return refuse('too_large');
  const contentType = CONTENT_TYPE_BY_EXT[ext]!;
  let decoded;
  try {
    decoded = await decodeToPcm16(input.bytes, contentType);
  } catch (err) {
    if (!(err instanceof AudioDecodeError)) throw err;
    log.info({ code: err.code, detail: err.detail, bytes: input.bytes.length, ext }, 'Inbound recording refused: it does not decode');
    switch (err.code) {
      case 'UNSUPPORTED_FORMAT':
        return refuse('unsupported_type');
      case 'EMPTY_AUDIO':
        return refuse('empty');
      case 'TOO_LONG':
        return refuse('too_long');
      case 'AUDIO_TRUNCATED':
      case 'DECODE_FAILED':
      case 'DECODE_TIMEOUT':
        return refuse('undecodable');
    }
  }
  if (decoded.durationSeconds > LIMITS.max_seconds) return refuse('too_long');
  const clip = toTelephonyClip(decoded.pcm16, decoded.sampleRate);
  const pcmHash = hashAudioFileContent(input.bytes);
  try {
    writeTtsFile(pcmHash, clip.pcm16, clip.sampleRate, 1);
  } catch (err) {
    log.warn({ err, pcmHash }, 'Could not cache an uploaded inbound recording — it is decoded again on first use');
  }
  return {
    ok: true,
    recording: {
      name,
      originalFilename: input.filename.slice(0, 500),
      contentType,
      ext,
      bytes: input.bytes,
      durationSeconds: Math.round(decoded.durationSeconds * 100) / 100,
      pcmHash,
      pcmSampleRate: TELEPHONY_CLIP_SAMPLE_RATE,
    },
  };
}

/** Where a new recording of the account is stored (a fresh random id each time). */
export function inboundRecordingKey(tenantId: string, accountId: string, ext: string): string {
  return `${PREFIX}/${tenantId}/${accountId}/${crypto.randomUUID()}${ext}`;
}

/** Whether `key` is one {@link inboundRecordingKey} made for this tenant and account. */
export function isInboundRecordingKey(key: string, tenantId: string, accountId: string): boolean {
  const base = `${PREFIX}/${tenantId}/${accountId}/`;
  if (!key.startsWith(base)) return false;
  return /^[0-9a-f-]{36}\.(wav|mp3|ogg)$/.test(key.slice(base.length));
}

/** A slug for the row's `slug` column (not unique; the name is). */
export function inboundRecordingSlug(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
  return slug || 'recording';
}
