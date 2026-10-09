// Deploy-concern check: decode must fail cleanly when the decoder is missing. The decode suite
// skips the real-decode cases when the binaries are absent (`skipIf(!HAVE_DECODERS)`) and
// `decoder-toolchain-packaging.test.ts` asserts the Dockerfile installs them (there is no
// Dockerfile yet). This drives the REAL spawn path at binaries that do
// not exist (the `MPG123_BIN` / `SNDFILE_CONVERT_BIN` overrides, read at import) and
// pins that the result is the typed `DECODE_FAILED` — never a crash, a hang or an untyped
// error — for both decoders.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.hoisted(() => {
  process.env['MPG123_BIN'] = '/nonexistent/magick-agency/mpg123';
  process.env['SNDFILE_CONVERT_BIN'] = '/nonexistent/magick-agency/sndfile-convert';
});
vi.mock('../../../src/config/index.js', () => ({ config: { audio: { decodeTimeoutMs: 90_000 } } }));

const { decodeToPcm16, AudioDecodeError } = await import('../../../src/audio/decode.js');

const FIXTURES = path.join(__dirname, '../../fixtures/audio');

describe('decodeToPcm16 with the decoder binaries missing (ENOENT)', () => {
  it.each([
    ['audio/mpeg', 'mono-440-44100.mp3'],
    ['audio/wav', 'mono-440-16000.wav'],
    ['audio/ogg', 'mono-440-16000.ogg'],
  ])('%s fails with AudioDecodeError(DECODE_FAILED) naming the spawn error', async (contentType, file) => {
    const input = fs.readFileSync(path.join(FIXTURES, file));
    const err = await decodeToPcm16(input, contentType).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AudioDecodeError);
    expect((err as InstanceType<typeof AudioDecodeError>).code).toBe('DECODE_FAILED');
    // Both decoders in the chain were tried and each failed to spawn.
    expect((err as InstanceType<typeof AudioDecodeError>).detail ?? '').toMatch(/mpg123/);
    expect((err as InstanceType<typeof AudioDecodeError>).detail ?? '').toMatch(/sndfile/);
  });
});
