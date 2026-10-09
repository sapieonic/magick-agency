import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every colour token must be defined in BOTH theme blocks of `global.css`.
 *
 * A token added to `:root` and forgotten in `[data-theme='light']` fails
 * *silently and asymmetrically*: `var(--x)` with no definition and no fallback
 * resolves to the property's initial value, so a colour becomes `currentColor`
 * or transparent — text that vanishes into its own background, or a border that
 * simply stops existing. Nothing throws, nothing warns, `npm run lint` is a type
 * check and cannot see stylesheets, and no unit test in this suite applies a
 * stylesheet at all, so none of them can see a colour either. The only
 * signal is the pixels, in one theme, on whichever screen happens to use the
 * token — which is how a half-themed token survives review and ships.
 *
 * (CSS Modules resolve to hashed names here — `_liveDot_8ae290`, not `liveDot`
 * — so a test cannot compare a class by equality either; the suite matches by
 * substring. Either way no stylesheet is applied, so no test can see a colour.)
 *
 * This is a source-level test for the same reason `hiddenPanelCss.test.ts` is:
 * the failure exists only where a real cascade does, so from here the wiring is
 * the only thing that can be asserted.
 *
 * Non-colour tokens are deliberately NOT checked. Radii, fonts, the sidebar
 * widths, the transition curve and the shadow *geometry* are theme-independent
 * by design — they are declared once on `:root` and inherited by the light
 * block, and requiring them twice would mean duplicating values that must never
 * be allowed to disagree.
 */

const GLOBAL_CSS = resolve(__dirname, '..', 'global.css');

/**
 * The two tokens that are legitimately dark-only.
 *
 * The tricolour is the Indian flag, and a flag's colours are not a matter of
 * theme — saffron and green are the same in both. Only `--tricolor-white` is
 * redefined, because "white" is the one band that has to be *retuned* rather
 * than reproduced: paper-white on a light background would vanish into the card
 * beneath it, so light theme steps it down to a grey that still reads as the
 * middle band.
 *
 * Anything else appearing here should be challenged rather than added.
 */
const DARK_ONLY = new Set(['--tricolor-saffron', '--tricolor-green']);

/** Extracts the text between the braces of the first `<selector> {` block. */
function blockBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`global.css has no \`${selector}\` block`);
  const open = css.indexOf('{', at);
  let depth = 0;
  let i = open;
  for (; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return css.slice(open + 1, i);
}

/** Custom properties declared directly in a block, as `name -> value`. */
function customProperties(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const declaration = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match = declaration.exec(body);
  while (match !== null) {
    out.set(match[1]!, match[2]!.trim());
    match = declaration.exec(body);
  }
  return out;
}

/**
 * Whether a value paints a colour.
 *
 * Matches a literal colour anywhere in the value, so gradients and multi-layer
 * shadows count — those are exactly the tokens most likely to be retuned per
 * theme and most expensive to get wrong. A value that only references other
 * custom properties (`var(--accent)`) is not a literal and does not need a
 * second definition: it already resolves per theme through the token it names.
 */
function paintsAColour(value: string): boolean {
  return /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(value);
}

describe('global.css — theme token parity', () => {
  const css = readFileSync(GLOBAL_CSS, 'utf8');
  const dark = customProperties(blockBody(css, ':root'));
  const light = customProperties(blockBody(css, "[data-theme='light']"));

  it('defines every dark colour token in the light theme too', () => {
    const missing = [...dark]
      .filter(([name, value]) => paintsAColour(value) && !DARK_ONLY.has(name))
      .map(([name]) => name)
      .filter(name => !light.has(name));

    expect(
      missing,
      `These colour tokens are declared in \`:root\` but not in ` +
        `\`[data-theme='light']\`, so they resolve to their initial value in ` +
        `light theme — invisible text, or a border that is not there. Add each ` +
        `one to the light block with a value tuned for a light background ` +
        `(never the dark value copied across), or, if it is genuinely ` +
        `theme-independent, add it to DARK_ONLY above with the reason.`,
    ).toEqual([]);
  });

  it('declares no light token that dark does not have', () => {
    // The reverse direction is the same bug seen from the other side: a token
    // only the light theme defines is undefined in dark, which is the default
    // theme and therefore the one most users see fail.
    const orphans = [...light.keys()].filter(name => !dark.has(name));

    expect(orphans, 'Declared in the light block but missing from `:root`').toEqual([]);
  });

  it('carries the full ember family in both themes', () => {
    // The reason this file exists. Ember shipped as seven tokens at once; the
    // parity rule above is general, but naming the family explicitly is what
    // turns "somebody deleted --ember-glow from light" into a failure that says
    // so, rather than a diff in a list of missing names.
    const family = [
      '--ember',
      '--ember-hover',
      '--ember-deep',
      '--ember-subtle',
      '--ember-faint',
      '--ember-glow',
      '--gradient-ember',
      // `.btn-ember` has no fill without this one, and the parity rules above
      // only compare tokens that still exist in at least ONE block — so deleting
      // it from both would leave every other assertion here green.
      '--button-ember-bg',
    ];

    for (const token of family) {
      expect(dark.has(token), `\`${token}\` missing from the dark theme`).toBe(true);
      expect(light.has(token), `\`${token}\` missing from the light theme`).toBe(true);
      expect(dark.get(token), `\`${token}\` is the same in both themes`).not.toBe(light.get(token));
    }
  });

  it('keeps ember distinct from the --orange chart-series token', () => {
    // These are different jobs that happen to be the same hue family: `--orange`
    // is a chart series used positionally beside `--pink` / `--teal`, `--ember`
    // is the signal that something is moving. They land inches apart inside a
    // chart card, so if they ever collapse to one value the distinction is gone
    // from the screen even though both tokens still exist in the file.
    expect(dark.get('--ember')).not.toBe(dark.get('--orange'));
    expect(light.get('--ember')).not.toBe(light.get('--orange'));
  });
});
