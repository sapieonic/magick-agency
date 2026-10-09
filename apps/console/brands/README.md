# Brand packs (whitelabeling)

Each subfolder is one whitelabel brand. The active brand is chosen at **build
time** by the `VITE_BRAND` env var (default: `magick-agency`).

## Structure

    brands/
      <brand-id>/
        brand.config.json     # name, shortName, optional tagline, accent colors
        public/               # optional static assets, served at the site root

## brand.config.json

    {
      "name": "Acme Voice",            // full product name (UI + browser tab title)
      "shortName": "AV",               // compact label
      "tagline": "Talk to anyone",     // optional
      "style": {                       // optional — non-color style levers
        "radius": "soft",              //   "sharp" | "default" | "soft" | <px>  (default 8px)
        "elevation": "flat",           //   "flat" | "soft" | "glow"  (default "glow")
        "gradientAngle": 120,          //   accent gradient angle in deg (default 135)
        "flatButtons": true            //   solid-accent primary buttons (default false)
      },
      "colors": {
        "accent": "#1d4ed8",           // #rrggbb — primary brand color (dark theme)
        "accentHover": "#2563eb",      // #rrggbb — hover/active accent (dark theme)
        "accentLight": "#1e40af",      // optional — light-theme accent (falls back to accent)
        "accentLightHover": "#1d4ed8"  // optional — light-theme hover (falls back to accentHover)
      }
    }

Required: `name`, `shortName`, `colors.accent`, `colors.accentHover`. A missing
required field fails the build. `tagline`, `accentLight`, and `accentLightHover`
are optional — omit the light-theme accents to reuse the dark accent in light
mode.

The brand mark (`src/components/common/Logo.tsx`) is a text tile: the accent
colour with `shortName` on it. There is no logo image; `index.html` declares an
empty favicon (`data:,`) so browsers do not request `/favicon.ico`. The default
brand ships no `public/` folder; a pack that adds one has it served at the site
root.

`style` is optional and fail-closed — any absent or malformed field falls back
to the default look:

- `radius` — corner radius across the app. A preset (`sharp` ≈ 2px, `default` =
  8px, `soft` ≈ 14px) or a base radius in px; the `lg`/`xl`/`2xl` steps are
  derived from it (×1.5 / ×2 / ×2.5).
- `elevation` — accent depth treatment: `glow` (the accent halo on buttons),
  `soft` (a plain neutral shadow), or `flat` (no glow).
- `gradientAngle` — angle (deg) of the accent gradient used by the wordmark,
  login panel, and gradient buttons.
- `flatButtons` — render primary buttons as a solid accent fill instead of the
  gradient.

These are applied at runtime in `src/brand/index.ts` alongside the accent
family; the default brand omits `style` and reproduces the original design
byte-for-byte.

**Scope note:** the brand accent drives all accent surfaces — buttons, links,
focus rings, active states, badges, subtle accent backgrounds/glows, the
`--gradient-purple` wordmark/panel gradient, and the `--shadow-glow` tokens (all
recolored from the accent pair at runtime in `src/brand/index.ts`). The
neutral/background palette stays theme-specific in `src/global.css`.

## Add a new whitelabel

1. `cp -r brands/magick-agency brands/acme`
2. Edit `brands/acme/brand.config.json` (name, shortName, colors).
3. Build/deploy with `VITE_BRAND=acme` set in the environment.
4. Point the brand's domain at that deployment (handled separately, infra side).

No code changes are needed to add a brand.
