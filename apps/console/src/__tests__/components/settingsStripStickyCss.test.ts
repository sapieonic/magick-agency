import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The campaign Settings section strip, on a phone, sticks flush under the top bar.
 *
 * A sticky box sticks inside its scroll area's padding. The strip sits in the console's
 * content pane (ConsoleLayout's `.content`), whose top padding is 24px, 16px at 768px and
 * below; with `top: 0` that padding stayed open above the stuck strip and the page showed
 * through it. The strip's `top` must take back exactly the pane's padding at each width.
 *
 * happy-dom applies no stylesheet, so this reads the sheets.
 */

const read = (path: string) =>
  readFileSync(resolve(__dirname, '../../components', path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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

function px(value: string | undefined): number {
  const match = /^(-?\d+(?:\.\d+)?)px/.exec(value ?? '');
  if (!match) throw new Error(`not a px length: ${value}`);
  return Number(match[1]);
}

const layout = read('layout/ConsoleLayout.module.css');
const strip = read('agency/SettingsSectionNav.module.css');

/** The content pane's top padding: the first length of its `padding` shorthand. */
const paneTop = (css: string) => px(property(block(css, '.content'), 'padding'));

describe('the Settings section strip on a phone', () => {
  it('sticks over the content pane’s top padding, at every width it is a strip', () => {
    const wide = paneTop(topLevel(layout));
    const narrow = paneTop(block(layout, '@media (max-width: 768px)'));

    // 769px to 900px: a strip, in a pane with the wide padding.
    expect(px(property(block(block(strip, '@media (max-width: 900px)'), '.nav'), 'top'))).toBe(-wide);
    // 768px and below: the pane's padding narrows, and so must the strip's offset.
    expect(px(property(block(block(strip, '@media (max-width: 768px)'), '.nav'), 'top'))).toBe(-narrow);
  });
});
