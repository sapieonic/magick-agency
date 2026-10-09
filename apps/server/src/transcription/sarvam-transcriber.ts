import { createChildLogger } from '@magick-agency/observability';
import type { DialerSpeakerRole, DialerTranscriptEntry } from '@magick-agency/db/models/agency-call.model';
import {
  TranscriptionError,
  type Transcriber,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './types.js';

const log = createChildLogger({ component: 'sarvam-transcriber' });

export interface SarvamTranscriberConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Optional base URL override (tests). Defaults to Sarvam's public API host. */
  baseUrl?: string;
}

/**
 * Sarvam batch transcriber. Indian-hosted, so it's the data-residency-friendly
 * switchable alternative to Gemini.
 *
 * It uses Sarvam's synchronous **batch** `POST /speech-to-text` endpoint. Kept
 * deliberately leaner than the Gemini transcriber (it is the alternative, not the
 * shipping default) but functional.
 *
 * Assumptions / documented uncertainties (best-effort):
 *  - The batch endpoint is `POST {baseUrl}/speech-to-text` with `Api-Subscription-Key`
 *    auth and a multipart body carrying
 *    the audio `file`, the `model`, and `with_diarization: true`. The exact field
 *    names for diarization/timestamps are not pinned down in this repo, so parsing
 *    is defensive: it reads a `diarized_transcript.entries[]` shape when present and
 *    falls back to a flat `transcript` string otherwise.
 *  - Diarized speakers arrive as `speaker_0`/`speaker_1` (not agent/customer). The
 *    documented heuristic maps **first speaker seen = agent** (the caller speaks
 *    first on an outbound call); all other speakers = customer. `diarizationFailed`
 *    is set when only one distinct speaker is detected.
 *  - `channelRoles` attributes by the numeric channel/speaker index when the
 *    batch response exposes one; otherwise it falls back to the first-speaker heuristic.
 */
export class SarvamTranscriber implements Transcriber {
  readonly provider = 'sarvam' as const;

  constructor(private readonly cfg: SarvamTranscriberConfig) {}

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const baseUrl = (this.cfg.baseUrl ?? 'https://api.sarvam.ai').replace(/\/+$/, '');
    const url = `${baseUrl}/speech-to-text`;

    const form = new FormData();
    form.append('file', new Blob([req.audio], { type: req.mimeType }), 'recording');
    form.append('model', this.cfg.model);
    form.append('with_diarization', 'true');
    if (req.languageHint) form.append('language_code', req.languageHint);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Api-Subscription-Key': this.cfg.apiKey },
        body: form,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') {
        throw new TranscriptionError('TIMEOUT', `Sarvam transcription timed out after ${this.cfg.timeoutMs}ms`);
      }
      throw new TranscriptionError('TRANSCRIPTION_FAILED', `Sarvam request failed: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const nonRetryable = res.status === 400 || res.status === 401 || res.status === 403;
      const rateLimited = res.status === 429;
      const body = await res.text().catch(() => '');
      if (rateLimited) {
        throw new TranscriptionError('RATE_LIMITED', `Sarvam rate-limited (429): ${body.slice(0, 200)}`);
      }
      throw new TranscriptionError(
        'TRANSCRIPTION_FAILED',
        `Sarvam returned ${res.status}: ${body.slice(0, 200)}`,
        !nonRetryable,
      );
    }

    let parsed: SarvamBatchResponse;
    try {
      parsed = (await res.json()) as SarvamBatchResponse;
    } catch (err) {
      throw new TranscriptionError('TRANSCRIPTION_FAILED', `Sarvam returned invalid JSON: ${(err as Error).message}`);
    }

    const { entries, distinctSpeakers } = mapEntries(parsed, req.channelRoles);
    const detectedLanguage = parsed.language_code ?? parsed.detected_language ?? req.languageHint ?? 'unknown';
    const durationSeconds = entries.reduce(
      (max, e) => Math.max(max, e.end_seconds ?? e.start_seconds ?? 0),
      req.expectedDurationSeconds ?? 0,
    );
    // Only one distinct speaker detected ⇒ diarization effectively failed.
    const diarizationFailed = entries.length > 0 && distinctSpeakers <= 1;

    log.info({ turns: entries.length, detectedLanguage, distinctSpeakers, diarizationFailed }, 'Sarvam transcription complete');
    return { entries, detectedLanguage, durationSeconds, model: this.cfg.model, diarizationFailed };
  }
}

interface SarvamDiarizedEntry {
  speaker?: string | number;
  transcript?: string;
  text?: string;
  start_time_seconds?: number;
  end_time_seconds?: number;
  start_seconds?: number;
  end_seconds?: number;
}

interface SarvamBatchResponse {
  transcript?: string;
  language_code?: string;
  detected_language?: string;
  diarized_transcript?: { entries?: SarvamDiarizedEntry[] };
}

/**
 * Map Sarvam's diarized entries to `DialerTranscriptEntry[]`. First distinct
 * speaker seen = agent; all others = customer. When `channelRoles` is supplied and
 * the entry carries a resolvable numeric channel, that mapping wins.
 */
function mapEntries(
  parsed: SarvamBatchResponse,
  channelRoles?: Record<number, DialerSpeakerRole>,
): { entries: DialerTranscriptEntry[]; distinctSpeakers: number } {
  const raw = parsed.diarized_transcript?.entries;
  if (!Array.isArray(raw) || raw.length === 0) {
    // No diarization — a single flat transcript. One 'unknown' turn.
    const flat = (parsed.transcript ?? '').trim();
    if (!flat) return { entries: [], distinctSpeakers: 0 };
    return { entries: [{ role: 'unknown', content: flat }], distinctSpeakers: 1 };
  }

  const speakerOrder: string[] = [];
  const useChannels = channelRoles && Object.keys(channelRoles).length > 0;
  const entries: DialerTranscriptEntry[] = [];

  for (const e of raw) {
    const content = String(e.transcript ?? e.text ?? '').trim();
    if (!content) continue;
    const speakerKey = String(e.speaker ?? 'speaker_0');

    let role: DialerSpeakerRole;
    const channelIdx = channelIndexOf(e.speaker);
    if (useChannels && channelIdx !== null && channelRoles![channelIdx]) {
      role = channelRoles![channelIdx]!;
    } else {
      if (!speakerOrder.includes(speakerKey)) speakerOrder.push(speakerKey);
      // First distinct speaker = agent (outbound caller speaks first); rest = customer.
      role = speakerOrder[0] === speakerKey ? 'agent' : 'customer';
    }

    const entry: DialerTranscriptEntry = { role, content };
    const start = e.start_time_seconds ?? e.start_seconds;
    const end = e.end_time_seconds ?? e.end_seconds;
    if (typeof start === 'number' && Number.isFinite(start)) entry.start_seconds = start;
    if (typeof end === 'number' && Number.isFinite(end)) entry.end_seconds = end;
    entries.push(entry);
  }

  const distinct = new Set(raw.map((e) => String(e.speaker ?? 'speaker_0'))).size;
  return { entries, distinctSpeakers: distinct };
}

/** Extract the numeric index from a `speaker_0`-style label (or a bare number). */
function channelIndexOf(speaker: string | number | undefined): number | null {
  if (typeof speaker === 'number' && Number.isInteger(speaker)) return speaker;
  const m = String(speaker ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
