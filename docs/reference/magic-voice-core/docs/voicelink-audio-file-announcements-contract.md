> **Reference copy, verbatim below this box.** Origin: magic-voice-core @ `4850d1d9` (v1.123.2), path `docs/voicelink-audio-file-announcements-contract.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The audio-file decode contract (toolchain routing, truncation guard). In agency it applies to uploaded abandon clips only; static calls and TTS are not ported.
>
> Index of all copies: [`docs/reference/README.md`](../../README.md).

# VoiceLink audio-file announcements — frozen contract

Ticket: [86d3x73vr](https://app.clickup.com/t/86d3x73vr) (supersedes 86d3x6p7z)

This document is the **frozen interface** between core, master, and cusui for this
feature. Implementations in the three repos are built in parallel against this
document. If an implementation needs to deviate, change this document first and
say so — do not silently diverge.

---

## 1. Goal and the one hard constraint

Enable **audio-file** announcements (not just TTS) for **VoiceLink** static calls.

**Hard constraint: the user must see no difference.** Same upload flow, same
bulk-call flow, no carrier picker, no "normalize" step, no VoiceLink-specific
copy in the happy path. VoiceLink being WebSocket-only is an internal detail.

The only user-visible change anywhere is that **M4A/AAC is no longer accepted**
(it is not decodable without ffmpeg — see §3).

---

## 2. Why the playback path needs no changes

`WsStaticCallSession.convertClip` (`src/core/ws-static-call-session.ts:274`)
already does exactly one thing:

```
readTtsPcm(hash) → { pcm16, sampleRate } → pcmToAlaw() → paced A-law frames
```

It resolves a **PCM16 WAV from the disk cache by hash** and does not know or care
whether the clip came from Sarvam TTS or a customer MP3. `pcmToAlaw`
(`src/utils/audio.ts:223`) already resamples any input rate → 8 kHz through the
16-tap windowed-sinc resampler.

**`convertClip` MUST NOT be modified by this work.** If you find yourself editing
it, the design has gone wrong.

The entire feature is therefore: *get a decoded PCM16 clip into the cache under a
hash, and hand that hash to the existing dispatch path.*

---

## 3. Supported formats (authoritative list)

Measured behaviour of the chosen toolchain, verified end-to-end on real fixtures:

| MIME | Ext | Decodable | Notes |
|---|---|---|---|
| `audio/mpeg` | mp3 | ✅ | `mpg123 -m` — downmixes to mono itself |
| `audio/wav` | wav | ✅ | |
| `audio/x-wav` | wav | ✅ | |
| `audio/wave` | wav | ✅ | |
| `audio/ogg` | ogg | ✅ | Vorbis |
| **`audio/mp4`** | m4a | ❌ **REMOVE** | AAC — needs ffmpeg (+395 MB), not worth it |

`ALLOWED_AUDIO_TYPES` after this change (`src/api/validators/audio-file.validator.ts`):

```ts
export const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/ogg',
] as const;
```

This list is **owned by core** and must be mirrored (not re-invented) in:

- `getExtension()` — `src/api/routes/audio-files.routes.ts:22`
- cusui file-input `accept` — `src/pages/announcements/AudioFilesPage.tsx:151-160`
- `GET /api/v1/metadata` — core advertises it; clients read it from there

### M4A decision (confirmed with product)

**Reject at upload.** `audio/mp4` is removed from the accepted list, so new M4A
uploads fail with a 400 naming the supported formats.

Pre-existing `audio/mp4` rows keep working on `<Play>` carriers (their S3 object
is untouched — we do not migrate or delete them). On VoiceLink they must fail
with an **actionable** error, never a silently silent call. See §6 fail-closed.

---

## 4. Decoder toolchain

apt packages: **`mpg123`** and **`sndfile-programs`**.

> These are the **CLI** packages. The library-only packages (`libmpg123-0`,
> `libsndfile1`) ship **no binaries** and are not usable from Node without FFI.

Measured image cost on the real base image (`node:22-slim`), built per variant:

| Variant | apt packages | Image | Delta |
|---|---|---|---|
| current base | — | 250 MB | — |
| + full `ffmpeg` | 196 | 645 MB | +395 MB |
| **+ `mpg123` + `sndfile-programs`** | 48 | 264 MB | **+14 MB** |

`docker/Dockerfile:11` already runs `apt-get install` (for `libsamplerate0`) —
add to that existing layer, do not create a new one.

### Verified tool behaviour (do not re-derive; this was measured)

| Input | Command | Result |
|---|---|---|
| MP3 stereo 44.1k | `mpg123 -q -m -w out.wav in.mp3` | PCM16 **mono** 44100 ✅ |
| WAV stereo 44.1k | `sndfile-convert -pcm16 in.wav out.wav` | PCM16 44100, **2 ch** ⚠️ |
| OGG stereo 44.1k | `sndfile-convert -pcm16 in.ogg out.wav` | PCM16 44100, **2 ch** ⚠️ |
| M4A/AAC | either tool | `Format not recognised` ❌ |

**`sndfile-convert` has no `-mono`/`-channels` option.** Confirmed — the flag does
not exist. So stereo WAV/OGG comes back interleaved 2-channel and **core must
downmix in JS** (§5.3).

`mpg123` also accepts WAV and OGG input (exit 0 on both). **Prefer `mpg123 -m`
wherever it works** — it downmixes for free and avoids the JS path entirely. Use
`sndfile-convert` only as the fallback for what `mpg123` rejects. Verify actual
coverage during implementation and record what you found.

---

## 5. Core implementation contract

### 5.1 Decode module — `src/audio/decode.ts` (new)

```ts
export interface DecodedAudio {
  pcm16: Buffer;        // mono, signed 16-bit LE
  sampleRate: number;   // native — NOT resampled
  durationSeconds: number;
  decoder: 'mpg123' | 'sndfile';
}

/**
 * Decode an uploaded audio buffer to mono PCM16 at its native sample rate.
 * Runs the decoder as a CHILD PROCESS over a temp file (never in-process FFI —
 * these are C parsers on untrusted bytes).
 *
 * Throws AudioDecodeError for every failure mode. Never returns an empty clip.
 */
export async function decodeToPcm16(
  input: Buffer,
  contentType: string,
  opts?: { timeoutMs?: number },
): Promise<DecodedAudio>;

export class AudioDecodeError extends Error {
  code:
    | 'UNSUPPORTED_FORMAT'   // decoder rejected it / mislabelled MIME
    | 'DECODE_FAILED'        // non-zero exit, corrupt or truncated input
    | 'DECODE_TIMEOUT'       // exceeded the 90s budget
    | 'EMPTY_AUDIO'          // decoded to zero samples
    | 'TOO_LONG';            // exceeds STATIC_CALL_MAX_DURATION_SECONDS
}
```

Rules:

- **Timeout 90 s** (`AUDIO_DECODE_TIMEOUT_MS`, default `90000`). On expiry, **kill
  the child process** (SIGKILL after SIGTERM), clean up temp files, throw
  `DECODE_TIMEOUT`.
- **Do not resample.** Native rate out; `pcmToAlaw` handles 8 kHz downstream.
- **Always clean up temp files** — `finally`, on every path including timeout.
- Size cap (10 MB) is enforced by the route **before** calling this.
- Never throw a bare `Error`; never let a decoder's stderr reach the client verbatim.

### 5.2 Duration cap

`STATIC_CALL_MAX_DURATION_SECONDS = 120` (`src/db/models/static-call.model.ts:29`).
Decode yields duration for free, so enforce at upload and put the **actual
duration** in the error message. This turns a mid-batch failure into instant
feedback.

### 5.3 Downmix helper — `src/utils/audio.ts`

No downmix helper exists today. Add one:

```ts
/** Average interleaved N-channel PCM16 down to mono. */
export function downmixToMono(pcm16: Buffer, channels: number): Buffer;
```

**Average** the channels — do not drop one (dropping loses content that was
panned). Skip entirely when the decoder already emitted mono.

### 5.4 Cache write — reuse `writeTtsFile`

Write decoded PCM through the **existing** `writeTtsFile()`
(`src/tts/tts-file-cache.ts`).

> **Load-bearing:** `readTtsPcm` (`tts-file-cache.ts:73`) hardcodes a 44-byte
> header. It is not a WAV parser. It is safe *only* because `writeTtsFile` is the
> sole writer and emits exactly that layout. **Do not write decoder output into
> the cache by any other route** — a `LIST`/`INFO` chunk would be misparsed as
> audio, i.e. noise on a live call.

Cache key: content-addressed on the **audio file's bytes**, not on TTS text. Use a
distinct hash input so it cannot collide with a TTS clip:

```ts
// sha256 of the raw uploaded bytes, sliced to 40 hex chars (matches hashTtsInput)
export function hashAudioFileContent(bytes: Buffer): string;
```

### 5.5 Persistence — migration `067`

Next free slot is `067` (last is `066_batch_dispatch_idempotency.sql`).

```sql
ALTER TABLE audio_files
  ADD COLUMN pcm_audio_hash VARCHAR(64),          -- NULL = never decoded (legacy row)
  ADD COLUMN pcm_sample_rate INTEGER,
  ADD COLUMN pcm_channels SMALLINT;
```

All nullable — legacy rows stay valid and are handled by §5.6. Also backfill
`duration_seconds` (already exists on the table) for newly uploaded files.

Update `AudioFileRecord` / `CreateAudioFileInput` in
`src/db/models/audio-file.model.ts` accordingly.

### 5.6 Replica-safety — the cache is NOT authoritative

**There is one replica today, but more are coming.** The clip cache is
**node-local disk** (`TTS_AUDIO_DIR`, defaults under `os.tmpdir()`), so a batch
dispatched from a replica that did not handle the upload **will miss**. The
sweeper (`sweepTtsCache`) can also evict a clip by age or size at any time.

Therefore:

- `pcm_audio_hash` on the row means *"this file decoded successfully, and this is
  its cache key"* — **not** *"the clip is on this disk right now."*
- At dispatch, if `ttsFileExists(pcm_audio_hash)` is false, **re-decode from S3**
  (the S3 object is the durable source of truth) and re-populate the cache under
  the same hash. Content-addressing makes this idempotent and safe to race.
- A legacy row with `pcm_audio_hash IS NULL` takes the same S3 re-decode path,
  then persists the hash. **No backfill migration is needed** — rows heal on first
  VoiceLink use.

Put this in **one** helper so upload, dispatch, and legacy paths cannot drift:

```ts
/**
 * Return a cache hash for a decoded PCM16 clip of this audio file, decoding from
 * S3 and populating the cache if it is absent. Idempotent; safe across replicas.
 */
export async function ensurePcmClip(
  audioFile: AudioFileRecord,
): Promise<{ hash: string; sampleRate: number }>;
```

### 5.7 Dispatch wiring — `src/services/static-call.service.ts`

Today pre-generation runs only for
`ttsMode === 'smart' && announcement.type === 'tts'` (`:347`).

Extend Phase 1 so that for `announcement.type === 'audio'` on a WS-static
provider, the per-call hash comes from `ensurePcmClip(audioFile)`. It lands in the
**same** `ttsHashMap` → `tts_audio_hash` → `wsMgr.register({ ttsAudioHash })`
flow, so nothing downstream changes.

An audio announcement has one clip for the whole batch (no per-call variable
interpolation), so resolve **once per batch**, not per call.

### 5.8 Fail-closed guarantee (keep this)

`:458` currently throws when a VoiceLink static call has no pre-generated hash.
**Preserve that guarantee** and widen the message to cover audio files. A call
that can render no audio must **fail**, never dial silently. This is what makes
the legacy-M4A case safe.

### 5.9 Remove the core guard

`src/services/static-call.service.ts:149` — drop the `announcement.type !== 'tts'`
rejection. Keep the `!this.wsStaticManager` 503. The `tts_text` check at `:152`
must now apply **only** to `type === 'tts'` announcements.

---

## 6. Master contract

- **Remove** the audio rejection: `src/proxy/voicelink-static-guard.ts:113-125`.
- **Keep** forced `tts_mode: 'smart'` for VoiceLink (`:148-161`) — unchanged.
- Do **not** add fields to the dispatch snapshot. `announcement_id` and the
  resolved `telephony_provider` are already snapshotted
  (`bulk-dispatch.producer.ts`, `batch-executor.ts:313-344`), and the audio hash
  is resolved by core at dispatch time — deliberately **not** carried through the
  queue, so a queued batch cannot hold a stale or evicted hash.
- Audio-file upload proxy (`proxy-announcements.routes.ts:116-207`) needs **no
  change**: no MIME re-validation there, 50 MiB multipart limit stays, core's
  400 passes through.
- Provider stays server-resolved from the caller ID (`:486-502`) — unchanged.

---

## 7. cusui contract

- **Remove** the VoiceLink audio filtering:
  - `src/pages/campaigns/registry/static.tsx:215-253` (filter) and `:485-509`
    (readiness block)
  - legacy `src/pages/announcements/StaticCallsPage.tsx:261-283`, `:895-920`
- **Update** the file-input `accept` — drop `.m4a` / `audio/mp4`:
  `src/pages/announcements/AudioFilesPage.tsx:151-160`
- **No encoder work.** No `decodeAudioData`, no WAV writing, no client-side
  resampling. The upload posts the original `File` exactly as it does today.
- Surface core's 400 message on upload failure (format / duration / decode) rather
  than a generic "upload failed".
- Keep showing the original filename in the list — unchanged.

---

## 8. Config

| Env | Default | Purpose |
|---|---|---|
| `AUDIO_DECODE_TIMEOUT_MS` | `90000` | Hard per-upload decode budget |

No new feature flag. The capability is implied by the provider; the guards being
removed is the whole switch.

---

## 9. Test requirements

Real fixtures, not mocks, for the decode layer — generate small MP3/WAV/OGG
fixtures and commit them (a few KB each; 0.5 s tones are enough).

Must cover:

1. MP3 / WAV / OGG → mono PCM16 at native rate
2. **Stereo input comes out mono** (both the `mpg123` and `sndfile-convert` paths)
3. M4A rejected at the validator with a message naming supported formats
4. Over-120 s input rejected with the actual duration in the message
5. Decode timeout kills the child, uploads nothing, leaves no temp file and no row
6. Corrupt / truncated / mislabelled bytes → 4xx, never 500, never a silent clip
7. `ensurePcmClip` re-decodes from S3 on cache miss (simulates another replica)
8. Legacy row (`pcm_audio_hash IS NULL`) heals on first use
9. **VoiceLink audio-file announcement dispatches with a hash and would stream**
10. **TTS announcements on VoiceLink are unaffected** (regression guard)
11. Same announcement still works on `<Play>` carriers (Twilio/Telnyx/VoBiz)

Run with: `npx vitest run --dir test/unit --exclude '**/.claude/**'`
(bare `npx vitest run` hangs on worktree clones.)

---

## 10. Explicit non-goals

- ffmpeg / AAC support
- Any client-side decoding or normalization
- Changing `convertClip`, the pacer, codec negotiation, or settlement
- Async/background decode (synchronous, 90 s budget — product decision)
- A shared/network clip cache (S3 re-decode covers replicas)
- Migrating or deleting existing `audio/mp4` rows
