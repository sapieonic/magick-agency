import { describe, it, expect } from 'vitest';
import { applyBrandColors, brand } from './index';

describe('brand module', () => {
  it('exposes the active brand from the build-time define', () => {
    expect(typeof brand.name).toBe('string');
    expect(brand.name.length).toBeGreaterThan(0);
    expect(brand.colors.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('injects a <style> with :root (dark) and light-theme accent rules', () => {
    applyBrandColors({
      id: 'x',
      name: 'X',
      shortName: 'X',
      colors: {
        accent: '#112233',
        accentHover: '#445566',
        accentLight: '#aabbcc',
        accentLightHover: '#ddeeff',
      },
    });
    const el = document.getElementById('brand-accent');
    expect(el).not.toBeNull();
    const css = el?.textContent ?? '';

    // Dark (:root) block uses the dark accent + dark alphas.
    expect(css).toContain(':root{');
    expect(css).toContain('--accent:#112233;');
    expect(css).toContain('--accent-hover:#445566;');
    expect(css).toContain('--accent-subtle:rgba(17, 34, 51, 0.12);');
    expect(css).toContain('--border-focus:rgba(17, 34, 51, 0.5);');

    // Light block uses the light accent + light alphas (proves the cascade fix).
    expect(css).toContain("[data-theme='light']{");
    expect(css).toContain('--accent:#aabbcc;');
    expect(css).toContain('--accent-subtle:rgba(170, 187, 204, 0.1);');
    expect(css).toContain('--border-focus:rgba(170, 187, 204, 0.36);');
  });

  it('falls back to the dark accent for light mode when light accents are omitted', () => {
    applyBrandColors({
      id: 'x',
      name: 'X',
      shortName: 'X',
      colors: { accent: '#102030', accentHover: '#405060' },
    });
    const css = document.getElementById('brand-accent')?.textContent ?? '';
    expect(css).toContain("[data-theme='light']{--accent:#102030;");
  });

  it('reuses a single <style> element on repeated calls (idempotent)', () => {
    applyBrandColors();
    applyBrandColors();
    expect(document.querySelectorAll('#brand-accent').length).toBe(1);
  });

  it('passes non-hex accent values through untouched (no rgba derivation)', () => {
    applyBrandColors({
      id: 'x',
      name: 'X',
      shortName: 'X',
      colors: { accent: 'rebeccapurple', accentHover: 'purple' },
    });
    const css = document.getElementById('brand-accent')?.textContent ?? '';
    expect(css).toContain('--accent:rebeccapurple;');
    // Non-hex can't be alpha-derived, so subtle/glow/focus fall back to the raw value.
    expect(css).toContain('--accent-subtle:rebeccapurple;');
    expect(css).toContain('--border-focus:rebeccapurple;');
  });

  it('uses the active brand when called with no argument', () => {
    applyBrandColors();
    const css = document.getElementById('brand-accent')?.textContent ?? '';
    expect(css).toContain(`--accent:${brand.colors.accent};`);
  });

  // Regression guard: the default magick-agency config + the derivation must
  // reproduce the original global.css accent variants exactly, in BOTH themes.
  // The gradient/glow are now derived from the accent pair (no longer the magic
  // global.css second-stop), so this also pins those derived values. If
  // global.css accents change, update both this test and
  // brands/magick-agency/brand.config.json together.
  it('reproduces the default accent family from the magick-agency config (both themes)', () => {
    applyBrandColors(); // default = magick-agency
    const css = document.getElementById('brand-accent')?.textContent ?? '';

    // Dark (:root) — accent variants match src/global.css :root; gradient/glow
    // derived from the accent pair.
    expect(css).toContain(':root{--accent:#7c5cfc;--accent-hover:#9b82ff;'
      + '--accent-subtle:rgba(124, 92, 252, 0.12);'
      + '--accent-glow:rgba(124, 92, 252, 0.25);'
      + '--border-focus:rgba(124, 92, 252, 0.5);'
      + '--gradient-purple:linear-gradient(135deg, #7c5cfc, #9b82ff);'
      + '--shadow-glow:0 4px 14px -6px rgba(124, 92, 252, 0.45);'
      + '--shadow-glow-strong:0 8px 22px -6px rgba(124, 92, 252, 0.55);'
      // Default style block: 8px radius scale, no flat-button override.
      + '--radius:8px;--radius-lg:12px;--radius-xl:16px;--radius-2xl:20px;}');

    // Light — accent variants match src/global.css [data-theme='light'].
    expect(css).toContain("[data-theme='light']{--accent:#6a4de4;--accent-hover:#5a40ce;"
      + '--accent-subtle:rgba(106, 77, 228, 0.1);'
      + '--accent-glow:rgba(106, 77, 228, 0.14);'
      + '--border-focus:rgba(106, 77, 228, 0.36);'
      + '--gradient-purple:linear-gradient(135deg, #6a4de4, #5a40ce);'
      + '--shadow-glow:0 2px 6px -2px rgba(106, 77, 228, 0.28), '
      + '0 12px 24px -14px rgba(106, 77, 228, 0.34);'
      + '--shadow-glow-strong:0 3px 8px -2px rgba(106, 77, 228, 0.34), '
      + '0 16px 32px -14px rgba(106, 77, 228, 0.42);}');
  });
});

describe('brand style levers', () => {
  const baseColors = { accent: '#112233', accentHover: '#445566' };
  const withStyle = (style: object) =>
    applyBrandColors({ id: 'x', name: 'X', shortName: 'X', style, colors: baseColors } as never);
  const cssNow = () => document.getElementById('brand-accent')?.textContent ?? '';

  it('derives the radius scale from a preset', () => {
    withStyle({ radius: 'sharp' });
    expect(cssNow()).toContain('--radius:2px;--radius-lg:3px;--radius-xl:4px;--radius-2xl:5px;');
  });

  it('derives the radius scale from a numeric base', () => {
    withStyle({ radius: 14 });
    expect(cssNow()).toContain('--radius:14px;--radius-lg:21px;--radius-xl:28px;--radius-2xl:35px;');
  });

  it('rotates the accent gradient by gradientAngle', () => {
    withStyle({ gradientAngle: 90 });
    expect(cssNow()).toContain('--gradient-purple:linear-gradient(90deg, #112233, #445566);');
  });

  it('flat elevation drops the accent glow', () => {
    withStyle({ elevation: 'flat' });
    expect(cssNow()).toContain('--shadow-glow:none;--shadow-glow-strong:none;');
  });

  it('soft elevation uses neutral shadows instead of the accent halo', () => {
    withStyle({ elevation: 'soft' });
    expect(cssNow()).toContain('--shadow-glow:var(--shadow-sm);--shadow-glow-strong:var(--shadow-md);');
  });

  it('flatButtons sets the primary-button fill to a solid accent', () => {
    withStyle({ flatButtons: true });
    expect(cssNow()).toContain('--button-primary-bg:var(--accent);');
  });

  it('omits the flat-button override by default', () => {
    applyBrandColors(); // default brand has no style
    expect(cssNow()).not.toContain('--button-primary-bg');
  });
});
