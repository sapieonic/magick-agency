/**
 * IBM Plex Sans and Mono, embedded in the HTML as data URIs so the PDF looks the same wherever it
 * is drawn (the Lambda's Chromium has almost no fonts). The woff2 files come from
 * `@fontsource/ibm-plex-sans` / `-mono`, found in this order:
 *  1. `REPORT_RENDERER_FONTS_DIR` (a directory holding the files by their fontsource names);
 *  2. a `fonts/` directory beside this module (the Lambda bundle copies them there);
 *  3. the fontsource packages through Node resolution from this module (a workspace install;
 *     in the server's bundle, from the server's own node_modules).
 * Missing files degrade to the system font stack with `embedded: false`, never a failed render.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface FontFace {
  family: 'IBM Plex Sans' | 'IBM Plex Mono';
  weight: number;
  /** `latin` or `latin-ext`, each with its unicode-range. */
  subset: 'latin' | 'latin-ext';
  file: string;
  pkg: '@fontsource/ibm-plex-sans' | '@fontsource/ibm-plex-mono';
}

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

/** Every face the templates use. */
export const FONT_FACES: FontFace[] = [
  ...[400, 500, 600].flatMap((weight) =>
    (['latin', 'latin-ext'] as const).map((subset) => ({
      family: 'IBM Plex Sans' as const,
      weight,
      subset,
      file: `ibm-plex-sans-${subset}-${weight}-normal.woff2`,
      pkg: '@fontsource/ibm-plex-sans' as const,
    })),
  ),
  ...[400, 500].map((weight) => ({
    family: 'IBM Plex Mono' as const,
    weight,
    subset: 'latin' as const,
    file: `ibm-plex-mono-latin-${weight}-normal.woff2`,
    pkg: '@fontsource/ibm-plex-mono' as const,
  })),
];

export interface FontSet {
  /** `@font-face` rules with data URIs (empty when nothing was found). */
  css: string;
  /** True when every face was embedded. */
  embedded: boolean;
}

/** This module's location, in an ES module (tests, the Lambda bundle) or a CommonJS bundle (the server). */
function moduleUrl(): string | null {
  const url = (import.meta as { url?: string }).url;
  if (typeof url === 'string' && url !== '') return url;
  if (typeof __filename === 'string') return pathToFileURL(__filename).href;
  return null;
}

function locate(face: FontFace, env: Record<string, string | undefined>): string | null {
  const dirs: string[] = [];
  if (env.REPORT_RENDERER_FONTS_DIR) dirs.push(env.REPORT_RENDERER_FONTS_DIR);
  const url = moduleUrl();
  if (url) dirs.push(join(dirname(fileURLToPath(url)), 'fonts'));
  for (const dir of dirs) {
    const p = join(dir, face.file);
    if (existsSync(p)) return p;
  }
  if (url) {
    try {
      return createRequire(url).resolve(`${face.pkg}/files/${face.file}`);
    } catch {
      return null;
    }
  }
  return null;
}

let cached: FontSet | null = null;

/** The embedded font CSS, read once per process. */
export function loadFonts(env: Record<string, string | undefined> = process.env): FontSet {
  if (cached && env === process.env) return cached;
  const rules: string[] = [];
  let missing = 0;
  for (const face of FONT_FACES) {
    const path = locate(face, env);
    if (!path) {
      missing += 1;
      continue;
    }
    const data = readFileSync(path).toString('base64');
    rules.push(
      `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${face.weight};font-display:block;` +
        `src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${face.subset === 'latin' ? LATIN : LATIN_EXT}}`,
    );
  }
  const set = { css: rules.join('\n'), embedded: missing === 0 };
  if (env === process.env) cached = set;
  return set;
}

/** The fontsource files to copy beside a bundle (`scripts/build-lambda.mjs`). */
export function fontFileNames(): string[] {
  return FONT_FACES.map((f) => f.file);
}
