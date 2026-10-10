import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Brand, BrandColors, BrandStyle } from './types';

/**
 * Validate the optional `style` block, keeping only well-formed fields. Unknown
 * or malformed values are dropped (fail-closed to the default look) rather than
 * thrown, so a typo degrades gracefully instead of failing the build. Returns
 * undefined when nothing valid is present.
 */
function sanitizeStyle(raw: unknown): BrandStyle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const style: BrandStyle = {};

  if (r.radius === 'sharp' || r.radius === 'default' || r.radius === 'soft') {
    style.radius = r.radius;
  } else if (typeof r.radius === 'number' && r.radius >= 0 && r.radius <= 64) {
    style.radius = r.radius;
  }
  if (r.elevation === 'flat' || r.elevation === 'soft' || r.elevation === 'glow') {
    style.elevation = r.elevation;
  }
  if (typeof r.gradientAngle === 'number' && Number.isFinite(r.gradientAngle)) {
    style.gradientAngle = r.gradientAngle;
  }
  if (r.flatButtons === true) {
    style.flatButtons = true;
  }

  return Object.keys(style).length > 0 ? style : undefined;
}

/** A brand id must be a simple slug — no path separators or `..` traversal. */
const VALID_BRAND_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** A brand asset path: one file at the site root, an image type, no traversal. */
const VALID_ASSET_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|svg|ico|webp)$/;

/**
 * Validate an optional asset field (`logo`, `favicon`). Absent = undefined. Present
 * but malformed, or naming a file the pack's `public/` does not have, throws: the
 * operator asked for an image, and shipping a broken one is worse than failing the
 * build.
 */
function assetPath(
  brandsDir: string,
  brandName: string,
  field: 'logo' | 'favicon',
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !VALID_ASSET_PATH.test(value)) {
    throw new Error(
      `Brand "${brandName}": "${field}" must be a root path to an image in public/, like "/${field}.png"`,
    );
  }
  const file = join(brandsDir, brandName, 'public', value.slice(1));
  if (!existsSync(file)) {
    throw new Error(`Brand "${brandName}": "${field}" names ${value}, but ${file} does not exist`);
  }
  return value;
}

/**
 * Read and validate a brand pack's config at build time. Used by vite.config.ts
 * (and the tests). Throws loudly so a misconfigured whitelabel fails the build
 * rather than shipping a half-branded app.
 *
 * `brandName` comes from the build-time `VITE_BRAND` env var (operator-set, not
 * user input), but it's still validated as a slug so a typo fails fast and a
 * value like `../x` can't resolve a path outside `brands/`.
 */
export function loadBrandConfig(brandsDir: string, brandName: string): Brand {
  if (!VALID_BRAND_ID.test(brandName)) {
    throw new Error(
      `Invalid brand id "${brandName}": expected a slug like "acme" (lowercase letters, digits, "-", "_")`,
    );
  }

  const path = join(brandsDir, brandName, 'brand.config.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw new Error(`Brand "${brandName}" not found: missing ${path}`);
  }

  let parsed: Partial<Brand>;
  try {
    parsed = JSON.parse(raw) as Partial<Brand>;
  } catch {
    throw new Error(`Brand "${brandName}": brand.config.json contains invalid JSON (${path})`);
  }

  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error(`Brand "${brandName}": "name" is required`);
  }
  if (typeof parsed.shortName !== 'string' || parsed.shortName.length === 0) {
    throw new Error(`Brand "${brandName}": "shortName" is required`);
  }
  if (
    !parsed.colors ||
    typeof parsed.colors.accent !== 'string' ||
    typeof parsed.colors.accentHover !== 'string'
  ) {
    throw new Error(
      `Brand "${brandName}": "colors.accent" and "colors.accentHover" are required`,
    );
  }

  const colors: BrandColors = {
    accent: parsed.colors.accent,
    accentHover: parsed.colors.accentHover,
  };
  if (typeof parsed.colors.accentLight === 'string') {
    colors.accentLight = parsed.colors.accentLight;
  }
  if (typeof parsed.colors.accentLightHover === 'string') {
    colors.accentLightHover = parsed.colors.accentLightHover;
  }

  return {
    // The validated folder slug is the canonical brand id (not from the file).
    id: brandName,
    name: parsed.name,
    shortName: parsed.shortName,
    // tagline is optional; ignore non-string values rather than passing them
    // through and violating the Brand contract.
    tagline: typeof parsed.tagline === 'string' ? parsed.tagline : undefined,
    logo: assetPath(brandsDir, brandName, 'logo', parsed.logo),
    favicon: assetPath(brandsDir, brandName, 'favicon', parsed.favicon),
    // optional non-color style levers; omitted entirely when nothing valid.
    style: sanitizeStyle(parsed.style),
    colors,
  };
}

/** HTML-escape a value destined for HTML text (e.g. the `<title>`). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Replace every `%BRAND_NAME%` placeholder in index.html with the brand name.
 * Used by the Vite plugin's `transformIndexHtml` hook; extracted as a pure
 * function so the title-injection behavior is unit-testable. The name is
 * HTML-escaped so a brand like "Tom & Jerry" yields valid markup, and a
 * function replacer avoids `$`-pattern interpretation in the replacement.
 */
export function injectBrandName(html: string, name: string): string {
  const escaped = escapeHtml(name);
  return html.replace(/%BRAND_NAME%/g, () => escaped);
}

/**
 * Replace the `%BRAND_FAVICON%` placeholder (the icon link's href in index.html)
 * with the brand's favicon path, or `data:,` when it has none, so browsers never
 * request a missing `/favicon.ico`.
 */
export function injectBrandFavicon(html: string, favicon: string | undefined): string {
  const href = favicon === undefined ? 'data:,' : escapeHtml(favicon);
  return html.replace(/%BRAND_FAVICON%/g, () => href);
}
