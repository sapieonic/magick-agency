import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { brand } from '../../brand';

/**
 * The super-admin app has no brand pack: its logo and favicon are copies, in
 * `public/`, of the console's default pack (`apps/console/brands/magick-agency/public/`).
 * This pins that the files the brand names exist, that index.html uses the
 * favicon, and that the copies match the console's byte for byte, so the two
 * apps cannot drift to different artwork.
 */

const appRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const publicDir = join(appRoot, 'public');
const consolePublic = join(appRoot, '..', 'console', 'brands', 'magick-agency', 'public');

describe('brand assets', () => {
  it.each([brand.logo, brand.favicon])('%s exists in public/', (path) => {
    expect(existsSync(join(publicDir, path.slice(1)))).toBe(true);
  });

  it.each([brand.logo, brand.favicon])("%s is byte-identical to the console's default pack", (path) => {
    const mine = readFileSync(join(publicDir, path.slice(1)));
    const consoles = readFileSync(join(consolePublic, path.slice(1)));
    expect(mine.equals(consoles)).toBe(true);
  });

  it('index.html links the favicon', () => {
    const html = readFileSync(join(appRoot, 'index.html'), 'utf8');
    expect(html).toContain(`<link rel="icon" type="image/png" href="${brand.favicon}" />`);
  });
});
