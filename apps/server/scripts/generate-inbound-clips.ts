/**
 * Regenerates the inbound calls' standard recordings (`assets/inbound/*.wav`, docs/inbound.md
 * §3.4) from their words (`AGENCY_INBOUND_STANDARD_WORDS`, the contract the carrier's spoken
 * stand-ins also read), so a recording and its spoken words can never say different things.
 *
 * Not run in CI or at build time: the WAVs are committed. Run it by hand after changing the words
 * (and commit the WAVs with the words), or replace the files with professionally recorded ones of
 * the same names and format (assets/inbound/README.md).
 *
 * Needs Piper (https://github.com/rhasspy/piper; `pip install piper-tts` in a virtualenv) with the
 * voice named in assets/inbound/README.md, and ffmpeg. From apps/server:
 *
 *   pnpm tsx scripts/generate-inbound-clips.ts \
 *     --piper /path/to/venv/bin/piper \
 *     --model /path/to/en-gb-southern_english_female-low.onnx \
 *     [--only voicemail_prompt_neutral,closed]
 *
 * `--only` regenerates just the named recordings (a new one, or one whose words changed), so the
 * others stay byte for byte as committed.
 *
 * Each recording is synthesised at the voice's own rate, then converted with ffmpeg to the form
 * the bridge plays without any work per call: WAV, PCM16, 8 kHz (the telephony rate), mono, with
 * no metadata chunks, 3 dB of headroom, a short lead-in and a trailing pause.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENCY_INBOUND_STANDARD_RECORDINGS,
  AGENCY_INBOUND_STANDARD_WORDS,
  type AgencyInboundStandardRecording,
} from '@magick-agency/contracts/api/agency/inbound';
import { INBOUND_STANDARD_CLIP_FILES, inboundStandardClipDir } from '../src/agency/inbound/inbound-standard-clip-files.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) {
    console.error(`Missing --${name}. Usage: pnpm tsx scripts/generate-inbound-clips.ts --piper <piper> --model <voice.onnx>`);
    process.exit(2);
  }
  return value;
}

/** `--only a,b`: the recordings to regenerate (every one when absent); an unknown name is refused. */
function only(): readonly AgencyInboundStandardRecording[] {
  const i = process.argv.indexOf('--only');
  if (i < 0) return AGENCY_INBOUND_STANDARD_RECORDINGS;
  const names = (process.argv[i + 1] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  const known = new Set<string>(AGENCY_INBOUND_STANDARD_RECORDINGS);
  const unknown = names.filter((n) => !known.has(n));
  if (names.length === 0 || unknown.length > 0) {
    console.error(`--only takes recordings among ${AGENCY_INBOUND_STANDARD_RECORDINGS.join(', ')}${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);
    process.exit(2);
  }
  return names as AgencyInboundStandardRecording[];
}

function run(cmd: string, args: string[], input?: string): void {
  const res = spawnSync(cmd, args, { input, stdio: ['pipe', 'inherit', 'inherit'] });
  if (res.status !== 0) {
    console.error(`${cmd} failed (exit ${res.status ?? res.signal})`);
    process.exit(1);
  }
}

const piper = arg('piper');
const model = arg('model');
const recordings = only();
const outDir = inboundStandardClipDir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-clips-'));
try {
  for (const recording of recordings) {
    const words = AGENCY_INBOUND_STANDARD_WORDS[recording];
    // Piper reads curly apostrophes as written; plain ones keep its phonemiser on familiar ground.
    const spoken = words.replace(/’/g, "'");
    const raw = path.join(scratch, `${recording}.raw.wav`);
    run(piper, ['--model', model, '--output-file', raw, '--sentence-silence', '0.35'], spoken);
    const out = path.join(outDir, INBOUND_STANDARD_CLIP_FILES[recording]);
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', raw,
      // 3 dB of headroom (Piper peaks at full scale, which G.711 clips), 0.2 s of lead-in and
      // 0.5 s of trailing pause, at the telephony rate.
      '-af', 'volume=-3dB,adelay=200,apad=pad_dur=0.5',
      '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le',
      '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
      out,
    ]);
    console.log(`${path.relative(process.cwd(), out)}  “${words}”`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
