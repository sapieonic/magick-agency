import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The campaign Settings section strip, on a phone, sticks flush under the top bar.
 *
 * A sticky box sticks inside its scroll area's padding. The strip sits in the console's
 * content pane (ConsoleLayout's `.content`), whose padding is `--content-pad` (24px, 16px at
 * 768px and below); with `top: 0` that padding stayed open above the stuck strip and the page
 * showed through it. The strip's `top` and sideways margins take back exactly that variable, so
 * they follow the pane at every width. The page clears the stuck strip by its height variable.
 *
 * happy-dom applies no stylesheet, so this reads the sheets.
 */

const read = (path: string) =>
  readFileSync(resolve(__dirname, '../..', path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the block opened by `head` (an `@media …` or a selector), braces balanced. */
function block(css: string, head: string): string {
  const at = css.indexOf(`${head} {`);
  if (at < 0) throw new Error(`no block ${head}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced block ${head}`);
}

/** Top-level rules only: nested `@media` blocks are cut out. */
function topLevel(css: string): string {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '@') {
      let depth = 0;
      let j = css.indexOf('{', i);
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}' && --depth === 0) break;
      }
      i = j;
      continue;
    }
    out += css[i];
  }
  return out;
}

function property(rule: string, name: string): string | undefined {
  return [...rule.matchAll(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`, 'g'))].at(-1)?.[1]?.trim();
}

const layout = read('components/layout/ConsoleLayout.module.css');
const strip = read('components/agency/SettingsSectionNav.module.css');
const page = read('pages/agency/AgencyCampaignSettingsPage.module.css');

const PAD = 'var(--content-pad)';
const NEGATIVE_PAD = 'calc(-1 * var(--content-pad))';

describe('the Settings section strip on a phone', () => {
  it('pads the content pane by --content-pad, narrower at 768px and below', () => {
    const pane = block(topLevel(layout), '.content');
    expect(property(pane, '--content-pad')).toBe('24px');
    expect(property(pane, 'padding')).toMatch(/^var\(--content-pad\) var\(--content-pad\) /);
    expect(property(block(block(layout, '@media (max-width: 768px)'), '.content'), '--content-pad')).toBe('16px');
  });

  it('sticks over the content pane’s top padding and runs edge to edge, by the same variable', () => {
    const nav = block(block(strip, '@media (max-width: 900px)'), '.nav');
    expect(property(nav, 'top')).toBe(NEGATIVE_PAD);
    expect(property(nav, 'margin')).toBe(`0 ${NEGATIVE_PAD}`);
    expect(property(nav, 'padding')).toBe(`6px ${PAD}`);
    // No width restates the pane's padding as a number.
    expect(strip).not.toMatch(/-(24|16)px/);
  });

  it('is cleared, when the page lands a section, by the strip’s own height', () => {
    expect(property(block(strip, ':root'), '--settings-strip-height')).toMatch(/^\d+px$/);
    expect(property(block(block(strip, '@media (max-width: 900px)'), '.nav'), 'min-height')).toBe('var(--settings-strip-height)');
    const sections = block(block(page, '@media (max-width: 900px)'), '.sections > *');
    expect(property(sections, 'scroll-margin-top')).toMatch(/^calc\(var\(--settings-strip-height\) \+ /);
  });
});
