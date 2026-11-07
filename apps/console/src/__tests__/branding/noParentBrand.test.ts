import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ORIGINATOR } from '../../config';
import { brand } from '../../brand';
import { PARENT_BRAND } from '../helpers/parentBrand';
import { shippedFiles, stripComments } from './sourceScan';

/**
 * Magick Agency ships no link to, and no visible mention of, the parent product
 * (decision B17, Manas 2026-10-09: "this shouldn't have any linking present").
 *
 * A source scan, for the reason
 * `agencyShellBoundary.test.ts` gives for being one: a link to the parent product
 * renders and navigates perfectly, so nothing at the DOM can tell it is wrong.
 *
 * What is scanned is everything that ships: every non-test file under `src/`
 * (code, CSS, JSON), `index.html`, `vite.config.ts` (it picks the default brand)
 * and the brand packs. Comments are stripped first — provenance notes such as
 * a note saying which brand a line used to carry is documentation, not
 * product, and a guard that fires on its own documentation gets deleted.
 * Tests are not scanned: their fixtures may name the parent product's hosts.
 * The components both apps import from `packages/web-ui` ship here too; that
 * package's own `test/noParentBrand.test.ts` scans them.
 */

const srcRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const appRoot = dirname(srcRoot);

const SCANNED_EXT = new Set(['.ts', '.tsx', '.css', '.json', '.html']);

function shipped(): string[] {
  return [
    ...shippedFiles(srcRoot, SCANNED_EXT),
    ...shippedFiles(join(appRoot, 'brands'), SCANNED_EXT),
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

describe('no parent-product branding or links (B17)', () => {
  it('names the parent product nowhere in shipped source, outside comments', () => {
    expect(parentBrandMentions()).toEqual([]);
  });

  // B17 as amended 2026-10-11: the default pack ships the logo artwork (its own
  // public/logo.png and favicon.png), but the old pack folder stays gone and the
  // tab title and icon come from the brand, never a hard-coded file.
  it('ships Magick Agency as the default brand, and not the old brand pack', () => {
    expect(brand.id).toBe('magick-agency');
    expect(brand.name).toBe('Magick Agency');
    expect(existsSync(join(appRoot, 'brands', 'magickvoice'))).toBe(false);
    const html = readFileSync(join(appRoot, 'index.html'), 'utf8');
    expect(html).toContain('<title>%BRAND_NAME%</title>');
    expect(html).toContain('<link rel="icon" href="%BRAND_FAVICON%" />');
  });

  it('attributes API calls as magick-agency-console', () => {
    expect(ORIGINATOR).toBe('magick-agency-console');
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
