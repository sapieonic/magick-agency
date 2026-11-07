import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ORIGINATOR } from '../../config';
import { brand } from '../../brand';
import { shippedFiles, stripComments } from './sourceScan';

/**
 * Magick Agency ships no link to, and no visible mention of, its parent product
 * (decision B17, Manas 2026-10-09: "this shouldn't have any linking present").
 *
 * The super-admin twin of
 * `apps/console/src/__tests__/branding/noParentBrand.test.ts`: a link or a name
 * renders perfectly, so only a source scan can tell it is wrong.
 *
 * What is scanned is everything that ships: every non-test file under `src/`
 * (code, CSS, JSON), `index.html` and `vite.config.ts`. Comments are stripped first — provenance notes that
 * name the parent product are documentation, not
 * product, and a guard that fires on its own documentation gets deleted.
 * Tests are not scanned: their fixtures may name the parent product's hosts.
 * The components both apps import from `packages/web-ui` ship here too; that
 * package's own `test/noParentBrand.test.ts` scans them.
 */

const srcRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const appRoot = dirname(srcRoot);

/** The parent product's name in any spacing or case, and its domains. */
const PARENT_BRAND = /magick[\s_-]?voice|magic[\s_-]?voice/i;

const SCANNED_EXT = new Set(['.ts', '.tsx', '.css', '.json', '.html']);

function shipped(): string[] {
  return [
    ...shippedFiles(srcRoot, SCANNED_EXT),
    join(appRoot, 'index.html'),
    join(appRoot, 'vite.config.ts'),
  ];
}

/** `path:line` for every mention of the parent brand left after comments are stripped. */
function parentBrandMentions(): string[] {
  return shipped().flatMap((path) => {
    const rel = relative(appRoot, path);
    return stripComments(readFileSync(path, 'utf8'))
      .split('\n')
      .flatMap((line, index) => (PARENT_BRAND.test(line) ? [`${rel}:${index + 1}: ${line.trim()}`] : []));
  });
}

describe('no parent-brand branding or links (B17)', () => {
  it('names the parent brand nowhere in shipped source, outside comments', () => {
    expect(parentBrandMentions()).toEqual([]);
  });

  it('is branded Magick Agency', () => {
    expect(brand.id).toBe('magick-agency');
    expect(brand.name).toBe('Magick Agency');
  });

  it('attributes API calls as magick-agency-super-admin', () => {
    expect(ORIGINATOR).toBe('magick-agency-super-admin');
  });

  it('strips comments but still sees strings', () => {
    expect(PARENT_BRAND.test(stripComments('// ported from MagickVoice\nconst x = 1;'))).toBe(false);
    expect(PARENT_BRAND.test(stripComments('/** Magick Voice */\n{/* magick-voice */}<div />'))).toBe(false);
    expect(PARENT_BRAND.test(stripComments('<!-- MagickVoice --><title>x</title>'))).toBe(false);
    expect(PARENT_BRAND.test(stripComments("const s = 'Back to MagickVoice';"))).toBe(true);
    expect(PARENT_BRAND.test(stripComments('<a href="https://docs.magickvoice.com">'))).toBe(true);
    // JSX prose with an apostrophe does not hide the next line.
    expect(PARENT_BRAND.test(stripComments("<p>don't</p>\nconst u = 'magickvoice.com';"))).toBe(true);
  });

  it('sees unquoted URLs, where `//` follows a scheme rather than opening a comment', () => {
    expect(PARENT_BRAND.test(stripComments('<p>Visit https://docs.magickvoice.com for help</p>'))).toBe(true);
    expect(PARENT_BRAND.test(stripComments('.x { background: url(https://cdn.magickvoice.com/a.png) }'))).toBe(true);
    expect(PARENT_BRAND.test(stripComments('<a href=https://magickvoice.com>'))).toBe(true);
    // A real line comment that contains a URL is still a comment.
    expect(PARENT_BRAND.test(stripComments('const x = 1; // see https://magickvoice.com'))).toBe(false);
  });
});
