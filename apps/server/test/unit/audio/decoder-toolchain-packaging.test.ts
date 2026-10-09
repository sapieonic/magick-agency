import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The decoders are external binaries, so "does the code compile" says nothing
// about whether they exist at runtime. Losing them from the image does not fail a
// build or a test — it turns EVERY audio-file upload into a 400 in production.
// These assertions are the only thing standing between a dependency-trimming PR
// and that outage.
// PORT NOTE (magick-agency): core `test/unit/audio/decoder-toolchain-packaging.test.ts:10`@4850d1d9
// read `path.join(process.cwd(), 'docker/Dockerfile')`; this suite runs from apps/server, and
// the Dockerfile is at the monorepo root, so the path is resolved from this file instead.
const DOCKERFILE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../../docker/Dockerfile'),
  'utf8',
);

/**
 * The package list only — comments explaining the choice mention the rejected
 * alternatives by name, so matching the whole file would assert against its own
 * documentation.
 */
const APT_LINES = DOCKERFILE.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n')
  .match(/apt-get install[\s\S]*?(?=\n(?:[A-Z]{2,}|\s*$))/)?.[0] ?? '';

describe('docker/Dockerfile — decoder toolchain is installed (§4)', () => {
  it('installs mpg123', () => {
    expect(APT_LINES).toMatch(/\bmpg123\b/);
  });

  it('installs sndfile-programs, NOT the library-only libsndfile1', () => {
    // libsndfile1 / libmpg123-0 ship no binaries and are unusable from Node
    // without FFI — installing those instead would look correct and fail at
    // runtime with ENOENT on every upload.
    expect(APT_LINES).toMatch(/\bsndfile-programs\b/);
    expect(APT_LINES).not.toMatch(/\blibsndfile1\b/);
    expect(APT_LINES).not.toMatch(/\blibmpg123-0\b/);
  });

  it('adds them to the EXISTING apt layer rather than creating a second one', () => {
    const aptLayers = [...DOCKERFILE.matchAll(/apt-get install/g)];
    expect(aptLayers).toHaveLength(1);
    // Same RUN as libsamplerate0.
    expect(APT_LINES).toMatch(/libsamplerate0[\s\S]{0,80}mpg123[\s\S]{0,80}sndfile-programs/);
  });

  it('keeps the apt-list cleanup so the layer stays small (+14 MB measured)', () => {
    expect(APT_LINES).toMatch(/rm -rf \/var\/lib\/apt\/lists/);
  });

  it('does NOT install ffmpeg (+395 MB; AAC is rejected at upload instead)', () => {
    expect(APT_LINES).not.toMatch(/\bffmpeg\b/);
  });

  it('still installs libsamplerate0 (pre-existing dependency, must not be displaced)', () => {
    expect(APT_LINES).toMatch(/\blibsamplerate0\b/);
  });
});
