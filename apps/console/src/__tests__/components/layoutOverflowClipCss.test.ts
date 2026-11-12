import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shell wrappers must be `overflow: clip`, not only `overflow: hidden`.
 *
 * An `overflow: hidden` box is still a scroll container: `focus()` or
 * `scrollIntoView` on anything inside it that pokes past its edge scrolls it.
 * The account switcher's dropdown did exactly that: it ran off the right of the
 * screen, focused its search box, and the whole page slid left under the fixed
 * sidebar. `clip` cuts the overflow the same way but cannot be scrolled.
 *
 * happy-dom applies no stylesheet, so this reads the sheets. Only screen rules
 * count: `@media` blocks are dropped (print releases the frame on purpose), and
 * every remaining rule naming the selector, alone or in a list, is read in
 * order, so a later `overflow: hidden` override fails the check.
 */

function screenRules(file: string): Array<{ selectors: string[]; body: string }> {
  const css = readFileSync(resolve(__dirname, '../../components/layout', file), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  // Drop every at-rule block, braces balanced, so nested rules cannot leak out.
  let flat = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '@') {
      const open = css.indexOf('{', i);
      let depth = 0;
      let j = open;
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}' && --depth === 0) break;
      }
      i = j;
      continue;
    }
    flat += css[i];
  }
  return [...flat.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel = '', body = '']) => ({
    selectors: sel.split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
    body,
  }));
}

/** The `overflow` that wins on screen for `selector`: the last one declared. */
function winningOverflow(file: string, selector: string): string | undefined {
  const values = screenRules(file)
    .filter((rule) => rule.selectors.includes(selector))
    .flatMap((rule) => [...rule.body.matchAll(/(?:^|[;{\s])overflow:\s*([^;]+);/g)])
    .map((m) => m[1]!.trim());
  return values.at(-1);
}

describe('shell wrappers cannot be scrolled sideways by a popover', () => {
  it.each([
    ['ConsoleLayout.module.css', '.layout'],
    ['ConsoleLayout.module.css', '.main'],
  ])('%s %s ends on overflow: clip', (file, selector) => {
    expect(winningOverflow(file, selector)).toBe('clip');
  });
});
