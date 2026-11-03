/**
 * Per-frame cost of the WebRTC bridge transcoder, current vs the pre-rewrite reference.
 *
 * Not a test: it prints timings and asserts nothing about them. Bit-identity is
 * `test/unit/utils/audio-fir.reference.test.ts`'s job; this script only re-checks
 * that both sides produced the same bytes, so a broken build cannot post a good time.
 *
 *   pnpm tsx scripts/bench-transcoder.ts            # from apps/server
 *   BENCH_FRAMES=500000 pnpm tsx scripts/bench-transcoder.ts
 *
 * One frame is 20 ms: 640 bytes of PCM16 16 kHz (browser → carrier, `pcm16kToAlaw`)
 * or 160 bytes of A-law 8 kHz (carrier → browser, `alawToPcm16k`). Each figure is
 * the median of several timed rounds after a warm-up, so the JIT has settled. Time is
 * process CPU time (user + system), not wall time, so other work on a shared machine
 * does not inflate it.
 */
import { VoicelinkTranscoder } from '../src/utils/audio-fir.js';
import { encodeAlaw } from '../src/utils/audio.js';
import { ReferenceVoicelinkTranscoder } from '../test/helpers/reference-audio-fir.js';

interface Codec {
  pcm16kToAlaw(pcm: Buffer): Buffer;
  alawToPcm16k(alaw: Buffer): Buffer;
}

const FRAMES = Number(process.env['BENCH_FRAMES'] ?? 50_000);
const ROUNDS = 7;
/** Distinct frames cycled through, so the JIT cannot specialise on one input. */
const VARIANTS = 64;

function speechLike(n: number, rate: number, seed: number): Int16Array {
  const s = new Int16Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const t = (seed * n + i) / rate;
    const v = 6000 * Math.sin(2 * Math.PI * 220 * t) + 3000 * Math.sin(2 * Math.PI * 1370 * t) + ((x % 2001) - 1000);
    s[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return s;
}

const pcmFrames: Buffer[] = [];
const alawFrames: Buffer[] = [];
for (let v = 0; v < VARIANTS; v++) {
  const pcm = speechLike(320, 16000, v + 1);
  pcmFrames.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  alawFrames.push(encodeAlaw(speechLike(160, 8000, v + 101)));
}

let sink = 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Process CPU time in µs. */
function cpuMicros(): number {
  const u = process.cpuUsage();
  return u.user + u.system;
}

/** CPU µs per call of `fn` over `FRAMES` frames, median of `ROUNDS`. */
function time(fn: (i: number) => Buffer): number {
  for (let i = 0; i < 20_000; i++) sink += fn(i).length; // warm-up
  const rounds: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = cpuMicros();
    for (let i = 0; i < FRAMES; i++) sink += fn(i).length;
    rounds.push((cpuMicros() - t0) / FRAMES);
  }
  return median(rounds);
}

function bench(codec: Codec): { down: number; up: number } {
  const down = time((i) => codec.pcm16kToAlaw(pcmFrames[i % VARIANTS]!));
  const up = time((i) => codec.alawToPcm16k(alawFrames[i % VARIANTS]!));
  return { down, up };
}

function sameBytes(): boolean {
  const a = new VoicelinkTranscoder();
  const b = new ReferenceVoicelinkTranscoder();
  for (let i = 0; i < 5_000; i++) {
    const v = i % VARIANTS;
    if (!a.pcm16kToAlaw(pcmFrames[v]!).equals(b.pcm16kToAlaw(pcmFrames[v]!))) return false;
    if (!a.alawToPcm16k(alawFrames[v]!).equals(b.alawToPcm16k(alawFrames[v]!))) return false;
  }
  return true;
}

if (!sameBytes()) {
  console.error('current and reference transcoders disagree: run test/unit/utils/audio-fir.reference.test.ts');
  process.exit(1);
}

const before = bench(new ReferenceVoicelinkTranscoder());
const after = bench(new VoicelinkTranscoder());

const fmt = (us: number): string => us.toFixed(2).padStart(7);
/** Event-loop share for N calls: two directions, 50 frames a second each. */
const loopShare = (r: { down: number; up: number }, calls: number): string =>
  `${(((r.down + r.up) * 50 * calls) / 1e6 * 100).toFixed(1)}%`;

console.log(`node ${process.version}, ${FRAMES} frames x ${ROUNDS} rounds, median CPU µs per 20 ms frame`);
console.log('                         reference   current   speed-up');
console.log(`pcm16kToAlaw  (640 B) ${fmt(before.down)}   ${fmt(after.down)}   ${(before.down / after.down).toFixed(1)}x`);
console.log(`alawToPcm16k  (160 B) ${fmt(before.up)}   ${fmt(after.up)}   ${(before.up / after.up).toFixed(1)}x`);
console.log(`event loop at 500 calls ${loopShare(before, 500).padStart(9)} ${loopShare(after, 500).padStart(9)}`);
if (sink === -1) console.log(sink); // keep the results live
