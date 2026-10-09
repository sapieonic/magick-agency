import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChildLogger } from '@magick-agency/observability';
import { runWithConcurrency } from '../utils/concurrency.js';

const log = createChildLogger({ component: 'tts-file-cache' });

const TTS_AUDIO_DIR = process.env['TTS_AUDIO_DIR'] || path.join(os.tmpdir(), 'tts-audio');

/**
 * Scratch-file suffix for an in-progress clip write. Deliberately NOT ending in
 * `.wav`, so `sweepTtsCache`'s clip filter (`.endsWith('.wav')`) can never count
 * a half-written file toward the size cap nor evict one as if it were a clip.
 */
const TEMP_SUFFIX_PREFIX = '.wav.tmp-';
/** Matches exactly what {@link tempFilePath} produces — nothing else is reaped. */
const TEMP_NAME_RE = /\.wav\.tmp-\d+-[0-9a-f]{12}$/;
/**
 * Age gate before an orphaned temp is reaped, mirroring `reapDecodeScratchDirs`
 * in `src/audio/decode.ts`. The cache directory may be a volume shared by several
 * replicas, so a temp we did not create may belong to a writer that is still
 * running; deleting it under them would turn a slow write into a failed one.
 * One hour is orders of magnitude beyond any synchronous `writeFileSync` of a
 * clip (bounded by `MAX_DECODED_OUTPUT_BYTES`, ~23 MB) while still keeping crash
 * litter bounded well inside the default 6 h clip TTL.
 */
const TEMP_REAP_MIN_AGE_MS = 3_600_000;

/**
 * How many `stat`/`unlink` calls {@link sweepTtsCache} keeps in flight.
 *
 * **The real ceiling is the libuv threadpool, not this number.** `fs.promises`
 * `stat`/`unlink` are threadpool operations, and `UV_THREADPOOL_SIZE` is unset
 * across this repo, so libuv's default of **4** applies: at most 4 of these are
 * genuinely in flight no matter what is configured here. Raising this value
 * therefore does not buy parallelism — it only deepens the queue in front of
 * those 4 threads.
 *
 * That matters because the threadpool is shared. Every queued sweep op sits
 * ahead of other threadpool consumers in the same process — `dns.lookup` (so:
 * every telephony and AI provider call), `crypto` KDFs, zlib, and every other
 * `fs` operation. Queuing 32 deep against 4 threads would push live-call
 * latency for the duration of the sweep, which is the same class of harm this
 * change exists to remove.
 *
 * So the bound is kept just above the threadpool width: enough to keep all 4
 * threads busy through a slow network round-trip, shallow enough that the queue
 * a live call's DNS lookup lands behind stays short. The event-loop *yielding*
 * property does not come from this number at all — it comes from every
 * filesystem call being awaited rather than synchronous.
 *
 * Overridable per call so tests can pin it. Deliberately not an env knob yet:
 * the useful lever on a slow volume is `UV_THREADPOOL_SIZE` (which this value
 * would then need to track), and shipping the narrower knob first would invite
 * tuning the one that cannot help.
 */
const SWEEP_CONCURRENCY = 8;

/**
 * Bound on the liveness lookup {@link sweepTtsCache} makes before evicting.
 *
 * The startup sweep is **awaited before the first dial is admitted** (`startVoice`
 * in `bootstrap/voice.ts`), so an unbounded query here would turn a wedged
 * database connection into a hung boot.
 * Ten seconds is twice the pool's own `connectionTimeoutMillis` (5 s), so a
 * genuinely-unavailable pool fails on its own timer first and this only fires for
 * a query that connected and then stalled. Exceeding it is treated exactly like a
 * failed query: skip eviction this cycle.
 */
const LIVENESS_TIMEOUT_MS = 10_000;

/**
 * Narrows a candidate hash set down to the hashes that are safe to unlink —
 * i.e. those **no non-terminal call still needs**; anything it does not return
 * is retained. None is registered today (`bootstrap/voice.ts` says why).
 */
export type EvictableClipFilter = (hashes: string[]) => Promise<string[]>;

/**
 * Registered liveness guard, or `null` when nothing is wired (the sweeper then
 * evicts unguarded). See
 * {@link setEvictableClipFilter}.
 */
let evictableClipFilter: EvictableClipFilter | null = null;

/**
 * Inject the reference-count guard the sweeper consults before unlinking.
 *
 * **A registration seam, not an import, and deliberately so.** Any useful
 * implementation is a repository query, and importing one here would pull the
 * database pool — and with it `pg` — into every module that touches the clip
 * cache (`webrtc-bridge-manager.ts`, `audio/ensure-pcm-clip.ts`) and into the
 * suites that exercise the *real* cache module rather than a mock. Same
 * rationale as `setTelephonyReleaseObserver`.
 *
 * Register it once at boot, before the startup sweep. Left unset — as it is
 * today, and in tests and scripts — the sweeper evicts unguarded.
 */
export function setEvictableClipFilter(fn: EvictableClipFilter | null): void {
  evictableClipFilter = fn;
}

/**
 * What one completed sweep measured, as {@link setTtsCacheSweepObserver} sees it.
 *
 * Cache-LEVEL, not write-level, and that distinction is the whole reason this
 * exists. No single write approaches the cache cap; what overflows is this
 * node's directory across many writes, each adding a modest content-addressed
 * clip while the node's total climbs past `cacheMaxBytes`. Only the sweeper ever
 * sees that total.
 */
export interface TtsCacheSweepStats {
  /** `.wav` clip bytes remaining on disk AFTER this sweep's evictions. */
  cacheBytes: number;
  /** Clips this sweep selected as victims but the liveness guard withheld. */
  retained: number;
  /**
   * The liveness lookup failed or timed out, so clip eviction was skipped for
   * this cycle. Sustained, this turns the size cap into no cap at all.
   */
  livenessFailed: boolean;
}

/** Observer invoked once per COMPLETED sweep. See {@link setTtsCacheSweepObserver}. */
export type TtsCacheSweepObserver = (stats: TtsCacheSweepStats) => void;

let sweepObserver: TtsCacheSweepObserver | null = null;

/**
 * Inject the metrics sink for {@link sweepTtsCache}'s measurements.
 *
 * **A registration seam, not an import**, for exactly the reason
 * {@link setEvictableClipFilter} is one: importing the metrics module here would
 * put it in the module graph of every consumer of the clip cache, and suites that
 * stub metrics with explicit factories would then have to list these exports.
 * Same rule as `setTelephonyReleaseObserver` and `setDecodeGateStatsProvider`.
 *
 * Wired once in `bootstrap/voice.ts`. Left unset (tests, scripts) the sweeper
 * simply publishes nothing.
 */
export function setTtsCacheSweepObserver(fn: TtsCacheSweepObserver | null): void {
  sweepObserver = fn;
}

/** Ensure the cache directory exists. Called once at startup. */
export function initTtsFileCache(): void {
  fs.mkdirSync(TTS_AUDIO_DIR, { recursive: true });
  log.info({ dir: TTS_AUDIO_DIR }, 'TTS file cache initialized');
}

/** Build a deterministic hash for text + language + voice. */
export function hashTtsInput(text: string, language: string, voice: string): string {
  return crypto
    .createHash('sha256')
    .update(`${text}|${language}|${voice}`)
    .digest('hex')
    .slice(0, 40);
}

/**
 * Build a content-addressed cache key for a decoded audio-file clip.
 *
 * Distinct from {@link hashTtsInput} by construction: that hashes `text|lang|voice`,
 * this hashes the raw uploaded bytes under an `audio-file:v1:` domain prefix, so an
 * audio clip can never collide with a synthesized TTS clip even in the (impossible)
 * event of a matching digest. Same 40-hex width, so both share one cache directory
 * and one sweeper.
 *
 * Content-addressed on purpose: re-uploading the same file, or re-decoding it from
 * S3 on another replica, lands on the same key, which makes cache population
 * idempotent and safe to race.
 */
export function hashAudioFileContent(bytes: Buffer): string {
  return crypto
    .createHash('sha256')
    .update('audio-file:v1:')
    .update(bytes)
    .digest('hex')
    .slice(0, 40);
}

/** Get the file path for a given hash. */
export function getTtsFilePath(hash: string): string {
  return path.join(TTS_AUDIO_DIR, `${hash}.wav`);
}

/**
 * Build a unique scratch path for an in-progress write of `hash`.
 *
 * Three properties are load-bearing:
 *  1. **Same directory** as the final file — `rename(2)` is only atomic within a
 *     filesystem; across one it degrades to copy+unlink, which reintroduces the
 *     partial-file window this whole mechanism exists to close.
 *  2. **Does not end in `.wav`** — `sweepTtsCache`'s clip filter is
 *     `.endsWith('.wav')`, so a temp can never be counted toward the size cap nor
 *     evicted as a clip, and `getTtsFilePath` can never resolve to one.
 *  3. **Unique per writer** (pid + random) — two processes, or two concurrent
 *     in-process writers, synthesizing the SAME hash must not share a scratch
 *     file. Clips are content-addressed, so both writes produce identical bytes
 *     and last-rename-wins is correct; what must not happen is two writers
 *     interleaving into one temp and renaming the mixture into place.
 */
function tempFilePath(hash: string): string {
  const nonce = crypto.randomBytes(6).toString('hex');
  return path.join(TTS_AUDIO_DIR, `${hash}${TEMP_SUFFIX_PREFIX}${process.pid}-${nonce}`);
}

/** Check whether audio already exists on disk for a given hash. */
export function ttsFileExists(hash: string): boolean {
  return fs.existsSync(getTtsFilePath(hash));
}

/**
 * Write raw PCM16 audio as a WAV file — **atomically**.
 *
 * The bytes go to a unique scratch file in the same directory and are then
 * `rename(2)`d into place, so a concurrent reader observes either the complete
 * clip or no clip, never a prefix of one. Writing straight to the final path
 * would let a truncated file (ENOSPC — `TTS_AUDIO_DIR` defaults to
 * `os.tmpdir()`, often a small tmpfs — a crash mid-write, or a reader racing an
 * in-progress write) satisfy `ttsFileExists`, and `ensurePcmClip` short-circuits
 * on that check, so the hash would be poisoned **permanently**: a 20 s
 * announcement would play 0.1 s of audio on a connected call.
 *
 * No `fsync` before the rename, deliberately. fsync buys durability across a
 * *machine* crash; the atomicity that fixes the poisoning comes from rename
 * alone, and holds against a process crash, ENOSPC, and concurrent readers
 * without it. The cost is real and lands on the wrong path — this runs on the
 * call path (an abandoned call resolving its clip), once per distinct clip,
 * synchronously, and an fsync on a network/overlay volume is tens of
 * milliseconds. The failure it would prevent (host loses power between rename
 * and writeback) leaves a zero-length or absent file after remount, which the
 * next `readTtsPcm` treats as a miss and regenerates — the cache is a cache, and
 * every clip is content-addressed and cheaply regenerable. Durability is not
 * worth per-clip latency here.
 *
 * @param hash - The cache key (file is named `{hash}.wav`)
 * @param pcm16 - Raw PCM16 signed-LE samples
 * @param sampleRate - Sample rate (default 16000)
 * @param channels - Number of channels (default 1 = mono)
 * @throws the underlying fs error, unchanged — callers key their cleanup off
 *   the throw.
 */
export function writeTtsFile(
  hash: string,
  pcm16: Buffer,
  sampleRate = 16000,
  channels = 1,
): void {
  const filePath = getTtsFilePath(hash);
  const tmpPath = tempFilePath(hash);
  const wav = createWavBuffer(pcm16, sampleRate, channels);

  try {
    fs.writeFileSync(tmpPath, wav);
    // Last-rename-wins is correct: clips are content-addressed, so two writers
    // racing on one hash are writing byte-identical payloads.
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort scratch cleanup. It must not mask the original failure — the
    // caller's error handling (and the operator reading the log) needs the real
    // cause, e.g. ENOSPC, not an ENOENT from the cleanup path.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Never created, or already gone — either way there is nothing to clean.
    }
    throw err;
  }

  log.debug({ hash, bytes: wav.length, filePath }, 'TTS audio written');
}

/** Read a cached WAV file. Returns null if not found. */
export function readTtsFile(hash: string): Buffer | null {
  const filePath = getTtsFilePath(hash);
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Read a cached clip as raw PCM16 samples + sample rate. This module owns the
 * WAV byte layout (the canonical 44-byte header `createWavBuffer` writes, with
 * the sample rate at offset 24) — consumers needing raw audio must go through
 * here rather than hardcoding offsets. Returns null when the clip is missing,
 * truncated, or carries no PCM payload, so callers can treat "unusable clip"
 * as a single condition.
 */
export function readTtsPcm(hash: string): { pcm16: Buffer; sampleRate: number } | null {
  const wav = readTtsFile(hash);
  if (!wav || wav.length <= 44) return null;
  const sampleRate = wav.readUInt32LE(24);
  if (!sampleRate) return null;
  // Trim to whole PCM16 samples; copy if the slice lands on an odd byteOffset
  // (Int16Array views over the buffer require 2-byte alignment).
  let pcm16 = wav.subarray(44, 44 + Math.floor((wav.length - 44) / 2) * 2);
  if (pcm16.length === 0) return null;
  if (pcm16.byteOffset % 2 !== 0) {
    pcm16 = Buffer.from(pcm16);
  }
  return { pcm16, sampleRate };
}

/**
 * Delete audio files for a set of hashes.
 * Silently ignores files that don't exist.
 */
export function deleteTtsFiles(hashes: string[]): number {
  let deleted = 0;
  for (const hash of hashes) {
    const filePath = getTtsFilePath(hash);
    try {
      fs.unlinkSync(filePath);
      deleted++;
    } catch {
      // File already deleted or never existed — fine
    }
  }
  if (deleted > 0) {
    log.info({ deleted, total: hashes.length }, 'TTS audio files cleaned up');
  }
  return deleted;
}

/**
 * Sweep the on-disk TTS clip cache by age, then by total size.
 *
 * Nothing else removes clips on a schedule, so without this they would
 * accumulate forever on a persistent volume. This sweeper:
 *  1. selects every `*.wav` whose mtime age exceeds `maxAgeMs`, then
 *  2. if the remaining files still total more than `maxBytes`, selects
 *     oldest-first until under the cap, then
 *  3. drops from that victim set every clip a **non-terminal call still needs**
 *     ({@link setEvictableClipFilter}) and unlinks the rest, then
 *  4. reaps orphaned `writeTtsFile` scratch files left by an interrupted write,
 *     then
 *  5. publishes what it measured to {@link setTtsCacheSweepObserver}.
 *
 * Step 5 is the only cache-LEVEL signal that exists. The overflow is a per-node
 * total across many writes (no single one approaches the cap), and this pass is
 * the only place that
 * total is ever computed — which is why the observer reuses the stats collected
 * here rather than walking the directory again, and why nothing increments a
 * running counter in `writeTtsFile` (it would drift against external deletion
 * and against this sweeper).
 *
 * ── Step 3: the liveness guard ───────────────────────────────────────────────
 *
 * Unconditional eviction is a way to put a callee on a silent line: oldest-first
 * eviction targets exactly the clips generated *earliest*, which may still belong
 * to calls that have not played them yet. The age path carries the same hazard
 * (a call outliving the 6 h TTL); the size path needs no old clip at all and is
 * the far easier of the two to trigger.
 *
 * The guard, when one is registered, is asked once for the whole victim set,
 * never per-hash, and scoped across every caller (one content-addressed file
 * backs every call that plays the same audio). None is registered today: an
 * abandon clip that is evicted is re-decoded from S3 by `ensurePcmClip`.
 *
 * Two consequences, both accepted deliberately:
 *  - A failed or slow lookup **skips clip eviction for this cycle** rather than
 *    deleting unguarded. Retaining a clip too long is harmless — the next sweep
 *    retries — while deleting one that is live is the incident above.
 *  - The size cap is a **soft** target: if the oldest clips are all live, the
 *    cache stays over `maxBytes` until those calls end. Disk pressure is the
 *    cheaper failure.
 *
 * Step 4 is deliberately *outside* the guard: a scratch file is not a clip, is
 * not content-addressed by a hash any row can reference, and is age-gated on its
 * own terms.
 *
 * Step 4 exists because the scratch suffix deliberately isn't `.wav` (so a
 * half-written file can never be mistaken for a clip) — which would otherwise
 * mean an ENOSPC or a crash mid-write leaks a file no sweep ever touches. It is
 * age-gated (`tempReapMinAgeMs`, default 1 h) for the same reason
 * `reapDecodeScratchDirs` is: the cache dir can be a volume shared by several
 * replicas, and a fresh temp may belong to a writer still running elsewhere.
 * Reaps are logged but deliberately kept out of the returned `deleted` /
 * `freedBytes`, which stay a count of evicted *clips* so the existing sweep
 * metrics (and their callers) keep exactly their current meaning.
 *
 * Safe because hashes are content-addressed: deleting an old clip only forces a
 * cheap regeneration on its next use. Fully defensive — no-ops if the dir is
 * missing, ignores files that vanish mid-sweep (ENOENT), and **never rejects**;
 * callers may treat the returned promise as infallible.
 *
 * ── Asynchronous and bounded, deliberately ───────────────────────────────────
 *
 * Every filesystem call here is `fs.promises` and every batch of them is capped
 * at {@link SWEEP_CONCURRENCY}. A synchronous loop — `readdirSync`, then a
 * `statSync` per entry, then `unlinkSync` per eviction — has no yield point
 * anywhere in it, and while it ran the process could not parse media frames,
 * send audio, accept requests or fire timers. That is ~2,500-3,000 back-to-back
 * syscalls at the 500 MB default cap with typical ~200 KB clips, once an hour,
 * and materially worse when `TTS_AUDIO_DIR` is a shared network volume where
 * each `stat` is a round-trip.
 *
 * Note this is the ONLY sweep-path concern addressed here: `writeTtsFile`,
 * `readTtsFile`/`readTtsPcm`, `ttsFileExists` and `deleteTtsFiles` remain
 * synchronous on purpose. Converting those ripples into the bridge's synchronous
 * clip conversion (`convertClipForCarrier`) and into the `ttsFileExists`
 * short-circuit that guards the atomic-write contract above — separate work,
 * with separate hazards.
 */
export function sweepTtsCache(opts: SweepOptions = {}): Promise<SweepResult> {
  // Single-flight. Asynchronous I/O makes overlapping sweeps possible: a sweep
  // on a slow network volume can still be running when the next interval fires,
  // and two concurrent sweeps would double-count `deleted`/`freedBytes` and race
  // each other's unlinks into spurious ENOENT warnings. A caller arriving mid-
  // sweep joins the in-flight run and receives its result.
  //
  // Consequence worth knowing: a joiner's `opts` are ignored — it gets the run
  // that is already going. Harmless for the scheduled sweeper (identical opts
  // every tick) and for tests (which await sequentially).
  if (sweepInFlight) {
    // A joiner is the ONLY externally visible symptom of a wedged sweep. If the
    // volume hangs (stale NFS handle), `fsp.stat` never settles, the slot is
    // never released, and every subsequent interval tick silently no-ops for the
    // lifetime of the process — the cache then grows past `maxBytes` unbounded
    // with nothing in the logs, because the success line below only fires when
    // something was actually deleted. Because the I/O is asynchronous the hang
    // does not wedge the event loop, so it is quiet and has to announce itself.
    //
    // Guarded, and NOT by `runSweep`'s catch — this line runs in `sweepTtsCache`
    // itself, outside the promise. A throw here would leave the function
    // throwing SYNCHRONOUSLY rather than returning a rejected promise, so the
    // `.then(onOk, onErr)` in `bootstrap/voice.ts` would never be attached and the
    // interval's `void sweepTts()` would become an uncaught exception that exits
    // a replica carrying live calls. The documented contract is that this
    // function returns a promise and never rejects; that has to hold on every
    // path out of it, joiner included.
    try {
      log.warn(
        { elapsedMs: Date.now() - sweepStartedAt },
        'TTS cache sweep still running — joining the in-flight run instead of starting a new one',
      );
    } catch {
      // A logger that throws must not become the failure it was reporting —
      // same rule as `runSweep`'s nested guard.
    }
    return sweepInFlight;
  }
  sweepStartedAt = Date.now();
  sweepInFlight = runSweep(opts).finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

/**
 * Enforces the "never rejects" half of {@link sweepTtsCache}'s contract.
 *
 * Every filesystem call in {@link sweepOnce} is individually caught, but the
 * `log.warn`/`log.info` calls are not inside those blocks, so a logger fault (or
 * anything else unforeseen) would otherwise escape as a rejection. That matters
 * specifically because the production caller is a fire-and-forget scheduled
 * task: an unhandled rejection terminates the process by default on Node >= 15,
 * so a cache-cleanup nicety could take down a replica carrying live calls.
 *
 * Counts are reported as zero on this path rather than partially — the sweep did
 * not complete, so it has no trustworthy total to report.
 */
async function runSweep(opts: SweepOptions): Promise<SweepResult> {
  try {
    return await sweepOnce(opts);
  } catch (err) {
    try {
      log.warn({ err }, 'TTS cache sweep aborted unexpectedly');
    } catch {
      // A logger that throws must not become the failure it was reporting.
    }
    return { deleted: 0, freedBytes: 0 };
  }
}

async function sweepOnce(opts: SweepOptions): Promise<SweepResult> {
  const maxAgeMs = opts.maxAgeMs ?? 21_600_000; // 6h
  const maxBytes = opts.maxBytes ?? 524_288_000; // 500MB
  const tempReapMinAgeMs = opts.tempReapMinAgeMs ?? TEMP_REAP_MIN_AGE_MS;
  const concurrency = Math.max(1, Math.trunc(opts.concurrency ?? SWEEP_CONCURRENCY));
  const livenessTimeoutMs = Math.max(1, Math.trunc(opts.livenessTimeoutMs ?? LIVENESS_TIMEOUT_MS));

  let entries: string[];
  try {
    entries = await fsp.readdir(TTS_AUDIO_DIR);
  } catch (err) {
    // Dir doesn't exist yet (never initialized) or unreadable — nothing to do.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, dir: TTS_AUDIO_DIR }, 'TTS cache sweep: could not list cache dir');
    }
    return { deleted: 0, freedBytes: 0 };
  }

  const now = Date.now();
  let deleted = 0;
  let freedBytes = 0;
  let tempsReaped = 0;

  // Collect stats for surviving files so we can apply the size cap afterwards.
  // Workers mutate these counters concurrently, which is safe: JS is single-
  // threaded and `++` never interleaves with another task — only `await` points
  // yield, and there are none inside the updates.
  const survivors: ClipEntry[] = [];
  // Age-expired clips are only *selected* here, not unlinked: the liveness guard
  // runs once over the combined (age + size) victim set, so the unlink for both
  // paths has to happen after this pass rather than inside it.
  const expired: ClipEntry[] = [];

  await runWithConcurrency(entries, concurrency, async (name) => {
    if (TEMP_NAME_RE.test(name)) {
      // Orphaned scratch from an interrupted write. Age-gated: a fresh one may
      // be an in-progress write by this or another replica sharing the volume.
      const tmpPath = path.join(TTS_AUDIO_DIR, name);
      try {
        const stat = await fsp.stat(tmpPath);
        // mtime, not birthtime: birthtime isn't portable across filesystems.
        if (!stat.isFile() || now - stat.mtimeMs <= tempReapMinAgeMs) return;
        await fsp.unlink(tmpPath);
        tempsReaped++;
      } catch (err) {
        // A racing writer may have renamed it away already — not an error.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn({ err, filePath: tmpPath }, 'TTS cache sweep: failed to reap temp file');
        }
      }
      return;
    }
    if (!name.endsWith('.wav')) return;
    const filePath = path.join(TTS_AUDIO_DIR, name);
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return;
      // The filename IS the content hash (`{hash}.wav`) — that is what makes a
      // single set-based liveness lookup possible without re-reading anything.
      const entry: ClipEntry = {
        path: filePath,
        hash: name.slice(0, -4),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      if (now - stat.mtimeMs > maxAgeMs) {
        expired.push(entry);
      } else {
        survivors.push(entry);
      }
    } catch (err) {
      // File vanished mid-sweep or unreadable — ignore, never let it abort.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, filePath }, 'TTS cache sweep: failed to process file');
      }
    }
  });

  // Size cap: if survivors still exceed maxBytes, evict oldest-first.
  //
  // The victim set is chosen up front from the (pure, in-memory) size arithmetic
  // and only then unlinked, rather than deciding as each delete lands.
  // Deliberate: a failed unlink simply frees less, rather than the loop evicting
  // an extra file to compensate. The cap is
  // a soft target on a cache of content-addressed, cheaply regenerable clips,
  // and the next sweep re-evaluates from real stat data — over-evicting on a
  // transient error is the worse of the two behaviours.
  //
  // Age-expired clips seed the victim set rather than having been unlinked in
  // the pass above, so the liveness guard below sees BOTH paths' victims in one
  // set and costs one round-trip rather than two. The size arithmetic
  // deliberately ignores the guard: it assumes every victim goes, and any the
  // guard retains simply leave the cache over the cap until the next sweep.
  // Re-deriving a replacement victim would need a second lookup, and the clip it
  // would pick is by construction newer — i.e. likelier still live.
  const victims: ClipEntry[] = [...expired];
  const survivorBytes = survivors.reduce((sum, f) => sum + f.size, 0);
  // Every clip byte this sweep saw, before any eviction. Derived from the stats
  // already collected above and NOT from a second directory walk — the observer
  // below reuses it, minus what was actually unlinked, as the cache-level gauge.
  // (Scratch files are excluded by construction: they never end in `.wav`, so
  // the gauge is clip bytes, which is what `maxBytes` is compared against.)
  //
  // It is a measurement AS OF THE SCAN, not a live figure: a clip that a
  // concurrent delete elsewhere unlinks after its `stat` but that this
  // sweep never tried to evict stays counted until the next pass. The ENOENT
  // accounting below corrects only the subset this sweep actually touched,
  // which is the only subset it can observe without a second directory walk.
  // Read the gauge as a ceiling on cache size, never as an exact byte count.
  const scannedBytes = survivorBytes + expired.reduce((sum, f) => sum + f.size, 0);
  let totalBytes = survivorBytes;
  if (totalBytes > maxBytes) {
    // Oldest first, then by path to break ties deterministically. The tiebreak is
    // load-bearing: `survivors` is filled in stat-COMPLETION order (threadpool-dependent),
    // not readdir order, and `sort` is stable — so without it, which of two
    // equal-mtime clips gets evicted varies run to run. Filesystems with 1 s
    // mtime granularity (common on network/overlay volumes) tie constantly.
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const f of survivors) {
      if (totalBytes <= maxBytes) break;
      victims.push(f);
      totalBytes -= f.size;
    }
  }

  // Liveness guard — see step 3 of the doc comment. Runs over the combined
  // victim set so both eviction paths cost exactly one round-trip, and returns
  // an EMPTY evictable set (not an unguarded one) on any failure.
  let evictable = victims;
  let retained = 0;
  let livenessFailed = false;
  const isEvictable = evictableClipFilter;
  if (isEvictable && victims.length > 0) {
    // Distinct hashes only: two names can never collide on one hash here (the
    // name IS the hash), but the dedupe keeps the array honest if that changes.
    const candidates = [...new Set(victims.map((f) => f.hash))];
    try {
      const allowed = new Set(await withTimeout(isEvictable(candidates), livenessTimeoutMs));
      evictable = victims.filter((f) => allowed.has(f.hash));
      retained = victims.length - evictable.length;
    } catch (err) {
      // Skip eviction entirely rather than guess. This must not rethrow: the
      // production caller is fire-and-forget (see `runSweep`), and evicting
      // unguarded is the exact failure this guard exists to prevent.
      livenessFailed = true;
      evictable = [];
      retained = victims.length;
      log.warn(
        { err, candidates: candidates.length },
        'TTS cache sweep: clip liveness check failed — skipping eviction this cycle',
      );
    }
  }

  // Bytes counted in `scannedBytes` that are provably NOT on disk any more, but
  // that this sweep did not free. Something else (another replica's sweep on a
  // shared volume, `deleteTtsFiles`) can unlink clips concurrently, so an ENOENT
  // here means "already gone", not "failed to delete". Folding it into `freedBytes` would overstate what
  // the sweep achieved (and is reported in `SweepResult`); leaving it out
  // entirely would overstate the cache gauge until the next hourly sweep, i.e.
  // a false capacity signal on the metric added precisely to watch capacity.
  // So: it is subtracted from the gauge and from nothing else.
  let absentBytes = 0;
  await runWithConcurrency(evictable, concurrency, async (f) => {
    try {
      await fsp.unlink(f.path);
      deleted++;
      freedBytes += f.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        absentBytes += f.size;
        return;
      }
      log.warn({ err, filePath: f.path }, 'TTS cache sweep: failed to evict file');
    }
  });

  if (deleted > 0 || tempsReaped > 0 || retained > 0) {
    log.info(
      { deleted, freedBytes, tempsReaped, retained, livenessFailed, maxAgeMs, maxBytes },
      'TTS cache swept',
    );
  }

  // Publish the cache-level measurements. Emitted only on a completed pass —
  // the early return above (unreadable/absent dir) measured nothing, and
  // publishing 0 bytes there would read as "the cache is empty".
  //
  // Guarded on its own: `runSweep`'s catch would otherwise turn an observer
  // fault into a sweep that reports `{ deleted: 0, freedBytes: 0 }` despite
  // having already unlinked files — i.e. an observability failure corrupting the
  // thing it observes.
  const observer = sweepObserver;
  if (observer) {
    try {
      observer({ cacheBytes: scannedBytes - freedBytes - absentBytes, retained, livenessFailed });
    } catch (err) {
      try {
        log.warn({ err }, 'TTS cache sweep: metrics observer threw — sweep unaffected');
      } catch {
        // A logger that throws must not become the failure it was reporting.
      }
    }
  }

  return { deleted, freedBytes };
}

// ── Sweep types ──────────────────────────────────────────────────────

export interface SweepOptions {
  /** Clips with an mtime older than this are deleted. Default 6 h. */
  maxAgeMs?: number;
  /** Total clip bytes to trim back to, oldest-first. Default 500 MB. */
  maxBytes?: number;
  /** Minimum age before an orphaned scratch file is reaped. Default 1 h. */
  tempReapMinAgeMs?: number;
  /** Max filesystem calls in flight. Default {@link SWEEP_CONCURRENCY}. */
  concurrency?: number;
  /**
   * Bound on the {@link setEvictableClipFilter} lookup. Default
   * {@link LIVENESS_TIMEOUT_MS}. Exceeding it skips eviction for this cycle,
   * exactly as a failed lookup does — the startup sweep is awaited before the
   * first dial is admitted, so this must never be unbounded.
   */
  livenessTimeoutMs?: number;
}

/** One `.wav` in the cache dir, as the sweep sees it. `hash` is the filename minus `.wav`. */
interface ClipEntry {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

/**
 * Reject after `ms` if `p` has not settled, without leaking the timer or an
 * unhandled rejection: `Promise.race` attaches a handler to `p`, so a late
 * rejection is already observed, and the timer is cleared on every exit.
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Counts evicted **clips** only — reaped scratch files are excluded by design. */
export interface SweepResult {
  deleted: number;
  freedBytes: number;
}

/** In-flight sweep, if any. See the single-flight note in {@link sweepTtsCache}. */
let sweepInFlight: Promise<SweepResult> | null = null;
/** When {@link sweepInFlight} started, so a joiner can report how long it has been stuck. */
let sweepStartedAt = 0;

// ── WAV header construction ──────────────────────────────────────────

function createWavBuffer(pcm16: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm16.length;

  // 44-byte WAV header
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);                        // ChunkID
  header.writeUInt32LE(36 + dataSize, 4);          // ChunkSize
  header.write('WAVE', 8);                         // Format
  header.write('fmt ', 12);                        // Subchunk1ID
  header.writeUInt32LE(16, 16);                    // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                     // AudioFormat (1 = PCM)
  header.writeUInt16LE(channels, 22);              // NumChannels
  header.writeUInt32LE(sampleRate, 24);            // SampleRate
  header.writeUInt32LE(byteRate, 28);              // ByteRate
  header.writeUInt16LE(blockAlign, 32);            // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);         // BitsPerSample
  header.write('data', 36);                        // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);              // Subchunk2Size

  return Buffer.concat([header, pcm16]);
}
