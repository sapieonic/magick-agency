import type { Brand, BrandStyle, BrandElevation } from './types';

/** The active whitelabel brand, injected at build time (see vite.config.ts). */
export const brand: Brand = __BRAND__;

const HEX = /^#([0-9a-fA-F]{6})$/;

/** Convert #rrggbb + alpha (0..1) into an `rgba(...)` string; passthrough if not hex. */
function withAlpha(hex: string, alpha: number): string {
  const m = HEX.exec(hex);
  if (!m || m[1] === undefined) return hex;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** One `box-shadow` layer: CSS offset/blur/spread plus the accent alpha to
 *  tint it with. Layers are composed in order into a single comma-separated
 *  `box-shadow` value. */
interface GlowLayer {
  geo: string;
  alpha: number;
}

/** Per-theme derivation parameters for the accent family. The alpha values
 *  reproduce the original global.css accent variants exactly for the default
 *  brand; the glow geometry is the theme's, recolored from the accent. The
 *  `--gradient-purple` wordmark/panel gradient is rebuilt from the accent pair
 *  so the brand color flows through every accent surface.
 *
 *  The dark glow is *directional*, not a halo. `0 0 20px` rendered an
 *  omnidirectional neon ring around every primary button — the single loudest
 *  "dark mode circa 2020" tell in the UI. A downward-offset, negative-spread
 *  ambient reads as the button sitting on the page and lit from above, which is
 *  what expensive software looks like. Same accent, same token, quieter physics. */
const DARK = {
  subtle: 0.12,
  glow: 0.25,
  focus: 0.5,
  glowLayers: [{ geo: '0 4px 14px -6px', alpha: 0.45 }],
  glowStrongLayers: [{ geo: '0 8px 22px -6px', alpha: 0.55 }],
};
const LIGHT = {
  subtle: 0.1,
  glow: 0.14,
  focus: 0.36,
  glowLayers: [
    { geo: '0 2px 6px -2px', alpha: 0.28 },
    { geo: '0 12px 24px -14px', alpha: 0.34 },
  ],
  glowStrongLayers: [
    { geo: '0 3px 8px -2px', alpha: 0.34 },
    { geo: '0 16px 32px -14px', alpha: 0.42 },
  ],
};

const STYLE_ID = 'brand-accent';

/** Named corner-radius presets → base radius in px (lg/xl/2xl derive from it). */
const RADIUS_PRESETS: Record<string, number> = { sharp: 2, default: 8, soft: 14 };
const DEFAULT_RADIUS = 8;
const DEFAULT_GRADIENT_ANGLE = 135;

/** Resolved (defaulted) style — every field concrete, so the default brand
 *  reproduces the original design and partial configs are filled in. */
interface ResolvedStyle {
  radiusBase: number;
  elevation: BrandElevation;
  gradientAngle: number;
  flatButtons: boolean;
}

function resolveRadiusBase(radius: BrandStyle['radius']): number {
  if (typeof radius === 'number' && radius >= 0) return radius;
  if (typeof radius === 'string') {
    const preset = RADIUS_PRESETS[radius];
    if (preset !== undefined) return preset;
  }
  return DEFAULT_RADIUS;
}

function resolveStyle(b: Brand): ResolvedStyle {
  const s = b.style ?? {};
  return {
    radiusBase: resolveRadiusBase(s.radius),
    elevation: s.elevation ?? 'glow',
    gradientAngle: typeof s.gradientAngle === 'number' ? s.gradientAngle : DEFAULT_GRADIENT_ANGLE,
    flatButtons: s.flatButtons === true,
  };
}

/** Glow declarations per elevation: accent halo (`glow`, the default), a plain
 *  neutral shadow (`soft`), or none (`flat`). */
function glowDecls(accent: string, a: typeof DARK, elevation: BrandElevation): string {
  if (elevation === 'flat') return '--shadow-glow:none;--shadow-glow-strong:none;';
  if (elevation === 'soft') return '--shadow-glow:var(--shadow-sm);--shadow-glow-strong:var(--shadow-md);';
  return (
    `--shadow-glow:${composeGlow(accent, a.glowLayers)};` +
    `--shadow-glow-strong:${composeGlow(accent, a.glowStrongLayers)};`
  );
}

/** Compose accent-tinted `box-shadow` layers into one CSS value. */
function composeGlow(accent: string, layers: readonly GlowLayer[]): string {
  return layers.map((l) => `${l.geo} ${withAlpha(accent, l.alpha)}`).join(', ');
}

/** Build the accent-family declarations for one theme. */
function accentBlock(accent: string, accentHover: string, a: typeof DARK, rs: ResolvedStyle): string {
  return (
    `--accent:${accent};` +
    `--accent-hover:${accentHover};` +
    `--accent-subtle:${withAlpha(accent, a.subtle)};` +
    `--accent-glow:${withAlpha(accent, a.glow)};` +
    `--border-focus:${withAlpha(accent, a.focus)};` +
    `--gradient-purple:linear-gradient(${rs.gradientAngle}deg, ${accent}, ${accentHover});` +
    glowDecls(accent, a, rs.elevation)
  );
}

/** Theme-independent style declarations (radius scale + flat-button token). */
function rootStyleBlock(rs: ResolvedStyle): string {
  const b = rs.radiusBase;
  return (
    `--radius:${Math.round(b)}px;` +
    `--radius-lg:${Math.round(b * 1.5)}px;` +
    `--radius-xl:${Math.round(b * 2)}px;` +
    `--radius-2xl:${Math.round(b * 2.5)}px;` +
    (rs.flatButtons ? '--button-primary-bg:var(--accent);' : '')
  );
}

/**
 * Width (px) the expanded sidebar needs so the brand wordmark fits on one line
 * at its 18px display size, clamped to a sane range. Short names keep the
 * default 240px; long ones (e.g. "Samarthya Connect") widen the rail. Derived
 * from an average glyph advance — exact enough for layout, with the wordmark's
 * ellipsis as a final safety net beyond the cap.
 */
export function brandSidebarWidth(b: Brand = brand): number {
  const FONT_PX = 18;
  const AVG_ADVANCE = 0.55; // em, for the 800-weight display face
  const wordmark = b.name.length * AVG_ADVANCE * FONT_PX;
  const chrome = 28 /* logo mark */ + 8 /* gap */ + 32 /* h-padding */ + 28 /* breathing room */;
  return Math.min(320, Math.max(240, Math.ceil(wordmark + chrome)));
}

/** Set the brand-derived `--sidebar-width` layout token on the document root. */
export function applyBrandLayout(b: Brand = brand): void {
  document.documentElement.style.setProperty('--sidebar-width', `${brandSidebarWidth(b)}px`);
}

/**
 * Apply the active brand's accent family + style levers by injecting a `<style>`
 * element with both `:root` (dark) and `[data-theme='light']` rules. A `<style>`
 * is used rather than inline `documentElement` styles so the light-theme rule
 * still participates in the cascade — inline styles would override
 * `[data-theme='light']` and freeze light mode to the dark accent. The accent
 * family (including the `--gradient-purple` gradient and `--shadow-glow` tokens),
 * plus the brand's optional `style` levers (corner radius, elevation/glow,
 * gradient angle, flat buttons), are derived here; the neutral/background palette
 * is left to global.css, so the light/dark theme toggle keeps working. An absent
 * or partial `style` falls back to the default look. Idempotent — reuses the same
 * `<style>` element on repeat calls.
 */
export function applyBrandColors(b: Brand = brand): void {
  const { accent, accentHover, accentLight, accentLightHover } = b.colors;
  const lightAccent = accentLight ?? accent;
  const lightHover = accentLightHover ?? accentHover;

  const rs = resolveStyle(b);
  const css =
    `:root{${accentBlock(accent, accentHover, DARK, rs)}${rootStyleBlock(rs)}}` +
    `[data-theme='light']{${accentBlock(lightAccent, lightHover, LIGHT, rs)}}`;

  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}
