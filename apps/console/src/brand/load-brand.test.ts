import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBrandConfig, injectBrandName } from './load-brand';

/** The real, shipped brands directory (used for the default-brand assertions). */
const REAL_BRANDS = join(process.cwd(), 'brands');

/** A unique scratch brands root per run, so parallel workers/runs can't race. */
const TMP_BRANDS = mkdtempSync(join(tmpdir(), 'mvc-load-brand-'));

/** Write a synthetic `brand.config.json` under TMP_BRANDS/<name>/. */
function writeBrand(name: string, contents: string): void {
  const dir = join(TMP_BRANDS, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.config.json'), contents);
}

beforeAll(() => {
  writeBrand('valid-minimal', JSON.stringify({
    name: 'Minimal',
    shortName: 'MIN',
    colors: { accent: '#010203', accentHover: '#040506' },
  }));
  writeBrand('with-light', JSON.stringify({
    name: 'Light Co',
    shortName: 'LC',
    tagline: 'Hello',
    colors: {
      accent: '#010203', accentHover: '#040506',
      accentLight: '#0a0b0c', accentLightHover: '#0d0e0f',
    },
  }));
  writeBrand('light-partial', JSON.stringify({
    name: 'Partial', shortName: 'P',
    colors: { accent: '#010203', accentHover: '#040506', accentLight: '#0a0b0c' },
  }));
  writeBrand('promotions-on', JSON.stringify({
    name: 'Promo', shortName: 'PR', promotions: true,
    colors: { accent: '#010203', accentHover: '#040506' },
  }));
  writeBrand('with-style', JSON.stringify({
    name: 'Styled', shortName: 'ST',
    style: { radius: 'sharp', elevation: 'flat', gradientAngle: 90, flatButtons: true },
    colors: { accent: '#010203', accentHover: '#040506' },
  }));
  writeBrand('bad-style', JSON.stringify({
    name: 'Bad', shortName: 'BD',
    style: { radius: 'wobbly', elevation: 'sparkly', gradientAngle: 'tilted', flatButtons: 'yes' },
    colors: { accent: '#010203', accentHover: '#040506' },
  }));
  writeBrand('bad-json', '{ this is not valid json');
  writeBrand('bad-tagline', JSON.stringify({
    name: 'X', shortName: 'X', tagline: 123,
    colors: { accent: '#010203', accentHover: '#040506' },
  }));
  writeBrand('no-name', JSON.stringify({ shortName: 'X', colors: { accent: '#010203', accentHover: '#040506' } }));
  writeBrand('empty-name', JSON.stringify({ name: '', shortName: 'X', colors: { accent: '#010203', accentHover: '#040506' } }));
  writeBrand('no-shortname', JSON.stringify({ name: 'X', colors: { accent: '#010203', accentHover: '#040506' } }));
  writeBrand('no-colors', JSON.stringify({ name: 'X', shortName: 'X' }));
  writeBrand('no-accent-hover', JSON.stringify({ name: 'X', shortName: 'X', colors: { accent: '#010203' } }));
});

afterAll(() => {
  rmSync(TMP_BRANDS, { recursive: true, force: true });
});

describe('loadBrandConfig — default brand', () => {
  // Decision B17: the shipped default brand is `magick-agency`.
  it('loads the shipped magick-agency brand', () => {
    const b = loadBrandConfig(REAL_BRANDS, 'magick-agency');
    expect(b.name).toBe('Magick Agency');
    expect(b.shortName).toBe('MA');
    expect(b.colors.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(b.colors.accentHover).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('carries the default light-theme accents', () => {
    const b = loadBrandConfig(REAL_BRANDS, 'magick-agency');
    expect(b.colors.accentLight).toBe('#6a4de4');
    expect(b.colors.accentLightHover).toBe('#5a40ce');
  });

  it('sets the brand id to the folder slug, not a value from the file', () => {
    expect(loadBrandConfig(REAL_BRANDS, 'magick-agency').id).toBe('magick-agency');
    expect(loadBrandConfig(TMP_BRANDS, 'valid-minimal').id).toBe('valid-minimal');
  });
});

describe('loadBrandConfig — error paths', () => {
  it('rejects unsafe brand ids before touching the filesystem', () => {
    for (const id of ['../secret', 'a/b', '..', 'Foo', '']) {
      expect(() => loadBrandConfig(REAL_BRANDS, id)).toThrow(/Invalid brand id/);
    }
  });

  it('throws when the brand folder is missing', () => {
    expect(() => loadBrandConfig(REAL_BRANDS, 'does-not-exist')).toThrow(/not found/);
  });

  it('throws a branded error on malformed JSON', () => {
    expect(() => loadBrandConfig(TMP_BRANDS, 'bad-json')).toThrow(/invalid JSON/);
  });

  it('throws when name is missing', () => {
    expect(() => loadBrandConfig(TMP_BRANDS, 'no-name')).toThrow(/"name" is required/);
  });

  it('throws when name is an empty string', () => {
    expect(() => loadBrandConfig(TMP_BRANDS, 'empty-name')).toThrow(/"name" is required/);
  });

  it('throws when shortName is missing', () => {
    expect(() => loadBrandConfig(TMP_BRANDS, 'no-shortname')).toThrow(/"shortName" is required/);
  });

  it('throws when colors is missing', () => {
    expect(() => loadBrandConfig(TMP_BRANDS, 'no-colors')).toThrow(/colors\.accent/);
  });

  it('throws when accentHover is missing', () => {
    expect(() => loadBrandConfig(TMP_BRANDS, 'no-accent-hover')).toThrow(/colors\.accent/);
  });
});

describe('loadBrandConfig — optional fields', () => {
  it('omits light accents and tagline when not provided', () => {
    const b = loadBrandConfig(TMP_BRANDS, 'valid-minimal');
    expect(b.tagline).toBeUndefined();
    expect(b.colors.accentLight).toBeUndefined();
    expect(b.colors.accentLightHover).toBeUndefined();
  });

  it('passes through tagline and both light accents when present', () => {
    const b = loadBrandConfig(TMP_BRANDS, 'with-light');
    expect(b.tagline).toBe('Hello');
    expect(b.colors.accentLight).toBe('#0a0b0c');
    expect(b.colors.accentLightHover).toBe('#0d0e0f');
  });

  it('passes through accentLight even when accentLightHover is absent', () => {
    const b = loadBrandConfig(TMP_BRANDS, 'light-partial');
    expect(b.colors.accentLight).toBe('#0a0b0c');
    expect(b.colors.accentLightHover).toBeUndefined();
  });

  // Decision B17: there is no `promotions` flag, so nothing about promotions is
  // read from the brand file at all.
  it('does not carry a promotions flag, even when the file sets one', () => {
    const b = loadBrandConfig(TMP_BRANDS, 'promotions-on');
    expect('promotions' in b).toBe(false);
    expect('promotions' in loadBrandConfig(REAL_BRANDS, 'magick-agency')).toBe(false);
  });

  it('passes through a valid style block', () => {
    const b = loadBrandConfig(TMP_BRANDS, 'with-style');
    expect(b.style).toEqual({ radius: 'sharp', elevation: 'flat', gradientAngle: 90, flatButtons: true });
  });

  it('drops malformed style fields (fail-closed) and omits an empty style', () => {
    const b = loadBrandConfig(TMP_BRANDS, 'bad-style');
    expect(b.style).toBeUndefined();
  });

  it('omits style when not provided', () => {
    expect(loadBrandConfig(TMP_BRANDS, 'valid-minimal').style).toBeUndefined();
  });

  it('coerces a non-string tagline to undefined', () => {
    const b = loadBrandConfig(TMP_BRANDS, 'bad-tagline');
    expect(b.tagline).toBeUndefined();
  });
});

describe('injectBrandName', () => {
  it('replaces a single %BRAND_NAME% placeholder', () => {
    expect(injectBrandName('<title>%BRAND_NAME%</title>', 'Acme')).toBe('<title>Acme</title>');
  });

  it('replaces every occurrence', () => {
    expect(injectBrandName('%BRAND_NAME% / %BRAND_NAME%', 'Acme')).toBe('Acme / Acme');
  });

  it('leaves html without the placeholder unchanged', () => {
    expect(injectBrandName('<title>Static</title>', 'Acme')).toBe('<title>Static</title>');
  });

  it('HTML-escapes the brand name', () => {
    expect(injectBrandName('<title>%BRAND_NAME%</title>', 'Tom & "Jerry" <Voice>')).toBe(
      '<title>Tom &amp; &quot;Jerry&quot; &lt;Voice&gt;</title>',
    );
  });

  it('treats a name containing $ patterns literally (no regex substitution)', () => {
    // Both `&` escape to `&amp;`; the `$1` and `$` of `$&` must survive unchanged
    // (a function replacer prevents regex `$`-substitution).
    expect(injectBrandName('%BRAND_NAME%', 'A$1 & B$&')).toBe('A$1 &amp; B$&amp;');
  });
});
