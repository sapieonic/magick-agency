/**
 * Accent colors. Prefer `#rrggbb` hex so the subtle/glow/focus variants can be
 * alpha-derived from the value; any valid CSS color is accepted, but non-hex
 * values are used as-is for those derived variants (no alpha applied).
 */
export interface BrandColors {
  /** Primary brand color (dark theme). */
  accent: string;
  /** Hover/active accent (dark theme). */
  accentHover: string;
  /** Optional light-theme accent. Falls back to `accent` when omitted. */
  accentLight?: string;
  /** Optional light-theme hover accent. Falls back to `accentHover` when omitted. */
  accentLightHover?: string;
}

/** Corner-radius feel. A preset, or a base radius in px (the lg/xl/2xl scale is
 *  derived from it). Defaults to `default` (8px). */
export type BrandRadius = 'sharp' | 'default' | 'soft' | number;

/** Surface depth treatment for the accent glow on buttons/cards.
 *  `glow` = today's accent halo, `soft` = a neutral shadow, `flat` = none. */
export type BrandElevation = 'flat' | 'soft' | 'glow';

/** Optional non-color style levers. All optional and fail-closed to the default
 *  look, so an absent/partial `style` reproduces the original design. */
export interface BrandStyle {
  /** Corner radius across the app. Default: `default` (8px base). */
  radius?: BrandRadius;
  /** Accent glow/elevation treatment. Default: `glow`. */
  elevation?: BrandElevation;
  /** Angle (deg) of the accent gradient (wordmark, panel, gradient buttons).
   *  Default: 135. */
  gradientAngle?: number;
  /** Render primary buttons as a solid accent fill instead of the gradient.
   *  Default: false. */
  flatButtons?: boolean;
}

export interface Brand {
  /** Stable brand id — the `brands/<id>` folder slug, set from `VITE_BRAND` at
   *  build time. Machine-friendly (validated slug); used for attribution such as
   *  the `x-mgkvc-originator` header. */
  id: string;
  /** Full product name, e.g. "Magick Agency". */
  name: string;
  /** Compact label for tight spots, e.g. "MA". Also the text of the brand mark. */
  shortName: string;
  /** Optional marketing tagline. */
  tagline?: string;
  /*
   * Decision B17: there is no `promotions` flag; the console has no
   * promotional UI (such as a login "free credits" banner).
   */
  /** Optional non-color style levers (corner radius, elevation, etc.). */
  style?: BrandStyle;
  colors: BrandColors;
}
