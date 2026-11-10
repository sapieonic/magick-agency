import fs from 'node:fs';
import path from 'node:path';
import type { AgencyInboundStandardRecording } from '@magick-agency/contracts/api/agency/inbound';

/*
 * Where the inbound standard recordings are (`inbound-standard-clips.ts`). Import-free beyond
 * the contract and Node, so `scripts/generate-inbound-clips.ts` can name the files without loading
 * the server's config.
 */

/** The file of each standard recording in {@link inboundStandardClipDir}. */
export const INBOUND_STANDARD_CLIP_FILES: Readonly<Record<AgencyInboundStandardRecording, string>> = Object.freeze({
  please_hold: 'please-hold.wav',
  recording_notice: 'recording-notice.wav',
  closed: 'closed.wav',
  busy: 'busy.wav',
  callback: 'callback.wav',
  voicemail_prompt: 'voicemail-prompt.wav',
  voicemail_prompt_neutral: 'voicemail-prompt-neutral.wav',
});

const ASSET_SUBDIR = path.join('assets', 'inbound');

let resolvedDir: string | null = null;

/**
 * `apps/server/assets/inbound`: found by walking up from this module, which is
 * `src/agency/inbound/` from source (tsx, Vitest) and `dist/` in the bundle (the image puts the
 * directory beside `dist/`, docker/Dockerfile).
 */
export function inboundStandardClipDir(): string {
  if (resolvedDir) return resolvedDir;
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ASSET_SUBDIR);
    if (fs.existsSync(path.join(candidate, INBOUND_STANDARD_CLIP_FILES.please_hold))) {
      resolvedDir = candidate;
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not found: report the source layout's path, so the error names where the files belong.
  return path.resolve(__dirname, '..', '..', '..', ASSET_SUBDIR);
}
